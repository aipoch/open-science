import { create } from 'zustand'

import type { JobSummary } from '../../../shared/compute'

const isNonTerminal = (job: JobSummary): boolean =>
  job.status === 'queued' || job.status === 'submitted' || job.status === 'running'

type SessionJobStoreData = {
  jobsById: Map<string, JobSummary>
  nonTerminalJobsById: Map<string, JobSummary>
  hydratedSessionId: string | undefined
  isLoaded: boolean
  loadErrorBySession: Map<string, string>
  hydrateGenerationBySession: Map<string, number>
  sessionRevisionBySession: Map<string, number>
  activeHydrationGeneration: number
}

type SessionJobStore = SessionJobStoreData & {
  hydrate: (sessionId: string, options?: { activate?: boolean }) => Promise<void>
  hydrateNonTerminal: () => Promise<void>
  applyUpdate: (job: JobSummary) => void
  runningJobsForSession: (sessionId: string) => JobSummary[]
  allJobsForSession: (sessionId: string) => JobSummary[]
}

const TERMINAL_STATUSES = new Set<JobSummary['status']>(['success', 'failed', 'timeout', 'error'])

const mergeTimestamp = (
  older: number | undefined,
  newer: number | undefined
): number | undefined =>
  older === undefined ? newer : newer === undefined ? older : Math.max(older, newer)

const terminalProjectionPhase = (job: JobSummary): number =>
  job.notified_at !== undefined ? 2 : job.harvest_error !== undefined ? 1 : 0

const mergeJob = (existing: JobSummary | undefined, incoming: JobSummary): JobSummary => {
  if (!existing) return incoming

  const existingTerminal = TERMINAL_STATUSES.has(existing.status)
  const incomingTerminal = TERMINAL_STATUSES.has(incoming.status)
  const activeRegression =
    existing.status === 'running' &&
    (incoming.status === 'queued' || incoming.status === 'submitted')
  const terminalRegression = existingTerminal && !incomingTerminal
  const olderTerminal =
    existingTerminal &&
    incomingTerminal &&
    ((incoming.finished_at ?? 0) < (existing.finished_at ?? 0) ||
      ((incoming.finished_at ?? 0) === (existing.finished_at ?? 0) &&
        terminalProjectionPhase(incoming) < terminalProjectionPhase(existing)))
  const base = terminalRegression || activeRegression || olderTerminal ? existing : incoming

  return {
    ...base,
    notified_at: mergeTimestamp(existing.notified_at, incoming.notified_at),
    notification_consumed_at: mergeTimestamp(
      existing.notification_consumed_at,
      incoming.notification_consumed_at
    )
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : 'Unable to load remote jobs.'

export const createInitialSessionJobState = (): SessionJobStoreData => ({
  jobsById: new Map(),
  nonTerminalJobsById: new Map(),
  hydratedSessionId: undefined,
  isLoaded: false,
  loadErrorBySession: new Map(),
  hydrateGenerationBySession: new Map(),
  sessionRevisionBySession: new Map(),
  activeHydrationGeneration: 0
})

export const useSessionJobStore = create<SessionJobStore>((set, get) => {
  let latestNonTerminalHydrationRequest = 0
  let latestUpdateRevision = 0
  const updateRevisionByJobId = new Map<string, number>()

  return {
    ...createInitialSessionJobState(),

    hydrate: async (sessionId, options) => {
      const activate = options?.activate ?? true
      const before = get()
      const generation = (before.hydrateGenerationBySession.get(sessionId) ?? 0) + 1
      const activeGeneration = activate
        ? before.activeHydrationGeneration + 1
        : before.activeHydrationGeneration
      const startRevision = before.sessionRevisionBySession.get(sessionId) ?? 0
      const hydrateGenerationBySession = new Map(before.hydrateGenerationBySession)
      hydrateGenerationBySession.set(sessionId, generation)
      set({
        hydrateGenerationBySession,
        ...(activate
          ? {
              hydratedSessionId: sessionId,
              isLoaded: false,
              activeHydrationGeneration: activeGeneration
            }
          : {})
      })

      let jobs: JobSummary[]
      try {
        jobs = await window.api.compute.jobsList({ sessionId })
      } catch (error) {
        set((state) => {
          if (state.hydrateGenerationBySession.get(sessionId) !== generation) return state
          const loadErrorBySession = new Map(state.loadErrorBySession)
          loadErrorBySession.set(sessionId, errorMessage(error))
          return {
            loadErrorBySession,
            ...(activate && state.activeHydrationGeneration === activeGeneration
              ? { isLoaded: false }
              : {})
          }
        })
        return
      }

      set((state) => {
        if (state.hydrateGenerationBySession.get(sessionId) !== generation) return state
        const sessionChanged =
          (state.sessionRevisionBySession.get(sessionId) ?? 0) !== startRevision
        const jobsById = new Map(state.jobsById)
        if (!sessionChanged) {
          for (const [jobId, existing] of jobsById) {
            if (existing.session_id === sessionId) jobsById.delete(jobId)
          }
        }
        for (const job of jobs) jobsById.set(job.job_id, mergeJob(jobsById.get(job.job_id), job))
        const loadErrorBySession = new Map(state.loadErrorBySession)
        loadErrorBySession.delete(sessionId)
        return {
          jobsById,
          loadErrorBySession,
          ...(activate && state.activeHydrationGeneration === activeGeneration
            ? { hydratedSessionId: sessionId, isLoaded: true }
            : {})
        }
      })
    },

    hydrateNonTerminal: async () => {
      const requestId = ++latestNonTerminalHydrationRequest
      const startedAtUpdateRevision = latestUpdateRevision
      const jobs = await window.api.compute.jobsList({ nonTerminal: true })
      if (requestId !== latestNonTerminalHydrationRequest) return
      set((state) => {
        const nonTerminalJobsById = new Map<string, JobSummary>()
        for (const job of jobs) {
          const revision = updateRevisionByJobId.get(job.job_id)
          if (revision !== undefined && revision > startedAtUpdateRevision) continue
          if (isNonTerminal(job)) {
            nonTerminalJobsById.set(
              job.job_id,
              mergeJob(state.nonTerminalJobsById.get(job.job_id), job)
            )
          }
        }
        for (const [jobId, job] of state.nonTerminalJobsById) {
          const revision = updateRevisionByJobId.get(jobId)
          if (revision !== undefined && revision > startedAtUpdateRevision && isNonTerminal(job)) {
            nonTerminalJobsById.set(jobId, job)
          }
        }
        return { nonTerminalJobsById }
      })
    },

    applyUpdate: (job) => {
      updateRevisionByJobId.set(job.job_id, ++latestUpdateRevision)
      set((state) => {
        const jobsById = new Map(state.jobsById)
        const merged = mergeJob(jobsById.get(job.job_id), job)
        jobsById.set(job.job_id, merged)
        const nonTerminalJobsById = new Map(state.nonTerminalJobsById)
        if (isNonTerminal(merged)) nonTerminalJobsById.set(job.job_id, merged)
        else nonTerminalJobsById.delete(job.job_id)
        const sessionRevisionBySession = new Map(state.sessionRevisionBySession)
        sessionRevisionBySession.set(
          job.session_id,
          (sessionRevisionBySession.get(job.session_id) ?? 0) + 1
        )
        return { jobsById, nonTerminalJobsById, sessionRevisionBySession }
      })
    },

    runningJobsForSession: (sessionId) =>
      Array.from(get().jobsById.values()).filter(
        (job) => job.session_id === sessionId && job.status === 'running'
      ),

    allJobsForSession: (sessionId) =>
      Array.from(get().jobsById.values())
        .filter((job) => job.session_id === sessionId)
        .sort((a, b) => b.created_at - a.created_at)
  }
})
