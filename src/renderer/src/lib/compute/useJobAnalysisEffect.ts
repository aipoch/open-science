// useJobAnalysisEffect — wires the job-analysis-trigger into the React component tree.
//
// Called from WorkspacePage (which owns `sendMessage` from useWorkspaceAgentRuntime).
// On every `compute:job-updated` broadcast AND once at session hydration time,
// the trigger is fed the job summary and decides whether to fire / queue an analysis turn.
//
// Design decisions:
// - The trigger instance is stable (created once in a ref) so batching logic survives re-renders.
// - `isSessionInFlight` reads from useSessionStore.getState() synchronously — no subscription needed.
// - `onTurnEnd` subscribes to the Zustand store once (cleanup returned from useEffect).
// - The restart-recovery scan fires whenever the active session id changes (session navigation).

import { useEffect, useMemo } from 'react'

import { useSessionJobStore } from '../../stores/session-job-store'
import { useSessionStore } from '../../stores/session-store'
import { createJobAnalysisTrigger } from '../compute/job-analysis-trigger'

// Matches the sendMessage signature returned by useWorkspaceAgentRuntime.
type SendMessageFn = (input: {
  sessionId?: string
  text: string
}) => Promise<{ sessionId: string; messageId: string } | undefined>

type UseJobAnalysisEffectOptions = {
  sendMessage: SendMessageFn
}

// Subscribes to all done-state compute:job-updated broadcasts and runs the analysis turn trigger.
// Also scans for pending notifications on session load (restart recovery path).
export const useJobAnalysisEffect = ({ sendMessage }: UseJobAnalysisEffectOptions): void => {
  // Create the trigger once for the lifetime of the WorkspacePage mount. useMemo with empty deps
  // gives a stable instance that survives re-renders without relying on ref mutation during render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const trigger = useMemo(
    () =>
      createJobAnalysisTrigger({
        isSessionInFlight: (sessionId) => {
          const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
          return session?.status === 'running' || session?.status === 'waiting-permission'
        },
        sendPrompt: async (sessionId, text) => {
          return sendMessage({ sessionId, text })
        },
        markConsumed: async (sessionId, jobIds) => {
          if (typeof window.api?.compute?.jobsMarkConsumed === 'function') {
            await window.api.compute.jobsMarkConsumed(sessionId, jobIds)
            // Refresh the in-memory job store so CompletedJobCard re-renders with consumed state.
            void useSessionJobStore.getState().hydrate(sessionId)
          }
        },
        onTurnEnd: (sessionId, callback) => {
          // Subscribe to session store state changes and fire the callback once when the target
          // session transitions out of running/waiting-permission into idle.
          const unsubscribe = useSessionStore.subscribe((state) => {
            const session = state.sessions.find((s) => s.id === sessionId)
            if (!session) return
            if (session.status !== 'running' && session.status !== 'waiting-permission') {
              unsubscribe()
              callback()
            }
          })
        },
        log: (tag, message) => {
          console.log(`[compute] ${tag}: ${message}`)
        }
      }),
    // Intentionally empty: trigger is created once per WorkspacePage mount.
    // sendMessage identity is stable (useCallback in useWorkspaceAgentRuntime).
    []
  )

  // Subscribe to the job store's full map so we pick up any new done-state jobs, including
  // those arriving via broadcast after the trigger was created.
  useEffect(() => {
    const unsubscribe = useSessionJobStore.subscribe((state) => {
      for (const job of state.jobsById.values()) {
        if (job.notified_at !== undefined && job.notified_at !== null) {
          trigger.onJobDone(job)
        }
      }
    })
    return unsubscribe
  }, [trigger])

  // Restart-recovery scan: when a session is hydrated, fetch any pending notifications from the
  // main process (jobs that were notified but not consumed before the last app restart).
  const hydratedSessionId = useSessionJobStore((s) => s.hydratedSessionId)

  useEffect(() => {
    if (!hydratedSessionId) return
    if (typeof window.api?.compute?.jobsPendingNotification !== 'function') return

    void window.api.compute.jobsPendingNotification(hydratedSessionId).then((jobs) => {
      for (const job of jobs) {
        trigger.onJobDone(job)
      }
    })
  }, [hydratedSessionId, trigger])
}
