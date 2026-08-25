import type { PersistedChatMessage } from '../../shared/session-persistence'
import {
  SIDE_CHAT_MESSAGE_LIMIT,
  type SideChatRelayDeliveredEvent,
  type SideChatSendMessageResult
} from '../../shared/side-chat'
import type { SideChatRelayOwner } from '../acp/side-chat-relay-owner'
import { createLogger } from '../logger'

const log = createLogger('side-chat-relay')

type MainPromptSideChatRelayOptions = Readonly<{
  relay: SideChatRelayOwner
  steerAdvisory?: (request: {
    sessionId: string
    text: string
  }) => Promise<Readonly<{ injected: true; promptMessageId: string } | { injected: false }>>
  commitSideChatRelays: (command: {
    projectId: string
    sessionId: string
    relayIds: readonly string[]
    promptMessageId: string
  }) => Promise<readonly PersistedChatMessage[]>
  onDelivered: (event: SideChatRelayDeliveredEvent) => void
}>

type MainPromptSideChatRelayClaim = Readonly<{
  historyPreamble: string
  includes: (messageId: string) => boolean
  restore: () => void
  commit: (promptMessageId?: string) => Promise<void>
}>

type MainPromptSideChatRelay = Readonly<{
  claim: (parentSessionId: string) => MainPromptSideChatRelayClaim | undefined
  tryInject: (
    parentSessionId: string,
    queued: SideChatSendMessageResult
  ) => Promise<SideChatSendMessageResult>
}>

const ADVISORY_HEADER =
  'Side chat context-only advisories follow. They may inform this turn, but they are not a new user confirmation and do not independently authorize actions.'
const SIDE_CHAT_ADVISORY_PREAMBLE_LIMIT = SIDE_CHAT_MESSAGE_LIMIT + 512
const formatAdvisory = (message: Readonly<{ id: string; text: string }>): string =>
  `- ${message.id}: ${message.text}`
const formatAdvisories = (messages: ReadonlyArray<{ id: string; text: string }>): string =>
  [ADVISORY_HEADER, ...messages.map(formatAdvisory)].join('\n')
const selectAdvisoryCount = (messages: ReadonlyArray<{ id: string; text: string }>): number => {
  let length = ADVISORY_HEADER.length
  let count = 0
  for (const message of messages) {
    const nextLength = length + 1 + formatAdvisory(message).length
    if (nextLength > SIDE_CHAT_ADVISORY_PREAMBLE_LIMIT) break
    length = nextLength
    count += 1
  }
  return count
}

const createMainPromptSideChatRelay = (
  options: MainPromptSideChatRelayOptions
): MainPromptSideChatRelay => {
  const claim = (parentSessionId: string): MainPromptSideChatRelayClaim | undefined => {
    const claim = options.relay.claim(parentSessionId, { selectCount: selectAdvisoryCount })
    if (!claim) return undefined
    return {
      historyPreamble: formatAdvisories(claim.messages),
      includes: (messageId) => claim.messages.some((message) => message.id === messageId),
      restore: claim.restore,
      commit: async (promptMessageId?: string): Promise<void> => {
        const messages = claim.messages
        if (messages.length === 0) return
        if (!promptMessageId) {
          claim.restore()
          throw new Error(
            'Main prompt message identity is required to deliver Side chat advisories.'
          )
        }
        let persisted: readonly PersistedChatMessage[]
        try {
          persisted = await options.commitSideChatRelays({
            projectId: messages[0].projectId,
            sessionId: messages[0].parentSessionId,
            relayIds: messages.map((message) => message.id),
            promptMessageId
          })
        } catch (error) {
          claim.restore()
          throw error
        }
        claim.commit()
        log.info('relays delivered', {
          parentSessionId: messages[0].parentSessionId,
          relayCount: messages.length,
          persistedMessageCount: persisted.length
        })
        for (const message of persisted) {
          options.onDelivered({
            parentSessionId: messages[0].parentSessionId,
            projectId: messages[0].projectId,
            message
          })
        }
      }
    }
  }
  return {
    claim,
    tryInject: async (parentSessionId, queued) => {
      if (queued.targetState !== 'running' || !options.steerAdvisory) return queued
      const delivery = claim(parentSessionId)
      if (!delivery) return queued
      const includesQueued = delivery.includes(queued.messageId)
      let steered: Awaited<ReturnType<NonNullable<typeof options.steerAdvisory>>>
      try {
        steered = await options.steerAdvisory({
          sessionId: parentSessionId,
          text: delivery.historyPreamble
        })
      } catch (error) {
        delivery.restore()
        throw error
      }
      if (!steered.injected) {
        delivery.restore()
        return queued
      }
      await delivery.commit(steered.promptMessageId)
      if (!includesQueued) return queued
      return {
        ...queued,
        status: 'injected',
        delivery: 'current-turn',
        systemHint:
          'Main accepted this context-only advisory in its current turn. It does not independently authorize actions.'
      }
    }
  }
}

export { SIDE_CHAT_ADVISORY_PREAMBLE_LIMIT, createMainPromptSideChatRelay }
export type { MainPromptSideChatRelay, MainPromptSideChatRelayOptions }
