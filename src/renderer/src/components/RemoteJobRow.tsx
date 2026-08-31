import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Zap, ChevronRight } from 'lucide-react'

import type { JobSummary } from '../../../shared/compute'
import { formatDuration, jobElapsedMs } from './remote-job-badge-utils'

// RemoteJobRow appears at the bottom of the repl_execute tool-call block that submitted a job.
// Design: design.md §5a — ⚡ host alias | intent | running · elapsed ›
// The row stays at its originating tool activity through terminal completion.
// Clicking the row opens JobDetailModal.

type RemoteJobRowProps = {
  job: JobSummary
  onOpen: (job: JobSummary) => void
}

export function RemoteJobRow({ job, onOpen }: RemoteJobRowProps): React.JSX.Element {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())

  // Tick every second while the job is still running so elapsed time stays fresh.
  useEffect(() => {
    if (job.status !== 'running' && job.status !== 'submitted') return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [job.status])

  const elapsedMs = jobElapsedMs(job, now)
  const elapsedStr = formatDuration(elapsedMs)

  // Truncate long intent text to keep the row compact
  const intentDisplay = job.intent.length > 60 ? `${job.intent.slice(0, 57)}…` : job.intent
  const statusLabel = (() => {
    if (job.cancellation_status === 'cancelling') return t('Cancelling')
    if (job.cancellation_status === 'cancelled') return t('Cancelled')
    switch (job.status) {
      case 'queued':
        return t('Waiting in queue')
      case 'submitted':
        return t('Submitting')
      case 'running':
        return t('Running')
      case 'success':
        return t('finished')
      case 'failed':
        return t('failed')
      case 'timeout':
        return t('timed out')
      case 'error':
        return t('error')
    }
  })()
  const showElapsed =
    job.cancellation_status !== 'cancelled' &&
    (job.status === 'queued' || job.status === 'submitted' || job.status === 'running')

  return (
    <button
      type="button"
      data-testid="remote-job-row"
      className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
      onClick={() => onOpen(job)}
      aria-label={t('Remote job: {{intent}}', { intent: job.intent })}
    >
      <Zap
        size={12}
        style={{ color: 'var(--session-waiting)', flexShrink: 0 }}
        aria-hidden="true"
      />
      <span className="text-[11px] text-muted-foreground shrink-0">{job.display_name}</span>
      <span className="flex-1 min-w-0 truncate text-[12px] text-secondary-foreground">
        {intentDisplay}
      </span>
      <span className="text-[11px] shrink-0" style={{ color: 'var(--session-waiting)' }}>
        {statusLabel}
        {showElapsed ? ` · ${elapsedStr}` : ''}
      </span>
      <ChevronRight size={12} className="text-muted-foreground shrink-0" aria-hidden="true" />
    </button>
  )
}
