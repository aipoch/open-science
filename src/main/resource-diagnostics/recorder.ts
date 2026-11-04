import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import type { ChildProcess } from 'node:child_process'
import type { ResourceProcessIdentity, WindowsResourceSample } from '@aipoch/process-tree-native'
import { ResourceLogStore } from './store'

const requireNative = createRequire(import.meta.url)
type NativeSampler = typeof import('@aipoch/process-tree-native')
export type ResourceFacts = Record<string, unknown>
export type ResourceObservation = { resourceDiagnosticSnapshot(): ResourceFacts }
const keys = new Set(
  (
    'runtimeId epoch framework status pid parentPid birth ownerPid ownerBirth role sessionId providerSessionId projectId ' +
    'frameId turnId activeBranchId kind sequence generation attached sessions interactions inFlight ' +
    'reconnect retirement activePrompts activeReviewers activityLeases operationLeases startups additionalActivity ' +
    'idleReleasePending retirementPending teardownPending providerPending skillsPending ' +
    'kernelEpochId receiptId lane attempt expected code signal reaped osReaped reason truncated total ' +
    'supported complete startedAt endedAt system committedBytes commitLimitBytes availableBytes systemError ' +
    'processes privateBytes workingSetBytes handleCount error sampleId elapsedMs dropped sealsSuppressed rotatedBytes ' +
    'pendingBytes failed missing snapshots processCoverage writeFailures'
  ).split(' ')
)

// Only structural metadata enters the default journal. Unknown keys, free-form payloads and paths
// are discarded here even if a future observer accidentally passes a broader object.
export const resourceFacts = (value: unknown, depth = 0): unknown => {
  if (depth > 6) return undefined
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') return /^[\w.:-]{1,160}$/.test(value) ? value : undefined
  if (Array.isArray(value)) return value.slice(0, 256).map((item) => resourceFacts(item, depth + 1))
  if (!value || typeof value !== 'object') return undefined
  const output: ResourceFacts = {}
  for (const [key, item] of Object.entries(value)) {
    if (!keys.has(key)) continue
    const projected = resourceFacts(item, depth + 1)
    if (projected !== undefined) output[key] = projected
  }
  return output
}

type Options = {
  runId: string
  store: ResourceLogStore
  native?: Pick<NativeSampler, 'sampleWindowsResources' | 'readWindowsResourceBirth'>
  now?: () => number
  timers?: boolean
}

export class ResourceRecorder {
  private readonly runtimes = new Map<string, WeakRef<ResourceObservation>>()
  private readonly native: Options['native']
  private readonly now: () => number
  private readonly started = performance.now()
  private sequence = 0
  private runtimeSequence = 0
  private retained: ResourceProcessIdentity[] = []
  private identities = new Map<string, ResourceFacts>()
  private sampleSequence = 0
  private pending: Promise<void> | undefined
  private closed = false
  private lastFull = -Infinity
  private timer: ReturnType<typeof setInterval> | undefined
  private missing = 0

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now
    try {
      this.native = options.native ?? requireNative('@aipoch/process-tree-native')
    } catch {
      /* Explicit unavailable sample below. */
    }
    const birth = this.birth(process.pid)
    if (birth) this.observeIdentity({ pid: process.pid, birth, role: 'backend' })
    options.store.setCheckpoint(() => this.checkpoint())
    this.event('run-start', { pid: process.pid, processCoverage: 'backend-family' })
    if (options.timers !== false) {
      this.timer = setInterval(() => void this.sample(), 10_000)
      this.timer.unref()
      void this.sample()
    }
  }

  event(event: string, fields: ResourceFacts, anomaly = false, sampled = false): void {
    if (this.closed) return
    try {
      const line =
        JSON.stringify({
          schema: 1,
          runId: this.options.runId,
          sequence: ++this.sequence,
          time: this.now(),
          elapsedMs: performance.now() - this.started,
          event,
          data: resourceFacts(fields)
        }) + '\n'
      if (Buffer.byteLength(line) > 64 * 1024) {
        this.missing++
        return
      }
      this.options.store.append(line, anomaly, sampled)
    } catch {
      this.missing++
    }
  }

  register(owner: ResourceObservation, identity?: string): string | undefined {
    if (this.closed) return undefined
    for (const [id, ref] of this.runtimes) if (!ref.deref()) this.runtimes.delete(id)
    if (this.runtimes.size >= 256) {
      this.missing++
      return undefined
    }
    const id = identity ?? `r${++this.runtimeSequence}`
    this.runtimes.set(id, new WeakRef(owner))
    return id
  }

  unregister(id: string): void {
    this.runtimes.delete(id)
  }

  birth(pid: number | undefined): string | undefined {
    if (pid === undefined || this.closed) return undefined
    try {
      return this.native?.readWindowsResourceBirth(pid) ?? undefined
    } catch {
      return undefined
    }
  }

  observeIdentity(fields: ResourceFacts): void {
    if (typeof fields.pid !== 'number' || typeof fields.birth !== 'string') {
      this.missing++
      return
    }
    const key = `${fields.pid}:${fields.birth}`
    if (this.identities.size >= 4096 && !this.identities.has(key)) {
      this.missing++
      return
    }
    this.identities.set(
      key,
      resourceFacts({ ...fields, ownerPid: fields.pid, ownerBirth: fields.birth }) as ResourceFacts
    )
  }

  snapshot(runtimeId: string, owner: ResourceObservation, event = 'activity-snapshot'): void {
    try {
      this.event(
        event,
        { ...owner.resourceDiagnosticSnapshot(), runtimeId },
        false,
        event === 'activity-snapshot'
      )
    } catch {
      this.missing++
    }
  }

  private checkpoint(): string {
    const processes: string[] = []
    const snapshots: string[] = []
    let bytes = 0
    let truncated = false
    const append = (target: string[], value: unknown, budget: number): boolean => {
      const line = JSON.stringify(value)
      const size = Buffer.byteLength(line) + 1
      if (bytes + size > budget) {
        truncated = true
        return false
      }
      target.push(line)
      bytes += size
      return true
    }
    // Reserve space for activity and the envelope. Stop reading owners as soon as the remaining
    // budget is exhausted; never build a large table and repeatedly serialize it to trim it.
    for (const fields of this.identities.values()) {
      if (!append(processes, fields, 48 * 1024)) break
    }
    for (const [runtimeId, ref] of this.runtimes) {
      try {
        const owner = ref.deref()
        if (
          owner &&
          !append(
            snapshots,
            resourceFacts({ ...owner.resourceDiagnosticSnapshot(), runtimeId }),
            60 * 1024
          )
        )
          break
      } catch {
        this.missing++
      }
    }
    const total = this.identities.size + this.runtimes.size
    const envelope = JSON.stringify({
      schema: 1,
      runId: this.options.runId,
      event: 'segment-checkpoint',
      time: this.now(),
      throughSequence: this.sequence
    })
    const status = JSON.stringify({ truncated, total, missing: this.missing })
    return `${envelope.slice(0, -1)},"data":{${status.slice(1, -1)},"processes":[${processes.join(',')}],"snapshots":[${snapshots.join(',')}]}}\n`
  }

  sample(): Promise<void> {
    if (this.pending || this.closed) return this.pending ?? Promise.resolve()
    const full = this.now() - this.lastFull >= 30_000
    const sampleId = ++this.sampleSequence
    const observedAtStart = new Set(this.identities.keys())
    if (full) {
      this.lastFull = this.now()
      for (const [id, ref] of this.runtimes) {
        const owner = ref.deref()
        if (owner) this.snapshot(id, owner)
        else this.runtimes.delete(id)
      }
    }
    this.event(
      'sample-start',
      { sampleId, missing: this.missing, ...this.options.store.status },
      false,
      true
    )
    const timeout = setTimeout(() => this.event('sample-delayed', { sampleId }, false, true), 2000)
    timeout.unref()
    // A timeout records a gap but never releases this guard while the OS query remains outstanding.
    this.pending = (async () => {
      try {
        const sample = await this.native?.sampleWindowsResources(full, this.retained)
        if (this.closed) return
        if (!sample) {
          this.event('sample-unavailable', { sampleId }, false, true)
          return
        }
        this.accept(sampleId, full, sample, observedAtStart)
      } catch {
        this.event('sample-failed', { sampleId }, false, true)
      } finally {
        clearTimeout(timeout)
      }
    })().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }

  private accept(
    sampleId: number,
    full: boolean,
    sample: WindowsResourceSample,
    observedAtStart: Set<string>
  ): void {
    this.event(
      'system-sample',
      {
        sampleId,
        supported: sample.supported,
        complete: sample.complete,
        startedAt: sample.startedAt,
        endedAt: sample.endedAt,
        system: sample.system,
        systemError: sample.systemError
      },
      false,
      true
    )
    if (!full) return
    const identities = new Map<number, ResourceProcessIdentity>(
      sample.complete ? [] : this.retained.map((p) => [p.pid, p])
    )
    const processes = new Map(sample.processes.slice(0, 4096).map((p) => [p.pid, p]))
    const linked = new Map<string, ResourceFacts>(
      sample.complete
        ? [...this.identities].filter(([key]) => !observedAtStart.has(key))
        : this.identities
    )
    for (const item of sample.processes.slice(0, 4096)) {
      if (item.birth) identities.set(item.pid, { pid: item.pid, birth: item.birth })
      let ancestor = item
      let fields: ResourceFacts | undefined
      const visited = new Set<number>()
      while (ancestor.birth && !visited.has(ancestor.pid)) {
        visited.add(ancestor.pid)
        fields = this.identities.get(`${ancestor.pid}:${ancestor.birth}`)
        if (fields) break
        const parent = processes.get(ancestor.parentPid)
        if (!parent?.birth || BigInt(parent.birth) > BigInt(ancestor.birth)) break
        ancestor = parent
      }
      if (fields && item.birth)
        linked.set(`${item.pid}:${item.birth}`, {
          ...fields,
          pid: item.pid,
          birth: item.birth,
          parentPid: item.parentPid
        })
      // Repeating the metadata in every sample preserves the join after the birth segment rotates.
      this.event('process-sample', { ...fields, sampleId, ...item }, false, true)
    }
    this.identities = new Map([...linked].slice(0, 4096))
    this.retained = [...identities.values()].slice(0, 4096)
    this.event(
      'sample-end',
      {
        sampleId,
        total: sample.processes.length,
        complete: sample.complete,
        truncated: sample.processes.length > 4096,
        ...this.options.store.status
      },
      false,
      true
    )
  }

  async close(clean: boolean): Promise<void> {
    if (this.closed) return
    clearInterval(this.timer)
    this.event('run-end', { expected: clean, missing: this.missing, ...this.options.store.status })
    this.closed = true
    this.runtimes.clear()
    this.retained = []
    this.identities.clear()
    // The host's existing shutdown deadline remains authoritative. Do not await a pending OS read.
    await this.options.store.close(clean)
  }
}

let active: ResourceRecorder | undefined
export const installResourceRecorder = (recorder: ResourceRecorder | undefined): void => {
  active = recorder
}
export const registerResourceObservation = (
  owner: ResourceObservation,
  id?: string
): string | undefined => active?.register(owner, id)
export const unregisterResourceObservation = (id: string): void => {
  active?.unregister(id)
}
export const recordResourceEvent = (
  event: string,
  fields: ResourceFacts,
  anomaly = false
): void => {
  active?.event(event, fields, anomaly)
}
export const recordResourceSnapshot = (
  id: string | undefined,
  owner: ResourceObservation,
  event?: string
): void => {
  if (id) active?.snapshot(id, owner, event)
}
export const resourceProcessBirth = (pid: number | undefined): string | undefined =>
  active?.birth(pid)

export const observeResourceProcess = (
  child: ChildProcess,
  fields: ResourceFacts,
  expected: () => boolean | undefined
): void => {
  const recorder = active
  if (!recorder) return
  try {
    const identity = { ...fields, pid: child.pid, birth: recorder.birth(child.pid) }
    recorder.observeIdentity(identity)
    recorder.event('process-born', identity)
    child.once('exit', (code, signal) => {
      let wasExpected: boolean | undefined
      try {
        wasExpected = expected()
      } catch {
        /* Missing owner evidence stays unknown. */
      }
      recorder.event(
        'process-exited',
        { ...identity, code, signal, expected: wasExpected },
        wasExpected === false
      )
    })
    child.once('error', () => recorder.event('process-error', identity))
  } catch {
    /* Observing a child must not change process ownership. */
  }
}
