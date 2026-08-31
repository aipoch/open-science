import { describe, expect, it, vi } from 'vitest'

import type {
  NotebookEnvironmentManifest,
  NotebookOutput,
  NotebookRunDocument,
  NotebookRunRecord,
  NotebookRunStatus
} from '../../shared/notebook'
import { createRootNotebookLane } from './lane-identity'
import { NotebookRunTerminalizationOwner } from './run-terminalization'

const session = {
  projectId: 'project-1',
  sessionId: 'session-1',
  lane: createRootNotebookLane('project-1', 'session-1', 'root-frame-session-1'),
  notebookSessionRoot: '/storage/notebooks/project-1/session-1',
  dataRoot: '/storage/notebooks/project-1/session-1/data'
}

const runningRun = (
  runId: string,
  kernelKind: NotebookRunRecord['kernelKind'] = 'python'
): NotebookRunRecord =>
  ({
    runId,
    cellId: 'cell-1',
    source: 'agent',
    inputKind: 'cell',
    kernelKind,
    script: 'print("hello")',
    status: 'running',
    startedAt: 100,
    cwdBefore: session.dataRoot,
    executionCount: 1,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    artifacts: [],
    workingFiles: [],
    inputFiles: []
  }) satisfies NotebookRunRecord

const documentWith = (runs: NotebookRunRecord[]): NotebookRunDocument => ({
  version: 1,
  projectId: session.projectId,
  sessionId: session.sessionId,
  workspaceCwd: '/workspace',
  notebookSessionRoot: session.notebookSessionRoot,
  dataRoot: session.dataRoot,
  kernel: {
    kernelName: 'python3',
    runtimeRoot: '/storage/runtime',
    lastKnownStatus: 'running'
  },
  runs,
  updatedAt: 100
})

const completedResult = (
  status: Exclude<NotebookRunStatus, 'queued' | 'running'> = 'completed'
): {
  status: Exclude<NotebookRunStatus, 'queued' | 'running'>
  stdout: string
  stderr: string
  traceback: string
  cwdAfter: string
  outputs: NotebookOutput[]
} => ({
  status,
  stdout: 'hello\n',
  stderr: '',
  traceback: '',
  cwdAfter: session.dataRoot,
  outputs: [{ type: 'stream' as const, name: 'stdout' as const, text: 'hello\n' }]
})

const environmentManifest: NotebookEnvironmentManifest = {
  schemaVersion: 1,
  captureKind: 'completed-run',
  capturedAt: '2026-08-03T00:00:00.000Z',
  installedInventory: {
    capturedAt: '2026-08-03T00:00:00.000Z',
    source: 'full-scan',
    validation: 'full-scan'
  },
  kernelKind: 'python',
  environmentName: 'default-python',
  runtimeSource: 'managed',
  inventorySources: ['kernel-native'],
  packages: [],
  complete: true,
  captureStatus: 'complete'
}

const createHarness = (
  options: {
    now?: () => number
    appendFailure?: Error
    updateFailure?: Error
    updateFailureCount?: number
    omitUpdatedRun?: boolean
  } = {}
): {
  owner: NotebookRunTerminalizationOwner
  events: string[]
  document: () => NotebookRunDocument
} => {
  const events: string[] = []
  let document = documentWith([])
  let updateFailuresRemaining = options.updateFailureCount ?? Number.POSITIVE_INFINITY
  const owner = new NotebookRunTerminalizationOwner({
    repository: {
      appendRun: async ({ run }) => {
        events.push(`append:${run.status}`)
        if (options.appendFailure) throw options.appendFailure
        document = documentWith([...document.runs, run])
        return document
      },
      updateRun: async ({ run }) => {
        events.push(`update:${run.status}`)
        if (options.updateFailure && updateFailuresRemaining > 0) {
          updateFailuresRemaining -= 1
          throw options.updateFailure
        }
        document = documentWith(
          document.runs.map((candidate) => (candidate.runId === run.runId ? run : candidate))
        )
        return options.omitUpdatedRun ? documentWith([]) : document
      }
    },
    notifyChanged: () => events.push(`notify:${document.runs[0]?.status}`),
    now: options.now ?? (() => 200)
  })
  return { owner, events, document: () => document }
}

describe('NotebookRunTerminalizationOwner', () => {
  it('allocates distinct run identities while preserving the shared sequence value', () => {
    const owner = new NotebookRunTerminalizationOwner({
      repository: {
        appendRun: async () => {
          throw new Error('not used')
        },
        updateRun: async () => {
          throw new Error('not used')
        }
      },
      notifyChanged: () => undefined,
      now: () => 123
    })

    expect(owner.allocateRunIdentity()).toEqual({
      runId: 'notebook-run-123-1',
      sequence: 1
    })
    expect(owner.allocateRunIdentity()).toEqual({
      runId: 'notebook-run-123-2',
      sequence: 2
    })
  })

  it('commits one terminal record before settling live ownership and the final notification', async () => {
    const harness = createHarness()
    const running = runningRun('run-1')

    const terminalized = await harness.owner.run({
      session,
      runningRun: running,
      invoke: async () => {
        harness.events.push('invoke')
        return completedResult()
      },
      settleLive: (result) => {
        harness.events.push(`settle-live:${result.status}`)
      }
    })

    expect(harness.events).toEqual([
      'append:running',
      'notify:running',
      'invoke',
      'update:completed',
      'settle-live:completed',
      'notify:completed'
    ])
    const document = harness.document()
    expect(document.runs).toHaveLength(1)
    expect(document.runs[0]).toMatchObject({
      runId: 'run-1',
      status: 'completed',
      endedAt: 200,
      text: { stdout: 'hello\n', plain: ['hello\n'] },
      environmentCapture: { state: 'unavailable', reason: 'environment-capture-failed' },
      fileEvidence: {
        state: 'unavailable',
        scientificOutputCount: 0,
        scientificOutputAnalysis: 'unavailable',
        managedRootsFinalState: 'unavailable',
        reasonCodes: expect.arrayContaining([
          'delayed-writes-not-observed',
          'observation-not-started',
          'remote-outputs-not-observed'
        ])
      }
    })
    expect(terminalized.run).toEqual(document.runs[0])
    expect(terminalized.result.status).toBe('completed')
  })

  it('persists the observer evidence summary on the terminal Run', async () => {
    const harness = createHarness()
    const fileEvidence = {
      schemaVersion: 1 as const,
      evidenceId: 'notebook-file-evidence-run-evidence',
      state: 'partial' as const,
      checksum: 'a'.repeat(64),
      storageKey: 'file-evidence/runs/run-evidence.json',
      relationCount: 2,
      generationCount: 1,
      scientificOutputCount: 1,
      initialViewState: 'complete' as const,
      managedRootsFinalState: 'partial' as const,
      scientificOutputAnalysis: 'partial' as const,
      fileReads: 'unavailable' as const,
      externalPaths: 'unavailable' as const,
      writerAttribution: 'unavailable' as const,
      reasonCodes: ['file-reads-not-observed' as const]
    }

    await harness.owner.run({
      session,
      runningRun: runningRun('run-evidence'),
      invoke: async () => ({ ...completedResult(), fileEvidence })
    })

    expect(harness.document().runs[0]?.fileEvidence).toEqual(fileEvidence)
  })

  it('keeps an admitted Run running across hours without an elapsed-time transition', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness()
      let finish!: (result: ReturnType<typeof completedResult>) => void
      const result = new Promise<ReturnType<typeof completedResult>>((resolve) => {
        finish = resolve
      })
      const execution = harness.owner.run({
        session,
        runningRun: runningRun('run-hours'),
        invoke: () => result
      })
      await vi.waitFor(() => expect(harness.document().runs[0]?.status).toBe('running'))

      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1_000)
      expect(harness.document().runs[0]?.status).toBe('running')
      expect(harness.events).not.toContainEqual(expect.stringMatching(/^update:/))

      finish(completedResult())
      await execution
      expect(harness.document().runs[0]?.status).toBe('completed')
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['failed', 'timeout', 'cancelled'] as const)(
    'persists a normalized %s result as the terminal status',
    async (status) => {
      const harness = createHarness()

      await harness.owner.run({
        session,
        runningRun: runningRun(`run-${status}`),
        invoke: async () => completedResult(status)
      })

      expect(harness.document().runs[0]).toMatchObject({
        runId: `run-${status}`,
        status,
        endedAt: 200
      })
      expect(harness.events.filter((event) => event.startsWith('update:'))).toEqual([
        `update:${status}`
      ])
    }
  )

  it.each(['repl', 'bash'] as const)(
    'uses the unsupported evidence fallback for %s runs',
    async (kernelKind) => {
      const harness = createHarness()

      await harness.owner.run({
        session,
        runningRun: runningRun(`run-${kernelKind}`, kernelKind),
        invoke: async () => completedResult()
      })

      expect(harness.document().runs[0]?.environmentCapture).toEqual({
        state: 'unavailable',
        reason: 'environment-not-supported'
      })
    }
  )

  it('persists available environment evidence and omits stale evidence when unavailable', async () => {
    const available = createHarness()
    await available.owner.run({
      session,
      runningRun: runningRun('run-available'),
      invoke: async () => ({
        ...completedResult(),
        environmentCapture: { state: 'available' as const, manifestChecksum: 'checksum-1' },
        environmentManifest,
        environmentManifestChecksum: 'checksum-1'
      })
    })
    expect(available.document().runs[0]).toMatchObject({
      environmentCapture: { state: 'available', manifestChecksum: 'checksum-1' },
      environmentManifest,
      environmentManifestChecksum: 'checksum-1'
    })

    const unavailable = createHarness()
    await unavailable.owner.run({
      session,
      runningRun: runningRun('run-unavailable'),
      invoke: async () => ({
        ...completedResult(),
        environmentCapture: { state: 'unavailable' as const, reason: 'environment-capture-failed' },
        environmentManifest,
        environmentManifestChecksum: 'stale-checksum'
      })
    })
    expect(unavailable.document().runs[0]).not.toHaveProperty('environmentManifest')
    expect(unavailable.document().runs[0]).not.toHaveProperty('environmentManifestChecksum')
  })

  it('terminalizes an unexpected invocation rejection as interrupted before rethrowing', async () => {
    const harness = createHarness()

    await expect(
      harness.owner.run({
        session,
        runningRun: runningRun('run-rejected'),
        invoke: async () => {
          harness.events.push('invoke')
          throw new Error('unexpected rejection')
        },
        settleLive: (result) => harness.events.push(`settle-live:${result.status}`)
      })
    ).rejects.toThrow('unexpected rejection')

    expect(harness.events).toEqual([
      'append:running',
      'notify:running',
      'invoke',
      'update:interrupted',
      'settle-live:interrupted',
      'notify:interrupted'
    ])
    expect(harness.document().runs[0]).toMatchObject({
      runId: 'run-rejected',
      status: 'interrupted',
      endedAt: 200,
      interruptionReason: 'execution-error',
      text: {
        stderr: 'unexpected rejection',
        plain: ['unexpected rejection']
      },
      environmentCapture: { state: 'unavailable', reason: 'environment-capture-failed' }
    })
  })

  it('settles live ownership without invoking when the initial append fails', async () => {
    const harness = createHarness({ appendFailure: new Error('append failed') })

    await expect(
      harness.owner.run({
        session,
        runningRun: runningRun('run-append-failed'),
        invoke: async () => {
          harness.events.push('invoke')
          return completedResult()
        },
        settleLive: (result) => harness.events.push(`settle-live:${result.status}`)
      })
    ).rejects.toThrow('append failed')

    expect(harness.events).toEqual([
      'append:running',
      'settle-live:interrupted',
      'notify:undefined'
    ])
    expect(harness.document().runs).toEqual([])
  })

  it('releases live ownership when the terminal update fails', async () => {
    const harness = createHarness({ updateFailure: new Error('update failed') })

    await expect(
      harness.owner.run({
        session,
        runningRun: runningRun('run-update-failed'),
        invoke: async () => completedResult(),
        settleLive: (result) => harness.events.push(`settle-live:${result.status}`)
      })
    ).rejects.toThrow('update failed')

    expect(harness.events).toEqual([
      'append:running',
      'notify:running',
      'update:completed',
      'settle-live:completed',
      'notify:running'
    ])
    expect(harness.document().runs[0]).toMatchObject({
      runId: 'run-update-failed',
      status: 'running'
    })
  })

  it('retries a pending terminal write in the same process on later reconciliation', async () => {
    const harness = createHarness({
      updateFailure: new Error('transient update failure'),
      updateFailureCount: 1
    })

    await expect(
      harness.owner.run({
        session,
        runningRun: runningRun('run-retry'),
        invoke: async () => completedResult(),
        settleLive: (result) => harness.events.push(`settle-live:${result.status}`)
      })
    ).rejects.toThrow('transient update failure')

    expect(harness.document().runs[0]?.status).toBe('running')

    await harness.owner.reconcilePending(session)

    expect(harness.document().runs[0]).toMatchObject({
      runId: 'run-retry',
      status: 'completed',
      endedAt: 200
    })
    expect(harness.events).toEqual([
      'append:running',
      'notify:running',
      'update:completed',
      'settle-live:completed',
      'notify:running',
      'update:completed',
      'notify:completed'
    ])
  })

  it('leaves the terminal update committed when settling live ownership fails', async () => {
    const harness = createHarness()

    await expect(
      harness.owner.run({
        session,
        runningRun: runningRun('run-post-commit-failed'),
        invoke: async () => completedResult(),
        settleLive: () => {
          harness.events.push('settle-live')
          throw new Error('settle-live failed')
        }
      })
    ).rejects.toThrow('settle-live failed')

    expect(harness.events).toEqual([
      'append:running',
      'notify:running',
      'update:completed',
      'settle-live',
      'notify:completed'
    ])
    expect(harness.document().runs[0]).toMatchObject({
      runId: 'run-post-commit-failed',
      status: 'completed'
    })
  })

  it('reports a missing same-id record returned by the repository', async () => {
    const harness = createHarness({ omitUpdatedRun: true })

    await expect(
      harness.owner.run({
        session,
        runningRun: runningRun('run-missing'),
        invoke: async () => completedResult()
      })
    ).rejects.toThrow('Notebook run not found after update: run-missing')

    expect(harness.events).toEqual([
      'append:running',
      'notify:running',
      'update:completed',
      'notify:completed'
    ])
  })
})
