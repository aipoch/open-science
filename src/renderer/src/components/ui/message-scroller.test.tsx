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

let container: HTMLDivElement | undefined
let root: Root | undefined

afterEach(() => {
  if (root) act(() => root?.unmount())
  container?.remove()
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
})
