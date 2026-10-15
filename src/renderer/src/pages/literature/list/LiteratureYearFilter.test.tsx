// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useLiteratureYearFilter } from './useLiteratureYearFilter'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('commits a complete year range once after typing pauses', () => {
  const commit = vi.fn()
  const { result } = renderHook(() => useLiteratureYearFilter(commit))
  act(() => result.current.setDraftFrom('2'))
  act(() => vi.advanceTimersByTime(200))
  act(() => result.current.setDraftFrom('2020'))
  act(() => result.current.setDraftTo('2024'))
  act(() => vi.advanceTimersByTime(399))
  expect(commit).not.toHaveBeenCalled()
  expect(result.current.from).toBe('')
  act(() => vi.advanceTimersByTime(1))
  expect(commit).toHaveBeenCalledTimes(1)
  expect(result.current).toMatchObject({ from: '2020', to: '2024' })
})

it('keeps the applied range during invalid edits and cancels pending input when cleared', () => {
  const commit = vi.fn()
  const { result } = renderHook(() => useLiteratureYearFilter(commit))
  act(() => result.current.setDraftFrom('2020'))
  act(() => vi.advanceTimersByTime(400))
  for (const value of ['2019', '10000', '-1', '2024.5']) {
    act(() => result.current.setDraftTo(value))
    act(() => vi.advanceTimersByTime(400))
    expect(result.current).toMatchObject({ from: '2020', to: '', invalid: true })
  }
  expect(commit).toHaveBeenCalledTimes(1)
  act(() => result.current.setDraftTo(''))
  expect(result.current.invalid).toBe(false)
  act(() => result.current.setDraftTo('2024'))
  act(() => result.current.clear())
  act(() => vi.advanceTimersByTime(1000))
  expect(result.current).toMatchObject({
    from: '',
    to: '',
    draftFrom: '',
    draftTo: '',
    invalid: false
  })
  expect(commit).toHaveBeenCalledTimes(1)
})
