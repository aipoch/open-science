import { formatDuration } from './remote-job-badge-utils'
import { Fragment, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, LoaderCircle, TriangleAlert } from 'lucide-react'
import type { JobSummary } from '../../../shared/compute'
import { Button } from './ui/button'
import { ErrorNotice } from './error-notice'
import { JobCancellationAgentDialog } from './JobCancellationAgentDialog'

export function JobCancellationRecovery({
  job,
  now,
  pending,
  requestFailed,
  onRetry,
  onReviewConnection
}: {
  job: JobSummary
  now: number
  pending: boolean
  requestFailed: boolean
  onRetry: () => Promise<void>
  onReviewConnection?: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [agentOpen, setAgentOpen] = useState(false)
  const failed = job.cancellation_status === 'cancel_failed' || requestFailed
  const active = ['queued', 'submitted', 'running'].includes(job.status)
  if (!active || job.cancellation_status === 'cancelled') return null
  if (!failed && job.cancellation_status !== 'cancelling') return null
  const failureCode = job.cancellation?.failureCode
  const explanation =
    failureCode === 'timeout'
      ? t('The cancellation attempt timed out. The remote job may still be running.')
      : t('The remote job has not been confirmed stopped. Check the connection and retry.')
  return (
    <section
      className="shrink-0 border-b border-border bg-background px-5 py-5"
      data-testid="cancellation-recovery"
    >
      {failed ? (
        <div role="alert" className="space-y-4">
          <ErrorNotice
            inline
            className="w-full"
            icon={TriangleAlert}
            tone="amber"
            title={t('Cancellation failed')}
            description={explanation}
          />
          <div className="flex flex-wrap items-center gap-2 pl-9">
            <Button size="sm" disabled={pending || !job.project_id} onClick={() => void onRetry()}>
              {pending ? (
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
              ) : null}
              {t('Retry cancellation')}
            </Button>
            {onReviewConnection ? (
              <Button variant="outline" size="sm" onClick={onReviewConnection}>
                {t('Review connection settings')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3" role="status">
          <LoaderCircle
            className="mt-0.5 size-5 shrink-0 animate-spin text-muted-foreground"
            aria-hidden="true"
          />
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {t('Cancelling')}
              {job.cancellation ? (
                <span className="ml-2 font-normal tabular-nums text-muted-foreground">
                  {formatDuration(Math.max(0, now - job.cancellation.requestedAt))}
                </span>
              ) : null}
            </p>
            <p className="text-sm leading-6 text-muted-foreground">
              {t('Waiting for confirmation that the remote job has stopped.')}
            </p>
          </div>
        </div>
      )}
      {job.cancellation ? (
        <details className="group mt-5 border-t border-border pt-3 text-xs text-muted-foreground">
          <summary className="flex cursor-pointer list-none items-center gap-2 py-1 font-medium text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight
              className="size-3.5 transition-transform group-open:rotate-90"
              aria-hidden="true"
            />
            {t('Cancellation diagnostics')}
          </summary>
          {/* Diagnostic field names are protocol identifiers, intentionally not translated. */}
          <dl
            data-testid="cancellation-diagnostics"
            className="mt-3 grid grid-cols-[140px_minmax(0,1fr)] gap-x-4 gap-y-2.5 rounded-lg bg-muted/40 p-4 font-mono leading-5 [&_dd]:break-all [&_dd]:text-foreground"
          >
            {Object.entries({
              providerId: job.provider_id,
              jobId: job.job_id,
              attemptCount: job.cancellation.attemptCount,
              updatedAt: new Date(job.cancellation.updatedAt).toISOString(),
              ...(failureCode ? { failureCode } : {})
            }).map(([field, value]) => (
              <Fragment key={field}>
                <dt>{field}</dt>
                <dd>{value}</dd>
              </Fragment>
            ))}
          </dl>
          {failed ? (
            <div className="mt-4 space-y-3 pl-1">
              <p className="max-w-lg text-xs leading-5">
                {t(
                  'You can also allow an agent to inspect this job over SSH and attempt to stop it.'
                )}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={() => setAgentOpen(true)}
                data-testid="job-agent-help"
              >
                {t('Ask an agent to investigate…')}
              </Button>
            </div>
          ) : null}
        </details>
      ) : null}
      {agentOpen && failed ? (
        <JobCancellationAgentDialog job={job} onClose={() => setAgentOpen(false)} />
      ) : null}
    </section>
  )
}
