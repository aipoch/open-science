import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { cpus, freemem, hostname, platform, totalmem, uptime } from 'node:os'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import type {
  NotebookProcessMonitorSnapshot,
  NotebookProcessObservation,
  NotebookProcessStatus,
  ManualKernelTermination,
  TerminateNotebookProcessRequest
} from '../../shared/notebook-process-monitor'

export type MonitoredKernelProcess = {
  identity: object
  processKey: string
  lastCell?: NotebookProcessObservation['lastCell']
  pid?: number
  startedAt: number
  status: NotebookProcessStatus
  terminate: () => Promise<void>
}

export type MonitoredInterpreter = MonitoredKernelProcess & {
  projectId: string
  sessionId: string
  lane: string
  kind: NotebookProcessObservation['kind']
  environment?: string
}

type ProcessSample = NotebookProcessObservation['processes'][number] & { cpuSeconds?: number }
const run = promisify(execFile)
const nativeRequire = createRequire(import.meta.url)
const cpuTimes = (): { idle: number; total: number } =>
  cpus().reduce(
    (sum, cpu) => ({
      idle: sum.idle + cpu.times.idle,
      total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0)
    }),
    { idle: 0, total: 0 }
  )

// Display-only enumeration. These numbers never grant permission to signal a process.
async function processSamples(): Promise<ProcessSample[]> {
  if (process.platform === 'win32') {
    const native = nativeRequire(
      '@aipoch/process-tree-native'
    ) as typeof import('@aipoch/process-tree-native')
    const result = await native.sampleWindowsResources(true, [])
    if (!result.supported || !result.complete) throw new Error('Process sample is incomplete.')
    return result.processes.map((item) => ({
      pid: item.pid,
      parentPid: item.parentPid,
      command: '',
      memoryBytes: item.workingSetBytes
    }))
  }
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,rss=,time=,comm='], {
    timeout: 2500,
    maxBuffer: 4 * 1024 * 1024
  })
  return stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d:.-]+)\s+(.+)$/)
    return match
      ? [
          {
            pid: Number(match[1]),
            parentPid: Number(match[2]),
            memoryBytes: Number(match[3]) * 1024,
            command: basename(match[5]),
            cpuSeconds: parseProcessCpuTime(match[4])
          }
        ]
      : []
  })
}

export function parseProcessCpuTime(value: string): number {
  const [days, clock] = value.includes('-') ? value.split('-') : ['0', value]
  return (
    Number(days) * 86400 + clock.split(':').reduce((total, part) => total * 60 + Number(part), 0)
  )
}

/** Samples live owners and delegates cleanup to them; PID observations are display-only. */
export class NotebookProcessMonitor {
  private readonly ids = new WeakMap<object, string>()
  private readonly stopping = new Map<string, Promise<void>>()
  private previousCpu = cpuTimes()
  private previousProcesses = new Map<string, { at: number; seconds: number }>()
  private readonly terminationEvents: ManualKernelTermination[] = []

  manualTerminations(projectId: string, sessionId: string): ManualKernelTermination[] {
    return this.terminationEvents
      .filter((event) => event.projectId === projectId && event.sessionId === sessionId)
      .map((event) => ({ ...event }))
  }

  async terminateRequest(request: TerminateNotebookProcessRequest): Promise<void> {
    if (
      !request ||
      (request.comment !== undefined &&
        (typeof request.comment !== 'string' || request.comment.length > 2000))
    )
      throw new Error('Invalid termination comment.')
    const ids = 'id' in request ? [request.id] : request.ids
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > 100 ||
      ids.some((id) => typeof id !== 'string') ||
      new Set(ids).size !== ids.length
    )
      throw new Error('Invalid kernel selection.')
    const resources = this.resources()
    const selected = ids.map((id) => {
      const resource = resources.find((item) => this.id(item) === id)
      if (!resource) throw new Error('Notebook process no longer exists. Refresh the list.')
      if (resource.projectId !== request.projectId || resource.sessionId !== request.sessionId)
        throw new Error('Kernel does not belong to this session.')
      return { id, resource }
    })
    const results = await Promise.allSettled(
      selected.map(async ({ id, resource }) => {
        const event: ManualKernelTermination = {
          id: randomUUID(),
          instanceId: id,
          projectId: resource.projectId,
          sessionId: resource.sessionId,
          kind: resource.kind,
          pid: resource.pid,
          requestedAt: Date.now(),
          comment: request.comment?.trim() ?? '',
          status: 'requested'
        }
        this.terminationEvents.push(event)
        // Bounded journal, readable even after the resource disappears.
        if (this.terminationEvents.length > 200) this.terminationEvents.shift()
        try {
          await this.terminate(id)
          event.status = 'stopped'
        } catch (error) {
          event.status = 'cleanup-failed'
          throw error
        }
      })
    )
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('Some kernel cleanup could not be confirmed. Refresh and retry.')
  }
  private sampleInFlight?: Promise<NotebookProcessMonitorSnapshot>
  private latest?: NotebookProcessMonitorSnapshot

  constructor(private readonly resources: () => MonitoredInterpreter[]) {}

  private id(resource: MonitoredInterpreter): string {
    let id = this.ids.get(resource.identity)
    if (!id) {
      id = randomUUID()
      this.ids.set(resource.identity, id)
    }
    return id
  }

  snapshot(): Promise<NotebookProcessMonitorSnapshot> {
    if (this.sampleInFlight) return this.sampleInFlight
    if (this.latest && Date.now() - this.latest.sampledAt < 1000)
      return Promise.resolve(this.latest)
    const sampling = this.sample().then((value) => (this.latest = value))
    this.sampleInFlight = sampling
    void sampling
      .finally(() => {
        if (this.sampleInFlight === sampling) this.sampleInFlight = undefined
      })
      .catch(() => undefined)
    return sampling
  }

  private async sample(): Promise<NotebookProcessMonitorSnapshot> {
    let available = true
    const samples = await processSamples().catch(() => {
      available = false
      return []
    })
    const currentCpu = cpuTimes()
    const elapsed = currentCpu.total - this.previousCpu.total
    const cpuPercent =
      elapsed > 0
        ? Math.max(
            0,
            Math.min(100, 100 * (1 - (currentCpu.idle - this.previousCpu.idle) / elapsed))
          )
        : undefined
    this.previousCpu = currentCpu
    const sampledAt = Date.now()
    const nextProcesses = new Map<string, { at: number; seconds: number }>()
    // Sampling yields to process exits/replacements. Project the owners that are live now.
    const instances = this.resources().map((resource): NotebookProcessObservation => {
      const pids = new Set<number>(resource.pid ? [resource.pid] : [])
      // Parent-first order is not guaranteed by ps/Toolhelp.
      let changed = true
      while (changed) {
        changed = false
        for (const sample of samples) {
          if (pids.has(sample.parentPid) && !pids.has(sample.pid)) {
            pids.add(sample.pid)
            changed = true
          }
        }
      }
      const id = this.id(resource)
      const processes = samples
        .filter((sample) => pids.has(sample.pid))
        .map((sample) => {
          const key = `${id}:${sample.pid}`
          const previous = this.previousProcesses.get(key)
          const cpuCores =
            sample.cpuSeconds !== undefined &&
            previous &&
            sampledAt > previous.at &&
            sample.cpuSeconds >= previous.seconds
              ? (sample.cpuSeconds - previous.seconds) / ((sampledAt - previous.at) / 1000)
              : undefined
          if (sample.cpuSeconds !== undefined)
            nextProcesses.set(key, { at: sampledAt, seconds: sample.cpuSeconds })
          return { ...sample, cpuCores }
        })
      const memoryKnown =
        processes.length > 0 && processes.every((item) => item.memoryBytes !== undefined)
      return {
        id,
        projectId: resource.projectId,
        sessionId: resource.sessionId,
        lane: resource.lane,
        kind: resource.kind,
        environment: resource.environment,
        pid: resource.pid,
        startedAt: resource.startedAt,
        hasLastCell: resource.lastCell !== undefined,
        lastCell: resource.lastCell,
        status: this.stopping.has(id) ? 'cleaning' : resource.status,
        processes,
        cpuCores:
          processes.length && processes.every((item) => item.cpuCores !== undefined)
            ? processes.reduce((sum, item) => sum + item.cpuCores!, 0)
            : undefined,
        memoryBytes: memoryKnown
          ? processes.reduce((sum, item) => sum + item.memoryBytes!, 0)
          : undefined
      }
    })
    this.previousProcesses = nextProcesses
    const memoryTotalBytes = totalmem()
    return {
      sampledAt: Date.now(),
      host: {
        hostname: hostname(),
        platform: platform(),
        cpuCount: cpus().length,
        cpuPercent,
        memoryTotalBytes,
        memoryUsedBytes: memoryTotalBytes - freemem(),
        uptimeSeconds: uptime()
      },
      processMetricsAvailable: available,
      instances
    }
  }

  terminate(id: string): Promise<void> {
    const pending = this.stopping.get(id)
    if (pending) return pending
    const resource = this.resources().find((item) => this.id(item) === id)
    if (!resource)
      return Promise.reject(new Error('Notebook process no longer exists. Refresh the list.'))
    // The owning adapter checks the captured object again and performs complete native cleanup.
    const stopping = resource.terminate().finally(() => {
      this.stopping.delete(id)
      this.latest = undefined
    })
    this.stopping.set(id, stopping)
    this.latest = undefined
    return stopping
  }
}
