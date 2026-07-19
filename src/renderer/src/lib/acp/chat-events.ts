import {
  getAcpRuntimeEventImage,
  getAcpRuntimeEventText,
  type AcpMessageImage,
  type AcpRuntimeEvent
} from '../../../../shared/acp'

type RuntimeChatRole = 'assistant' | 'user'

type RuntimeChatMessageEvent = AcpRuntimeEvent & {
  kind: 'message'
  role: RuntimeChatRole
  text?: string
  image?: AcpMessageImage
}

type AssistantRuntimeChatMessageEvent = RuntimeChatMessageEvent & {
  role: 'assistant'
  sessionId: string
}

// Narrows runtime message roles to the two roles shown in chat projections.
const isRuntimeChatRole = (role: AcpRuntimeEvent['role']): role is RuntimeChatRole =>
  role === 'assistant' || role === 'user'

// Identifies text- or image-bearing message events that can appear in chat transcripts.
const isRuntimeChatMessageEvent = (event: AcpRuntimeEvent): event is RuntimeChatMessageEvent =>
  event.kind === 'message' &&
  isRuntimeChatRole(event.role) &&
  (Boolean(getAcpRuntimeEventText(event)) || Boolean(getAcpRuntimeEventImage(event)))

// Identifies assistant text events that can update the workspace conversation.
const isAssistantRuntimeChatMessageEvent = (
  event: AcpRuntimeEvent
): event is AssistantRuntimeChatMessageEvent =>
  isRuntimeChatMessageEvent(event) && event.role === 'assistant' && Boolean(event.sessionId)

// Chooses the stream id used by the workspace store for chunk merging.
const createRuntimeStreamId = (event: RuntimeChatMessageEvent): string =>
  event.messageId ?? event.id

export { createRuntimeStreamId, isAssistantRuntimeChatMessageEvent, isRuntimeChatMessageEvent }
export { getAcpRuntimeEventImage, getAcpRuntimeEventText }
export type { RuntimeChatMessageEvent, RuntimeChatRole }
