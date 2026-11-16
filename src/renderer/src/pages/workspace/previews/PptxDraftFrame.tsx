import type { PreviewFileItem, PreviewFileSource } from '@/stores/preview-workbench-contract'
import type { PptxDraftState } from './use-pptx-draft'
import type { PptxDraftPreview } from './use-pptx-draft-preview'
import { PptxDraftBanner } from './PptxDraftBanner'
import { PptxDraftReviewSurface } from './PptxDraftReviewSurface'

type PptxDraftFrameProps = {
  item: PreviewFileItem
  source: PreviewFileSource
  state: PptxDraftState
  preview: PptxDraftPreview
  reviewing: boolean
  onReview: () => void
  onAccept: () => void
  onReject: () => void
  children: React.ReactNode
}

const PptxDraftFrame = ({
  item,
  source,
  state,
  preview,
  reviewing,
  onReview,
  onAccept,
  onReject,
  children
}: PptxDraftFrameProps): React.JSX.Element => {
  const { draft, problem, busy } = state
  if (!draft && !problem) return <>{children}</>
  return (
    <div className="flex size-full min-h-0 flex-col">
      <PptxDraftBanner
        draft={draft}
        problem={problem}
        busy={busy}
        reviewing={reviewing}
        onReview={onReview}
        onAccept={onAccept}
        onReject={onReject}
      />
      <div className="min-h-0 flex-1">
        {reviewing && draft ? (
          <PptxDraftReviewSurface item={item} source={source} draft={draft} preview={preview} />
        ) : (
          children
        )}
      </div>
    </div>
  )
}

export { PptxDraftFrame }
export type { PptxDraftFrameProps }
