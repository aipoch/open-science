import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ConsoleMessage, ElectronApplication } from 'playwright'
import {
  readProcessTree,
  type ProcessKind,
  type ProcessSnapshotEntry,
  type ProcessTreeSnapshot
} from './process-snapshot'

const PROFILE_SCHEMA_VERSION = 3
const DEFAULT_SAMPLE_INTERVAL_MS = 1_000
const MIN_SAMPLE_INTERVAL_MS = 250
const MAX_SAMPLE_INTERVAL_MS = 10_000
const SESSION_TRACE_MESSAGE_PREFIX = '[session-persistence] operation '

type ElectronProcessMetric = {
  creationTime: number
  cumulativeCpuSeconds?: number
  idleWakeupsPerSecond: number
  peakWorkingSetKb: number
  percentCpuUsage: number
  pid: number
  privateKb?: number
  type: string
  workingSetKb: number
}

type RuntimeProcessSample = {
  cpuPercent?: number
  electronType?: string
  identity: string
  kind: ProcessKind
  parentPid?: number
  pid: number
  privateKb?: number
  rssKb?: number
  workingSetKb?: number
}

type RuntimeResourceTotals = {
  electronPrivateKb?: number
  electronWorkingSetKb: number
  processCount: number
  summedRssKb: number
  totalCpuPercent: number
}

type RuntimeResourceSample = {
  capturedAt: number
  electronMetricsComplete: boolean
  elapsedMs: number
  phase: string
  processTreeComplete: boolean
  processes: RuntimeProcessSample[]
  rootPid: number
  storage?: RuntimeStorageTotals
  totals: RuntimeResourceTotals
}

type RuntimeStorageTotals = {
  notebookRunBytes: number
  notebookRunFileCount: number
  sessionBytes: number
  sessionFileCount: number
  temporaryBytes: number
  temporaryFileCount: number
}

type RuntimeStorageSummary = {
  notebookRunBytes: NumberStats
  notebookRunFileCount: NumberStats
  sessionBytes: NumberStats
  sessionFileCount: NumberStats
  temporaryBytes: NumberStats
  temporaryFileCount: NumberStats
}

type NumberStats = {
  delta: number
  first: number
  last: number
  max: number
  mean: number
  p95: number
}

type RuntimePhaseSummary = {
  electronPrivateKb?: NumberStats
  electronWorkingSetKb: NumberStats
  processCount: NumberStats
  roles: Record<
    string,
    {
      cpuPercent: NumberStats
      processCount: NumberStats
      rssKb: NumberStats
    }
  >
  includedSampleCount: number
  sampleCount: number
  storage?: RuntimeStorageSummary
  summedRssKb: NumberStats
  totalCpuPercent: NumberStats
}

type RuntimeProfileSummary = {
  architecture: string
  durationMs: number
  electronVersion?: string
  endedAt: number
  incompleteSampleCount: number
  nodeVersion: string
  phases: Record<string, RuntimePhaseSummary>
  platform: string
  sampleCount: number
  sampleIntervalMs: number
  schemaVersion: number
  sessionHydrationTrace: SessionHydrationTraceEvent[]
  startedAt: number
}

type SessionHydrationTraceEvent = {
  capturedAt: number
  event: 'started' | 'phase' | 'completed' | 'cancelled' | 'failed'
  operationId: string
  phase?: string
  cpuIntervalPhase?: string
  elapsedMs?: number
  phaseDurationMs?: number
  durationMs?: number
  cpuUserMs?: number
  cpuSystemMs?: number
  cpuTotalMs?: number
  phaseCpuUserMs?: number
  phaseCpuSystemMs?: number
  phaseCpuTotalMs?: number
  sessionCount?: number
  warningCount?: number
  projectDirectoryCount?: number
  sessionFileCount?: number
  sessionBytes?: number
  recoveryFailureCount?: number
  degradedReconciliationCount?: number
}

type SessionHydrationDiagnosticInput = {
  capturedAt: number
  data: unknown
  message: string
}

type RuntimeProfileResult = {
  outputDirectory: string
  samplePath: string
  summary: RuntimeProfileSummary
  summaryJsonPath: string
  summaryMarkdownPath: string
}

type RuntimeResourceProfilerOptions = {
  dataRoot?: string
  now?: () => number
  outputRoot?: string
  readTree?: (rootPid: number) => Promise<ProcessTreeSnapshot>
  runId?: string
  sampleIntervalMs?: number
  storageRoot?: string
}

type StorageFileKind = 'notebook-run' | 'session' | 'temporary'

const emptyStorageTotals = (): RuntimeStorageTotals => ({
  notebookRunBytes: 0,
  notebookRunFileCount: 0,
  sessionBytes: 0,
  sessionFileCount: 0,
  temporaryBytes: 0,
  temporaryFileCount: 0
})

const scanStorageFiles = async (
  root: string,
  classify: (name: string) => StorageFileKind | undefined,
  totals: RuntimeStorageTotals
): Promise<void> => {
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    }
  )
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name)
      if (entry.isDirectory()) {
        await scanStorageFiles(path, classify, totals)
        return
      }
      if (!entry.isFile()) return
      const kind = classify(entry.name)
      if (!kind) return
      const bytes = (await stat(path)).size
      if (kind === 'session') {
        totals.sessionFileCount += 1
        totals.sessionBytes += bytes
      } else if (kind === 'notebook-run') {
        totals.notebookRunFileCount += 1
        totals.notebookRunBytes += bytes
      } else {
        totals.temporaryFileCount += 1
        totals.temporaryBytes += bytes
      }
    })
  )
}

const readRuntimeStorageSnapshot = async (
  storageRoot: string,
  dataRoot = storageRoot
): Promise<RuntimeStorageTotals> => {
  const totals = emptyStorageTotals()
  await Promise.all([
    scanStorageFiles(
      join(storageRoot, 'sessions'),
      (name) =>
        name.endsWith('.tmp')
          ? 'temporary'
          : name !== 'manifest.json' && name.endsWith('.json')
            ? 'session'
            : undefined,
      totals
    ),
    scanStorageFiles(
      join(dataRoot, 'notebooks'),
      (name) =>
        name.endsWith('.tmp') ? 'temporary' : name === 'run.json' ? 'notebook-run' : undefined,
      totals
    )
  ])
  return totals
}

const SESSION_TRACE_NUMBER_FIELDS = [
  'elapsedMs',
  'phaseDurationMs',
  'durationMs',
  'cpuUserMs',
  'cpuSystemMs',
  'cpuTotalMs',
  'phaseCpuUserMs',
  'phaseCpuSystemMs',
  'phaseCpuTotalMs',
  'sessionCount',
  'warningCount',
  'projectDirectoryCount',
  'sessionFileCount',
  'sessionBytes',
  'recoveryFailureCount',
  'degradedReconciliationCount'
] as const satisfies readonly (keyof SessionHydrationTraceEvent)[]

const parseSessionHydrationDiagnostic = ({
  capturedAt,
  data,
  message
}: SessionHydrationDiagnosticInput): SessionHydrationTraceEvent | undefined => {
  if (
    !message.startsWith(SESSION_TRACE_MESSAGE_PREFIX) ||
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data)
  ) {
    return undefined
  }
  const record = data as Record<string, unknown>
  if (record.operation !== 'session-hydration' || typeof record.operationId !== 'string') {
    return undefined
  }
  const outcome = record.outcome
  const event: SessionHydrationTraceEvent['event'] =
    outcome === 'started'
      ? 'started'
      : outcome === 'completed' || outcome === 'cancelled' || outcome === 'failed'
        ? outcome
        : typeof record.phase === 'string'
          ? 'phase'
          : 'started'
  const trace: SessionHydrationTraceEvent = {
    capturedAt,
    event,
    operationId: record.operationId
  }
  if (typeof record.phase === 'string') trace.phase = record.phase
  if (typeof record.cpuIntervalPhase === 'string') {
    trace.cpuIntervalPhase = record.cpuIntervalPhase
  }
  for (const field of SESSION_TRACE_NUMBER_FIELDS) {
    const value = record[field]
    if (typeof value === 'number' && Number.isFinite(value)) {
      Object.assign(trace, { [field]: value })
    }
  }
  return trace
}

type CpuIdentityState = {
  capturedAt: number
  cumulativeCpuSeconds: number
  generation: number
  kind: ProcessKind
  parentPid: number
}

class ProcessCpuTracker {
  private readonly states = new Map<number, CpuIdentityState>()

  observe(
    process: ProcessSnapshotEntry,
    capturedAt: number
  ): { cpuPercent?: number; identity: string } {
    const previous = this.states.get(process.pid)
    const identityChanged =
      previous !== undefined &&
      (previous.parentPid !== process.parentPid ||
        previous.kind !== process.kind ||
        process.cumulativeCpuSeconds < previous.cumulativeCpuSeconds)
    const generation =
      previous === undefined ? 1 : identityChanged ? previous.generation + 1 : previous.generation
    let cpuPercent: number | undefined
    if (previous && !identityChanged && capturedAt > previous.capturedAt) {
      cpuPercent =
        ((process.cumulativeCpuSeconds - previous.cumulativeCpuSeconds) * 100_000) /
        (capturedAt - previous.capturedAt)
      if (!Number.isFinite(cpuPercent) || cpuPercent < 0) cpuPercent = undefined
    }
    this.states.set(process.pid, {
      capturedAt,
      generation,
      kind: process.kind,
      parentPid: process.parentPid,
      cumulativeCpuSeconds: process.cumulativeCpuSeconds
    })
    return {
      identity: `${process.pid}:${generation}`,
      ...(cpuPercent === undefined ? {} : { cpuPercent })
    }
  }
}

const validateSampleInterval = (value: number): number => {
  if (
    !Number.isInteger(value) ||
    value < MIN_SAMPLE_INTERVAL_MS ||
    value > MAX_SAMPLE_INTERVAL_MS
  ) {
    throw new Error(
      `sampleIntervalMs must be an integer between ${MIN_SAMPLE_INTERVAL_MS} and ${MAX_SAMPLE_INTERVAL_MS}.`
    )
  }
  return value
}

const validatePhase = (phase: string): string => {
  if (!/^[a-z][a-z0-9-]{0,39}$/u.test(phase)) {
    throw new Error('Performance phase must be a lowercase kebab-case label.')
  }
  return phase
}

const percentile = (values: readonly number[], ratio: number): number => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0
}

const numberStats = (values: readonly number[]): NumberStats => {
  const first = values[0] ?? 0
  const last = values.at(-1) ?? 0
  return {
    first,
    last,
    delta: last - first,
    max: Math.max(...values, 0),
    mean: values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length,
    p95: percentile(values, 0.95)
  }
}

const processRole = (process: RuntimeProcessSample): string =>
  process.electronType
    ? `electron-${process.electronType.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '-')}`
    : `external-${process.kind}`

const summarizeSamples = (
  samples: readonly RuntimeResourceSample[],
  metadata: {
    electronVersion?: string
    endedAt: number
    nodeVersion: string
    sampleIntervalMs: number
    startedAt: number
  },
  sessionHydrationTrace: readonly SessionHydrationTraceEvent[] = []
): RuntimeProfileSummary => {
  const byPhase = new Map<string, RuntimeResourceSample[]>()
  for (const sample of samples) {
    const phaseSamples = byPhase.get(sample.phase) ?? []
    phaseSamples.push(sample)
    byPhase.set(sample.phase, phaseSamples)
  }
  const phases: Record<string, RuntimePhaseSummary> = {}
  for (const [phase, phaseSamples] of byPhase) {
    const includedSamples = phaseSamples.filter(
      (sample) => sample.processTreeComplete && sample.electronMetricsComplete
    )
    const privateValues = includedSamples
      .map((sample) => sample.totals.electronPrivateKb)
      .filter((value): value is number => value !== undefined)
    const storageSamples = phaseSamples
      .map((sample) => sample.storage)
      .filter((value): value is RuntimeStorageTotals => value !== undefined)
    const roleNames = new Set(
      includedSamples.flatMap((sample) => sample.processes.map((process) => processRole(process)))
    )
    const roles: RuntimePhaseSummary['roles'] = {}
    for (const role of [...roleNames].sort()) {
      const roleSamples = includedSamples.map((sample) => {
        const processes = sample.processes.filter((process) => processRole(process) === role)
        return {
          cpuPercent: processes.reduce((sum, process) => sum + (process.cpuPercent ?? 0), 0),
          processCount: processes.length,
          rssKb: processes.reduce(
            (sum, process) => sum + (process.rssKb ?? process.workingSetKb ?? 0),
            0
          )
        }
      })
      roles[role] = {
        cpuPercent: numberStats(roleSamples.map((sample) => sample.cpuPercent)),
        processCount: numberStats(roleSamples.map((sample) => sample.processCount)),
        rssKb: numberStats(roleSamples.map((sample) => sample.rssKb))
      }
    }
    phases[phase] = {
      sampleCount: phaseSamples.length,
      includedSampleCount: includedSamples.length,
      roles,
      totalCpuPercent: numberStats(includedSamples.map((sample) => sample.totals.totalCpuPercent)),
      summedRssKb: numberStats(includedSamples.map((sample) => sample.totals.summedRssKb)),
      electronWorkingSetKb: numberStats(
        includedSamples.map((sample) => sample.totals.electronWorkingSetKb)
      ),
      processCount: numberStats(includedSamples.map((sample) => sample.totals.processCount)),
      ...(storageSamples.length === 0
        ? {}
        : {
            storage: {
              notebookRunBytes: numberStats(
                storageSamples.map((sample) => sample.notebookRunBytes)
              ),
              notebookRunFileCount: numberStats(
                storageSamples.map((sample) => sample.notebookRunFileCount)
              ),
              sessionBytes: numberStats(storageSamples.map((sample) => sample.sessionBytes)),
              sessionFileCount: numberStats(
                storageSamples.map((sample) => sample.sessionFileCount)
              ),
              temporaryBytes: numberStats(storageSamples.map((sample) => sample.temporaryBytes)),
              temporaryFileCount: numberStats(
                storageSamples.map((sample) => sample.temporaryFileCount)
              )
            }
          }),
      ...(privateValues.length === 0 ? {} : { electronPrivateKb: numberStats(privateValues) })
    }
  }
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    platform: platform(),
    architecture: arch(),
    nodeVersion: metadata.nodeVersion,
    ...(metadata.electronVersion ? { electronVersion: metadata.electronVersion } : {}),
    startedAt: metadata.startedAt,
    endedAt: metadata.endedAt,
    durationMs: metadata.endedAt - metadata.startedAt,
    sampleIntervalMs: metadata.sampleIntervalMs,
    sampleCount: samples.length,
    incompleteSampleCount: samples.filter(
      (sample) => !sample.processTreeComplete || !sample.electronMetricsComplete
    ).length,
    sessionHydrationTrace: sessionHydrationTrace.map((event) => ({ ...event })),
    phases
  }
}

const formatNumber = (value: number): string => value.toFixed(1)
const formatMb = (valueKb: number): string => formatNumber(valueKb / 1024)
const formatBytesMb = (valueBytes: number): string => formatNumber(valueBytes / (1024 * 1024))

const renderSummaryMarkdown = (summary: RuntimeProfileSummary): string => {
  const rows = Object.entries(summary.phases).map(([phase, stats]) => {
    const roleEntries = Object.entries(stats.roles)
    const topCpuRole = roleEntries.toSorted(
      (left, right) => right[1].cpuPercent.mean - left[1].cpuPercent.mean
    )[0]?.[0]
    const topRssRole = roleEntries.toSorted(
      (left, right) => right[1].rssKb.max - left[1].rssKb.max
    )[0]?.[0]
    return [
      phase,
      `${stats.includedSampleCount}/${stats.sampleCount}`,
      formatNumber(stats.totalCpuPercent.mean),
      formatNumber(stats.totalCpuPercent.p95),
      formatNumber(stats.totalCpuPercent.max),
      formatNumber(stats.totalCpuPercent.last),
      formatMb(stats.summedRssKb.first),
      formatMb(stats.summedRssKb.max),
      formatMb(stats.summedRssKb.last),
      formatMb(stats.summedRssKb.delta),
      formatNumber(stats.processCount.max),
      topCpuRole ?? 'unavailable',
      topRssRole ?? 'unavailable'
    ].join(' | ')
  })
  const sessionTraceRows = summary.sessionHydrationTrace.filter(
    (event) => event.phaseCpuTotalMs !== undefined
  )
  const sessionOperationNumbers = new Map<string, number>()
  const numberedSessionTraceRows = sessionTraceRows.map((event) => {
    const operationNumber =
      sessionOperationNumbers.get(event.operationId) ?? sessionOperationNumbers.size + 1
    sessionOperationNumbers.set(event.operationId, operationNumber)
    return [
      operationNumber,
      event.cpuIntervalPhase ?? 'unavailable',
      event.event === 'phase' ? (event.phase ?? 'phase') : event.event,
      formatNumber(event.phaseDurationMs ?? 0),
      formatNumber(event.phaseCpuUserMs ?? 0),
      formatNumber(event.phaseCpuSystemMs ?? 0),
      formatNumber(event.phaseCpuTotalMs ?? 0)
    ].join(' | ')
  })
  const sessionTraceSection =
    numberedSessionTraceRows.length === 0
      ? ''
      : `
## Session hydration CPU trace

Operation | CPU interval | Boundary/outcome | Wall ms | CPU user ms | CPU system ms | CPU total ms
---: | --- | --- | ---: | ---: | ---: | ---:
${numberedSessionTraceRows.join('\n')}
`
  const storageRows = Object.entries(summary.phases).flatMap(([phase, stats]) => {
    if (!stats.storage) return []
    return [
      [
        phase,
        formatNumber(stats.storage.sessionFileCount.last),
        formatBytesMb(stats.storage.sessionBytes.first),
        formatBytesMb(stats.storage.sessionBytes.last),
        formatBytesMb(stats.storage.sessionBytes.delta),
        formatNumber(stats.storage.notebookRunFileCount.last),
        formatBytesMb(stats.storage.notebookRunBytes.first),
        formatBytesMb(stats.storage.notebookRunBytes.last),
        formatBytesMb(stats.storage.notebookRunBytes.delta),
        formatNumber(stats.storage.temporaryFileCount.max),
        formatNumber(stats.storage.temporaryFileCount.last)
      ].join(' | ')
    ]
  })
  const storageSection =
    storageRows.length === 0
      ? ''
      : `
## Durable storage snapshots

Phase | Session files end | Session start MB | Session end MB | Session delta MB | Notebook run files end | Notebook start MB | Notebook end MB | Notebook delta MB | Temp files peak | Temp files end
--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:
${storageRows.join('\n')}
`
  return `# Runtime resource profile

- Platform: ${summary.platform}/${summary.architecture}
- Electron: ${summary.electronVersion ?? 'unavailable'}
- Sample interval: ${summary.sampleIntervalMs} ms
- Samples: ${summary.sampleCount} (${summary.incompleteSampleCount} excluded because a process-tree or Electron snapshot was incomplete)
- Duration: ${formatNumber(summary.durationMs / 1000)} s

Phase | Included/total | CPU mean % | CPU p95 % | CPU peak % | CPU end % | RSS start MB | RSS peak MB | RSS end MB | RSS delta MB | Process peak | Top CPU role | Top RSS role
--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---
${rows.join('\n')}
${sessionTraceSection}
${storageSection}

RSS is the sum of per-process resident sets and can double-count shared pages. It is intended for
same-machine trend comparison, not as a portable absolute memory value. The profile records no
prompts, responses, command arguments, environment variables, paths, endpoints, or file contents.
`
}

const mergeResourceSample = (
  capturedAt: number,
  elapsedMs: number,
  phase: string,
  tree: ProcessTreeSnapshot,
  electronMetrics: readonly ElectronProcessMetric[],
  cpuTracker: ProcessCpuTracker,
  electronMetricsComplete = true,
  storage?: RuntimeStorageTotals
): RuntimeResourceSample => {
  const electronByPid = new Map(electronMetrics.map((metric) => [metric.pid, metric]))
  const processes: RuntimeProcessSample[] = tree.processes.map((process) => {
    const cpu = cpuTracker.observe(process, capturedAt)
    const electron = electronByPid.get(process.pid)
    return {
      pid: process.pid,
      parentPid: process.parentPid,
      identity: electron ? `${process.pid}:${electron.creationTime}` : cpu.identity,
      kind: electron ? 'electron' : process.kind,
      cpuPercent: electron?.percentCpuUsage ?? cpu.cpuPercent,
      rssKb: process.rssKb,
      ...(electron
        ? {
            electronType: electron.type,
            workingSetKb: electron.workingSetKb,
            ...(electron.privateKb === undefined ? {} : { privateKb: electron.privateKb })
          }
        : {})
    }
  })
  const capturedPids = new Set(processes.map((process) => process.pid))
  for (const electron of electronMetrics) {
    if (capturedPids.has(electron.pid)) continue
    processes.push({
      pid: electron.pid,
      identity: `${electron.pid}:${electron.creationTime}`,
      kind: 'electron',
      electronType: electron.type,
      cpuPercent: electron.percentCpuUsage,
      workingSetKb: electron.workingSetKb,
      ...(electron.privateKb === undefined ? {} : { privateKb: electron.privateKb })
    })
  }
  processes.sort((left, right) => left.pid - right.pid)

  const privateValues = electronMetrics
    .map((metric) => metric.privateKb)
    .filter((value): value is number => value !== undefined)
  return {
    capturedAt,
    elapsedMs,
    phase,
    rootPid: tree.rootPid,
    processTreeComplete: tree.complete,
    electronMetricsComplete,
    processes,
    ...(storage ? { storage } : {}),
    totals: {
      processCount: processes.length,
      totalCpuPercent: processes.reduce((sum, process) => sum + (process.cpuPercent ?? 0), 0),
      summedRssKb: processes.reduce((sum, process) => sum + (process.rssKb ?? 0), 0),
      electronWorkingSetKb: electronMetrics.reduce((sum, metric) => sum + metric.workingSetKb, 0),
      ...(privateValues.length === 0
        ? {}
        : { electronPrivateKb: privateValues.reduce((sum, value) => sum + value, 0) })
    }
  }
}

class RuntimeResourceProfiler {
  private application: ElectronApplication | undefined
  private readonly consoleListeners = new Map<
    ElectronApplication,
    (message: ConsoleMessage) => void
  >()
  private electronVersion: string | undefined
  private readonly cpuTracker = new ProcessCpuTracker()
  private readonly dataRoot: string | undefined
  private readonly now: () => number
  private readonly outputRoot: string
  private readonly readTree: (rootPid: number) => Promise<ProcessTreeSnapshot>
  private readonly runId: string
  private readonly sampleIntervalMs: number
  private readonly storageRoot: string | undefined
  private readonly samples: RuntimeResourceSample[] = []
  private readonly sessionHydrationTrace: SessionHydrationTraceEvent[] = []
  private phase = 'startup'
  private sampleInFlight: Promise<void> | undefined
  private startedAt: number
  private timer: NodeJS.Timeout | undefined
  private traceCaptureInFlight: Promise<void> = Promise.resolve()

  constructor(options: RuntimeResourceProfilerOptions = {}) {
    this.now = options.now ?? Date.now
    this.dataRoot = options.dataRoot ? resolve(options.dataRoot) : undefined
    this.outputRoot = resolve(
      options.outputRoot ?? join(process.cwd(), 'test-results', 'performance')
    )
    this.readTree = options.readTree ?? ((rootPid) => readProcessTree(rootPid))
    this.runId =
      options.runId ??
      `${new Date(this.now()).toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`
    this.sampleIntervalMs = validateSampleInterval(
      options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS
    )
    this.storageRoot = options.storageRoot ? resolve(options.storageRoot) : undefined
    this.startedAt = this.now()
  }

  async attach(application: ElectronApplication): Promise<void> {
    this.application = application
    if (!this.consoleListeners.has(application)) {
      const listener = (message: ConsoleMessage): void => this.queueSessionTraceCapture(message)
      this.consoleListeners.set(application, listener)
      application.on('console', listener)
    }
    this.electronVersion ??= await application
      .evaluate(() => process.versions.electron)
      .catch(() => undefined)
    if (!this.timer) {
      this.startedAt = this.now()
      this.timer = setInterval(() => this.queueSample(), this.sampleIntervalMs)
    }
    await this.queueSample()
  }

  detach(application?: ElectronApplication): void {
    const target = application ?? this.application
    if (target) {
      const listener = this.consoleListeners.get(target)
      if (listener) target.off('console', listener)
      this.consoleListeners.delete(target)
    }
    if (!application || this.application === application) this.application = undefined
  }

  markPhase(phase: string): void {
    this.phase = validatePhase(phase)
  }

  async sampleNow(): Promise<void> {
    await this.queueSample(this.phase, true)
  }

  async finish(): Promise<RuntimeProfileResult> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.sampleInFlight
    await this.traceCaptureInFlight
    const endedAt = this.now()
    const summary = summarizeSamples(
      this.samples,
      {
        startedAt: this.startedAt,
        endedAt,
        sampleIntervalMs: this.sampleIntervalMs,
        nodeVersion: process.versions.node,
        electronVersion: this.electronVersion
      },
      this.sessionHydrationTrace
    )
    const outputDirectory = join(this.outputRoot, this.runId)
    await mkdir(outputDirectory, { recursive: true })
    const samplePath = join(outputDirectory, 'samples.jsonl')
    const summaryJsonPath = join(outputDirectory, 'summary.json')
    const summaryMarkdownPath = join(outputDirectory, 'summary.md')
    await Promise.all([
      writeFile(
        samplePath,
        `${this.samples.map((sample) => JSON.stringify(sample)).join('\n')}\n`,
        'utf8'
      ),
      writeFile(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8'),
      writeFile(summaryMarkdownPath, renderSummaryMarkdown(summary), 'utf8')
    ])
    return { outputDirectory, samplePath, summary, summaryJsonPath, summaryMarkdownPath }
  }

  abort(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.application = undefined
    for (const [application, listener] of this.consoleListeners) {
      application.off('console', listener)
    }
    this.consoleListeners.clear()
  }

  private queueSessionTraceCapture(message: ConsoleMessage): void {
    const capturedAt = this.now()
    const capture = (async (): Promise<void> => {
      const consoleText = message.text()
      if (!consoleText.startsWith(SESSION_TRACE_MESSAGE_PREFIX)) return
      const data = await message
        .args()[1]
        ?.jsonValue()
        .catch(() => undefined)
      const trace = parseSessionHydrationDiagnostic({
        capturedAt,
        message: consoleText,
        data
      })
      if (trace) this.sessionHydrationTrace.push(trace)
    })().catch(() => undefined)
    this.traceCaptureInFlight = Promise.all([this.traceCaptureInFlight, capture]).then(
      () => undefined
    )
  }

  private queueSample(phase = this.phase, force = false): Promise<void> {
    if (this.sampleInFlight && !force) return this.sampleInFlight
    const previousSample = this.sampleInFlight
    const sampling = (
      previousSample
        ? previousSample.then(() => this.captureSample(phase, force))
        : this.captureSample(phase, force)
    ).finally(() => {
      if (this.sampleInFlight === sampling) this.sampleInFlight = undefined
    })
    this.sampleInFlight = sampling
    return sampling
  }

  private async captureSample(phase: string, includeStorage: boolean): Promise<void> {
    const application = this.application
    const rootPid = application?.process().pid
    if (!application || rootPid === undefined) return
    const capturedAt = this.now()
    const [tree, electronSnapshot, storage] = await Promise.all([
      this.readTree(rootPid),
      application
        .evaluate(({ app }) => {
          const metrics = app.getAppMetrics().map((metric) => ({
            pid: metric.pid,
            type: metric.type,
            creationTime: metric.creationTime,
            percentCpuUsage: metric.cpu.percentCPUUsage,
            cumulativeCpuSeconds: metric.cpu.cumulativeCPUUsage,
            idleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond,
            workingSetKb: metric.memory.workingSetSize,
            peakWorkingSetKb: metric.memory.peakWorkingSetSize,
            privateKb: metric.memory.privateBytes
          }))
          return new Promise<typeof metrics>((resolveMetrics) => {
            setImmediate(() => resolveMetrics(metrics))
          })
        })
        .then(
          (metrics) => ({ complete: true, metrics }),
          (error) => {
            process.stderr.write(
              `Runtime resource profiler could not capture Electron metrics: ${error instanceof Error ? error.message : String(error)}\n`
            )
            return { complete: false, metrics: [] as ElectronProcessMetric[] }
          }
        ),
      includeStorage && this.storageRoot
        ? readRuntimeStorageSnapshot(this.storageRoot, this.dataRoot)
        : Promise.resolve(undefined)
    ])
    this.samples.push(
      mergeResourceSample(
        capturedAt,
        capturedAt - this.startedAt,
        phase,
        tree,
        electronSnapshot.metrics,
        this.cpuTracker,
        electronSnapshot.complete,
        storage
      )
    )
  }
}

export {
  DEFAULT_SAMPLE_INTERVAL_MS,
  MAX_SAMPLE_INTERVAL_MS,
  MIN_SAMPLE_INTERVAL_MS,
  PROFILE_SCHEMA_VERSION,
  ProcessCpuTracker,
  RuntimeResourceProfiler,
  mergeResourceSample,
  parseSessionHydrationDiagnostic,
  readRuntimeStorageSnapshot,
  renderSummaryMarkdown,
  summarizeSamples,
  validatePhase,
  validateSampleInterval
}
export type {
  ElectronProcessMetric,
  NumberStats,
  RuntimePhaseSummary,
  RuntimeProcessSample,
  RuntimeProfileResult,
  RuntimeProfileSummary,
  RuntimeResourceProfilerOptions,
  RuntimeResourceSample,
  RuntimeResourceTotals,
  RuntimeStorageSummary,
  RuntimeStorageTotals,
  SessionHydrationTraceEvent
}
