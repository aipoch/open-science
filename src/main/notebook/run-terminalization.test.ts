import { describe, expect, it } from 'vitest'

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
  projectName: 'project-1',
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
  projectName: session.projectName,
  sessionId: session.sessionId,
  workspaceCwd: '/workspace',
  notebookSessionRoot: session.notebookSessionRoot,
  dataRoot: session.dataRoot,
  kernel: {
    language: 'python',
    kernelName: 'python3',
    runtimeRoot: '/storage/runtime',
    lastKnownStatus: 'running'
  },
  runs,
  updatedAt: 100
})

const completedResult = (
  status: NotebookRunStatus = 'completed'
): {
  status: NotebookRunStatus
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
    omitUpdatedRun?: boolean
  } = {}
): {
  owner: NotebookRunTerminalizationOwner
  events: string[]
  document: () => NotebookRunDocument
} => {
  const events: string[] = []
  let document = documentWith([])
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
        if (options.updateFailure) throw options.updateFailure
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

  it('commits one terminal record before post-commit work and the final notification', async () => {
    const harness = createHarness()
    const running = runningRun('run-1')

    const terminalized = await harness.owner.run({
      session,
      runningRun: running,
      invoke: async () => {
        harness.events.push('invoke')
        return completedResult()
      },
      postCommit: (result, run) => {
        harness.events.push(`post-commit:${result.status}:${run.status}`)
      }
    })

    expect(harness.events).toEqual([
      'append:running',
      'notify:running',
      'invoke',
      'update:completed',
      'post-commit:completed:completed',
      'notify:completed'
    ])
    const document = harness.document()
    expect(document.runs).toHaveLength(1)
    expect(document.runs[0]).toMatchObject({
      runId: 'run-1',
      status: 'completed',
      endedAt: 200,
      text: { stdout: 'hello\n', plain: ['hello\n'] },
      environmentCapture: { state: 'unavailable', reason: 'environment-capture-failed' }
    })
    expect(terminalized.run).toEqual(document.runs[0])
    expect(terminalized.result.status).toBe('completed')
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

  it('keeps the running record when invocation rejects unexpectedly', async () => {
    const harness = createHarness()

    await expect(
      harness.owner.run({
        session,
        runningRun: runningRun('run-rejected'),
        invoke: async () => {
          harness.events.push('invoke')
          throw new Error('unexpected rejection')
        }
      })
    ).rejects.toThrow('unexpected rejection')

    expect(harness.events).toEqual(['append:running', 'notify:running', 'invoke'])
    expect(harness.document().runs[0]).toMatchObject({ runId: 'run-rejected', status: 'running' })
  })

  it('does not invoke or notify when the initial append fails', async () => {
    const harness = createHarness({ appendFailure: new Error('append failed') })

    await expect(
      harness.owner.run({
        session,
        runningRun: runningRun('run-append-failed'),
        invoke: async () => {
          harness.events.push('invoke')
          return completedResult()
        }
      })
    ).rejects.toThrow('append failed')

    expect(harness.events).toEqual(['append:running'])
    expect(harness.document().runs).toEqual([])
  })

  it('keeps the running record when the terminal update fails', async () => {
    const harness = createHarness({ updateFailure: new Error('update failed') })

    await expect(
      harness.owner.run({
        session,
        runningRun: runningRun('run-update-failed'),
        invoke: async () => completedResult()
      })
    ).rejects.toThrow('update failed')

    expect(harness.events).toEqual(['append:running', 'notify:running', 'update:completed'])
    expect(harness.document().runs[0]).toMatchObject({
      runId: 'run-update-failed',
      status: 'running'
    })
  })

  it('leaves the terminal update committed when post-commit work fails', async () => {
    const harness = createHarness()

    await expect(
      harness.owner.run({
        session,
        runningRun: runningRun('run-post-commit-failed'),
        invoke: async () => completedResult(),
        postCommit: () => {
          harness.events.push('post-commit')
          throw new Error('post-commit failed')
        }
      })
    ).rejects.toThrow('post-commit failed')

    expect(harness.events).toEqual([
      'append:running',
      'notify:running',
      'update:completed',
      'post-commit'
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

    expect(harness.events).toEqual(['append:running', 'notify:running', 'update:completed'])
  })
})
