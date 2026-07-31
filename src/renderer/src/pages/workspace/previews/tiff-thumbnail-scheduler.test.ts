import { describe, expect, it, vi } from 'vitest'

import { createTiffThumbnailScheduler } from './tiff-thumbnail-scheduler'

const deferred = <T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

describe('TIFF thumbnail scheduler', () => {
  it('limits concurrent decodes and removes aborted queued work', async () => {
    const scheduler = createTiffThumbnailScheduler(2)
    const first = deferred<number>()
    const second = deferred<number>()
    const starts = vi.fn()
    const firstTask = scheduler.schedule(new AbortController().signal, () => {
      starts('first')
      return first.promise
    })
    const secondTask = scheduler.schedule(new AbortController().signal, () => {
      starts('second')
      return second.promise
    })
    const thirdController = new AbortController()
    const thirdTask = scheduler.schedule(thirdController.signal, async () => {
      starts('third')
      return 3
    })

    await Promise.resolve()
    expect(starts.mock.calls.map(([name]) => name)).toEqual(['first', 'second'])

    thirdController.abort()
    await expect(thirdTask).rejects.toMatchObject({ name: 'AbortError' })
    first.resolve(1)
    second.resolve(2)
    await expect(Promise.all([firstTask, secondTask])).resolves.toEqual([1, 2])
    expect(starts).not.toHaveBeenCalledWith('third')
  })
})
