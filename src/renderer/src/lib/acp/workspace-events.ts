import type { AcpRuntimeEvent, AcpPermissionRequest } from '../../../../shared/acp'
import type { ArtifactFile, FinalizeRunArtifactsRequest } from '../../../../shared/artifacts'
import { useSessionStore } from '../../stores/session-store'
import { createRuntimeStreamId, isAssistantRuntimeChatMessageEvent } from './chat-events'

// Remembers which sessions were marked as waiting during the previous permission sync.
const pendingPermissionSessionIds = new Set<string>()

// Chooses the best user-facing error text from a runtime event.
const getEventErrorText = (event: AcpRuntimeEvent): string =>
  event.text?.trim() || event.title?.trim() || 'Agent run failed'

// Normalizes IPC/finalization failures into storeable session error text.
const getErrorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

type WorkspaceRuntimeEventDependencies = {
  finalizeRunArtifacts?: (request: FinalizeRunArtifactsRequest) => Promise<ArtifactFile[]>
}

// Defaults to the preload artifact API while allowing tests to inject a fake finalizer.
const finalizeRunArtifacts = (request: FinalizeRunArtifactsRequest): Promise<ArtifactFile[]> =>
  window.api.artifacts.finalizeRunArtifacts(request)

// Applies one runtime event to the workspace store when it affects chat state.
const applyWorkspaceRuntimeEvent = async (
  event: AcpRuntimeEvent,
  dependencies: WorkspaceRuntimeEventDependencies = {}
): Promise<boolean> => {
  const store = useSessionStore.getState()

  // Assistant chat deltas extend the transcript as streamed markdown messages.
  if (isAssistantRuntimeChatMessageEvent(event)) {
    store.appendAgentMessageChunk({
      sessionId: event.sessionId,
      streamId: createRuntimeStreamId(event),
      eventId: event.id,
      content: event.text
    })
    return true
  }

  // Tool calls become visible activity rows, including web-search query/result payloads.
  if (event.kind === 'tool' && event.sessionId && event.toolCallId) {
    store.upsertToolActivity({
      sessionId: event.sessionId,
      toolCallId: event.toolCallId,
      eventId: event.id,
      title: event.title,
      status: event.status,
      providerToolName: event.providerToolName,
      toolKind: event.toolKind,
      toolContent: event.toolContent,
      toolLocations: event.toolLocations,
      rawInput: event.rawInput,
      rawOutput: event.rawOutput,
      terminalOutput: event.terminalOutput,
      terminalExitCode: event.terminalExitCode
    })
    return true
  }

  if (event.kind === 'stop' && event.sessionId) {
    store.finishRun(event.sessionId)
    return true
  }

  if (
    event.kind === 'artifact' &&
    event.sessionId &&
    event.runId &&
    event.artifactClaimId &&
    event.artifacts &&
    event.artifacts.length > 0
  ) {
    // First attach pending artifacts to whichever assistant message represents this run locally.
    const attached = store.attachRunArtifacts({
      sessionId: event.sessionId,
      runId: event.runId,
      eventId: event.id,
      artifacts: event.artifacts
    })

    if (attached) {
      try {
        // Then move files from pending run storage into the final message-owned directory.
        const finalizedArtifacts = await (
          dependencies.finalizeRunArtifacts ?? finalizeRunArtifacts
        )({
          claimId: event.artifactClaimId,
          messageId: attached.messageId
        })

        // Replace temporary run paths with finalized message paths before persistence/UI rendering.
        store.replaceMessageArtifacts({
          sessionId: event.sessionId,
          messageId: attached.messageId,
          artifacts: finalizedArtifacts
        })
        store.clearArtifactError(event.sessionId)
      } catch (error) {
        store.recordArtifactError(event.sessionId, getErrorText(error))
        throw error
      }
    }

    return true
  }

  if (event.kind === 'error' && event.sessionId) {
    store.failRun(event.sessionId, getEventErrorText(event))
    return true
  }

  if (event.kind === 'tool') {
    // Tool calls do not create preview items; file preview is opened by file-specific actions.
    return false
  }

  return false
}

// Keeps store permission state aligned with the runtime's current pending request set.
const syncWorkspacePermissionState = (requests: AcpPermissionRequest[]): void => {
  const nextSessionIds = new Set(requests.map((request) => request.sessionId))
  const store = useSessionStore.getState()

  // New pending sessions enter the waiting-permission status.
  for (const sessionId of nextSessionIds) {
    if (!pendingPermissionSessionIds.has(sessionId)) {
      store.setPermissionPending(sessionId)
    }
  }

  // Sessions with no pending request return to their prior run-derived status.
  for (const sessionId of pendingPermissionSessionIds) {
    if (!nextSessionIds.has(sessionId)) {
      store.clearPermissionPending(sessionId)
    }
  }

  pendingPermissionSessionIds.clear()

  // Remember the current set for the next sync pass.
  for (const sessionId of nextSessionIds) {
    pendingPermissionSessionIds.add(sessionId)
  }
}

export { applyWorkspaceRuntimeEvent, syncWorkspacePermissionState }
