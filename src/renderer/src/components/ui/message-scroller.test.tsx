// @vitest-environment jsdom
import { act, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScrollerScrollable
} from './message-scroller'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | undefined
let root: Root | undefined

afterEach(() => {
  if (root) act(() => root?.unmount())
  container?.remove()
  vi.unstubAllGlobals()
  root = undefined
  container = undefined
})

describe('MessageScrollerItem', () => {
  it('reports provider follow intent across content growth and a reader scroll', async () => {
    const FollowProbe = (): React.JSX.Element => {
      const { end } = useMessageScrollerScrollable()
      return <output data-following={!end} />
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <MessageScrollerProvider autoScroll>
          <FollowProbe />
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent>
                <MessageScrollerItem messageId="reply">Reply</MessageScrollerItem>
              </MessageScrollerContent>
            </MessageScrollerViewport>
          </MessageScroller>
        </MessageScrollerProvider>
      )
    })
    const viewport = container.querySelector<HTMLElement>(
      '[data-slot="message-scroller-viewport"]'
    )!
    const probe = container.querySelector<HTMLElement>('output')!
    let scrollHeight = 200
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, writable: true, value: 100 }
    })
    await act(async () => viewport.dispatchEvent(new Event('scroll', { bubbles: true })))
    expect(probe.dataset.following).toBe('true')

    scrollHeight = 300
    await act(async () => viewport.dispatchEvent(new Event('scroll', { bubbles: true })))
    expect(probe.dataset.following).toBe('true')

    await act(async () => {
      viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }))
      viewport.scrollTop = 80
      viewport.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    expect(probe.dataset.following).toBe('false')

    viewport.scrollTop = 200
    await act(async () => viewport.dispatchEvent(new Event('scroll', { bubbles: true })))
    expect(probe.dataset.following).toBe('true')
  })

  it('contains stable rows while keeping mutable rows in normal paint flow', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <MessageScrollerProvider>
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent>
                <MessageScrollerItem messageId="stable-message">Stable message</MessageScrollerItem>
                <MessageScrollerItem messageId="streaming-message" disableContainment>
                  Streaming message
                </MessageScrollerItem>
              </MessageScrollerContent>
            </MessageScrollerViewport>
          </MessageScroller>
        </MessageScrollerProvider>
      )
    })

    const stableItem = container.querySelector<HTMLElement>("[data-message-id='stable-message']")
    const streamingItem = container.querySelector<HTMLElement>(
      "[data-message-id='streaming-message']"
    )
    expect(stableItem?.className).toContain('[content-visibility:auto]')
    expect(stableItem?.className).toContain('[contain-intrinsic-size:auto_10rem]')
    expect(streamingItem?.className).not.toContain('content-visibility')
    expect(streamingItem?.className).not.toContain('contain-intrinsic-size')
  })

  it('scrolls the viewport to the start from a start-direction button', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <MessageScrollerProvider>
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent>
                <MessageScrollerItem messageId="first-message">First message</MessageScrollerItem>
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton direction="start">First message</MessageScrollerButton>
          </MessageScroller>
        </MessageScrollerProvider>
      )
    })

    const viewport = container.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')
    const button = container.querySelector<HTMLButtonElement>(
      '[data-slot="message-scroller-button"]'
    )
    expect(viewport).not.toBeNull()
    expect(button).not.toBeNull()

    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 600 },
      scrollTop: { configurable: true, writable: true, value: 160 }
    })
    const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      if (typeof top === 'number' && viewport) viewport.scrollTop = top
    })
    Object.defineProperty(viewport, 'scrollTo', { configurable: true, value: scrollTo })

    await act(async () => viewport?.dispatchEvent(new Event('scroll', { bubbles: true })))
    expect(button?.dataset.active).toBe('true')

    await act(async () => button?.click())
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
  })

  it('does not rewrite unchanged scroll-state attributes while scrolling within the same range', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <MessageScrollerProvider>
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent>
                <MessageScrollerItem messageId="reply">Reply</MessageScrollerItem>
              </MessageScrollerContent>
            </MessageScrollerViewport>
          </MessageScroller>
        </MessageScrollerProvider>
      )
    })
    const viewport = container.querySelector<HTMLElement>(
      '[data-slot="message-scroller-viewport"]'
    )!
    const scroller = container.querySelector<HTMLElement>('[data-slot="message-scroller"]')!
    const item = container.querySelector<HTMLElement>('[data-message-id="reply"]')!
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 600 },
      scrollTop: { configurable: true, writable: true, value: 100 },
      getBoundingClientRect: { configurable: true, value: () => ({ top: 0, bottom: 100 }) }
    })
    Object.defineProperty(item, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: -viewport.scrollTop, bottom: 600 - viewport.scrollTop })
    })
    await act(async () => viewport.dispatchEvent(new Event('scroll', { bubbles: true })))
    expect(scroller.dataset.scrollable).toBe('start end')
    const changes: MutationRecord[] = []
    const observer = new MutationObserver((records) => changes.push(...records))
    for (const element of [scroller, viewport]) {
      observer.observe(element, {
        attributes: true,
        attributeFilter: ['data-scrollable', 'data-autoscrolling']
      })
    }
    try {
      for (const top of [120, 140, 160]) {
        viewport.scrollTop = top
        await act(async () => viewport.dispatchEvent(new Event('scroll', { bubbles: true })))
      }
      expect(changes).toHaveLength(0)
      // A real boundary change must still update both surfaces immediately.
      viewport.scrollTop = 500
      await act(async () => viewport.dispatchEvent(new Event('scroll', { bubbles: true })))
      expect(scroller.dataset.scrollable).toBe('start')
      expect(viewport.dataset.scrollable).toBe('start')
      expect(changes).toHaveLength(2)
    } finally {
      observer.disconnect()
    }
  })

  it('uses native scroll bounds without measuring content styles when no anchor spacer is visible', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <MessageScrollerProvider>
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent>
                <MessageScrollerItem messageId="reply">Reply</MessageScrollerItem>
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      )
    })
    const viewport = container.querySelector<HTMLElement>(
      '[data-slot="message-scroller-viewport"]'
    )!
    const content = container.querySelector<HTMLElement>('[data-slot="message-scroller-content"]')!
    const item = container.querySelector<HTMLElement>('[data-message-id="reply"]')!
    const button = container.querySelector<HTMLElement>('[data-slot="message-scroller-button"]')!
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 600 },
      scrollTop: { configurable: true, writable: true, value: 100 },
      getBoundingClientRect: { configurable: true, value: () => ({ top: 0, bottom: 100 }) }
    })
    let contentBottom = 600
    Object.defineProperty(item, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: -viewport.scrollTop, bottom: contentBottom - viewport.scrollTop })
    })
    const styles = vi.spyOn(window, 'getComputedStyle')
    try {
      await act(async () => viewport.dispatchEvent(new Event('scroll', { bubbles: true })))
      expect(button.dataset.active).toBe('true')
      viewport.scrollTop = 500
      await act(async () => viewport.dispatchEvent(new Event('scroll', { bubbles: true })))
      expect(button.dataset.active).toBe('false')
      expect(styles.mock.calls.filter(([element]) => element === content)).toHaveLength(0)
      // An active anchor spacer adds native scroll range that is not message content.
      const spacer = container.querySelector<HTMLElement>('[data-message-scroller-spacer]')!
      spacer.hidden = false
      contentBottom = 400
      viewport.scrollTop = 300
      await act(async () => viewport.dispatchEvent(new Event('scroll', { bubbles: true })))
      expect(button.dataset.active).toBe('false')
      expect(styles.mock.calls.some(([element]) => element === content)).toBe(true)
      spacer.hidden = true
      await act(async () => viewport.dispatchEvent(new Event('scroll', { bubbles: true })))
      expect(button.dataset.active).toBe('true')
    } finally {
      styles.mockRestore()
    }
  })

  it('hides the end button at the native scroll limit despite fractional layout geometry', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <MessageScrollerProvider>
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent>
                <MessageScrollerItem messageId="last-message">Last message</MessageScrollerItem>
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      )
    })

    const viewport = container.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')
    const item = container.querySelector<HTMLElement>('[data-message-id="last-message"]')
    const button = container.querySelector<HTMLButtonElement>(
      '[data-slot="message-scroller-button"]'
    )
    expect(viewport).not.toBeNull()
    expect(item).not.toBeNull()
    expect(button).not.toBeNull()

    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 100 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 0, bottom: 100, height: 100 })
      }
    })
    Object.defineProperty(item, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: -99.75, bottom: 100.25, height: 200 })
    })

    await act(async () => viewport?.dispatchEvent(new Event('scroll', { bubbles: true })))

    expect(viewport?.scrollTop).toBe(100)
    expect(button?.dataset.active).toBe('false')
  })

  it('releases bottom following for a small scrollbar drag before animated content grows', async () => {
    const resizeCallbacks = new Map<Element, ResizeObserverCallback>()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly callback: ResizeObserverCallback

        constructor(callback: ResizeObserverCallback) {
          this.callback = callback
        }

        observe(target: Element): void {
          resizeCallbacks.set(target, this.callback)
        }

        disconnect(): void {
          /* no-op */
        }
      }
    )

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <MessageScrollerProvider autoScroll>
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent>
                <MessageScrollerItem messageId="animated-tool-details">
                  Tool details
                </MessageScrollerItem>
              </MessageScrollerContent>
            </MessageScrollerViewport>
          </MessageScroller>
        </MessageScrollerProvider>
      )
    })

    const viewport = container.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')
    const content = container.querySelector<HTMLElement>('[data-slot="message-scroller-content"]')
    const item = container.querySelector<HTMLElement>('[data-message-id="animated-tool-details"]')
    expect(viewport).not.toBeNull()
    expect(content).not.toBeNull()
    expect(item).not.toBeNull()

    let contentHeight = 200
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, get: () => contentHeight },
      scrollTop: { configurable: true, writable: true, value: 100 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 0, bottom: 100, height: 100 })
      },
      scrollTo: {
        configurable: true,
        value: ({ top }: ScrollToOptions) => {
          if (typeof top === 'number' && viewport) viewport.scrollTop = top
        }
      }
    })
    Object.defineProperty(item, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: -(viewport?.scrollTop ?? 0),
        bottom: contentHeight - (viewport?.scrollTop ?? 0),
        height: contentHeight
      })
    })

    // Establish bottom-follow mode, then mimic a small scrollbar-thumb drag. Unlike a wheel event,
    // a scrollbar drag emits only `scroll`, so the scroller must notice the upward movement itself.
    await act(async () => viewport?.dispatchEvent(new Event('scroll', { bubbles: true })))
    if (viewport) viewport.scrollTop = 96
    await act(async () => viewport?.dispatchEvent(new Event('scroll', { bubbles: true })))

    // A tool expansion height tween keeps producing content resize frames after the reader moves.
    contentHeight = 240
    await act(async () => {
      resizeCallbacks.get(content!)?.([], {} as ResizeObserver)
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })

    expect(viewport?.scrollTop).toBe(96)
  })

  it('hides the end button at the bottom when fractional content height rounds down', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <MessageScrollerProvider>
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent>
                <MessageScrollerItem messageId="fractional-message">
                  Fractional message
                </MessageScrollerItem>
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      )
    })

    const viewport = container.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')
    const item = container.querySelector<HTMLElement>('[data-message-id="fractional-message"]')
    const button = container.querySelector<HTMLButtonElement>(
      '[data-slot="message-scroller-button"]'
    )
    expect(viewport).not.toBeNull()
    expect(item).not.toBeNull()
    expect(button).not.toBeNull()

    // The browser clamps scrollTop to the integer scrollHeight - clientHeight, while the
    // scroller derives the content bottom from fractional layout rects. A fractional content
    // height that rounds down must not keep the end state active once scrolled to the bottom.
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 100 }
    })
    Object.defineProperty(item, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: -(viewport?.scrollTop ?? 0),
        bottom: 200.5 - (viewport?.scrollTop ?? 0),
        height: 200.5
      })
    })

    await act(async () => viewport?.dispatchEvent(new Event('scroll', { bubbles: true })))
    expect(button?.dataset.active).toBe('false')

    // A sub-pixel move beyond the 0.5px edge threshold is still detected (#2007, #2145).
    if (viewport) viewport.scrollTop = 99.4
    await act(async () => viewport?.dispatchEvent(new Event('scroll', { bubbles: true })))
    expect(button?.dataset.active).toBe('true')
  })

  it('resumes bottom following when scrolled back to a fractionally rounded bottom', async () => {
    const resizeCallbacks = new Map<Element, ResizeObserverCallback>()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly callback: ResizeObserverCallback

        constructor(callback: ResizeObserverCallback) {
          this.callback = callback
        }

        observe(target: Element): void {
          resizeCallbacks.set(target, this.callback)
        }

        disconnect(): void {
          /* no-op */
        }
      }
    )

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <MessageScrollerProvider autoScroll>
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent>
                <MessageScrollerItem messageId="streaming-message">
                  Streaming message
                </MessageScrollerItem>
              </MessageScrollerContent>
            </MessageScrollerViewport>
          </MessageScroller>
        </MessageScrollerProvider>
      )
    })

    const viewport = container.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')
    const content = container.querySelector<HTMLElement>('[data-slot="message-scroller-content"]')
    const item = container.querySelector<HTMLElement>('[data-message-id="streaming-message"]')
    expect(viewport).not.toBeNull()
    expect(content).not.toBeNull()
    expect(item).not.toBeNull()

    // Fractional layout height rounds down to the integer scrollHeight; the reader lands on the
    // clamped integer maximum when scrolling back to the bottom.
    let contentHeight = 200
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, get: () => contentHeight },
      scrollTop: { configurable: true, writable: true, value: 100 },
      scrollTo: {
        configurable: true,
        value: ({ top }: ScrollToOptions) => {
          if (typeof top === 'number' && viewport) viewport.scrollTop = top
        }
      }
    })
    Object.defineProperty(item, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: -(viewport?.scrollTop ?? 0),
        bottom: contentHeight + 0.5 - (viewport?.scrollTop ?? 0),
        height: contentHeight + 0.5
      })
    })

    // Establish following at the bottom, scroll up to release it, then return to the clamped
    // bottom.
    await act(async () => viewport?.dispatchEvent(new Event('scroll', { bubbles: true })))
    if (viewport) viewport.scrollTop = 90
    await act(async () => viewport?.dispatchEvent(new Event('scroll', { bubbles: true })))
    if (viewport) viewport.scrollTop = 100
    await act(async () => viewport?.dispatchEvent(new Event('scroll', { bubbles: true })))

    // Streaming growth must follow again from the bottom instead of staying paused.
    contentHeight = 240
    await act(async () => {
      resizeCallbacks.get(content!)?.([], {} as ResizeObserver)
    })

    expect(viewport?.scrollTop).toBe(140)
  })

  it('applies the bottom-follow correction synchronously when content resizes', async () => {
    const resizeCallbacks = new Map<Element, ResizeObserverCallback>()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly callback: ResizeObserverCallback

        constructor(callback: ResizeObserverCallback) {
          this.callback = callback
        }

        observe(target: Element): void {
          resizeCallbacks.set(target, this.callback)
        }

        disconnect(): void {
          /* no-op */
        }
      }
    )

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <MessageScrollerProvider autoScroll>
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent>
                <MessageScrollerItem messageId="streaming-message">
                  Streaming message
                </MessageScrollerItem>
              </MessageScrollerContent>
            </MessageScrollerViewport>
          </MessageScroller>
        </MessageScrollerProvider>
      )
    })

    const viewport = container.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')
    const content = container.querySelector<HTMLElement>('[data-slot="message-scroller-content"]')
    const item = container.querySelector<HTMLElement>('[data-message-id="streaming-message"]')
    expect(viewport).not.toBeNull()
    expect(content).not.toBeNull()
    expect(item).not.toBeNull()

    let contentHeight = 200
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, get: () => contentHeight },
      scrollTop: { configurable: true, writable: true, value: 100 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 0, bottom: 100, height: 100 })
      },
      scrollTo: {
        configurable: true,
        value: ({ top }: ScrollToOptions) => {
          if (typeof top === 'number' && viewport) viewport.scrollTop = top
        }
      }
    })
    Object.defineProperty(item, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: -(viewport?.scrollTop ?? 0),
        bottom: contentHeight - (viewport?.scrollTop ?? 0),
        height: contentHeight
      })
    })

    await act(async () => viewport?.dispatchEvent(new Event('scroll', { bubbles: true })))

    // A line wrap during streaming grows the content while pinned to the bottom. The follow
    // correction must land in the same frame as the resize — waiting one rAF paints a stale frame.
    contentHeight = 240
    await act(async () => {
      resizeCallbacks.get(content!)?.([], {} as ResizeObserver)
    })

    expect(viewport?.scrollTop).toBe(140)
  })

  it('keeps following after a reader clicks Scroll to end and the measured tail grows', async () => {
    const resizeCallbacks = new Map<Element, ResizeObserverCallback>()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly callback: ResizeObserverCallback

        constructor(callback: ResizeObserverCallback) {
          this.callback = callback
        }

        observe(target: Element): void {
          resizeCallbacks.set(target, this.callback)
        }

        disconnect(): void {
          /* no-op */
        }
      }
    )

    const ReaderScroller = (): React.JSX.Element => {
      const [autoScroll, setAutoScroll] = useState(false)
      return (
        <MessageScrollerProvider autoScroll={autoScroll}>
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent>
                <MessageScrollerItem messageId="long-reply">Long reply</MessageScrollerItem>
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton
              onClick={() => {
                // WorkspaceMessageScroller restores this before the primitive scrollToEnd runs.
                flushSync(() => setAutoScroll(true))
              }}
            />
          </MessageScroller>
        </MessageScrollerProvider>
      )
    }

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root?.render(<ReaderScroller />))

    const viewport = container.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')
    const content = container.querySelector<HTMLElement>('[data-slot="message-scroller-content"]')
    const button = container.querySelector<HTMLButtonElement>(
      '[data-slot="message-scroller-button"]'
    )
    const item = container.querySelector<HTMLElement>('[data-message-id="long-reply"]')
    expect(viewport).not.toBeNull()
    expect(content).not.toBeNull()
    expect(button).not.toBeNull()
    expect(item).not.toBeNull()

    let contentHeight = 200
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, get: () => contentHeight },
      scrollTop: { configurable: true, writable: true, value: 20 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 0, bottom: 100, height: 100 })
      },
      scrollTo: {
        configurable: true,
        value: ({ top }: ScrollToOptions) => {
          if (typeof top === 'number' && viewport) viewport.scrollTop = top
        }
      }
    })
    Object.defineProperty(item, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: -(viewport?.scrollTop ?? 0),
        bottom: contentHeight - (viewport?.scrollTop ?? 0),
        height: contentHeight
      })
    })
    await act(async () => viewport?.dispatchEvent(new Event('scroll', { bubbles: true })))
    await act(async () => button?.click())
    expect(viewport?.scrollTop).toBe(100)

    // Rich content can replace its intrinsic-size estimate after the click.
    contentHeight = 240
    await act(async () => resizeCallbacks.get(content!)?.([], {} as ResizeObserver))
    expect(viewport?.scrollTop).toBe(140)
  })
})
