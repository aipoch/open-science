import { describe, expect, it, vi } from 'vitest'

import {
  AcpNativeFollowUpWorkflow,
  type NativeFollowUpUserMessage
} from './native-follow-up-workflow'
import { ACP_STEERING_METHOD } from './native-follow-up'

const published: NativeFollowUpUserMessage[] = []

const createWorkflow = (
  overrides: {
    advertised?: boolean
    livePrompt?: boolean
    frameworkId?: 'claude-code' | 'opencode' | 'codex'
    openCodeHttp?: boolean
    providerSessionId?: string | null
    request?: (method: string, params: unknown) => Promise<unknown>
    fetchImpl?: typeof fetch
    prepareFollowUp?: ConstructorParameters<typeof AcpNativeFollowUpWorkflow>[0]['prepareFollowUp']
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
        overrides.providerSessionId === undefined ? 'provider-1' : (overrides.providerSessionId ?? undefined),
      hasLivePrompt: () => overrides.livePrompt ?? true,
      sessionCwd: () => '/workspace',
      publishUserMessage: (input) => {
        published.push(input)
      },
      createMessageId: () => 'message-steer-1',
      fetchImpl: overrides.fetchImpl,
      ...(overrides.prepareFollowUp ? { prepareFollowUp: overrides.prepareFollowUp } : {})
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
        prompt: [{ type: 'text', text: 'focus on tests' }],
        _meta: { steering: { idleBehavior: 'promptRequired' } }
      })
    )
    expect(published).toEqual([
      { sessionId: 'app-1', messageId: 'message-steer-1', text: 'focus on tests' }
    ])
  })

  it('treats startedNewTurn as injected because the adapter consumed the prompt', async () => {
    const { workflow } = createWorkflow({
      request: vi.fn(async () => ({ outcome: 'startedNewTurn' }))
    })
    await expect(
      workflow.steerFollowUp({ sessionId: 'app-1', text: 'focus on tests' })
    ).resolves.toEqual({
      injected: true,
      transport: 'acp-steering',
      messageId: 'message-steer-1'
    })
    expect(published).toEqual([
      { sessionId: 'app-1', messageId: 'message-steer-1', text: 'focus on tests' }
    ])
  })

  it('injects prepared attachment and skill blocks on advertised steering', async () => {
    const prepareFollowUp = vi.fn(async () => ({
      prompt: [
        {
          type: 'text' as const,
          text: 'Use the following skill(s) for this task: Research.\n\nsee file'
        },
        {
          type: 'resource_link' as const,
          uri: 'file:///notes.md',
          name: 'notes.md',
          mimeType: 'text/markdown'
        }
      ],
      uploads: [
        {
          id: 'upload-1',
          sessionId: 'app-1',
          name: 'notes.md',
          originalName: 'notes.md',
          path: '/managed/notes.md',
          mimeType: 'text/markdown',
          size: 12,
          versionId: 'version-1',
          versionNumber: 1,
          checksum: 'abc'
        }
      ]
    }))
    const { request, workflow } = createWorkflow({ prepareFollowUp })
    await expect(
      workflow.steerFollowUp({
        sessionId: 'app-1',
        text: 'see file',
        attachments: [
          {
            id: 'upload-1',
            sessionId: 'app-1',
            name: 'notes.md',
            originalName: 'notes.md',
            path: '/tmp/notes.md',
            mimeType: 'text/markdown',
            size: 12
          }
        ],
        forcedSkillIds: ['research'],
        parts: [{ type: 'text', text: 'see file' }]
      })
    ).resolves.toEqual({
      injected: true,
      transport: 'acp-steering',
      messageId: 'message-steer-1'
    })
    expect(prepareFollowUp).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith(
      ACP_STEERING_METHOD,
      expect.objectContaining({
        prompt: [
          {
            type: 'text',
            text: 'Use the following skill(s) for this task: Research.\n\nsee file'
          },
          {
            type: 'resource_link',
            uri: 'file:///notes.md',
            name: 'notes.md',
            mimeType: 'text/markdown'
          }
        ]
      })
    )
    expect(published[0]).toMatchObject({
      sessionId: 'app-1',
      text: 'see file',
      uploads: [
        expect.objectContaining({
          id: 'upload-1',
          name: 'notes.md',
          versionId: 'version-1',
          sha256: 'abc'
        })
      ],
      parts: [{ type: 'text', text: 'see file' }]
    })
    expect(published[0]?.uploads?.[0]).not.toHaveProperty('path')
  })

  it('does not persist unfinalized attachments that session save cannot recover', async () => {
    const { workflow } = createWorkflow()
    await expect(
      workflow.steerFollowUp({
        sessionId: 'app-1',
        text: 'see file',
        attachments: [
          {
            id: 'upload-pending',
            sessionId: '.pending',
            name: 'notes.md',
            originalName: 'notes.md',
            path: '/tmp/notes.md',
            mimeType: 'text/markdown',
            size: 12
          }
        ]
      })
    ).resolves.toEqual({
      injected: true,
      transport: 'acp-steering',
      messageId: 'message-steer-1'
    })
    expect(published[0]).toEqual({
      sessionId: 'app-1',
      messageId: 'message-steer-1',
      text: 'see file'
    })
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

  it('refuses an empty steering success instead of treating it as injected', async () => {
    const { workflow } = createWorkflow({
      request: vi.fn(async () => ({}))
    })
    await expect(
      workflow.steerFollowUp({ sessionId: 'app-1', text: 'focus on tests' })
    ).resolves.toEqual({ injected: false, reason: 'unrecognized-success' })
    expect(published).toEqual([])
  })

  it('refuses idle promptRequired without persisting a user message', async () => {
    const { workflow } = createWorkflow({
      request: vi.fn(async () => ({ outcome: 'promptRequired', reason: 'noRunningTurn' }))
    })
    await expect(
      workflow.steerFollowUp({ sessionId: 'app-1', text: 'focus on tests' })
    ).resolves.toEqual({ injected: false, reason: 'prompt-required' })
    expect(published).toEqual([])
  })

  it('refuses when the provider session is gone', async () => {
    const { request, workflow } = createWorkflow({ providerSessionId: null })
    await expect(
      workflow.steerFollowUp({ sessionId: 'app-1', text: 'focus on tests' })
    ).resolves.toEqual({ injected: false, reason: 'no-live-turn' })
    expect(request).not.toHaveBeenCalled()
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
