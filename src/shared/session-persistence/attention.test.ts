import { describe, expect, it } from 'vitest'
import { deriveSessionAttention, projectSessionAttention } from './attention'
import { materializeSessionConversationGraph } from '../session-conversation-graph-materialization'
import type { PersistedChatSession } from './session'

const fixture = (messages: PersistedChatSession['messages']): PersistedChatSession =>
  materializeSessionConversationGraph({
    id: 's',
    projectId: 'p',
    title: 'Test',
    cwd: '/tmp',
    status: 'error',
    createdAt: 1,
    updatedAt: 2,
    messages
  })

describe('Session Attention', () => {
  it('includes a visible application correction as its own turn', () => {
    const session = fixture([
      {
        id: 'correction',
        role: 'user',
        content: 'Fix the cited claim',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1,
        attribution: {
          kind: 'application',
          feature: 'reviewer',
          purpose: 'correction',
          causeReviewId: 'review'
        },
        turnOutcome: { kind: 'failed', settledAt: 2 }
      }
    ])
    expect(deriveSessionAttention(session)?.turn?.promptMessageId).toBe('correction')
  })

  it.each([
    [{ kind: 'completed', settledAt: 2 }, false],
    [{ kind: 'cancelled', settledAt: 2, recovery: 'resume' }, false],
    [{ kind: 'failed', settledAt: 2 }, true],
    [{ kind: 'interrupted', cause: 'app-restart', settledAt: 2, recovery: 'resume' }, true],
    [{ kind: 'interrupted', cause: 'connection-lost', settledAt: 2, recovery: 'resume' }, true],
    [
      { kind: 'interrupted', cause: 'terminal-commit-failed', settledAt: 2, recovery: 'resume' },
      false
    ]
  ] as const)('projects outcome %j as attention=%s', (turnOutcome, attention) => {
    const session = fixture([
      {
        id: 'prompt',
        role: 'user',
        content: 'x',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1,
        turnOutcome
      }
    ])
    expect(Boolean(deriveSessionAttention(session))).toBe(attention)
    expect(deriveSessionAttention(session, ['size-limit'])?.recordProblems).toEqual(['size-limit'])
  })

  it('clears the previous failure when a newer visible prompt exists', () => {
    const session = fixture([
      {
        id: 'old',
        role: 'user',
        content: 'x',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1,
        turnOutcome: { kind: 'failed', settledAt: 1 }
      },
      {
        id: 'new',
        role: 'user',
        content: 'y',
        status: 'complete',
        eventIds: [],
        createdAt: 2,
        updatedAt: 2,
        turnOutcome: { kind: 'completed', settledAt: 2 }
      }
    ])
    expect(deriveSessionAttention(session)).toBeUndefined()
  })

  it('projects the latest visible failed turn', () => {
    const session = fixture([
      {
        id: 'prompt',
        role: 'user',
        content: 'x',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1,
        turnOutcome: { kind: 'failed', settledAt: 2, error: 'failed' }
      }
    ])
    expect(deriveSessionAttention(session)?.turn?.promptMessageId).toBe('prompt')
  })
  it('keeps independent record problems and canonical ordering', () => {
    expect(projectSessionAttention({ recordProblems: ['size-limit', 'missing-record'] })).toEqual({
      recordProblems: ['missing-record', 'size-limit']
    })
  })
  it('does not transfer a hidden control failure to an earlier visible turn', () => {
    const session = fixture([
      {
        id: 'visible',
        role: 'user',
        content: 'x',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1,
        turnOutcome: { kind: 'failed', settledAt: 1, error: 'old' }
      },
      {
        id: 'hidden',
        role: 'user',
        content: 'save',
        status: 'complete',
        eventIds: [],
        createdAt: 2,
        updatedAt: 2,
        turnIntent: 'save-as-skill',
        turnOutcome: { kind: 'failed', settledAt: 2, error: 'hidden' }
      }
    ])
    expect(deriveSessionAttention(session)?.turn?.promptMessageId).toBe('visible')
    delete session.messages[0].turnOutcome
    delete session.conversationGraph!.messages[0].turnOutcome
    expect(deriveSessionAttention(session)).toBeUndefined()
  })

  describe('fork history', () => {
    const turn = (
      id: string,
      turnOutcome?: PersistedChatSession['messages'][number]['turnOutcome']
    ): PersistedChatSession['messages'][number] => ({
      id,
      role: 'user',
      content: id,
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1,
      ...(turnOutcome ? { turnOutcome } : {})
    })
    const fork = (
      messages: PersistedChatSession['messages'],
      forkHeadMessageId: string | undefined,
      overrides: Partial<PersistedChatSession> = {}
    ): PersistedChatSession => ({ ...fixture(messages), forkHeadMessageId, ...overrides })
    const failed = { kind: 'failed', settledAt: 2, error: 'Provider failed' } as const
    const interrupted = {
      kind: 'interrupted',
      settledAt: 2,
      cause: 'app-restart',
      recovery: 'resume'
    } as const

    it.each([failed, interrupted])('does not alert on an inherited %o latest turn', (outcome) => {
      expect(
        deriveSessionAttention(fork([turn('inherited', outcome)], 'inherited'))
      ).toBeUndefined()
    })

    it('does not alert on an inherited legacy outcome that Session status still describes', () => {
      expect(
        deriveSessionAttention(fork([turn('inherited')], 'inherited', { status: 'error' }))
      ).toBeUndefined()
    })

    it('alerts again on a prompt sent after forking', () => {
      const session = fork(
        [turn('inherited', failed), turn('new', { ...failed, error: 'New failure' })],
        'inherited'
      )
      expect(deriveSessionAttention(session)?.turn).toMatchObject({
        promptMessageId: 'new',
        outcome: { error: 'New failure' }
      })
    })

    it('keeps today behavior for a fork without a recorded head', () => {
      expect(
        deriveSessionAttention(fork([turn('inherited', failed)], undefined))?.turn?.promptMessageId
      ).toBe('inherited')
    })
  })
})
