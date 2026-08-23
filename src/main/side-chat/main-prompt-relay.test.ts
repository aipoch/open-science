import { describe, expect, it, vi } from 'vitest'

import { SideChatRelayOwner } from '../acp/side-chat-relay-owner'
import {
  SIDE_CHAT_ADVISORY_PREAMBLE_LIMIT,
  createMainPromptSideChatRelay
} from './main-prompt-relay'

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

  it('injects a running relay into the live Main prompt and commits it against that prompt', async () => {
    const relay = new SideChatRelayOwner({
      targetState: () => 'running',
      appendRelay: async () => undefined
    })
    relay.bind({
      sideSessionId: 'side-1',
      sideChatId: 'chat-1',
      parentSessionId: 'main-1',
      projectId: 'project-1'
    })
    const queued = await relay.send({
      sideSessionId: 'side-1',
      target: 'main',
      text: 'Use the latest result.'
    })
    const steerAdvisory = vi.fn(async () => ({
      injected: true as const,
      promptMessageId: 'prompt-live'
    }))
    const commitSideChatRelays = vi.fn(async () => [])
    const adapter = createMainPromptSideChatRelay({
      relay,
      steerAdvisory,
      commitSideChatRelays,
      onDelivered: vi.fn()
    })

    await expect(adapter.tryInject('main-1', queued)).resolves.toMatchObject({
      status: 'injected',
      delivery: 'current-turn',
      messageId: queued.messageId,
      persisted: true
    })
    expect(steerAdvisory).toHaveBeenCalledWith({
      sessionId: 'main-1',
      text: expect.stringContaining('Use the latest result.')
    })
    expect(commitSideChatRelays).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'main-1',
      relayIds: [queued.messageId],
      promptMessageId: 'prompt-live'
    })
    expect(adapter.claim('main-1')).toBeUndefined()
  })

  it('restores a running relay when native injection is refused', async () => {
    const relay = new SideChatRelayOwner({
      targetState: () => 'running',
      appendRelay: async () => undefined
    })
    relay.bind({
      sideSessionId: 'side-1',
      sideChatId: 'chat-1',
      parentSessionId: 'main-1',
      projectId: 'project-1'
    })
    const queued = await relay.send({
      sideSessionId: 'side-1',
      target: 'main',
      text: 'Keep this durable.'
    })
    const adapter = createMainPromptSideChatRelay({
      relay,
      steerAdvisory: async () => ({ injected: false }),
      commitSideChatRelays: vi.fn(),
      onDelivered: vi.fn()
    })

    await expect(adapter.tryInject('main-1', queued)).resolves.toBe(queued)
    expect(adapter.claim('main-1')?.historyPreamble).toContain('Keep this durable.')
  })

  it('restores a running relay when native injection fails unexpectedly', async () => {
    const relay = new SideChatRelayOwner({
      targetState: () => 'running',
      appendRelay: async () => undefined
    })
    relay.bind({
      sideSessionId: 'side-1',
      sideChatId: 'chat-1',
      parentSessionId: 'main-1',
      projectId: 'project-1'
    })
    const queued = await relay.send({
      sideSessionId: 'side-1',
      target: 'main',
      text: 'Keep this advisory durable.'
    })
    const adapter = createMainPromptSideChatRelay({
      relay,
      steerAdvisory: vi.fn(async () => {
        throw new Error('transport unavailable')
      }),
      commitSideChatRelays: vi.fn(async () => []),
      onDelivered: vi.fn()
    })

    await expect(adapter.tryInject('main-1', queued)).rejects.toThrow('transport unavailable')
    const restored = adapter.claim('main-1')
    expect(restored?.historyPreamble).toContain('Keep this advisory durable.')
    restored?.restore()
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

  it('bounds each Main advisory preamble and leaves overflow queued for a later turn', async () => {
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
    const first = await relay.send({
      sideSessionId: 'side-1',
      target: 'main',
      text: `first-${'a'.repeat(7_000)}`
    })
    const second = await relay.send({
      sideSessionId: 'side-1',
      target: 'main',
      text: `second-${'b'.repeat(7_000)}`
    })
    const commitSideChatRelays = vi.fn(async () => [])
    const adapter = createMainPromptSideChatRelay({
      relay,
      commitSideChatRelays,
      onDelivered: vi.fn()
    })

    const firstClaim = adapter.claim('main-1')
    expect(firstClaim?.historyPreamble.length).toBeLessThanOrEqual(
      SIDE_CHAT_ADVISORY_PREAMBLE_LIMIT
    )
    expect(firstClaim?.historyPreamble).toContain('first-')
    expect(firstClaim?.historyPreamble).not.toContain('second-')
    await firstClaim?.commit('prompt-1')

    const secondClaim = adapter.claim('main-1')
    expect(secondClaim?.historyPreamble.length).toBeLessThanOrEqual(
      SIDE_CHAT_ADVISORY_PREAMBLE_LIMIT
    )
    expect(secondClaim?.historyPreamble).toContain('second-')
    await secondClaim?.commit('prompt-2')

    expect(commitSideChatRelays).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ relayIds: [first.messageId], promptMessageId: 'prompt-1' })
    )
    expect(commitSideChatRelays).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ relayIds: [second.messageId], promptMessageId: 'prompt-2' })
    )
  })

  it('does not report the current relay as injected when an older bounded claim fills the turn', async () => {
    const relay = new SideChatRelayOwner({
      targetState: () => 'running',
      appendRelay: async () => undefined
    })
    relay.bind({
      sideSessionId: 'side-1',
      sideChatId: 'chat-1',
      parentSessionId: 'main-1',
      projectId: 'project-1'
    })
    const first = await relay.send({
      sideSessionId: 'side-1',
      target: 'main',
      text: `first-${'a'.repeat(7_000)}`
    })
    const second = await relay.send({
      sideSessionId: 'side-1',
      target: 'main',
      text: `second-${'b'.repeat(7_000)}`
    })
    const commitSideChatRelays = vi.fn(async () => [])
    const adapter = createMainPromptSideChatRelay({
      relay,
      steerAdvisory: vi.fn(async () => ({
        injected: true as const,
        promptMessageId: 'prompt-live'
      })),
      commitSideChatRelays,
      onDelivered: vi.fn()
    })

    await expect(adapter.tryInject('main-1', second)).resolves.toBe(second)
    expect(commitSideChatRelays).toHaveBeenCalledWith(
      expect.objectContaining({ relayIds: [first.messageId], promptMessageId: 'prompt-live' })
    )
    const remaining = adapter.claim('main-1')
    expect(remaining?.historyPreamble).toContain('second-')
    remaining?.restore()
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
