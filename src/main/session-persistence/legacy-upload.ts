import type { PersistedChatSession } from '../../shared/session-persistence'

const hasLegacySessionUpload = (session: PersistedChatSession): boolean =>
  [...session.messages, ...(session.conversationGraph?.messages ?? [])].some((message) =>
    message.uploads?.some((upload) => !upload.versionId)
  )

export { hasLegacySessionUpload }
