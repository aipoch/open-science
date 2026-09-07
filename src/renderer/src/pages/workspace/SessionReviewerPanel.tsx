// SessionReviewerPanel: the dedicated Session reviewer page rendered inside the PreviewPanel.
// Opened by clicking "Go to transcript" on any check in the ReviewerCard. Shows:
//   - A unified Checks list (pass/warn/fail) with status badges, claim, evidence, locator+link
//   - Expandable "Reviewer log" section (collapsed by default, visually de-emphasized)
//
// v2 (issue 12): replaced the old top/middle/bottom three-region layout with a single Checks list.
// The Summary section is removed (Review no longer has a summary column).
// v3 (issue 13): replaced the old "Full reasoning" prose block with a "Reviewer log" section that
// renders the captured reviewer action stream (thinking / tool calls / results / messages), collapsed
// by default and visually de-emphasized (muted colors, left-rule indent, no colored severity badges).
// Current Reviews render submittedChecks so tracked assessments remain visible beside new Findings;
// legacy in-memory snapshots fall back to their Review-owned checks.
//
// The activeFindingId prop scrolls/highlights the check the user navigated from.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { CheckCircle, AlertTriangle, XCircle, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'
import { cn } from '@/lib/utils'
import {
  presentReviewSubmission,
  type PresentedReviewCheck
} from '@/lib/reviewer-submission-presentation'

import type { ReviewWithChecks, ReviewCheck, ReviewerLogEntry } from '../../../../shared/reviewer'

type SessionReviewerPanelProps = {
  review: ReviewWithChecks
  // Check id to highlight/scroll to (from GoToTranscriptIntent). Undefined = no active check.
  activeFindingId: string | undefined
}

// Formats the blockRef into a human-readable reference like "msg-2[1]" or "act-3[0]".
const formatBlockRef = (check: PresentedReviewCheck): string | null => {
  if (!check.locator) return null
  const { blockRef } = check.locator
  const ref = blockRef.messageId ?? blockRef.activityId ?? 'block'
  return `${ref}[${blockRef.blockIndex}]`
}

// Icon component for a check status.
const StatusIcon = ({ status }: { status: ReviewCheck['status'] }): React.JSX.Element => {
  if (status === 'fail')
    return (
      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
    )
  if (status === 'warn')
    return <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-yellow-500" aria-hidden />
  return (
    <CheckCircle
      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400"
      aria-hidden
    />
  )
}

// One row in the unified checks list.
const CheckRow = ({
  check,
  isActive
}: {
  check: PresentedReviewCheck
  isActive: boolean
}): React.JSX.Element => {
  const rowRef = useRef<HTMLDivElement | null>(null)
  const { t } = useTranslation()

  // Scroll this row into view when it becomes the active check.
  useEffect(() => {
    if (isActive && rowRef.current && typeof rowRef.current.scrollIntoView === 'function') {
      rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [isActive])

  const statusStyles: Record<string, string> = {
    fail: 'text-red-700 bg-red-50 border border-red-200 dark:text-red-300 dark:bg-red-950/20 dark:border-red-800/50',
    warn: 'text-yellow-700 bg-yellow-50 border border-yellow-200 dark:text-yellow-300 dark:bg-yellow-950/20 dark:border-yellow-800/50',
    pass: 'text-green-700 bg-green-50 border border-green-200 dark:text-green-300 dark:bg-green-950/20 dark:border-green-800/50'
  }

  const locatorRef = formatBlockRef(check)
  return (
    <div
      ref={rowRef}
      className={cn(
        'rounded-lg border p-3 transition-colors',
        isActive ? 'border-primary/40 bg-primary/5' : 'border-border-200 bg-bg-000'
      )}
      data-finding-id={check.findingId}
      data-active={isActive ? 'true' : 'false'}
      data-submission-kind={check.kind}
    >
      <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-text-300">
        {t(check.kindLabel)}
      </div>
      {/* Status badge + claim */}
      <div className="flex items-start gap-2">
        <StatusIcon status={check.status} />
        <span
          className={cn(
            'mt-0.5 shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
            statusStyles[check.status] ?? ''
          )}
        >
          {t(check.status)}
        </span>
        <p className="flex-1 text-xs font-medium leading-snug text-text-000">{check.claim}</p>
      </div>

      {/* Evidence */}
      <p className="mt-2 text-xs leading-relaxed text-text-300">{check.evidence}</p>

      {check.legacyAssessmentNote && (
        <p className="mt-2 text-[11px] text-text-300">{t(check.legacyAssessmentNote)}</p>
      )}
      {check.dispositionLabel && (
        <p className="mt-1 text-[11px] text-text-300">
          {t('Disposition: {{disposition}}', { disposition: t(check.dispositionLabel) })}
        </p>
      )}

      {/* Locator reference — only shown for warn/fail checks that have a locator */}
      {check.isWarnOrFail && locatorRef && (
        <div className="mt-2 text-[10px] text-text-400">
          <span className="font-medium">{t('Ref:')}</span> {locatorRef}{' '}
          <span className="text-text-500/60">
            {t('· hash {{hash}}', { hash: check.locator!.contentHash.slice(0, 8) })}
          </span>
        </div>
      )}
    </div>
  )
}

// Icon for a reviewer log text entry (thought / message). Tool entries render their own
// chevron-based collapsible header, so they never go through this icon.
const LogEntryIcon = ({ kind }: { kind: 'thought' | 'message' }): React.JSX.Element => (
  <span className="text-text-400 select-none" aria-hidden>
    {kind === 'thought' ? '✦' : '›'}
  </span>
)

// One row in the reviewer log. Reuses the same visual vocabulary as the workspace activity rows
// but de-emphasized: muted colors, no colored severity badges, smaller font.
const ReviewerLogRow = ({ entry }: { entry: ReviewerLogEntry }): React.JSX.Element => {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  const rowClassName = 'flex items-start gap-1.5 py-0.5 text-[11px] leading-[1.45]'

  if (entry.kind === 'thought') {
    return (
      <div className={rowClassName}>
        <span className="mt-0.5 w-3.5 shrink-0 text-center">
          <LogEntryIcon kind="thought" />
        </span>
        <span className="text-text-400 italic">{entry.text}</span>
      </div>
    )
  }

  if (entry.kind === 'message') {
    return (
      <div className={rowClassName}>
        <span className="mt-0.5 w-3.5 shrink-0 text-center">
          <LogEntryIcon kind="message" />
        </span>
        <span className="text-text-300">{entry.text}</span>
      </div>
    )
  }

  // tool entry: collapsible row with real tool name + one-line summary + status dot
  const statusDot =
    entry.status === 'ok' ? (
      <span className="shrink-0 text-[10px] text-green-600 dark:text-green-400">{t('● ok')}</span>
    ) : entry.status === 'error' ? (
      <span className="shrink-0 text-[10px] text-red-500">{t('● error')}</span>
    ) : null

  // One-line summary: prefer title, fall back to rawInput (first line only)
  const summary = entry.title ?? (entry.rawInput ? entry.rawInput.split('\n')[0] : undefined)

  const hasDetails = Boolean(entry.rawInput ?? entry.rawOutput)

  return (
    <div className="py-0.5">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left text-[11px] leading-[1.45] text-text-400 transition-colors duration-150 hover:text-text-300 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={hasDetails ? detailsId : undefined}
        data-testid="tool-log-row-toggle"
        disabled={!hasDetails}
      >
        <span className="w-3.5 shrink-0 text-center">
          <ChevronRight
            className={cn(
              'h-3 w-3 transition-transform duration-150 motion-reduce:transition-none',
              expanded ? 'rotate-90' : ''
            )}
            aria-hidden
          />
        </span>
        <span className="font-semibold text-text-300">{entry.toolName || t('Tool')}</span>
        {summary ? (
          <code className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-text-400">
            {summary}
          </code>
        ) : null}
        {statusDot}
      </button>

      {expanded && hasDetails && (
        <div id={detailsId} className="ml-5 mt-1 space-y-1" data-testid="tool-log-row-details">
          {entry.rawInput ? (
            <div>
              <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-400">
                {t('Input')}
              </div>
              <pre className="overflow-auto rounded border border-border-200 bg-bg-100 p-1.5 text-[10px] leading-[1.5] text-text-300 whitespace-pre-wrap break-words max-h-36">
                {entry.rawInput}
              </pre>
            </div>
          ) : null}
          {entry.rawOutput ? (
            <div>
              <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-400">
                {t('Output')}
              </div>
              <pre className="overflow-auto rounded border border-border-200 bg-bg-100 p-1.5 text-[10px] leading-[1.5] text-text-300 whitespace-pre-wrap break-words max-h-36">
                {entry.rawOutput}
                {entry.exitCode !== undefined && entry.exitCode !== null ? (
                  <span
                    className={cn(
                      'block',
                      entry.exitCode === 0 ? 'text-green-600 dark:text-green-400' : 'text-red-500'
                    )}
                  >
                    {t('exit {{code}}', { code: entry.exitCode })}
                  </span>
                ) : null}
              </pre>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

type MutedDisclosureProps = {
  label: (expanded: boolean) => ReactNode
  toggleTestId: string
  bodyTestId: string
  bodyClassName: string
  bodyAs?: 'div' | 'dl'
  children: ReactNode
}

const MutedDisclosure = ({
  label,
  toggleTestId,
  bodyTestId,
  bodyClassName,
  bodyAs = 'div',
  children
}: MutedDisclosureProps): React.JSX.Element => {
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  const Body = bodyAs

  return (
    <>
      <button
        type="button"
        className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:transition-none"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={bodyId}
        data-testid={toggleTestId}
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 transition-transform duration-150 motion-reduce:transition-none',
            expanded ? 'rotate-90' : ''
          )}
          aria-hidden
        />
        {label(expanded)}
      </button>
      {expanded && (
        <Body id={bodyId} className={bodyClassName} data-testid={bodyTestId}>
          {children}
        </Body>
      )}
    </>
  )
}

// The "Reviewer log" section: collapsed by default, visually de-emphasized with muted left-rule.
// Reuses WorkspaceMessageItem/activity-style patterns adapted to ReviewerLogEntry (props-driven).
const ReviewerLogSection = ({ log }: { log: ReviewerLogEntry[] }): React.JSX.Element | null => {
  const { t } = useTranslation()
  const wasTruncated = log.some((entry) =>
    entry.kind === 'tool'
      ? Boolean(entry.rawInputTruncated || entry.rawOutputTruncated || entry.reviewLogTruncated)
      : Boolean(entry.textTruncated || entry.reviewLogTruncated)
  )

  // If the log is empty, show nothing (graceful empty state per acceptance criterion).
  if (log.length === 0) return null

  return (
    <section>
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-300">
        {t('Reviewer log')}
      </h3>
      <MutedDisclosure
        label={(expanded) => (expanded ? t('Collapse Reviewer log') : t('Expand Reviewer log'))}
        toggleTestId="reviewer-log-toggle"
        bodyTestId="reviewer-log-body"
        bodyClassName="mt-2 border-l-2 border-border-200 pl-2.5 opacity-75 space-y-0.5"
      >
        {wasTruncated && (
          <p className="pb-1 text-[10px] text-text-400" data-testid="reviewer-log-truncated">
            {t('Reviewer log content was truncated to fit the size limit.')}
          </p>
        )}
        {log.map((entry, i) => (
          <ReviewerLogRow key={i} entry={entry} />
        ))}
      </MutedDisclosure>
    </section>
  )
}

// The Session reviewer panel, rendered inside the right PreviewPanel when toolKind === 'reviewer'.
const SessionReviewerPanel = ({
  review,
  activeFindingId
}: SessionReviewerPanelProps): React.JSX.Element => {
  const { t } = useTranslation()
  const formatDate = useDateTimeFormat()
  const presentedChecks = presentReviewSubmission(review)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 border-b border-border-200 px-4 py-3">
        <h2 className="text-[13px] font-semibold text-text-000">{t('Session Reviewer')}</h2>
        <p className="mt-0.5 text-[11px] text-text-300">
          {review.model} &middot; {formatDate(review.createdAt, 'dateTime')}
        </p>
        {review.stale && (
          <p
            data-testid="reviewer-stale-notice"
            className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:border-amber-800/50 dark:bg-amber-950/20 dark:text-amber-300"
          >
            {t(
              'This turn changed after the review ran (e.g. an artifact was edited). The result below may be out of date — re-run the review to refresh it.'
            )}
          </p>
        )}
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5">
        {/* Unified Checks list */}
        <section data-testid="reviewer-checks">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-300">
            {t('Checks')}
            {presentedChecks.length > 0 && (
              <span className="font-normal text-text-400"> &middot; {presentedChecks.length}</span>
            )}
          </h3>
          {presentedChecks.length === 0 ? (
            <p className="text-xs text-text-400">{t('No checks recorded.')}</p>
          ) : (
            <div className="space-y-2">
              {presentedChecks.map((presented) => (
                <CheckRow
                  key={presented.key}
                  check={presented}
                  isActive={presented.findingId === activeFindingId}
                />
              ))}
            </div>
          )}
        </section>

        {/* Reviewer log section — replaces the old "Full reasoning" prose block */}
        <ReviewerLogSection log={review.reviewerLog ?? []} />
      </div>
    </div>
  )
}

export { SessionReviewerPanel }
