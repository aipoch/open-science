import { describe, it, expect, vi } from 'vitest'
import { SessionReproducibilityBatches } from './session-reproducibility'
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
  it('freezes workflow selection through preflight and execution-only completion', async () => {
    const workflow = {
      captureId: '1'.repeat(64),
      targetRunIds: ['de', 'plot'],
      boundaryEntityIds: ['clean-file']
    }
    const run = vi.fn(async (request: ArtifactReproducibilityCheckRequest) =>
      state(request, 'executed')
    )
    const batches = new SessionReproducibilityBatches({ preflight, run, cancel: vi.fn() })
    const ready = (await batches.command(
      {
        ...scope,
        action: 'prepare',
        targets: [{ ...targets[0]!, frontierId: 'workflow-selection', workflow }]
      },
      1
    ))!
    workflow.targetRunIds.push('unrelated')
    expect(ready.targets[0]!.workflow!.targetRunIds).toEqual(['de', 'plot'])
    await batches.command({ ...scope, action: 'start', batchId: ready.batchId }, 1)
    await vi.waitFor(async () =>
      expect((await batches.command({ ...scope, action: 'get' }, 1))?.status).toBe('completed')
    )
    expect(run.mock.calls[0]![0].workflow?.targetRunIds).toEqual(['de', 'plot'])
    expect((await batches.command({ ...scope, action: 'get' }, 1))?.targets[0]?.status).toBe(
      'executed'
    )
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
    expect(ready.targets.map((target) => target.frontierId)).toEqual([
      'original-inputs',
      'original-inputs',
      'original-inputs'
    ])
    expect(run.mock.calls.every(([request]) => request.frontierId === 'original-inputs')).toBe(true)
    expect(run.mock.calls[0]![0].expectedRecipeId).toBe('a'.repeat(64))
    expect(await batches.command({ ...scope, action: 'get' }, 2)).toBeUndefined()
  })
  it('admits and executes each selected frontier without changing it after preparation', async () => {
    const selections: Array<(typeof targets)[number] & { frontierId?: string }> = [
      targets[0]!,
      { ...targets[1]!, frontierId: 'checkpoint:run-1' },
      { ...targets[2]!, frontierId: 'checkpoint:run-2' }
    ]
    const inspect =
      vi.fn<(request: ArtifactReproducibilityCheckRequest) => ReturnType<typeof preflight>>(
        preflight
      )
    const run = vi.fn(async (request: ArtifactReproducibilityCheckRequest) =>
      state(request, 'matched')
    )
    const batches = new SessionReproducibilityBatches({ preflight: inspect, run, cancel: vi.fn() })
    const ready = (await batches.command({ ...scope, action: 'prepare', targets: selections }, 1))!
    const frontiers = ['original-inputs', 'checkpoint:run-1', 'checkpoint:run-2']
    expect(ready.targets.map((target) => target.frontierId)).toEqual(frontiers)
    expect(inspect.mock.calls.map(([request]) => request.frontierId)).toEqual(frontiers)
    selections[1]!.frontierId = 'original-inputs'
    ready.targets[2]!.frontierId = 'original-inputs'
    await batches.command({ ...scope, action: 'start', batchId: ready.batchId }, 1)
    await vi.waitFor(async () =>
      expect((await batches.command({ ...scope, action: 'get' }, 1))?.status).toBe('completed')
    )
    expect(run.mock.calls.map(([request]) => request.frontierId)).toEqual(frontiers)
    expect(run.mock.calls.every(([request]) => request.expectedRecipeId === 'a'.repeat(64))).toBe(
      true
    )
  })
  it.each(['checkpoint:missing', 'checkpoint:unrecoverable'])(
    'blocks a rejected frontier %s without retrying from original inputs',
    async (frontierId) => {
      const inspect = vi.fn(async (request: ArtifactReproducibilityCheckRequest) => {
        if (request.frontierId === frontierId) throw new Error('Selected frontier is unavailable')
        return preflight()
      })
      const run = vi.fn(async (request: ArtifactReproducibilityCheckRequest) =>
        state(request, 'matched')
      )
      const batches = new SessionReproducibilityBatches({
        preflight: inspect,
        run,
        cancel: vi.fn()
      })
      const ready = (await batches.command(
        {
          ...scope,
          action: 'prepare',
          targets: [{ ...targets[0]!, frontierId }, targets[1]!]
        },
        1
      ))!
      expect(ready.targets[0]).toMatchObject({
        frontierId,
        status: 'blocked',
        reason: 'preflight-failed'
      })
      expect(inspect.mock.calls.map(([request]) => request.frontierId)).toEqual([
        frontierId,
        'original-inputs'
      ])
      await batches.command({ ...scope, action: 'start', batchId: ready.batchId }, 1)
      await vi.waitFor(async () =>
        expect((await batches.command({ ...scope, action: 'get' }, 1))?.status).toBe('completed')
      )
      expect(run.mock.calls.map(([request]) => [request.artifactId, request.frontierId])).toEqual([
        ['two', 'original-inputs']
      ])
    }
  )
  it.each(['', 'x'.repeat(257)])(
    'rejects an invalid frontier before preflight',
    async (frontierId) => {
      const inspect = vi.fn(preflight)
      const batches = new SessionReproducibilityBatches({
        preflight: inspect,
        run: vi.fn(),
        cancel: vi.fn()
      })
      await expect(
        batches.command(
          { ...scope, action: 'prepare', targets: [{ ...targets[0]!, frontierId }] },
          1
        )
      ).rejects.toThrow()
      expect(inspect).not.toHaveBeenCalled()
    }
  )
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
    await expect(
      batches.command(
        {
          ...scope,
          action: 'prepare',
          targets: [
            { ...targets[0]!, frontierId: 'original-inputs' },
            { ...targets[0]!, frontierId: 'checkpoint:run-1' }
          ]
        },
        1
      )
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
