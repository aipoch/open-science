import type { AcpRuntimeEvent } from '../../shared/acp'
import {
  isReviewerCorrectionAttribution,
  type MessageAttribution,
  type PersistedChatMessage,
  type PersistedChatSession
} from '../../shared/session-persistence'

type TrustedAttributionEvidence = Readonly<{
  attribution: MessageAttribution
  content: string
}>

const MAX_TRACKED_SESSIONS = 256
const MAX_TRACKED_MESSAGES_PER_SESSION = 128
const sessionAuthorityKey = (projectId: string, sessionId: string): string =>
  `${projectId}\0${sessionId}`

const evidenceFromMessage = (
  message: PersistedChatMessage
): TrustedAttributionEvidence | undefined =>
  message.role === 'user' && isReviewerCorrectionAttribution(message.attribution)
    ? { attribution: message.attribution, content: message.content }
    : undefined

const projectMessage = <Message extends PersistedChatMessage>(
  message: Message,
  evidence: ReadonlyMap<string, TrustedAttributionEvidence>
): Message => {
  const messageWithoutAttribution = Object.fromEntries(
    Object.entries(message).filter(([key]) => key !== 'attribution')
  ) as Message
  const trusted = evidence.get(message.id)
  return (
    trusted && message.role === 'user' && message.content === trusted.content
      ? { ...messageWithoutAttribution, attribution: trusted.attribution }
      : messageWithoutAttribution
  ) as Message
}

// Renderer Session snapshots are projections, not authority for app-authored message identity.
// Runtime events establish initial trust; once durable, the main-owned Session file carries that
// evidence across restarts and ordinary focus saves.
export class MainMessageAttributionAuthority {
  private readonly runtimeEvidence = new Map<string, Map<string, TrustedAttributionEvidence>>()

  recordRuntimeEvent(projectId: string, event: AcpRuntimeEvent): void {
    if (
      event.kind !== 'message' ||
      event.role !== 'user' ||
      !event.sessionId ||
      !event.messageId ||
      typeof event.text !== 'string' ||
      !isReviewerCorrectionAttribution(event.attribution)
    ) {
      return
    }

    const authorityKey = sessionAuthorityKey(projectId, event.sessionId)
    let sessionEvidence = this.runtimeEvidence.get(authorityKey)
    if (!sessionEvidence) {
      sessionEvidence = new Map()
      this.runtimeEvidence.set(authorityKey, sessionEvidence)
      if (this.runtimeEvidence.size > MAX_TRACKED_SESSIONS) {
        this.runtimeEvidence.delete(this.runtimeEvidence.keys().next().value!)
      }
    }
    sessionEvidence.set(event.messageId, {
      attribution: event.attribution,
      content: event.text
    })
    if (sessionEvidence.size > MAX_TRACKED_MESSAGES_PER_SESSION) {
      sessionEvidence.delete(sessionEvidence.keys().next().value!)
    }
  }

  authorizeSessionProjection(
    submitted: PersistedChatSession,
    durable: PersistedChatSession | undefined
  ): PersistedChatSession {
    const evidence = new Map<string, TrustedAttributionEvidence>()
    for (const message of durable?.messages ?? []) {
      const trusted = evidenceFromMessage(message)
      if (trusted) evidence.set(message.id, trusted)
    }
    for (const [messageId, trusted] of this.runtimeEvidence.get(
      sessionAuthorityKey(submitted.projectId, submitted.id)
    ) ?? []) {
      evidence.set(messageId, trusted)
    }

    return {
      ...submitted,
      messages: submitted.messages.map((message) => projectMessage(message, evidence)),
      ...(submitted.conversationGraph
        ? {
            conversationGraph: {
              ...submitted.conversationGraph,
              messages: submitted.conversationGraph.messages.map((message) =>
                projectMessage(message, evidence)
              )
            }
          }
        : {})
    }
  }

  clear(): void {
    this.runtimeEvidence.clear()
  }
}
