import { describe, expect, it } from 'vitest'
import { materializeSessionConversationGraph } from '../session-conversation-graph-materialization'
import { createSessionFile, decodeSessionFile } from './file-codec'
import { sanitizeMessage } from './message-codec'
import { sanitizeTurnOutcome } from './turn-outcome'

const future = { futureField: { nested: true } }

describe('sanitizeTurnOutcome forward compatibility', () => {
  it.each([
    [{ kind: 'completed', settledAt: 2 }],
    [{ kind: 'failed', settledAt: 2, error: 'Bad', errorReportable: false }],
    [{ kind: 'failed', settledAt: 2, recovery: 'retry-artifact-publication' }],
    [{ kind: 'cancelled', settledAt: 2, recovery: 'resume' }],
    [
      {
        kind: 'interrupted',
        settledAt: 2,
        cause: 'app-restart',
        error: 'Interrupted',
        errorReportable: false,
        recovery: 'resume'
      }
    ],
    [{ kind: 'interrupted', settledAt: 2, cause: 'connection-lost', recovery: 'resume' }]
  ])('keeps a known kind and strips unknown fields: %j', (outcome) => {
    const result = sanitizeTurnOutcome({ ...outcome, ...future, another: 1 })
    expect(result).toEqual(outcome)
    expect(Object.keys(result ?? {}).sort()).toEqual(Object.keys(outcome).sort())
  })

  it('does not alias the submitted object', () => {
    const raw = { kind: 'completed', settledAt: 2, ...future }
    expect(sanitizeTurnOutcome(raw)).not.toBe(raw)
  })

  it('drops an unknown kind', () => {
    expect(sanitizeTurnOutcome({ kind: 'paused', settledAt: 2 })).toBeUndefined()
  })

  it.each(['future-action', 'resume', { a: 1 }])(
    'strips an unrecognized failed.recovery %j but keeps the failure',
    (recovery) => {
      expect(sanitizeTurnOutcome({ kind: 'failed', settledAt: 2, error: 'Bad', recovery })).toEqual(
        {
          kind: 'failed',
          settledAt: 2,
          error: 'Bad'
        }
      )
    }
  )

  it.each([
    [
      'unknown interrupted.cause',
      { kind: 'interrupted', settledAt: 2, cause: 'future-cause', recovery: 'resume' }
    ],
    [
      'unknown interrupted.recovery',
      { kind: 'interrupted', settledAt: 2, cause: 'app-restart', recovery: 'future-action' }
    ],
    ['unknown cancelled.recovery', { kind: 'cancelled', settledAt: 2, recovery: 'future-action' }],
    [
      'live-only terminal-commit-failed',
      {
        kind: 'interrupted',
        settledAt: 2,
        cause: 'terminal-commit-failed',
        recovery: 'resume',
        ...future
      }
    ],
    ['invalid settledAt', { kind: 'completed', settledAt: -1, ...future }],
    ['invalid known error', { kind: 'failed', settledAt: 2, error: 4, ...future }]
  ])('still drops %s', (_name, value) => {
    expect(sanitizeTurnOutcome(value)).toBeUndefined()
  })
})

describe('Turn Outcome in a Session file written by a future version', () => {
  const session = materializeSessionConversationGraph({
    id: 's',
    projectId: 'p',
    title: 'Research',
    cwd: '/workspace',
    status: 'idle',
    createdAt: 1,
    updatedAt: 9,
    messages: ['a', 'b'].flatMap((id, index) => [
      {
        id: `prompt-${id}`,
        role: 'user' as const,
        content: id,
        status: 'complete' as const,
        eventIds: [],
        createdAt: index * 2 + 1,
        updatedAt: index * 2 + 1
      },
      {
        id: `response-${id}`,
        role: 'agent' as const,
        responseToMessageId: `prompt-${id}`,
        content: 'Result',
        status: 'complete' as const,
        eventIds: [],
        createdAt: index * 2 + 2,
        updatedAt: index * 2 + 2
      }
    ])
  })

  it('keeps every historical outcome instead of rebuilding only the latest turn', () => {
    const file = JSON.parse(JSON.stringify(createSessionFile(session))) as {
      session: {
        messages: Record<string, unknown>[]
        conversationGraph: { messages: Record<string, unknown>[] }
      }
    }
    const outcomes: Record<string, unknown> = {
      'prompt-a': { kind: 'failed', settledAt: 2, error: 'Old failure', futureField: 1 },
      'prompt-b': { kind: 'completed', settledAt: 4, futureField: 2 }
    }
    for (const message of [...file.session.messages, ...file.session.conversationGraph.messages])
      if (outcomes[message.id as string]) message.turnOutcome = outcomes[message.id as string]
    for (const options of [{ preserveRuntimeState: true }, undefined]) {
      const decoded = decodeSessionFile(file, options)
      expect(decoded.status).toBe('ok')
      if (decoded.status !== 'ok') throw new Error('Expected Session decode')
      const byId = new Map(decoded.session.messages.map((message) => [message.id, message]))
      expect(byId.get('prompt-a')?.turnOutcome).toEqual({
        kind: 'failed',
        settledAt: 2,
        error: 'Old failure'
      })
      expect(byId.get('prompt-b')?.turnOutcome).toEqual({ kind: 'completed', settledAt: 4 })
    }
  })

  it('sanitizeMessage keeps the outcome of a user message with extra fields', () => {
    const message = session.messages[0]
    expect(
      sanitizeMessage({ ...message, turnOutcome: { kind: 'completed', settledAt: 2, ...future } })
        ?.turnOutcome
    ).toEqual({ kind: 'completed', settledAt: 2 })
  })
})
