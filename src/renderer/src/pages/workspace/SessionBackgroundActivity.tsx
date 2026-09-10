import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Circle, CircleCheck, CircleX, Clock3, Loader2 } from 'lucide-react'

import type { JobSummary } from '../../../../shared/compute'
import type { NotebookRunRecord, NotebookSessionReference } from '../../../../shared/notebook'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import { backgroundActivityStatusLabel } from './background-activity-presentation'
import { isJobActive, isRunActive } from './use-session-background-tasks'

type Props = {
  sessionId: string
  projectId: string
  /** Undefined until the session's Notebook exists; the Compute Jobs section renders without one. */
  notebook?: NotebookSessionReference
  runs: NotebookRunRecord[]
  jobs: JobSummary[]
  now: number
  onOpenNotebook: (notebook: NotebookSessionReference, runId?: string) => void
  onOpenComputeJob?: (job: JobSummary) => void
  onOpenJobList?: (sessionId: string) => void
}

const terminalStatuses = new Set<NotebookRunRecord['status']>([
  'completed',
  'failed',
  'timeout',
  'interrupted',
  'cancelled'
])

const elapsed = (run: NotebookRunRecord, now: number): string => {
  const seconds = Math.max(0, Math.floor(((run.endedAt ?? now) - run.startedAt) / 1_000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
}

const taskName = (run: NotebookRunRecord): string =>
  run.script
    .split(/\r?\n/u)
    .find((line) => line.trim())
    ?.trim()
    .slice(0, 80) || run.runId

const shellLaneLabel = (
  run: NotebookRunRecord,
  t: (key: string, values?: Record<string, number>) => string
): string | undefined => {
  if (run.kernelKind !== 'bash') return undefined
  const concurrency = run.shellConcurrency
  return concurrency?.slot
    ? t('Shell slot {{slot}} of {{limit}}', {
        slot: concurrency.slot,
        limit: concurrency.limit
      })
    : t('Waiting for shell slot')
}

// Expanded "Background tasks" ledger above the composer. Fed by
// useSessionBackgroundTasks and toggled by the BackgroundTasksChip in the
// strip; data fetching and ordering live in the hook, this component only
// renders sections and owns optimistic cancelling state.
const SessionBackgroundActivityLedger = ({
  sessionId,
  projectId,
  notebook,
  runs,
  jobs,
  now,
  onOpenNotebook,
  onOpenComputeJob,
  onOpenJobList
}: Props): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [cancellationRequests, setCancellationRequests] = useState<Set<string>>(() => new Set())
  const [cancellationErrors, setCancellationErrors] = useState<Map<string, string>>(() => new Map())
  const cancelling = useMemo(() => {
    const activeIds = new Set<string>([
      ...runs.filter(isRunActive).map(({ runId }) => runId),
      ...jobs.filter(isJobActive).map(({ job_id: jobId }) => jobId)
    ])
    return new Set([
      ...[...cancellationRequests].filter((id) => activeIds.has(id)),
      ...runs
        .filter((run) => isRunActive(run) && run.cancellationRequestedAt !== undefined)
        .map((run) => run.runId)
    ])
  }, [cancellationRequests, jobs, runs])
  if (runs.length === 0 && jobs.length === 0) return null

  const columnClass =
    'grid min-w-[680px] grid-cols-[minmax(180px,1.4fr)_110px_110px_90px_140px] items-center gap-2'

  const runStatus = (run: NotebookRunRecord): string => {
    const status = cancelling.has(run.runId) ? 'cancelling' : run.status
    return backgroundActivityStatusLabel(status, undefined, t)
  }

  const jobStatus = (job: JobSummary): string => {
    const isCancelling = cancelling.has(job.job_id) || job.cancellation_status === 'cancelling'
    const effectiveStatus = isCancelling
      ? 'cancelling'
      : job.cancellation_status === 'cancelled'
        ? 'cancelled'
        : job.status
    return backgroundActivityStatusLabel(effectiveStatus, undefined, t)
  }

  const runRow = (run: NotebookRunRecord, ref: NotebookSessionReference): React.JSX.Element => {
    const isActive = isRunActive(run)
    const isCancelling = cancelling.has(run.runId)
    const StatusIcon = isCancelling
      ? Loader2
      : run.status === 'completed'
        ? CircleCheck
        : terminalStatuses.has(run.status)
          ? CircleX
          : run.status === 'queued'
            ? Clock3
            : Circle
    return (
      <div
        key={run.runId}
        className={`${columnClass} min-h-10 border-t border-border-200 px-3 py-1.5 text-[11px]`}
      >
        <span className="min-w-0 truncate font-medium" title={taskName(run)}>
          {taskName(run)}
        </span>
        <span className="truncate text-text-100">
          {run.kernelKind === 'repl'
            ? t('Persistent REPL')
            : (shellLaneLabel(run, t) ??
              run.environment ??
              (run.kernelKind === 'r' ? 'R' : 'Python'))}
        </span>
        <span className="flex items-center gap-1.5 text-text-100" aria-live="polite">
          <StatusIcon
            className={
              isCancelling ? 'size-3.5 animate-spin motion-reduce:animate-none' : 'size-3.5'
            }
            aria-hidden="true"
          />
          {runStatus(run)}
        </span>
        <span className="tabular-nums text-text-100">{elapsed(run, now)}</span>
        <span className="flex justify-end gap-1">
          <Button variant="outline" size="xs" onClick={() => onOpenNotebook(ref, run.runId)}>
            {t('Open')}
          </Button>
          {isActive ? (
            <Button
              variant="destructive"
              size="xs"
              disabled={isCancelling}
              onClick={() => {
                setCancellationErrors((current) => {
                  const next = new Map(current)
                  next.delete(run.runId)
                  return next
                })
                setCancellationRequests((current) => new Set(current).add(run.runId))
                void window.api.notebook
                  .cancelBackgroundRun({
                    ...ref,
                    runId: run.runId,
                    agentFrameId: run.agentFrameId
                  })
                  .catch((error: unknown) => {
                    setCancellationErrors((current) =>
                      new Map(current).set(
                        run.runId,
                        error instanceof Error ? error.message : String(error)
                      )
                    )
                    setCancellationRequests((current) => {
                      const next = new Set(current)
                      next.delete(run.runId)
                      return next
                    })
                  })
              }}
            >
              {t('Cancel')}
            </Button>
          ) : null}
        </span>
        {isActive && cancellationErrors.has(run.runId) ? (
          <ErrorNotice
            className="col-span-full"
            role="alert"
            tone="amber"
            title={t('Cancellation request failed')}
            description={cancellationErrors.get(run.runId)}
          />
        ) : null}
      </div>
    )
  }

  const jobRow = (job: JobSummary): React.JSX.Element => {
    const isActive = isJobActive(job)
    const isCancelling = cancelling.has(job.job_id) || job.cancellation_status === 'cancelling'
    const StatusIcon = isCancelling
      ? Loader2
      : job.status === 'success'
        ? CircleCheck
        : isActive
          ? job.status === 'running'
            ? Circle
            : Clock3
          : CircleX
    const startedAt = job.started_at ?? job.created_at
    const endedAt = job.finished_at ?? (isActive ? now : startedAt)
    const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000))
    const duration = `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
    return (
      <div
        key={`compute:${job.job_id}`}
        className={`${columnClass} min-h-10 border-t border-border-200 px-3 py-1.5 text-[11px]`}
      >
        <span className="min-w-0 truncate font-medium" title={job.intent}>
          {job.intent}
        </span>
        <span className="truncate text-text-100">
          {t('Remote · {{host}}', { host: job.display_name })}
        </span>
        <span className="flex items-center gap-1.5 text-text-100" aria-live="polite">
          <StatusIcon
            className={
              isCancelling ? 'size-3.5 animate-spin motion-reduce:animate-none' : 'size-3.5'
            }
            aria-hidden="true"
          />
          {jobStatus(job)}
        </span>
        <span className="tabular-nums text-text-100">{duration}</span>
        <span className="flex justify-end gap-1">
          <Button variant="outline" size="xs" onClick={() => onOpenComputeJob?.(job)}>
            {t('Open')}
          </Button>
          {isActive ? (
            <Button
              variant="destructive"
              size="xs"
              disabled={isCancelling}
              onClick={() => {
                setCancellationErrors((current) => {
                  const next = new Map(current)
                  next.delete(job.job_id)
                  return next
                })
                setCancellationRequests((current) => new Set(current).add(job.job_id))
                void window.api.compute
                  .jobsCancel({
                    jobId: job.job_id,
                    providerId: job.provider_id,
                    sessionId,
                    projectId
                  })
                  .catch((error: unknown) => {
                    setCancellationErrors((current) =>
                      new Map(current).set(
                        job.job_id,
                        error instanceof Error ? error.message : String(error)
                      )
                    )
                    setCancellationRequests((current) => {
                      const next = new Set(current)
                      next.delete(job.job_id)
                      return next
                    })
                  })
              }}
            >
              {t('Cancel')}
            </Button>
          ) : null}
        </span>
        {isActive && cancellationErrors.has(job.job_id) ? (
          <ErrorNotice
            className="col-span-full"
            role="alert"
            tone="amber"
            title={t('Cancellation request failed')}
            description={cancellationErrors.get(job.job_id)}
          />
        ) : null}
      </div>
    )
  }

  const sectionHeader = (label: string, count: number): React.JSX.Element => (
    <div className="min-w-[680px] border-t border-border-200 bg-bg-100 px-3 py-1 text-[10px] font-semibold tracking-wide text-text-300 uppercase">
      {label} · {count}
    </div>
  )

  return (
    <section
      className="relative z-10 mb-2 max-h-[min(40dvh,24rem)] overflow-auto overscroll-contain rounded-xl border border-border-200 bg-bg-000 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      aria-label={t('Background tasks')}
      tabIndex={0}
      data-testid="session-background-activity"
    >
      <div
        className={`${columnClass} sticky top-0 z-20 bg-bg-200 px-3 py-1.5 text-[10px] font-semibold tracking-wide text-text-300 uppercase`}
      >
        <span>{t('Task')}</span>
        <span>{t('Lane')}</span>
        <span>{t('Status')}</span>
        <span>{t('Elapsed')}</span>
        <span className="text-right">{t('Manage in Session')}</span>
      </div>
      {notebook && runs.length > 0 ? (
        <>
          {sectionHeader(t('Local runs'), runs.length)}
          {runs.map((item) => runRow(item, notebook))}
        </>
      ) : null}
      {jobs.length > 0 ? (
        <>
          <div className="flex min-w-[680px] items-center justify-between border-t border-border-200 bg-bg-100 px-3 py-1 text-[10px] font-semibold tracking-wide text-text-300 uppercase">
            <span>
              {t('Compute jobs')} · {jobs.length}
            </span>
            {onOpenJobList ? (
              <Button
                variant="ghost"
                size="xs"
                className="normal-case tracking-normal"
                onClick={() => onOpenJobList(sessionId)}
              >
                {t('View all jobs')}
              </Button>
            ) : null}
          </div>
          {jobs.map(jobRow)}
        </>
      ) : null}
    </section>
  )
}

const SessionBackgroundActivity = (props: Props): React.JSX.Element => (
  <SessionBackgroundActivityLedger
    key={JSON.stringify([props.projectId, props.sessionId])}
    {...props}
  />
)

export { SessionBackgroundActivity }
