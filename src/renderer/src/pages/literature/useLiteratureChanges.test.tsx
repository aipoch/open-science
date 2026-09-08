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
