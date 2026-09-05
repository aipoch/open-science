import { DEFAULT_PERMISSION_PROFILE } from '../../../../shared/permission-profiles'
import {
  MAX_COMPOSER_ATTACHMENTS,
  toPersistedUploadedAttachment,
  toRuntimeUploadedAttachment,
  type UploadedAttachment
} from '../../../../shared/uploads'
import type { AgentFrameworkId, SessionAgentConfiguration } from '../../../../shared/settings'
import {
  isSessionSizeLimitError,
  type DelegationPolicy
} from '../../../../shared/session-persistence'
import {
  confirmPendingDelegationPolicyAuthority,
  saveSessionInOrder
} from '../session-persistence/session-persistence'
import { usePreviewWorkbenchStore } from '../../stores/preview-workbench-store'
import { toPersistedSession, useSessionStore, type ChatMessage } from '../../stores/session-store'
import type { useAcpRuntime } from './useAcpRuntime'

export type BranchWorkspaceSessionFromMessageIntent = {
  sourceSessionId: string
  sourceMessageId: string
  agentFrameworkId?: AgentFrameworkId
  agentBackendId?: string
  agentModel?: string
  agentConfiguration?: SessionAgentConfiguration
  delegationPolicy?: DelegationPolicy
  specialistId?: string | null
}

export type BranchWorkspaceSessionFromMessageResult = {
  sessionId: string
  messageId: string
}

type WorkspaceSessionBranchRuntime = Pick<ReturnType<typeof useAcpRuntime>, 'createSession'> &
  Partial<Pick<ReturnType<typeof useAcpRuntime>, 'deleteSession'>>

export const reconcileBranchedAttachments = async (
  sourceSessionId: string,
  childSessionId: string,
  messages: ChatMessage[],
  projectId?: string
): Promise<void> => {
  const stagedById = new Map<string, UploadedAttachment>()
  for (const message of messages) {
    for (const upload of message.uploads ?? []) {
      if (!upload.versionId && !stagedById.has(upload.id)) {
        stagedById.set(upload.id, toRuntimeUploadedAttachment(upload, projectId))
      }
    }
  }
  if (stagedById.size === 0) return

  const staged = [...stagedById.values()]
  const finalized: UploadedAttachment[] = []
  for (let offset = 0; offset < staged.length; offset += MAX_COMPOSER_ATTACHMENTS) {
    const batch = await window.api.uploads.finalizeSession({
      projectId,
      sessionId: sourceSessionId,
      attachments: staged.slice(offset, offset + MAX_COMPOSER_ATTACHMENTS)
    })
    finalized.push(...batch)
  }
  const finalizedById = new Map(finalized.map((upload) => [upload.id, upload]))
  for (const stagedId of stagedById.keys()) {
    if (!finalizedById.has(stagedId)) {
      throw new Error(`Upload finalization did not return the staged attachment: ${stagedId}`)
    }
  }
  for (const message of messages) {
    if (!message.uploads?.some((upload) => stagedById.has(upload.id))) continue
    const uploads = message.uploads.map((upload) => {
      const replacement = finalizedById.get(upload.id)
      return replacement ? toPersistedUploadedAttachment(replacement) : upload
    })
    for (const sessionId of [sourceSessionId, childSessionId]) {
      useSessionStore
        .getState()
        .replaceMessageUploads({ sessionId, messageId: message.id, uploads })
    }
  }
  usePreviewWorkbenchStore.getState().reconcileFinalizedUploads(finalized)
}

export const branchWorkspaceSessionFromMessage = async (
  runtime: WorkspaceSessionBranchRuntime,
  input: BranchWorkspaceSessionFromMessageIntent,
  onSessionSizeLimit?: (sessionId: string) => void
): Promise<BranchWorkspaceSessionFromMessageResult | undefined> => {
  const pending = useSessionStore.getState().branchInNewSession(input)
  if (!pending || pending.messageId) return undefined

  const pendingSession = useSessionStore
    .getState()
    .sessions.find((session) => session.id === pending.sessionId)
  if (!pendingSession) return undefined
  const pdfContext = pendingSession.messages.findLast((message) => message.pdfContext)?.pdfContext
  const pdfContextSources = pdfContext
    ? [
        ...new Map(
          pdfContext.bindings.map((binding) => [
            `${binding.sourceKind}:${binding.sourceVersionId}`,
            {
              sourceKind: binding.sourceKind,
              sourceFileId: binding.sourceFileId,
              sourceVersionId: binding.sourceVersionId
            }
          ])
        ).values()
      ]
    : []

  let createdSessionId: string | undefined
  try {
    await reconcileBranchedAttachments(
      input.sourceSessionId,
      pending.sessionId,
      pendingSession.messages,
      pendingSession.projectId
    )
    const target =
      input.agentFrameworkId && input.agentConfiguration
        ? { frameworkId: input.agentFrameworkId, ...input.agentConfiguration }
        : undefined
    const created = target
      ? await runtime.createSession(
          pendingSession.cwd || undefined,
          pendingSession.projectId,
          pendingSession.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
          pendingSession.specialistId,
          target,
          pendingSession.memoryEnabled !== false,
          ...(pdfContextSources.length > 0 ? ([true] as const) : [])
        )
      : await runtime.createSession(
          pendingSession.cwd || undefined,
          pendingSession.projectId,
          pendingSession.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
          pendingSession.specialistId,
          undefined,
          pendingSession.memoryEnabled !== false,
          ...(pdfContextSources.length > 0 ? ([true] as const) : [])
        )
    const sessionId = created?.sessionId
    if (!sessionId) throw new Error('Agent session could not be created.')
    createdSessionId = sessionId

    const bound = useSessionStore.getState().bindPendingSession({
      pendingSessionId: pending.sessionId,
      sessionId,
      cwd: created.cwd,
      agentFrameworkId: created.frameworkId,
      agentBackendId: created.backendId,
      providerSessionId: created.providerSessionId,
      providerContinuityToken: created.providerContinuityToken
    })
    if (!bound) throw new Error('Branched Session could not be created.')

    const boundSession = useSessionStore
      .getState()
      .sessions.find((session) => session.id === sessionId)
    if (!boundSession) throw new Error('Branched Session could not be created.')
    await confirmPendingDelegationPolicyAuthority(boundSession)
    if (pdfContextSources.length > 0) {
      if (!boundSession.projectId) throw new Error('PDF context requires a Project.')
      const runtimeContext = await window.api.sessions.linkPdfContext({
        projectId: boundSession.projectId,
        sessionId,
        expectedRevision: boundSession.runtimeContext?.revision ?? 0,
        sources: pdfContextSources
      })
      useSessionStore.getState().applyDurableSessionProjection({
        source: boundSession,
        session: {
          ...toPersistedSession(boundSession),
          runtimeContext,
          updatedAt: Math.max(boundSession.updatedAt, Date.now())
        },
        mode: 'runtime-context-authority'
      })
      const linkedSession = useSessionStore
        .getState()
        .sessions.find((session) => session.id === sessionId)
      if (!linkedSession) throw new Error('Branched Session could not be created.')
      await saveSessionInOrder(toPersistedSession(linkedSession))
    }
    return { sessionId, messageId: input.sourceMessageId }
  } catch (error) {
    const failedSessionId = createdSessionId ?? pending.sessionId
    if (isSessionSizeLimitError(error)) {
      onSessionSizeLimit?.(createdSessionId ?? input.sourceSessionId)
    }
    useSessionStore.getState().deleteSession(failedSessionId)
    if (createdSessionId && runtime.deleteSession) {
      await runtime.deleteSession(createdSessionId).catch(() => undefined)
    }
    throw error
  }
}
