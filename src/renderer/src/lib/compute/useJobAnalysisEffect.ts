// useJobAnalysisEffect — wires the job-analysis-trigger into the React component tree.
//
// Called from WorkspacePage (which owns `sendMessage` from useWorkspaceAgentRuntime).
// On every `compute:job-updated` broadcast AND once at session hydration time,
// the trigger is fed the job summary and decides whether to fire / queue an analysis turn.
//
// Design decisions:
// - One readiness-scoped effect owns the trigger and every subscription so delayed work cannot cross
//   a persistence recovery boundary.
// - `isSessionInFlight` reads from useSessionStore.getState() synchronously — no subscription needed.
// - The restart-recovery scan fires whenever the active session id changes (session navigation).

import { useEffect, useEffectEvent } from 'react'

import { useSessionJobStore } from '../../stores/session-job-store'
import { useSessionStore } from '../../stores/session-store'
import { createJobAnalysisTrigger } from '../compute/job-analysis-trigger'

// Matches the sendMessage signature returned by useWorkspaceAgentRuntime.
type SendMessageFn = (input: {
  sessionId?: string
  text: string
}) => Promise<{ sessionId: string; messageId: string } | undefined>

type UseJobAnalysisEffectOptions = {
  enabled: boolean
  sendMessage: SendMessageFn
}

// Subscribes to all done-state compute:job-updated broadcasts and runs the analysis turn trigger.
// Also scans for pending notifications on session load (restart recovery path).
export const useJobAnalysisEffect = ({
  enabled,
  sendMessage
}: UseJobAnalysisEffectOptions): void => {
  const sendLatestMessage = useEffectEvent(
    (input: Parameters<SendMessageFn>[0]): ReturnType<SendMessageFn> => sendMessage(input)
  )

  useEffect(() => {
    if (!enabled) return

    let isActive = true
    let pendingScanRetry: ReturnType<typeof setTimeout> | undefined
    const turnEndUnsubscribes = new Set<() => void>()
    const trigger = createJobAnalysisTrigger({
      isSessionInFlight: (sessionId) => {
        const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
        return (
          session?.status === 'running' ||
          session?.status === 'waiting-for-user' ||
          session?.status === 'waiting-permission'
        )
      },
      sendPrompt: async (sessionId, text) => {
        if (!isActive) return undefined
        return sendLatestMessage({ sessionId, text })
      },
      markConsumed: async (sessionId, jobIds) => {
        if (!isActive) return
        if (typeof window.api?.compute?.jobsMarkConsumed === 'function') {
          await window.api.compute.jobsMarkConsumed(sessionId, jobIds)
          const consumedAt = Date.now()
          const jobStore = useSessionJobStore.getState()
          for (const jobId of jobIds) {
            const job = jobStore.jobsById.get(jobId)
            if (job?.session_id === sessionId) {
              jobStore.applyUpdate({ ...job, notification_consumed_at: consumedAt })
            }
          }
        }
      },
      onTurnEnd: (sessionId, callback) => {
        // Keep runtime completion listeners inside the same readiness lifecycle as dispatch.
        const unsubscribe = useSessionStore.subscribe((state) => {
          const session = state.sessions.find((candidate) => candidate.id === sessionId)
          if (!session) return
          if (
            session.status !== 'running' &&
            session.status !== 'waiting-for-user' &&
            session.status !== 'waiting-permission'
          ) {
            unsubscribe()
            turnEndUnsubscribes.delete(unsubscribe)
            if (isActive) callback()
          }
        })
        turnEndUnsubscribes.add(unsubscribe)
      },
      log: (tag, message) => {
        console.log(`[compute] ${tag}: ${message}`)
      }
    })

    const feedNotifiedJobs = (state: ReturnType<typeof useSessionJobStore.getState>): void => {
      for (const job of state.jobsById.values()) {
        if (job.notified_at !== undefined && job.notified_at !== null) {
          trigger.onJobDone(job)
        }
      }
    }

    const scanPendingJobs = (sessionId: string | undefined, retryDelay = 1_000): void => {
      if (!sessionId) return
      if (typeof window.api?.compute?.jobsPendingNotification !== 'function') return
      if (useSessionJobStore.getState().hydratedSessionId !== sessionId) return
      clearTimeout(pendingScanRetry)
      pendingScanRetry = undefined

      void window.api.compute
        .jobsPendingNotification(sessionId)
        .then((jobs) => {
          if (!isActive) return
          for (const job of jobs) trigger.onJobDone(job)
        })
        .catch((error) => {
          if (!isActive || useSessionJobStore.getState().hydratedSessionId !== sessionId) return
          console.warn('[compute] analysis-turn:pending-scan-failed', error)
          pendingScanRetry = setTimeout(() => {
            pendingScanRetry = undefined
            scanPendingJobs(sessionId, Math.min(retryDelay * 2, 30_000))
          }, retryDelay)
        })
    }

    const initialState = useSessionJobStore.getState()
    feedNotifiedJobs(initialState)
    scanPendingJobs(initialState.hydratedSessionId)

    const unsubscribeJobs = useSessionJobStore.subscribe((state, previousState) => {
      feedNotifiedJobs(state)
      if (state.hydratedSessionId !== previousState.hydratedSessionId) {
        scanPendingJobs(state.hydratedSessionId)
      }
    })

    return () => {
      isActive = false
      clearTimeout(pendingScanRetry)
      unsubscribeJobs()
      for (const unsubscribe of turnEndUnsubscribes) unsubscribe()
      turnEndUnsubscribes.clear()
    }
  }, [enabled])
}
