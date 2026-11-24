import { useShallow } from 'zustand/react/shallow'
import { computeQueueBlockedLabel } from '@/lib/compute/queue-blocked-label'
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { isComputeJobCancelled, isComputeJobTrackingStopped } from '@aipoch/compute'
import { ArrowUpRight, ChevronDown, Cpu, RadioTower } from 'lucide-react'

import {
  externalComputeMode,
  isComputeProviderId,
  type JobSummary
} from '../../../../shared/compute'
import type {
  NotebookProjectActivity,
  NotebookProjectBackgroundRunActivity,
  NotebookProjectKernelActivity
} from '../../../../shared/notebook'
import { WEB_CALLER_LOCATION_ATTRIBUTE } from '../../../../shared/web-caller-location'
import type { NotebookProjectResources } from '../../../../shared/notebook-resources'
import { ComputePanel } from './ComputePanel'
import { ComputeProcessMonitor } from './ComputeProcessMonitor'
import { ErrorNotice } from '@/components/error-notice'
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
  canRead: () => boolean = () => true,
  onFailure?: (error: unknown) => void
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
      } catch (error) {
        if (active && canRead() && !pending) onFailure?.(error)
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

type ProjectRead<T> = { projectId: string; value?: T; observedAt?: number; error?: string }

const createNotebookRefresh = <T,>(
  projectId: string,
  read: () => Promise<T>,
  publish: Dispatch<SetStateAction<ProjectRead<T> | undefined>>,
  visible: () => boolean
): ReturnType<typeof createActivityRefresh> =>
  createActivityRefresh(
    read,
    (value) => publish({ projectId, value, observedAt: Date.now() }),
    visible,
    (error) =>
      publish((previous) => ({
        ...(previous?.projectId === projectId ? previous : undefined),
        projectId,
        error: String(error)
      }))
  )

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
  const isRemote = document.documentElement.getAttribute(WEB_CALLER_LOCATION_ATTRIBUTE) === 'remote'
  const currentSessionId = useSessionStore((state) => state.selectedSessionId)
  const projectId = useNavigationStore((state) => state.activeProjectId)
  const openSession = useNavigationStore((state) => state.openSession)
  const refreshNotebook = useRef<() => void>(() => undefined)
  const pollNotebook = useRef<() => void>(() => undefined)
  const notebookVisible = useRef(isActive)
  const liveTitles = useSessionStore(
    useShallow((state) =>
      Object.fromEntries(state.sessions.map((session) => [session.id, session.title]))
    )
  )
  const [indexedTitles, setIndexedTitles] = useState<ReadonlyMap<string, string>>(new Map())
  useEffect(() => {
    let disposed = false
    const loadTitles = async (): Promise<void> => {
      try {
        const result = await window.api.sessions.list()
        if (!disposed)
          setIndexedTitles(new Map(result.sessions.map((session) => [session.id, session.title])))
      } catch {
        // Live session titles remain available when the index cannot be read.
      }
    }
    void loadTitles()
    return () => {
      disposed = true
    }
  }, [projectId])
  const [activityRead, setActivityRead] = useState<ProjectRead<NotebookProjectActivity>>()
  const [resourceRead, setResourceRead] = useState<ProjectRead<NotebookProjectResources>>()
  const activity = activityRead?.projectId === projectId ? activityRead : undefined
  const resources = resourceRead?.projectId === projectId ? resourceRead : undefined
  const [jobsSnapshot, setJobsSnapshot] = useState<{ projectId: string; jobs: JobSummary[] }>()
  const [recentSince, setRecentSince] = useState(() => Date.now() - RECENT_COMPUTE_WINDOW_MS)
  const notebookActivity = activity?.value ?? EMPTY_NOTEBOOK_ACTIVITY
  const jobs = projectId && jobsSnapshot?.projectId === projectId ? jobsSnapshot.jobs : EMPTY_JOBS

  useEffect(() => {
    notebookVisible.current = isActive
    if (isActive) refreshNotebook.current()
  }, [isActive])

  useEffect(() => {
    if (!projectId) return
    const visible = (): boolean => notebookVisible.current && document.visibilityState !== 'hidden'
    const activity = createNotebookRefresh(
      projectId,
      () => window.api.notebook.getProjectActivity({ projectId }),
      setActivityRead,
      visible
    )
    const resources = createNotebookRefresh(
      projectId,
      () => window.api.notebook.getProjectResources({ projectId }),
      setResourceRead,
      visible
    )
    const refresh = (): void => {
      activity.refresh()
      resources.refresh()
    }
    refreshNotebook.current = refresh
    pollNotebook.current = () => {
      activity.poll()
      resources.poll()
    }
    const stop = window.api.notebook.onChanged((event) => {
      if (event.projectId === projectId) refresh()
    })
    const resume = (): void => {
      if (document.visibilityState !== 'hidden') refresh()
    }
    document.addEventListener('visibilitychange', resume)
    refresh()
    return () => {
      refreshNotebook.current = () => undefined
      pollNotebook.current = () => undefined
      document.removeEventListener('visibilitychange', resume)
      activity.dispose()
      resources.dispose()
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

  const sessionTitles = useMemo(
    () => new Map([...indexedTitles, ...Object.entries(liveTitles)]),
    [indexedTitles, liveTitles]
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
    if (projectId && sessionTitles.has(sessionId)) openSession(projectId, sessionId, 'user')
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
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-6 px-6 py-6">
          {projectId ? (
            <NotebookResourcePanel
              key={projectId}
              isActive={isActive}
              projectId={projectId}
              snapshot={resources?.value ?? EMPTY_NOTEBOOK_RESOURCES}
              observedAt={resources?.observedAt}
              readError={resources?.error}
              backgroundRuns={notebookActivity.backgroundRuns}
              refresh={() => refreshNotebook.current()}
              goToSession={goToSession}
            />
          ) : null}

          {activity?.error !== undefined && (
            <ErrorNotice
              inline
              role="status"
              title={t('Could not refresh {{source}}', { source: t('Active kernels') })}
              description={
                activity.value && t('The last successful sample is shown. Try refreshing again.')
              }
              errorCode={activity.error}
              diagnosticsLabel={t('Details')}
            />
          )}
          {isRemote ? (
            <section aria-labelledby="active-kernels-title">
              {kernels.length === 0 ? (
                <div className="overflow-hidden rounded-lg border border-border-200 bg-bg-000">
                  <h2
                    id="active-kernels-title"
                    className="border-b border-border-200 px-3.5 py-3 text-sm font-semibold"
                  >
                    {t('Active kernels')}
                    {activity?.value && ` · ${kernels.length}`}
                  </h2>
                  <div className="px-3 py-6 text-center text-xs text-text-100">
                    {activity?.error !== undefined
                      ? null
                      : activity?.value
                        ? t('No active kernels')
                        : t('Loading…')}
                  </div>
                </div>
              ) : (
                <div className="overflow-hidden rounded-lg border border-border-200 bg-bg-000">
                  <h2
                    id="active-kernels-title"
                    className="border-b border-border-200 px-3.5 py-3 text-sm font-semibold"
                  >
                    {t('Active kernels')}
                    {activity?.value && ` · ${kernels.length}`}
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
                    const sessionTitle = sessionTitles.get(kernel.sessionId)
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
                                {sessionTitle ?? t('Deleted Session')}
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
                                {sessionTitle ?? t('Deleted Session')}
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
                          disabled={!sessionTitle}
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
          ) : (
            <ComputeProcessMonitor
              isActive={isActive}
              projectId={projectId ?? undefined}
              sessionTitles={sessionTitles}
              openSession={(targetProjectId, sessionId) =>
                openSession(targetProjectId, sessionId, 'user')
              }
            />
          )}

          <ComputePanel
            title={t('Compute jobs')}
            icon={RadioTower}
            collapsible={jobs.length === 0}
            count={jobs.length}
            description={t('Current project · Active and completed in the last 48 hours.')}
          >
            {jobs.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                {t('No active or recently completed Compute Jobs.')}
              </div>
            ) : (
              <div>
                <div
                  role="row"
                  className="hidden grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,1fr)_100px_110px_28px] gap-4 border-b border-border bg-muted/30 px-4 py-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase @3xl/compute:grid"
                >
                  <span role="columnheader">{t('Task')}</span>
                  <span role="columnheader">{t('Session')}</span>
                  <span role="columnheader">{t('Target')}</span>
                  <span role="columnheader">{t('Status')}</span>
                  <span role="columnheader">{t('Updated')}</span>
                  <span aria-hidden="true" />
                </div>
                {jobs.map((job) => {
                  const sessionTitle = sessionTitles.get(job.session_id)
                  const target = jobTargetLabel(job, t)
                  const updatedAt = job.finished_at ?? job.started_at ?? job.created_at
                  return (
                    <div
                      key={job.job_id}
                      className="relative border-t border-border px-4 py-3 text-sm first:border-t-0"
                    >
                      <details className="group pr-8 @3xl/compute:hidden">
                        <summary className="flex cursor-pointer list-none items-start gap-2 rounded-md outline-none focus-visible:keyboard-focus [&::-webkit-details-marker]:hidden">
                          <RadioTower
                            className="mt-px size-3.5 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium" title={job.intent}>
                              {job.intent}
                            </span>
                            <span className="block wrap-anywhere text-xs text-muted-foreground">
                              {target}
                            </span>
                            <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                              <span>{jobStatusLabel(job, t)}</span>
                              <span aria-hidden="true">·</span>
                              <time dateTime={new Date(updatedAt).toISOString()}>
                                {formatRelativeTime(updatedAt)}
                              </time>
                            </span>
                          </span>
                          <span className="-mt-1 flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors group-hover:bg-bg-100 group-hover:text-text-000">
                            <ChevronDown
                              className="size-4 transition-transform motion-reduce:transition-none group-open:rotate-180"
                              strokeWidth={1.75}
                              aria-hidden="true"
                            />
                          </span>
                        </summary>
                        <dl className="mt-3 grid gap-2 border-t border-border pt-3">
                          <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
                            <dt className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                              {t('Session')}
                            </dt>
                            <dd className="truncate text-muted-foreground">
                              {sessionTitle ?? t('Deleted Session')}
                            </dd>
                          </div>
                        </dl>
                      </details>
                      <dl className="hidden grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,1fr)_100px_110px_28px] items-center gap-4 @3xl/compute:grid">
                        <div>
                          <dt className="sr-only">{t('Task')}</dt>
                          <dd className="flex min-w-0 items-center gap-2 font-medium">
                            <RadioTower
                              className="size-3.5 shrink-0 text-muted-foreground"
                              aria-hidden="true"
                            />
                            <span className="truncate" title={job.intent}>
                              {job.intent}
                            </span>
                          </dd>
                        </div>
                        <div>
                          <dt className="sr-only">{t('Session')}</dt>
                          <dd className="truncate text-muted-foreground">
                            {sessionTitle ?? t('Deleted Session')}
                          </dd>
                        </div>
                        <div>
                          <dt className="sr-only">{t('Target')}</dt>
                          <dd className="wrap-anywhere text-muted-foreground">{target}</dd>
                        </div>
                        <div>
                          <dt className="sr-only">{t('Status')}</dt>
                          <dd className="text-muted-foreground">{jobStatusLabel(job, t)}</dd>
                        </div>
                        <div>
                          <dt className="sr-only">{t('Updated')}</dt>
                          <dd>
                            <time
                              dateTime={new Date(updatedAt).toISOString()}
                              className="text-muted-foreground"
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
                        className="absolute top-2 right-2.5 text-muted-foreground hover:text-text-000 @3xl/compute:top-1/2 @3xl/compute:-translate-y-1/2"
                        disabled={!sessionTitles.has(job.session_id)}
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
          </ComputePanel>
        </div>
      </ScrollArea>
    </section>
  )
}

export { ProjectComputeInbox }
