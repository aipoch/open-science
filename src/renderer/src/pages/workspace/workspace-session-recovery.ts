import type { ChatSession } from '@/stores/session-store'
import { resolvePreparationNoticeBaseline } from '../../../../shared/session-persistence'

type SessionRecoveryPresentation = {
  cause: 'cancelled' | 'connection-lost' | 'app-restart'
  error?: string
}

// Resume is a Session capability. Message selection and turn-anchor eligibility only affect the
// timeline; they cannot hide the recovery target held by the Session. Preparations retain their
// prior recovery until Main admits the replacement execution or rolls the preparation back.
const resolveSessionRecoveryPresentation = (
  session: ChatSession | undefined
): SessionRecoveryPresentation | undefined => {
  if (!session) return undefined
  const preparation = session.promptPreparation
  const preparationState =
    resolvePreparationNoticeBaseline(session)?.state ??
    (preparation?.sessionId === session.id && preparation.projectId === session.projectId
      ? preparation.previousState
      : undefined)
  const state = session.resumeRecovery ? session : (preparationState ?? session)
  const recovery = state.resumeRecovery
  if (!recovery) return undefined
  const recoveryOutcome = (session.conversationGraph?.messages ?? session.messages).find(
    ({ id }) => id === recovery.promptMessageId
  )?.turnOutcome
  // Terminal storage exhaustion has its own global alert and cannot offer a local Resume action.
  if (recoveryOutcome?.kind === 'interrupted' && recoveryOutcome.cause === 'terminal-commit-failed')
    return undefined
  return {
    cause: recovery.cause,
    error:
      state.error ?? (recoveryOutcome?.kind === 'interrupted' ? recoveryOutcome.error : undefined)
  }
}

export { resolveSessionRecoveryPresentation }
