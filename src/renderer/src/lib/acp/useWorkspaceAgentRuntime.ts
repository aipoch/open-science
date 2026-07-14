import { useCallback, useEffect, useRef } from 'react'

import type {
  AcpPermissionGrant,
  AcpPermissionRequest,
  AcpRuntimeEvent
} from '../../../../shared/acp'
import {
  DEFAULT_PERMISSION_PROFILE,
  type PermissionProfileId,
  type SessionPermissionProfileState
} from '../../../../shared/permission-profiles'
import type { UploadedAttachment } from '../../../../shared/uploads'
import type { ArtifactReference } from '../../../../shared/artifacts'
import type { MessagePart } from '../../../../shared/session-persistence'
import { useSessionStore } from '../../stores/session-store'
import { useAcpRuntime } from './useAcpRuntime'
import { applyWorkspaceRuntimeEvent, syncWorkspacePermissionState } from './workspace-events'

type SendWorkspaceMessageInput = {
  sessionId?: string
  text: string
  attachments?: UploadedAttachment[]
  cwd?: string
  // Durable owning project stamped on new sessions.
  projectId?: string
  // Storage project the artifact/notebook MCP servers write under (usually the same value).
  projectName?: string
  permissionProfile?: PermissionProfileId
  // Skills the user picked in the composer; force-loaded and nudged for this turn only.
  forcedSkillIds?: string[]
  // Existing files referenced via `@` mentions; attached to the prompt as content blocks.
  referencedArtifacts?: ArtifactReference[]
  // Structured mention segments of the draft, persisted so the sent bubble renders styled pills.
  parts?: MessagePart[]
}

type SendWorkspaceMessageResult = {
  sessionId: string
  messageId: string
}

type WorkspaceMessageRuntime = Pick<
  ReturnType<typeof useAcpRuntime>,
  'state' | 'createSession' | 'resumeSession' | 'sendPrompt'
>

type RuntimeEventApplier = (event: AcpRuntimeEvent) => Promise<boolean>

type WorkspaceRuntimeEventProcessor = {
  process: (events: AcpRuntimeEvent[]) => Promise<void>
}

// The agent process reports a deleted/moved workspace folder as "cwd does not exist"; surface
// that as the same actionable message already used when a session has no cwd to resume into.
const getResumeFailureMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)

  if (/cwd does not exist/i.test(message)) {
    return 'Session workspace is missing; start a new conversation.'
  }

  return 'Agent session resume failed'
}

// Keeps attachment-finalization failures displayable without assuming Error instances.
const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// Moves staged uploads into the session directory and updates the already-visible user message.
const finalizeWorkspaceAttachments = async (
  sessionId: string,
  messageId: string,
  attachments: UploadedAttachment[]
): Promise<UploadedAttachment[]> => {
  if (attachments.length === 0) return attachments

  // The renderer message is written before runtime work starts, so its upload paths are replaced.
  const finalizedAttachments = await window.api.uploads.finalizeSession({
    sessionId,
    attachments
  })

  useSessionStore.getState().replaceMessageUploads({
    sessionId,
    messageId,
    uploads: finalizedAttachments
  })

  return finalizedAttachments
}

const processVisibleWorkspaceRuntimeEvents = async (
  events: AcpRuntimeEvent[],
  processedEventIds: Set<string>,
  applyEvent: RuntimeEventApplier = applyWorkspaceRuntimeEvent,
  processingEventIds = new Set<string>()
): Promise<void> => {
  // Runtime snapshots are bounded, so forget ids that can no longer be replayed from the source list.
  const visibleEventIds = new Set(events.map((event) => event.id))

  for (const eventId of processedEventIds) {
    if (!visibleEventIds.has(eventId)) {
      processedEventIds.delete(eventId)
    }
  }

  for (const eventId of processingEventIds) {
    if (!visibleEventIds.has(eventId)) {
      processingEventIds.delete(eventId)
    }
  }

  for (const event of events) {
    if (processedEventIds.has(event.id) || processingEventIds.has(event.id)) continue

    processingEventIds.add(event.id)
    try {
      // Apply visible events sequentially so message chunks and artifact finalization stay ordered.
      await applyEvent(event)
      processedEventIds.add(event.id)
    } catch {
      // Artifact finalization errors are recorded by the adapter before throwing.
      // Keeping this id unprocessed lets the same visible runtime event retry.
      continue
    } finally {
      processingEventIds.delete(event.id)
    }
  }
}

const createWorkspaceRuntimeEventProcessor = (
  applyEvent: RuntimeEventApplier = applyWorkspaceRuntimeEvent
): WorkspaceRuntimeEventProcessor => {
  const processedEventIds = new Set<string>()
  const processingEventIds = new Set<string>()
  let latestEvents: AcpRuntimeEvent[] = []
  let drainInFlight: Promise<void> | undefined
  let drainAgain = false

  // Coalesces rapid runtime snapshots while preserving a single ordered drain loop.
  const drain = async (): Promise<void> => {
    if (drainInFlight) {
      drainAgain = true
      return drainInFlight
    }

    drainInFlight = (async () => {
      do {
        drainAgain = false
        await processVisibleWorkspaceRuntimeEvents(
          latestEvents,
          processedEventIds,
          applyEvent,
          processingEventIds
        )
      } while (drainAgain)
    })()

    try {
      await drainInFlight
    } finally {
      drainInFlight = undefined
    }
  }

  return {
    process: (events) => {
      latestEvents = events
      return drain()
    }
  }
}

// Finishes the ACP session handshake for a prompt that is already visible locally.
const startPendingSessionPrompt = (
  runtime: WorkspaceMessageRuntime,
  pending: SendWorkspaceMessageResult,
  content: string,
  attachments: UploadedAttachment[],
  cwd: string | undefined,
  projectName: string | undefined,
  permissionProfile: PermissionProfileId,
  forcedSkillIds: string[] | undefined,
  referencedArtifacts: ArtifactReference[] | undefined
): void => {
  void (async () => {
    let createdSession

    try {
      createdSession = await runtime.createSession(cwd, projectName, permissionProfile)
    } catch (error) {
      useSessionStore.getState().failRun(pending.sessionId, getErrorMessage(error))
      return
    }

    const runtimeSessionId = createdSession?.sessionId

    if (!runtimeSessionId) {
      useSessionStore.getState().failRun(pending.sessionId, 'Agent session could not be created.')
      return
    }

    const bound = useSessionStore.getState().bindPendingSession({
      pendingSessionId: pending.sessionId,
      sessionId: runtimeSessionId,
      cwd: createdSession.cwd ?? cwd ?? runtime.state.cwd
    })

    if (!bound) return

    let promptAttachments = attachments

    try {
      // Pending conversations only learn their durable id after createSession completes.
      if (attachments.length > 0) {
        promptAttachments = await finalizeWorkspaceAttachments(
          runtimeSessionId,
          bound.messageId,
          attachments
        )
      }
    } catch (error) {
      useSessionStore.getState().failRun(runtimeSessionId, getErrorMessage(error))
      return
    }

    void runtime
      .sendPrompt(runtimeSessionId, content, promptAttachments, forcedSkillIds, referencedArtifacts)
      .then((snapshot) => {
        if (!snapshot) {
          useSessionStore.getState().failRun(runtimeSessionId, 'Agent run failed')
        }
      })
      .catch((error) => {
        // A rejected prompt (e.g. an upstream gateway 5xx) must surface as a visible session error
        // instead of being swallowed as an unhandled rejection.
        useSessionStore.getState().failRun(runtimeSessionId, getErrorMessage(error))
      })
  })()
}

// Records the user's prompt before slow runtime work continues.
const sendWorkspaceMessage = async (
  runtime: WorkspaceMessageRuntime,
  {
    sessionId,
    text,
    attachments = [],
    cwd,
    projectId,
    projectName,
    permissionProfile,
    forcedSkillIds,
    referencedArtifacts,
    parts
  }: SendWorkspaceMessageInput
): Promise<SendWorkspaceMessageResult | undefined> => {
  const content = text.trim()

  // Empty drafts are allowed only when the user attached at least one file.
  if (!content && attachments.length === 0) return undefined

  const targetSessionId = sessionId
  const targetCwd = cwd

  if (targetSessionId) {
    const currentSession = useSessionStore
      .getState()
      .sessions.find((session) => session.id === targetSessionId)

    if (currentSession?.status === 'running' || currentSession?.status === 'waiting-permission') {
      return undefined
    }

    // Existing sessions keep their own project; new/pending ones fall back to the caller's project.
    const sessionProjectName = projectName ?? currentSession?.projectId

    if (currentSession?.isPending) {
      const retryCwd = targetCwd ?? currentSession.cwd ?? runtime.state.cwd
      const appended = useSessionStore.getState().appendUserMessage({
        sessionId: currentSession.id,
        content,
        attachments,
        parts,
        cwd: retryCwd,
        projectId: projectId ?? currentSession.projectId
      })

      if (!appended) return undefined

      startPendingSessionPrompt(
        runtime,
        appended,
        content,
        attachments,
        retryCwd,
        sessionProjectName,
        currentSession.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
        forcedSkillIds,
        referencedArtifacts
      )
      return appended
    }

    const shouldResumeSession = !runtime.state.sessionIds.includes(targetSessionId)
    let resumeCwd: string | undefined

    if (shouldResumeSession) {
      if (!targetCwd) {
        useSessionStore
          .getState()
          .failRun(targetSessionId, 'Session workspace is missing; start a new conversation.')
        return undefined
      }

      resumeCwd = targetCwd
    }

    const appended = useSessionStore.getState().appendUserMessage({
      sessionId: targetSessionId,
      content,
      attachments,
      parts,
      cwd: targetCwd,
      projectId: projectId ?? currentSession?.projectId
    })

    // appendUserMessage can reject stale session ids after local deletion or hydration changes.
    if (!appended) return undefined

    // Persisted sessions are marked running locally before async resume closes duplicate submits.
    if (resumeCwd) {
      try {
        await runtime.resumeSession(
          targetSessionId,
          resumeCwd,
          sessionProjectName,
          currentSession?.permissionProfile ?? permissionProfile
        )
      } catch (error) {
        useSessionStore.getState().failRun(targetSessionId, getResumeFailureMessage(error))
        return appended
      }
    }

    let promptAttachments = attachments

    try {
      // Existing sessions can finalize immediately because their durable id is already known.
      if (attachments.length > 0) {
        promptAttachments = await finalizeWorkspaceAttachments(
          targetSessionId,
          appended.messageId,
          attachments
        )
      }
    } catch (error) {
      useSessionStore.getState().failRun(targetSessionId, getErrorMessage(error))
      return appended
    }

    // The hook returns after local state is updated; event listeners handle the streamed result.
    void runtime
      .sendPrompt(targetSessionId, content, promptAttachments, forcedSkillIds, referencedArtifacts)
      .then((snapshot) => {
        if (!snapshot) {
          useSessionStore.getState().failRun(targetSessionId, 'Agent run failed')
        }
      })
      .catch((error) => {
        // A rejected prompt (e.g. an upstream gateway 5xx) must surface as a visible session error
        // instead of being swallowed as an unhandled rejection.
        useSessionStore.getState().failRun(targetSessionId, getErrorMessage(error))
      })

    return appended
  }

  const pending = useSessionStore.getState().appendPendingUserMessage({
    content,
    attachments,
    parts,
    cwd: targetCwd ?? runtime.state.cwd,
    projectId,
    permissionProfile
  })

  if (!pending) return undefined

  // The visible prompt is already local; ACP creation finishes the session binding later.
  startPendingSessionPrompt(
    runtime,
    pending,
    content,
    attachments,
    targetCwd ?? runtime.state.cwd,
    projectName,
    permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
    forcedSkillIds,
    referencedArtifacts
  )

  return pending
}

// Explicitly re-attaches an interrupted session's ACP runtime so the user can keep chatting. On
// success the composer is unlocked; on failure the interrupted banner stays so a retry stays possible.
const resumeInterruptedWorkspaceSession = async (
  runtime: WorkspaceMessageRuntime,
  sessionId: string
): Promise<void> => {
  const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId)

  if (!session) return

  // Already attached (e.g. a redundant click after a prior resume): just clear the banner.
  if (runtime.state.sessionIds.includes(sessionId)) {
    useSessionStore.getState().markResumed(sessionId)
    return
  }

  const resumeCwd = session.cwd || runtime.state.cwd

  if (!resumeCwd) {
    useSessionStore
      .getState()
      .failRun(sessionId, 'Session workspace is missing; start a new conversation.')
    return
  }

  try {
    await runtime.resumeSession(
      sessionId,
      resumeCwd,
      session.projectId,
      session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE
    )
    useSessionStore.getState().markResumed(sessionId)
  } catch (error) {
    useSessionStore.getState().failRun(sessionId, getResumeFailureMessage(error))
  }
}

const useWorkspaceAgentRuntime = (): {
  actionError: string | null
  isConnecting: boolean
  pendingPermissions: AcpPermissionRequest[]
  permissionProfiles: Record<string, SessionPermissionProfileState>
  permissionGrants: Record<string, AcpPermissionGrant[]>
  sendMessage: (input: SendWorkspaceMessageInput) => Promise<SendWorkspaceMessageResult | undefined>
  cancelRun: (sessionId: string) => Promise<void>
  resumeInterruptedSession: (sessionId: string) => Promise<void>
  deleteRuntimeSession: (sessionId: string) => Promise<void>
  respondToPermission: (requestId: string, optionId?: string) => Promise<void>
  setPermissionProfile: (sessionId: string, profile: PermissionProfileId) => Promise<boolean>
  revokePermissionGrant: (sessionId: string, categoryKey: string) => Promise<void>
} => {
  const runtime = useAcpRuntime()
  const eventProcessor = useRef(createWorkspaceRuntimeEventProcessor())

  // Applies each visible runtime event once and trims ids that fell out of the runtime window.
  useEffect(() => {
    void eventProcessor.current.process(runtime.state.events)
  }, [runtime.state.events])

  // Mirrors pending permission requests into per-session store status.
  useEffect(() => {
    syncWorkspacePermissionState(runtime.state.pendingPermissions)
  }, [runtime.state.pendingPermissions])

  // Creates a session if needed, records the user message, then starts the prompt in the background.
  const sendMessage = useCallback(
    (input: SendWorkspaceMessageInput): Promise<SendWorkspaceMessageResult | undefined> =>
      sendWorkspaceMessage(runtime, input),
    [runtime]
  )

  // Explicitly re-attaches an interrupted session's ACP runtime so the user can keep chatting. On
  // success the composer is unlocked; on failure the interrupted banner stays so a retry stays possible.
  const resumeInterruptedSession = useCallback(
    (sessionId: string): Promise<void> => resumeInterruptedWorkspaceSession(runtime, sessionId),
    [runtime]
  )

  // Sends a cancellation request while the runtime waits for the eventual stop event.
  const cancelRun = useCallback(
    async (sessionId: string): Promise<void> => {
      const snapshot = await runtime.cancel(sessionId)

      if (!snapshot) {
        useSessionStore.getState().failRun(sessionId, 'Agent cancellation failed')
      }
    },
    [runtime]
  )

  // Deletes the local session only after runtime state confirms it was removed.
  const deleteRuntimeSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const snapshot = await runtime.deleteSession(sessionId)

      if (!snapshot) {
        useSessionStore.getState().failRun(sessionId, 'Agent session deletion failed')
        return
      }

      // Preview files intentionally outlive conversations, so only the chat session is removed.
      if (!snapshot.sessionIds.includes(sessionId)) {
        useSessionStore.getState().deleteSession(sessionId)
      }
    },
    [runtime]
  )

  // Routes a permission decision back to the runtime permission broker.
  const respondToPermission = useCallback(
    async (requestId: string, optionId?: string): Promise<void> => {
      const request = runtime.state.pendingPermissions.find((item) => item.requestId === requestId)
      const snapshot = await runtime.respondToPermission(requestId, optionId)

      if (!snapshot && request) {
        useSessionStore.getState().failRun(request.sessionId, 'Permission response failed')
      }
    },
    [runtime]
  )

  // Applies attached-session mode changes before persisting the selection. Detached sessions store
  // the preference now and reapply it during resume before their next prompt.
  const setPermissionProfile = useCallback(
    async (sessionId: string, profile: PermissionProfileId): Promise<boolean> => {
      if (runtime.state.sessionIds.includes(sessionId)) {
        const snapshot = await runtime.setPermissionProfile(sessionId, profile)

        if (!snapshot) return false
      }

      useSessionStore.getState().setPermissionProfile(sessionId, profile)
      return true
    },
    [runtime]
  )

  // Revokes one always-allow grant; the returned snapshot refreshes the visible grant list.
  const revokePermissionGrant = useCallback(
    async (sessionId: string, categoryKey: string): Promise<void> => {
      const snapshot = await runtime.revokePermissionGrant(sessionId, categoryKey)

      if (!snapshot) {
        useSessionStore.getState().failRun(sessionId, 'Permission revoke failed')
      }
    },
    [runtime]
  )

  return {
    actionError: runtime.actionError,
    isConnecting: runtime.isConnecting,
    pendingPermissions: runtime.state.pendingPermissions,
    permissionProfiles: runtime.state.permissionProfiles,
    permissionGrants: runtime.state.permissionGrants,
    sendMessage,
    cancelRun,
    resumeInterruptedSession,
    deleteRuntimeSession,
    respondToPermission,
    setPermissionProfile,
    revokePermissionGrant
  }
}

export {
  createWorkspaceRuntimeEventProcessor,
  processVisibleWorkspaceRuntimeEvents,
  resumeInterruptedWorkspaceSession,
  sendWorkspaceMessage,
  useWorkspaceAgentRuntime
}
