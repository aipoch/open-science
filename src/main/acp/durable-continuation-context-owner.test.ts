import { describe, expect, it, vi } from 'vitest'

import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatMessage, PersistedChatSession } from '../../shared/session-persistence'
import { AcpDurableContinuationContextOwner } from './durable-continuation-context-owner'

const message = (id: string, content: string): PersistedChatMessage => ({
  id,
  role: 'user',
  content,
  status: 'complete',
  eventIds: [],
  createdAt: 1,
  updatedAt: 1
})

describe('AcpDurableContinuationContextOwner', () => {
  it('rejects an originating prompt that is no longer on the active Message Branch', async () => {
    const inactivePrompt = message('prompt-inactive', 'Use the abandoned approach.')
    const activePrompt = message('prompt-active', 'Use the revised approach.')
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Branched task',
      cwd: '/workspace',
      status: 'waiting-permission',
      messages: [inactivePrompt, activePrompt],
      conversationGraph: createLinearConversationGraph({
        sessionId: 'pending-session',
        messages: [activePrompt],
        frameworkId: 'claude-code',
        createdAt: 1,
        updatedAt: 1
      }),
      createdAt: 1,
      updatedAt: 1
    }
    const owner = new AcpDurableContinuationContextOwner({
      loadSessionForContinuation: vi.fn(async () => structuredClone(session))
    })

    await expect(
      owner.prepare({
        projectId: 'project-1',
        sessionId: 'session-1',
        promptMessageId: 'prompt-inactive'
      })
    ).rejects.toThrow('active Message Branch')
  })
})
