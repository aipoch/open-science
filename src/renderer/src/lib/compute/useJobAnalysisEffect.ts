// useJobAnalysisEffect — wires the job-analysis-trigger into the React component tree.
//
// Owned by the App-level runtime bridge so analysis survives navigation away from Workspace.
// On every `compute:job-updated` broadcast AND once after App persistence recovery,
// the trigger is fed the job summary and decides whether to fire / queue an analysis turn.
//
// Design decisions:
// - One readiness-scoped effect owns the trigger and every subscription so delayed work cannot cross
//   a persistence recovery boundary.
// - `isSessionInFlight` reads from useSessionStore.getState() synchronously — no subscription needed.
// - The restart-recovery scan covers every persisted Session from the App-lifetime owner.

import { useEffect, useEffectEvent } from 'react'

import { useWorkspaceAgentRuntime } from '../acp/useWorkspaceAgentRuntime'
import {
  hydratePersistedSessionIfPresent,
  loadPersistedSession
} from '../session-persistence/session-persistence'
import { useSessionJobStore } from '../../stores/session-job-store'
import { useSessionStore, type ChatSession } from '../../stores/session-store'
import { createJobAnalysisTrigger } from '../compute/job-analysis-trigger'
import type { ComputeJobAnalysisState } from '../../../../shared/compute'

// Matches the sendMessage signature returned by useWorkspaceAgentRuntime.
type SendMessageFn = (input: {
  sessionId?: string
  text: string
  cwd?: string
  projectId?: string
  preserveSelection?: boolean
  messageId?: string
}) => Promise<{ sessionId: string; messageId: string } | undefined>

type UseJobAnalysisEffectOptions = {
  enabled: boolean
  sendMessage: SendMessageFn
}

// Subscribes to all done-state compute:job-updated broadcasts and runs the analysis turn trigger.
// Also scans every Session for pending notifications on startup (restart recovery path).
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

    const loadAnalysisSession = async (sessionId: string): Promise<ChatSession | undefined> => {
      let session = useSessionStore
        .getState()
        .sessions.find((candidate) => candidate.id === sessionId)
      if (!session || session.contentLoaded !== false) return session
      const persisted = await loadPersistedSession({
        projectId: session.projectId,
        sessionId
      })
      if (!isActive || !persisted) return undefined
      session = hydratePersistedSessionIfPresent(persisted)
      return session
    }

    const trigger = createJobAnalysisTrigger({
      isSessionInFlight: (sessionId) => {
        const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
        return (
          session?.status === 'running' ||
          session?.status === 'waiting-for-user' ||
          session?.status === 'waiting-permission' ||
          session?.status === 'waiting-plan-approval'
        )
      },
      sendPrompt: async (sessionId, text, messageId) => {
        if (!isActive) return undefined
        const session = await loadAnalysisSession(sessionId)
        if (!isActive || !session) return undefined
        return sendLatestMessage({
          sessionId,
          text,
          cwd: session.cwd,
          projectId: session.projectId,
          preserveSelection: true,
          messageId
        })
      },
      createMessageId: () => `analysis-${globalThis.crypto.randomUUID()}`,
      transitionAnalysis: async (request) => {
        if (!isActive || typeof window.api?.compute?.jobsTransitionAnalysis !== 'function') {
          throw new Error('Compute analysis persistence is unavailable.')
        }
        const jobs = await window.api.compute.jobsTransitionAnalysis(request)
        if (!isActive) return
        const jobStore = useSessionJobStore.getState()
        for (const job of jobs) jobStore.applyUpdate(job)
      },
      getTurnState: async (sessionId, messageId) => {
        const session = await loadAnalysisSession(sessionId)
        if (!session) return 'missing'
        const prompt = session.messages.find((message) => message.id === messageId)
        if (!prompt) return 'missing'
        const response = session.messages.find(
          (message) => message.role === 'agent' && message.responseToMessageId === messageId
        )
        if (response?.status === 'complete') return 'succeeded'
        if (response?.status === 'error') return 'failed'
        if (session.resumeRecovery?.promptMessageId === messageId) {
          return session.resumeRecovery.cause === 'cancelled' ? 'cancelled' : 'failed'
        }
        if (
          session.activeRun?.promptMessageId === messageId ||
          session.status === 'running' ||
          session.status === 'waiting-for-user' ||
          session.status === 'waiting-permission' ||
          session.status === 'waiting-plan-approval'
        ) {
          return 'running'
        }
        return session.status === 'idle' ? 'succeeded' : 'failed'
      },
      onTurnEnd: (sessionId, callback) => {
        // Keep runtime completion listeners inside the same readiness lifecycle as dispatch.
        let unsubscribe: (() => void) | undefined
        let settled = false
        const settleIfTerminal = (state: ReturnType<typeof useSessionStore.getState>): void => {
          if (settled) return
          const session = state.sessions.find((candidate) => candidate.id === sessionId)
          if (!session) return
          if (
            session.status !== 'running' &&
            session.status !== 'waiting-for-user' &&
            session.status !== 'waiting-permission' &&
            session.status !== 'waiting-plan-approval'
          ) {
            settled = true
            const currentUnsubscribe = unsubscribe
            currentUnsubscribe?.()
            if (currentUnsubscribe) turnEndUnsubscribes.delete(currentUnsubscribe)
            const outcome: Exclude<ComputeJobAnalysisState, 'dispatched'> =
              session.status === 'idle'
                ? 'succeeded'
                : session.resumeRecovery?.cause === 'cancelled'
                  ? 'cancelled'
                  : 'failed'
            if (isActive) callback(outcome)
          }
        }
        const stop = useSessionStore.subscribe(settleIfTerminal)
        unsubscribe = stop
        if (settled) {
          stop()
          return
        }
        // Close the subscribe/check race when a fast turn ended before listener registration.
        turnEndUnsubscribes.add(stop)
        settleIfTerminal(useSessionStore.getState())
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

    const scanPendingJobs = (retryDelay = 1_000): void => {
      if (typeof window.api?.compute?.jobsPendingNotification !== 'function') return
      clearTimeout(pendingScanRetry)
      pendingScanRetry = undefined

      void window.api.compute
        .jobsPendingNotification({ allSessions: true })
        .then((jobs) => {
          if (!isActive) return
          const jobStore = useSessionJobStore.getState()
          for (const job of jobs) jobStore.applyUpdate(job)
        })
        .catch((error) => {
          if (!isActive) return
          console.warn('[compute] analysis-turn:pending-scan-failed', error)
          pendingScanRetry = setTimeout(() => {
            pendingScanRetry = undefined
            scanPendingJobs(Math.min(retryDelay * 2, 30_000))
          }, retryDelay)
        })
    }

    const initialState = useSessionJobStore.getState()
    feedNotifiedJobs(initialState)
    scanPendingJobs()

    const unsubscribeJobs = useSessionJobStore.subscribe((state) => {
      feedNotifiedJobs(state)
    })

    return () => {
      isActive = false
      clearTimeout(pendingScanRetry)
      trigger.dispose()
      unsubscribeJobs()
      for (const unsubscribe of turnEndUnsubscribes) unsubscribe()
      turnEndUnsubscribes.clear()
    }
  }, [enabled])
}

const JobAnalysisRuntimeBridge = ({ enabled }: { enabled: boolean }): null => {
  const runtime = useWorkspaceAgentRuntime()
  useJobAnalysisEffect({ enabled, sendMessage: runtime.sendMessage })
  return null
}

export { JobAnalysisRuntimeBridge }
