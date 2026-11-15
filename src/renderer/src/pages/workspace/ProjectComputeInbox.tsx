import { computeQueueBlockedLabel } from '@/lib/compute/queue-blocked-label'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isComputeJobCancelled, isComputeJobTrackingStopped } from '@aipoch/compute'
import { ArrowUpRight, ChevronDown, RadioTower } from 'lucide-react'

import {
  externalComputeMode,
  isComputeProviderId,
  type JobSummary
} from '../../../../shared/compute'
import type { NotebookProjectActivity } from '../../../../shared/notebook'
import type { NotebookProjectResources } from '../../../../shared/notebook-resources'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useRelativeTimeFormat } from '@/hooks/useDateTimeFormat'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore } from '@/stores/session-store'
import { backgroundActivityStatusLabel } from './background-activity-presentation'
import { NotebookResourcePanel } from './NotebookResourcePanel'

const RECENT_COMPUTE_WINDOW_MS = 48 * 60 * 60 * 1_000
const EMPTY_NOTEBOOK_ACTIVITY: NotebookProjectActivity = { kernels: [], backgroundRuns: [] }
const EMPTY_NOTEBOOK_RESOURCES: NotebookProjectResources = {
  groups: [],
  pendingDecisions: [],
  releases: []
}
const EMPTY_JOBS: JobSummary[] = []
const ACTIVE_COMPUTE_JOB_STATUSES = new Set<JobSummary['status']>([
  'queued',
  'submitted',
  'running'
])

// Events invalidate snapshots. Keep one read in flight and one trailing refresh, so a burst
// cannot fan out queries or let an already-invalidated response replace the last good data.
const createActivityRefresh = <T,>(
  read: () => Promise<T>,
  publish: (value: T) => void,
  canRead: () => boolean = () => true
): { refresh: () => void; poll: () => void; dispose: () => void } => {
  let active = true
  let loading = false
  let pending = false
  let retries = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const clearRetry = (): void => {
    clearTimeout(timer)
    timer = undefined
  }
  const load = async (): Promise<void> => {
    if (!active || !canRead()) return
    if (loading) {
      pending = true
      return
    }
    loading = true
    do {
      pending = false
      try {
        const value = await read()
        if (active && canRead() && !pending) publish(value)
        retries = 0
      } catch {
        // Keep the last good snapshot. A missed terminal update may have no later event.
        if (active && canRead() && !pending && retries < 3) {
          timer = setTimeout(
            () => {
              timer = undefined
              void load()
            },
            1_000 * 2 ** retries++
          )
        }
      }
    } while (active && canRead() && pending)
    loading = false
  }
  return {
    refresh: (): void => {
      if (!active) return
      clearRetry()
      retries = 0
      void load()
    },
    poll: (): void => {
      if (!loading && !timer) void load()
    },
    dispose: (): void => {
      active = false
      clearRetry()
    }
  }
}

const jobStatusLabel = (job: JobSummary, t: ReturnType<typeof useTranslation>['t']): string => {
  if (isComputeJobTrackingStopped(job)) return t('Unable to confirm cancellation')
  return (
    (job.status === 'queued' &&
    job.cancellation_status !== 'cancelling' &&
    !isComputeJobCancelled(job)
      ? computeQueueBlockedLabel(job.queue_blocked_reason, t)
      : undefined) ??
    backgroundActivityStatusLabel(
      isComputeJobCancelled(job)
        ? 'cancelled'
        : job.cancellation_status === 'cancelling'
          ? 'cancelling'
          : job.status,
      undefined,
      t
    )
  )
}

const backendLabels = {
  direct_ssh: 'Direct SSH',
  slurm: 'Slurm',
  kubernetes: 'Kubernetes',
  hugging_face_jobs: 'Hugging Face Jobs',
  ray_jobs: 'Ray Jobs',
  modal_sandbox: 'Modal Sandboxes'
} as const

function jobTargetLabel(job: JobSummary, t: ReturnType<typeof useTranslation>['t']): string {
  const mode =
    job.execution_mode ??
    (isComputeProviderId(job.provider_id) ? externalComputeMode(job.provider_id) : undefined)
  const name = job.display_name || job.provider_id
  if (!mode || !Object.hasOwn(backendLabels, mode)) return name
  const backend = t(backendLabels[mode])
  return name === backend ? name : `${backend} · ${name}`
}

const ProjectComputeInbox = ({ isActive = true }: { isActive?: boolean }): React.JSX.Element => {
  const { t } = useTranslation()
  const formatRelativeTime = useRelativeTimeFormat()
  const projectId = useNavigationStore((state) => state.activeProjectId)
  const openSession = useNavigationStore((state) => state.openSession)
  const sessions = useSessionStore((state) => state.sessions)
  const refreshNotebook = useRef<() => void>(() => undefined)
  const pollNotebook = useRef<() => void>(() => undefined)
  const notebookVisible = useRef(isActive)
  const [notebookSnapshot, setNotebookSnapshot] = useState<{
    projectId: string
    activity: NotebookProjectActivity
    resources: NotebookProjectResources
    observedAt: number
  }>()
  const [jobsSnapshot, setJobsSnapshot] = useState<{ projectId: string; jobs: JobSummary[] }>()
  const [recentSince, setRecentSince] = useState(() => Date.now() - RECENT_COMPUTE_WINDOW_MS)
  const notebookActivity =
    projectId && notebookSnapshot?.projectId === projectId
      ? notebookSnapshot.activity
      : EMPTY_NOTEBOOK_ACTIVITY
  const jobs = projectId && jobsSnapshot?.projectId === projectId ? jobsSnapshot.jobs : EMPTY_JOBS
  const notebookResources =
    projectId && notebookSnapshot?.projectId === projectId
      ? notebookSnapshot.resources
      : EMPTY_NOTEBOOK_RESOURCES

  useEffect(() => {
    notebookVisible.current = isActive
    if (isActive) refreshNotebook.current()
  }, [isActive])

  useEffect(() => {
    if (!projectId) return
    const refresh = createActivityRefresh(
      async () => {
        const [activity, resources] = await Promise.all([
          window.api.notebook.getProjectActivity({ projectId }),
          window.api.notebook.getProjectResources({ projectId })
        ])
        return { activity, resources, observedAt: Date.now() }
      },
      (snapshot) => setNotebookSnapshot({ projectId, ...snapshot }),
      () => notebookVisible.current && document.visibilityState !== 'hidden'
    )
    refreshNotebook.current = refresh.refresh
    pollNotebook.current = refresh.poll
    const stop = window.api.notebook.onChanged((event) => {
      if (event.projectId === projectId) refresh.refresh()
    })
    const resume = (): void => {
      if (document.visibilityState !== 'hidden') refresh.refresh()
    }
    document.addEventListener('visibilitychange', resume)
    refresh.refresh()
    return () => {
      refreshNotebook.current = () => undefined
      pollNotebook.current = () => undefined
      document.removeEventListener('visibilitychange', resume)
      refresh.dispose()
      stop()
    }
  }, [projectId])

  useEffect(() => {
    if (!projectId || !isActive) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (): void => {
      clearTimeout(timer)
      if (document.visibilityState === 'hidden') return
      timer = setTimeout(() => {
        pollNotebook.current()
        schedule()
      }, 5_000)
    }
    document.addEventListener('visibilitychange', schedule)
    schedule()
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', schedule)
    }
  }, [projectId, isActive])

  useEffect(() => {
    if (!projectId) return
    const refresh = createActivityRefresh(
      () => window.api.compute.jobsList({ projectId, since: recentSince }),
      (jobs) => setJobsSnapshot({ projectId, jobs })
    )
    const stop = window.api.compute.onJobUpdated((job) => {
      if (job.project_id === projectId) refresh.refresh()
    })
    refresh.refresh()
    return () => {
      refresh.dispose()
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
            'Local Notebook resources, active Compute Jobs, and Compute Jobs completed in the last 48 hours.'
          )}
        </p>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 px-6 py-4">
          {projectId ? (
            <NotebookResourcePanel
              key={projectId}
              isActive={isActive}
              projectId={projectId}
              snapshot={notebookResources}
              observedAt={notebookSnapshot?.observedAt ?? 0}
              backgroundRuns={notebookActivity.backgroundRuns}
              refresh={() => refreshNotebook.current()}
              goToSession={goToSession}
            />
          ) : null}

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
                  className="hidden grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,1fr)_100px_110px_28px] gap-4 border-b border-border-200 bg-bg-10 px-3.5 py-2 text-[10px] font-semibold tracking-wide text-text-100 uppercase @3xl/compute:grid"
                >
                  <span role="columnheader">{t('Task')}</span>
                  <span role="columnheader">{t('Session')}</span>
                  <span role="columnheader">{t('Target')}</span>
                  <span role="columnheader">{t('Status')}</span>
                  <span role="columnheader">{t('Updated')}</span>
                  <span aria-hidden="true" />
                </div>
                {jobs.map((job) => {
                  const session = sessionById.get(job.session_id)
                  const target = jobTargetLabel(job, t)
                  const updatedAt = job.finished_at ?? job.started_at ?? job.created_at
                  return (
                    <div
                      key={job.job_id}
                      className="relative border-t border-border-200 px-3.5 py-3 text-xs first:border-t-0"
                    >
                      <details className="group pr-8 @3xl/compute:hidden">
                        <summary className="flex cursor-pointer list-none items-start gap-2 rounded-md outline-none focus-visible:keyboard-focus [&::-webkit-details-marker]:hidden">
                          <RadioTower
                            className="mt-px size-3.5 shrink-0 text-text-100"
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium" title={job.intent}>
                              {job.intent}
                            </span>
                            <span className="block wrap-anywhere text-[11px] text-text-100">
                              {target}
                            </span>
                            <span className="mt-1 flex items-center gap-1.5 text-[11px] text-text-100">
                              <span>{jobStatusLabel(job, t)}</span>
                              <span aria-hidden="true">·</span>
                              <time dateTime={new Date(updatedAt).toISOString()}>
                                {formatRelativeTime(updatedAt)}
                              </time>
                            </span>
                          </span>
                          <span className="-mt-1 flex size-7 shrink-0 items-center justify-center rounded-lg text-text-100 transition-colors group-hover:bg-bg-100 group-hover:text-text-000">
                            <ChevronDown
                              className="size-4 transition-transform motion-reduce:transition-none group-open:rotate-180"
                              strokeWidth={1.75}
                              aria-hidden="true"
                            />
                          </span>
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
                        </dl>
                      </details>
                      <dl className="hidden grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,1fr)_100px_110px_28px] items-center gap-4 @3xl/compute:grid">
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
                          <dt className="sr-only">{t('Target')}</dt>
                          <dd className="wrap-anywhere text-text-100">{target}</dd>
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
                        size="icon-sm"
                        className="absolute top-2 right-2.5 text-text-100 hover:text-text-000 @3xl/compute:top-1/2 @3xl/compute:-translate-y-1/2"
                        disabled={!session}
                        aria-label={t('Go to Session')}
                        title={t('Go to Session')}
                        onClick={() => goToSession(job.session_id)}
                      >
                        <ArrowUpRight className="size-4" strokeWidth={1.75} aria-hidden="true" />
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
