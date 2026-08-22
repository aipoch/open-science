import { describe, expect, it, vi } from 'vitest'

import { AcpNativeFollowUpWorkflow } from './native-follow-up-workflow'
import { ACP_STEERING_METHOD } from './native-follow-up'

const published: Array<{ sessionId: string; messageId: string; text: string }> = []

const createWorkflow = (
  overrides: {
    advertised?: boolean
    livePrompt?: boolean
    frameworkId?: 'claude-code' | 'opencode' | 'codex'
    openCodeHttp?: boolean
    providerSessionId?: string | undefined
    request?: (method: string, params: unknown) => Promise<unknown>
    fetchImpl?: typeof fetch
  } = {}
): {
  request: (method: string, params: unknown) => Promise<unknown>
  workflow: AcpNativeFollowUpWorkflow
} => {
  published.length = 0
  const request = overrides.request ?? vi.fn(async () => ({ outcome: 'injected' }))
  return {
    request,
    workflow: new AcpNativeFollowUpWorkflow({
      connection: () =>
        ({
          agent: { request }
        }) as never,
      capabilities: () =>
        Object.freeze({
          close: true,
          delete: true,
          resume: true,
          steering: overrides.advertised ?? true
        }),
      frameworkId: () => overrides.frameworkId ?? 'claude-code',
      openCodeUsageApi: () =>
        overrides.openCodeHttp
          ? Object.freeze({
              baseUrl: 'http://127.0.0.1:4096/',
              authorization: 'Basic test'
            })
          : undefined,
      activeProviderSessionId: () =>
        overrides.providerSessionId === undefined ? 'provider-1' : overrides.providerSessionId,
      hasLivePrompt: () => overrides.livePrompt ?? true,
      sessionCwd: () => '/workspace',
      publishUserMessage: (input) => {
        published.push(input)
      },
      createMessageId: () => 'message-steer-1',
      fetchImpl: overrides.fetchImpl
    })
  }
}

describe('AcpNativeFollowUpWorkflow', () => {
  it('injects advertised ACP steering without opening a second prompt', async () => {
    const { request, workflow } = createWorkflow()
    await expect(
      workflow.steerFollowUp({ sessionId: 'app-1', text: 'focus on tests' })
    ).resolves.toEqual({
      injected: true,
      transport: 'acp-steering',
      messageId: 'message-steer-1'
    })
    expect(request).toHaveBeenCalledWith(
      ACP_STEERING_METHOD,
      expect.objectContaining({
        sessionId: 'provider-1',
        prompt: [{ type: 'text', text: 'focus on tests' }]
      })
    )
    expect(published).toEqual([
      { sessionId: 'app-1', messageId: 'message-steer-1', text: 'focus on tests' }
    ])
  })

  it('refuses startedNewTurn and does not persist a user message', async () => {
    const { workflow } = createWorkflow({
      request: vi.fn(async () => ({ outcome: 'startedNewTurn' }))
    })
    await expect(
      workflow.steerFollowUp({ sessionId: 'app-1', text: 'focus on tests' })
    ).resolves.toEqual({ injected: false, reason: 'started-new-turn' })
    expect(published).toEqual([])
  })

  it('posts OpenCode HTTP follow-up into the v1 session when ACP steering is not advertised', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
        ({
          ok: true,
          json: async () => ({
            info: { id: 'msg_1', role: 'user', sessionID: 'provider-1' },
            parts: [{ type: 'text', text: 'http-steer' }]
          })
        }) as Response
    )
    const { request, workflow } = createWorkflow({
      advertised: false,
      frameworkId: 'opencode',
      openCodeHttp: true,
      fetchImpl
    })
    await expect(
      workflow.steerFollowUp({ sessionId: 'app-1', text: 'http-steer' })
    ).resolves.toEqual({
      injected: true,
      transport: 'opencode-http',
      messageId: 'message-steer-1'
    })
    expect(request).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledOnce()
    const call = fetchImpl.mock.calls[0]
    expect(call).toBeDefined()
    expect(String(call?.[0])).toContain('/session/provider-1/message')
    expect(String(call?.[0])).not.toContain('/api/session/')
    expect(String(call?.[0])).toContain('directory=')
    expect(call?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          parts: [{ type: 'text', text: 'http-steer' }],
          noReply: true
        })
      })
    )
    expect(published).toHaveLength(1)
  })

  it('refuses OpenCode v2 inbox admission that never lands in the ACP session', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
        ({
          ok: true,
          json: async () => ({
            data: {
              admittedSeq: 7,
              id: 'msg_1',
              sessionID: 'provider-1',
              prompt: { text: 'http-steer' },
              delivery: 'steer'
            }
          })
        }) as Response
    )
    const { workflow } = createWorkflow({
      advertised: false,
      frameworkId: 'opencode',
      openCodeHttp: true,
      fetchImpl
    })
    await expect(
      workflow.steerFollowUp({ sessionId: 'app-1', text: 'http-steer' })
    ).resolves.toEqual({ injected: false, reason: 'dispatch-failed' })
    expect(published).toEqual([])
  })

  it('does not lift the prompt lock when steering is unavailable', async () => {
    const { request, workflow } = createWorkflow({
      advertised: false,
      frameworkId: 'codex',
      livePrompt: true
    })
    await expect(
      workflow.steerFollowUp({ sessionId: 'app-1', text: 'focus on tests' })
    ).resolves.toEqual({ injected: false, reason: 'not-advertised' })
    expect(request).not.toHaveBeenCalled()
    expect(published).toEqual([])
  })
})
