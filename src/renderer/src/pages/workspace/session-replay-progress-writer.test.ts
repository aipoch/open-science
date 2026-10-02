import { describe, expect, it, vi } from 'vitest'
import type {
  ReplayViewState,
  SaveSessionReplayProgressResult
} from '../../../../shared/session-replay'
import { SessionReplayProgressWriter } from './session-replay-progress-writer'
const state: ReplayViewState = {
  fingerprint: 'recorded',
  generatorVersion: 1,
  branchId: 'main',
  timeMs: 1,
  rate: 1
}
const deferred = (): {
  promise: Promise<SaveSessionReplayProgressResult>
  resolve: (value: SaveSessionReplayProgressResult) => void
  reject: (error: Error) => void
} => {
  let resolve!: (value: SaveSessionReplayProgressResult) => void
  let reject!: (error: Error) => void
  const promise = new Promise<SaveSessionReplayProgressResult>((yes, no) => {
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
    const writer = new SessionReplayProgressWriter(
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
    const writer = new SessionReplayProgressWriter(
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
    expect(save).toHaveBeenCalledTimes(1)
    writer.retry()
    expect(save.mock.calls[1][0].expectedRevision).toBe(9)
  })
  it('retries the newest failed checkpoint explicitly and avoids duplicate saved writes', async () => {
    const first = deferred()
    const save = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ status: 'saved', revision: 2 })
    const report = vi.fn()
    const writer = new SessionReplayProgressWriter(
      { projectId: 'p', sourceSessionId: 's' },
      1,
      save,
      report
    )
    writer.enqueue(state)
    writer.enqueue({ ...state, timeMs: 5 })
    first.reject(new Error('Unavailable'))
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.any(Error)))
    expect(save).toHaveBeenCalledTimes(1)
    writer.retry()
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith('saved'))
    expect(save.mock.calls[1][0]).toMatchObject({ expectedRevision: 1, state: { timeMs: 5 } })
    writer.enqueue({ ...state, timeMs: 5 })
    expect(save).toHaveBeenCalledTimes(2)
    writer.dispose()
    writer.retry()
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('revalidates an earlier position after a potentially committed failed write', async () => {
    const save = vi
      .fn()
      .mockResolvedValueOnce({ status: 'saved', revision: 1 })
      .mockRejectedValueOnce(new Error('Acknowledgement lost'))
      .mockResolvedValueOnce({ status: 'conflict', snapshot: { state, revision: 2 } })
    const report = vi.fn()
    const writer = new SessionReplayProgressWriter(
      { projectId: 'p', sourceSessionId: 's' },
      0,
      save,
      report
    )
    writer.enqueue(state)
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith('saved'))
    writer.enqueue({ ...state, timeMs: 2 })
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.any(Error)))
    writer.enqueue(state)
    writer.retry()
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith('conflict'))
    expect(save).toHaveBeenCalledTimes(3)
  })

  it.each(['saved', 'conflict', 'error'] as const)(
    'discards old %s replies and queued writes after disposal',
    async (result) => {
      const first = deferred()
      const save = vi.fn().mockReturnValue(first.promise)
      const report = vi.fn()
      const old = new SessionReplayProgressWriter(
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
      new SessionReplayProgressWriter(
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
