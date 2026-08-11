// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import {
  MessageScroller,
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
})
