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
