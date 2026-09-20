import { describe, expect, it, vi } from 'vitest'

const diagnosticLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
}))
vi.mock('../logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../logger')>()),
  createLogger: () => diagnosticLog
}))

import type { PersistedArtifactExecutionSnapshot } from '../../shared/artifact-provenance'
import type {
  ArtifactReproducibilityCheckRequest,
  ArtifactReproducibilityCheckState
} from '../../shared/artifact-reproducibility'
import type { NotebookProcessSandbox } from '../notebook/process-sandbox'
import { CHILD_UNCONFIRMED } from '../notebook/provisioner-runtime'
import { ReproducibilityCleanupError } from './artifact-reproducibility-execution'
import { withReproducibilityNotebookLifecycle } from './reproducibility-notebook-lifecycle'
import { SessionDeletionOwner } from '../session-deletion/owner'
import {
  ArtifactReproducibilityAttemptOwner,
  type ArtifactReproducibilityAttemptOwnerDependencies
} from './artifact-reproducibility-lifecycle'

const request: ArtifactReproducibilityCheckRequest = {
  projectId: 'project-1',
  appSessionId: 'session-1',
  artifactId: 'artifact-1',
  versionId: 'version-1',
  frontierId: 'original-inputs'
}

const execution: PersistedArtifactExecutionSnapshot = {
  schemaVersion: 2,
  rootFrameId: 'root-1',
  agentFrameId: 'agent-1',
  messageBranchId: 'branch-1',
  terminalPromptMessageId: 'prompt-1',
  producerRunId: 'run-1',
  producerRunIndex: 0,
  createdAt: '2026-09-02T00:00:00.000Z',
  inputFiles: [],
  runs: [],
  reproducibilityRecipe: {
    schemaVersion: 1,
    recipeId: 'a'.repeat(64),
    targetVersionId: 'version-1',
    targetEntityId: 'artifact-version:version-1',
    targetChecksum: 'b'.repeat(64),
    graphChecksum: 'c'.repeat(64),
    steps: [],
    frontiers: [
      {
        frontierId: 'original-inputs',
        claimScope: 'end-to-end',
        stepIds: ['step:run-1'],
        crossingFiles: [],
        reasonCodes: []
      }
    ],
    environmentRequirements: [],
    capture: { state: 'sealed', reasonCodes: [] }
  }
}

const sandbox: NotebookProcessSandbox = { wrap: vi.fn() }

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('reproducibility resource lifecycle', () => {
  it('reports cleanup failures after cancellation without treating stopped workers as unsafe', async () => {
    const stopped = deferred()
    const execute = vi.fn(async () => {
      await stopped.promise
      throw new ReproducibilityCleanupError([new Error('directory busy')], '/temporary/attempt')
    })
    const persistFailure = vi.fn<ArtifactReproducibilityAttemptOwnerDependencies['persistFailure']>(
      async (_request, attempt, checkLog) => ({
        schemaVersion: 1,
        ...attempt,
        checkLog: {
          logChecksum: 'f'.repeat(64),
          entryCount: checkLog.entries.length,
          sizeBytes: 1,
          truncated: checkLog.truncated
        }
      })
    )
    const owner = createOwner({ execute, persistFailure })
    const states: ArtifactReproducibilityCheckState[] = []
    owner.start(request, 1, (state) => states.push(state))
    await vi.waitFor(() => expect(execute).toHaveBeenCalled())
    const cancelling = owner.cancelSession(request.projectId, request.appSessionId)
    stopped.resolve()
    await cancelling
    expect(states.at(-1)?.status).toBe('failed')
    expect(persistFailure).toHaveBeenCalledOnce()
    expect(owner.getActiveSessions()).toHaveLength(0)
  })
  it('fences cleanup against active checks and releases the fence after cleanup errors', async () => {
    const executionDone = deferred()
    const owner = createOwner({
      execute: async () => {
        await executionDone.promise
        return { matched: true, completedStepIds: [], comparisons: [] }
      }
    })
    owner.start(request, 1, vi.fn())
    const remove = vi.fn()
    await expect(owner.withIdleVersion(request, remove)).rejects.toThrow('Wait')
    expect(remove).not.toHaveBeenCalled()
    const cancelling = owner.cancelSession(request.projectId, request.appSessionId)
    executionDone.resolve()
    await cancelling
    const cleanup = deferred()
    const pending = owner.withIdleVersion(request, async () => {
      await cleanup.promise
      throw new Error('disk error')
    })
    expect(() => owner.start(request, 1, vi.fn())).toThrow('being cleared')
    await expect(owner.withIdleVersion(request, remove)).rejects.toThrow('Wait')
    const failed = expect(pending).rejects.toThrow('disk error')
    cleanup.resolve()
    await failed
    await expect(owner.withIdleVersion(request, async () => 'clean')).resolves.toBe('clean')
  })
  it('prunes output before execution and after cancellation within the storage lease', async () => {
    const ready = deferred()
    const order: string[] = []
    const persistReceipt = vi.fn()
    const owner = createOwner({
      persistReceipt,
      withStorageLease: async (operation) => {
        order.push('lease')
        try {
          return await operation()
        } finally {
          order.push('release')
        }
      },
      pruneOutputs: async () => {
        order.push('prune')
      },
      retainOutput: async () => {
        order.push('retain')
        return true
      },
      execute: async ({ retainOutput }) => {
        await retainOutput!(Buffer.from('changed'))
        await ready.promise
        return { matched: false, completedStepIds: [], comparisons: [] }
      }
    })
    owner.start(request, 1, vi.fn())
    await vi.waitFor(() => expect(order).toContain('retain'))
    const cancelled = owner.cancelSession(request.projectId, request.appSessionId)
    ready.resolve()
    await cancelled
    expect(order).toEqual(['lease', 'prune', 'retain', 'prune', 'release'])
    expect(persistReceipt).not.toHaveBeenCalled()
  })
  it.each(['session', 'project'] as const)(
    'cancels only the selected %s and waits for cleanup',
    async (scope) => {
      const cleanup = deferred()
      const signals: AbortSignal[] = []
      const persistReceipt = vi.fn()
      let id = 0
      const owner = createOwner({
        createId: () => String(++id),
        persistReceipt,
        execute: async ({ signal }) => {
          signals.push(signal!)
          await cleanup.promise
          return { matched: true, completedStepIds: [], comparisons: [] }
        }
      })
      owner.start(request, 1, vi.fn())
      owner.start({ ...request, appSessionId: 'session-2' }, 1, vi.fn())
      owner.start({ ...request, projectId: 'project-2' }, 1, vi.fn())
      await vi.waitFor(() => expect(signals).toHaveLength(3))
      const done = vi.fn()
      const draining = (
        scope === 'session'
          ? owner.cancelSession(request.projectId, request.appSessionId)
          : owner.cancelProject(request.projectId)
      ).then(done)
      expect(signals.map((signal) => signal.aborted)).toEqual([true, scope === 'project', false])
      await Promise.resolve()
      expect(done).not.toHaveBeenCalled()
      const quitting = owner.dispose()
      cleanup.resolve()
      await Promise.all([draining, quitting])
      expect(persistReceipt).not.toHaveBeenCalled()
      expect(owner.getActiveSessions()).toEqual([])
    }
  )

  it('fences checks through runtime and durable Session deletion, including concurrent requests', async () => {
    const cleanup = deferred()
    const saving = deferred()
    const execute = vi.fn(async () => {
      await cleanup.promise
      return { matched: true, completedStepIds: [], comparisons: [] }
    })
    const owner = createOwner({ execute })
    owner.start(request, 1, vi.fn())
    await vi.waitFor(() => expect(execute).toHaveBeenCalled())
    const deleteRuntime = vi.fn(async () => ({ sessionIds: [] }) as never)
    const deletePersisted = vi.fn(async () => saving.promise)
    const deletion = new SessionDeletionOwner({
      runtime: { deleteSession: deleteRuntime, liveSessionProjectId: () => request.projectId },
      persistence: { deleteSession: deletePersisted },
      withStoppedWork: (scope, operation) =>
        owner.withSessionStopped(scope.projectId, scope.sessionId, operation)
    })
    const scope = { projectId: request.projectId, sessionId: request.appSessionId }
    const pending = deletion.delete(scope)
    expect(deletion.delete(scope)).toBe(pending)
    expect(() => owner.start(request, 1, vi.fn())).toThrow(/being deleted/)
    expect(deleteRuntime).not.toHaveBeenCalled()
    cleanup.resolve()
    await vi.waitFor(() => expect(deletePersisted).toHaveBeenCalledOnce())
    expect(() => owner.start(request, 1, vi.fn())).toThrow(/being deleted/)
    saving.resolve()
    await expect(pending).resolves.toMatchObject({ status: 'deleted' })
  })

  it('waits for an already recording receipt before deleting its owner', async () => {
    const saving = deferred()
    const persistReceipt = vi.fn(async (_request, receipt) => {
      await saving.promise
      return { ...receipt, receiptChecksum: 'e'.repeat(64) }
    })
    const owner = createOwner({
      persistReceipt,
      execute: async () => ({ matched: true, completedStepIds: [], comparisons: [] })
    })
    owner.start(request, 1, vi.fn())
    await vi.waitFor(() => expect(persistReceipt).toHaveBeenCalledOnce())
    const remove = vi.fn(async () => undefined)
    const pending = owner.withSessionStopped(request.projectId, request.appSessionId, remove)
    await Promise.resolve()
    expect(remove).not.toHaveBeenCalled()
    saving.resolve()
    await pending
    expect(remove).toHaveBeenCalledOnce()
  })

  it('retains uncertain workers as deletion and shutdown blockers after cancellation', async () => {
    const cleanup = deferred()
    const execute = vi.fn(async () => {
      await cleanup.promise
      throw new Error(CHILD_UNCONFIRMED)
    })
    const owner = createOwner({ execute })
    const states: ArtifactReproducibilityCheckState[] = []
    owner.start(request, 1, (state) => states.push(state))
    await vi.waitFor(() => expect(execute).toHaveBeenCalled())
    const remove = vi.fn(async () => undefined)
    const pending = owner.withSessionStopped(request.projectId, request.appSessionId, remove)
    const rejected = expect(pending).rejects.toThrow(CHILD_UNCONFIRMED)
    cleanup.resolve()
    await rejected
    expect(remove).not.toHaveBeenCalled()
    expect(states.at(-1)?.status).toBe('failed')
    expect(owner.getActiveSessions()).toHaveLength(1)
    const lifecycle = withReproducibilityNotebookLifecycle(
      {
        getActiveNotebookSessions: () => [],
        shutdownAll: async () => ({ reaped: true }),
        dispose: async () => ({ reaped: true })
      },
      () => owner
    )
    await expect(lifecycle.shutdownAll()).resolves.toEqual({ reaped: false })
    await expect(owner.cancelProject(request.projectId)).rejects.toThrow(CHILD_UNCONFIRMED)
    await expect(owner.dispose()).rejects.toThrow(CHILD_UNCONFIRMED)
  })

  it('includes isolated checks in Notebook close gates and permits reuse after a non-quit stop', async () => {
    const signals: AbortSignal[] = []
    const execute = vi.fn(async ({ signal }) => {
      signals.push(signal!)
      await new Promise<void>((resolve) =>
        signal!.addEventListener('abort', () => resolve(), { once: true })
      )
      return { matched: true, completedStepIds: [], comparisons: [] }
    })
    const owner = createOwner({ execute })
    const notebook = {
      getActiveNotebookSessions: () => [
        { projectId: request.projectId, sessionId: request.appSessionId }
      ],
      shutdownAll: vi.fn(async () => ({ reaped: true })),
      dispose: vi.fn(async () => ({ reaped: true }))
    }
    const lifecycle = withReproducibilityNotebookLifecycle(notebook, () => owner)
    owner.start(request, 1, vi.fn())
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
    expect(lifecycle.getActiveNotebookSessions()).toHaveLength(1)
    // Merely detecting work for a close dialog must leave it running.
    expect(signals[0].aborted).toBe(false)
    await expect(lifecycle.shutdownAll()).resolves.toEqual({ reaped: true })
    expect(signals[0].aborted).toBe(true)
    owner.start(request, 1, vi.fn())
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
    await expect(lifecycle.dispose()).resolves.toEqual({ reaped: true })
    expect(signals[1].aborted).toBe(true)
    expect(() => owner.start(request, 1, vi.fn())).toThrow(/shutting down/)
  })
})

it('rejects new checks once client shutdown has begun', async () => {
  const owner = createOwner()
  await owner.dispose()
  expect(() => owner.start(request, 1, vi.fn())).toThrow(/shutting down/)
})

const createOwner = (
  overrides: Partial<ArtifactReproducibilityAttemptOwnerDependencies> = {}
): ArtifactReproducibilityAttemptOwner =>
  new ArtifactReproducibilityAttemptOwner({
    storageRoot: '/storage',
    processSandbox: sandbox,
    loadExecution: vi.fn(async () => execution),
    persistReceipt: vi.fn(async (_request, receipt) => ({
      ...receipt,
      receiptChecksum: 'e'.repeat(64)
    })),
    persistFailure: vi.fn(async (_request, attempt, checkLog) => ({
      schemaVersion: 1,
      ...attempt,
      checkLog: {
        logChecksum: 'f'.repeat(64),
        entryCount: checkLog.entries.length,
        sizeBytes: 1,
        truncated: checkLog.truncated
      }
    })),
    listReceipts: vi.fn(async () => ({ receipts: [] })),
    getCheckLog: vi.fn(async () => undefined),
    createId: () => 'attempt-1',
    now: () => new Date('2026-09-02T00:00:01.000Z'),
    ...overrides
  })

const terminalStates = (
  states: ArtifactReproducibilityCheckState[]
): ArtifactReproducibilityCheckState[] => states.filter((state) => state.status !== 'running')

describe('ArtifactReproducibilityAttemptOwner', () => {
  it.each(['completed', 'failed', 'cancelled'] as const)(
    'records one correlated %s diagnostic without execution output',
    async (outcome) => {
      for (const method of Object.values(diagnosticLog)) method.mockClear()
      const states: ArtifactReproducibilityCheckState[] = []
      const owner = createOwner({
        execute: async ({ onEvent, signal }) => {
          onEvent?.({ type: 'step-started', index: 0, total: 1, stepId: 'step:run-1' })
          for (let index = 0; index < 5; index++) {
            onEvent?.({
              type: 'step-output',
              entries: [
                {
                  source: 'notebook',
                  text: 'PRIVATE-DATA',
                  kernelKind: 'python',
                  stream: 'stdout',
                  stepId: 'step:run-1',
                  runIndex: 0
                }
              ]
            })
          }
          if (outcome === 'failed') throw new Error('PRIVATE-CODE /private/patient')
          if (outcome === 'cancelled') {
            await new Promise<void>((resolve) =>
              signal?.addEventListener('abort', () => resolve(), { once: true })
            )
          }
          return { matched: true, completedStepIds: ['step:run-1'], comparisons: [] }
        }
      })
      owner.start(request, 1, (state) => states.push(state))
      await vi.waitFor(() => expect(states.some((state) => state.phase === 'executing')).toBe(true))
      if (outcome === 'cancelled')
        await owner.cancelSession(request.projectId, request.appSessionId)
      await vi.waitFor(() => expect(terminalStates(states)).toHaveLength(1))
      const calls = Object.values(diagnosticLog).flatMap((method) => method.mock.calls)
      expect(calls.filter(([message]) => message === 'operation started')).toHaveLength(1)
      expect(calls.filter(([message]) => message === `operation ${outcome}`)).toHaveLength(1)
      expect(calls.every(([, data]) => data.operationId === 'attempt-1')).toBe(true)
      expect(
        calls.filter(
          ([message, data]) => message === 'operation phase' && data.phase === 'executing'
        )
      ).toHaveLength(1)
      expect(JSON.stringify(calls)).not.toMatch(/PRIVATE-|\/private\/patient/)
    }
  )

  it('returns the owning renderer a detached live snapshot scoped to one Artifact Version', async () => {
    let finish!: () => void
    const waiting = new Promise<void>((resolve) => {
      finish = resolve
    })
    const execute = vi.fn<NonNullable<ArtifactReproducibilityAttemptOwnerDependencies['execute']>>(
      async (input) => {
        input.onEvent?.({
          type: 'environment-output',
          entry: {
            source: 'environment',
            requirementId: 'environment-lock:python',
            environmentIndex: 0,
            environmentTotal: 1,
            kernelKind: 'python',
            stream: 'stdout',
            text: 'Restoring captured packages\n'
          }
        })
        await waiting
        return { matched: true, completedStepIds: [], comparisons: [] }
      }
    )
    const owner = createOwner({ execute })
    const initial = owner.start(request, 17, vi.fn())
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
    const state = owner.getCheck(request, 17)
    expect(state?.attemptId).toBe(initial.attemptId)
    expect(state?.logs?.[0].text).toBe('Restoring captured packages\n')
    state!.logs![0].text = 'changed by reader'
    expect(owner.getCheck(request, 17)?.logs?.[0].text).toBe('Restoring captured packages\n')
    expect(owner.getCheck(request, 18)).toBeUndefined()
    for (const field of ['projectId', 'appSessionId', 'artifactId', 'versionId']) {
      expect(owner.getCheck({ ...request, [field]: 'other' }, 17)).toBeUndefined()
    }
    expect(owner.start(request, 17, vi.fn()).attemptId).toBe(initial.attemptId)
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0][0].signal?.aborted).toBe(false)
    finish()
    await vi.waitFor(() => expect(owner.getCheck(request, 17)).toBeUndefined())
    await owner.dispose()
  })

  it('projects PR6 progress and a matching result without exposing execution internals', async () => {
    const states: ArtifactReproducibilityCheckState[] = []
    const execute = vi.fn(async (input) => {
      input.onEvent?.({
        type: 'attempt-started',
        totalEnvironments: 1,
        totalSteps: 1,
        totalComparisons: 1
      })
      input.onEvent?.({ type: 'inputs-materialized', count: 1 })
      input.onEvent?.({
        type: 'environment-progress',
        requirementId: 'environment-lock:python',
        kernelKind: 'python',
        index: 0,
        total: 1,
        stage: 'restoring-packages'
      })
      input.onEvent?.({
        type: 'environment-output',
        entry: {
          source: 'environment',
          requirementId: 'environment-lock:python',
          environmentIndex: 0,
          environmentTotal: 1,
          kernelKind: 'python',
          stream: 'stdout',
          text: 'Linking numpy\n'
        }
      })
      input.onEvent?.({ type: 'environments-restored', count: 1 })
      input.onEvent?.({ type: 'step-started', stepId: 'step:run-1', index: 0, total: 1 })
      input.onEvent?.({
        type: 'step-output',
        entries: [
          {
            source: 'notebook',
            stepId: 'step:run-1',
            runIndex: 0,
            kernelKind: 'python',
            stream: 'stdout',
            text: 'reproduced result\n'
          }
        ]
      })
      input.onEvent?.({ type: 'step-completed', stepId: 'step:run-1', index: 0, total: 1 })
      input.onEvent?.({
        type: 'output-compared',
        comparison: {
          stepId: 'step:run-1',
          entityId: 'file-1',
          relativePath: 'result.csv',
          expectedChecksum: 'd'.repeat(64),
          expectedSizeBytes: 10,
          status: 'matched'
        }
      })
      return {
        matched: true,
        completedStepIds: ['step:run-1'],
        comparisons: [
          {
            stepId: 'step:run-1',
            entityId: 'file-1',
            relativePath: 'result.csv',
            expectedChecksum: 'd'.repeat(64),
            expectedSizeBytes: 10,
            status: 'matched' as const
          }
        ]
      }
    })
    const owner = createOwner({ execute })

    const initial = owner.start(request, 7, (state) => states.push(state))
    await vi.waitFor(() => expect(terminalStates(states)).toHaveLength(1))

    expect(initial).toMatchObject({
      attemptId: 'attempt-1',
      status: 'running',
      phase: 'loading-evidence'
    })
    expect(states.map((state) => state.phase)).toEqual([
      'loading-evidence',
      'materializing-inputs',
      'restoring-environments',
      'restoring-environments',
      'restoring-environments',
      'executing',
      'executing',
      'executing',
      'executing',
      'comparing',
      undefined
    ])
    expect(states[3]).toMatchObject({
      completedEnvironments: 0,
      totalEnvironments: 1,
      activeEnvironment: {
        kernelKind: 'python',
        index: 0,
        total: 1,
        stage: 'restoring-packages'
      }
    })
    expect(states.at(-1)).toMatchObject({
      status: 'matched',
      completedSteps: 1,
      totalSteps: 1,
      completedEnvironments: 1,
      totalEnvironments: 1,
      logs: [
        {
          source: 'environment',
          text: 'Linking numpy\n',
          recordedAt: '2026-09-02T00:00:01.000Z'
        },
        {
          source: 'notebook',
          text: 'reproduced result\n',
          recordedAt: '2026-09-02T00:00:01.000Z'
        }
      ],
      totalComparisons: 1,
      comparisons: [{ relativePath: 'result.csv', status: 'matched' }]
    })
    expect(states.at(-1)?.receipt).toMatchObject({
      receiptId: 'attempt-1',
      outcome: 'matched',
      artifactVersion: { versionId: 'version-1', targetChecksum: 'b'.repeat(64) },
      frontier: { frontierId: 'original-inputs', claimScope: 'end-to-end' },
      recipe: { recipeId: 'a'.repeat(64), graphChecksum: 'c'.repeat(64) },
      completedStepIds: ['step:run-1']
    })
    expect(states.at(-1)).not.toHaveProperty('execution')
  })

  it('holds the data-root lease while evidence is loaded and executed', async () => {
    const states: ArtifactReproducibilityCheckState[] = []
    const order: string[] = []
    const leaseStarted = vi.fn()
    const withStorageLease = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
      leaseStarted()
      order.push('lease-start')
      const result = await operation()
      order.push('lease-end')
      return result
    }
    const loadExecution = vi.fn(async () => {
      order.push('load')
      return execution
    })
    const execute = vi.fn(async () => {
      order.push('execute')
      return { matched: true, completedStepIds: [], comparisons: [] }
    })
    const owner = createOwner({ withStorageLease, loadExecution, execute })

    owner.start(request, 7, (state) => states.push(state))
    await vi.waitFor(() => expect(terminalStates(states)).toHaveLength(1))

    expect(leaseStarted).toHaveBeenCalledOnce()
    expect(order).toEqual(['lease-start', 'load', 'execute', 'lease-end'])
  })

  it('bounds transient check logs while retaining the newest output', async () => {
    const states: ArtifactReproducibilityCheckState[] = []
    const execute = vi.fn(async (input) => {
      input.onEvent?.({
        type: 'step-output',
        entries: Array.from({ length: 9 }, (_, index) => ({
          source: 'notebook' as const,
          stepId: `step:run-${index}`,
          runIndex: index,
          kernelKind: 'python' as const,
          stream: 'stdout' as const,
          text: String(index).repeat(16 * 1024)
        }))
      })
      return { matched: true, completedStepIds: [], comparisons: [] }
    })
    const owner = createOwner({ execute })

    owner.start(request, 7, (state) => states.push(state))
    await vi.waitFor(() => expect(terminalStates(states)).toHaveLength(1))

    expect(states.at(-1)?.logs).toHaveLength(8)
    expect(states.at(-1)?.logs?.[0]).toMatchObject({ source: 'notebook', runIndex: 1 })
    expect(states.at(-1)?.logs?.at(-1)).toMatchObject({ source: 'notebook', runIndex: 8 })
    expect(states.at(-1)?.logsTruncated).toBe(true)
  })

  it('deduplicates the same renderer request and rejects competing ownership', async () => {
    let release!: () => void
    const execute = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          release = () => reject(new Error('finished'))
        })
    )
    const owner = createOwner({ execute })

    const first = owner.start(request, 7, () => undefined)
    const duplicate = owner.start(request, 7, () => undefined)

    expect(duplicate).toEqual(first)
    expect(() => owner.start(request, 8, () => undefined)).toThrow(
      'already running for this Artifact Version'
    )
    expect(() =>
      owner.start({ ...request, frontierId: 'checkpoint:run-1' }, 7, () => undefined)
    ).toThrow('already running for this Artifact Version')
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
    release()
    await owner.dispose()
  })

  it('cancels only attempts owned by the requesting renderer', async () => {
    const states: ArtifactReproducibilityCheckState[] = []
    const execute = vi.fn(
      (input) =>
        new Promise<never>((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => reject(input.signal?.reason), {
            once: true
          })
        })
    )
    const owner = createOwner({ execute })
    const initial = owner.start(request, 7, (state) => states.push(state))

    expect(() => owner.cancel({ attemptId: initial.attemptId }, 8)).toThrow(
      'can only be cancelled by its owner'
    )
    owner.cancel({ attemptId: initial.attemptId }, 7)
    await vi.waitFor(() => expect(terminalStates(states)).toHaveLength(1))

    expect(states.at(-1)?.status).toBe('cancelled')
  })

  it('reports evidence loading failures as an in-memory failed state', async () => {
    const states: ArtifactReproducibilityCheckState[] = []
    const persistReceipt = vi.fn()
    let storageLeaseCount = 0
    const withStorageLease = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
      storageLeaseCount += 1
      return operation()
    }
    const persistFailure = vi.fn(async (_request, attempt, checkLog) => ({
      schemaVersion: 1 as const,
      ...attempt,
      checkLog: {
        logChecksum: 'f'.repeat(64),
        entryCount: checkLog.entries.length,
        sizeBytes: 1,
        truncated: checkLog.truncated
      }
    }))
    const owner = createOwner({
      loadExecution: vi.fn(async () => {
        throw new Error('private source at /Users/researcher/project/notebook.py is corrupt')
      }),
      persistReceipt,
      persistFailure,
      withStorageLease
    })

    owner.start(request, 7, (state) => states.push(state))
    await vi.waitFor(() => expect(terminalStates(states)).toHaveLength(1))

    expect(states.at(-1)).toMatchObject({ status: 'failed', phase: 'loading-evidence' })
    expect(states.at(-1)).not.toHaveProperty('errorMessage')
    expect(JSON.stringify(states)).not.toContain('/Users/researcher')
    expect(JSON.stringify(states)).not.toContain('notebook.py')
    expect(persistReceipt).not.toHaveBeenCalled()
    expect(storageLeaseCount).toBe(2)
    expect(persistFailure).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        attemptId: 'attempt-1',
        phase: 'loading-evidence',
        artifactVersion: {
          projectId: 'project-1',
          appSessionId: 'session-1',
          artifactId: 'artifact-1',
          versionId: 'version-1'
        }
      }),
      { entries: [], truncated: false }
    )
  })

  it('fails closed when a completed check cannot be recorded durably', async () => {
    const states: ArtifactReproducibilityCheckState[] = []
    const owner = createOwner({
      execute: vi.fn(async () => ({ matched: true, completedStepIds: [], comparisons: [] })),
      persistReceipt: vi.fn(async () => {
        throw new Error('receipt storage unavailable')
      })
    })

    owner.start(request, 7, (state) => states.push(state))
    await vi.waitFor(() => expect(terminalStates(states)).toHaveLength(1))

    expect(states.at(-1)).toMatchObject({ status: 'failed', phase: undefined })
    expect(states.at(-1)).not.toHaveProperty('errorMessage')
    expect(states.at(-1)).not.toHaveProperty('receipt')
  })

  it('records only environment locks restored for the selected frontier', async () => {
    const states: ArtifactReproducibilityCheckState[] = []
    const selectedExecution: PersistedArtifactExecutionSnapshot = {
      ...execution,
      reproducibilityRecipe: {
        ...execution.reproducibilityRecipe!,
        steps: [
          {
            kind: 'notebook-run',
            stepId: 'step:run-1',
            activityId: 'run-1',
            sequence: 0,
            runId: 'run-1',
            runIndex: 0,
            kernelKind: 'python',
            sourceChecksum: '1'.repeat(64),
            environmentRequirementId: 'environment:python',
            inputEntityIds: [],
            outputEntityIds: []
          },
          {
            kind: 'notebook-run',
            stepId: 'step:run-2',
            activityId: 'run-2',
            sequence: 1,
            runId: 'run-2',
            runIndex: 1,
            kernelKind: 'r',
            sourceChecksum: '2'.repeat(64),
            environmentRequirementId: 'environment:r',
            inputEntityIds: [],
            outputEntityIds: []
          }
        ],
        frontiers: [
          {
            frontierId: 'original-inputs',
            claimScope: 'end-to-end',
            stepIds: ['step:run-1', 'step:run-2'],
            crossingFiles: [],
            reasonCodes: []
          },
          {
            frontierId: 'checkpoint:run-1',
            claimScope: 'downstream-only',
            afterActivityId: 'run-1',
            stepIds: ['step:run-2'],
            crossingFiles: [],
            reasonCodes: []
          }
        ],
        environmentRequirements: [
          {
            requirementId: 'environment:python',
            kernelKind: 'python',
            lockChecksum: '3'.repeat(64),
            lockState: 'available'
          },
          {
            requirementId: 'environment:r',
            kernelKind: 'r',
            lockChecksum: '4'.repeat(64),
            lockState: 'available'
          }
        ]
      }
    }
    const owner = createOwner({
      loadExecution: vi.fn(async () => selectedExecution),
      execute: vi.fn(async () => ({
        matched: true,
        completedStepIds: ['step:run-2'],
        comparisons: []
      }))
    })

    owner.start({ ...request, frontierId: 'checkpoint:run-1' }, 7, (state) => states.push(state))
    await vi.waitFor(() => expect(terminalStates(states)).toHaveLength(1))

    expect(states.at(-1)?.receipt?.environmentLocks).toEqual([
      {
        requirementId: 'environment:r',
        kernelKind: 'r',
        lockChecksum: '4'.repeat(64)
      }
    ])
  })

  it('finishes recording a completed scientific result when cancellation arrives during commit', async () => {
    const states: ArtifactReproducibilityCheckState[] = []
    let release!: () => void
    const persistReceipt = vi.fn(
      async (_request, receipt) =>
        new Promise<ArtifactReproducibilityCheckState['receipt']>((resolve) => {
          release = () => resolve({ ...receipt, receiptChecksum: 'e'.repeat(64) })
        })
    )
    const owner = createOwner({
      execute: vi.fn(async () => ({
        matched: true,
        completedStepIds: ['step:run-1'],
        comparisons: [
          {
            stepId: 'step:run-1',
            entityId: 'file-1',
            relativePath: 'result.csv',
            expectedChecksum: 'd'.repeat(64),
            expectedSizeBytes: 10,
            actualChecksum: 'd'.repeat(64),
            actualSizeBytes: 10,
            status: 'matched' as const
          }
        ]
      })),
      persistReceipt: persistReceipt as never
    })

    const initial = owner.start(request, 7, (state) => states.push(state))
    await vi.waitFor(() => expect(persistReceipt).toHaveBeenCalledOnce())
    owner.cancel({ attemptId: initial.attemptId }, 7)
    release()
    await vi.waitFor(() => expect(terminalStates(states)).toHaveLength(1))

    expect(states.at(-1)?.status).toBe('matched')
    expect(states.at(-1)?.receipt?.receiptId).toBe('attempt-1')
  })
})
