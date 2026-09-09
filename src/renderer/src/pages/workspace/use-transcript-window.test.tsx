// @vitest-environment jsdom
import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'

import { useTranscriptWindow } from './use-transcript-window'
import type { WorkspaceConversationTimelineItem } from './workspace-conversation-timeline'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const items = Array.from(
  { length: 120 },
  (_, index) =>
    ({
      id: `message-${index + 1}`,
      type: 'message',
      message: { id: `message-${index + 1}` }
    }) as WorkspaceConversationTimelineItem
)

describe('useTranscriptWindow', () => {
  it.each(['none', 'selection', 'focus'] as const)(
    'PERF-03 bounds reading after releasing %s without moving the reading anchor',
    (pin) => {
      const viewport = document.createElement('div')
      document.body.appendChild(viewport)
      const root = createRoot(viewport)
      const rows = Array.from({ length: 1000 }, (_, index) => ({
        id: `row-${index}`,
        type: 'message',
        message: { id: `row-${index}` }
      })) as WorkspaceConversationTimelineItem[]
      Object.defineProperties(viewport, {
        clientHeight: { value: 400 },
        scrollHeight: { get: () => viewport.childElementCount * 20 }
      })
      viewport.getBoundingClientRect = () => ({ top: 100, bottom: 500 }) as DOMRect
      viewport.scrollTo = (options) => {
        viewport.scrollTop = (options as ScrollToOptions).top ?? 0
      }
      let current!: ReturnType<typeof useTranscriptWindow>
      const Harness = (): React.JSX.Element => {
        current = useTranscriptWindow('large', rows, -1, { current: viewport })
        return (
          <>
            {current.entries.map(({ item }) => (
              <div
                key={item.id}
                data-message-id={item.id}
                ref={(node) => {
                  if (node)
                    node.getBoundingClientRect = () => {
                      const top =
                        100 + Array.from(viewport.children).indexOf(node) * 20 - viewport.scrollTop
                      return { top, bottom: top + 20 } as DOMRect
                    }
                }}
              >
                {item.id}
              </div>
            ))}
          </>
        )
      }
      const expand = (direction: 'up' | 'down', bounded = true): void => {
        viewport.scrollTop = direction === 'up' ? 0 : viewport.scrollHeight - 400
        const anchor = Array.from(viewport.children).find(
          (node) => node.getBoundingClientRect().bottom > 100
        )!
        const id = (anchor as HTMLElement).dataset.messageId
        const top = anchor.getBoundingClientRect().top
        act(() => current.expandAtScrollEdge(direction === 'up' ? 100 : 0))
        if (bounded) expect(viewport.childElementCount).toBeLessThanOrEqual(160)
        const retained = viewport.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
        expect(retained).not.toBeNull()
        expect(retained!.getBoundingClientRect().top).toBe(top)
      }
      try {
        act(() => root.render(<Harness />))
        expect(viewport.childElementCount).toBe(80)
        if (pin !== 'none') {
          const pinned = viewport.lastElementChild as HTMLElement
          if (pin === 'selection') {
            const range = document.createRange()
            range.selectNodeContents(pinned)
            document.getSelection()!.addRange(range)
          } else {
            pinned.tabIndex = 0
            pinned.focus()
          }
          for (let i = 0; i < 3; i++) expand('up', false)
          expect(pinned.isConnected).toBe(true)
          if (pin === 'selection') {
            expect(document.getSelection()!.toString()).toBe('row-999')
            document.getSelection()!.removeAllRanges()
          } else {
            expect(document.activeElement).toBe(pinned)
            pinned.blur()
          }
        }
        for (let i = 0; i < 12; i++) expand('up')
        expect(current.entries[0].item.id).toBe('row-0')
        for (let i = 0; i < 12; i++) expand('down')
        expect(current.entries.at(-1)?.item.id).toBe('row-999')
      } finally {
        act(() => root.unmount())
        viewport.remove()
      }
    }
  )

  it('keeps the full transcript mounted when revealing a run during whole-window find', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const result = {
      current: undefined as unknown as ReturnType<typeof useTranscriptWindow>
    }
    const HookHarness = (): null => {
      result.current = useTranscriptWindow('session-1', items, -1, createRef())
      return null
    }

    act(() => root.render(<HookHarness />))
    expect(result.current.entries).toHaveLength(80)

    act(() => result.current.revealAll())
    expect(result.current.entries).toHaveLength(120)

    act(() => result.current.revealMessage('message-1'))
    expect(result.current.entries).toHaveLength(120)

    act(() => root.unmount())
  })

  it('bounds items arriving after an empty session mounts', () => {
    const root = createRoot(document.createElement('div'))
    const ref = createRef<HTMLDivElement>()
    let current!: ReturnType<typeof useTranscriptWindow>
    const Harness = ({ rows }: { rows: typeof items }): null => {
      current = useTranscriptWindow('empty-session', rows, -1, ref)
      return null
    }
    act(() => root.render(<Harness rows={[]} />))
    expect(current.entries).toHaveLength(0)
    act(() => root.render(<Harness rows={items} />))
    expect(current.entries).toHaveLength(80)
    expect(current.entries[0].item.id).toBe('message-41')
    expect(current.entries.at(-1)?.item.id).toBe('message-120')
    expect(current.isFollowingEnd).toBe(true)
    act(() => root.unmount())
  })

  it('keeps an explicit end selection when find closes', () => {
    const root = createRoot(document.createElement('div'))
    const ref = createRef<HTMLDivElement>()
    let current!: ReturnType<typeof useTranscriptWindow>
    const Harness = ({ rows = items }: { rows?: typeof items }): null => {
      current = useTranscriptWindow('session', rows, -1, ref)
      return null
    }
    act(() => root.render(<Harness />))
    act(() => current.revealAll())
    act(() => current.revealMessage('message-1'))
    act(() => current.followEnd())
    // The owner keeps whole-window find mounted until its hide event arrives.
    act(() => current.revealAll())
    act(() => current.restoreWindow())
    expect(current.isFollowingEnd).toBe(true)
    const appended = [
      ...items,
      {
        id: 'latest',
        type: 'message',
        message: { id: 'latest' }
      } as WorkspaceConversationTimelineItem
    ]
    act(() => root.render(<Harness rows={appended} />))
    expect(current.entries).toHaveLength(80)
    expect(current.entries.at(-1)?.item.id).toBe('latest')
    act(() => root.unmount())
  })

  it('honors find scrolling after an explicit end selection settles', () => {
    const root = createRoot(document.createElement('div'))
    const viewport = document.createElement('div')
    Object.defineProperties(viewport, {
      clientHeight: { value: 800 },
      scrollHeight: { value: 10000 }
    })
    viewport.getBoundingClientRect = () => ({ top: 100, bottom: 900 }) as DOMRect
    const ref = { current: viewport }
    let current!: ReturnType<typeof useTranscriptWindow>
    const Harness = (): null => {
      current = useTranscriptWindow('session', items, -1, ref)
      return null
    }
    act(() => root.render(<Harness />))
    act(() => current.revealAll())
    act(() => current.followEnd())
    act(() => current.revealAll())
    viewport.scrollTop = 9200
    act(() => current.expandAtScrollEdge(0))
    const match = document.createElement('div')
    match.dataset.messageId = 'message-1'
    match.getBoundingClientRect = () => ({ top: 108, bottom: 208 }) as DOMRect
    viewport.appendChild(match)
    // Text find scrolls programmatically; no wheel or key event reaches the transcript viewport.
    viewport.scrollTop = 500
    act(() => current.expandAtScrollEdge(9200))
    act(() => current.restoreWindow())
    expect(current.isFollowingEnd).toBe(false)
    expect(current.entries[0].item.id).toBe('message-1')
    act(() => root.unmount())
  })

  it('keeps a stable reading row through insertions, resumes following, and resets scope', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const viewport = document.createElement('div')
    Object.defineProperties(viewport, {
      clientHeight: { value: 800 },
      scrollHeight: { value: 10000 },
      scrollTop: { writable: true, value: 5000 }
    })
    viewport.getBoundingClientRect = () => ({ top: 100, bottom: 900 }) as DOMRect
    const readingNode = document.createElement('div')
    readingNode.dataset.messageId = 'message-81'
    readingNode.getBoundingClientRect = () => ({ top: 108, bottom: 208 }) as DOMRect
    viewport.appendChild(readingNode)
    const ref = { current: viewport }
    let current!: ReturnType<typeof useTranscriptWindow>
    const Harness = ({ scope, rows }: { scope: string; rows: typeof items }): null => {
      current = useTranscriptWindow(scope, rows, -1, ref)
      return null
    }
    const render = (scope: string, rows = items): void =>
      act(() => root.render(<Harness scope={scope} rows={rows} />))
    render('session:branch-a')
    act(() => current.expandAtScrollEdge(9000))
    const originalIds = current.entries.map(({ item }) => item.id)
    const inserted = [
      {
        id: 'inserted',
        type: 'message',
        message: { id: 'inserted' }
      } as WorkspaceConversationTimelineItem,
      ...items
    ]
    render('session:branch-a', inserted)
    expect(current.entries.map(({ item }) => item.id)).toEqual(originalIds)
    const interleaved = [
      ...inserted.slice(0, 60),
      ...Array.from(
        { length: 100 },
        (_, index) =>
          ({
            id: `late-${index}`,
            type: 'message',
            message: { id: `late-${index}` }
          }) as WorkspaceConversationTimelineItem
      ),
      ...inserted.slice(60)
    ]
    render('session:branch-a', interleaved)
    expect(current.entries.some(({ item }) => item.id === 'message-81')).toBe(true)
    act(() => current.followEnd())
    const appended = [
      ...inserted,
      {
        id: 'appended',
        type: 'message',
        message: { id: 'appended' }
      } as WorkspaceConversationTimelineItem
    ]
    render('session:branch-a', appended)
    expect(current.entries.at(-1)?.item.id).toBe('appended')
    act(() => current.revealAll())
    act(() => current.revealMessage('message-1'))
    render('session:branch-b', appended)
    act(() => current.restoreWindow())
    expect(current.entries).toHaveLength(80)
    expect(current.entries.at(-1)?.item.id).toBe('appended')
    expect(current.entries.some(({ item }) => item.id === 'message-1')).toBe(false)
    render('another-session:branch-a', appended)
    expect(current.entries).toHaveLength(80)
    render('session:branch-a', appended)
    expect(current.entries.some(({ item }) => item.id === 'message-1')).toBe(false)
    expect(current.entries.at(-1)?.item.id).toBe('appended')
    act(() => root.unmount())
  })

  it.each([false, true])(
    'keeps a find navigation target unless manually scrolled afterwards: %s',
    (manualScroll) => {
      const container = document.createElement('div')
      const root = createRoot(container)
      const viewport = document.createElement('div')
      viewport.getBoundingClientRect = () => ({ top: 100, bottom: 900 }) as DOMRect
      const visible = document.createElement('div')
      visible.dataset.messageId = 'message-1'
      visible.getBoundingClientRect = () => ({ top: 108, bottom: 208 }) as DOMRect
      const ref = { current: viewport }
      let current!: ReturnType<typeof useTranscriptWindow>
      const Harness = (): null => {
        current = useTranscriptWindow('session', items, -1, ref)
        return null
      }
      act(() => root.render(<Harness />))
      act(() => current.revealAll())
      act(() => current.revealMessage('message-100'))
      // Simulate an intermediate native scroll position before the selected run has arrived.
      viewport.appendChild(visible)
      viewport.scrollTop = 500
      if (manualScroll) act(() => current.recordUserScroll())
      act(() => current.restoreWindow())
      expect(
        current.entries.some(({ item }) => item.id === (manualScroll ? 'message-1' : 'message-100'))
      ).toBe(true)
      expect(
        current.entries.some(({ item }) => item.id === (manualScroll ? 'message-100' : 'message-1'))
      ).toBe(false)
      act(() => root.unmount())
    }
  )

  it('shrinks find around the visible old row with its viewport offset', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const viewport = document.createElement('div')
    viewport.getBoundingClientRect = () => ({ top: 100, bottom: 900 }) as DOMRect
    viewport.scrollTo = (options?: ScrollToOptions | number, y?: number): void => {
      viewport.scrollTop = typeof options === 'number' ? (y ?? 0) : (options?.top ?? 0)
    }
    const target = document.createElement('div')
    target.dataset.messageId = 'message-1'
    // Only the current visible row is observable; other rows are outside the mocked viewport.
    let targetTop = 108
    target.getBoundingClientRect = () => ({ top: targetTop, bottom: targetTop + 100 }) as DOMRect
    const ref = { current: viewport }
    let current!: ReturnType<typeof useTranscriptWindow>
    const Harness = ({ rows = items }: { rows?: typeof items }): null => {
      current = useTranscriptWindow('session:branch', rows, -1, ref)
      return null
    }
    act(() => root.render(<Harness />))
    act(() => current.revealAll())
    viewport.appendChild(target)
    viewport.scrollTop = 500
    act(() => current.expandAtScrollEdge(9000))
    act(() => current.restoreWindow())
    expect(current.entries[0].item.id).toBe('message-1')
    expect(current.entries).toHaveLength(80)
    expect(viewport.scrollTop).toBe(500)
    // A prepend changes DOM geometry; the saved relative offset remains 8 pixels.
    targetTop = 208
    act(() => root.render(<Harness rows={[...items]} />))
    expect(viewport.scrollTop).toBe(600)
    act(() => root.unmount())
  })

  it('keeps config-change dividers behind the presentation barrier with their owning message', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const timeline = [
      { id: 'message-1', type: 'message' },
      { id: 'message-2', type: 'message' },
      { id: 'session-config-change-message-3', type: 'session-config-change' },
      { id: 'message-3', type: 'message' },
      { id: 'activity-1', type: 'activity' }
    ] as WorkspaceConversationTimelineItem[]
    const result = {
      current: undefined as unknown as ReturnType<typeof useTranscriptWindow>
    }
    const HookHarness = (): null => {
      result.current = useTranscriptWindow('session-1', timeline, 1, createRef())
      return null
    }

    act(() => root.render(<HookHarness />))
    expect(result.current.entries.map((entry) => entry.item.id)).toEqual([
      'message-1',
      'message-2',
      'activity-1'
    ])

    act(() => root.unmount())
  })
})
