import { describe, expect, it } from 'vitest'

import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { buildAgentResultContinuationPrompt, hasSavedAgentResultContinuation } from './continuation'

const request = { continuationMessageId: 'continuation-1', deliveryIds: ['local-run:run-1'] }
const prompt = {
  id: 'continuation-1',
  role: 'user' as const,
  status: 'complete',
  attribution: {
    kind: 'application',
    feature: 'background-results',
    purpose: 'agent-result-delivery',
    deliveryKey: 'agent-result-delivery:continuation-1',
    deliveryIds: ['local-run:run-1']
  }
}
const reply = {
  id: 'reply-1',
  role: 'agent' as const,
  status: 'complete',
  responseToMessageId: 'continuation-1'
}

describe('hasSavedAgentResultContinuation', () => {
  it('requires both the exact durable attribution and its completed Agent reply', () => {
    expect(hasSavedAgentResultContinuation([prompt, reply], request)).toBe(true)
    expect(hasSavedAgentResultContinuation([reply], request)).toBe(false)
    expect(hasSavedAgentResultContinuation([prompt], request)).toBe(false)
    expect(
      hasSavedAgentResultContinuation(
        [{ ...prompt, attribution: { ...prompt.attribution, deliveryIds: ['other'] } }, reply],
        request
      )
    ).toBe(false)
  })

  it('matches a batch as a set rather than depending on row order', () => {
    expect(
      hasSavedAgentResultContinuation(
        [
          {
            ...prompt,
            attribution: {
              ...prompt.attribution,
              deliveryIds: ['local-run:run-2', 'local-run:run-1']
            }
          },
          reply
        ],
        { ...request, deliveryIds: ['local-run:run-1', 'local-run:run-2'] }
      )
    ).toBe(true)
  })
})

describe('buildAgentResultContinuationPrompt', () => {
  it('preserves active conversation ancestry for the delivery turn', () => {
    const messages: PersistedChatSession['messages'] = [
      {
        id: 'original-prompt',
        role: 'user',
        content: 'Run it.',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'original-reply',
        role: 'agent',
        content: 'Submitted.',
        status: 'complete',
        responseToMessageId: 'original-prompt',
        eventIds: [],
        createdAt: 2,
        updatedAt: 2
      }
    ]
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Background analysis',
      cwd: '/workspace',
      status: 'idle',
      messages,
      conversationGraph: createLinearConversationGraph({
        sessionId: 'session-1',
        messages,
        frameworkId: 'opencode',
        providerId: 'provider-1',
        model: 'model-1',
        createdAt: 1,
        updatedAt: 2
      }),
      createdAt: 1,
      updatedAt: 2
    }
    expect(
      buildAgentResultContinuationPrompt(session, {
        sessionId: 'session-1',
        text: 'Outcomes available.',
        continuationMessageId: 'delivery-prompt'
      }).provenanceContext
    ).toMatchObject({
      promptMessageId: 'delivery-prompt',
      runtimeSegmentId: 'runtime-segment-session-1'
    })
  })
})
