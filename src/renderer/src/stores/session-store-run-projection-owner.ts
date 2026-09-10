import {
  type PersistedMessageNode,
  projectConversationMessage,
  resolveActiveConversationActivities,
  resolveActiveConversationMessages
} from '../../../shared/conversation-graph'
import type { StoreApi } from 'zustand'

import type { ActivePlanProjection } from '../../../shared/session-plan/contract'
import {
  MAX_ELICITATION_MESSAGE_CHARS,
  MAX_ELICITATION_MULTI_SELECT_VALUES,
  resolveAgentUserChoiceQuestions
} from '../../../shared/elicitation'
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
import type {
  ChatSession,
  ElicitationEditDraft,
  SessionStoreData
} from './session-store-persistence-owner'
import {
  hydrateToolActivity,
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
    >,
    options?: { preserveCompaction?: boolean }
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
  setElicitationEditDraft: (
    sessionId: string,
    activityId: string,
    requestId: string,
    draft: ElicitationEditDraft | undefined
  ) => void
  setElicitationDraftAnswers: (
    sessionId: string,
    activityId: string,
    answers: ElicitationAnswer[]
  ) => void
  setActivePlanProjection: (sessionId: string, projection: ActivePlanProjection) => void
  invalidateActivePlanProjection: (
    sessionId: string,
    expected: Pick<ActivePlanProjection, 'artifactVersionId' | 'revision'>
  ) => void
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

const findOffBranchRunPrompt = (
  session: ChatSession,
  promptMessageId: string | undefined
): PersistedMessageNode | undefined => {
  const graph = session.conversationGraph
  const promptId = promptMessageId ?? session.activeRun?.promptMessageId
  const prompt = graph?.messages.find(
    (message) => message.id === promptId && message.role === 'user'
  )
  const activeFrame = graph?.frames.find((frame) => frame.id === graph.activeFrameId)
  if (!graph || !prompt || !activeFrame) return undefined
  if (
    activeFrame.id === prompt.agentFrameId &&
    activeFrame.activeBranchId === prompt.introducedOnBranchId
  )
    return undefined
  // A flat transcript that disagrees with its selected graph path is an existing integrity error,
  // not a valid branch switch. Leave it to the normal projection/error handling.
  if (
    session.messages.some((message) => message.id === prompt.id) &&
    !resolveActiveConversationMessages(graph).some((message) => message.id === prompt.id)
  )
    return undefined
  return prompt
}

// Runtime events keep their prompt owner even when a persisted branch selection arrives while
// the run is in flight. Project through that branch, then restore the UI selection.
const projectRunBranch = (
  session: ChatSession,
  promptMessageId: string | undefined,
  projector: (session: ChatSession) => ChatSession
): ChatSession => {
  const prompt = findOffBranchRunPrompt(session, promptMessageId)
  const graph = session.conversationGraph
  if (!graph || !prompt) return projector(session)
  const runBranches = new Map([[prompt.agentFrameId, prompt.introducedOnBranchId]])
  let frame = graph.frames.find((candidate) => candidate.id === prompt.agentFrameId)
  // A hidden delegate also needs its ancestors on the branches containing each frame origin.
  // These selections exist only during projection; the caller's selections are restored below.
  while (frame?.parentFrameId) {
    const { originMessageId, parentFrameId } = frame
    const origin = graph.messages.find((message) => message.id === originMessageId)
    if (!origin) break
    runBranches.set(parentFrameId, origin.introducedOnBranchId)
    frame = graph.frames.find((candidate) => candidate.id === parentFrameId)
  }
  const runGraph = {
    ...graph,
    activeFrameId: prompt.agentFrameId,
    frames: graph.frames.map((frame) => {
      const branchId = runBranches.get(frame.id)
      return branchId ? { ...frame, activeBranchId: branchId } : frame
    })
  }
  const activities = resolveActiveConversationActivities(runGraph)
  const runSession = {
    ...session,
    conversationGraph: runGraph,
    messages: resolveActiveConversationMessages(runGraph).map(projectConversationMessage),
    activities: activities.activities.map((activity) =>
      hydrateToolActivity({
        ...activity,
        promptMessageId: graph.activities.find(({ id }) => id === activity.id)?.promptMessageId
      })
    ),
    activityGroups: activities.activityGroups.map((group) => ({
      ...group,
      promptMessageId: graph.activityGroups.find(({ id }) => id === group.id)?.promptMessageId
    }))
  }
  const projected = projector(runSession)
  if (projected === runSession) return session
  const updatedGraph = synchronizeSessionGraph(projected, projected.messages, projected.updatedAt)
  return {
    ...projected,
    messages: session.messages,
    activities: session.activities,
    activityGroups: session.activityGroups,
    conversationGraph: {
      ...updatedGraph,
      activeFrameId: graph.activeFrameId,
      frames: updatedGraph.frames.map((frame) => ({
        ...frame,
        activeBranchId: graph.frames.find((original) => original.id === frame.id)!.activeBranchId
      }))
    }
  }
}

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
      const sessionInputs = indexes.map((index) => inputs[index])
      if (sessionInputs.some((input) => findOffBranchRunPrompt(session, input.promptMessageId))) {
        let next = session
        for (const index of indexes) {
          next = projectRunBranch(next, inputs[index].promptMessageId, (runSession) => {
            const projection = projectAgentMessageChunks(
              runSession,
              [inputs[index]],
              streamingMessages
            )
            streamingMessages = projection.streamingMessages
            indexedResults[index] = projection.results[0]
            return materializeStreamingMessageContent(projection.session, streamingMessages)
          })
        }
        sessionsChanged ||= next !== session
        return next
      }
      const projection = projectAgentMessageChunks(session, sessionInputs, streamingMessages)
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
    projector: (session: ChatSession) => ChatSession,
    promptMessageId?: string
  ): Partial<SessionStoreData> => {
    let projected = false
    const sessions = projectSession(state.sessions, sessionId, (session) => {
      const next = projectRunBranch(session, promptMessageId, (runSession) => {
        const materialized = materializeStreamingMessageContent(runSession, state.streamingMessages)
        const projected = projector(materialized)
        // A projector that declines keeps the original Session and streaming slice.
        return projected === materialized ? runSession : projected
      })
      if (next === session) return session
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
          return projectRunBranch(session, input.promptMessageId, (runSession) => {
            const projection = projectRunArtifacts(runSession, input)
            result = projection.result
            return projection.session
          })
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

    invalidateActivePlanProjection: (sessionId, expected) => {
      setSessionState((state) => {
        const session = state.sessions.find((candidate) => candidate.id === sessionId)
        const projection = session?.activePlanProjection
        if (
          !projection ||
          projection.artifactVersionId !== expected.artifactVersionId ||
          projection.revision !== expected.revision
        ) {
          return state
        }
        return {
          sessions: projectSession(state.sessions, sessionId, (current) => ({
            ...current,
            activePlanProjection: undefined
          }))
        }
      })
    },

    upsertToolActivity: (input) => {
      if (!input.sessionId || !input.toolCallId || !input.eventId) return
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, input.sessionId, (session) =>
          projectRunBranch(session, input.promptMessageId, (runSession) =>
            projectToolActivity(runSession, input)
          )
        )
      }))
    },

    setElicitationEditDraft: (sessionId, activityId, requestId, draft) => {
      const session = get().sessions.find((item) => item.id === sessionId)
      const activity = session?.activities?.find((item) => item.id === activityId)
      if (
        !session ||
        activity?.elicitation?.state !== 'pending' ||
        (activity.elicitation.durable && activity.elicitation.durable.requestId !== requestId) ||
        (draft && draft.requestId !== requestId)
      )
        return
      if (!draft && session.elicitationEditDrafts?.[activityId]?.requestId !== requestId) return
      const drafts = { ...session.elicitationEditDrafts }
      if (draft) {
        const questions = resolveAgentUserChoiceQuestions(activity.elicitation.fields)
        if (
          !questions ||
          !Number.isInteger(draft.activeQuestionIndex) ||
          draft.activeQuestionIndex < 0 ||
          draft.activeQuestionIndex >= questions.length
        )
          return
        drafts[activityId] = {
          ...draft,
          values: Object.fromEntries(
            activity.elicitation.fields.map((field) => {
              const value = draft.values[field.id]
              return [
                field.id,
                typeof value === 'string'
                  ? value.slice(0, MAX_ELICITATION_MESSAGE_CHARS)
                  : Array.isArray(value)
                    ? value.slice(0, MAX_ELICITATION_MULTI_SELECT_VALUES)
                    : undefined
              ]
            })
          )
        }
      } else delete drafts[activityId]
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, sessionId, (current) => ({
          ...current,
          elicitationEditDrafts: drafts
        }))
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
          projectRunBranch(session, promptMessageId, (runSession) =>
            projectActivityGroupStart(runSession, groupId, title, promptMessageId)
          )
        )
      }))
    },

    completeActivityGroup: (sessionId, promptMessageId) => {
      if (!sessionId) return
      const now = Date.now()
      setSessionState((state) => {
        const target = state.sessions.find((session) => session.id === sessionId)
        if (!target) return state
        const projected = projectRunBranch(target, promptMessageId, (runSession) =>
          projectActivityGroupCompletion(runSession, promptMessageId, now)
        )
        if (projected === target) return state
        return {
          sessions: projectSession(state.sessions, sessionId, () => projected)
        }
      })
    },

    finishRun: (sessionId, turnUsage, promptMessageId, contextWindowSample, modelCallUsage) => {
      setSessionState((state) =>
        projectTerminalRun(
          state,
          sessionId,
          (session) =>
            projectFinishedRun(
              session,
              turnUsage,
              promptMessageId,
              contextWindowSample,
              modelCallUsage
            ),
          promptMessageId
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
        projectTerminalRun(
          state,
          sessionId,
          (session) =>
            projectInterruptedRun(
              session,
              cause,
              error,
              promptMessageId,
              contextWindowSample,
              turnUsage,
              modelCallUsage
            ),
          promptMessageId
        )
      )
    },

    // Clears the interrupted/error state after a successful resume so the composer is usable again.
    markResumed: (sessionId, update, options) => {
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
          compacting: options?.preserveCompaction ? session.compacting : undefined,
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
        projectTerminalRun(
          state,
          sessionId,
          (session) =>
            projectFailedRun(
              session,
              message,
              opts?.reportable,
              opts?.promptMessageId,
              opts?.contextWindowSample
            ),
          opts?.promptMessageId
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
