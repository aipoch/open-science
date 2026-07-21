import { create } from 'zustand'

import type { JobSummary } from '../../../shared/compute'

// Session-scoped job feed store (renderer-only, never persisted).
// Hydrates from compute:jobs:list once per session and stays fresh via compute:job-updated broadcasts.
// The store is global so the App can subscribe to the broadcast once at startup.
type SessionJobStoreData = {
  // All known jobs indexed by job_id for O(1) incremental updates.
  jobsById: Map<string, JobSummary>
  // Session id for which the initial list was last fetched.
  hydratedSessionId: string | undefined
  isLoaded: boolean
}

type SessionJobStore = SessionJobStoreData & {
  // Loads all jobs for a session from the main process (initial hydration).
  hydrate: (sessionId: string) => Promise<void>
  // Applies an incremental update from the compute:job-updated broadcast.
  // Stored regardless of session match so cross-session jobs in the broadcast window aren't lost.
  applyUpdate: (job: JobSummary) => void
  // Pure utility — returns running jobs for a given session id (does not trigger a store write).
  runningJobsForSession: (sessionId: string) => JobSummary[]
}

export const createInitialSessionJobState = (): SessionJobStoreData => ({
  jobsById: new Map(),
  hydratedSessionId: undefined,
  isLoaded: false
})

export const useSessionJobStore = create<SessionJobStore>((set, get) => ({
  ...createInitialSessionJobState(),

  // Fetches all jobs for `sessionId` from the main process and replaces the current map.
  // Multiple concurrent calls are safe — the last one wins (state is plain data).
  hydrate: async (sessionId) => {
    const jobs = await window.api.compute.jobsList({ sessionId })
    const jobsById = new Map(jobs.map((j) => [j.job_id, j]))
    set({ jobsById, hydratedSessionId: sessionId, isLoaded: true })
  },

  // Upserts a single job received via broadcast. Works even if the store has not been hydrated yet
  // (the job simply lands in the map for when selectors query it).
  applyUpdate: (job) => {
    set((state) => {
      const next = new Map(state.jobsById)
      next.set(job.job_id, job)
      return { jobsById: next }
    })
  },

  // Returns running jobs for the given session — used by RemoteJobBadge and similar UI.
  runningJobsForSession: (sessionId) =>
    Array.from(get().jobsById.values()).filter(
      (j) => j.session_id === sessionId && j.status === 'running'
    )
}))
