import type { StoreApi } from 'zustand'

import type { ActivePlanProjection } from '../../../shared/session-plan/contract'
import type { AcpModelCallUsage, AcpTurnTokenUsage, ElicitationAnswer } from '../../../shared/acp'
import type {
  PersistedChatSession,
  PersistedPendingHistoryReplay,
  PersistedSessionResumeRecovery
} from '../../../shared/session-persistence'
import {
  synchronizeSessionGraph,
  type AppendMessageResult
} from './session-store-message-graph-helpers'
import {
  canStartActivityGroup,
  projectActivePlan,
  projectActivityGroupCompletion,
  projectActivityGroupStart,
  projectElicitationDraftAnswers,
  projectToolActivity,
  type UpsertToolActivityInput
} from './session-store-run-activity-helpers'
import {
  projectAgentMessageChunks,
  projectMessageArtifacts,
  projectMessagePdfContext,
  projectMessageUploads,
  projectRunArtifacts,
  type AppendAgentMessageChunkInput,
  type AttachRunArtifactsInput,
  type ReplaceMessageArtifactsInput,
  type ReplaceMessagePdfContextInput,
  type ReplaceMessageUploadsInput
} from './session-store-run-output-helpers'
import {
  projectAgentPromptInFlight,
  projectAgentStatus,
  projectArtifactError,
  projectArtifactErrorCleared,
  projectAwaitingFirstAgentOutput,
  projectCompactionFailed,
  projectCompactionFinished,
  projectCompactionStarted,
  projectElicitationPending,
  projectFailedRun,
  projectFinishedRun,
  projectInterruptedRun,
  projectPermissionCleared,
  projectPermissionPending,
  type RunTerminalContextWindowSample
} from './session-store-run-terminal-helpers'
import type { ChatSession, SessionStoreData } from './session-store-persistence-owner'
import {
  materializeStreamingMessageContent,
  removeStreamingMessageContentForSession
} from './session-store-persistence-owner'

type SessionStateSetter = StoreApi<SessionStoreData>['setState']

export type SessionRunProjectionActions = {
  appendAgentMessageChunk: (input: AppendAgentMessageChunkInput) => AppendMessageResult | undefined
  appendAgentMessageChunks: (inputs: AppendAgentMessageChunkInput[]) => AppendMessageResult[]
  setAwaitingFirstAgentOutput: (sessionId: string, waiting: boolean) => void
  setAgentPromptInFlight: (sessionId: string, inFlight: boolean) => void
  setElicitationPending: (sessionId: string, pending: boolean) => void
  setPermissionPending: (sessionId: string, options?: { rearmAuthority?: boolean }) => void
  clearPermissionPending: (
    sessionId: string,
    options?: { authority?: 'continuing' | 'settled'; requestId?: string }
  ) => void
  attachRunArtifacts: (input: AttachRunArtifactsInput) => AppendMessageResult | undefined
  replaceMessageArtifacts: (input: ReplaceMessageArtifactsInput) => void
  replaceMessageUploads: (input: ReplaceMessageUploadsInput) => void
  replaceMessagePdfContext: (input: ReplaceMessagePdfContextInput) => void
  recordArtifactError: (
    sessionId: string,
    error: string,
    retryable?: boolean,
    eventId?: string
  ) => void
  clearArtifactError: (sessionId: string, eventId?: string) => void
  finishRun: (
    sessionId: string,
    turnUsage?: AcpTurnTokenUsage,
    promptMessageId?: string,
    contextWindowSample?: RunTerminalContextWindowSample,
    modelCallUsage?: readonly AcpModelCallUsage[]
  ) => void
  interruptRun: (
    sessionId: string,
    cause: PersistedSessionResumeRecovery['cause'],
    error: string,
    promptMessageId?: string,
    contextWindowSample?: RunTerminalContextWindowSample,
    turnUsage?: AcpTurnTokenUsage,
    modelCallUsage?: readonly AcpModelCallUsage[]
  ) => void
  markResumed: (
    sessionId: string,
    update?: Pick<
      PersistedChatSession,
      | 'agentFrameworkId'
      | 'agentBackendId'
      | 'providerSessionId'
      | 'providerContinuityToken'
      | 'pendingHistoryReplay'
    >
  ) => void
  prepareInterruptedTurnContinuation: (
    sessionId: string,
    promptMessageId: string,
    update:
      | Pick<
          PersistedChatSession,
          'agentFrameworkId' | 'agentBackendId' | 'providerSessionId' | 'providerContinuityToken'
        >
      | undefined,
    contextReset: boolean
  ) => { runtimeSegmentId?: string } | undefined
  completeInterruptedTurnResume: (sessionId: string) => void
  clearPendingHistoryReplay: (sessionId: string, replay: PersistedPendingHistoryReplay) => void
  failRun: (
    sessionId: string,
    error: string,
    opts?: {
      reportable?: boolean
      promptMessageId?: string
      contextWindowSample?: RunTerminalContextWindowSample
    }
  ) => void
  setAgentStatus: (sessionId: string, text: string) => void
  beginCompaction: (sessionId: string, options?: { supersedeActiveRun?: boolean }) => void
  finishCompaction: (sessionId: string) => void
  failCompaction: (sessionId: string, error: string) => void
  upsertToolActivity: (input: UpsertToolActivityInput) => void
  setElicitationDraftAnswers: (
    sessionId: string,
    activityId: string,
    answers: ElicitationAnswer[]
  ) => void
  setActivePlanProjection: (sessionId: string, projection: ActivePlanProjection) => void
  beginActivityGroup: (
    sessionId: string,
    groupId: string,
    title: string,
    promptMessageId?: string
  ) => void
  completeActivityGroup: (sessionId: string, promptMessageId?: string) => void
}

const projectSession = (
  sessions: ChatSession[],
  sessionId: string,
  projector: (session: ChatSession) => ChatSession
): ChatSession[] =>
  sessions.map((session) => (session.id === sessionId ? projector(session) : session))

export const createSessionRunProjectionOwner = <
  State extends SessionStoreData & SessionRunProjectionActions
>(
  set: StoreApi<State>['setState'],
  get: StoreApi<State>['getState']
): SessionRunProjectionActions => {
  const setSessionState = set as SessionStateSetter
  const appendAgentMessageChunks = (
    inputs: AppendAgentMessageChunkInput[]
  ): AppendMessageResult[] => {
    if (inputs.length === 0) return []

    const state = get()
    const inputIndexesBySessionId = new Map<string, number[]>()
    inputs.forEach((input, index) => {
      if (!input.sessionId) return
      const indexes = inputIndexesBySessionId.get(input.sessionId)
      if (indexes) indexes.push(index)
      else inputIndexesBySessionId.set(input.sessionId, [index])
    })
    let sessionsChanged = false
    let streamingMessages = state.streamingMessages
    const indexedResults: Array<AppendMessageResult | undefined> = []
    const sessions = state.sessions.map((session) => {
      const indexes = inputIndexesBySessionId.get(session.id)
      if (!indexes) return session
      const projection = projectAgentMessageChunks(
        session,
        indexes.map((index) => inputs[index]),
        streamingMessages
      )
      streamingMessages = projection.streamingMessages
      indexes.forEach((inputIndex, resultIndex) => {
        indexedResults[inputIndex] = projection.results[resultIndex]
      })
      sessionsChanged ||= projection.session !== session
      return projection.session
    })

    // Commit only what changed: pure text-growth ticks touch the streaming slice alone, leaving
    // the sessions array (and every Session object) referentially stable.
    const streamingChanged = streamingMessages !== state.streamingMessages
    if (sessionsChanged || streamingChanged) {
      setSessionState({
        ...(sessionsChanged ? { sessions } : {}),
        ...(streamingChanged ? { streamingMessages } : {})
      } as Partial<State>)
    }
    return indexedResults.filter((result): result is AppendMessageResult => Boolean(result))
  }

  // Folds in-flight streaming text into the Session before a terminal projection rebuilds its
  // Messages, then drops the Session's slice entries. A projection that bails out (e.g. compaction
  // refused during an active run) leaves both the Session and the slice untouched.
  const projectTerminalRun = (
    state: SessionStoreData,
    sessionId: string,
    projector: (session: ChatSession) => ChatSession
  ): Partial<SessionStoreData> => {
    let projected = false
    const sessions = projectSession(state.sessions, sessionId, (session) => {
      const materialized = materializeStreamingMessageContent(session, state.streamingMessages)
      const next = projector(materialized)
      // A projector that declines (returns its input) keeps the original Session and slice.
      if (next === materialized) return session
      projected = true
      return next
    })
    if (!projected) return {}
    return {
      sessions,
      streamingMessages: removeStreamingMessageContentForSession(state.streamingMessages, sessionId)
    }
  }

  return {
    appendAgentMessageChunk: (input) => {
      return appendAgentMessageChunks([input])[0]
    },

    appendAgentMessageChunks,

    setAwaitingFirstAgentOutput: (sessionId, waiting) => {
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, sessionId, (session) =>
          projectAwaitingFirstAgentOutput(session, waiting)
        )
      }))
    },

    setAgentPromptInFlight: (sessionId, inFlight) => {
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, sessionId, (session) =>
          projectAgentPromptInFlight(session, inFlight)
        )
      }))
    },

    setElicitationPending: (sessionId, pending) => {
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, sessionId, (session) =>
          projectElicitationPending(session, pending)
        )
      }))
    },

    setPermissionPending: (sessionId, options) => {
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, sessionId, (session) =>
          projectPermissionPending(session, options?.rearmAuthority)
        )
      }))
    },

    clearPermissionPending: (sessionId, options) => {
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, sessionId, (session) =>
          projectPermissionCleared(session, options?.authority, options?.requestId)
        )
      }))
    },

    attachRunArtifacts: (input) => {
      if (!input.sessionId || !input.runId || !input.eventId || input.artifacts.length === 0) {
        return undefined
      }
      let result: AppendMessageResult | undefined
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, input.sessionId, (session) => {
          const projection = projectRunArtifacts(session, input)
          result = projection.result
          return projection.session
        })
      }))
      return result
    },

    replaceMessageArtifacts: (input) => {
      if (!input.sessionId || !input.messageId) return
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, input.sessionId, (session) =>
          projectMessageArtifacts(session, input)
        )
      }))
    },

    replaceMessageUploads: (input) => {
      if (!input.sessionId || !input.messageId) return
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, input.sessionId, (session) =>
          projectMessageUploads(session, input)
        )
      }))
    },

    replaceMessagePdfContext: (input) => {
      if (!input.sessionId || !input.messageId) return
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, input.sessionId, (session) =>
          projectMessagePdfContext(session, input)
        )
      }))
    },

    recordArtifactError: (sessionId, error, retryable = true, eventId) => {
      const message = error.trim()
      if (!sessionId || !message) return
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, sessionId, (session) =>
          projectArtifactError(session, message, retryable, eventId)
        )
      }))
    },

    clearArtifactError: (sessionId, eventId) => {
      if (!sessionId) return
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, sessionId, (session) =>
          projectArtifactErrorCleared(session, eventId)
        )
      }))
    },

    setActivePlanProjection: (sessionId, projection) => {
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, sessionId, (session) =>
          projectActivePlan(session, projection)
        )
      }))
    },

    upsertToolActivity: (input) => {
      if (!input.sessionId || !input.toolCallId || !input.eventId) return
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, input.sessionId, (session) =>
          projectToolActivity(session, input)
        )
      }))
    },

    setElicitationDraftAnswers: (sessionId, activityId, answers) => {
      if (!sessionId || !activityId) return
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, sessionId, (session) =>
          projectElicitationDraftAnswers(session, activityId, answers)
        )
      }))
    },

    beginActivityGroup: (sessionId, groupId, title, promptMessageId) => {
      if (!sessionId || !canStartActivityGroup(groupId, title)) return
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, sessionId, (session) =>
          projectActivityGroupStart(session, groupId, title, promptMessageId)
        )
      }))
    },

    completeActivityGroup: (sessionId, promptMessageId) => {
      if (!sessionId) return
      const now = Date.now()
      setSessionState((state) => {
        const target = state.sessions.find((session) => session.id === sessionId)
        if (!target) return state
        const projected = projectActivityGroupCompletion(target, promptMessageId, now)
        if (projected === target) return state
        return {
          sessions: projectSession(state.sessions, sessionId, () => projected)
        }
      })
    },

    finishRun: (sessionId, turnUsage, promptMessageId, contextWindowSample, modelCallUsage) => {
      setSessionState((state) =>
        projectTerminalRun(state, sessionId, (session) =>
          projectFinishedRun(
            session,
            turnUsage,
            promptMessageId,
            contextWindowSample,
            modelCallUsage
          )
        )
      )
    },

    interruptRun: (
      sessionId,
      cause,
      error,
      promptMessageId,
      contextWindowSample,
      turnUsage,
      modelCallUsage
    ) => {
      setSessionState((state) =>
        projectTerminalRun(state, sessionId, (session) =>
          projectInterruptedRun(
            session,
            cause,
            error,
            promptMessageId,
            contextWindowSample,
            turnUsage,
            modelCallUsage
          )
        )
      )
    },

    // Clears the interrupted/error state after a successful resume so the composer is usable again.
    markResumed: (sessionId, update) => {
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, sessionId, (session) => ({
          ...session,
          status: 'idle',
          error: undefined,
          errorReportable: undefined,
          interrupted: undefined,
          resumeRecovery: undefined,
          specialistBindingPending: undefined,
          agentFrameworkId: update?.agentFrameworkId ?? session.agentFrameworkId,
          agentBackendId: update?.agentBackendId ?? session.agentBackendId,
          providerSessionId: update?.providerSessionId ?? session.providerSessionId,
          providerContinuityToken:
            update === undefined ? session.providerContinuityToken : update.providerContinuityToken,
          pendingHistoryReplay: update?.pendingHistoryReplay ?? session.pendingHistoryReplay,
          compacting: undefined,
          updatedAt: Date.now()
        }))
      }))
    },

    prepareInterruptedTurnContinuation: (sessionId, promptMessageId, update, contextReset) => {
      let prepared: { runtimeSegmentId?: string } | undefined
      setSessionState((state) => ({
        sessions: state.sessions.map((session) => {
          const prompt = session.messages.find((message) => message.id === promptMessageId)
          if (
            session.id !== sessionId ||
            prompt?.role !== 'user' ||
            session.resumeRecovery?.promptMessageId !== promptMessageId ||
            (session.activeRun && session.activeRun.promptMessageId !== promptMessageId)
          ) {
            return session
          }

          const now = Date.now()
          const withProvider = {
            ...session,
            agentFrameworkId: update?.agentFrameworkId ?? session.agentFrameworkId,
            agentBackendId: update?.agentBackendId ?? session.agentBackendId,
            providerSessionId: update?.providerSessionId ?? session.providerSessionId,
            providerContinuityToken:
              update === undefined
                ? session.providerContinuityToken
                : update.providerContinuityToken
          }
          const isRetryingPreparedContext =
            contextReset && session.pendingHistoryReplay !== undefined
          const conversationGraph = contextReset
            ? synchronizeSessionGraph(
                withProvider,
                withProvider.messages,
                now,
                withProvider.agentFrameworkId ?? 'claude-code',
                withProvider.agentBackendId,
                withProvider.agentModel,
                !isRetryingPreparedContext
              )
            : withProvider.conversationGraph
          const runtimeSegmentId = conversationGraph?.runtimeSegments
            .filter((segment) => segment.agentFrameId === conversationGraph.activeFrameId)
            .at(-1)?.id
          prepared = runtimeSegmentId ? { runtimeSegmentId } : {}
          return {
            ...withProvider,
            status: 'running',
            activeRun: { promptMessageId, startedAt: now },
            activeRunRuntimeSegmentId: runtimeSegmentId,
            awaitingFirstAgentOutput: true,
            agentStatus: undefined,
            error: undefined,
            errorReportable: undefined,
            pendingHistoryReplay: contextReset
              ? (session.pendingHistoryReplay ?? {
                  kind: 'before-message',
                  messageId: promptMessageId
                })
              : session.pendingHistoryReplay,
            compacting: undefined,
            conversationGraph,
            updatedAt: now
          }
        })
      }))
      return prepared
    },

    completeInterruptedTurnResume: (sessionId) => {
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, sessionId, (session) => ({
          ...session,
          interrupted: undefined,
          resumeRecovery: undefined,
          error: undefined,
          errorReportable: undefined,
          pendingHistoryReplay: undefined,
          updatedAt: Date.now()
        }))
      }))
    },

    clearPendingHistoryReplay: (sessionId, replay) => {
      setSessionState((state) => ({
        sessions: state.sessions.map((session) => {
          const pending = session.pendingHistoryReplay
          const matches =
            pending?.kind === replay.kind &&
            (replay.kind === 'all' ||
              (pending.kind === 'before-message' && pending.messageId === replay.messageId))
          return session.id === sessionId && matches
            ? { ...session, pendingHistoryReplay: undefined }
            : session
        })
      }))
    },

    failRun: (sessionId, error, opts) => {
      const message = error.trim()
      if (!message) return
      setSessionState((state) =>
        projectTerminalRun(state, sessionId, (session) =>
          projectFailedRun(
            session,
            message,
            opts?.reportable,
            opts?.promptMessageId,
            opts?.contextWindowSample
          )
        )
      )
    },

    setAgentStatus: (sessionId, text) => {
      const trimmed = text.trim()
      if (!trimmed) return
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, sessionId, (session) =>
          projectAgentStatus(session, trimmed)
        )
      }))
    },

    beginCompaction: (sessionId, options) => {
      setSessionState((state) =>
        projectTerminalRun(state, sessionId, (session) =>
          projectCompactionStarted(session, options?.supersedeActiveRun)
        )
      )
    },

    finishCompaction: (sessionId) => {
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, sessionId, projectCompactionFinished)
      }))
    },

    failCompaction: (sessionId, error) => {
      const message = error.trim()
      if (!message) return
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, sessionId, (session) =>
          projectCompactionFailed(session, message)
        )
      }))
    }
  }
}
