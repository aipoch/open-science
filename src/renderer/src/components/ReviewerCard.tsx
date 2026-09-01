// ReviewerCard: a compact review surface that appears in the conversation after a turn is reviewed.
// While running, it reduces to a transparent branded status row without mounting the review surface.
//
// v2 (issue 12): unified Checks list — all checks (pass/warn/fail) come from ReviewWithChecks.checks.
// The header count = number of warn/fail checks. Expansion shows all checks with pass/warn/fail badges.
//
// A warn/fail check's "Go to transcript" fires GoToTranscriptIntent with checkId+locator.
// A pass check's "Go to transcript" fires GoToTranscriptIntent with reviewId only (no checkId/locator),
// opening the Session reviewer page without an active highlighted check.
//
// warn/fail expansions show a self-correct footer note; pass-only expansions do not.

import { useState } from 'react'
import { ChevronDown, ChevronRight, ShieldCheck, AlertTriangle, Loader } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { OpenScienceThinkingIndicator } from '@/components/OpenScienceThinkingIndicator'
import {
  presentReviewSubmission,
  type PresentedReviewCheck
} from '@/lib/reviewer-submission-presentation'

import type { ReviewWithChecks, GoToTranscriptIntent } from '../../../shared/reviewer'

type ReviewerCardProps = {
  review: ReviewWithChecks
  className?: string
  // Embedded detail surfaces can start expanded while the transcript keeps its compact default.
  defaultExpanded?: boolean
  // Called when the user clicks "Go to transcript" on any item card.
  onGoToTranscript?: (intent: GoToTranscriptIntent) => void
  // Called when the user asks to re-run a stale review (its turn changed after it ran). Resolves to
  // whether a review actually started; a false result (e.g. session load failed) releases the button
  // latch so the turn stays retriable.
  onRerun?: (review: ReviewWithChecks) => Promise<boolean>
}

// Status badge styles (pass/warn/fail).
const STATUS_BADGE_STYLES: Record<string, string> = {
  fail: 'bg-bg-200 text-red-700 dark:text-red-300',
  warn: 'bg-bg-200 text-yellow-700 dark:text-yellow-300',
  pass: 'bg-bg-200 text-green-700 dark:text-green-300'
}

// ── Shared item card layout ──────────────────────────────────────────────────
//
// All check cards (pass/warn/fail) use this unified layout:
//   [badge]  [bold title]
//   [body text]
//   [model pill]  ...  [Go to transcript button]

type ItemCardProps = {
  // data-testid for the card root — distinguishes check status types.
  testId: string
  // Badge text (e.g. "fail", "warn", "pass") and its CSS classes.
  badgeText: string
  badgeClassName: string
  // Bold title (claim text for all check types).
  title: string
  // Body text rendered inline (evidence for all check types).
  body: string | undefined
  // Model tag shown at the bottom-left of the card.
  model: string
  // Called when the user clicks "Go to transcript".
  onGoToTranscript: (() => void) | undefined
  // Number of times this claim was re-flagged in the fix loop (0 means no marker).
  reflagCount?: number
  // Quiet provenance label for this Review's own submission row.
  kindLabel?: 'New' | 'Tracked'
  // Explicit compatibility note for a legacy tracked disposition without a persisted assessment.
  legacyNote?: string
  dispositionLabel?: string
}

const ItemCard = ({
  testId,
  badgeText,
  badgeClassName,
  title,
  body,
  model,
  onGoToTranscript,
  reflagCount,
  kindLabel,
  legacyNote,
  dispositionLabel
}: ItemCardProps): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <div className="rounded-lg bg-bg-000 p-3" data-testid={testId}>
      {kindLabel && (
        <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-text-300">
          {t(kindLabel)}
        </div>
      )}
      {/* Badge + title row */}
      <div className="flex items-start gap-2">
        <span
          className={cn(
            'mt-0.5 shrink-0 rounded bg-bg-200 px-1 py-0.5 text-[11px] font-semibold uppercase',
            badgeClassName
          )}
          data-testid="reviewer-item-badge"
        >
          {t(badgeText)}
        </span>
        <span className="min-w-0 flex-1 break-words text-xs font-semibold leading-snug text-text-000 [overflow-wrap:anywhere]">
          {title}
        </span>
        {/* Re-flag marker: shown when this claim was re-flagged in the fix loop. */}
        {reflagCount != null && reflagCount > 0 && (
          <span
            className="shrink-0 rounded bg-bg-200 px-1 py-0.5 text-[11px] text-yellow-600 dark:text-yellow-400"
            data-testid="reviewer-reflag-marker"
          >
            {t('re-flagged ×{{count}}', { count: reflagCount })}
          </span>
        )}
      </div>

      {/* Body — evidence for all check types */}
      {body ? (
        <p className="mt-2 break-words text-xs leading-relaxed text-text-300 [overflow-wrap:anywhere]">
          {body}
        </p>
      ) : null}

      {legacyNote && (
        <p className="mt-2 text-[11px] text-text-300" data-testid="reviewer-legacy-assessment-note">
          {t(legacyNote)}
        </p>
      )}
      {dispositionLabel && (
        <p className="mt-1 text-[11px] text-text-300">
          {t('Disposition: {{disposition}}', {
            disposition: dispositionLabel === 'still open' ? t('still open') : t(dispositionLabel)
          })}
        </p>
      )}

      {/* Footer row: model pill (left) + Go to transcript button (right) */}
      <div className="mt-3 flex items-center justify-between gap-2">
        <span
          className="rounded bg-bg-200 px-1.5 py-0.5 text-[11px] text-text-400"
          data-testid="reviewer-model-pill"
        >
          {model}
        </span>
        <button
          type="button"
          className="rounded bg-bg-200 px-2 py-0.5 text-[11px] text-text-300 transition-colors hover:bg-bg-300 hover:text-text-000"
          onClick={onGoToTranscript}
        >
          {t('Go to transcript')}
        </button>
      </div>
    </div>
  )
}

const PresentedCheckCard = ({
  item,
  reviewId,
  model,
  onGoToTranscript
}: {
  item: PresentedReviewCheck
  reviewId: string
  model: string
  onGoToTranscript?: (intent: GoToTranscriptIntent) => void
}): React.JSX.Element => {
  return (
    <ItemCard
      testId={
        item.kind === 'tracked'
          ? 'reviewer-tracked-check-card'
          : item.isWarnOrFail
            ? 'reviewer-finding-card'
            : 'reviewer-check-card'
      }
      badgeText={item.status}
      badgeClassName={STATUS_BADGE_STYLES[item.status] ?? ''}
      title={item.claim}
      body={item.evidence}
      model={model}
      kindLabel={item.kindLabel}
      reflagCount={item.reflagCount}
      legacyNote={item.legacyAssessmentNote}
      dispositionLabel={item.dispositionLabel}
      onGoToTranscript={() =>
        onGoToTranscript?.(
          item.transcriptFindingId
            ? {
                reviewId,
                findingId: item.transcriptFindingId,
                checkId: item.transcriptFindingId,
                locator: item.locator
              }
            : { reviewId }
        )
      }
    />
  )
}

// ── Main card ────────────────────────────────────────────────────────────────

export const ReviewerCard = ({
  review,
  className,
  defaultExpanded = false,
  onGoToTranscript,
  onRerun
}: ReviewerCardProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(defaultExpanded)
  // Latches on the first Re-run click so the button can't fire twice. Reset whenever the review updates
  // (a fresh review row arrived, or its lifecycle/timestamp changed) so a later re-stale review can be
  // re-run again. setState-during-render pattern, matching the composer popup's query reset.
  const [rerunRequested, setRerunRequested] = useState(false)
  const [lastReviewStamp, setLastReviewStamp] = useState(review.updatedAt)
  if (lastReviewStamp !== review.updatedAt) {
    setLastReviewStamp(review.updatedAt)
    setRerunRequested(false)
  }

  const isRunning = review.lifecycle === 'running'

  // A live review is status, not a result card; keep completed-review controls out of the DOM.
  if (isRunning) {
    return (
      <div
        className={cn('mt-2 flex items-center gap-1.5 px-0 py-2 text-xs text-text-300', className)}
        data-testid="reviewer-running-state"
        data-review-id={review.id}
        role="status"
        aria-live="polite"
      >
        <OpenScienceThinkingIndicator />
        <span>{t('Reviewing...')}</span>
      </div>
    )
  }

  const isError = review.lifecycle === 'error'
  const isComplete = review.lifecycle === 'complete'

  // Current reads carry the exact submitted projection. Older in-memory snapshots fall back to the
  // Review-owned Findings without inventing tracked assessment content.
  const submittedChecks = presentReviewSubmission(review)
  const warnFailCount = submittedChecks.filter((item) => item.isWarnOrFail).length
  const totalCheckCount = submittedChecks.length
  const hasWarnOrFail = warnFailCount > 0
  // The durable Review verdict is authoritative. A fix-loop Review may commit its tracked failing
  // assessments as dispositions on earlier Findings, leaving this Review with no local warn/fail
  // rows (or only newly assessed pass rows) while its outcome correctly remains flagged.
  const isFlagged = isComplete && review.outcome === 'flagged'

  // Terminal dispositions distinguish a true round cap from correction transport/persistence failure.
  const isCapReached =
    isComplete &&
    hasWarnOrFail &&
    submittedChecks.some(
      (item) => item.isUnaddressed && item.unaddressedTrigger === 'loop_terminated'
    )
  const isCorrectionFailed =
    isComplete &&
    hasWarnOrFail &&
    submittedChecks.some(
      (item) => item.isUnaddressed && item.unaddressedTrigger === 'correction_failed'
    )

  // A complete review is expandable if it has any checks; an error review is expandable if it carries
  // a message (kept out of the status bar so a verbose Prisma-style error doesn't overflow the line).
  const hasErrorDetail = isError && Boolean(review.errorMessage)
  const canExpand = (isComplete && totalCheckCount > 0) || hasErrorDetail

  // The turn changed after this review ran (e.g. an artifact was edited) — the verdict may not
  // describe the current turn. Computed at load time (see flagStaleReviews); only meaningful for a
  // completed review, since running/error reviews have no verdict to go stale.
  const isStale = isComplete && review.stale === true

  // Compact summary line.
  const summaryText = (): string => {
    if (isError) return t('Review error')
    if (isFlagged) {
      if (!hasWarnOrFail) {
        return isStale ? t('Issues found (outdated)') : t('Issues found')
      }
      return isStale
        ? t('{{count}} findings (outdated)', {
            defaultValue_one: '{{count}} finding (outdated)',
            count: warnFailCount
          })
        : t('{{count}} findings', { defaultValue_one: '{{count}} finding', count: warnFailCount })
    }
    if (isComplete) return isStale ? t('No issues found (outdated)') : t('No issues found')
    return t('Review pending')
  }

  // Status icon. A stale complete review always shows the warning icon (amber), even a stale pass —
  // the point is "this verdict may not reflect the turn anymore", not the original outcome.
  const statusIcon = ((): React.JSX.Element => {
    if (isError) return <AlertTriangle className="h-3 w-3 text-yellow-500" />
    if (isStale) return <AlertTriangle className="h-3 w-3 text-amber-500" />
    if (isFlagged) return <AlertTriangle className="h-3 w-3 text-red-500" />
    if (isComplete) return <ShieldCheck className="h-3 w-3 text-green-600 dark:text-green-400" />
    return <Loader className="h-3 w-3 text-text-400" />
  })()

  return (
    <div
      className={cn('mt-2 rounded-lg bg-bg-200 px-3 py-2 text-xs', className)}
      data-testid="reviewer-card"
      data-review-id={review.id}
    >
      {/* Header row */}
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-1.5 text-left',
          canExpand ? 'cursor-pointer' : 'cursor-default'
        )}
        onClick={canExpand ? () => setExpanded((v) => !v) : undefined}
        disabled={!canExpand}
        aria-expanded={canExpand ? expanded : undefined}
      >
        {statusIcon}
        <span className="font-medium text-text-200">{t('Reviewer')}</span>
        <span className="mx-1 text-text-400">&middot;</span>
        <span className={cn('text-text-300', isFlagged && 'text-red-600 dark:text-red-400')}>
          {summaryText()}
        </span>
        {/* Total check count — shown for any completed review (pass or flagged), never for zero checks. */}
        {isComplete && totalCheckCount > 0 && (
          <>
            <span className="mx-1 text-text-400">&middot;</span>
            <span className="text-text-400">
              {t('{{count}} checks', {
                defaultValue_one: '{{count}} check',
                count: totalCheckCount
              })}
            </span>
          </>
        )}
        {/* Fix limit reached — shown when the loop was capped with unaddressed warn/fail checks. */}
        {isCapReached && (
          <>
            <span className="mx-1 text-text-400">&middot;</span>
            <span className="text-yellow-600 dark:text-yellow-400">{t('fix limit reached')}</span>
          </>
        )}
        {isCorrectionFailed && (
          <>
            <span className="mx-1 text-text-400">&middot;</span>
            <span className="text-yellow-600 dark:text-yellow-400">{t('correction failed')}</span>
          </>
        )}
        {canExpand && (
          <span className="ml-auto">
            {expanded ? (
              <ChevronDown className="h-3 w-3 text-text-400" />
            ) : (
              <ChevronRight className="h-3 w-3 text-text-400" />
            )}
          </span>
        )}
      </button>

      {/* Stale notice + explicit re-run: the verdict above may no longer describe the turn (an artifact
          was edited after the review ran). This is the actionable refresh path for THIS review's turn —
          including earlier turns that the composer's "Request review" (last-turn only) cannot reach. */}
      {isStale && (
        <div
          className="mt-2 flex items-center justify-between gap-2 rounded-md bg-bg-300 px-2 py-1"
          data-testid="reviewer-stale-notice"
        >
          <span className="text-[11px] text-amber-800 dark:text-amber-300">
            {t('Turn changed after this review ran.')}
          </span>
          {onRerun && (
            <button
              type="button"
              // Disable immediately on click so a double-click (or an impatient second click before the
              // review flips to 'running') can't launch two reviews; main also dedups concurrent runs.
              disabled={rerunRequested}
              className="shrink-0 rounded bg-bg-000 px-2 py-0.5 text-[11px] text-amber-800 transition-colors hover:bg-bg-300 disabled:cursor-default disabled:opacity-50 dark:text-amber-300"
              onClick={() => {
                setRerunRequested(true)
                // Release the latch if no review actually started (e.g. the session couldn't load), so
                // the button stays usable; on success the running-review push clears it via updatedAt.
                void onRerun(review).then((started) => {
                  if (!started) setRerunRequested(false)
                })
              }}
            >
              {rerunRequested ? t('Re-running…') : t('Re-run review')}
            </button>
          )}
        </div>
      )}

      {/* Expanded error detail: full message in a scrollable monospace block (kept out of the status bar). */}
      {hasErrorDetail && expanded && (
        <div className="mt-2">
          <div
            className="max-h-48 overflow-auto rounded-lg bg-bg-000 p-3"
            data-testid="reviewer-error-detail"
          >
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-text-300">
              {review.errorMessage}
            </pre>
          </div>
        </div>
      )}

      {/* Expanded item cards: one card per check (pass/warn/fail unified list) */}
      {canExpand && expanded && (
        <div className="mt-2 space-y-2">
          {submittedChecks.map((item) => (
            <PresentedCheckCard
              key={item.key}
              item={item}
              reviewId={review.id}
              model={review.model}
              onGoToTranscript={onGoToTranscript}
            />
          ))}

          {/* Self-correct footer note — shown only for warn/fail (flagged) expansions. */}
          {hasWarnOrFail && !isCapReached && !isCorrectionFailed && (
            <p className="mt-1 text-[11px] italic text-text-400">
              {t('The agent reads these findings and self-corrects in its next message.')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
