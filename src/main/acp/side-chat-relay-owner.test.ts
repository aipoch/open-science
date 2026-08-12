import { describe, expect, it, vi } from 'vitest'

import { SideChatRelayOwner } from './side-chat-relay-owner'

const createOwner = (): {
  owner: SideChatRelayOwner
  targetState: (parentSessionId: string) => 'idle'
  appendRelay: ReturnType<typeof vi.fn>
} => {
  const targetState = vi.fn(() => 'idle' as const)
  const appendRelay = vi.fn(async () => undefined)
  return { owner: new SideChatRelayOwner({ targetState, appendRelay }), targetState, appendRelay }
}

describe('SideChatRelayOwner', () => {
  it('persists then queues a relationship-bound side-to-main advisory without waking main', async () => {
    const { owner, targetState, appendRelay } = createOwner()
    owner.bind({
      sideSessionId: 'side-1',
      sideChatId: 'chat-1',
      parentSessionId: 'main-1',
      projectId: 'project-1'
    })

    const result = await owner.send({
      sideSessionId: 'side-1',
      target: 'main',
      text: '  Use black.  '
    })

    expect(result).toMatchObject({
      status: 'queued',
      targetState: 'idle',
      delivery: 'next-user-turn',
      persisted: true
    })
    expect(result.messageId).toMatch(/^side-chat-message-/)
    expect(result.systemHint).toContain('next user turn')
    expect(targetState).toHaveBeenCalledWith('main-1')
    expect(appendRelay).toHaveBeenCalledWith({
      projectId: 'project-1',
      parentSessionId: 'main-1',
      sideChatId: 'chat-1',
      relay: expect.objectContaining({ id: result.messageId, text: 'Use black.' })
    })
    expect(owner.claim('main-1')?.messages).toEqual([
      expect.objectContaining({
        id: result.messageId,
        parentSessionId: 'main-1',
        projectId: 'project-1',
        text: 'Use black.'
      })
    ])
  })

  it('rejects untrusted senders, raw targets, empty text, and oversized text', async () => {
    const { owner } = createOwner()
    owner.bind({
      sideSessionId: 'side-1',
      sideChatId: 'chat-1',
      parentSessionId: 'main-1',
      projectId: 'project-1'
    })

    await expect(
      owner.send({ sideSessionId: 'unknown', target: 'main', text: 'hello' })
    ).rejects.toThrow('not bound')
    await expect(
      owner.send({ sideSessionId: 'side-1', target: 'main-2' as 'main', text: 'hello' })
    ).rejects.toThrow('target main')
    await expect(
      owner.send({ sideSessionId: 'side-1', target: 'main', text: '   ' })
    ).rejects.toThrow('non-empty')
    await expect(
      owner.send({ sideSessionId: 'side-1', target: 'main', text: 'x'.repeat(12_001) })
    ).rejects.toThrow('12,000')
  })

  it('does not expose a relay in memory when durable enqueue fails', async () => {
    const owner = new SideChatRelayOwner({
      targetState: () => 'idle',
      appendRelay: async () => {
        throw new Error('disk unavailable')
      }
    })
    owner.bind({
      sideSessionId: 'side-1',
      sideChatId: 'chat-1',
      parentSessionId: 'main-1',
      projectId: 'project-1'
    })

    await expect(
      owner.send({ sideSessionId: 'side-1', target: 'main', text: 'Use black.' })
    ).rejects.toThrow('disk unavailable')
    expect(owner.claim('main-1')).toBeUndefined()
  })

  it('hydrates durable relays before any Side chat runtime is resumed', () => {
    const { owner } = createOwner()
    owner.hydrate([
      {
        parentSessionId: 'main-restored',
        projectId: 'project-1',
        relays: [
          {
            id: 'relay-restored',
            sideChatId: 'chat-restored',
            text: 'Persisted advisory',
            createdAt: 10
          }
        ]
      }
    ])

    expect(owner.claim('main-restored')?.messages).toEqual([
      {
        id: 'relay-restored',
        text: 'Persisted advisory',
        createdAt: 10,
        sideSessionId: 'chat-restored',
        sideChatId: 'chat-restored',
        parentSessionId: 'main-restored',
        projectId: 'project-1'
      }
    ])
  })

  it('restores a failed claim ahead of messages queued while main was preparing', async () => {
    const { owner } = createOwner()
    owner.bind({
      sideSessionId: 'side-1',
      sideChatId: 'chat-1',
      parentSessionId: 'main-1',
      projectId: 'project-1'
    })
    await owner.send({ sideSessionId: 'side-1', target: 'main', text: 'first' })
    const claim = owner.claim('main-1')!

    await owner.send({ sideSessionId: 'side-1', target: 'main', text: 'second' })
    claim.restore()

    expect(owner.claim('main-1')?.messages.map(({ text }) => text)).toEqual(['first', 'second'])
  })

  it('commits one claim exactly once and leaves later messages queued', async () => {
    const { owner } = createOwner()
    owner.bind({
      sideSessionId: 'side-1',
      sideChatId: 'chat-1',
      parentSessionId: 'main-1',
      projectId: 'project-1'
    })
    await owner.send({ sideSessionId: 'side-1', target: 'main', text: 'first' })
    const claim = owner.claim('main-1')!
    await owner.send({ sideSessionId: 'side-1', target: 'main', text: 'second' })

    expect(claim.commit().map(({ text }) => text)).toEqual(['first'])
    expect(claim.commit()).toEqual([])
    expect(owner.claim('main-1')?.messages.map(({ text }) => text)).toEqual(['second'])
  })

  it('keeps queued advisories when the side panel closes and drops them with the parent', async () => {
    const { owner } = createOwner()
    owner.bind({
      sideSessionId: 'side-1',
      sideChatId: 'chat-1',
      parentSessionId: 'main-1',
      projectId: 'project-1'
    })
    await owner.send({ sideSessionId: 'side-1', target: 'main', text: 'keep me' })

    owner.releaseSide('side-1')
    expect(owner.claim('main-1')?.messages.map(({ text }) => text)).toEqual(['keep me'])

    owner.releaseParent('main-1')
    expect(owner.claim('main-1')).toBeUndefined()
  })

  it('invalidates an unadmitted claim when its parent scope is released', async () => {
    const { owner } = createOwner()
    owner.bind({
      sideSessionId: 'side-1',
      sideChatId: 'chat-1',
      parentSessionId: 'main-1',
      projectId: 'project-1'
    })
    await owner.send({ sideSessionId: 'side-1', target: 'main', text: 'already preparing' })
    const claim = owner.claim('main-1')!

    owner.releaseParent('main-1')

    expect(claim.commit()).toEqual([])
    claim.restore()
    expect(owner.claim('main-1')).toBeUndefined()
  })
})
