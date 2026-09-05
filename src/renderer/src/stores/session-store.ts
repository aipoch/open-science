import { create, type StateCreator } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'

import type { AcpContextUsage } from '../../../shared/acp'
import type { PermissionProfileId } from '../../../shared/permission-profiles'
import type { SessionAgentConfiguration } from '../../../shared/settings'
import type { UpdateSessionArchiveRequest } from '../../../shared/session-persistence'
import { createSessionMessageGraphOwner } from './session-store-message-graph-owner'
import type { SessionMessageGraphActions } from './session-store-message-graph-helpers'
import {
  createSessionRunProjectionOwner,
  type SessionRunProjectionActions
} from './session-store-run-projection-owner'
import { projectInterruptedRun } from './session-store-run-terminal-helpers'
import {
  createInitialSessionState,
  createSessionPersistenceOwner,
  hydrateSession,
  materializeStreamingMessageContent,
  removeStreamingMessageContentForSession,
  type ChatSession,
  type SessionPersistenceActions,
  type SessionStoreData
} from './session-store-persistence-owner'

export {
  createInitialSessionState,
  getExternallyHydratedSessionAuthority,
  isExternallyHydratedSession,
  toPersistedSession,
  type ActiveRun,
  type ChatMessage,
  type ChatMessageRole,
  type ChatMessageStatus,
  type ChatSession,
  type SessionHydrationSelection,
  type SessionStatus,
  type StreamingMessageContent,
  type StreamingMessageContentByMessageId,
  type ToolActivity,
  type ToolActivityStatus
} from './session-store-persistence-owner'

export type { BranchInNewSessionInput } from './session-store-message-graph-helpers'

export {
  isSessionWaitReason,
  projectSessionActionability,
  resolveRootPermissionPending,
  sessionAwaitsHistoryReplay,
  type SessionActionabilityFacts,
  type SessionActionabilityProjection,
  type SessionActionAvailability,
  type SessionActionDisabledReason,
  type SessionBlockingInteraction,
  type SessionWaitReason
} from './session-store-interaction-state'

type SessionStore = SessionStoreData &
  SessionPersistenceActions &
  SessionMessageGraphActions &
  SessionRunProjectionActions & {
    selectSession: (sessionId: string) => void
    clearSelection: () => void
    markDisconnected: (sessionId: string, reason?: string) => void
    setBranchSwitchBlocked: (sessionId: string, blocked: boolean) => void
    clearBranchContextReset: (sessionId: string) => void
    markSpecialistSwitchResetRequired: (sessionId: string) => void
    clearSpecialistSwitchResetRequired: (sessionId: string) => void
    setContextUsage: (sessionId: string, contextUsage: AcpContextUsage | undefined) => void
    setPermissionProfile: (sessionId: string, profile: PermissionProfileId) => void
    setAgentConfiguration: (
      sessionId: string,
      configuration: SessionAgentConfiguration,
      options?: { preserveUpdatedAt?: boolean }
    ) => void
    // Persists the per-session auto-review toggle. true = on; false = off (default).
    setAutoReviewEnabled: (sessionId: string, enabled: boolean) => void
    // Persists whether this Session may receive recalled Memory and Memory tools.
    setMemoryEnabled: (sessionId: string, enabled: boolean) => void
    // Mirrors Main's desired Specialist binding and its durable pending marker. Passing undefined
    // clears the binding (Main Agent); pending blocks sends until Main confirms runtime application.
    setSessionSpecialistId: (
      sessionId: string,
      specialistId: string | undefined,
      pending?: boolean
    ) => void
    // Toggles whether a conversation is pinned to the top section of the sidebar.
    togglePinned: (sessionId: string) => void
    updateSessionArchive: (request: UpdateSessionArchiveRequest) => Promise<ChatSession>
    // Sets or clears the per-session fix loop active flag. When true, the composer send button is
    // disabled for this session; when false (loop ended or cancelled), send is re-enabled.
    setFixLoopActive: (sessionId: string, active: boolean) => void
    renameSession: (sessionId: string, title: string) => void
    deleteSession: (sessionId: string) => void
    removeSessionsForProject: (projectId: string) => void
  }

// Navigation and deletion use the same visible, project-scoped fallback, regardless of list order.
export const findMostRecentSessionId = (
  sessions: ChatSession[],
  projectId: string
): string | undefined =>
  sessions
    .filter(
      (session) =>
        session.projectId === projectId && !session.isPending && session.archivedAt === undefined
    )
    .sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id

// Stores all transient workspace conversation state for the renderer process.
const createSessionStoreInitializer = (): StateCreator<SessionStore> => (set, get) => ({
  ...createInitialSessionState(),

  // Selects only existing sessions so deleted ids cannot remain active.
  selectSession: (sessionId) => {
    if (!get().sessions.some((session) => session.id === sessionId)) return

    set({ selectedSessionId: sessionId })
  },

  // Clears visible conversation selection without deleting session history.
  clearSelection: () => {
    set({ selectedSessionId: undefined })
  },

  ...createSessionMessageGraphOwner<SessionStore>(set, get),
  ...createSessionPersistenceOwner<SessionStore>(set),

  ...createSessionRunProjectionOwner<SessionStore>(set, get),

  // Flags a session dropped by a live connection loss so the Resume banner appears; like failRun it
  // settles any half-streamed message/open tool so nothing hangs in a perpetually-running state.
  markDisconnected: (sessionId, reason) => {
    // Preserve the specific failure cause (e.g. "Connection timeout") when the caller has one,
    // while keeping the Resume affordance. Fall back to a generic message otherwise.
    const trimmedReason = reason?.trim()
    const error = trimmedReason
      ? `${trimmedReason} — Resume to reconnect and continue.`
      : 'Connection lost — Resume to reconnect and continue.'
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? projectInterruptedRun(
              materializeStreamingMessageContent(session, state.streamingMessages),
              'connection-lost',
              error
            )
          : session
      ),
      streamingMessages: removeStreamingMessageContentForSession(state.streamingMessages, sessionId)
    }))
  },

  setBranchSwitchBlocked: (sessionId, blocked) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId && Boolean(session.branchSwitchBlocked) !== blocked
          ? { ...session, branchSwitchBlocked: blocked || undefined }
          : session
      )
    }))
  },

  clearBranchContextReset: (sessionId) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId ? { ...session, branchContextResetRequired: undefined } : session
      )
    }))
  },

  // Marks that a specialist switch replaced the live agent session; the next send replays history
  // into the fresh session so the new specialist keeps conversation continuity. Distinct from
  // branchContextResetRequired because it must NOT shut down the notebook kernel.
  markSpecialistSwitchResetRequired: (sessionId) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId ? { ...session, specialistSwitchResetRequired: true } : session
      )
    }))
  },

  clearSpecialistSwitchResetRequired: (sessionId) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? { ...session, specialistSwitchResetRequired: undefined }
          : session
      )
    }))
  },

  // Stores the approval posture with the conversation so resumes and provider switches reapply it.
  setPermissionProfile: (sessionId, profile) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              permissionProfile: profile,
              updatedAt: Date.now()
            }
          : session
      )
    }))
  },

  setAgentConfiguration: (sessionId, configuration, options) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              agentConfiguration: configuration,
              ...(options?.preserveUpdatedAt ? {} : { updatedAt: Date.now() })
            }
          : session
      )
    }))
  },

  // Persists the per-session auto-review toggle so finishRun can skip a review when disabled.
  setAutoReviewEnabled: (sessionId, enabled) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              autoReviewEnabled: enabled,
              updatedAt: Date.now()
            }
          : session
      )
    }))
  },

  setMemoryEnabled: (sessionId, enabled) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              memoryEnabled: enabled,
              updatedAt: Date.now()
            }
          : session
      )
    }))
  },

  setContextUsage: (sessionId, contextUsage) => {
    set((state) => {
      const session = state.sessions.find((candidate) => candidate.id === sessionId)
      if (!session || JSON.stringify(session.contextUsage) === JSON.stringify(contextUsage)) {
        return state
      }

      return {
        sessions: state.sessions.map((candidate) =>
          candidate.id === sessionId ? { ...candidate, contextUsage } : candidate
        )
      }
    })
  },

  setSessionSpecialistId: (sessionId, specialistId, pending = false) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              specialistId: specialistId ?? undefined,
              specialistBindingPending: pending ? true : undefined,
              updatedAt: Date.now()
            }
          : session
      )
    }))
  },

  // Flips the pinned flag so the sidebar can float the conversation into its pinned section. The flag
  // is persisted via the durable projection, but updatedAt is deliberately left untouched so pinning
  // never disturbs the "last active" ordering within a section.
  togglePinned: (sessionId) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId ? { ...session, pinned: !session.pinned } : session
      )
    }))
  },

  updateSessionArchive: async (request) => {
    const source = get().sessions.find((session) => session.id === request.sessionId)
    const persisted = await window.api.sessions.updateArchive(request)
    if (source)
      get().applyDurableSessionProjection({ source, session: persisted, mode: 'archive-authority' })
    return (
      get().sessions.find((session) => session.id === persisted.id) ?? hydrateSession(persisted)
    )
  },

  // Sets or clears the per-session fix loop active flag. The flag is transient (never persisted)
  // and gates canSendMessage in WorkspacePage: true blocks send for the duration of the fix loop.
  setFixLoopActive: (sessionId, active) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              fixLoopActive: active,
              updatedAt: Date.now()
            }
          : session
      )
    }))
  },

  // Renames a session while ignoring blank titles.
  renameSession: (sessionId, title) => {
    const trimmedTitle = title.trim()

    if (!trimmedTitle) return

    set((state) => {
      let changed = false
      const sessions = state.sessions.map((session) => {
        if (session.id !== sessionId || session.title === trimmedTitle) return session
        changed = true
        return {
          ...session,
          title: trimmedTitle,
          unsavedTitle: true as const,
          updatedAt: Date.now()
        }
      })
      return changed ? { sessions } : state
    })
  },

  // Removes a session and falls selection back to the next session within the same project.
  deleteSession: (sessionId) => {
    set((state) => {
      const deletedSession = state.sessions.find((session) => session.id === sessionId)
      if (!deletedSession) return state

      const sessions = state.sessions.filter((session) => session.id !== sessionId)
      const streamingMessages = removeStreamingMessageContentForSession(
        state.streamingMessages,
        sessionId
      )

      if (state.selectedSessionId !== sessionId) {
        return {
          sessions,
          streamingMessages,
          selectedSessionId: state.selectedSessionId
        }
      }

      return {
        sessions,
        streamingMessages,
        selectedSessionId: findMostRecentSessionId(sessions, deletedSession.projectId)
      }
    })
  },

  // Drops every session belonging to a deleted project; the persistence bridge removes their files.
  removeSessionsForProject: (projectId) => {
    set((state) => {
      const removedSessionIds = new Set(
        state.sessions.flatMap((session) => (session.projectId === projectId ? [session.id] : []))
      )
      const sessions = state.sessions.filter((session) => session.projectId !== projectId)
      if (sessions.length === state.sessions.length) return state

      const selectedRemoved = !sessions.some((session) => session.id === state.selectedSessionId)
      let streamingMessages = state.streamingMessages
      for (const sessionId of removedSessionIds) {
        streamingMessages = removeStreamingMessageContentForSession(streamingMessages, sessionId)
      }

      return {
        sessions,
        streamingMessages,
        selectedSessionId: selectedRemoved ? sessions[0]?.id : state.selectedSessionId
      }
    })
  }
})

type SessionStoreApi = StoreApi<SessionStore>

export const createSessionStore = (): SessionStoreApi =>
  createStore<SessionStore>(createSessionStoreInitializer())

export const useSessionStore = create<SessionStore>(createSessionStoreInitializer())

export {
  isArtifactFinalizationError,
  isRetryableArtifactFinalizationError
} from './session-store-run-terminal-helpers'
export type { SessionStore, SessionStoreApi }
