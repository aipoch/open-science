import type { ChatMessage, ChatSession } from '@/stores/session-store'
import { describe, expect, it } from 'vitest'

const createMessage = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: 'message-1',
  role: 'user',
  content: 'Prompt',
  status: 'complete',
  eventIds: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

const createSession = (overrides: Partial<ChatSession>): ChatSession => ({
  id: 'session-1',
  projectId: 'default',
  title: 'Session',
  cwd: '/workspace',
  status: 'running',
  messages: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

const loadAgentLoadingMessageModule = async (): Promise<{
  shouldShowAgentLoadingMessage: (session: ChatSession | undefined) => boolean
}> => import('./agent-loading-message')

describe('agent loading message state', () => {
  it('shows loading after the active prompt until agent text arrives', async () => {
    const { shouldShowAgentLoadingMessage } = await loadAgentLoadingMessageModule()
    const session = createSession({
      activeRun: {
        promptMessageId: 'prompt-1',
        startedAt: 1710000000100
      },
      messages: [
        createMessage({
          id: 'prompt-1',
          role: 'user',
          content: 'Summarize this'
        })
      ]
    })

    expect(shouldShowAgentLoadingMessage(session)).toBe(true)
  })

  it('hides loading once the active prompt has an agent response', async () => {
    const { shouldShowAgentLoadingMessage } = await loadAgentLoadingMessageModule()
    const session = createSession({
      activeRun: {
        promptMessageId: 'prompt-1',
        startedAt: 1710000000100
      },
      messages: [
        createMessage({
          id: 'prompt-1',
          role: 'user',
          content: 'Summarize this'
        }),
        createMessage({
          id: 'reply-1',
          role: 'agent',
          content: 'I found three points.',
          status: 'streaming',
          streamId: 'assistant-message-1',
          responseToMessageId: 'prompt-1'
        })
      ]
    })

    expect(shouldShowAgentLoadingMessage(session)).toBe(false)
  })

  it('ignores previous replies when a follow-up prompt starts a new run', async () => {
    const { shouldShowAgentLoadingMessage } = await loadAgentLoadingMessageModule()
    const session = createSession({
      activeRun: {
        promptMessageId: 'prompt-2',
        startedAt: 1710000000300
      },
      messages: [
        createMessage({
          id: 'prompt-1',
          role: 'user',
          content: 'Summarize this'
        }),
        createMessage({
          id: 'reply-1',
          role: 'agent',
          content: 'First answer.',
          status: 'complete',
          streamId: 'assistant-message-1',
          responseToMessageId: 'prompt-1'
        }),
        createMessage({
          id: 'prompt-2',
          role: 'user',
          content: 'Add citations'
        })
      ]
    })

    expect(shouldShowAgentLoadingMessage(session)).toBe(true)
  })

  it('keeps loading when an agent message after the active prompt belongs to an older run', async () => {
    const { shouldShowAgentLoadingMessage } = await loadAgentLoadingMessageModule()
    const session = createSession({
      activeRun: {
        promptMessageId: 'prompt-2',
        startedAt: 1710000000300
      },
      messages: [
        createMessage({
          id: 'prompt-1',
          role: 'user',
          content: 'Summarize this'
        }),
        createMessage({
          id: 'prompt-2',
          role: 'user',
          content: 'Add citations'
        }),
        createMessage({
          id: 'stale-reply-1',
          role: 'agent',
          content: 'Late chunk from the old run.',
          status: 'streaming',
          streamId: 'assistant-message-1',
          responseToMessageId: 'prompt-1'
        })
      ]
    })

    expect(shouldShowAgentLoadingMessage(session)).toBe(true)
  })

  it('keeps loading for empty agent placeholders and missing active prompts', async () => {
    const { shouldShowAgentLoadingMessage } = await loadAgentLoadingMessageModule()
    const session = createSession({
      activeRun: {
        promptMessageId: 'prompt-1',
        startedAt: 1710000000100
      },
      messages: [
        createMessage({ id: 'prompt-1' }),
        createMessage({
          id: 'reply-1',
          role: 'agent',
          content: '   ',
          status: 'streaming',
          streamId: 'assistant-message-1',
          responseToMessageId: 'prompt-1'
        })
      ]
    })

    expect(shouldShowAgentLoadingMessage(session)).toBe(true)
    expect(
      shouldShowAgentLoadingMessage({
        ...session,
        activeRun: {
          promptMessageId: 'missing-prompt',
          startedAt: 1710000000100
        }
      })
    ).toBe(false)
  })

  it('does not show loading for permission waits or sessions without an active run', async () => {
    const { shouldShowAgentLoadingMessage } = await loadAgentLoadingMessageModule()
    const runningSession = createSession({
      activeRun: {
        promptMessageId: 'prompt-1',
        startedAt: 1710000000100
      },
      messages: [createMessage({ id: 'prompt-1' })]
    })

    expect(
      shouldShowAgentLoadingMessage({
        ...runningSession,
        status: 'waiting-permission'
      })
    ).toBe(false)
    expect(
      shouldShowAgentLoadingMessage({
        ...runningSession,
        status: 'running',
        activeRun: undefined
      })
    ).toBe(false)
  })
})
