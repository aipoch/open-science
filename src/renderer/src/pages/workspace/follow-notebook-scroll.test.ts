import { describe, expect, it } from 'vitest'

import {
  FOLLOW_SCROLL_EDGE_PX,
  followScrollBottomTop,
  isAtFollowScrollBottom,
  isCurrentSessionNotebookView
} from './follow-notebook-scroll'

describe('isAtFollowScrollBottom', () => {
  it('treats the viewport as following when remaining overflow is within the edge', () => {
    expect(isAtFollowScrollBottom({ scrollTop: 592, clientHeight: 400, scrollHeight: 1000 })).toBe(
      true
    )
    expect(
      isAtFollowScrollBottom({
        scrollTop: 1000 - 400 - FOLLOW_SCROLL_EDGE_PX - 1,
        clientHeight: 400,
        scrollHeight: 1000
      })
    ).toBe(false)
  })
})

describe('followScrollBottomTop', () => {
  it('pins to the last visible line without going negative', () => {
    expect(followScrollBottomTop({ scrollTop: 0, clientHeight: 400, scrollHeight: 1000 })).toBe(600)
    expect(followScrollBottomTop({ scrollTop: 0, clientHeight: 400, scrollHeight: 200 })).toBe(0)
  })
})

describe('isCurrentSessionNotebookView', () => {
  const currentView = {
    notebookSessionId: 'session-1',
    selectedSessionId: 'session-1',
    notebookItemId: 'tool:session-1:notebook',
    previewPanelState: 'open' as const,
    previewActiveItemId: 'tool:session-1:notebook',
    notebookItemInWorkbench: true
  }

  it('follows only the selected Session Notebook while that preview is visible', () => {
    expect(isCurrentSessionNotebookView(currentView)).toBe(true)
  })

  it('does not follow another Session even when its Notebook tab is open', () => {
    expect(
      isCurrentSessionNotebookView({
        ...currentView,
        selectedSessionId: 'session-2'
      })
    ).toBe(false)
  })

  it('does not follow when the preview panel is collapsed or another tab is active', () => {
    expect(
      isCurrentSessionNotebookView({
        ...currentView,
        previewPanelState: 'collapsed'
      })
    ).toBe(false)
    expect(
      isCurrentSessionNotebookView({
        ...currentView,
        previewActiveItemId: 'tool:project:files'
      })
    ).toBe(false)
  })

  it('follows an isolated mount whose Notebook is not yet in the workbench', () => {
    expect(
      isCurrentSessionNotebookView({
        ...currentView,
        notebookItemInWorkbench: false,
        previewPanelState: 'collapsed',
        previewActiveItemId: undefined
      })
    ).toBe(true)
  })
})
