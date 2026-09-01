import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import type { ProcessSnapshotEntry, ProcessTreeSnapshot } from './process-snapshot'
import {
  ProcessCpuTracker,
  RuntimeResourceProfiler,
  mergeResourceSample,
  parseSessionHydrationDiagnostic,
  readRuntimeStorageSnapshot,
  renderSummaryMarkdown,
  summarizeSamples,
  validatePhase,
  validateSampleInterval,
  type ElectronProcessMetric,
  type RuntimeResourceSample
} from './runtime-resource-profiler'

const processEntry = (overrides: Partial<ProcessSnapshotEntry> = {}): ProcessSnapshotEntry => ({
  pid: 10,
  parentPid: 1,
  kind: 'electron',
  rssKb: 100,
  cumulativeCpuSeconds: 1,
  ...overrides
})

const tree = (processes: ProcessSnapshotEntry[]): ProcessTreeSnapshot => ({
  rootPid: 10,
  complete: true,
  processes
})

const electronMetric = (overrides: Partial<ElectronProcessMetric> = {}): ElectronProcessMetric => ({
  pid: 10,
  type: 'Browser',
  creationTime: 1_000,
  percentCpuUsage: 5,
  cumulativeCpuSeconds: 1,
  idleWakeupsPerSecond: 0,
  workingSetKb: 90,
  peakWorkingSetKb: 100,
  ...overrides
})

describe('runtime resource profiler', () => {
  it('calculates external-process CPU deltas and resets identity after PID reuse', () => {
    const tracker = new ProcessCpuTracker()
    expect(tracker.observe(processEntry({ kind: 'agent' }), 1_000)).toEqual({ identity: '10:1' })
    expect(
      tracker.observe(processEntry({ kind: 'agent', cumulativeCpuSeconds: 1.5 }), 2_000)
    ).toEqual({ identity: '10:1', cpuPercent: 50 })
    expect(
      tracker.observe(processEntry({ kind: 'python', cumulativeCpuSeconds: 0.1 }), 3_000)
    ).toEqual({ identity: '10:2' })
  })

  it('merges Electron role metrics with external descendants without content fields', () => {
    const sample = mergeResourceSample(
      2_000,
      1_000,
      'acp-turn',
      tree([
        processEntry(),
        processEntry({
          pid: 11,
          parentPid: 10,
          kind: 'agent',
          rssKb: 50,
          cumulativeCpuSeconds: 0.5
        })
      ]),
      [electronMetric()],
      new ProcessCpuTracker()
    )

    expect(sample.totals).toEqual({
      processCount: 2,
      totalCpuPercent: 5,
      summedRssKb: 150,
      electronWorkingSetKb: 90
    })
    expect(sample.processes).toEqual([
      {
        pid: 10,
        parentPid: 1,
        identity: '10:1000',
        kind: 'electron',
        cpuPercent: 5,
        rssKb: 100,
        electronType: 'Browser',
        workingSetKb: 90
      },
      { pid: 11, parentPid: 10, identity: '11:1', kind: 'agent', rssKb: 50 }
    ])
    expect(JSON.stringify(sample)).not.toMatch(/prompt|response|argument|environment|path/iu)
  })

  it('summarizes phase trends and renders the privacy boundary', () => {
    const samples: RuntimeResourceSample[] = [
      {
        capturedAt: 1_000,
        elapsedMs: 0,
        phase: 'idle',
        rootPid: 10,
        processTreeComplete: true,
        electronMetricsComplete: true,
        processes: [],
        storage: {
          notebookRunBytes: 1_024,
          notebookRunFileCount: 1,
          sessionBytes: 2_048,
          sessionFileCount: 1,
          temporaryBytes: 0,
          temporaryFileCount: 0
        },
        totals: {
          processCount: 4,
          totalCpuPercent: 1,
          summedRssKb: 1_024,
          electronWorkingSetKb: 900
        }
      },
      {
        capturedAt: 2_000,
        elapsedMs: 1_000,
        phase: 'idle',
        rootPid: 10,
        processTreeComplete: false,
        electronMetricsComplete: true,
        processes: [],
        storage: {
          notebookRunBytes: 2_048,
          notebookRunFileCount: 1,
          sessionBytes: 4_096,
          sessionFileCount: 1,
          temporaryBytes: 0,
          temporaryFileCount: 0
        },
        totals: {
          processCount: 5,
          totalCpuPercent: 3,
          summedRssKb: 2_048,
          electronWorkingSetKb: 1_800
        }
      }
    ]
    const summary = summarizeSamples(samples, {
      startedAt: 1_000,
      endedAt: 2_000,
      sampleIntervalMs: 1_000,
      nodeVersion: '22.0.0',
      electronVersion: '39.0.0'
    })

    expect(summary.phases.idle.totalCpuPercent).toMatchObject({ mean: 1, max: 1, delta: 0 })
    expect(summary.phases.idle.summedRssKb).toMatchObject({ first: 1_024, last: 1_024 })
    expect(summary.phases.idle).toMatchObject({ sampleCount: 2, includedSampleCount: 1 })
    expect(summary.phases.idle.roles).toEqual({})
    expect(summary.phases.idle.storage?.sessionBytes).toMatchObject({
      first: 2_048,
      last: 4_096,
      delta: 2_048
    })
    expect(summary.incompleteSampleCount).toBe(1)
    expect(renderSummaryMarkdown(summary)).toContain('records no\nprompts, responses')
    expect(renderSummaryMarkdown(summary)).toContain('## Durable storage snapshots')
  })

  it('records only aggregate Session, Notebook, and atomic temporary file sizes', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-runtime-storage-'))
    const dataRoot = join(storageRoot, 'relocated-data')
    try {
      const sessions = join(storageRoot, 'sessions', 'project-1')
      const notebooks = join(dataRoot, 'notebooks', 'project-1', 'session-1')
      await Promise.all([
        mkdir(sessions, { recursive: true }),
        mkdir(notebooks, { recursive: true })
      ])
      await Promise.all([
        writeFile(join(sessions, 'session-1.json'), '12345'),
        writeFile(join(sessions, 'manifest.json'), 'ignored'),
        writeFile(join(sessions, 'session-1.json.1700000000000-1.tmp'), '12'),
        writeFile(join(notebooks, 'run.json'), '1234567'),
        writeFile(join(notebooks, 'run.json.1700000000000-1.tmp'), '123')
      ])

      await expect(readRuntimeStorageSnapshot(storageRoot, dataRoot)).resolves.toEqual({
        sessionFileCount: 1,
        sessionBytes: 5,
        notebookRunFileCount: 1,
        notebookRunBytes: 7,
        temporaryFileCount: 2,
        temporaryBytes: 5
      })
    } finally {
      await rm(storageRoot, { force: true, recursive: true })
    }
  })

  it('excludes a sample when Electron metrics are unavailable', () => {
    const sample = mergeResourceSample(
      2_000,
      1_000,
      'idle',
      tree([processEntry()]),
      [],
      new ProcessCpuTracker(),
      false
    )
    const summary = summarizeSamples([sample], {
      startedAt: 1_000,
      endedAt: 2_000,
      sampleIntervalMs: 1_000,
      nodeVersion: '22.0.0'
    })

    expect(sample.electronMetricsComplete).toBe(false)
    expect(summary.incompleteSampleCount).toBe(1)
    expect(summary.phases.idle.includedSampleCount).toBe(0)
    expect(summary.phases.idle.roles).toEqual({})
  })

  it('bounds intervals and accepts only report-local kebab-case phases', () => {
    expect(validateSampleInterval(1_000)).toBe(1_000)
    expect(() => validateSampleInterval(100)).toThrow('sampleIntervalMs')
    expect(validatePhase('notebook-tool')).toBe('notebook-tool')
    expect(() => validatePhase('User project')).toThrow('lowercase kebab-case')
  })

  it('finishes an in-flight sample under its starting phase before sampling a new phase', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'open-science-runtime-profiler-'))
    let releaseFirstSample: (() => void) | undefined
    let markFirstSampleStarted: (() => void) | undefined
    const firstSampleStarted = new Promise<void>((resolve) => {
      markFirstSampleStarted = resolve
    })
    const firstSampleReleased = new Promise<void>((resolve) => {
      releaseFirstSample = resolve
    })
    const readTree = vi.fn(async (): Promise<ProcessTreeSnapshot> => {
      if (readTree.mock.calls.length === 1) {
        markFirstSampleStarted?.()
        await firstSampleReleased
      }
      return tree([processEntry()])
    })
    let retainedElectronMetricsPromise = false
    const evaluate = vi.fn(
      async (callback: (electron: { app: { getAppMetrics: () => [] } }) => unknown) => {
        if (evaluate.mock.calls.length === 1) return '39.0.0'
        const result = callback({ app: { getAppMetrics: () => [] } })
        retainedElectronMetricsPromise = result instanceof Promise
        return result
      }
    )
    const application = {
      evaluate,
      off: vi.fn(),
      on: vi.fn(),
      process: () => ({ pid: 10 })
    } as unknown as ElectronApplication
    const profiler = new RuntimeResourceProfiler({
      outputRoot,
      readTree,
      runId: 'phase-transition',
      sampleIntervalMs: 10_000
    })

    try {
      const attaching = profiler.attach(application)
      await firstSampleStarted
      profiler.markPhase('recovery')
      const samplingRecovery = profiler.sampleNow()
      profiler.markPhase('idle')
      const samplingIdle = profiler.sampleNow()
      releaseFirstSample?.()
      await attaching
      await samplingRecovery
      await samplingIdle

      const result = await profiler.finish()

      expect(result.summary.phases.startup.sampleCount).toBe(1)
      expect(result.summary.phases.recovery.sampleCount).toBe(1)
      expect(result.summary.phases.idle.sampleCount).toBe(1)
      expect(readTree).toHaveBeenCalledTimes(3)
      expect(retainedElectronMetricsPromise).toBe(true)
    } finally {
      profiler.abort()
      await rm(outputRoot, { force: true, recursive: true })
    }
  })

  it('retains only whitelisted scalar Session hydration performance fields', () => {
    expect(
      parseSessionHydrationDiagnostic({
        capturedAt: 2_000,
        message: '[session-persistence] operation phase',
        data: {
          operation: 'session-hydration',
          operationId: 'operation-1',
          phase: 'authority-loaded',
          cpuIntervalPhase: 'load-authority',
          elapsedMs: 25,
          phaseDurationMs: 20,
          cpuTotalMs: 12,
          phaseCpuTotalMs: 8,
          sessionCount: 3,
          secretPath: '/private/research'
        }
      })
    ).toEqual({
      capturedAt: 2_000,
      event: 'phase',
      operationId: 'operation-1',
      phase: 'authority-loaded',
      cpuIntervalPhase: 'load-authority',
      elapsedMs: 25,
      phaseDurationMs: 20,
      cpuTotalMs: 12,
      phaseCpuTotalMs: 8,
      sessionCount: 3
    })
    expect(
      parseSessionHydrationDiagnostic({
        capturedAt: 2_000,
        message: '[settings] operation phase',
        data: { operation: 'session-hydration', operationId: 'operation-2' }
      })
    ).toBeUndefined()
  })

  it('renders Session hydration CPU intervals in the local summary', () => {
    const summary = summarizeSamples(
      [],
      {
        startedAt: 1_000,
        endedAt: 2_000,
        sampleIntervalMs: 1_000,
        nodeVersion: '22.0.0'
      },
      [
        {
          capturedAt: 1_100,
          event: 'phase',
          operationId: 'operation-1',
          phase: 'authority-loaded',
          cpuIntervalPhase: 'load-authority',
          phaseDurationMs: 20,
          phaseCpuUserMs: 6,
          phaseCpuSystemMs: 2,
          phaseCpuTotalMs: 8
        }
      ]
    )

    expect(summary.sessionHydrationTrace).toHaveLength(1)
    expect(renderSummaryMarkdown(summary)).toContain(
      '1 | load-authority | authority-loaded | 20.0 | 6.0 | 2.0 | 8.0'
    )
  })
})
