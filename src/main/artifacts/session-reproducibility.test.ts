import { describe, it, expect, vi } from 'vitest'
import { SessionReproducibilityBatches } from './session-reproducibility'
import { NotebookExecutionAdmissionError } from '../notebook/execution-admission'
import type {
  ArtifactReproducibilityCheckRequest,
  ArtifactReproducibilityCheckState
} from '../../shared/artifact-reproducibility'

const scope = { projectId: 'p', appSessionId: 's' }
const targets = ['one', 'two', 'three'].map((id) => ({
  artifactId: id,
  versionId: `${id}-v1`,
  name: `${id}.csv`
}))
const preflight = async (): Promise<{
  recipeId: string
  steps: number
  inputBytes: number
  environmentCount: number
}> => ({
  recipeId: 'a'.repeat(64),
  steps: 1,
  inputBytes: 10,
  environmentCount: 1
})
const state = (
  request: ArtifactReproducibilityCheckRequest,
  status: ArtifactReproducibilityCheckState['status']
): ArtifactReproducibilityCheckState => ({
  request,
  status,
  attemptId: request.artifactId,
  revision: 0,
  startedAt: new Date().toISOString(),
  completedSteps: 0,
  totalSteps: 1,
  completedEnvironments: 0,
  totalEnvironments: 1,
  totalComparisons: 1,
  comparisons: []
})
describe('Session reproducibility batches', () => {
  it('exposes ready batches and stops their original unstarted targets without stopping a successor', async () => {
    const run = vi.fn(async (request: ArtifactReproducibilityCheckRequest) =>
      state(request, 'matched')
    )
    const batches = new SessionReproducibilityBatches({ preflight, run, cancel: vi.fn() })
    const ready = (await batches.command({ ...scope, action: 'prepare', targets }, 1))!
    const [original] = batches.resources({ projectId: 'p', sessionId: 's' })
    expect(original).toMatchObject({
      group: 'batch',
      phase: 'ready',
      projectId: 'p',
      sessionId: 's',
      startedAt: expect.any(Number)
    })
    expect(batches.activeSessions()).toEqual([{ projectId: 'p', sessionId: 's' }])
    await expect(original.release()).resolves.toMatchObject({ reaped: true })
    await expect(
      batches.command({ ...scope, action: 'start', batchId: ready.batchId }, 1)
    ).rejects.toThrow('no longer current')
    expect(run).not.toHaveBeenCalled()
    const successor = (await batches.command({ ...scope, action: 'prepare', targets }, 1))!
    await expect(original.release()).resolves.toMatchObject({ reaped: true })
    expect((await batches.command({ ...scope, action: 'get' }, 1))?.batchId).toBe(successor.batchId)
    expect((await batches.command({ ...scope, action: 'get' }, 1))?.status).toBe('ready')
    await batches.stopWhere(() => true)
  })

  it('retains a failed original batch projection for retry and does not evict its cleanup fence', async () => {
    let failProjection = false
    const save = vi.fn(async (batch) => {
      if (failProjection && batch.appSessionId === 's') throw new Error('checkpoint unavailable')
    })
    const batches = new SessionReproducibilityBatches({
      preflight,
      run: vi.fn(),
      cancel: vi.fn(),
      store: { load: async () => undefined, save }
    })
    const ready = (await batches.command({ ...scope, action: 'prepare', targets }, 1))!
    const [original] = batches.resources()
    failProjection = true
    await expect(original.release()).resolves.toMatchObject({ reaped: true, projection: 'failed' })
    await expect(
      batches.command({ ...scope, action: 'start', batchId: ready.batchId }, 1)
    ).rejects.toThrow('cleanup is incomplete')
    for (let index = 0; index < 64; index++) {
      await batches.command(
        { ...scope, appSessionId: `other-${index}`, action: 'prepare', targets: [targets[0]] },
        1
      )
    }
    expect(batches.resources({ sessionId: 's' })[0]?.identity).toBe(original.identity)
    failProjection = false
    await expect(original.release()).resolves.toMatchObject({
      reaped: true,
      projection: 'complete'
    })
    expect(batches.resources({ sessionId: 's' })).toEqual([])
    await batches.stopWhere(() => true)
  })

  it('stops pending targets after a memory refusal and preserves completed targets', async () => {
    const run = vi.fn(
      async (
        request: ArtifactReproducibilityCheckRequest,
        publish: (state: ArtifactReproducibilityCheckState) => void
      ) => {
        if (request.artifactId === 'two') {
          publish({
            ...state(request, 'failed'),
            failedStep: { stepId: 'step:two', runIndex: 1, execution: 'not-started' }
          })
          throw new NotebookExecutionAdmissionError(
            'NOTEBOOK_MEMORY_PRESSURE',
            'Execution was not started.'
          )
        }
        return state(request, 'matched')
      }
    )
    const batches = new SessionReproducibilityBatches({ preflight, run, cancel: vi.fn() })
    const ready = (await batches.command({ ...scope, action: 'prepare', targets }, 1))!
    await batches.command({ ...scope, action: 'start', batchId: ready.batchId }, 1)
    await vi.waitFor(async () =>
      expect((await batches.command({ ...scope, action: 'get' }, 1))?.status).toBe('cancelled')
    )
    expect((await batches.command({ ...scope, action: 'get' }, 1))?.targets).toMatchObject([
      { status: 'matched' },
      {
        status: 'failed',
        failedStep: { stepId: 'step:two', runIndex: 1, execution: 'not-started' }
      },
      { status: 'cancelled' }
    ])
    expect(run.mock.calls.map(([request]) => request.artifactId)).toEqual(['one', 'two'])
  })
  it('fixes versions at preflight, skips blocked targets and continues after failure', async () => {
    const run = vi.fn(async (request: ArtifactReproducibilityCheckRequest) => {
      if (request.artifactId === 'two') throw new Error('execution failed')
      return state(request, 'matched')
    })
    const batches = new SessionReproducibilityBatches({
      preflight: async (request) => {
        if (request.artifactId === 'one') throw new Error('missing lock')
        return preflight()
      },
      run,
      cancel: vi.fn()
    })
    const ready = (await batches.command({ ...scope, action: 'prepare', targets }, 1))!
    expect(ready.targets.map((t) => t.status)).toEqual(['blocked', 'queued', 'queued'])
    // Callers cannot mutate the admitted plan.
    ready.targets[2]!.versionId = 'new-version'
    await batches.command({ ...scope, action: 'start', batchId: ready.batchId }, 1)
    await vi.waitFor(async () =>
      expect((await batches.command({ ...scope, action: 'get' }, 1))?.status).toBe('completed')
    )
    expect(
      (await batches.command({ ...scope, action: 'get' }, 1))?.targets.map((t) => t.status)
    ).toEqual(['blocked', 'failed', 'matched'])
    expect(run.mock.calls.map(([request]) => request.versionId)).toEqual(['two-v1', 'three-v1'])
    expect(run.mock.calls[0]![0].expectedRecipeId).toBe('a'.repeat(64))
    expect(await batches.command({ ...scope, action: 'get' }, 2)).toBeUndefined()
  })
  it('cancels queued targets before draining a running worker', async () => {
    let finish!: () => void
    const run = vi.fn(
      async (
        request: ArtifactReproducibilityCheckRequest,
        publish: (state: ArtifactReproducibilityCheckState) => void
      ) => {
        publish(state(request, 'running'))
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        return state(request, 'cancelled')
      }
    )
    const cancel = vi.fn(() => finish())
    const batches = new SessionReproducibilityBatches({ preflight, run, cancel })
    const ready = (await batches.command({ ...scope, action: 'prepare', targets }, 1))!
    await batches.command({ ...scope, action: 'start', batchId: ready.batchId }, 1)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    await batches.command({ ...scope, action: 'cancel', batchId: ready.batchId }, 1)
    expect(cancel).toHaveBeenCalledWith('one', 1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(
      (await batches.command({ ...scope, action: 'get' }, 1))?.targets.map((t) => t.status)
    ).toEqual(['cancelled', 'cancelled', 'cancelled'])
  })
  it('cancels preflight and rejects stale or duplicate selections', async () => {
    let release!: () => void
    const batches = new SessionReproducibilityBatches({
      preflight: async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return preflight()
      },
      run: vi.fn(),
      cancel: vi.fn()
    })
    await expect(
      batches.command({ ...scope, action: 'prepare', targets: [targets[0]!, targets[0]!] }, 1)
    ).rejects.toThrow('Duplicate')
    const pending = batches.command({ ...scope, action: 'prepare', targets }, 1)
    const stopping = batches.stopWhere(() => true)
    release()
    await stopping
    const result = await pending
    expect(result?.status).toBe('cancelled')
    expect(result?.targets.every((t) => t.status === 'cancelled')).toBe(true)
    await expect(
      batches.command({ ...scope, action: 'start', batchId: 'stale' }, 1)
    ).rejects.toThrow('current')
  })
  it('drains delayed checkpoints before scope removal and does not write them again on shutdown', async () => {
    let release!: () => void
    const save = vi.fn(async () => {})
    const run = vi.fn()
    const batches = new SessionReproducibilityBatches({
      preflight,
      run,
      cancel: vi.fn(),
      store: { load: async () => undefined, save }
    })
    const ready = (await batches.command({ ...scope, action: 'prepare', targets }, 1))!
    save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await batches.command({ ...scope, action: 'start', batchId: ready.batchId }, 1)
    let drained = false
    const stopping = batches
      .stopWhere(() => true)
      .then(() => {
        drained = true
      })
    await Promise.resolve()
    expect(drained).toBe(false)
    release()
    await stopping
    expect(run).not.toHaveBeenCalled()
    const writes = save.mock.calls.length
    await batches.stopWhere(() => true)
    expect(save).toHaveBeenCalledTimes(writes)
    expect(batches.activeSessions()).toEqual([])
  })
})
