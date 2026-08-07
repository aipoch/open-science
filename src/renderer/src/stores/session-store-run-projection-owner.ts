import type { StoreApi } from 'zustand'

import type { ActivePlanProjection } from '../../../shared/session-plan/contract'
import type { AcpTurnTokenUsage } from '../../../shared/acp'
import type { AppendMessageResult } from './session-store-message-graph-helpers'
import {
  canStartActivityGroup,
  projectActivePlan,
  projectActivityGroupCompletion,
  projectActivityGroupStart,
  projectToolActivity,
  type UpsertToolActivityInput
} from './session-store-run-activity-helpers'
import {
  projectAgentMessageChunk,
  projectMessageArtifacts,
  projectMessageUploads,
  projectRunArtifacts,
  type AppendAgentMessageChunkInput,
  type AttachRunArtifactsInput,
  type ReplaceMessageArtifactsInput,
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
  projectFailedRun,
  projectFinishedRun
} from './session-store-run-terminal-helpers'
import type { ChatSession, SessionStoreData } from './session-store-persistence-owner'

type SessionStateSetter = StoreApi<SessionStoreData>['setState']

export type SessionRunProjectionActions = {
  appendAgentMessageChunk: (input: AppendAgentMessageChunkInput) => AppendMessageResult | undefined
  setAwaitingFirstAgentOutput: (sessionId: string, waiting: boolean) => void
  setAgentPromptInFlight: (sessionId: string, inFlight: boolean) => void
  attachRunArtifacts: (input: AttachRunArtifactsInput) => AppendMessageResult | undefined
  replaceMessageArtifacts: (input: ReplaceMessageArtifactsInput) => void
  replaceMessageUploads: (input: ReplaceMessageUploadsInput) => void
  recordArtifactError: (sessionId: string, error: string) => void
  clearArtifactError: (sessionId: string) => void
  finishRun: (sessionId: string, turnUsage?: AcpTurnTokenUsage, promptMessageId?: string) => void
  failRun: (sessionId: string, error: string, opts?: { reportable?: boolean }) => void
  setAgentStatus: (sessionId: string, text: string) => void
  beginCompaction: (sessionId: string, options?: { supersedeActiveRun?: boolean }) => void
  finishCompaction: (sessionId: string) => void
  failCompaction: (sessionId: string, error: string) => void
  upsertToolActivity: (input: UpsertToolActivityInput) => void
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

  return {
    appendAgentMessageChunk: (input) => {
      if (!input.sessionId) return undefined
      const state = get()
      const session = state.sessions.find((candidate) => candidate.id === input.sessionId)
      if (!session) return undefined
      const projection = projectAgentMessageChunk(session, input)
      if (!projection.result) return undefined
      if (projection.shouldCommit)
        setSessionState({
          sessions: state.sessions.map((candidate) =>
            candidate.id === input.sessionId ? projection.session : candidate
          )
        } as Partial<State>)
      return projection.result
    },

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

    recordArtifactError: (sessionId, error) => {
      const message = error.trim()
      if (!sessionId || !message) return
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, sessionId, (session) =>
          projectArtifactError(session, message)
        )
      }))
    },

    clearArtifactError: (sessionId) => {
      if (!sessionId) return
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, sessionId, projectArtifactErrorCleared)
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

    finishRun: (sessionId, turnUsage, promptMessageId) => {
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, sessionId, (session) =>
          projectFinishedRun(session, turnUsage, promptMessageId)
        )
      }))
    },

    failRun: (sessionId, error, opts) => {
      const message = error.trim()
      if (!message) return
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, sessionId, (session) =>
          projectFailedRun(session, message, opts?.reportable)
        )
      }))
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
      setSessionState((state) => ({
        sessions: projectSession(state.sessions, sessionId, (session) =>
          projectCompactionStarted(session, options?.supersedeActiveRun)
        )
      }))
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
