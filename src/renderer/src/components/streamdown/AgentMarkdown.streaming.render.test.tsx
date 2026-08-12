// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentMarkdown } from './AgentMarkdown'

describe('AgentMarkdown streaming presentation', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
    container.remove()
  })

  it('continues painting while target content grows faster than animation frames', async () => {
    await act(async () => {
      root.render(<AgentMarkdown content="流" isAnimating />)
    })

    for (let length = 2; length <= 70; length += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(8))
      await act(async () => {
        root.render(<AgentMarkdown content={'流'.repeat(length)} isAnimating />)
      })
    }

    const visible = container.querySelector('.agent-markdown')?.textContent ?? ''
    expect(visible.length).toBeGreaterThan(0)
    expect(visible.length).toBeLessThan(70)
  })
})
