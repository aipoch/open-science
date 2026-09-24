// @vitest-environment jsdom
import { act, Activity, StrictMode } from 'react'
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
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
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

  const renderActivityProbe = async (
    content: string,
    sourceOpen: boolean,
    active: boolean
  ): Promise<void> => {
    await act(async () => {
      root.render(
        <Activity mode={active ? 'visible' : 'hidden'}>
          <Probe content={content} sourceOpen={sourceOpen} snapshots={snapshots} />
        </Activity>
      )
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

  it('starts an already-visible open source as presenting without an extra mount transition', async () => {
    const initial = 'restored reply '
    await act(async () =>
      root.render(
        <Probe content={initial} sourceOpen animateOnMount={false} snapshots={snapshots} />
      )
    )
    expect(snapshots).toEqual([{ content: initial, presenting: true }])

    await act(async () =>
      root.render(
        <Probe
          content={`${initial}${'a'.repeat(1_000)}`}
          sourceOpen
          animateOnMount={false}
          snapshots={snapshots}
        />
      )
    )
    expect(snapshots.at(-1)).toEqual({ content: initial, presenting: true })
    await advance(400)
    expect(snapshots.at(-1)?.content).toBe(initial)
    await advance(200)
    expect(snapshots.at(-1)?.content.length).toBeGreaterThan(initial.length)
    expect(snapshots.at(-1)?.content.length).toBeLessThan(initial.length + 1_000)
  })

  it('releases an already-visible open source when it closes without new content', async () => {
    await act(async () =>
      root.render(
        <Probe content="restored reply" sourceOpen animateOnMount={false} snapshots={snapshots} />
      )
    )
    expect(snapshots).toEqual([{ content: 'restored reply', presenting: true }])
    await renderProbe('restored reply', false)
    expect(snapshots.at(-1)).toEqual({ content: 'restored reply', presenting: false })
    expect(vi.getTimerCount()).toBe(0)
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

  it('does not mistake StrictMode initial effect replay for an Activity resume', async () => {
    await act(async () =>
      root.render(
        <StrictMode>
          <Probe content={'s'.repeat(1_000)} sourceOpen snapshots={snapshots} />
        </StrictMode>
      )
    )
    expect(snapshots.at(-1)).toEqual({ content: '', presenting: true })
    await advance(400)
    expect(snapshots.at(-1)?.content).toBe('')
  })

  it('keeps normal animation when content changes without an Activity reconnect', async () => {
    await renderProbe('o'.repeat(100))
    await advance(600)
    const partial = snapshots.at(-1)!.content
    expect(partial.length).toBeGreaterThan(0)
    expect(partial.length).toBeLessThan(100)

    await renderProbe('o'.repeat(120))
    expect(snapshots.at(-1)?.content).toBe(partial)
    await advance(16)
    expect(snapshots.at(-1)?.content).not.toBe('o'.repeat(120))
  })

  it('snaps hidden Activity backlog on reveal, then animates new chunks normally', async () => {
    await renderActivityProbe('a'.repeat(1_000), true, true)
    await advance(600)
    const beforeHide = snapshots.at(-1)!.content
    expect(beforeHide.length).toBeGreaterThan(0)
    expect(beforeHide.length).toBeLessThan(1_000)

    await renderActivityProbe('a'.repeat(1_000), true, false)
    await renderActivityProbe('a'.repeat(8_000), true, false)
    await advance(2_000)
    expect(snapshots.at(-1)?.content).toBe(beforeHide)

    await renderActivityProbe('a'.repeat(8_000), true, true)
    expect(snapshots.at(-1)).toEqual({ content: 'a'.repeat(8_000), presenting: true })

    await renderActivityProbe('a'.repeat(8_100), true, true)
    expect(snapshots.at(-1)?.content).toBe('a'.repeat(8_000))
    await advance(100)
    expect(snapshots.at(-1)?.content).not.toBe('a'.repeat(8_100))
  })

  it('shows the terminal hidden snapshot on every Activity reveal without stale timers', async () => {
    await renderActivityProbe('first', true, true)
    await advance(600)
    await renderActivityProbe('first', true, false)
    await renderActivityProbe('first terminal', false, false)
    await renderActivityProbe('first terminal', false, true)
    expect(snapshots.at(-1)).toEqual({ content: 'first terminal', presenting: false })

    await renderActivityProbe('first terminal', false, false)
    await renderActivityProbe('second terminal', false, false)
    await renderActivityProbe('second terminal', false, true)
    expect(snapshots.at(-1)).toEqual({ content: 'second terminal', presenting: false })
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

  it.each([
    { updates: 90, size: 2048 },
    { updates: 100, size: 4096 }
  ])(
    'keeps up with $updates sustained $size-code-unit chunks without oversized commits',
    async ({ updates, size }) => {
      const grapheme = '👩‍🔬e\u0301'
      const chunk = 'a'.repeat(size - grapheme.length) + grapheme
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      const chunkBoundaries = new Set([0])
      for (const { index, segment } of segmenter.segment(chunk)) {
        chunkBoundaries.add(index + segment.length)
      }
      let target = ''
      for (let index = 0; index < updates; index += 1) {
        target += chunk
        await renderProbe(target)
        await advance(30)
      }

      let catchUpFrames = 0
      while (snapshots.at(-1)?.content !== target && catchUpFrames < 250) {
        await advance(16)
        catchUpFrames += 1
      }

      expect(snapshots.at(-1)?.content.length).toBe(target.length)
      expect(snapshots.at(-1)?.content).toBe(target)
      expect(catchUpFrames * 16).toBeLessThan(4000)
      for (let index = 1; index < snapshots.length; index += 1) {
        const previous = snapshots[index - 1].content
        const current = snapshots[index].content
        expect(target.startsWith(current)).toBe(true)
        expect(current.startsWith(previous)).toBe(true)
        expect(chunkBoundaries.has(current.length % chunk.length)).toBe(true)
        const added = current.slice(previous.length)
        const graphemes = Array.from(segmenter.segment(added))
        expect(graphemes.length).toBeLessThanOrEqual(8192)
      }
    }
  )

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

  it('releases a closed source on the next frame when its final long-message batch is ready', async () => {
    const target = 'f'.repeat(8000)
    await renderProbe(target)
    await advance(500)

    let remaining = target.length
    for (let frame = 0; frame < 300 && remaining > 192; frame += 1) {
      await advance(16)
      remaining = target.length - (snapshots.at(-1)?.content.length ?? 0)
    }
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThanOrEqual(192)

    await renderProbe(target, false)
    expect(snapshots.at(-1)?.presenting).toBe(true)
    await advance(16)
    expect(snapshots.at(-1)).toEqual({ content: target, presenting: false })
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

  it('flushes a large pending presentation when the document becomes hidden', async () => {
    const target = 'e'.repeat(100_000)
    await renderProbe(target)
    await advance(600)
    expect(snapshots.at(-1)?.content).not.toBe(target)

    const visibilityState = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      await act(async () => document.dispatchEvent(new Event('visibilitychange')))
      expect(snapshots.at(-1)?.content).toBe(target)
    } finally {
      visibilityState.mockRestore()
    }
  })
})
