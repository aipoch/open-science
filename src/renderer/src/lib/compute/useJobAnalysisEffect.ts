// useJobAnalysisEffect — wires the job-analysis-trigger into the React component tree.
//
// Owned by the App-level runtime bridge so analysis survives navigation away from Workspace.
// On every `compute:job-updated` broadcast AND once after App persistence recovery,
// the trigger is fed the job summary and decides whether to fire / queue an analysis turn.
//
// Design decisions:
// - One readiness-scoped effect owns the trigger and every subscription so delayed work cannot cross
//   a persistence recovery boundary.
// - The shared application Message queue owns pre-send readiness and in-flight barriers.
// - The restart-recovery scan covers every persisted Session from the App-lifetime owner.

import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'

import {
  flushSessionPersistence,
  hydratePersistedSessionIfPresent,
  loadPersistedSession
} from '../session-persistence/session-persistence'
import { useSessionJobStore } from '../../stores/session-job-store'
import { useSessionStore, type ChatSession } from '../../stores/session-store'
import { createJobAnalysisTrigger } from '../compute/job-analysis-trigger'
import { isComputeJobCompletionAttribution } from '../../../../shared/session-persistence'
import type { JobAnalysisTriggerDeps } from './job-analysis-trigger'

type AdmitMessageFn = (input: {
  session: ChatSession
  text: string
  messageId: string
  attribution: {
    kind: 'application'
    feature: 'compute'
    purpose: 'job-completion-analysis'
    deliveryKey: string
    jobIds: string[]
  }
}) => Promise<{ sessionId: string; messageId: string } | undefined>

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
  admitMessage?: AdmitMessageFn
  // Retained as a test seam; production owns delivery through admitMessage and the shared queue.
  sendMessage: SendMessageFn
}

type JobAnalysisRecoveryStatus = Readonly<{
  error: 'pending-scan-failed' | undefined
  retry: () => void
}>

const DURABLE_SESSION_READINESS_RETRY_MS = 250

const durableSessionAcceptsAnalysis = (
  session: Pick<ChatSession, 'status' | 'activeRun'>
): boolean =>
  (session.status === 'idle' || session.status === 'error') && session.activeRun === undefined

const findAnalysisPrompt = (
  session: ChatSession,
  messageId: string
): ChatSession['messages'][number] | undefined =>
  session.messages.find((message) => message.id === messageId) ??
  session.conversationGraph?.messages.find((message) => message.id === messageId)

const analysisTurnState = (
  session: ChatSession | undefined,
  messageId: string,
  previousSession?: ChatSession
): Awaited<ReturnType<JobAnalysisTriggerDeps['getTurnState']>> => {
  if (!session) return 'missing'
  const prompt = findAnalysisPrompt(session, messageId)
  if (!prompt) return 'missing'
  if (prompt.role !== 'user') return 'failed'
  // A rearmed prompt may still have an older partial response. Its live run owns completion.
  if (session.activeRun?.promptMessageId === messageId) return 'running'
  const recovery =
    session.resumeRecovery?.promptMessageId === messageId ? session.resumeRecovery : undefined
  if (recovery?.cause === 'cancelled') return 'cancelled'
  const graphPrompt = session.conversationGraph?.messages.find(
    (message) => message.id === messageId
  )
  const visibleIds = new Set(session.messages.map((message) => message.id))
  const responses = [
    ...(session.conversationGraph?.messages.filter(
      (message) =>
        !visibleIds.has(message.id) &&
        message.agentFrameId === graphPrompt?.agentFrameId &&
        message.introducedOnBranchId === graphPrompt?.introducedOnBranchId
    ) ?? []),
    ...session.messages
  ].filter((message) => message.role === 'agent' && message.responseToMessageId === messageId)
  const response = responses.at(-1)
  if (response?.status === 'complete') return 'succeeded'
  if (response?.status === 'error') return 'failed'
  if (recovery && recovery.cause !== 'app-restart') return 'failed'
  // A live run can end without producing text. Only an observed transition of this exact run
  // identifies that outcome; a terminal Session snapshot alone is not completion evidence.
  if (
    previousSession?.activeRun?.promptMessageId === messageId &&
    !session.activeRun &&
    !session.resumeRecovery
  ) {
    if (session.status === 'idle') return 'succeeded'
    if (session.status === 'error') return 'failed'
  }
  return 'missing'
}

// Subscribes to all done-state compute:job-updated broadcasts and runs the analysis turn trigger.
// Also scans every Session for pending notifications on startup (restart recovery path).
export const useJobAnalysisEffect = ({
  enabled,
  admitMessage,
  sendMessage
}: UseJobAnalysisEffectOptions): JobAnalysisRecoveryStatus => {
  const [error, setError] = useState<JobAnalysisRecoveryStatus['error']>()
  const retryScanRef = useRef<() => void>(() => undefined)
  const retry = useCallback(() => retryScanRef.current(), [])
  const admitLatestMessage = useEffectEvent(
    (input: Parameters<AdmitMessageFn>[0]): ReturnType<AdmitMessageFn> => {
      if (admitMessage) return admitMessage(input)
      return sendMessage({
        sessionId: input.session.id,
        text: input.text,
        cwd: input.session.cwd,
        projectId: input.session.projectId,
        preserveSelection: true,
        messageId: input.messageId
      })
    }
  )

  useEffect(() => {
    if (!enabled) return

    let isActive = true
    let pendingScanRetry: ReturnType<typeof setTimeout> | undefined
    const turnEndUnsubscribes = new Set<() => void>()

    const loadAnalysisSession = async (
      sessionId: string,
      waitForDurableReadiness = false
    ): Promise<ChatSession | undefined> => {
      let session = useSessionStore
        .getState()
        .sessions.find((candidate) => candidate.id === sessionId)
      if (!session) return undefined
      if (session.contentLoaded !== false && !waitForDurableReadiness) return session

      while (isActive) {
        const persisted = await loadPersistedSession({
          projectId: session.projectId,
          sessionId
        })
        if (!isActive) return undefined
        // Older persistence adapters may not provide lazy single-Session reads. Preserve their
        // existing in-memory behavior rather than preventing completion delivery.
        if (!persisted) return session
        if (waitForDurableReadiness && !durableSessionAcceptsAnalysis(persisted)) {
          await new Promise((resolve) => setTimeout(resolve, DURABLE_SESSION_READINESS_RETRY_MS))
          session =
            useSessionStore.getState().sessions.find((candidate) => candidate.id === sessionId) ??
            session
          continue
        }
        return hydratePersistedSessionIfPresent(persisted)
      }
      return undefined
    }

    const trigger = createJobAnalysisTrigger({
      preparePrompt: async (sessionId, text, messageId, jobIds) => {
        // CLI Tasks commit their terminal Session after the ACP stop event. Keep the durable idle
        // boundary before admission, but let the trigger retry a failed read without failing a turn.
        const session = await loadAnalysisSession(sessionId, true)
        if (!isActive || !session) return undefined
        const prompt = findAnalysisPrompt(session, messageId)
        if (!prompt) return text
        if (prompt.role !== 'user') return undefined
        const jobs = await window.api.compute.jobsList({ sessionId })
        if (!isActive) return undefined
        const batch = jobs.filter((job) => job.analysis_message_id === messageId)
        if (
          batch.length !== jobIds.length ||
          batch.some(
            (job) =>
              job.session_id !== sessionId ||
              job.analysis_state !== 'dispatched' ||
              !jobIds.includes(job.job_id)
          )
        )
          return undefined
        if (
          prompt.attribution &&
          (!isComputeJobCompletionAttribution(prompt.attribution) ||
            prompt.attribution.deliveryKey !==
              `compute_done:${sessionId}:${[...jobIds].sort().join(',')}` ||
            prompt.attribution.jobIds.length !== jobIds.length ||
            prompt.attribution.jobIds.some((jobId) => !jobIds.includes(jobId)))
        )
          return undefined
        return prompt.content
      },
      sendPrompt: async (sessionId, text, messageId, jobIds) => {
        const session = useSessionStore
          .getState()
          .sessions.find((candidate) => candidate.id === sessionId)
        if (!isActive || !session) return undefined
        return admitLatestMessage({
          session,
          text,
          messageId,
          attribution: {
            kind: 'application',
            feature: 'compute',
            purpose: 'job-completion-analysis',
            deliveryKey: `compute_done:${sessionId}:${[...new Set(jobIds)].sort().join(',')}`,
            jobIds: [...jobIds]
          }
        })
      },
      flushPersistence: () => flushSessionPersistence(),
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
      getJobsForSession: async (sessionId) => {
        if (!isActive || typeof window.api?.compute?.jobsList !== 'function') {
          throw new Error('Compute Job reconciliation is unavailable.')
        }
        const jobs = await window.api.compute.jobsList({ sessionId })
        if (!isActive) return []
        const jobStore = useSessionJobStore.getState()
        for (const job of jobs) jobStore.applyUpdate(job)
        return jobs
      },
      getTurnState: async (sessionId, messageId) => {
        const session = await loadAnalysisSession(sessionId)
        return analysisTurnState(session, messageId)
      },
      onTurnEnd: (sessionId, messageId, callback) => {
        let settled = false
        let unsubscribe = (): void => undefined
        const settleIfTerminal = (
          state: ReturnType<typeof useSessionStore.getState>,
          previousState?: ReturnType<typeof useSessionStore.getState>
        ): void => {
          if (settled || !isActive) return
          const session = state.sessions.find((candidate) => candidate.id === sessionId)
          const outcome = analysisTurnState(
            session,
            messageId,
            previousState?.sessions.find((candidate) => candidate.id === sessionId)
          )
          if (outcome === 'missing' || outcome === 'running') return
          settled = true
          unsubscribe()
          turnEndUnsubscribes.delete(unsubscribe)
          callback(outcome)
        }
        settleIfTerminal(useSessionStore.getState())
        if (settled) return
        unsubscribe = useSessionStore.subscribe(settleIfTerminal)
        turnEndUnsubscribes.add(unsubscribe)
        // Reconcile again after subscription; only this Message can complete the batch.
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
          setError(undefined)
          const jobStore = useSessionJobStore.getState()
          for (const job of jobs) jobStore.applyUpdate(job)
        })
        .catch((error) => {
          if (!isActive) return
          setError('pending-scan-failed')
          console.warn('[compute] analysis-turn:pending-scan-failed', error)
          pendingScanRetry = setTimeout(() => {
            pendingScanRetry = undefined
            scanPendingJobs(Math.min(retryDelay * 2, 30_000))
          }, retryDelay)
        })
    }

    const initialState = useSessionJobStore.getState()
    retryScanRef.current = () => scanPendingJobs()
    feedNotifiedJobs(initialState)
    scanPendingJobs()

    const unsubscribeJobs = useSessionJobStore.subscribe((state) => {
      feedNotifiedJobs(state)
    })

    return () => {
      isActive = false
      retryScanRef.current = () => undefined
      clearTimeout(pendingScanRetry)
      trigger.dispose()
      unsubscribeJobs()
      for (const unsubscribe of turnEndUnsubscribes) unsubscribe()
      turnEndUnsubscribes.clear()
    }
  }, [enabled])
  return { error, retry }
}

export type { UseJobAnalysisEffectOptions }
