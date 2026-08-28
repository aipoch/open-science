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
    ({ id: `message-${index + 1}`, type: 'message' }) as WorkspaceConversationTimelineItem
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
