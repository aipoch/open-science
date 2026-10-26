// @vitest-environment jsdom
import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  useMessageScroller
} from './message-scroller'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let container: HTMLDivElement
let api: ReturnType<typeof useMessageScroller>
function Controls(): null {
  const controls = useMessageScroller()
  useLayoutEffect(() => {
    api = controls
  }, [controls])
  return null
}
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  vi.unstubAllGlobals()
})

async function setup(initiallyEmpty = false): Promise<{
  viewport: HTMLElement
  resize: (next: number) => Promise<void>
  scroll: () => Promise<void>
  setHeight: (height: number) => void
  render: (showTool: boolean) => Promise<void>
}> {
  const observers = new Map<Element, ResizeObserverCallback>()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(element: Element): void {
        observers.set(element, this.callback)
      }
      disconnect(): void {
        /* The fixture owns all observers. */
      }
    }
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const render = async (showTool: boolean): Promise<void> => {
    await act(async () =>
      root!.render(
        <MessageScrollerProvider autoScroll>
          <Controls />
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent>
                {showTool && <MessageScrollerItem messageId="tool">Tool</MessageScrollerItem>}
              </MessageScrollerContent>
            </MessageScrollerViewport>
          </MessageScroller>
        </MessageScrollerProvider>
      )
    )
  }
  await render(!initiallyEmpty)
  const viewport = container.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')!
  const content = container.querySelector<HTMLElement>('[data-slot="message-scroller-content"]')!
  let height = 500
  Object.defineProperties(viewport, {
    clientHeight: { value: 100 },
    scrollHeight: { get: () => height },
    scrollTop: { writable: true, value: 380 },
    getBoundingClientRect: { value: () => ({ top: 0, bottom: 100, height: 100 }) },
    scrollTo: {
      value: ({ top }: ScrollToOptions) => {
        viewport.scrollTop = top!
      }
    }
  })
  const scroll = async (): Promise<void> => {
    await act(async () => viewport.dispatchEvent(new Event('scroll', { bubbles: true })))
  }
  const resize = async (next: number): Promise<void> => {
    height = next
    // Model the browser's range clamp, which jsdom does not perform.
    viewport.scrollTop = Math.min(viewport.scrollTop, height - 100)
    await scroll()
    await act(async () => {
      observers.get(content)!([], {} as ResizeObserver)
      await new Promise(requestAnimationFrame)
    })
  }
  await scroll()
  return {
    viewport,
    render,
    resize,
    scroll,
    setHeight: (next: number): void => {
      height = next
    }
  }
}

it('pauses at the current position across shrink-to-bottom and subsequent streaming growth', async () => {
  const { viewport, resize } = await setup()
  await act(async () => api.stopAutoScroll())
  expect(viewport.scrollTop).toBe(380)
  await resize(450)
  expect(viewport.scrollTop).toBe(350)
  await resize(600)
  expect(viewport.scrollTop).toBe(350)
})

it.each(['button', 'wheel', 'keyboard', 'touch', 'scrollbar'] as const)(
  'resumes following after deliberate %s navigation to the bottom',
  async (input) => {
    const { viewport, resize, scroll } = await setup()
    await act(async () => api.stopAutoScroll())
    await resize(600)
    expect(viewport.scrollTop).toBe(380)
    await act(async () => {
      if (input === 'button') api.scrollToEnd({ behavior: 'instant' })
      else {
        if (input === 'wheel')
          viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }))
        if (input === 'keyboard')
          viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
        if (input === 'touch') viewport.dispatchEvent(new Event('touchmove', { bubbles: true }))
        viewport.scrollTop = 500
      }
    })
    await scroll()
    await resize(700)
    expect(viewport.scrollTop).toBe(600)
  }
)

it('pauses bottom following before expansion without moving the viewport', async () => {
  const { viewport, resize } = await setup()
  await act(async () => api.scrollToEnd({ behavior: 'instant' }))
  expect(viewport.scrollTop).toBe(400)
  await act(async () => api.stopAutoScroll())
  await resize(700)
  expect(viewport.scrollTop).toBe(400)
})

it('resumes a scrollbar arrival even if streaming changes height before its scroll event', async () => {
  const { viewport, setHeight, scroll, resize } = await setup()
  await act(async () => api.stopAutoScroll())
  setHeight(600)
  viewport.scrollTop = 500
  await scroll()
  await resize(700)
  expect(viewport.scrollTop).toBe(600)
})

it('suspends native anchoring during repeated toggles and restores the caller style on navigation', async () => {
  const { viewport } = await setup()
  viewport.style.overflowAnchor = 'auto'
  await act(async () => api.stopAutoScroll())
  expect(viewport.style.overflowAnchor).toBe('none')
  await act(async () => api.stopAutoScroll())
  await act(async () => api.scrollToEnd({ behavior: 'instant' }))
  await act(async () => {
    await new Promise(requestAnimationFrame)
  })
  expect(viewport.style.overflowAnchor).toBe('auto')
})

it('cancels queued navigation and initial following when paused before the first message mounts', async () => {
  const { viewport, render, resize } = await setup(true)
  await act(async () => {
    api.scrollToMessage('tool', { align: 'start' })
    api.stopAutoScroll()
  })
  await render(true)
  await act(async () => {
    await new Promise(requestAnimationFrame)
  })
  expect(viewport.scrollTop).toBe(380)
  await resize(700)
  expect(viewport.scrollTop).toBe(380)
})
