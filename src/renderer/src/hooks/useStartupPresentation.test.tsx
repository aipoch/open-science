// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useStartupPresentation } from './useStartupPresentation'

afterEach(() => {
  delete window.startupPresentation
  vi.unstubAllGlobals()
})

it('waits for paint and cancels an obsolete interactive acknowledgement', () => {
  const callbacks = new Map<number, FrameRequestCallback>()
  let id = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    callbacks.set(++id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => callbacks.delete(frame))
  const phase = vi.fn()
  window.startupPresentation = { phase }
  const { rerender, unmount } = renderHook(({ state }) => useStartupPresentation(state), {
    initialProps: { state: 'interactive' as 'interactive' | 'startup-sessions' }
  })
  expect(phase).not.toHaveBeenCalled()
  const paint = (): void => {
    act(() => {
      const frames = [...callbacks.values()]
      callbacks.clear()
      frames.forEach((cb) => cb(0))
    })
  }
  paint()
  expect(phase).not.toHaveBeenCalled()
  rerender({ state: 'startup-sessions' })
  paint()
  paint()
  expect(phase.mock.calls).toEqual([['startup-sessions']])
  rerender({ state: 'interactive' })
  paint()
  paint()
  expect(phase).toHaveBeenLastCalledWith('interactive')
  unmount()
  expect(callbacks.size).toBe(0)
})
