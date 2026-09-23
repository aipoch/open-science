// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSmoothStreamingContent } from './use-smooth-streaming-content'

type Snapshot = { content: string; presenting: boolean }

const Probe = ({
  content,
  sourceOpen,
  snapshots,
  animateOnMount
}: {
  content: string
  sourceOpen: boolean
  snapshots: Snapshot[]
  animateOnMount?: boolean
}): null => {
  const presentation = useSmoothStreamingContent(content, sourceOpen, animateOnMount)
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

  it('accepts a provider burst beyond the engine argument limit and preserves exact Unicode through stop', async () => {
    const target = 'a'.repeat(220_000) + '👩‍🔬e\u0301'.repeat(32)
    await renderProbe('prefix')
    await renderProbe('prefix' + target)
    await advance(600)
    const partial = snapshots.at(-1)!.content
    expect(partial.length).toBeGreaterThan(0)
    expect(('prefix' + target).startsWith(partial)).toBe(true)
    await renderProbe('prefix' + target, false)
    expect(snapshots.at(-1)).toEqual({ content: 'prefix' + target, presenting: false })
    expect(vi.getTimerCount()).toBe(0)
    await advance(1_000)
    expect(snapshots.at(-1)).toEqual({ content: 'prefix' + target, presenting: false })
  })

  it.each([600, 601])(
    'preserves ordinary close pacing through the %i-grapheme catch-up boundary',
    async (size) => {
      const target = 'x'.repeat(size)
      await renderProbe(target)
      await renderProbe(target, false)
      expect(snapshots.at(-1)).toEqual(
        size === 600 ? { content: '', presenting: true } : { content: target, presenting: false }
      )
      await advance(10_000)
      expect(snapshots.at(-1)).toEqual({ content: target, presenting: false })
    }
  )

  it('preserves intentional animation of a source mounted already closed', async () => {
    await act(async () =>
      root.render(
        <Probe content="queued reply" sourceOpen={false} animateOnMount snapshots={snapshots} />
      )
    )
    expect(snapshots.at(-1)).toEqual({ content: '', presenting: true })
    await advance(1_000)
    expect(snapshots.at(-1)).toEqual({ content: 'queued reply', presenting: false })
  })

  it('cleans pending animation when unmounted under StrictMode', async () => {
    await act(async () =>
      root.render(
        <StrictMode>
          <Probe content={'a'.repeat(1_000)} sourceOpen snapshots={snapshots} />
        </StrictMode>
      )
    )
    await advance(600)
    expect(snapshots.at(-1)!.presenting).toBe(true)
    await act(async () => root.render(null))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('segments initial content once rather than on every presentation render', async () => {
    const target = 'initial'.repeat(1_000)
    const segment = vi.spyOn(Intl.Segmenter.prototype, 'segment')
    try {
      await renderProbe(target)
      await advance(600)
      await advanceFrames(8)
      await renderProbe(target)
      expect(segment.mock.calls.filter(([value]) => value === target)).toHaveLength(1)
    } finally {
      segment.mockRestore()
    }
  })

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
