import { useTranslation } from 'react-i18next'

import type { ComputeJobCancellationStatus, ComputeJobStatus } from '../../../shared/compute'

// Maps job status to badge styling. Follows design.md §6 badge pattern (same conventions as ReviewCard).
// Terminal statuses consolidate under semantic groups: success=Done, error/failed/timeout=Failed.
// The label is a catalog key rather than literal text — the map is module-level, so it cannot call a
// hook; the component resolves it at render time and re-resolves when the language changes.
// `as const satisfies` rather than a plain annotation: the literal key strings must survive for t()'s
// compile-time key checking, while `satisfies` still forces every ComputeJobStatus to be covered.
const STATUS_STYLE = {
  queued: {
    labelKey: 'Waiting in queue',
    className: 'border-border bg-muted text-muted-foreground'
  },
  submitted: {
    labelKey: 'Submitting',
    className: 'border-border bg-muted text-muted-foreground'
  },
  running: {
    labelKey: 'Running',
    className:
      'border-transparent bg-status-warning-surface text-status-warning-foreground dark:bg-status-warning-dark-surface dark:text-status-warning-dark-foreground'
  },
  success: {
    labelKey: 'Done',
    className:
      'border-transparent bg-status-success-surface text-status-success-foreground dark:bg-status-success-dark-surface dark:text-status-success-dark-foreground'
  },
  failed: {
    labelKey: 'Failed',
    className:
      'border-transparent bg-status-failure-surface text-status-failure-foreground dark:bg-status-failure-dark-surface dark:text-status-failure-dark-foreground'
  },
  timeout: {
    labelKey: 'Timeout',
    className:
      'border-transparent bg-status-failure-surface text-status-failure-foreground dark:bg-status-failure-dark-surface dark:text-status-failure-dark-foreground'
  },
  error: {
    labelKey: 'Error',
    className:
      'border-transparent bg-status-failure-surface text-status-failure-foreground dark:bg-status-failure-dark-surface dark:text-status-failure-dark-foreground'
  }
} as const satisfies Record<ComputeJobStatus, { labelKey: string; className: string }>

type JobStatusBadgeProps = {
  status: ComputeJobStatus
  cancellationStatus?: ComputeJobCancellationStatus
}

// Status badge for job detail modal header (top-right). Follows design.md §6 color table.
export function JobStatusBadge({
  status,
  cancellationStatus
}: JobStatusBadgeProps): React.JSX.Element {
  const { t } = useTranslation()
  const { labelKey, className } = cancellationStatus
    ? {
        labelKey: cancellationStatus === 'cancelled' ? 'Cancelled' : 'Cancelling',
        className:
          cancellationStatus === 'cancelled'
            ? 'border-border bg-muted text-muted-foreground'
            : 'border-transparent bg-status-warning-surface text-status-warning-foreground dark:bg-status-warning-dark-surface dark:text-status-warning-dark-foreground'
      }
    : STATUS_STYLE[status]
  return (
    <span
      data-testid="job-status-badge"
      className={`inline-flex items-center rounded border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ${className}`}
    >
      {t(labelKey)}
    </span>
  )
}
