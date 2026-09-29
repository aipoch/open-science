import { describe, expect, it, vi } from 'vitest'
import type {
  ReplayViewState,
  SaveResearchReplayViewResult
} from '../../../../shared/research-workspace'
import { ResearchReplayViewWriter } from './research-replay-view-writer'
const state: ReplayViewState = {
  fingerprint: 'recorded',
  generatorVersion: 1,
  branchId: 'main',
  timeMs: 1,
  rate: 1
}
const deferred = (): {
  promise: Promise<SaveResearchReplayViewResult>
  resolve: (value: SaveResearchReplayViewResult) => void
  reject: (error: Error) => void
} => {
  let resolve!: (value: SaveResearchReplayViewResult) => void
  let reject!: (error: Error) => void
  const promise = new Promise<SaveResearchReplayViewResult>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
describe('source-scoped Replay checkpoint writer', () => {
  it('coalesces pending checkpoints and advances only its own confirmed revision', async () => {
    const first = deferred()
    const save = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ status: 'saved', revision: 5 })
    const report = vi.fn()
    const writer = new ResearchReplayViewWriter(
      { projectId: 'p', sourceSessionId: 'source' },
      3,
      save,
      report
    )
    writer.enqueue(state)
    writer.enqueue({ ...state, timeMs: 2 })
    writer.enqueue({ ...state, timeMs: 3 })
    first.resolve({ status: 'saved', revision: 4 })
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(save.mock.calls[0][0].expectedRevision).toBe(3)
    expect(save.mock.calls[1][0]).toMatchObject({ expectedRevision: 4, state: { timeMs: 3 } })
    expect(report).toHaveBeenCalledWith('saved')
  })
  it('does not turn another window conflict into an automatic overwrite', async () => {
    const first = deferred()
    const save = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ status: 'saved', revision: 10 })
    const report = vi.fn()
    const writer = new ResearchReplayViewWriter(
      { projectId: 'p', sourceSessionId: 'source' },
      0,
      save,
      report
    )
    writer.enqueue(state)
    writer.enqueue({ ...state, timeMs: 2 })
    first.resolve({ status: 'conflict', snapshot: { state, revision: 9 } })
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith('conflict'))
    expect(save).toHaveBeenCalledTimes(1)
    writer.enqueue({ ...state, timeMs: 3 })
    expect(save.mock.calls[1][0].expectedRevision).toBe(9)
  })
  it.each(['saved', 'conflict', 'error'] as const)(
    'discards old %s replies and queued writes after disposal',
    async (result) => {
      const first = deferred()
      const save = vi.fn().mockReturnValue(first.promise)
      const report = vi.fn()
      const old = new ResearchReplayViewWriter(
        { projectId: 'p', sourceSessionId: 'old' },
        1,
        save,
        report
      )
      old.enqueue(state)
      old.enqueue({ ...state, timeMs: 2 })
      old.dispose()
      if (result === 'error') first.reject(new Error('late failure'))
      else
        first.resolve(
          result === 'saved'
            ? { status: 'saved', revision: 99 }
            : { status: 'conflict', snapshot: null }
        )
      await Promise.resolve()
      await Promise.resolve()
      expect(report).not.toHaveBeenCalled()
      expect(save).toHaveBeenCalledTimes(1)
      old.enqueue(state)
      expect(save).toHaveBeenCalledTimes(1)
      const freshSave = vi.fn().mockResolvedValue({ status: 'saved', revision: 4 })
      new ResearchReplayViewWriter(
        { projectId: 'p', sourceSessionId: 'new' },
        3,
        freshSave,
        report
      ).enqueue(state)
      expect(freshSave.mock.calls[0][0]).toMatchObject({
        sourceSessionId: 'new',
        expectedRevision: 3
      })
    }
  )
})
