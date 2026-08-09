import { describe, expect, it, vi } from 'vitest'

import { SideChatRelayOwner } from '../acp/side-chat-relay-owner'
import { createMainPromptSideChatRelay } from './main-prompt-relay'

describe('main prompt side-chat relay', () => {
  it('adds bounded advisory context, then persists and publishes only after commit', async () => {
    const relay = new SideChatRelayOwner({ targetState: () => 'idle' })
    relay.bind({
      sideSessionId: 'side-1',
      parentSessionId: 'main-1',
      projectId: 'project-1'
    })
    relay.send({ sideSessionId: 'side-1', target: 'main', text: 'Use a black line.' })
    const appendSideChatAdvisory = vi.fn(async (command) => ({
      id: 'persisted-message-1',
      role: 'user' as const,
      content: command.content,
      status: 'complete' as const,
      eventIds: [],
      responseToMessageId: command.promptMessageId,
      relayedFrom: { kind: 'side-chat' as const, direction: 'to-main' as const },
      createdAt: 1,
      updatedAt: 1
    }))
    const onDelivered = vi.fn()
    const adapter = createMainPromptSideChatRelay({
      relay,
      appendSideChatAdvisory,
      onDelivered
    })

    const claim = adapter.claim('main-1')

    expect(claim?.historyPreamble).toContain('context-only advisories')
    expect(claim?.historyPreamble).toContain('Use a black line.')
    expect(appendSideChatAdvisory).not.toHaveBeenCalled()
    expect(onDelivered).not.toHaveBeenCalled()

    await claim?.commit('prompt-1')

    expect(appendSideChatAdvisory).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'main-1',
      promptMessageId: 'prompt-1',
      content: 'Use a black line.'
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

  it('restores a claim before provider admission', () => {
    const relay = new SideChatRelayOwner({ targetState: () => 'completed' })
    relay.bind({
      sideSessionId: 'side-1',
      parentSessionId: 'main-1',
      projectId: 'project-1'
    })
    relay.send({ sideSessionId: 'side-1', target: 'main', text: 'Keep this queued.' })
    const adapter = createMainPromptSideChatRelay({
      relay,
      appendSideChatAdvisory: vi.fn(),
      onDelivered: vi.fn()
    })

    adapter.claim('main-1')?.restore()

    expect(adapter.claim('main-1')?.historyPreamble).toContain('Keep this queued.')
  })

  it('requires the admitted main prompt identity before making delivery durable', async () => {
    const relay = new SideChatRelayOwner({ targetState: () => 'idle' })
    relay.bind({
      sideSessionId: 'side-1',
      parentSessionId: 'main-1',
      projectId: 'project-1'
    })
    relay.send({ sideSessionId: 'side-1', target: 'main', text: 'Advisory.' })
    const adapter = createMainPromptSideChatRelay({
      relay,
      appendSideChatAdvisory: vi.fn(),
      onDelivered: vi.fn()
    })

    await expect(adapter.claim('main-1')?.commit()).rejects.toThrow(
      'Main prompt message identity is required'
    )
  })
})
