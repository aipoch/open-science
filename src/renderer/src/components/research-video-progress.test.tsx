// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ResearchVideoGenerationProgress } from './research-video-progress'
it('filters by the displayed session and stops status requests on unmount', async () => {
  vi.useFakeTimers()
  const previous = window.api
  const getProgress = vi.fn(async () => ({
    phase: 'voice' as const,
    completed: 3,
    total: 7,
    completedLines: 1,
    totalLines: 3,
    startedAt: Date.now()
  }))
  window.api = { ...previous, researchVideo: { ...previous?.researchVideo, getProgress } }
  const container = document.createElement('div'),
    root = createRoot(container)
  document.body.appendChild(container)
  try {
    await act(async () =>
      root.render(<ResearchVideoGenerationProgress projectId="p" sessionId="s" branchId="b" />)
    )
    expect(getProgress).toHaveBeenCalledWith({ projectId: 'p', sessionId: 's', branchId: 'b' })
    expect(container.textContent).toContain('Speech steps: 3 / 7')
    expect(container.textContent).toContain('Lines: 1 / 3')
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(
      '43'
    )
    expect(container.querySelector('progress')).toBeNull()
    getProgress.mockResolvedValueOnce(undefined as never)
    await act(async () =>
      root.render(<ResearchVideoGenerationProgress projectId="p" sessionId="other" branchId="c" />)
    )
    expect(container.querySelector('[role="status"]')).toBeNull()
  } finally {
    await act(async () => root.unmount())
    const calls = getProgress.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(getProgress).toHaveBeenCalledTimes(calls)
    container.remove()
    window.api = previous
    vi.useRealTimers()
  }
})
