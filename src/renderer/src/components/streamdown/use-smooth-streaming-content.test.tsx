// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSmoothStreamingContent } from './use-smooth-streaming-content'

type Snapshot = { content: string; presenting: boolean }

const Probe = ({
  content,
  sourceOpen,
  snapshots
}: {
  content: string
  sourceOpen: boolean
  snapshots: Snapshot[]
}): null => {
  const presentation = useSmoothStreamingContent(content, sourceOpen)
  const last = snapshots[snapshots.length - 1]
  if (
    !last ||
    last.content !== presentation.content ||
    last.presenting !== presentation.isPresenting
  ) {
    snapshots.push({ content: presentation.content, presenting: presentation.isPresenting })
  }
  return null
}

describe('useSmoothStreamingContent', () => {
  let container: HTMLDivElement
  let root: Root
  let snapshots: Snapshot[]

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
    snapshots = []
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
    container.remove()
  })

  const renderProbe = async (content: string, sourceOpen = true): Promise<void> => {
    await act(async () => {
      root.render(<Probe content={content} sourceOpen={sourceOpen} snapshots={snapshots} />)
    })
  }

  const advance = async (ms: number): Promise<void> => {
    await act(async () => vi.advanceTimersByTimeAsync(ms))
  }

  // One act per 16ms frame so each frame's commit flushes to a paint instead of batching.
  const advanceFrames = async (frames: number): Promise<void> => {
    for (let frame = 0; frame < frames; frame += 1) {
      await advance(16)
    }
  }

  it('prebuffers before revealing while the source is open', async () => {
    await renderProbe('a'.repeat(100))

    await advance(400)
    expect(snapshots[snapshots.length - 1]?.content ?? '').toBe('')

    await advance(200)
    const visible = snapshots[snapshots.length - 1]?.content ?? ''
    expect(visible.length).toBeGreaterThan(0)
    expect(visible.length).toBeLessThan(100)
  })

  it('commits every frame while content stays below the adaptive threshold', async () => {
    await renderProbe('a'.repeat(1500))
    await advance(500)

    snapshots.length = 0
    await advanceFrames(20)

    // 20 frames at 16ms: per-frame pacing means nearly every frame paints new graphemes.
    expect(snapshots.length).toBeGreaterThanOrEqual(15)
  })

  it('lowers the commit rate for long content while keeping the reveal rate', async () => {
    await renderProbe('a'.repeat(8000))
    await advance(500)

    snapshots.length = 0
    await advanceFrames(20)

    // 8000 graphemes commits at a 64ms interval: ~5 paints over 20 frames, each ~4x larger.
    expect(snapshots.length).toBeGreaterThan(0)
    expect(snapshots.length).toBeLessThanOrEqual(8)
    const revealed = snapshots[snapshots.length - 1]?.content.length ?? 0
    expect(revealed).toBeGreaterThan(500)
  })

  it('drains a long backlog in bounded time and lands on the exact final content', async () => {
    const target = 'b'.repeat(8000)
    await renderProbe(target)
    await advance(500)

    await advance(8000)
    const last = snapshots[snapshots.length - 1]
    expect(last?.content).toBe(target)
  })

  it('flushes the remaining backlog without reserve once the source closes', async () => {
    const target = 'c'.repeat(4000)
    await renderProbe(target)
    await advance(1000)

    await renderProbe(target, false)
    await advance(8000)

    const last = snapshots[snapshots.length - 1]
    expect(last?.content).toBe(target)
    expect(last?.presenting).toBe(false)
  })

  it('reveals immediately when reduced motion is requested', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }))

    const target = 'd'.repeat(5000)
    await renderProbe(target)

    const last = snapshots[snapshots.length - 1]
    expect(last?.content).toBe(target)
  })
})
