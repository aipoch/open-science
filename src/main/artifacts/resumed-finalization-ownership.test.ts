import { describe, expect, it } from 'vitest'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { validateDurableMessageOwnership } from './provenance-message-finalization'

// Minimal topology from the supplied v0.30 evidence: one prompt, one branch,
// a replacement provider Segment, and a finalization claim from that replacement.
// No report contents, credentials, or user data are required to reproduce the rejection.
const fixture = (
  resumed: boolean,
  correctedResponse: boolean
): {
  session: PersistedChatSession
  context: Parameters<typeof validateDurableMessageOwnership>[1]
} => {
  const messages: PersistedChatSession['messages'] = [
    {
      id: 'prompt',
      role: 'user',
      content: 'Analyze',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'answer',
      role: 'agent',
      content: 'Done',
      status: 'complete',
      eventIds: [],
      createdAt: 3,
      updatedAt: 3
    }
  ]
  const graph = createLinearConversationGraph({
    sessionId: 'session',
    messages,
    frameworkId: 'codex',
    createdAt: 1,
    updatedAt: 3
  })
  const original = graph.runtimeSegments[0]
  if (resumed) {
    original.endedAt = 2
    graph.runtimeSegments.push({
      id: 'resumed-segment',
      agentFrameId: graph.rootFrameId,
      frameworkId: 'codex',
      startedAt: 2
    })
    if (correctedResponse)
      graph.messages.find(({ id }) => id === 'answer')!.runtimeSegmentId = 'resumed-segment'
  }
  const session: PersistedChatSession = {
    id: 'session',
    projectId: 'project',
    title: 'Resume',
    cwd: '/workspace',
    status: 'idle',
    messages,
    conversationGraph: graph,
    createdAt: 1,
    updatedAt: 3
  }
  const context: Parameters<typeof validateDurableMessageOwnership>[1] = {
    rootFrameId: graph.rootFrameId,
    agentFrameId: graph.rootFrameId,
    messageBranchId: graph.branches[0].id,
    promptMessageId: 'prompt',
    messageId: 'answer',
    runtimeSegmentId: resumed ? 'resumed-segment' : original.id
  }
  return { session, context }
}

describe('resumed Artifact finalization ownership', () => {
  it('accepts the same-segment control', () => {
    const { session, context } = fixture(false, false)
    expect(() => validateDurableMessageOwnership(session, context)).not.toThrow()
  })

  it.each([false, true])(
    'reproduces prompt mismatch even with corrected response Segment: %s',
    (correctedResponse) => {
      const { session, context } = fixture(true, correctedResponse)
      expect(() => validateDurableMessageOwnership(session, context)).toThrow(
        expect.objectContaining({ reasonCode: 'prompt-ownership-mismatch' })
      )
    }
  )

  it('accepts a resumed output using its durable Main admission', () => {
    const { session, context } = fixture(true, true)
    session.runtimeTranscriptOwner = 'main'
    session.runtimeSessionAdmissions = [
      {
        executionId: 'resumed-execution',
        ...context,
        promptRuntimeSegmentId: session.conversationGraph!.runtimeSegments[0].id
      }
    ]
    expect(() => validateDurableMessageOwnership(session, context)).not.toThrow()
  })

  it.each([
    'rootFrameId',
    'agentFrameId',
    'messageBranchId',
    'promptMessageId',
    'promptRuntimeSegmentId',
    'runtimeSegmentId'
  ] as const)('rejects an admission belonging to another %s', (field) => {
    const { session, context } = fixture(true, true)
    session.runtimeTranscriptOwner = 'main'
    session.runtimeSessionAdmissions = [
      {
        executionId: 'resumed-execution',
        ...context,
        promptRuntimeSegmentId: session.conversationGraph!.runtimeSegments[0].id,
        [field]: 'unrelated'
      }
    ]
    expect(() => validateDurableMessageOwnership(session, context)).toThrow(
      expect.objectContaining({ reasonCode: 'prompt-ownership-mismatch' })
    )
  })

  it('does not transfer an old answer to a new execution even with valid prompt admission', () => {
    const { session, context } = fixture(true, false)
    session.runtimeTranscriptOwner = 'main'
    session.runtimeSessionAdmissions = [
      {
        executionId: 'resumed-execution',
        ...context,
        promptRuntimeSegmentId: session.conversationGraph!.runtimeSegments[0].id
      }
    ]
    expect(() => validateDurableMessageOwnership(session, context)).toThrow(
      expect.objectContaining({ reasonCode: 'message-ownership-mismatch' })
    )
  })
})
