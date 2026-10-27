// @vitest-environment jsdom
import { act, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  useMessageScroller,
  MessageScrollerButton
} from './message-scroller'
import { useTranscriptWindow } from '../../pages/workspace/use-transcript-window'
import type { WorkspaceConversationTimelineItem } from '../../pages/workspace/workspace-conversation-timeline'
import {
  TranscriptEndSync,
  MessageScrollerFollowIntent
} from '../../pages/workspace/TranscriptEndSync'

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

// Exercise the production window and scroller together, including native scroll event ordering.
const WindowedTranscript = ({ count }: { count: number }): React.JSX.Element => {
  const viewport = useRef<HTMLDivElement>(null)
  const previousTop = useRef(0)
  const [paused, setPaused] = useState(false)
  const items = useMemo(
    () =>
      Array.from(
        { length: count },
        (_, index) =>
          ({
            id: `row-${index}`,
            type: 'message',
            message: { id: `row-${index}` }
          }) as WorkspaceConversationTimelineItem
      ),
    [count]
  )
  const window = useTranscriptWindow('long-session', items, -1, viewport, paused)
  return (
    <>
      <MessageScrollerViewport
        ref={viewport}
        onScroll={() => {
          window.expandAtScrollEdge(previousTop.current)
          previousTop.current = viewport.current!.scrollTop
        }}
      >
        <MessageScrollerContent>
          {window.entries.map(({ item }) => (
            <MessageScrollerItem key={item.id} messageId={item.id}>
              History
            </MessageScrollerItem>
          ))}
        </MessageScrollerContent>
      </MessageScrollerViewport>
      <TranscriptEndSync
        scopeId="long-session"
        itemCount={count}
        mountedItemCount={window.entries.length}
        following={window.isFollowingEnd}
      />
      <MessageScrollerFollowIntent active onPauseChange={setPaused} />
      <MessageScrollerButton behavior="instant" onClick={() => window.followEnd()} />
    </>
  )
}
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  vi.unstubAllGlobals()
})

async function setup(
  initiallyEmpty = false,
  onFollowChange?: (following: boolean) => void,
  windowed = false
): Promise<{
  viewport: HTMLElement
  resize: (next: number) => Promise<void>
  scroll: () => Promise<void>
  setHeight: (height: number) => void
  render: (showTool: boolean, totalItems?: number) => Promise<void>
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
  const render = async (showTool: boolean, totalItems = 80): Promise<void> => {
    await act(async () =>
      root!.render(
        <MessageScrollerProvider autoScroll>
          <Controls />
          <MessageScroller>
            {windowed ? (
              <WindowedTranscript count={totalItems} />
            ) : (
              <>
                <MessageScrollerViewport>
                  <MessageScrollerContent>
                    {onFollowChange &&
                      Array.from({ length: 79 }, (_, index) => (
                        <MessageScrollerItem
                          key={totalItems - index}
                          messageId={`row-${totalItems - index}`}
                        >
                          History
                        </MessageScrollerItem>
                      ))}
                    {showTool && <MessageScrollerItem messageId="tool">Tool</MessageScrollerItem>}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                {onFollowChange && (
                  <>
                    <TranscriptEndSync
                      scopeId="long-session"
                      itemCount={totalItems}
                      mountedItemCount={80}
                      following
                    />
                    <MessageScrollerFollowIntent active onChange={onFollowChange} />
                  </>
                )}
              </>
            )}
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

it('keeps a collapse pause through a bounded tail replacement and subsequent streaming', async () => {
  const followChanges: boolean[] = []
  const { viewport, scroll, resize, render } = await setup(false, (value) =>
    followChanges.push(value)
  )
  await resize(1000)
  viewport.scrollTop = 880
  await scroll()
  await act(async () => api.stopAutoScroll())
  // Collapsing removes 160px and clamps the reader onto the new bottom.
  await resize(840)
  expect(viewport.scrollTop).toBe(740)
  // The bounded tail replaces a row without changing its count or current height.
  await render(true, 81)
  await resize(940)
  expect(viewport.scrollTop).toBe(740)
  expect(followChanges.at(-1)).toBe(false)
  // Explicit user navigation still resumes both synchronization layers.
  await act(async () => api.scrollToEnd({ behavior: 'instant' }))
  await render(true, 82)
  await resize(1040)
  expect(viewport.scrollTop).toBe(940)
  expect(followChanges.at(-1)).toBe(true)
})

it.each(['button', 'button-at-bottom', 'scrollbar'] as const)(
  'preserves the actual long-session window while paused and resumes it with the %s',
  async (input) => {
    const { viewport, scroll, resize, render } = await setup(false, undefined, true)
    await render(true, 100)
    await resize(1000)
    viewport.scrollTop = 880
    await scroll()
    const mounted = (): string[] =>
      [...viewport.querySelectorAll<HTMLElement>('[data-message-id]')].map(
        (e) => e.dataset.messageId!
      )
    expect(mounted()[0]).toBe('row-20')
    await act(async () => api.stopAutoScroll())
    await resize(840)
    await render(true, 101)
    if (input !== 'button-at-bottom') await resize(940)
    expect(viewport.scrollTop).toBe(740)
    expect(mounted()).toHaveLength(80)
    expect(mounted()[0]).toBe('row-20')
    expect(mounted().at(-1)).toBe('row-99')
    if (input !== 'scrollbar') {
      expect(container.querySelector('button')?.getAttribute('data-active')).toBe('true')
      await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
    } else {
      viewport.scrollTop = 840
      await scroll()
    }
    await render(true, 102)
    await resize(1040)
    expect(mounted().at(-1)).toBe('row-101')
    expect(viewport.scrollTop).toBe(940)
  }
)
