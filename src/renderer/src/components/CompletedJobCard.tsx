import { Zap, ChevronRight } from 'lucide-react'

import type { JobSummary } from '../../../shared/compute'

// CompletedJobCard appears in the conversation timeline as an independent card.
// Used when a job's job_id was NOT found in any tool-call rawOutput
// (fallback: placed at createdAt position in the timeline).
// Also shown for completed jobs (success/failed/timeout/error).
// Design: design.md §5b — rounded card, green for finished, red for failed/error/timeout.

type CompletedJobCardProps = {
  job: JobSummary
  onOpen: (job: JobSummary) => void
}

// Returns the status label and color class based on job status.
function getStatusDisplay(job: JobSummary): { label: string; colorClass: string } {
  switch (job.status) {
    case 'success':
      return { label: 'finished', colorClass: 'text-green-600' }
    case 'failed':
      return { label: 'failed', colorClass: 'text-red-600' }
    case 'timeout':
      return { label: 'timed out', colorClass: 'text-red-600' }
    case 'error':
      return { label: 'error', colorClass: 'text-red-600' }
    default:
      return { label: job.status, colorClass: 'text-muted-foreground' }
  }
}

export function CompletedJobCard({ job, onOpen }: CompletedJobCardProps): React.JSX.Element {
  const { label, colorClass } = getStatusDisplay(job)

  const intentDisplay = job.intent.length > 70 ? `${job.intent.slice(0, 67)}…` : job.intent

  return (
    <button
      type="button"
      data-testid="completed-job-card"
      className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-muted/30 px-3.5 py-2.5 text-left text-[12px] hover:bg-muted/50 transition-colors"
      onClick={() => onOpen(job)}
      aria-label={`Completed remote job: ${job.intent}`}
    >
      <Zap size={13} className={colorClass} aria-hidden="true" style={{ flexShrink: 0 }} />
      <span className="text-[11px] text-muted-foreground shrink-0">{job.display_name}</span>
      <span className="flex-1 min-w-0 truncate text-secondary-foreground">{intentDisplay}</span>
      <span className={`text-[11px] shrink-0 ${colorClass}`}>— {label}</span>
      <ChevronRight size={12} className="text-muted-foreground shrink-0" aria-hidden="true" />
    </button>
  )
}
