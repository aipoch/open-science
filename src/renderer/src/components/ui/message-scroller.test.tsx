// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport
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
})
