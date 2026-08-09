import { describe, expect, it, vi } from 'vitest'

import { SideChatRelayOwner } from '../acp/side-chat-relay-owner'
import { createMainPromptSideChatRelay } from './main-prompt-relay'

describe('main prompt side-chat relay', () => {
  it('adds bounded advisory context, then persists and publishes only after commit', async () => {
    const relay = new SideChatRelayOwner({
      targetState: () => 'idle',
      appendRelay: async () => undefined
    })
    relay.bind({
      sideSessionId: 'side-1',
      sideChatId: 'chat-1',
      parentSessionId: 'main-1',
      projectId: 'project-1'
    })
    await relay.send({ sideSessionId: 'side-1', target: 'main', text: 'Use a black line.' })
    const commitSideChatRelays = vi.fn(async (command) => [
      {
        id: 'persisted-message-1',
        role: 'user' as const,
        content: 'Use a black line.',
        status: 'complete' as const,
        eventIds: [],
        responseToMessageId: command.promptMessageId,
        relayedFrom: { kind: 'side-chat' as const, direction: 'to-main' as const },
        createdAt: 1,
        updatedAt: 1
      }
    ])
    const onDelivered = vi.fn()
    const adapter = createMainPromptSideChatRelay({
      relay,
      commitSideChatRelays,
      onDelivered
    })

    const claim = adapter.claim('main-1')

    expect(claim?.historyPreamble).toContain('context-only advisories')
    expect(claim?.historyPreamble).toContain('Use a black line.')
    expect(commitSideChatRelays).not.toHaveBeenCalled()
    expect(onDelivered).not.toHaveBeenCalled()

    await claim?.commit('prompt-1')

    expect(commitSideChatRelays).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'main-1',
      relayIds: [expect.stringMatching(/^side-chat-message-/)],
      promptMessageId: 'prompt-1'
    })
    expect(onDelivered).toHaveBeenCalledWith({
      parentSessionId: 'main-1',
      projectId: 'project-1',
      message: expect.objectContaining({
        id: 'persisted-message-1',
        relayedFrom: { kind: 'side-chat', direction: 'to-main' }
      })
    })
    expect(adapter.claim('main-1')).toBeUndefined()
  })

  it('commits one parent claim containing relays from successive Side chats', async () => {
    const relay = new SideChatRelayOwner({
      targetState: () => 'idle',
      appendRelay: async () => undefined
    })
    relay.bind({
      sideSessionId: 'sender-1',
      sideChatId: 'chat-1',
      parentSessionId: 'main-1',
      projectId: 'project-1'
    })
    const first = await relay.send({ sideSessionId: 'sender-1', target: 'main', text: 'first' })
    relay.releaseSide('sender-1')
    relay.bind({
      sideSessionId: 'sender-2',
      sideChatId: 'chat-2',
      parentSessionId: 'main-1',
      projectId: 'project-1'
    })
    const second = await relay.send({ sideSessionId: 'sender-2', target: 'main', text: 'second' })
    const commitSideChatRelays = vi.fn(async () => [])
    const adapter = createMainPromptSideChatRelay({
      relay,
      commitSideChatRelays,
      onDelivered: vi.fn()
    })

    await adapter.claim('main-1')?.commit('prompt-1')

    expect(commitSideChatRelays).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'main-1',
      relayIds: [first.messageId, second.messageId],
      promptMessageId: 'prompt-1'
    })
  })

  it('restores a claim before provider admission', async () => {
    const relay = new SideChatRelayOwner({
      targetState: () => 'completed',
      appendRelay: async () => undefined
    })
    relay.bind({
      sideSessionId: 'side-1',
      sideChatId: 'chat-1',
      parentSessionId: 'main-1',
      projectId: 'project-1'
    })
    await relay.send({ sideSessionId: 'side-1', target: 'main', text: 'Keep this queued.' })
    const adapter = createMainPromptSideChatRelay({
      relay,
      commitSideChatRelays: vi.fn(),
      onDelivered: vi.fn()
    })

    adapter.claim('main-1')?.restore()

    expect(adapter.claim('main-1')?.historyPreamble).toContain('Keep this queued.')
  })

  it('requires the admitted main prompt identity before making delivery durable', async () => {
    const relay = new SideChatRelayOwner({
      targetState: () => 'idle',
      appendRelay: async () => undefined
    })
    relay.bind({
      sideSessionId: 'side-1',
      sideChatId: 'chat-1',
      parentSessionId: 'main-1',
      projectId: 'project-1'
    })
    await relay.send({ sideSessionId: 'side-1', target: 'main', text: 'Advisory.' })
    const adapter = createMainPromptSideChatRelay({
      relay,
      commitSideChatRelays: vi.fn(),
      onDelivered: vi.fn()
    })

    await expect(adapter.claim('main-1')?.commit()).rejects.toThrow(
      'Main prompt message identity is required'
    )
    expect(adapter.claim('main-1')?.historyPreamble).toContain('Advisory.')
  })

  it('restores the in-memory claim when atomic durable commit fails', async () => {
    const relay = new SideChatRelayOwner({
      targetState: () => 'idle',
      appendRelay: async () => undefined
    })
    relay.bind({
      sideSessionId: 'side-1',
      sideChatId: 'chat-1',
      parentSessionId: 'main-1',
      projectId: 'project-1'
    })
    await relay.send({ sideSessionId: 'side-1', target: 'main', text: 'Retry me.' })
    const adapter = createMainPromptSideChatRelay({
      relay,
      commitSideChatRelays: async () => {
        throw new Error('disk unavailable')
      },
      onDelivered: vi.fn()
    })

    await expect(adapter.claim('main-1')?.commit('prompt-1')).rejects.toThrow('disk unavailable')
    expect(adapter.claim('main-1')?.historyPreamble).toContain('Retry me.')
  })
})
