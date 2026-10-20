import { memo, useState } from 'react'
import type { ReviewWithChecks } from '../../../../../shared/reviewer'
import { SessionReviewerPanel } from '../SessionReviewerPanel'
import { WorkspaceActivityGroupSurface } from '../WorkspaceTranscriptSurface'
import { useReplayTranslation } from './replay-presentation'

// Archived evidence only. Expanding never mounts the live Reviewer controller or its actions.
export const ReplayReviewRecord = memo(function ReplayReviewRecord({
  review,
  showResults
}: {
  review: ReviewWithChecks
  showResults: boolean
}): React.JSX.Element {
  const { t } = useReplayTranslation()
  const [expanded, setExpanded] = useState(false)
  return (
    <div data-replay-review={review.id} className="min-w-0">
      <WorkspaceActivityGroupSurface
        animate={false}
        title={t('Session Reviewer')}
        meta={
          showResults
            ? review.lifecycle === 'error'
              ? t('Failed')
              : review.lifecycle === 'complete'
                ? review.outcome === 'pass'
                  ? t('No issues found')
                  : review.outcome === 'flagged'
                    ? t('Issues found')
                    : t('Recorded review incomplete')
                : t('Recorded review incomplete')
            : t('Reconstructed activity')
        }
        isExpanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
      >
        {showResults ? (
          <SessionReviewerPanel review={review} activeFindingId={undefined} historical />
        ) : (
          <p className="p-3 text-xs text-text-300">
            {t('Recorded results appear later in the replay.')}
          </p>
        )}
      </WorkspaceActivityGroupSurface>
    </div>
  )
})
