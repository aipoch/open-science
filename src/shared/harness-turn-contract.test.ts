import { describe, expect, it } from 'vitest'
import { harnessTurnJournalSchema, type HarnessTurnJournal } from './harness-turn-contract'
import { sanitizeMessage } from './session-persistence/message-codec'

const journal = (): HarnessTurnJournal => ({
  schemaVersion: 1,
  scope: {
    projectId: 'p',
    sessionId: 's',
    agentFrameId: 'f',
    messageBranchId: 'b',
    promptMessageId: 'u',
    messageId: 'a',
    generation: 'g',
    route: {
      id: 'r',
      providerId: 'provider',
      configRevision: 0,
      model: 'model',
      protocol: 'chat-completions'
    }
  },
  status: 'running',
  attemptedRequests: 0,
  requests: []
})
const message = (harnessTurn: unknown): Record<string, unknown> => ({
  id: 'a',
  role: 'agent',
  content: '',
  status: 'streaming',
  eventIds: [],
  createdAt: 1,
  updatedAt: 1,
  harnessTurn
})

describe('harness durable contract', () => {
  it('round trips the journal without sharing mutable receipt state', () => {
    const source = journal()
    const result = sanitizeMessage(message(source))!
    expect(result.harnessTurn).toEqual(source)
    result.harnessTurn!.scope.generation = 'changed'
    expect(source.scope.generation).toBe('g')
  })

  it.each([
    { ...journal(), schemaVersion: 2 },
    { ...journal(), unexpectedCredential: 'private-key' },
    { ...journal(), attemptedRequests: -1 },
    { ...journal(), scope: { ...journal().scope, generation: ' ' } },
    {
      ...journal(),
      scope: { ...journal().scope, route: { ...journal().scope.route, token: 'private-key' } }
    }
  ])('keeps a blocking marker for invalid or unsupported journal %#', (input) => {
    expect(harnessTurnJournalSchema.safeParse(input).success).toBe(false)
    const parsed = sanitizeMessage(message(input))!
    expect(parsed.harnessTurn).toBeUndefined()
    expect(parsed.harnessTurnInvalid).toBe(true)
    expect(sanitizeMessage(JSON.parse(JSON.stringify(parsed)))?.harnessTurnInvalid).toBe(true)
    expect(JSON.stringify(parsed)).not.toContain('private-key')
  })

  it('does not accept a journal on a user message and leaves legacy messages unchanged', () => {
    expect(sanitizeMessage({ ...message(journal()), role: 'user' })?.harnessTurn).toBeUndefined()
    const legacy = message(undefined)
    expect(sanitizeMessage(legacy)?.harnessTurnInvalid).toBeUndefined()
  })
})
