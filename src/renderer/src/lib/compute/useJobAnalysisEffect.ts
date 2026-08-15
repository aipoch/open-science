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
import type { ComputeSessionOwner } from '../../../../shared/compute'

import { useSessionJobStore } from '../../stores/session-job-store'
import { type ChatSession, useSessionStore } from '../../stores/session-store'
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

const uniqueSessionForOwner = (owner: ComputeSessionOwner): ChatSession | undefined => {
  const matches = useSessionStore
    .getState()
    .sessions.filter((session) => session.id === owner.sessionId)
  if (matches.length !== 1 || matches[0]?.projectId !== owner.projectId) return undefined
  return matches[0]
}

const sameOwner = (
  left: ComputeSessionOwner | undefined,
  right: ComputeSessionOwner | undefined
): boolean =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    left.projectId === right.projectId &&
    left.sessionId === right.sessionId)
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
    const turnEndUnsubscribes = new Set<() => void>()
    const trigger = createJobAnalysisTrigger({
      canAddressOwner: (owner) => uniqueSessionForOwner(owner) !== undefined,
      isSessionInFlight: (owner) => {
        const session = uniqueSessionForOwner(owner)
        return (
          session?.status === 'running' ||
          session?.status === 'waiting-for-user' ||
          session?.status === 'waiting-permission'
        )
      },
      sendPrompt: async (owner, text) => {
        if (!isActive) return undefined
        if (!uniqueSessionForOwner(owner)) return undefined
        return sendLatestMessage({ sessionId: owner.sessionId, text })
      },
      markConsumed: async (owner, jobIds) => {
        if (!isActive) return
        if (typeof window.api?.compute?.jobsMarkConsumed === 'function') {
          await window.api.compute.jobsMarkConsumed(owner, jobIds)
          // Refresh the in-memory job store so CompletedJobCard re-renders with consumed state.
          void useSessionJobStore.getState().hydrate(owner)
        }
      },
      onTurnEnd: (owner, callback) => {
        // Keep runtime completion listeners inside the same readiness lifecycle as dispatch.
        const unsubscribe = useSessionStore.subscribe((state) => {
          const matches = state.sessions.filter((candidate) => candidate.id === owner.sessionId)
          if (matches.length !== 1 || matches[0]?.projectId !== owner.projectId) return
          const session = matches[0]
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

    const scanPendingJobs = (owner: ComputeSessionOwner | undefined): void => {
      if (!owner) return
      if (typeof window.api?.compute?.jobsPendingNotification !== 'function') return

      void window.api.compute.jobsPendingNotification(owner).then((jobs) => {
        if (!isActive) return
        for (const job of jobs) trigger.onJobDone(job)
      })
    }

    const initialState = useSessionJobStore.getState()
    feedNotifiedJobs(initialState)
    scanPendingJobs(initialState.hydratedOwner)

    const unsubscribeJobs = useSessionJobStore.subscribe((state, previousState) => {
      feedNotifiedJobs(state)
      if (!sameOwner(state.hydratedOwner, previousState.hydratedOwner)) {
        scanPendingJobs(state.hydratedOwner)
      }
    })

    return () => {
      isActive = false
      unsubscribeJobs()
      for (const unsubscribe of turnEndUnsubscribes) unsubscribe()
      turnEndUnsubscribes.clear()
    }
  }, [enabled])
}
