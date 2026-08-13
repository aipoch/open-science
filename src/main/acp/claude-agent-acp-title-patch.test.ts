import type { Query, SDKMessage, SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import type { Logger } from '@agentclientprotocol/claude-agent-acp/dist/acp-agent.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ClaudeAcpAgent } from '@agentclientprotocol/claude-agent-acp/dist/acp-agent.js'

class QueryStream {
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this
  }

  private readonly messages: SDKMessage[] = []
  private readonly readers: Array<(result: IteratorResult<SDKMessage>) => void> = []

  initializationResult = vi.fn().mockResolvedValue({
    account: {},
    models: [
      {
        value: 'claude-sonnet-4-5',
        displayName: 'Claude Sonnet 4.5',
        description: ''
      }
    ]
  })
  supportedAgents = vi.fn().mockResolvedValue([])
  supportedCommands = vi.fn().mockResolvedValue([])
  interrupt = vi.fn().mockResolvedValue(undefined)
  close = vi.fn()

  get pendingReaderCount(): number {
    return this.readers.length
  }

  next(): Promise<IteratorResult<SDKMessage>> {
    const message = this.messages.shift()
    if (message) return Promise.resolve({ done: false, value: message })
    return new Promise((resolve) => this.readers.push(resolve))
  }

  push(message: SDKMessage): void {
    const reader = this.readers.shift()
    if (reader) reader({ done: false, value: message })
    else this.messages.push(message)
  }
}

const sessionState = (sessionId: string, state: 'idle'): SDKMessage =>
  ({
    type: 'system',
    subtype: 'session_state_changed',
    state,
    uuid: '00000000-0000-4000-8000-000000000002',
    session_id: sessionId
  }) as unknown as SDKMessage

const resultMessage = (sessionId: string): SDKMessage =>
  ({
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: 'Done',
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    },
    modelUsage: {},
    permission_denials: [],
    uuid: '00000000-0000-4000-8000-000000000001',
    session_id: sessionId
  }) as unknown as SDKMessage

describe('claude-agent-acp framework-native session titles', () => {
  const getSessionInfo = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  const setup = async (
    info: SDKSessionInfo | undefined,
    preserveMock = false,
    logger?: Logger
  ): Promise<{
    agent: ClaudeAcpAgent
    query: QueryStream
    sessionId: string
    sessionUpdate: ReturnType<typeof vi.fn>
  }> => {
    const query = new QueryStream()
    if (!preserveMock) getSessionInfo.mockResolvedValue(info)
    const sessionUpdate = vi.fn().mockResolvedValue(undefined)
    const agent = new ClaudeAcpAgent({ sessionUpdate } as never, logger, {
      query: vi.fn().mockReturnValue(query as unknown as Query),
      getSessionInfo
    } as never)
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} })
    const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(agent.sessions[sessionId].query).toBe(query)
    return { agent, query, sessionId, sessionUpdate }
  }

  const runPrompt = async (
    agent: ClaudeAcpAgent,
    query: QueryStream,
    sessionId: string
  ): Promise<void> => {
    const prompt = agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '用 python 统计系统信息，产出 1 个简单的 markdown 报告' }]
    })
    await vi.waitFor(() => expect(query.pendingReaderCount).toBe(1))
    query.push(resultMessage(sessionId))
    await expect(prompt).resolves.toMatchObject({ stopReason: 'end_turn' })
  }

  it('publishes an SDK title before a terminal result settles, without waiting for idle', async () => {
    const { agent, query, sessionId, sessionUpdate } = await setup({
      sessionId: 'unused-by-adapter',
      summary: 'Generate system info markdown report',
      customTitle: 'Generate system info markdown report',
      firstPrompt: '用 python 统计系统信息，产出 1 个简单的 markdown 报告',
      lastModified: 1
    })

    await runPrompt(agent, query, sessionId)
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId,
      update: {
        sessionUpdate: 'session_info_update',
        title: 'Generate system info markdown report',
        updatedAt: new Date(1).toISOString()
      }
    })
  })

  it('does not publish summary when it is only the first-prompt fallback', async () => {
    const firstPrompt = '你的身份是什么'
    const { agent, query, sessionId, sessionUpdate } = await setup({
      sessionId: 'unused-by-adapter',
      summary: firstPrompt,
      firstPrompt,
      lastModified: 1
    })

    await runPrompt(agent, query, sessionId)
    query.push(sessionState(sessionId, 'idle'))
    await vi.waitFor(() => expect(getSessionInfo).toHaveBeenCalledTimes(2))

    expect(sessionUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ sessionUpdate: 'session_info_update' })
      })
    )
  })

  it('retries at idle when the SDK persists its title after the result', async () => {
    const firstPrompt = '你的身份是什么'
    getSessionInfo
      .mockResolvedValueOnce({
        sessionId: 'unused-by-adapter',
        summary: firstPrompt,
        firstPrompt,
        lastModified: 1
      } satisfies SDKSessionInfo)
      .mockResolvedValueOnce({
        sessionId: 'unused-by-adapter',
        summary: 'Explain assistant identity',
        customTitle: 'Explain assistant identity',
        firstPrompt,
        lastModified: 2
      } satisfies SDKSessionInfo)
    const { agent, query, sessionId, sessionUpdate } = await setup(undefined, true)

    await runPrompt(agent, query, sessionId)
    query.push(sessionState(sessionId, 'idle'))
    await vi.waitFor(() =>
      expect(sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'session_info_update',
            title: 'Explain assistant identity'
          })
        })
      )
    )
  })

  it('does not publish the same title again at idle', async () => {
    const info = {
      sessionId: 'unused-by-adapter',
      summary: 'Explain assistant identity',
      customTitle: 'Explain assistant identity',
      firstPrompt: '你的身份是什么',
      lastModified: 2
    } satisfies SDKSessionInfo
    const { agent, query, sessionId, sessionUpdate } = await setup(info)

    await runPrompt(agent, query, sessionId)
    query.push(sessionState(sessionId, 'idle'))
    await vi.waitFor(() => expect(getSessionInfo).toHaveBeenCalledTimes(2))

    const titles = sessionUpdate.mock.calls.filter(
      ([notification]) => notification.update.sessionUpdate === 'session_info_update'
    )
    expect(titles).toHaveLength(1)
  })

  it('settles the prompt normally when reading the framework title fails', async () => {
    getSessionInfo.mockRejectedValue(new Error('transcript temporarily unavailable'))
    const { agent, query, sessionId, sessionUpdate } = await setup(undefined)

    await runPrompt(agent, query, sessionId)

    expect(sessionUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ sessionUpdate: 'session_info_update' })
      })
    )
  })

  it('settles the prompt when reading the framework title never completes', async () => {
    getSessionInfo.mockReturnValue(new Promise<SDKSessionInfo | undefined>(() => undefined))
    const { agent, query, sessionId, sessionUpdate } = await setup(undefined, true)

    await runPrompt(agent, query, sessionId)

    expect(getSessionInfo).toHaveBeenCalledOnce()
    expect(sessionUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ sessionUpdate: 'session_info_update' })
      })
    )
  })

  it('does not associate an autonomous result with a framework title', async () => {
    const { agent, query, sessionId, sessionUpdate } = await setup(undefined)
    await runPrompt(agent, query, sessionId)
    getSessionInfo.mockClear()
    sessionUpdate.mockClear()
    getSessionInfo.mockResolvedValue({
      sessionId: 'unused-by-adapter',
      summary: 'Background agent report',
      customTitle: 'Background agent report',
      firstPrompt: '你的身份是什么',
      lastModified: 1
    })

    await vi.waitFor(() => expect(query.pendingReaderCount).toBe(1))
    query.push({
      ...resultMessage(sessionId),
      origin: { kind: 'peer', from: 'peer-session' }
    } as SDKMessage)
    await vi.waitFor(() => expect(query.pendingReaderCount).toBe(1))

    expect(getSessionInfo).not.toHaveBeenCalled()
    expect(sessionUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ sessionUpdate: 'session_info_update' })
      })
    )
    await agent.closeSession({ sessionId })
  })
})
