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
