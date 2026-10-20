// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareReplayFrame } from './replay-readiness'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const frameScheduler = (): (() => void) => {
  const callbacks: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.push(callback)
    return callbacks.length
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  return () => callbacks.splice(0).forEach((callback) => callback(0))
}

describe('replay frame resource barrier', () => {
  it('waits for image decoding and the committed layout before allowing capture', async () => {
    const layout = frameScheduler()
    const root = document.createElement('div')
    const img = document.createElement('img')
    Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 1280 } })
    let decoded!: () => void
    img.decode = () => new Promise<void>((resolve) => (decoded = resolve))
    root.append(img)
    let ready = false
    const preparation = prepareReplayFrame(root).then((value) => {
      ready = true
      return value
    })
    layout()
    expect(ready).toBe(false)
    decoded()
    await Promise.resolve()
    expect(ready).toBe(false)
    layout()
    expect(await preparation).toEqual({ ready: true, degraded: false, diagnostics: [] })
  })

  it('settles unavailable images and stalled resources with explicit diagnostics', async () => {
    vi.useFakeTimers()
    const layout = frameScheduler()
    const root = document.createElement('div')
    const broken = document.createElement('img')
    broken.dataset.replayResourceId = 'version-a'
    const slow = document.createElement('img')
    slow.dataset.replayResourceId = 'version-b'
    Object.defineProperty(slow, 'complete', { value: false })
    root.append(broken, slow)
    const preparation = prepareReplayFrame(root, { timeoutMs: 50 })
    layout()
    await vi.advanceTimersByTimeAsync(50)
    expect(await preparation).toEqual({
      ready: true,
      degraded: true,
      diagnostics: ['unavailable:image:version-a', 'timeout:image:version-b']
    })
    vi.useRealTimers()
  })

  it('never publishes a ready frame after a source switch aborts preparation', async () => {
    const layout = frameScheduler()
    const root = document.createElement('div')
    const controller = new AbortController()
    const preparation = prepareReplayFrame(root, { signal: controller.signal })
    controller.abort()
    layout()
    expect((await preparation).ready).toBe(false)
  })
})
