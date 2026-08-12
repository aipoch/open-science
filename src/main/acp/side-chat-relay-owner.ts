import { randomUUID } from 'node:crypto'

import {
  SIDE_CHAT_MESSAGE_LIMIT,
  type SideChatSendMessageResult,
  type SideChatTargetState
} from '../../shared/side-chat'
import type { PersistedSideChatRelay } from '../../shared/session-persistence'
import { createLogger } from '../logger'

const MAX_SIDE_CHAT_MESSAGE_CHARS = SIDE_CHAT_MESSAGE_LIMIT
const log = createLogger('side-chat-relay')

type SideChatRelayBinding = Readonly<{
  sideSessionId: string
  sideChatId: string
  parentSessionId: string
  projectId: string
}>

type SideChatRelayMessage = Readonly<{
  id: string
  sideSessionId: string
  sideChatId: string
  parentSessionId: string
  projectId: string
  text: string
  createdAt: number
}>

type SideChatRelayClaim = Readonly<{
  messages: readonly SideChatRelayMessage[]
  commit: () => readonly SideChatRelayMessage[]
  restore: () => void
}>

type SideChatRelayClaimOptions = Readonly<{
  selectCount: (messages: readonly SideChatRelayMessage[]) => number
}>

type SideChatRelayOwnerOptions = Readonly<{
  targetState: (parentSessionId: string) => SideChatTargetState
  appendRelay: (input: {
    projectId: string
    parentSessionId: string
    sideChatId: string
    relay: Omit<PersistedSideChatRelay, 'sideChatId'>
  }) => Promise<void>
}>

class SideChatRelayOwner {
  private readonly bindings = new Map<string, SideChatRelayBinding>()
  private readonly queued = new Map<string, SideChatRelayMessage[]>()
  private readonly claims = new Map<string, symbol>()

  constructor(private readonly options: SideChatRelayOwnerOptions) {}

  bind(binding: SideChatRelayBinding): void {
    if (this.bindings.has(binding.sideSessionId)) {
      throw new Error(`Side chat Session is already bound: ${binding.sideSessionId}`)
    }
    this.bindings.set(binding.sideSessionId, binding)
  }

  hydrate(
    records: readonly {
      parentSessionId: string
      projectId: string
      relays: readonly PersistedSideChatRelay[]
    }[]
  ): void {
    for (const record of records) {
      if (record.relays.length === 0) continue
      this.queued.set(
        record.parentSessionId,
        record.relays.map((relay) => ({
          ...relay,
          sideSessionId: relay.sideChatId,
          sideChatId: relay.sideChatId,
          parentSessionId: record.parentSessionId,
          projectId: record.projectId
        }))
      )
    }
  }

  async send(input: {
    sideSessionId: string
    target: 'main'
    text: string
  }): Promise<SideChatSendMessageResult> {
    const binding = this.bindings.get(input.sideSessionId)
    if (!binding) throw new Error('Side chat sender is not bound to a parent Session.')
    if (input.target !== 'main') throw new Error('Side chat may only target main.')
    const text = input.text.trim()
    if (!text) throw new Error('Side chat message text must be non-empty.')
    if (text.length > MAX_SIDE_CHAT_MESSAGE_CHARS) {
      throw new Error('Side chat message text must not exceed 12,000 characters.')
    }

    const message: SideChatRelayMessage = {
      id: `side-chat-message-${randomUUID()}`,
      ...binding,
      text,
      createdAt: Date.now()
    }
    await this.options.appendRelay({
      projectId: binding.projectId,
      parentSessionId: binding.parentSessionId,
      sideChatId: binding.sideChatId,
      relay: { id: message.id, text: message.text, createdAt: message.createdAt }
    })
    const messages = this.queued.get(binding.parentSessionId) ?? []
    messages.push(message)
    this.queued.set(binding.parentSessionId, messages)
    const targetState = this.options.targetState(binding.parentSessionId)
    log.info('relay queued', {
      messageId: message.id,
      sideChatId: binding.sideChatId,
      parentSessionId: binding.parentSessionId,
      targetState
    })
    return {
      status: 'queued',
      messageId: message.id,
      targetState,
      delivery: 'next-user-turn',
      persisted: true,
      systemHint:
        'Main is not interrupted or awakened. This advisory is persisted and will be delivered with its next user turn.'
    }
  }

  claim(
    parentSessionId: string,
    options?: SideChatRelayClaimOptions
  ): SideChatRelayClaim | undefined {
    if (this.claims.has(parentSessionId)) return undefined
    const queued = this.queued.get(parentSessionId)
    if (!queued || queued.length === 0) return undefined
    const selectedCount = options?.selectCount(queued) ?? queued.length
    if (!Number.isInteger(selectedCount) || selectedCount < 1 || selectedCount > queued.length) {
      throw new Error('Side chat relay claim selected an invalid message count.')
    }
    const messages = queued.slice(0, selectedCount)
    const deferred = queued.slice(selectedCount)
    if (deferred.length > 0) this.queued.set(parentSessionId, deferred)
    else this.queued.delete(parentSessionId)
    const token = Symbol('side-chat-relay-claim')
    this.claims.set(parentSessionId, token)
    let settled = false

    const ownsClaim = (): boolean => this.claims.get(parentSessionId) === token
    return {
      messages,
      commit: () => {
        if (settled || !ownsClaim()) return []
        settled = true
        this.claims.delete(parentSessionId)
        return messages
      },
      restore: () => {
        if (settled || !ownsClaim()) return
        settled = true
        this.claims.delete(parentSessionId)
        this.queued.set(parentSessionId, [...messages, ...(this.queued.get(parentSessionId) ?? [])])
      }
    }
  }

  releaseSide(sideSessionId: string): void {
    this.bindings.delete(sideSessionId)
  }

  releaseParent(parentSessionId: string): void {
    for (const [sideSessionId, binding] of this.bindings) {
      if (binding.parentSessionId === parentSessionId) this.bindings.delete(sideSessionId)
    }
    this.queued.delete(parentSessionId)
    this.claims.delete(parentSessionId)
  }
}

export { MAX_SIDE_CHAT_MESSAGE_CHARS, SideChatRelayOwner }
export type {
  SideChatRelayBinding,
  SideChatRelayClaim,
  SideChatRelayMessage,
  SideChatSendMessageResult
}
