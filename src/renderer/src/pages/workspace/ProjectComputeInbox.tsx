import { computeQueueBlockedLabel } from '@/lib/compute/queue-blocked-label'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, ChevronDown, Cpu, RadioTower } from 'lucide-react'

import type { JobSummary } from '../../../../shared/compute'
import type {
  NotebookProjectActivity,
  NotebookProjectBackgroundRunActivity,
  NotebookProjectKernelActivity
} from '../../../../shared/notebook'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useRelativeTimeFormat } from '@/hooks/useDateTimeFormat'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore } from '@/stores/session-store'
import { backgroundActivityStatusLabel } from './background-activity-presentation'

const RECENT_COMPUTE_WINDOW_MS = 48 * 60 * 60 * 1_000
const EMPTY_NOTEBOOK_ACTIVITY: NotebookProjectActivity = { kernels: [], backgroundRuns: [] }
const EMPTY_JOBS: JobSummary[] = []
const ACTIVE_COMPUTE_JOB_STATUSES = new Set<JobSummary['status']>([
  'queued',
  'submitted',
  'running'
])

const kernelLabel = (
  kernel: NotebookProjectKernelActivity,
  t: ReturnType<typeof useTranslation>['t']
): string => {
  if (kernel.kind === 'repl') return t('JavaScript REPL')
  const language = kernel.kind === 'r' ? 'R' : 'Python'
  return kernel.environment ? `${language} · ${kernel.environment}` : language
}

const kernelStatusLabel = (
  status: NotebookProjectKernelActivity['status'],
  t: ReturnType<typeof useTranslation>['t']
): string => {
  if (status === 'idle') return t('Idle')
  if (status === 'starting') return t('Starting')
  if (status === 'restarting') return t('Restarting')
  return t('Running')
}

const kernelStatusClassName = (status: NotebookProjectKernelActivity['status']): string => {
  if (status === 'running') {
    return 'inline-flex rounded-full bg-status-success-surface px-2 py-0.5 text-[10px] font-semibold text-status-success-foreground dark:bg-status-success-dark-surface dark:text-status-success-dark-foreground'
  }
  if (status === 'idle') {
    return 'inline-flex rounded-full bg-bg-100 px-2 py-0.5 text-[10px] font-semibold text-text-100'
  }
  return 'inline-flex rounded-full bg-status-warning-surface px-2 py-0.5 text-[10px] font-semibold text-status-warning-foreground dark:bg-status-warning-dark-surface dark:text-status-warning-dark-foreground'
}

const jobStatusLabel = (job: JobSummary, t: ReturnType<typeof useTranslation>['t']): string =>
  (job.status === 'queued' && !job.cancellation_status
    ? computeQueueBlockedLabel(job.queue_blocked_reason, t)
    : undefined) ??
  backgroundActivityStatusLabel(
    job.cancellation_status === 'cancelling'
      ? 'cancelling'
      : job.cancellation_status === 'cancelled'
        ? 'cancelled'
        : job.status,
    undefined,
    t
  )

const ProjectComputeInbox = (): React.JSX.Element => {
  const { t } = useTranslation()
  const formatRelativeTime = useRelativeTimeFormat()
  const projectId = useNavigationStore((state) => state.activeProjectId)
  const openSession = useNavigationStore((state) => state.openSession)
  const sessions = useSessionStore((state) => state.sessions)
  const currentSessionId = useSessionStore((state) => state.selectedSessionId)
  const [notebookSnapshot, setNotebookSnapshot] = useState<{
    projectId: string
    activity: NotebookProjectActivity
  }>()
  const [jobsSnapshot, setJobsSnapshot] = useState<{ projectId: string; jobs: JobSummary[] }>()
  const [recentSince, setRecentSince] = useState(() => Date.now() - RECENT_COMPUTE_WINDOW_MS)
  const notebookActivity =
    projectId && notebookSnapshot?.projectId === projectId
      ? notebookSnapshot.activity
      : EMPTY_NOTEBOOK_ACTIVITY
  const jobs = projectId && jobsSnapshot?.projectId === projectId ? jobsSnapshot.jobs : EMPTY_JOBS

  useEffect(() => {
    if (!projectId) return
    let alive = true
    let requestVersion = 0
    const load = async (): Promise<void> => {
      const version = ++requestVersion
      const activity = await window.api.notebook
        .getProjectActivity({ projectId })
        .catch(() => undefined)
      if (alive && version === requestVersion && activity) {
        setNotebookSnapshot({ projectId, activity })
      }
    }
    const stop = window.api.notebook.onChanged((event) => {
      if (event.projectId === projectId) void load()
    })
    void load()
    return () => {
      alive = false
      stop()
    }
  }, [projectId])

  useEffect(() => {
    if (!projectId) return
    let alive = true
    let requestVersion = 0
    const load = async (): Promise<void> => {
      const version = ++requestVersion
      const next = await window.api.compute
        .jobsList({ projectId, since: recentSince })
        .catch(() => [])
      if (alive && version === requestVersion) setJobsSnapshot({ projectId, jobs: next })
    }
    const stop = window.api.compute.onJobUpdated((job) => {
      if (job.project_id === projectId) void load()
    })
    void load()
    return () => {
      alive = false
      stop()
    }
  }, [projectId, recentSince])

  useEffect(() => {
    const nextExpiry = Math.min(
      ...jobs
        .filter(
          (job) =>
            !ACTIVE_COMPUTE_JOB_STATUSES.has(job.status) && job.cancellation_status !== 'cancelling'
        )
        .map((job) => (job.finished_at ?? job.created_at) + RECENT_COMPUTE_WINDOW_MS)
    )
    if (!Number.isFinite(nextExpiry)) return
    const timer = window.setTimeout(
      () => setRecentSince(Date.now() - RECENT_COMPUTE_WINDOW_MS),
      Math.max(0, nextExpiry - Date.now() + 1)
    )
    return () => window.clearTimeout(timer)
  }, [jobs])

  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session] as const)),
    [sessions]
  )
  const kernels = useMemo(() => {
    const latestBySession = new Map<string, NotebookProjectKernelActivity>()
    for (const kernel of notebookActivity.kernels) {
      const previous = latestBySession.get(kernel.sessionId)
      if (!previous || kernel.lastActivityAt > previous.lastActivityAt) {
        latestBySession.set(kernel.sessionId, kernel)
      }
    }
    return [...latestBySession.values()].sort((left, right) => {
      const leftCurrent = left.sessionId === currentSessionId
      const rightCurrent = right.sessionId === currentSessionId
      if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1
      return (
        left.sessionId.localeCompare(right.sessionId) ||
        left.processKey.localeCompare(right.processKey)
      )
    })
  }, [currentSessionId, notebookActivity.kernels])
  const latestBackgroundRunBySessionAndKernel = useMemo(() => {
    const bySession = new Map<string, Map<string, NotebookProjectBackgroundRunActivity>>()
    for (const run of notebookActivity.backgroundRuns) {
      if (!run.processKey) continue
      let byKernel = bySession.get(run.sessionId)
      if (!byKernel) {
        byKernel = new Map()
        bySession.set(run.sessionId, byKernel)
      }
      const previous = byKernel.get(run.processKey)
      if (!previous || run.acceptedAt > previous.acceptedAt) {
        byKernel.set(run.processKey, run)
      }
    }
    return bySession
  }, [notebookActivity.backgroundRuns])

  const goToSession = (sessionId: string): void => {
    if (projectId && sessionById.has(sessionId)) openSession(projectId, sessionId, 'user')
  }

  return (
    <section
      className="@container/compute flex h-full min-h-0 flex-col bg-bg-10"
      aria-labelledby="project-compute-title"
    >
      <header className="border-b border-border-200 px-6 py-4">
        <h1 id="project-compute-title" className="text-lg font-semibold">
          {t('Compute')}
        </h1>
        <p className="mt-1 text-xs text-text-100">
          {t(
            'Active kernels, active Compute Jobs, and Compute Jobs completed in the last 48 hours.'
          )}
        </p>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 px-6 py-4">
          <section aria-labelledby="active-kernels-title">
            {kernels.length === 0 ? (
              <div className="overflow-hidden rounded-lg border border-border-200 bg-bg-000">
                <h2
                  id="active-kernels-title"
                  className="border-b border-border-200 px-3.5 py-3 text-sm font-semibold"
                >
                  {t('Active kernels')} · {kernels.length}
                </h2>
                <div className="px-3 py-6 text-center text-xs text-text-100">
                  {t('No active kernels')}
                </div>
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border-200 bg-bg-000">
                <h2
                  id="active-kernels-title"
                  className="border-b border-border-200 px-3.5 py-3 text-sm font-semibold"
                >
                  {t('Active kernels')} · {kernels.length}
                </h2>
                <div
                  role="row"
                  className="hidden grid-cols-[minmax(180px,1.15fr)_minmax(220px,1.4fr)_100px_28px] gap-4 border-b border-border-200 bg-bg-10 px-3.5 py-2 text-[10px] font-semibold tracking-wide text-text-100 uppercase @3xl/compute:grid"
                >
                  <span role="columnheader">{t('Session')}</span>
                  <span role="columnheader">{t('Kernel')}</span>
                  <span role="columnheader">{t('Status')}</span>
                  <span aria-hidden="true" />
                </div>
                {kernels.map((kernel) => {
                  const workload = latestBackgroundRunBySessionAndKernel
                    .get(kernel.sessionId)
                    ?.get(kernel.processKey)
                  const session = sessionById.get(kernel.sessionId)
                  return (
                    <div
                      key={`${kernel.sessionId}:${kernel.processKey}`}
                      className="relative border-t border-border-200 px-3.5 py-3 text-xs first:border-t-0"
                    >
                      <div className="flex min-w-0 items-center gap-2 pr-8 @3xl/compute:hidden">
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-bg-100 text-text-100">
                          <Cpu className="size-3.5" aria-hidden="true" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate font-medium">
                              {session?.title ?? t('Deleted Session')}
                            </span>
                            <span className={kernelStatusClassName(kernel.status)}>
                              {kernelStatusLabel(kernel.status, t)}
                            </span>
                          </div>
                          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-text-100">
                            <span className="shrink-0">{kernelLabel(kernel, t)}</span>
                            {workload ? (
                              <>
                                <span className="shrink-0 rounded border border-border-300 bg-bg-100 px-1.5 py-0.5 text-[10px] font-semibold text-text-200">
                                  {t('Background')}
                                </span>
                                <span className="truncate" title={workload.title}>
                                  {workload.title}
                                </span>
                              </>
                            ) : null}
                          </div>
                        </div>
                      </div>
                      <dl className="hidden grid-cols-[minmax(180px,1.15fr)_minmax(220px,1.4fr)_100px_28px] items-center gap-4 @3xl/compute:grid">
                        <div>
                          <dt className="sr-only">{t('Session')}</dt>
                          <dd className="flex min-w-0 items-center gap-2 font-medium">
                            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-bg-100 text-text-100">
                              <Cpu className="size-3.5" aria-hidden="true" />
                            </span>
                            <span className="truncate">
                              {session?.title ?? t('Deleted Session')}
                            </span>
                          </dd>
                        </div>
                        <div>
                          <dt className="sr-only">{t('Kernel')}</dt>
                          <dd className="min-w-0">
                            <div className="flex min-w-0 flex-wrap items-center gap-1.5 font-medium">
                              <span className="truncate">{kernelLabel(kernel, t)}</span>
                              {workload ? (
                                <span className="shrink-0 rounded border border-border-300 bg-bg-100 px-1.5 py-0.5 text-[10px] font-semibold text-text-200">
                                  {t('Background')}
                                </span>
                              ) : null}
                            </div>
                            {workload ? (
                              <div
                                className="mt-1 min-w-0 truncate text-[11px] font-normal text-text-100"
                                title={workload.title}
                              >
                                {workload.title}
                              </div>
                            ) : null}
                          </dd>
                        </div>
                        <div>
                          <dt className="sr-only">{t('Status')}</dt>
                          <dd>
                            <span className={kernelStatusClassName(kernel.status)}>
                              {kernelStatusLabel(kernel.status, t)}
                            </span>
                          </dd>
                        </div>
                        <div aria-hidden="true" />
                      </dl>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="absolute top-3 right-3 text-text-100 hover:text-text-000 @3xl/compute:top-1/2 @3xl/compute:-translate-y-1/2"
                        disabled={!session}
                        aria-label={t('Go to Session')}
                        title={t('Go to Session')}
                        onClick={() => goToSession(kernel.sessionId)}
                      >
                        <ArrowUpRight aria-hidden="true" />
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <section aria-labelledby="compute-jobs-title">
            {jobs.length === 0 ? (
              <div className="overflow-hidden rounded-lg border border-border-200 bg-bg-000">
                <h2
                  id="compute-jobs-title"
                  className="border-b border-border-200 px-3.5 py-3 text-sm font-semibold"
                >
                  {t('Compute jobs')} · {jobs.length}
                </h2>
                <div className="px-3 py-6 text-center text-xs text-text-100">
                  {t('No active or recently completed Compute Jobs.')}
                </div>
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border-200 bg-bg-000">
                <h2
                  id="compute-jobs-title"
                  className="border-b border-border-200 px-3.5 py-3 text-sm font-semibold"
                >
                  {t('Compute jobs')} · {jobs.length}
                </h2>
                <div
                  role="row"
                  className="hidden grid-cols-[minmax(200px,1.35fr)_minmax(160px,1fr)_minmax(140px,1fr)_100px_110px_28px] gap-4 border-b border-border-200 bg-bg-10 px-3.5 py-2 text-[10px] font-semibold tracking-wide text-text-100 uppercase @3xl/compute:grid"
                >
                  <span role="columnheader">{t('Task')}</span>
                  <span role="columnheader">{t('Session')}</span>
                  <span role="columnheader">{t('Host')}</span>
                  <span role="columnheader">{t('Status')}</span>
                  <span role="columnheader">{t('Updated')}</span>
                  <span aria-hidden="true" />
                </div>
                {jobs.map((job) => {
                  const session = sessionById.get(job.session_id)
                  const updatedAt = job.finished_at ?? job.started_at ?? job.created_at
                  return (
                    <div
                      key={job.job_id}
                      className="relative border-t border-border-200 px-3.5 py-3 text-xs first:border-t-0"
                    >
                      <details className="group pr-8 @3xl/compute:hidden">
                        <summary className="flex cursor-pointer list-none items-center gap-2 pr-1 [&::-webkit-details-marker]:hidden">
                          <RadioTower
                            className="size-3.5 shrink-0 text-text-100"
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium" title={job.intent}>
                              {job.intent}
                            </span>
                            <span className="mt-1 flex items-center gap-1.5 text-[11px] text-text-100">
                              <span>{jobStatusLabel(job, t)}</span>
                              <span aria-hidden="true">·</span>
                              <time dateTime={new Date(updatedAt).toISOString()}>
                                {formatRelativeTime(updatedAt)}
                              </time>
                            </span>
                          </span>
                          <ChevronDown
                            className="size-3.5 shrink-0 transition-transform group-open:rotate-180"
                            aria-hidden="true"
                          />
                        </summary>
                        <dl className="mt-3 grid gap-2 border-t border-border-200 pt-3">
                          <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
                            <dt className="text-[10px] font-semibold tracking-wide text-text-100 uppercase">
                              {t('Session')}
                            </dt>
                            <dd className="truncate text-text-100">
                              {session?.title ?? t('Deleted Session')}
                            </dd>
                          </div>
                          <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
                            <dt className="text-[10px] font-semibold tracking-wide text-text-100 uppercase">
                              {t('Host')}
                            </dt>
                            <dd className="truncate text-text-100">{job.display_name}</dd>
                          </div>
                        </dl>
                      </details>
                      <dl className="hidden grid-cols-[minmax(200px,1.35fr)_minmax(160px,1fr)_minmax(140px,1fr)_100px_110px_28px] items-center gap-4 @3xl/compute:grid">
                        <div>
                          <dt className="sr-only">{t('Task')}</dt>
                          <dd className="flex min-w-0 items-center gap-2 font-medium">
                            <RadioTower
                              className="size-3.5 shrink-0 text-text-100"
                              aria-hidden="true"
                            />
                            <span className="truncate" title={job.intent}>
                              {job.intent}
                            </span>
                          </dd>
                        </div>
                        <div>
                          <dt className="sr-only">{t('Session')}</dt>
                          <dd className="truncate text-text-100">
                            {session?.title ?? t('Deleted Session')}
                          </dd>
                        </div>
                        <div>
                          <dt className="sr-only">{t('Host')}</dt>
                          <dd className="truncate text-text-100">{job.display_name}</dd>
                        </div>
                        <div>
                          <dt className="sr-only">{t('Status')}</dt>
                          <dd className="text-text-100">{jobStatusLabel(job, t)}</dd>
                        </div>
                        <div>
                          <dt className="sr-only">{t('Updated')}</dt>
                          <dd>
                            <time
                              dateTime={new Date(updatedAt).toISOString()}
                              className="text-text-100"
                            >
                              {formatRelativeTime(updatedAt)}
                            </time>
                          </dd>
                        </div>
                        <div aria-hidden="true" />
                      </dl>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="absolute top-3 right-3 text-text-100 hover:text-text-000 @3xl/compute:top-1/2 @3xl/compute:-translate-y-1/2"
                        disabled={!session}
                        aria-label={t('Go to Session')}
                        title={t('Go to Session')}
                        onClick={() => goToSession(job.session_id)}
                      >
                        <ArrowUpRight aria-hidden="true" />
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        </div>
      </ScrollArea>
    </section>
  )
}

export { ProjectComputeInbox }
