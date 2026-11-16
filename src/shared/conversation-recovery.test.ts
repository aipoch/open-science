import { describe, expect, it } from 'vitest'
import { canResendConversationPrompt, recoverableConversationPrompt } from './conversation-recovery'
import {
  materializeSessionConversationGraph,
  setTurnOutcome,
  createSessionFile,
  decodeSessionFile,
  type PersistedChatSession
} from './session-persistence'

const fixture = (): PersistedChatSession =>
  materializeSessionConversationGraph({
    id: 's',
    projectId: 'p',
    title: 'Request',
    cwd: '/workspace',
    status: 'error',
    createdAt: 1,
    updatedAt: 2,
    messages: [
      {
        id: 'prompt',
        role: 'user',
        content: 'Analyze',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ]
  })

describe('durable conversation recovery evidence', () => {
  it('never treats missing output or admission evidence as permission to resend', () => {
    const session = fixture()
    expect(recoverableConversationPrompt(session)?.id).toBe('prompt')
    expect(canResendConversationPrompt(session, session.messages[0])).toBe(false)
  })

  it('resends only a definitive pre-dispatch failure and keeps that evidence through restart', () => {
    const session = setTurnOutcome(fixture(), 'prompt', {
      kind: 'failed',
      settledAt: 2,
      execution: 'not-started'
    })
    const decoded = decodeSessionFile(createSessionFile(session))
    if (decoded.status !== 'ok') throw new Error('Expected valid session')
    const restored = decoded.session
    expect(canResendConversationPrompt(restored, restored.messages[0])).toBe(true)
  })

  it.each(['app-restart', 'connection-lost'] as const)(
    'keeps %s uncertainty after a later pre-dispatch failure and restart',
    (cause) => {
      const interrupted = setTurnOutcome(fixture(), 'prompt', {
        kind: 'interrupted',
        settledAt: 2,
        cause,
        recovery: 'resume'
      })
      const failed = setTurnOutcome(interrupted, 'prompt', {
        kind: 'failed',
        settledAt: 3,
        execution: 'not-started'
      })
      const decoded = decodeSessionFile(createSessionFile(failed))
      if (decoded.status !== 'ok') throw new Error('Expected valid session')
      const restored = decoded.session
      expect(restored.messages[0].failureHistory).toMatchObject([{ kind: 'interrupted', cause }])
      expect(canResendConversationPrompt(restored, restored.messages[0])).toBe(false)
    }
  )

  it('never resends an observed reply even if a later failure was before dispatch', () => {
    const session = setTurnOutcome(fixture(), 'prompt', {
      kind: 'failed',
      settledAt: 2,
      execution: 'not-started'
    })
    session.conversationGraph!.messages.push({
      ...session.conversationGraph!.messages[0],
      id: 'reply',
      role: 'agent',
      responseToMessageId: 'prompt',
      content: 'Completed analysis'
    })
    expect(canResendConversationPrompt(session, session.messages[0])).toBe(false)
  })

  it('does not grant model recovery to a publication failure or an older failed turn', () => {
    const publication = setTurnOutcome(fixture(), 'prompt', {
      kind: 'failed',
      settledAt: 2,
      recovery: 'retry-artifact-publication'
    })
    expect(recoverableConversationPrompt(publication)).toBeUndefined()
    const graph = publication.conversationGraph!
    const first = graph.messages[0]
    graph.messages.push({
      ...first,
      id: 'next',
      content: 'New request',
      parentMessageId: first.id,
      turnOutcome: undefined
    })
    graph.branches[0].headMessageId = 'next'
    expect(recoverableConversationPrompt(publication, first.id)).toBeUndefined()
  })
})
