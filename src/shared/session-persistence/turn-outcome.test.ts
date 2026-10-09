import { describe, expect, it } from 'vitest'
import { activateConversationBranch, forkEditedConversationMessage } from '../conversation-graph'
import { materializeSessionConversationGraph } from '../session-conversation-graph-materialization'
import { createSessionFile, decodeSessionFile } from './file-codec'
import type { PersistedChatSession } from './session'
import { sanitizeMessage } from './message-codec'
import { deriveSessionAttention } from './attention'
import {
  resolveTurnOutcome,
  latestOutcomePrompt,
  setTurnOutcome,
  sanitizeTurnOutcome,
  legacySessionStateForOutcome,
  type TurnOutcome
} from './turn-outcome'

const fixture = (): PersistedChatSession =>
  materializeSessionConversationGraph({
    id: 's',
    projectId: 'p',
    title: 'Research',
    cwd: '/workspace',
    status: 'idle',
    createdAt: 1,
    updatedAt: 5,
    messages: [
      {
        id: 'prompt',
        role: 'user',
        content: 'Research',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'response',
        role: 'agent',
        responseToMessageId: 'prompt',
        content: 'Result',
        status: 'complete',
        eventIds: [],
        createdAt: 2,
        updatedAt: 2
      }
    ]
  })
const outcomes: TurnOutcome[] = [
  { kind: 'completed', settledAt: 2 },
  { kind: 'failed', settledAt: 2, error: 'Bad input', errorReportable: false },
  {
    kind: 'failed',
    settledAt: 2,
    error: 'Publication failed',
    recovery: 'retry-artifact-publication'
  },
  { kind: 'cancelled', settledAt: 2, recovery: 'resume' },
  {
    kind: 'interrupted',
    settledAt: 2,
    cause: 'app-restart',
    recovery: 'resume',
    errorReportable: false
  },
  { kind: 'interrupted', settledAt: 2, cause: 'connection-lost', recovery: 'resume' }
]

describe('Turn Outcome persistence and legacy reads', () => {
  it.each(outcomes)(
    'round-trips $kind on the exact user node with the existing envelope version',
    (outcome) => {
      const session = setTurnOutcome(fixture(), 'prompt', outcome)
      const file = createSessionFile(session)
      const decoded = decodeSessionFile(JSON.parse(JSON.stringify(file)), {
        preserveRuntimeState: true
      })
      expect(decoded.status).toBe('ok')
      if (decoded.status !== 'ok') throw new Error('Expected Session decode')
      expect(decoded.session.messages[0].turnOutcome).toEqual(outcome)
      expect(decoded.session.conversationGraph?.messages[0].turnOutcome).toEqual(outcome)
      expect(fixture().messages[0].turnOutcome).toBeUndefined()
      expect(
        sanitizeMessage({ ...session.messages[1], turnOutcome: outcome })?.turnOutcome
      ).toBeUndefined()
    }
  )

  it.each([
    { kind: 'completed', settledAt: NaN },
    { kind: 'completed', settledAt: -1 },
    { kind: 'unknown', settledAt: 1 },
    { kind: 'failed', settledAt: 1, error: 4 },
    { kind: 'cancelled', settledAt: 1 },
    { kind: 'interrupted', settledAt: 1, cause: 'other', recovery: 'resume' },
    {
      kind: 'interrupted',
      settledAt: 1,
      cause: 'app-restart',
      recovery: 'resume',
      errorReportable: true
    },
    { kind: 'interrupted', settledAt: 1, cause: 'terminal-commit-failed', recovery: 'resume' }
  ])('rejects malformed or live-only JSON %#', (value) =>
    expect(sanitizeTurnOutcome(value)).toBeUndefined()
  )

  it.each(['completed', 'failed', 'cancelled', 'interrupted'] as const)(
    'synthesizes only latest legacy %s without backfilling',
    (kind) => {
      const session = fixture()
      if (kind === 'failed')
        Object.assign(session, { status: 'error', error: 'Failure', errorReportable: true })
      if (kind === 'cancelled' || kind === 'interrupted')
        session.resumeRecovery = {
          kind: 'resume-required',
          cause: kind === 'cancelled' ? 'cancelled' : 'app-restart',
          promptMessageId: 'prompt'
        }
      const before = JSON.stringify(session)
      expect(resolveTurnOutcome(session, 'prompt')?.kind).toBe(kind)
      expect(JSON.stringify(session)).toBe(before)
      const rewritten = JSON.parse(before)
      for (const message of [...rewritten.messages, ...rewritten.conversationGraph.messages])
        delete message.turnOutcome
      expect(resolveTurnOutcome(rewritten, 'prompt')?.kind).toBe(kind)
    }
  )

  it.each(['cancelled', 'connection-lost', 'app-restart'] as const)(
    'does not borrow %s session recovery for a different message',
    (cause) => {
      const session = fixture()
      session.status = 'error'
      session.error = 'Feedback execution interrupted'
      session.resumeRecovery = {
        kind: 'resume-required',
        promptMessageId: 'feedback',
        cause
      }
      expect(resolveTurnOutcome(session, 'prompt')).toBeUndefined()
      session.resumeRecovery = { kind: 'resume-required', cause }
      expect(resolveTurnOutcome(session, 'prompt')).toBeUndefined()
    }
  )

  it.each(outcomes)('keeps routed user messages inside their owning $kind turn', (outcome) => {
    for (const withGraph of [false, true]) {
      const original = fixture()
      const messages = [
        ...original.messages,
        ...['steering-1', 'steering-2'].map((id, index) => ({
          ...original.messages[0],
          id,
          content: 'Additional instruction',
          responseToMessageId: 'prompt',
          createdAt: 3 + index,
          updatedAt: 3 + index
        }))
      ]
      let session: PersistedChatSession = {
        ...original,
        conversationGraph: undefined,
        messages,
        ...legacySessionStateForOutcome(outcome, 'prompt')
      }
      if (withGraph) session = materializeSessionConversationGraph(session)
      session = setTurnOutcome(session, 'prompt', outcome)
      expect(latestOutcomePrompt(session)?.id).toBe('prompt')
      expect(resolveTurnOutcome(session, 'steering-2')).toBeUndefined()
      expect(deriveSessionAttention(session)?.turn?.promptMessageId).toBe(
        outcome.kind === 'failed' || outcome.kind === 'interrupted' ? 'prompt' : undefined
      )
      const legacy = setTurnOutcome(session, 'prompt', undefined)
      expect(resolveTurnOutcome(legacy, 'prompt')?.kind).toBe(outcome.kind)
      expect(resolveTurnOutcome(legacy, 'steering-2')).toBeUndefined()
    }
  })

  it('assigns legacy hidden-control failure to the hidden anchor and preserves application attribution', () => {
    const session = fixture()
    const hidden = { ...session.messages[0], id: 'hidden', turnIntent: 'save-as-skill' as const }
    session.messages.push(hidden)
    delete session.conversationGraph
    session.status = 'error'
    session.error = 'Hidden operation failed'
    expect(resolveTurnOutcome(session, 'prompt')).toBeUndefined()
    expect(resolveTurnOutcome(session, 'hidden')?.kind).toBe('failed')
    session.messages.push({
      ...hidden,
      id: 'app',
      turnIntent: undefined,
      attribution: {
        kind: 'application',
        feature: 'reviewer',
        purpose: 'correction',
        causeReviewId: 'review'
      }
    })
    expect(resolveTurnOutcome(session, 'hidden')).toBeUndefined()
    expect(resolveTurnOutcome(session, 'app')?.kind).toBe('failed')
    session.messages.push({
      ...hidden,
      id: 'relay',
      relayedFrom: { kind: 'side-chat', direction: 'to-main' }
    })
    expect(resolveTurnOutcome(session, 'app')?.kind).toBe('failed')
  })

  it.each(['running', 'waiting-permission', 'waiting-for-user', 'waiting-plan-approval'] as const)(
    'does not invent an outcome for %s',
    (status) => {
      const session = fixture()
      session.status = status
      expect(resolveTurnOutcome(session, 'prompt')).toBeUndefined()
    }
  )

  it('keeps original outcomes after Branch switching and gives an edited turn its own fallback', () => {
    const failed = outcomes[1]
    const session = setTurnOutcome(fixture(), 'prompt', failed)
    const originalBranch = session.conversationGraph!.branches[0].id
    const forked = forkEditedConversationMessage(session.conversationGraph!, 'prompt', 'fork', 10)
    const fork = { ...session, conversationGraph: forked }
    expect(resolveTurnOutcome(fork, 'prompt')).toEqual(failed)
    fork.conversationGraph = activateConversationBranch(forked, originalBranch)
    expect(resolveTurnOutcome(fork, 'prompt')).toEqual(failed)
  })

  it('preserves old readers Resume for cancellation and keeps the terminal-commit-failed marker live-only', () => {
    expect(legacySessionStateForOutcome(outcomes[3], 'prompt')).toMatchObject({
      status: 'idle',
      resumeRecovery: { cause: 'cancelled', promptMessageId: 'prompt' }
    })
    expect(
      legacySessionStateForOutcome(
        { kind: 'interrupted', cause: 'terminal-commit-failed', settledAt: 2, recovery: 'resume' },
        'prompt'
      ).resumeRecovery?.cause
    ).toBe('connection-lost')
  })
})
