import { useReviewStore } from '@/stores/review-store'
import type { PreviewToolItem } from '@/stores/preview-workbench-store'

import { NotebookPreview } from '../NotebookPreview'
import type { NotebookPreviewItem } from '../NotebookPreview'
import { ProjectFilesView } from '../ProjectFilesView'
import { SessionReviewerPanel } from '../SessionReviewerPanel'

const isNotebookPreviewItem = (item: PreviewToolItem): item is NotebookPreviewItem =>
  item.toolKind === 'notebook' && Boolean(item.notebook)

// Renders the Session reviewer panel from persisted review data for the tool item's session.
const SessionReviewerContent = ({ item }: { item: PreviewToolItem }): React.JSX.Element | null => {
  const sessionId = item.reviewerSessionId ?? ''
  const getReviewsForSession = useReviewStore((state) => state.getReviewsForSession)
  // Select the review the finding actually points at; fall back to the newest when the item carries
  // no reviewId (e.g. a session-level entry point) or that review is gone.
  const reviews = getReviewsForSession(sessionId)
  const review = reviews.find((r) => r.id === item.reviewerReviewId) ?? reviews[0]

  if (!review) {
    return (
      <div className="flex size-full items-center justify-center text-[12px] text-text-300">
        No review available for this session.
      </div>
    )
  }

  return <SessionReviewerPanel review={review} activeFindingId={item.reviewerActiveFindingId} />
}

export const PreviewToolContent = ({
  item
}: {
  item: PreviewToolItem
}): React.JSX.Element | null => {
  if (item.toolKind === 'files') return <ProjectFilesView />

  if (item.toolKind === 'reviewer') return <SessionReviewerContent item={item} />

  if (!isNotebookPreviewItem(item)) return null

  return <NotebookPreview item={item} />
}
