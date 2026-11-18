import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import type { PptxDraftSummary } from '../../../../../shared/pptx-draft'
import type { PptxDraftProblem } from './use-pptx-draft'

type PptxDraftBannerProps = {
  draft: PptxDraftSummary | null
  problem: PptxDraftProblem | undefined
  busy: boolean
  reviewing: boolean
  onReview: () => void
  onAccept: () => void
  onReject: () => void
}

const PptxDraftBanner = ({
  draft,
  problem,
  busy,
  reviewing,
  onReview,
  onAccept,
  onReject
}: PptxDraftBannerProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  if (!draft && !problem) return null
  const message =
    problem === 'stale'
      ? t('The file changed after these edits were suggested. Ask the AI to try again.')
      : problem === 'conflict'
        ? t('The file changed while you were reviewing. Reload it and review the edits again.')
        : problem === 'failed'
          ? t('The suggested edits could not be saved.')
          : undefined
  return (
    <div
      role="status"
      data-testid="pptx-draft-banner"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-300 bg-bg-100 px-3 py-2 text-xs text-text-100"
    >
      <span className="min-w-0 flex-1 truncate">
        {message ?? `${t('AI suggested edits')}: ${draft?.summary ?? ''}`}
      </span>
      {draft ? (
        <>
          {reviewing ? null : (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onReview}>
              {t('Review edits')}
            </Button>
          )}
          <Button type="button" size="sm" disabled={busy} onClick={onAccept}>
            {t('Accept')}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onReject}>
            {t('Reject')}
          </Button>
        </>
      ) : null}
    </div>
  )
}

export { PptxDraftBanner }
export type { PptxDraftBannerProps }
