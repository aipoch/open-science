// ReviewerCard: a compact card that appears in the conversation after a turn has been reviewed.
// Shows "Reviewing..." while running, "No issues found" for a pass, or "N findings" for flagged.
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
import { cn } from '@/lib/utils'

import type { ReviewWithChecks, ReviewCheck, GoToTranscriptIntent } from '../../../shared/reviewer'

type ReviewerCardProps = {
  review: ReviewWithChecks
  className?: string
  // Called when the user clicks "Go to transcript" on any item card.
  onGoToTranscript?: (intent: GoToTranscriptIntent) => void
  // Called when the user asks to re-run a stale review (its turn changed after it ran). Resolves to
  // whether a review actually started; a false result (e.g. session load failed) releases the button
  // latch so the turn stays retriable.
  onRerun?: (review: ReviewWithChecks) => Promise<boolean>
}

// Status badge styles (pass/warn/fail).
const STATUS_BADGE_STYLES: Record<string, string> = {
  fail: 'text-red-700 bg-red-50 border border-red-200',
  warn: 'text-yellow-700 bg-yellow-50 border border-yellow-200',
  pass: 'text-green-700 bg-green-50 border border-green-200'
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
}

const ItemCard = ({
  testId,
  badgeText,
  badgeClassName,
  title,
  body,
  model,
  onGoToTranscript,
  reflagCount
}: ItemCardProps): React.JSX.Element => (
  <div className="rounded-lg border border-border-200 bg-bg-000 p-3" data-testid={testId}>
    {/* Badge + title row */}
    <div className="flex items-start gap-2">
      <span
        className={cn(
          'mt-0.5 shrink-0 rounded px-1 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
          badgeClassName
        )}
        data-testid="reviewer-item-badge"
      >
        {badgeText}
      </span>
      <span className="flex-1 text-xs font-semibold leading-snug text-text-000">{title}</span>
      {/* Re-flag marker: shown when this claim was re-flagged in the fix loop. */}
      {reflagCount != null && reflagCount > 0 && (
        <span
          className="shrink-0 rounded px-1 py-0.5 text-[11px] text-yellow-600 border border-yellow-200 bg-yellow-50"
          data-testid="reviewer-reflag-marker"
        >
          re-flagged ×{reflagCount}
        </span>
      )}
    </div>

    {/* Body — evidence for all check types */}
    {body ? <p className="mt-2 text-xs leading-relaxed text-text-300">{body}</p> : null}

    {/* Footer row: model pill (left) + Go to transcript button (right) */}
    <div className="mt-3 flex items-center justify-between gap-2">
      <span
        className="rounded border border-border-200 bg-bg-100 px-1.5 py-0.5 text-[11px] text-text-400"
        data-testid="reviewer-model-pill"
      >
        {model}
      </span>
      <button
        type="button"
        className="rounded border border-border-200 px-2 py-0.5 text-[11px] text-text-300 hover:border-border-300 hover:text-text-000 transition-colors"
        onClick={onGoToTranscript}
      >
        Go to transcript
      </button>
    </div>
  </div>
)

// ── Check card ───────────────────────────────────────────────────────────────

type CheckCardProps = {
  check: ReviewCheck
  reviewId: string
  model: string
  onGoToTranscript?: (intent: GoToTranscriptIntent) => void
}

const CheckCard = ({
  check,
  reviewId,
  model,
  onGoToTranscript
}: CheckCardProps): React.JSX.Element => {
  const isWarnOrFail = check.status === 'warn' || check.status === 'fail'

  return (
    <ItemCard
      testId={isWarnOrFail ? 'reviewer-finding-card' : 'reviewer-check-card'}
      badgeText={check.status}
      badgeClassName={STATUS_BADGE_STYLES[check.status] ?? ''}
      title={check.claim}
      body={check.evidence}
      model={model}
      reflagCount={check.reflagCount}
      onGoToTranscript={() =>
        onGoToTranscript?.(
          isWarnOrFail
            ? {
                reviewId,
                findingId: check.id,
                checkId: check.id,
                locator: check.locator
              }
            : // Pass check: open panel without highlighting a specific check.
              { reviewId }
        )
      }
    />
  )
}

// ── Main card ────────────────────────────────────────────────────────────────

export const ReviewerCard = ({
  review,
  className,
  onGoToTranscript,
  onRerun
}: ReviewerCardProps): React.JSX.Element => {
  const [expanded, setExpanded] = useState(false)
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
  const isError = review.lifecycle === 'error'
  const isComplete = review.lifecycle === 'complete'

  // v2: header count = warn/fail checks only (pass checks don't count toward "findings").
  const warnFailCount = review.checks.filter(
    (c) => c.status === 'warn' || c.status === 'fail'
  ).length
  const totalCheckCount = review.checks.length
  const hasWarnOrFail = warnFailCount > 0

  // Fix loop cap: if any warn/fail check is unaddressed the loop was capped — show the hint.
  const isCapReached =
    isComplete &&
    hasWarnOrFail &&
    review.checks.some(
      (c) => (c.status === 'warn' || c.status === 'fail') && c.resolution === 'unaddressed'
    )

  // A complete review is expandable if it has any checks; an error review is expandable if it carries
  // a message (kept out of the status bar so a verbose Prisma-style error doesn't overflow the line).
  const hasErrorDetail = isError && Boolean(review.errorMessage)
  const canExpand = (isComplete && totalCheckCount > 0) || hasErrorDetail
  const isFlagged = isComplete && hasWarnOrFail

  // The turn changed after this review ran (e.g. an artifact was edited) — the verdict may not
  // describe the current turn. Computed at load time (see flagStaleReviews); only meaningful for a
  // completed review, since running/error reviews have no verdict to go stale.
  const isStale = isComplete && review.stale === true

  // Compact summary line.
  const summaryText = (): string => {
    if (isRunning) return 'Reviewing…'
    if (isError) return 'Review error'
    if (isComplete && !hasWarnOrFail)
      return isStale ? 'No issues found (outdated)' : 'No issues found'
    if (isComplete && hasWarnOrFail) {
      const base = `${warnFailCount} finding${warnFailCount === 1 ? '' : 's'}`
      return isStale ? `${base} (outdated)` : base
    }
    return 'Review pending'
  }

  // Status icon. A stale complete review always shows the warning icon (amber), even a stale pass —
  // the point is "this verdict may not reflect the turn anymore", not the original outcome.
  const statusIcon = ((): React.JSX.Element => {
    if (isRunning) return <Loader className="h-3 w-3 animate-spin text-text-400" />
    if (isError) return <AlertTriangle className="h-3 w-3 text-yellow-500" />
    if (isStale) return <AlertTriangle className="h-3 w-3 text-amber-500" />
    if (isComplete && !hasWarnOrFail) return <ShieldCheck className="h-3 w-3 text-green-600" />
    if (isComplete && hasWarnOrFail) return <AlertTriangle className="h-3 w-3 text-red-500" />
    return <Loader className="h-3 w-3 text-text-400" />
  })()

  return (
    <div
      className={cn(
        'mt-2 rounded-lg border border-border-200 bg-bg-100 px-3 py-2 text-xs',
        className
      )}
      data-testid="reviewer-card"
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
        <span className="font-medium text-text-200">Reviewer</span>
        <span className="mx-1 text-text-400">&middot;</span>
        <span className={cn('text-text-300', isComplete && hasWarnOrFail && 'text-red-600')}>
          {summaryText()}
        </span>
        {/* Total check count — shown for any completed review (pass or flagged), never for zero checks. */}
        {isComplete && totalCheckCount > 0 && (
          <>
            <span className="mx-1 text-text-400">&middot;</span>
            <span className="text-text-400">
              {totalCheckCount} {totalCheckCount === 1 ? 'check' : 'checks'}
            </span>
          </>
        )}
        {/* Fix limit reached — shown when the loop was capped with unaddressed warn/fail checks. */}
        {isCapReached && (
          <>
            <span className="mx-1 text-text-400">&middot;</span>
            <span className="text-yellow-600">fix limit reached</span>
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
          className="mt-2 flex items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1"
          data-testid="reviewer-stale-notice"
        >
          <span className="text-[11px] text-amber-800">Turn changed after this review ran.</span>
          {onRerun && (
            <button
              type="button"
              // Disable immediately on click so a double-click (or an impatient second click before the
              // review flips to 'running') can't launch two reviews; main also dedups concurrent runs.
              disabled={rerunRequested}
              className="shrink-0 rounded border border-amber-300 px-2 py-0.5 text-[11px] text-amber-800 hover:bg-amber-100 transition-colors disabled:cursor-default disabled:opacity-50"
              onClick={() => {
                setRerunRequested(true)
                // Release the latch if no review actually started (e.g. the session couldn't load), so
                // the button stays usable; on success the running-review push clears it via updatedAt.
                void onRerun(review).then((started) => {
                  if (!started) setRerunRequested(false)
                })
              }}
            >
              {rerunRequested ? 'Re-running…' : 'Re-run review'}
            </button>
          )}
        </div>
      )}

      {/* Expanded error detail: full message in a scrollable monospace block (kept out of the status bar). */}
      {hasErrorDetail && expanded && (
        <div className="mt-2">
          <div
            className="max-h-48 overflow-auto rounded-lg border border-border-200 bg-bg-000 p-3"
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
          {review.checks.map((check) => (
            <CheckCard
              key={check.id}
              check={check}
              reviewId={review.id}
              model={review.model}
              onGoToTranscript={onGoToTranscript}
            />
          ))}

          {/* Self-correct footer note — shown only for warn/fail (flagged) expansions. */}
          {isFlagged && (
            <p className="mt-1 text-[11px] italic text-text-400">
              The agent reads these findings and self-corrects in its next message.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
