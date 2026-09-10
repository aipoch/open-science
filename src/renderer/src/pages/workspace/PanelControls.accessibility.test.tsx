// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ResizableBottomPanel } from '@/pages/workspace/ResizableBottomPanel'
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('resizing publishes the current size through a value-bearing handle', () => {
  render(
    <ResizableBottomPanel ariaLabel="Resize question panel" testId="surface" scrollTestId="scroll">
      <p>Question</p>
    </ResizableBottomPanel>
  )
  const surface = screen.getByTestId('surface')
  vi.spyOn(surface, 'getBoundingClientRect').mockImplementation(
    () => ({ height: Number.parseFloat(surface.style.height) || 400 }) as DOMRect
  )
  const handle = screen.getByLabelText('Resize question panel')
  fireEvent.keyDown(handle, { key: 'ArrowUp' })
  expect(surface.style.height).toBe('432px')
  expect(handle.getAttribute('aria-valuenow')).toBe('432')
  expect(handle.getAttribute('role')).toBe('separator')
  expect(document.getElementById(handle.getAttribute('aria-controls')!)).toBe(
    screen.getByTestId('scroll')
  )
  const originalHeight = window.innerHeight
  try {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 500 })
    act(() => window.dispatchEvent(new Event('resize')))
    expect(surface.style.height).toBe('350px')
    expect(handle.getAttribute('aria-valuenow')).toBe('350')
    expect(handle.getAttribute('aria-valuemax')).toBe('350')
  } finally {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight })
  }
})
