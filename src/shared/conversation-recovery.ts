import { resolveActiveConversationMessages } from './conversation-graph'
import type { PersistedChatSession } from './session-persistence/session'
import { resolveTurnOutcome } from './session-persistence/turn-outcome'
import { latestTurnAnchor } from './session-persistence/turn-anchor'

// Shared eligibility, checked against Main's durable authority again at provider admission.
// Historical revisions, completed turns and publication retries never acquire this capability.
export const recoverableConversationPrompt = (
  session: PersistedChatSession,
  promptMessageId?: string
): PersistedChatSession['messages'][number] | undefined => {
  const messages = session.conversationGraph
    ? resolveActiveConversationMessages(session.conversationGraph)
    : session.messages
  const recovery = session.resumeRecovery?.promptMessageId
  const hidden = messages.at(-1)
  const failedControl =
    hidden?.turnIntent === 'save-as-skill' && hidden.turnOutcome?.kind === 'failed'
  const prompt = recovery
    ? messages.find((message) => message.id === recovery && message.role === 'user')
    : failedControl
      ? hidden
      : latestTurnAnchor(messages)
  if (!prompt || prompt.role !== 'user' || (promptMessageId && prompt.id !== promptMessageId))
    return undefined
  if (session.resumeRecovery?.promptMessageId === prompt.id) return prompt
  const outcome = resolveTurnOutcome(session, prompt.id)
  return outcome?.kind === 'failed' && outcome.recovery !== 'retry-artifact-publication'
    ? prompt
    : undefined
}

export const canResendConversationPrompt = (
  session: PersistedChatSession,
  prompt: PersistedChatSession['messages'][number]
): boolean => {
  const outcome = prompt.turnOutcome
  if (outcome?.kind !== 'failed' || outcome.execution !== 'not-started') return false
  // A later failed recovery before dispatch does not undo work from an earlier attempt.
  if (
    prompt.failureHistory?.some(
      (attempt) => attempt.kind !== 'failed' || attempt.execution !== 'not-started'
    )
  )
    return false
  const messages = session.conversationGraph?.messages ?? session.messages
  const activities = session.conversationGraph?.activities ?? session.activities ?? []
  return (
    !messages.some(
      (message) =>
        message.role === 'agent' &&
        message.responseToMessageId === prompt.id &&
        (Boolean(message.content) || message.artifactIds?.length)
    ) &&
    !activities.some(
      (activity) => activity.promptMessageId === prompt.id && activity.kind === 'tool'
    )
  )
}
