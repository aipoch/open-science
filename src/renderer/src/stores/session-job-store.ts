import { create } from 'zustand'

import type { JobSummary } from '../../../shared/compute'

const isNonTerminal = (job: JobSummary): boolean =>
  job.status === 'queued' || job.status === 'submitted' || job.status === 'running'

// Renderer-only job projections, never persisted here: Workspace hydrates a Session history while
// the App hydrates bounded cross-Session activity. Broadcasts keep both projections current.
type SessionJobStoreData = {
  // All known jobs indexed by job_id for O(1) incremental updates.
  jobsById: Map<string, JobSummary>
  // Persisted activity for every Session, hydrated once per renderer recovery cycle.
  nonTerminalJobsById: Map<string, JobSummary>
  // Session id for which the initial list was last fetched.
  hydratedSessionId: string | undefined
  isLoaded: boolean
}

type SessionJobStore = SessionJobStoreData & {
  // Loads all jobs for a session from the main process (initial hydration).
  hydrate: (sessionId: string) => Promise<void>
  // Loads the bounded cross-Session activity projection after app startup or recovery.
  hydrateNonTerminal: () => Promise<void>
  // Applies an incremental update from the compute:job-updated broadcast.
  // Stored regardless of session match so cross-session jobs in the broadcast window aren't lost.
  applyUpdate: (job: JobSummary) => void
  // Pure utility — returns running jobs for a given session id (does not trigger a store write).
  runningJobsForSession: (sessionId: string) => JobSummary[]
  // Pure utility — returns all jobs for a given session id, sorted by created_at descending.
  allJobsForSession: (sessionId: string) => JobSummary[]
}

export const createInitialSessionJobState = (): SessionJobStoreData => ({
  jobsById: new Map(),
  nonTerminalJobsById: new Map(),
  hydratedSessionId: undefined,
  isLoaded: false
})

export const useSessionJobStore = create<SessionJobStore>((set, get) => {
  let latestHydrationRequest = 0
  let latestNonTerminalHydrationRequest = 0
  let latestUpdateRevision = 0
  const updateRevisionByJobId = new Map<string, number>()

  return {
    ...createInitialSessionJobState(),

    // Fetches all jobs for `sessionId`. A newer hydration intent wins, while broadcasts received
    // after this request started remain authoritative over its snapshot.
    hydrate: async (sessionId) => {
      const requestId = ++latestHydrationRequest
      const startedAtUpdateRevision = latestUpdateRevision
      const jobs = await window.api.compute.jobsList({ sessionId })
      if (requestId !== latestHydrationRequest) return

      set((state) => {
        const next = new Map<string, JobSummary>()

        for (const [jobId, job] of state.jobsById) {
          const updateRevision = updateRevisionByJobId.get(jobId)
          if (
            (job.session_id !== sessionId && updateRevision !== undefined) ||
            (job.session_id === sessionId &&
              updateRevision !== undefined &&
              updateRevision > startedAtUpdateRevision)
          ) {
            next.set(jobId, job)
          }
        }

        for (const job of jobs) {
          const updateRevision = updateRevisionByJobId.get(job.job_id)
          if (updateRevision !== undefined && updateRevision > startedAtUpdateRevision) continue
          next.set(job.job_id, job)
        }

        return { jobsById: next, hydratedSessionId: sessionId, isLoaded: true }
      })
    },

    hydrateNonTerminal: async () => {
      const requestId = ++latestNonTerminalHydrationRequest
      const startedAtUpdateRevision = latestUpdateRevision
      const jobs = await window.api.compute.jobsList({ nonTerminal: true })
      if (requestId !== latestNonTerminalHydrationRequest) return

      set((state) => {
        const next = new Map<string, JobSummary>()

        for (const job of jobs) {
          const updateRevision = updateRevisionByJobId.get(job.job_id)
          if (updateRevision !== undefined && updateRevision > startedAtUpdateRevision) continue
          next.set(job.job_id, job)
        }

        for (const [jobId, job] of state.nonTerminalJobsById) {
          const updateRevision = updateRevisionByJobId.get(jobId)
          if (updateRevision !== undefined && updateRevision > startedAtUpdateRevision) {
            next.set(jobId, job)
          }
        }

        return { nonTerminalJobsById: next }
      })
    },

    // Upserts Session history and adds/removes the job from the global activity projection. Works
    // before either hydration so a startup broadcast cannot be lost to a later snapshot.
    applyUpdate: (job) => {
      updateRevisionByJobId.set(job.job_id, ++latestUpdateRevision)
      set((state) => {
        const next = new Map(state.jobsById)
        const nextNonTerminal = new Map(state.nonTerminalJobsById)
        next.set(job.job_id, job)
        if (isNonTerminal(job)) nextNonTerminal.set(job.job_id, job)
        else nextNonTerminal.delete(job.job_id)
        return { jobsById: next, nonTerminalJobsById: nextNonTerminal }
      })
    },

    // Returns running jobs for the given session — used by RemoteJobBadge and similar UI.
    runningJobsForSession: (sessionId) =>
      Array.from(get().jobsById.values()).filter(
        (j) => j.session_id === sessionId && j.status === 'running'
      ),

    // Returns all jobs for the given session, sorted by created_at descending.
    allJobsForSession: (sessionId) =>
      Array.from(get().jobsById.values())
        .filter((j) => j.session_id === sessionId)
        .sort((a, b) => b.created_at - a.created_at)
  }
})
