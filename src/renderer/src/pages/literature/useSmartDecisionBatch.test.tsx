// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { saveSmartDecisionChunks, useSmartDecisionBatch } from './useSmartDecisionBatch'
import {
  setSmartReevaluationConfirmation,
  shouldConfirmSmartReevaluation
} from './smart-collection-preferences'
afterEach(cleanup)

it('saves bounded atomic chunks and retries only a failed chunk', async () => {
  const ids = Array.from({ length: 121 }, (_, n) => String(n))
  const save = vi
    .fn()
    .mockImplementationOnce(async (saved: string[]) => ({ saved, failed: [] }))
    .mockRejectedValueOnce(new Error('failed'))
    .mockImplementationOnce(async (saved: string[]) => ({ saved, failed: [] }))
  const progress = vi.fn()
  const result = await saveSmartDecisionChunks(ids, save, new AbortController().signal, progress)
  expect(save.mock.calls.map(([chunk]) => chunk.length)).toEqual([50, 50, 21])
  expect(result).toEqual({ done: 71, failed: ids.slice(50, 100), remaining: [] })
  expect(progress.mock.calls.map(([done]) => done)).toEqual([50, 100, 121])
  save.mockReset().mockImplementation(async (saved: string[]) => ({ saved, failed: [] }))
  expect(
    await saveSmartDecisionChunks(result.failed, save, new AbortController().signal, progress)
  ).toEqual({ done: 50, failed: [], remaining: [] })
  expect(save).toHaveBeenCalledExactlyOnceWith(ids.slice(50, 100))
})

it('stops after the in-flight commit, preserving saved and unprocessed references separately', async () => {
  const ids = Array.from({ length: 120 }, (_, n) => String(n))
  const abort = new AbortController()
  const save = vi.fn(async (saved: string[]) => {
    abort.abort()
    return { saved, failed: [] }
  })
  expect(await saveSmartDecisionChunks(ids, save, abort.signal, () => {})).toEqual({
    done: 50,
    failed: [],
    remaining: ids.slice(50)
  })
  expect(save).toHaveBeenCalledOnce()
})

it('stops scheduling after the page unmounts', async () => {
  let release!: (value: unknown) => void
  const transact = vi.fn(
    () =>
      new Promise<unknown>((resolve) => {
        release = resolve
      })
  )
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { transact } } })
  const { result, unmount } = renderHook(useSmartDecisionBatch)
  let task!: ReturnType<typeof result.current.run>
  act(() => {
    task = result.current.run(
      'collection',
      Array.from({ length: 75 }, (_, n) => String(n)),
      'include'
    )
  })
  expect(result.current.progress?.total).toBe(75)
  unmount()
  release({
    smartDecisionBatch: { saved: Array.from({ length: 50 }, (_, n) => String(n)), failed: [] }
  })
  expect(await task).toMatchObject({ done: 50, remaining: expect.any(Array) })
  expect(transact).toHaveBeenCalledOnce()
})

it('does not start a write when a selection lookup settles after unmount', async () => {
  const transact = vi.fn()
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { transact } } })
  const { result, unmount } = renderHook(useSmartDecisionBatch)
  const run = result.current.run
  unmount()
  expect(await run('collection', ['one', 'two'], 'include')).toEqual({
    done: 0,
    failed: [],
    remaining: ['one', 'two']
  })
  expect(transact).not.toHaveBeenCalled()
})

it('restores confirmation after it has been dismissed', () => {
  setSmartReevaluationConfirmation(false)
  expect(shouldConfirmSmartReevaluation()).toBe(false)
  setSmartReevaluationConfirmation(true)
  expect(shouldConfirmSmartReevaluation()).toBe(true)
})
