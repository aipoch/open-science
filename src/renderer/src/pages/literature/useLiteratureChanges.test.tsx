// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useLiteratureChanges } from './useLiteratureChanges'

afterEach(cleanup)
it('coalesces mutation bursts and restores missed changes on visibility and replay without leaking subscriptions', async () => {
  let notify!: () => void
  const unsubscribe = vi.fn()
  const onChanged = vi.fn((listener: () => void) => {
    notify = listener
    return unsubscribe
  })
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { onChanged } } })
  const first = vi.fn(),
    latest = vi.fn()
  const { rerender, unmount } = renderHook(({ invalidate }) => useLiteratureChanges(invalidate), {
    initialProps: { invalidate: first }
  })
  await act(async () => {
    notify()
    notify()
    window.dispatchEvent(new Event('focus'))
  })
  expect(first).toHaveBeenCalledTimes(1)
  rerender({ invalidate: latest })
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await act(async () => window.dispatchEvent(new Event('open-science:web-events-open')))
  expect(latest).toHaveBeenCalledTimes(2)
  expect(onChanged).toHaveBeenCalledTimes(1)
  notify()
  unmount()
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
    notify()
  })
  expect(latest).toHaveBeenCalledTimes(2)
  expect(unsubscribe).toHaveBeenCalledTimes(1)
})

it.each(['onDeleted', 'onDeletionCleanupChanged'] as const)(
  'refreshes literature when project availability changes through %s and releases that subscription',
  async (subscription) => {
    let notify!: () => void
    const remove = vi.fn()
    const onDeleted = vi.fn((listener: () => void) => {
      notify = listener
      return remove
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { projects: { [subscription]: onDeleted } }
    })
    const invalidate = vi.fn()
    const { unmount } = renderHook(() => useLiteratureChanges(invalidate))
    expect(onDeleted).toHaveBeenCalledOnce()
    await act(async () => notify())
    expect(invalidate).toHaveBeenCalledOnce()
    unmount()
    expect(remove).toHaveBeenCalledOnce()
    await act(async () => notify())
    expect(invalidate).toHaveBeenCalledOnce()
  }
)

it('coalesces collection progress across ticks and lets a full invalidation supersede it', async () => {
  vi.useFakeTimers()
  try {
    let notify!: (event: { revision: number; collectionIds?: string[]; itemIds?: string[] }) => void
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        literature: {
          onChanged: (listener: typeof notify) => {
            notify = listener
            return () => {}
          }
        }
      }
    })
    const invalidate = vi.fn()
    const { unmount } = renderHook(() => useLiteratureChanges(invalidate))
    await act(async () => {
      notify({ revision: 1, collectionIds: ['a'] })
      await vi.advanceTimersByTimeAsync(50)
    })
    await act(async () => {
      notify({ revision: 2, collectionIds: ['b'] })
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ revision: 2, collectionIds: ['a', 'b'] })
    await act(async () => {
      notify({ revision: 3, collectionIds: ['a'] })
      notify({ revision: 4, itemIds: ['paper'] })
    })
    expect(invalidate).toHaveBeenCalledTimes(2)
    expect(invalidate).toHaveBeenLastCalledWith()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(invalidate).toHaveBeenCalledTimes(2)
    notify({ revision: 5, collectionIds: ['a'] })
    unmount()
    await vi.advanceTimersByTimeAsync(100)
    expect(invalidate).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
})

it('consumes only queued changes covered by a command refresh, preserving other and later changes', async () => {
  vi.useFakeTimers()
  try {
    let notify!: (event: { revision: number; collectionIds: string[] }) => void
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        literature: {
          onChanged: (listener: typeof notify) => {
            notify = listener
            return () => {}
          }
        }
      }
    })
    const invalidate = vi.fn()
    const { result } = renderHook(() => useLiteratureChanges(invalidate))
    notify({ revision: 1, collectionIds: ['a'] })
    result.current('a')
    await act(() => vi.advanceTimersByTimeAsync(100))
    expect(invalidate).not.toHaveBeenCalled()
    notify({ revision: 2, collectionIds: ['a', 'b'] })
    result.current('a')
    await act(() => vi.advanceTimersByTimeAsync(100))
    expect(invalidate).toHaveBeenLastCalledWith({ revision: 2, collectionIds: ['b'] })
    notify({ revision: 3, collectionIds: ['a'] })
    await act(() => vi.advanceTimersByTimeAsync(100))
    expect(invalidate).toHaveBeenLastCalledWith({ revision: 3, collectionIds: ['a'] })
  } finally {
    vi.useRealTimers()
  }
})
