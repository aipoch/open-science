import { describe, expect, it, vi } from 'vitest'

import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type {
  PersistedChatMessage,
  PersistedChatSession,
  PersistedToolActivity
} from '../../shared/session-persistence'
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

const createSession = (
  messages: PersistedChatMessage[],
  graphMessages = messages
): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Restored task',
  cwd: '/workspace',
  status: 'waiting-for-user',
  messages,
  conversationGraph: createLinearConversationGraph({
    sessionId: 'pending-session',
    messages: graphMessages,
    frameworkId: 'claude-code',
    createdAt: 1,
    updatedAt: 1
  }),
  createdAt: 1,
  updatedAt: 1
})

const pendingChoice = (overrides: Partial<PersistedToolActivity> = {}): PersistedToolActivity => ({
  id: 'tool-choice-1',
  kind: 'tool',
  title: 'Choose an approach',
  status: 'in_progress',
  sortIndex: 0,
  eventIds: [],
  promptMessageId: 'prompt-active',
  elicitation: {
    message: 'Choose an approach',
    fields: [{ id: 'question_0', label: 'Approach', kind: 'text' }],
    state: 'pending',
    durable: {
      kind: 'agent-user-choice',
      requestId: 'choice-1',
      promptMessageId: 'prompt-active'
    }
  },
  createdAt: 2,
  updatedAt: 2,
  ...overrides
})

const createOwner = (session: PersistedChatSession): AcpDurableContinuationContextOwner =>
  new AcpDurableContinuationContextOwner({
    loadSessionForContinuation: vi.fn(async () => structuredClone(session))
  })

describe('AcpDurableContinuationContextOwner', () => {
  it('rejects an originating prompt that is no longer on the active Message Branch', async () => {
    const inactivePrompt = message('prompt-inactive', 'Use the abandoned approach.')
    const activePrompt = message('prompt-active', 'Use the revised approach.')
    const owner = createOwner(createSession([inactivePrompt, activePrompt], [activePrompt]))

    await expect(
      owner.prepare({
        projectId: 'project-1',
        sessionId: 'session-1',
        promptMessageId: 'prompt-inactive'
      })
    ).rejects.toThrow('active Message Branch')
  })

  it('rejects an inherited prompt that was introduced on an ancestor Branch', async () => {
    const prompt = message('prompt-active', 'Choose an approach.')
    const session = createSession([prompt])
    const graph = session.conversationGraph!
    const frame = graph.frames[0]
    const parentBranch = graph.branches[0]
    graph.branches.push({
      id: 'message-branch-revised-choice',
      agentFrameId: frame.id,
      parentBranchId: parentBranch.id,
      forkMessageId: prompt.id,
      headMessageId: prompt.id,
      createdAt: 2,
      updatedAt: 2
    })
    frame.activeBranchId = 'message-branch-revised-choice'

    await expect(
      createOwner(session).prepare({
        projectId: 'project-1',
        sessionId: 'session-1',
        promptMessageId: prompt.id
      })
    ).rejects.toThrow('active Message Branch')
  })

  it('restores an elicitation from the canonical pending Session activity', async () => {
    const session = createSession([message('prompt-active', 'Choose an approach.')])
    session.activities = [pendingChoice()]

    await expect(
      createOwner(session).prepareElicitation({
        projectId: 'project-1',
        sessionId: 'session-1',
        requestId: 'choice-1',
        toolCallId: 'tool-choice-1'
      })
    ).resolves.toMatchObject({
      request: {
        requestId: 'choice-1',
        sessionId: 'session-1',
        toolCallId: 'tool-choice-1',
        message: 'Choose an approach',
        fields: [{ id: 'question_0', label: 'Approach', kind: 'text' }],
        durable: { promptMessageId: 'prompt-active' }
      },
      provenanceContext: {
        rootFrameId: 'root-frame-pending-session',
        messageBranchId: 'message-branch-pending-session',
        promptMessageId: 'prompt-active'
      }
    })
  })

  it.each([
    ['missing', []],
    [
      'stale',
      [
        pendingChoice({
          elicitation: {
            ...pendingChoice().elicitation!,
            durable: {
              kind: 'agent-user-choice',
              requestId: 'choice-newer',
              promptMessageId: 'prompt-active'
            }
          }
        })
      ]
    ],
    ['duplicated', [pendingChoice(), pendingChoice()]]
  ] as const)('rejects a %s durable elicitation correlation', async (_case, activities) => {
    const session = createSession([message('prompt-active', 'Choose an approach.')])
    session.activities = structuredClone([...activities])

    await expect(
      createOwner(session).prepareElicitation({
        projectId: 'project-1',
        sessionId: 'session-1',
        requestId: 'choice-1',
        toolCallId: 'tool-choice-1'
      })
    ).rejects.toThrow('pending Session activity')
  })
})
