import type { PreviewPanelState } from '@/stores/preview-workbench-store'

export const FOLLOW_SCROLL_EDGE_PX = 8

type FollowScrollViewport = Pick<HTMLElement, 'clientHeight' | 'scrollHeight' | 'scrollTop'>

export const isAtFollowScrollBottom = (
  viewport: FollowScrollViewport,
  edgePx: number = FOLLOW_SCROLL_EDGE_PX
): boolean => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= edgePx

export const followScrollBottomTop = (viewport: FollowScrollViewport): number =>
  Math.max(0, viewport.scrollHeight - viewport.clientHeight)

export const prependAnchoredScrollTop = (
  previous: Pick<FollowScrollViewport, 'scrollHeight' | 'scrollTop'>,
  nextScrollHeight: number
): number => Math.max(0, previous.scrollTop + nextScrollHeight - previous.scrollHeight)

// Follow only while the visible preview is this Session's Notebook. Isolated mounts that are not
// yet in the workbench still follow when the selected Session matches.
export const isCurrentSessionNotebookView = ({
  notebookSessionId,
  selectedSessionId,
  notebookItemId,
  previewPanelState,
  previewActiveItemId,
  notebookItemInWorkbench
}: {
  notebookSessionId: string
  selectedSessionId: string | undefined
  notebookItemId: string
  previewPanelState: PreviewPanelState
  previewActiveItemId: string | undefined
  notebookItemInWorkbench: boolean
}): boolean => {
  if (selectedSessionId !== notebookSessionId) return false
  if (!notebookItemInWorkbench) return true
  return previewPanelState === 'open' && previewActiveItemId === notebookItemId
}
