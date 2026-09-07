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
  // ponytail: receipts live only in this process; durable crash reconciliation needs a separate contract.
  const pendingCommits = new Map<string, MainPromptSideChatRelayClaim>()
  const claim = (parentSessionId: string): MainPromptSideChatRelayClaim | undefined => {
    const pending = pendingCommits.get(parentSessionId)
    if (pending) {
      void pending.commit().catch((error) => {
        log.warn('accepted advisory commit retry failed', { parentSessionId, error: String(error) })
      })
      return undefined
    }
    const claimed = options.relay.claim(parentSessionId, { selectCount: selectAdvisoryCount })
    if (!claimed) return undefined
    let acceptedPromptId: string | undefined
    let writing: Promise<void> | undefined
    let completed = false
    const delivery: MainPromptSideChatRelayClaim = {
      historyPreamble: formatAdvisories(claimed.messages),
      includes: (messageId) => claimed.messages.some((message) => message.id === messageId),
      restore: () => {
        if (!acceptedPromptId) claimed.restore()
      },
      commit: (promptMessageId?: string): Promise<void> => {
        if (completed) return Promise.resolve()
        if (writing) return writing
        acceptedPromptId ??= promptMessageId
        if (!acceptedPromptId) {
          claimed.restore()
          return Promise.reject(
            new Error('Main prompt message identity is required to deliver Side chat advisories.')
          )
        }
        if (!claimed.isCurrent()) {
          pendingCommits.delete(parentSessionId)
          completed = true
          return Promise.resolve()
        }
        pendingCommits.set(parentSessionId, delivery)
        const messages = claimed.messages
        const persist = async (): Promise<void> => {
          const persisted = await options.commitSideChatRelays({
            projectId: messages[0].projectId,
            sessionId: parentSessionId,
            relayIds: messages.map((message) => message.id),
            promptMessageId: acceptedPromptId!
          })
          claimed.commit()
          completed = true
          if (pendingCommits.get(parentSessionId) === delivery)
            pendingCommits.delete(parentSessionId)
          log.info('relays delivered', {
            parentSessionId,
            relayCount: messages.length,
            persistedMessageCount: persisted.length
          })
          for (const message of persisted) {
            options.onDelivered({ parentSessionId, projectId: messages[0].projectId, message })
          }
        }
        writing = persist().finally(() => {
          writing = undefined
        })
        return writing
      }
    }
    return delivery
  }
  return {
    claim,
    tryInject: async (parentSessionId, queued) => {
      const pending = pendingCommits.get(parentSessionId)
      if (pending) {
        try {
          await pending.commit()
        } catch {
          // Keep accepted advisories out of both native injection and the next-user-turn queue.
        }
        if (pending.includes(queued.messageId)) {
          return {
            ...queued,
            status: 'injected',
            delivery: 'current-turn',
            ...(pendingCommits.has(parentSessionId)
              ? { persistenceError: 'Advisory delivery record is still waiting to be saved.' }
              : {}),
            systemHint:
              'Main already accepted this advisory. Do not send it again; only its local delivery record may need saving.'
          }
        }
        if (pendingCommits.has(parentSessionId)) return queued
      }
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
      let persistenceError: string | undefined
      try {
        await delivery.commit(steered.promptMessageId)
      } catch (error) {
        persistenceError = error instanceof Error ? error.message : String(error)
      }
      if (!includesQueued) return queued
      return {
        ...queued,
        status: 'injected',
        delivery: 'current-turn',
        ...(persistenceError ? { persistenceError } : {}),
        systemHint: persistenceError
          ? 'Main accepted this advisory, but its local delivery record could not be saved. Do not send it again; only the local commit will be retried.'
          : 'Main accepted this context-only advisory in its current turn. It does not independently authorize actions.'
      }
    }
  }
}

export { SIDE_CHAT_ADVISORY_PREAMBLE_LIMIT, createMainPromptSideChatRelay }
export type { MainPromptSideChatRelay, MainPromptSideChatRelayOptions }
