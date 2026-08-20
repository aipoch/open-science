import type { ChatMessage, ChatSession, ToolActivity } from '@/stores/session-store'
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

const createActivity = (overrides: Partial<ToolActivity> = {}): ToolActivity => ({
  id: 'tool-1',
  kind: 'tool',
  title: 'Saved a file',
  status: 'completed',
  eventIds: ['tool-event-1'],
  sortIndex: 2,
  promptMessageId: 'prompt-1',
  createdAt: 1710000000200,
  updatedAt: 1710000000300,
  ...overrides
})

const loadAgentLoadingMessageModule = async (): Promise<{
  getAgentLoadingPhase: (
    session: ChatSession | undefined
  ) =>
    | 'hidden'
    | 'thinking'
    | 'interacting-with-tools'
    | 'waiting-for-approval'
    | 'waiting-for-response'
}> => import('./agent-loading-message')

describe('agent loading message state', () => {
  it('shows loading after the active prompt until agent text arrives', async () => {
    const { getAgentLoadingPhase } = await loadAgentLoadingMessageModule()
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

    expect(getAgentLoadingPhase(session)).toBe('thinking')
  })

  it('shows loading when the foreground runtime owns a request without a local active run', async () => {
    const { getAgentLoadingPhase } = await loadAgentLoadingMessageModule()
    const session = createSession({
      status: 'idle',
      activeRun: undefined,
      agentPromptInFlight: true,
      awaitingFirstAgentOutput: true,
      messages: [createMessage({ id: 'prompt-1' })]
    })

    expect(getAgentLoadingPhase(session)).toBe('thinking')
  })

  it('shows tool interaction while any current-run tool is active', async () => {
    const { getAgentLoadingPhase } = await loadAgentLoadingMessageModule()
    const session = createSession({
      awaitingFirstAgentOutput: true,
      activeRun: {
        promptMessageId: 'prompt-1',
        startedAt: 1710000000100
      },
      messages: [createMessage({ id: 'prompt-1', sortIndex: 1 })],
      activities: [
        createActivity({ id: 'tool-completed', status: 'completed', sortIndex: 2 }),
        createActivity({
          id: 'tool-running',
          status: 'in_progress',
          sortIndex: 3,
          updatedAt: 1710000000400
        })
      ]
    })

    expect(getAgentLoadingPhase(session)).toBe('interacting-with-tools')
  })

  it('shows runtime-owned tool interaction without a local run', async () => {
    const { getAgentLoadingPhase } = await loadAgentLoadingMessageModule()
    const session = createSession({
      status: 'idle',
      activeRun: undefined,
      agentPromptInFlight: true,
      awaitingFirstAgentOutput: true,
      messages: [createMessage({ id: 'prompt-1', sortIndex: 1 })],
      activities: [createActivity({ status: 'in_progress' })]
    })

    expect(getAgentLoadingPhase(session)).toBe('interacting-with-tools')
  })

  it('shows Notebook tool interaction while approval waiting remains a distinct phase', async () => {
    const { getAgentLoadingPhase } = await loadAgentLoadingMessageModule()
    const session = createSession({
      activeRun: {
        promptMessageId: 'prompt-1',
        startedAt: 1710000000100
      },
      messages: [createMessage({ id: 'prompt-1', sortIndex: 1 })],
      activities: [
        createActivity({
          status: 'in_progress',
          providerToolName: 'mcp__open-science-notebook__notebook_execute',
          rawInput: { code: 'print(1)' }
        })
      ]
    })

    expect(getAgentLoadingPhase(session)).toBe('interacting-with-tools')
    expect(
      getAgentLoadingPhase({
        ...session,
        status: 'waiting-permission',
        runtimeContext: {
          version: 1,
          revision: 1,
          permission: {
            state: 'pending',
            request: {
              requestId: 'permission-1',
              sessionId: 'session-1',
              toolCallId: 'tool-1',
              title: 'Run code',
              options: []
            },
            originatingPromptMessageId: 'prompt-1',
            fingerprint: 'fingerprint-1',
            createdAt: 1710000000400
          }
        }
      })
    ).toBe('waiting-for-approval')
  })

  it('ignores active tools from a historical run when no prompt is in flight', async () => {
    const { getAgentLoadingPhase } = await loadAgentLoadingMessageModule()
    const session = createSession({
      status: 'idle',
      activeRun: undefined,
      messages: [createMessage({ id: 'prompt-1', sortIndex: 1 })],
      activities: [createActivity({ status: 'in_progress' })]
    })

    expect(getAgentLoadingPhase(session)).toBe('hidden')
  })

  it('keeps loading while an active run has a partial agent response', async () => {
    const { getAgentLoadingPhase } = await loadAgentLoadingMessageModule()
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

    expect(getAgentLoadingPhase(session)).toBe('thinking')
  })

  it('keeps loading across a completed tool and later token while the run remains active', async () => {
    const { getAgentLoadingPhase } = await loadAgentLoadingMessageModule()
    const session = createSession({
      activeRun: {
        promptMessageId: 'prompt-1',
        startedAt: 1710000000100
      },
      messages: [
        createMessage({ id: 'prompt-1', sortIndex: 1 }),
        createMessage({
          id: 'reply-1',
          role: 'agent',
          content: 'I saved the file.',
          status: 'streaming',
          streamId: 'assistant-message-1',
          responseToMessageId: 'prompt-1',
          sortIndex: 3,
          createdAt: 1710000000250,
          updatedAt: 1710000000250
        })
      ],
      activities: [createActivity()]
    })

    expect(getAgentLoadingPhase(session)).toBe('thinking')
    expect(
      getAgentLoadingPhase({
        ...session,
        messages: session.messages.map((message) =>
          message.id === 'reply-1' ? { ...message, updatedAt: 1710000000400 } : message
        )
      })
    ).toBe('thinking')
  })

  it('keeps loading while an active run has an image-only agent response', async () => {
    const { getAgentLoadingPhase } = await loadAgentLoadingMessageModule()
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
          content: '',
          status: 'streaming',
          responseToMessageId: 'prompt-1',
          images: [{ id: 'event-image', mimeType: 'image/png', data: 'AQID', byteLength: 3 }]
        })
      ]
    })

    expect(getAgentLoadingPhase(session)).toBe('thinking')
  })

  it('ignores previous replies when a follow-up prompt starts a new run', async () => {
    const { getAgentLoadingPhase } = await loadAgentLoadingMessageModule()
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

    expect(getAgentLoadingPhase(session)).toBe('thinking')
  })

  it('keeps loading when an agent message after the active prompt belongs to an older run', async () => {
    const { getAgentLoadingPhase } = await loadAgentLoadingMessageModule()
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

    expect(getAgentLoadingPhase(session)).toBe('thinking')
  })

  it('keeps loading for empty agent placeholders and missing active prompts', async () => {
    const { getAgentLoadingPhase } = await loadAgentLoadingMessageModule()
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

    expect(getAgentLoadingPhase(session)).toBe('thinking')
    expect(
      getAgentLoadingPhase({
        ...session,
        activeRun: {
          promptMessageId: 'missing-prompt',
          startedAt: 1710000000100
        }
      })
    ).toBe('hidden')
  })

  it('shows an approval wait during permission requests and hides it without a current run', async () => {
    const { getAgentLoadingPhase } = await loadAgentLoadingMessageModule()
    const runningSession = createSession({
      activeRun: {
        promptMessageId: 'prompt-1',
        startedAt: 1710000000100
      },
      messages: [createMessage({ id: 'prompt-1' })]
    })

    // Permission is a distinct user wait even when the provider has not emitted a tool row yet.
    expect(
      getAgentLoadingPhase({
        ...runningSession,
        status: 'waiting-permission'
      })
    ).toBe('waiting-for-approval')
    expect(
      getAgentLoadingPhase({
        ...runningSession,
        status: 'running',
        activeRun: undefined
      })
    ).toBe('hidden')
  })

  it('keeps the approval wait visible after agent content arrives', async () => {
    const { getAgentLoadingPhase } = await loadAgentLoadingMessageModule()

    // A permission pause takes over from body output until the user answers it.
    expect(
      getAgentLoadingPhase(
        createSession({
          status: 'waiting-permission',
          activeRun: {
            promptMessageId: 'prompt-1',
            startedAt: 1710000000100
          },
          messages: [
            createMessage({ id: 'prompt-1' }),
            createMessage({
              id: 'reply-1',
              role: 'agent',
              content: "I'll inspect the files",
              status: 'streaming',
              streamId: 'stream-1',
              responseToMessageId: 'prompt-1'
            })
          ]
        })
      )
    ).toBe('waiting-for-approval')
  })

  it.each([
    ['waiting-for-user', 'waiting-for-response'],
    ['waiting-plan-approval', 'waiting-for-approval']
  ] as const)(
    'shows the user wait for a pending %s session after the agent turn ends',
    async (status, phase) => {
      const { getAgentLoadingPhase } = await loadAgentLoadingMessageModule()

      expect(
        getAgentLoadingPhase(
          createSession({
            status,
            activeRun: undefined,
            agentPromptInFlight: false,
            messages: [createMessage({ id: 'prompt-1' })]
          })
        )
      ).toBe(phase)
    }
  )
})
