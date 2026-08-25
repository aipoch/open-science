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
})
