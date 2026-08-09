import { describe, expect, it, vi } from 'vitest'

import { SideChatRelayOwner } from './side-chat-relay-owner'

const createOwner = (): {
  owner: SideChatRelayOwner
  targetState: (parentSessionId: string) => 'idle'
} => {
  const targetState = vi.fn(() => 'idle' as const)
  return { owner: new SideChatRelayOwner({ targetState }), targetState }
}

describe('SideChatRelayOwner', () => {
  it('queues a relationship-bound side-to-main advisory without waking main', () => {
    const { owner, targetState } = createOwner()
    owner.bind({ sideSessionId: 'side-1', parentSessionId: 'main-1', projectId: 'project-1' })

    const result = owner.send({ sideSessionId: 'side-1', target: 'main', text: '  Use black.  ' })

    expect(result).toMatchObject({
      status: 'queued',
      targetState: 'idle',
      delivery: 'next-user-turn',
      persisted: false
    })
    expect(result.messageId).toMatch(/^side-chat-message-/)
    expect(result.systemHint).toContain('next user turn')
    expect(targetState).toHaveBeenCalledWith('main-1')
    expect(owner.claim('main-1')?.messages).toEqual([
      expect.objectContaining({
        id: result.messageId,
        parentSessionId: 'main-1',
        projectId: 'project-1',
        text: 'Use black.'
      })
    ])
  })

  it('rejects untrusted senders, raw targets, empty text, and oversized text', () => {
    const { owner } = createOwner()
    owner.bind({ sideSessionId: 'side-1', parentSessionId: 'main-1', projectId: 'project-1' })

    expect(() => owner.send({ sideSessionId: 'unknown', target: 'main', text: 'hello' })).toThrow(
      'not bound'
    )
    expect(() =>
      owner.send({ sideSessionId: 'side-1', target: 'main-2' as 'main', text: 'hello' })
    ).toThrow('target main')
    expect(() => owner.send({ sideSessionId: 'side-1', target: 'main', text: '   ' })).toThrow(
      'non-empty'
    )
    expect(() =>
      owner.send({ sideSessionId: 'side-1', target: 'main', text: 'x'.repeat(12_001) })
    ).toThrow('12,000')
  })

  it('restores a failed claim ahead of messages queued while main was preparing', () => {
    const { owner } = createOwner()
    owner.bind({ sideSessionId: 'side-1', parentSessionId: 'main-1', projectId: 'project-1' })
    owner.send({ sideSessionId: 'side-1', target: 'main', text: 'first' })
    const claim = owner.claim('main-1')!

    owner.send({ sideSessionId: 'side-1', target: 'main', text: 'second' })
    claim.restore()

    expect(owner.claim('main-1')?.messages.map(({ text }) => text)).toEqual(['first', 'second'])
  })

  it('commits one claim exactly once and leaves later messages queued', () => {
    const { owner } = createOwner()
    owner.bind({ sideSessionId: 'side-1', parentSessionId: 'main-1', projectId: 'project-1' })
    owner.send({ sideSessionId: 'side-1', target: 'main', text: 'first' })
    const claim = owner.claim('main-1')!
    owner.send({ sideSessionId: 'side-1', target: 'main', text: 'second' })

    expect(claim.commit().map(({ text }) => text)).toEqual(['first'])
    expect(claim.commit()).toEqual([])
    expect(owner.claim('main-1')?.messages.map(({ text }) => text)).toEqual(['second'])
  })

  it('keeps queued advisories when the side panel closes and drops them with the parent', () => {
    const { owner } = createOwner()
    owner.bind({ sideSessionId: 'side-1', parentSessionId: 'main-1', projectId: 'project-1' })
    owner.send({ sideSessionId: 'side-1', target: 'main', text: 'keep me' })

    owner.releaseSide('side-1')
    expect(owner.claim('main-1')?.messages.map(({ text }) => text)).toEqual(['keep me'])

    owner.releaseParent('main-1')
    expect(owner.claim('main-1')).toBeUndefined()
  })

  it('invalidates an unadmitted claim when its parent scope is released', () => {
    const { owner } = createOwner()
    owner.bind({ sideSessionId: 'side-1', parentSessionId: 'main-1', projectId: 'project-1' })
    owner.send({ sideSessionId: 'side-1', target: 'main', text: 'already preparing' })
    const claim = owner.claim('main-1')!

    owner.releaseParent('main-1')

    expect(claim.commit()).toEqual([])
    claim.restore()
    expect(owner.claim('main-1')).toBeUndefined()
  })
})
