// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import type { AcpPromptRequest, AcpStateSnapshot } from '../../../../../shared/acp'
import {
  forkEditedConversationMessage,
  resolveActiveConversationMessages
} from '../../../../../shared/conversation-graph'
import { continueInterruptedTurn } from '../../../../../main/acp/interrupted-turn-continuation'
import { hydrateSession } from '@/stores/session-store-persistence-owner'
import {
  latestOutcomePrompt,
  legacySessionStateForOutcome,
  materializeSessionConversationGraph,
  resolveTurnOutcome,
  setTurnOutcome,
  type PersistedChatSession,
  type TurnOutcome
} from '../../../../../shared/session-persistence'
import { resolveCurrentTurnOutcomeItem } from '../workspace-conversation-timeline'
import { resolveSessionRecoveryPresentation } from '../workspace-session-recovery'

// Synthetic reproduction of dev #1047: a routed Plan feedback Message was independently
// admitted by Main, then manually stopped. Ordinary unadmitted steering must stay a reply.
const fixture = (): PersistedChatSession => {
  const session = materializeSessionConversationGraph({
    id: 'feedback-session',
    projectId: 'project',
    title: 'Plan feedback recovery reproduction',
    cwd: '/workspace',
    status: 'idle',
    runtimeTranscriptOwner: 'main',
    createdAt: 1,
    updatedAt: 4,
    error: 'This turn was interrupted. Resume to continue.',
    resumeRecovery: { kind: 'resume-required', promptMessageId: 'feedback', cause: 'cancelled' },
    runtimeTranscriptLastRun: { promptMessageId: 'feedback', startedAt: 3 },
    messages: [
      {
        id: 'original',
        role: 'user',
        content: 'Demonstrate a plan',
        status: 'complete',
        eventIds: [],
        interrupted: true,
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'feedback',
        role: 'user',
        content: 'Write it in English',
        status: 'complete',
        eventIds: [],
        responseToMessageId: 'original',
        interrupted: true,
        turnOutcome: { kind: 'cancelled', settledAt: 4, recovery: 'resume' },
        createdAt: 2,
        updatedAt: 2
      }
    ]
  })
  const graph = session.conversationGraph!
  session.runtimeSessionAdmissions = ['original', 'feedback'].map((promptMessageId) => ({
    executionId: `execution-${promptMessageId}`,
    promptMessageId,
    promptRuntimeSegmentId: graph.runtimeSegments[0].id,
    rootFrameId: graph.rootFrameId,
    agentFrameId: graph.rootFrameId,
    messageBranchId: graph.branches[0].id,
    runtimeSegmentId: graph.runtimeSegments[0].id
  }))
  return session
}

function graphOnlyRecoveryFixture(
  cause: Extract<TurnOutcome, { kind: 'interrupted' }>['cause']
): PersistedChatSession {
  const outcome: TurnOutcome = {
    kind: 'interrupted',
    cause,
    settledAt: 4,
    error: 'Diagnostic retained only on the recovery message.',
    recovery: 'resume'
  }
  const source = setTurnOutcome(fixture(), 'feedback', outcome)
  const graph = forkEditedConversationMessage(
    source.conversationGraph!,
    'feedback',
    'selected-branch',
    5
  )
  return {
    ...source,
    ...legacySessionStateForOutcome(outcome, 'feedback'),
    error: undefined,
    conversationGraph: graph,
    messages: resolveActiveConversationMessages(graph)
  }
}

describe('Session Plan feedback recovery', () => {
  it('does not attribute feedback recovery to the original prompt', () => {
    expect(resolveTurnOutcome(fixture(), 'original')).toBeUndefined()
    expect(resolveTurnOutcome(fixture(), 'feedback')?.kind).toBe('cancelled')
  })

  it('presents session recovery independently of the latest turn anchor', () => {
    const session = hydrateSession(fixture())
    expect(latestOutcomePrompt(session)?.id).toBe('original')
    expect(resolveCurrentTurnOutcomeItem(session)).toBeUndefined()
    expect(resolveSessionRecoveryPresentation(session)).toEqual({
      cause: 'cancelled',
      error: 'This turn was interrupted. Resume to continue.'
    })
  })

  it.each(['connection-lost', 'app-restart'] as const)(
    'retains %s recovery and its diagnostic when the selected branch hides the target',
    (cause) => {
      const session = hydrateSession(graphOnlyRecoveryFixture(cause))
      expect(session.messages.map(({ id }) => id)).toEqual(['original'])
      expect(session.conversationGraph?.messages.map(({ id }) => id)).toContain('feedback')
      expect(session.error).toBeUndefined()
      expect(resolveCurrentTurnOutcomeItem(session)).toBeUndefined()
      expect(resolveSessionRecoveryPresentation(session)).toEqual({
        cause,
        error: 'Diagnostic retained only on the recovery message.'
      })
    }
  )

  it('suppresses local recovery when a graph-only target has a terminal commit failure', () => {
    const session = hydrateSession(graphOnlyRecoveryFixture('terminal-commit-failed'))
    expect(session.messages.map(({ id }) => id)).toEqual(['original'])
    expect(resolveTurnOutcome(session, 'feedback')).toMatchObject({
      kind: 'interrupted',
      cause: 'terminal-commit-failed'
    })
    expect(session.resumeRecovery).toMatchObject({ promptMessageId: 'feedback' })
    expect(resolveSessionRecoveryPresentation(session)).toBeUndefined()
  })

  it('keeps an unadmitted routed reply inside the original turn', () => {
    const session = fixture()
    session.runtimeSessionAdmissions = session.runtimeSessionAdmissions!.filter(
      ({ promptMessageId }) => promptMessageId !== 'feedback'
    )
    session.runtimeTranscriptLastRun = undefined
    session.resumeRecovery = undefined
    session.error = undefined
    session.messages[1].turnOutcome = undefined
    session.conversationGraph!.messages[1].turnOutcome = undefined
    expect(latestOutcomePrompt(session)?.id).toBe('original')
    expect(resolveCurrentTurnOutcomeItem(hydrateSession(session))).toBeUndefined()
  })

  it('can dispatch the exact feedback recovery through the existing Main continuation API', async () => {
    const session = fixture()
    const snapshot: AcpStateSnapshot = {
      status: 'connected',
      cwd: '/workspace',
      sessionIds: [session.id],
      events: [],
      pendingPermissions: [],
      permissionProfiles: {},
      permissionGrants: {},
      contextUsageBySession: {},
      promptInFlight: false,
      promptInFlightSessionIds: [],
      agentPromptInFlightSessionIds: []
    }
    const startContinuation = vi.fn<(request: AcpPromptRequest) => Promise<void>>(async () => {})
    await continueInterruptedTurn(
      {
        runtime: {
          getState: () => snapshot,
          getLatestUserPrompt: () => undefined,
          startContinuation
        },
        loadSession: async () => structuredClone(session)
      },
      { projectId: session.projectId, sessionId: session.id, promptMessageId: 'feedback' }
    )
    expect(startContinuation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        suppressUserMessage: true,
        text: expect.stringContaining('Write it in English'),
        provenanceContext: expect.objectContaining({ promptMessageId: 'feedback' })
      })
    )
  })
})
