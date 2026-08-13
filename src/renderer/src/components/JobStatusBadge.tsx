import { useTranslation } from 'react-i18next'

import type { ComputeJobStatus } from '../../../shared/compute'

// Maps job status to badge styling. Follows design.md §6 badge pattern (same conventions as ReviewCard).
// Terminal statuses consolidate under semantic groups: success=Done, error/failed/timeout=Failed.
// The label is a catalog key rather than literal text — the map is module-level, so it cannot call a
// hook; the component resolves it at render time and re-resolves when the language changes.
// `as const satisfies` rather than a plain annotation: the literal key strings must survive for t()'s
// compile-time key checking, while `satisfies` still forces every ComputeJobStatus to be covered.
const STATUS_STYLE = {
  queued: {
    labelKey: 'Queued',
    className:
      'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-950/40 dark:text-slate-400 dark:border-slate-800/50'
  },
  submitted: {
    labelKey: 'Queued',
    className:
      'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-950/40 dark:text-slate-400 dark:border-slate-800/50'
  },
  running: {
    labelKey: 'Running',
    className:
      'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/20 dark:text-amber-300 dark:border-amber-800/50'
  },
  success: {
    labelKey: 'Done',
    className:
      'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/20 dark:text-green-300 dark:border-green-800/50'
  },
  failed: {
    labelKey: 'Failed',
    className:
      'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/20 dark:text-red-300 dark:border-red-800/50'
  },
  timeout: {
    labelKey: 'Timeout',
    className:
      'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/20 dark:text-red-300 dark:border-red-800/50'
  },
  error: {
    labelKey: 'Error',
    className:
      'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/20 dark:text-red-300 dark:border-red-800/50'
  }
} as const satisfies Record<ComputeJobStatus, { labelKey: string; className: string }>

type JobStatusBadgeProps = {
  status: ComputeJobStatus
}

// Status badge for job detail modal header (top-right). Follows design.md §6 color table.
export function JobStatusBadge({ status }: JobStatusBadgeProps): React.JSX.Element {
  const { t } = useTranslation()
  const { labelKey, className } = STATUS_STYLE[status]
  return (
    <span
      data-testid="job-status-badge"
      className={`inline-flex items-center rounded border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ${className}`}
    >
      {t(labelKey)}
    </span>
  )
}
