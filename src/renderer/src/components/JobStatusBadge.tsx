import type { ComputeJobStatus } from '../../../shared/compute'

// Maps job status to badge styling. Follows design.md §6 badge pattern (same conventions as ReviewCard).
// Terminal statuses consolidate under semantic groups: success=Done, error/failed/timeout=Failed.
const STATUS_STYLE: Record<ComputeJobStatus, { label: string; className: string }> = {
  queued: {
    label: 'Queued',
    className: 'bg-slate-100 text-slate-600 border-slate-200'
  },
  submitted: {
    label: 'Queued',
    className: 'bg-slate-100 text-slate-600 border-slate-200'
  },
  running: {
    label: 'Running',
    className: 'bg-amber-50 text-amber-700 border-amber-200'
  },
  success: {
    label: 'Done',
    className: 'bg-green-50 text-green-700 border-green-200'
  },
  failed: {
    label: 'Failed',
    className: 'bg-red-50 text-red-700 border-red-200'
  },
  timeout: {
    label: 'Timeout',
    className: 'bg-red-50 text-red-700 border-red-200'
  },
  error: {
    label: 'Error',
    className: 'bg-red-50 text-red-700 border-red-200'
  }
}

type JobStatusBadgeProps = {
  status: ComputeJobStatus
}

// Status badge for job detail modal header (top-right). Follows design.md §6 color table.
export function JobStatusBadge({ status }: JobStatusBadgeProps): React.JSX.Element {
  const { label, className } = STATUS_STYLE[status]
  return (
    <span
      data-testid="job-status-badge"
      className={`inline-flex items-center rounded border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ${className}`}
    >
      {label}
    </span>
  )
}
