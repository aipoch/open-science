import type { AcpCreateSessionResponse } from '../../shared/acp'
import { latestOutcomePrompt, type PersistedChatSession } from '../../shared/session-persistence'

// Old attachment-only recovery records have no turn to resume or settle. Successful provider
// attachment releases their compatibility notice; real turn outcomes remain Main-owned history.
export const clearUnanchoredAttachmentRecovery = (
  session: PersistedChatSession
): PersistedChatSession => {
  if (!session.resumeRecovery || session.activeRun || latestOutcomePrompt(session)) return session
  return {
    ...session,
    status: 'idle',
    error: undefined,
    errorReportable: undefined,
    resumeRecovery: undefined,
    updatedAt: Date.now()
  }
}

// Attachment identity is Main-owned. Commit it before renderer preparation can re-read the Session;
// a renderer metadata save deliberately cannot replace these authority fields.
export const completeRuntimeAttachmentRecovery = (
  session: PersistedChatSession,
  attached: AcpCreateSessionResponse
): PersistedChatSession => {
  if (attached.sessionId !== session.id)
    throw new Error('Attached Session identity does not match.')
  return clearUnanchoredAttachmentRecovery({
    ...session,
    ...(attached.frameworkId
      ? { agentFrameworkId: attached.frameworkId, agentBackendId: attached.backendId }
      : {}),
    ...(attached.providerSessionId ? { providerSessionId: attached.providerSessionId } : {}),
    providerContinuityToken: attached.providerContinuityToken,
    ...(attached.contextReset
      ? { pendingHistoryReplay: session.pendingHistoryReplay ?? { kind: 'all' as const } }
      : {}),
    updatedAt: Date.now()
  })
}
