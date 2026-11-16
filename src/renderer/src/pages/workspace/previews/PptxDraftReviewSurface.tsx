import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import type { PreviewFileItem, PreviewFileSource } from '@/stores/preview-workbench-contract'
import type { OfficePreviewSlideView } from '../../../../../shared/office-preview'
import type { PptxDraftSummary } from '../../../../../shared/pptx-draft'
import { OfficePreviewContent, type OfficeSlideRequest } from './renderers/OfficePreview'
import type { PptxDraftPreview } from './use-pptx-draft-preview'

type PptxDraftReviewSurfaceProps = {
  item: PreviewFileItem
  source: PreviewFileSource
  draft: PptxDraftSummary
  preview: PptxDraftPreview
}

const changedSlideIds = (draft: PptxDraftSummary): Set<number> =>
  new Set(
    draft.operations.flatMap((operation) => {
      const slideId = (operation as { slideId?: number }).slideId
      return slideId === undefined ? [] : [slideId]
    })
  )

const PptxDraftReviewSurface = ({
  item,
  source,
  draft,
  preview
}: PptxDraftReviewSurfaceProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [slideIndex, setSlideIndex] = useState(0)
  const [slideRequest, setSlideRequest] = useState<OfficeSlideRequest>()
  const { view, failed } = preview
  if (failed) {
    return (
      <div role="alert" className="p-4 text-xs text-destructive">
        {t('The suggested edits could not be previewed.')}
      </div>
    )
  }
  if (!view) return null
  const changed = changedSlideIds(draft)
  const marked = view.outline.slides.flatMap((slide, index) =>
    changed.has(slide.slideId) ? [index] : []
  )
  return (
    <div className="flex size-full min-h-0 flex-col" data-testid="pptx-draft-review">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border-300 px-2 py-1 text-xs">
        <span className="mr-1">{t('Changed slides')}</span>
        {marked.map((index) => (
          <Button
            key={index}
            type="button"
            size="sm"
            variant={index === slideIndex ? 'secondary' : 'ghost'}
            aria-label={t('Slide {{number}}', { number: index + 1 })}
            onClick={() => {
              setSlideIndex(index)
              setSlideRequest({ slideIndex: index, serial: (slideRequest?.serial ?? 0) + 1 })
            }}
          >
            {index + 1}
          </Button>
        ))}
      </div>
      <div className="relative min-h-0 flex-1">
        <OfficePreviewContent
          item={item}
          source={source}
          slideRequest={slideRequest}
          staged={{
            key: view.stagedKey,
            slideIndex,
            onSlideView: (next: OfficePreviewSlideView) => setSlideIndex(next.slideIndex)
          }}
        />
      </div>
    </div>
  )
}

export { PptxDraftReviewSurface }
export type { PptxDraftReviewSurfaceProps }
