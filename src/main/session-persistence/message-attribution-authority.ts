import type { AcpRuntimeEvent } from '../../shared/acp'
import {
  isComputeJobCompletionAttribution,
  isComputeJobCompletionPresentation,
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
  message.role === 'user' &&
  (isReviewerCorrectionAttribution(message.attribution) ||
    isComputeJobCompletionAttribution(message.attribution))
    ? { attribution: message.attribution, content: message.content }
    : undefined

const presentationEvidenceFromMessage = (message: PersistedChatMessage): string | undefined =>
  message.role === 'user' && isComputeJobCompletionPresentation(message)
    ? message.content
    : undefined

const projectMessage = <Message extends PersistedChatMessage>(
  message: Message,
  evidence: ReadonlyMap<string, TrustedAttributionEvidence>,
  presentationEvidence: ReadonlyMap<string, string>
): Message => {
  const messageWithoutApplicationIdentity = Object.fromEntries(
    Object.entries(message).filter(([key]) => key !== 'attribution' && key !== 'presentation')
  ) as Message
  const trusted = evidence.get(message.id)
  if (trusted && message.role === 'user' && message.content === trusted.content) {
    return { ...messageWithoutApplicationIdentity, attribution: trusted.attribution } as Message
  }
  const hasDurablePresentation = presentationEvidence.get(message.id) === message.content
  if (
    message.role === 'user' &&
    (isComputeJobCompletionAttribution(message.attribution) || hasDurablePresentation)
  ) {
    return {
      ...messageWithoutApplicationIdentity,
      presentation: { kind: 'compute-job-completion' }
    } as Message
  }
  return messageWithoutApplicationIdentity
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
      (!isReviewerCorrectionAttribution(event.attribution) &&
        !isComputeJobCompletionAttribution(event.attribution))
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
    const presentationEvidence = new Map<string, string>()
    for (const message of durable?.messages ?? []) {
      const trusted = evidenceFromMessage(message)
      if (trusted) evidence.set(message.id, trusted)
      const presentationContent = presentationEvidenceFromMessage(message)
      if (presentationContent !== undefined) {
        presentationEvidence.set(message.id, presentationContent)
      }
    }
    for (const [messageId, trusted] of this.runtimeEvidence.get(
      sessionAuthorityKey(submitted.projectId, submitted.id)
    ) ?? []) {
      evidence.set(messageId, trusted)
    }

    return {
      ...submitted,
      messages: submitted.messages.map((message) =>
        projectMessage(message, evidence, presentationEvidence)
      ),
      ...(submitted.conversationGraph
        ? {
            conversationGraph: {
              ...submitted.conversationGraph,
              messages: submitted.conversationGraph.messages.map((message) =>
                projectMessage(message, evidence, presentationEvidence)
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
