import { useEffect, useMemo, useState } from 'react'

import type { BackgroundResultActivityItem } from '../../../../shared/background-result-delivery'
import type { JobSummary } from '../../../../shared/compute'
import type { NotebookRunRecord, NotebookSessionReference } from '../../../../shared/notebook'

// Shared data source for the composer-area background-task surfaces: the strip
// summary chip and the expandable "Background tasks" ledger. Local background
// Runs need the session's Notebook; all Compute Jobs stay observable without
// one or an awaiting delivery, so the hook must be callable before the
// Notebook reference exists.
type SessionBackgroundTasks = {
  /** Background Runs, active first, with recently completed activity kept. */
  runs: NotebookRunRecord[]
  /** All Compute Jobs, active first. */
  jobs: JobSummary[]
  /** Ticks every second while anything is live; frozen otherwise. */
  now: number
  /** Counts for the collapsed strip chip (no awaiting/attention breakdown by design). */
  summary: {
    activeCount: number
    oldestActiveStartedAt: number | undefined
    totalTasks: number
  }
}

const isRunActive = (run: NotebookRunRecord): boolean =>
  run.status === 'queued' || run.status === 'running'

const isJobActive = (job: JobSummary): boolean =>
  job.cancellation_status !== 'cancelled' &&
  (job.status === 'queued' || job.status === 'submitted' || job.status === 'running')

const jobStartedAt = (job: JobSummary): number => job.started_at ?? job.created_at

type TaskSnapshot = Readonly<{
  identityKey?: string
  runs: NotebookRunRecord[]
  deliveries: BackgroundResultActivityItem[]
  computeJobs: JobSummary[]
}>

const EMPTY_TASK_SNAPSHOT: TaskSnapshot = { runs: [], deliveries: [], computeJobs: [] }

const useSessionBackgroundTasks = (
  sessionId: string | undefined,
  projectId: string | undefined,
  notebook: NotebookSessionReference | undefined
): SessionBackgroundTasks => {
  const identityKey = sessionId && projectId ? `${projectId}\0${sessionId}` : undefined
  const [snapshot, setSnapshot] = useState<TaskSnapshot>(EMPTY_TASK_SNAPSHOT)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!sessionId || !projectId || !identityKey) return
    let active = true
    let requestVersion = 0
    const load = async (): Promise<void> => {
      const version = ++requestVersion
      const [state, activity, jobs] = await Promise.all([
        notebook
          ? window.api.notebook.state(notebook).catch(() => undefined)
          : Promise.resolve(undefined),
        window.api.backgroundResultDelivery?.getSessionActivity
          ? window.api.backgroundResultDelivery
              .getSessionActivity({ sessionId })
              .catch(() => undefined)
          : Promise.resolve(undefined),
        window.api.compute?.jobsList({ sessionId }).catch(() => undefined)
      ])
      if (!active || version !== requestVersion) return
      setSnapshot((current) => {
        const previous = current.identityKey === identityKey ? current : EMPTY_TASK_SNAPSHOT
        return {
          identityKey,
          runs: state
            ? state.runs.filter((run) => run.executionMode === 'background')
            : previous.runs,
          deliveries: activity ? [...activity.awaitingAgent] : previous.deliveries,
          computeJobs: jobs ?? previous.computeJobs
        }
      })
    }
    const stopDelivery =
      window.api.backgroundResultDelivery?.onChanged?.((event) => {
        if (event.projectId === projectId) void load()
      }) ?? (() => undefined)
    const stop =
      window.api.notebook?.onChanged((event) => {
        if (event.sessionId === sessionId && event.projectId === projectId) {
          void load()
        }
      }) ?? (() => undefined)
    const stopCompute = window.api.compute?.onJobUpdated((job) => {
      if (job.session_id === sessionId && job.project_id === projectId) {
        void load()
      }
    })
    void load()
    const poll = window.setInterval(() => void load(), 30_000)
    return () => {
      active = false
      stopDelivery()
      stop()
      stopCompute?.()
      window.clearInterval(poll)
    }
  }, [identityKey, notebook, projectId, sessionId])

  const current = snapshot.identityKey === identityKey ? snapshot : EMPTY_TASK_SNAPSHOT
  const { runs, deliveries, computeJobs } = current

  const deliveryByRunId = useMemo(
    () =>
      new Map(
        deliveries.flatMap((delivery) =>
          delivery.sourceKind === 'compute-job' ? [] : [[delivery.sourceId, delivery] as const]
        )
      ),
    [deliveries]
  )
  const orderedRuns = useMemo(
    () =>
      [...runs]
        .filter((run) => isRunActive(run) || deliveryByRunId.has(run.runId))
        .sort((left, right) => {
          const leftActive = isRunActive(left)
          const rightActive = isRunActive(right)
          return leftActive === rightActive ? right.startedAt - left.startedAt : leftActive ? -1 : 1
        }),
    [deliveryByRunId, runs]
  )
  const orderedJobs = useMemo(
    () =>
      [...computeJobs].sort((left, right) => {
        const leftActive = isJobActive(left)
        const rightActive = isJobActive(right)
        return leftActive === rightActive ? right.created_at - left.created_at : leftActive ? -1 : 1
      }),
    [computeJobs]
  )

  const hasLiveRun = useMemo(
    () => orderedRuns.some(isRunActive) || orderedJobs.some(isJobActive),
    [orderedJobs, orderedRuns]
  )
  useEffect(() => {
    if (!hasLiveRun) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [hasLiveRun])

  const summary = useMemo(() => {
    const activeRuns = orderedRuns.filter(isRunActive)
    const activeJobs = orderedJobs.filter(isJobActive)
    const startedAts = [...activeRuns.map((run) => run.startedAt), ...activeJobs.map(jobStartedAt)]
    return {
      activeCount: activeRuns.length + activeJobs.length,
      oldestActiveStartedAt: startedAts.length > 0 ? Math.min(...startedAts) : undefined,
      totalTasks: orderedRuns.length + orderedJobs.length
    }
  }, [orderedJobs, orderedRuns])

  return {
    runs: orderedRuns,
    jobs: orderedJobs,
    now,
    summary
  }
}

export { isJobActive, isRunActive, useSessionBackgroundTasks }
export type { SessionBackgroundTasks }
