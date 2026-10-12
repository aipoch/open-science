import { expect, it } from 'vitest'
import {
  SESSION_DETAILS_TITLE_MAX_LENGTH,
  deriveSessionAttention
} from '../../shared/session-persistence'
import { createForkSession, nextForkTitle } from './fork-session'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { createLinearConversationGraph } from '../../shared/conversation-graph'

it.each([
  ['Study', [], 'Study(2)'],
  ['Study', ['Study(2)', 'Study(3)'], 'Study(4)'],
  ['Study(2)', [], 'Study(2)(2)'],
  ['文'.repeat(80), [], `${'文'.repeat(77)}(2)`],
  ['x'.repeat(1000), [], `${'x'.repeat(77)}(2)`],
  ['x'.repeat(76) + '😀tail', [], `${'x'.repeat(76)}(2)`],
  ['x'.repeat(76) + 'e\u0301tail', [], `${'x'.repeat(76)}(2)`],
  ['x'.repeat(76) + '👩‍🔬tail', [], `${'x'.repeat(76)}(2)`],
  ['x'.repeat(75) + '😀tail', [], `${'x'.repeat(75)}😀(2)`],
  ['x'.repeat(80), [`${'x'.repeat(77)}(2)`], `${'x'.repeat(77)}(3)`],
  [
    'x'.repeat(80),
    Array.from({ length: 8 }, (_, i) => `${'x'.repeat(77)}(${i + 2})`),
    `${'x'.repeat(76)}(10)`
  ]
] as const)(
  'allocates a bounded title without splitting characters (%s)',
  (source, existing, expected) => {
    const title = nextForkTitle(source, existing)
    expect(title).toBe(expected)
    expect(title.length).toBeLessThanOrEqual(SESSION_DETAILS_TITLE_MAX_LENGTH)
    expect(existing).not.toContain(title)
  }
)

it('records the copied active branch head independently of original usage attribution on refork', () => {
  const copied: PersistedChatSession = {
    id: 'child',
    projectId: 'project',
    title: 'Copy',
    cwd: '',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    researchMembership: {
      sourceProjectId: 'p',
      sourceSessionId: 'research',
      sourceImportId: 'import',
      sourceTitle: 'Research'
    },
    packageOrigin: {
      importId: 'copy',
      sourceProjectId: 'project',
      sourceSessionId: 'source',
      importedAt: 2,
      manifestChecksum: 'a'.repeat(64)
    },
    conversationGraph: createLinearConversationGraph({
      sessionId: 'child',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          id: 'local-head',
          role: 'agent',
          content: 'Copied answer',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 2,
          usageOrigin: { sessionId: 'ancestor', messageId: 'original-head' }
        }
      ]
    })
  }
  const source = {
    ...copied,
    id: 'source',
    packageOrigin: undefined,
    forkHeadMessageId: 'previous-copy-head'
  }
  const fork = createForkSession(copied, source, 'ask', 'Copy(2)')
  expect(fork.researchMembership).toBeUndefined()
  expect(fork.forkHeadMessageId).toBe('local-head')
  expect(fork.conversationGraph?.messages[0].usageOrigin).toEqual({
    sessionId: 'ancestor',
    messageId: 'original-head'
  })
})

const turnSession = (
  id: string,
  overrides: Partial<PersistedChatSession> = {},
  promptOutcome?: NonNullable<PersistedChatSession['messages'][number]['turnOutcome']>
): PersistedChatSession => {
  const messages: PersistedChatSession['messages'] = [
    {
      id: `${id}-prompt`,
      role: 'user',
      content: 'Question',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1,
      ...(promptOutcome ? { turnOutcome: promptOutcome } : {})
    },
    {
      id: `${id}-reply`,
      role: 'agent',
      content: '',
      status: 'error',
      eventIds: [],
      createdAt: 2,
      updatedAt: 2,
      responseToMessageId: `${id}-prompt`
    }
  ]
  return {
    id,
    projectId: 'project',
    title: 'Source',
    cwd: '',
    status: 'idle',
    createdAt: 1,
    updatedAt: 3,
    messages,
    conversationGraph: createLinearConversationGraph({
      sessionId: id,
      createdAt: 1,
      updatedAt: 3,
      messages
    }),
    ...overrides
  }
}

// The package copier remaps Message identities; mirror that so the fork cannot rely on source ids.
const copyForFork = (source: PersistedChatSession): PersistedChatSession => {
  const copied = structuredClone({ ...source, id: 'fork' })
  const rename = (id: string): string => id.replace(/^source/, 'fork')
  copied.messages = copied.messages.map((message) => ({
    ...message,
    id: rename(message.id),
    responseToMessageId: message.responseToMessageId && rename(message.responseToMessageId)
  }))
  copied.conversationGraph = createLinearConversationGraph({
    sessionId: 'fork',
    createdAt: 1,
    updatedAt: 3,
    messages: copied.messages
  })
  return copied
}

const legacyFailed = (): PersistedChatSession =>
  turnSession('source', { status: 'error', error: 'Provider failed', errorReportable: true })

const legacyInterrupted = (): PersistedChatSession =>
  turnSession('source', {
    status: 'error',
    error: 'Interrupted',
    resumeRecovery: {
      kind: 'resume-required',
      promptMessageId: 'source-prompt',
      cause: 'app-restart'
    }
  })

it('keeps a legacy failed latest turn as a durable failed outcome in the fork', () => {
  const source = legacyFailed()
  const before = structuredClone(source)
  const fork = createForkSession(copyForFork(source), source, 'ask', 'Copy')
  expect(fork.status).toBe('idle')
  for (const message of [fork.messages[0], fork.conversationGraph!.messages[0]])
    expect(message.turnOutcome).toMatchObject({
      kind: 'failed',
      error: 'Provider failed',
      errorReportable: true
    })
  expect(deriveSessionAttention(fork)).toBeUndefined()
  expect(source).toEqual(before)
})

it('does not offer Artifact publication retry from a materialized legacy failure', () => {
  const source = turnSession('source', {
    status: 'error',
    error: 'Generated file finalization failed: disk full'
  })
  const fork = createForkSession(copyForFork(source), source, 'ask', 'Copy')
  expect(fork.messages[0].turnOutcome).toMatchObject({ kind: 'failed' })
  expect(fork.messages[0].turnOutcome).not.toHaveProperty('recovery')
})

it.each([
  ['failed', { kind: 'failed', settledAt: 3, error: 'Boom' }],
  ['interrupted', { kind: 'interrupted', settledAt: 3, cause: 'app-restart', recovery: 'resume' }],
  ['cancelled', { kind: 'cancelled', settledAt: 3, recovery: 'resume' }]
] as const)('demotes an inherited %s latest outcome to history', (_kind, outcome) => {
  const source = turnSession(
    'source',
    outcome.kind === 'failed'
      ? { status: 'error', error: 'Boom' }
      : {
          status: 'error',
          resumeRecovery: {
            kind: 'resume-required',
            promptMessageId: 'source-prompt',
            cause: outcome.kind === 'cancelled' ? 'cancelled' : 'app-restart'
          }
        },
    outcome
  )
  const before = structuredClone(source)
  const fork = createForkSession(copyForFork(source), source, 'ask', 'Copy')
  expect(fork.forkHeadMessageId).toBe('fork-reply')
  expect(fork.messages[0].turnOutcome).toEqual(outcome)
  expect(deriveSessionAttention(fork)).toBeUndefined()
  expect(source).toEqual(before)

  const followUp: PersistedChatSession['messages'][number] = {
    ...fork.messages[0],
    id: 'fork-follow-up',
    turnOutcome: { kind: 'failed', settledAt: 9, error: 'New failure' }
  }
  const messages = [...fork.messages, followUp]
  const next = {
    ...fork,
    messages,
    conversationGraph: createLinearConversationGraph({
      sessionId: 'fork',
      createdAt: 1,
      updatedAt: 9,
      messages
    })
  }
  expect(deriveSessionAttention(next)?.turn).toMatchObject({
    promptMessageId: 'fork-follow-up',
    outcome: { error: 'New failure' }
  })
})

it('does not materialize an outcome for a legacy interrupted latest turn', () => {
  const source = legacyInterrupted()
  const before = structuredClone(source)
  const fork = createForkSession(copyForFork(source), source, 'ask', 'Copy')
  expect(fork.resumeRecovery).toBeUndefined()
  expect(fork.messages[0].turnOutcome).toBeUndefined()
  expect(fork.conversationGraph!.messages[0].turnOutcome).toBeUndefined()
  expect(deriveSessionAttention(fork)).toBeUndefined()
  expect(source).toEqual(before)
})

it('preserves an existing Turn Outcome on the copied latest turn', () => {
  const outcome = { kind: 'failed', settledAt: 3, error: 'Boom' } as const
  const source = turnSession('source', {}, outcome)
  const fork = createForkSession(copyForFork(source), source, 'ask', 'Copy')
  expect(fork.messages[0].turnOutcome).toEqual(outcome)
  expect(fork.conversationGraph!.messages[0].turnOutcome).toEqual(outcome)
})
