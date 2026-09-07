import { describe, expect, it, vi } from 'vitest'

import { createMainPromptSideChatRelay } from '../side-chat/main-prompt-relay'
import {
  AcpNativeFollowUpWorkflow,
  finalizeNativeFollowUpPreparedContent,
  type NativeFollowUpUserMessage
} from './native-follow-up-workflow'
import { ACP_STEERING_METHOD, CODEBUDDY_STEER_METHOD } from './native-follow-up'
import { SideChatRelayOwner } from './side-chat-relay-owner'

const published: NativeFollowUpUserMessage[] = []

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const createWorkflow = (
  overrides: {
    advertised?: boolean
    livePrompt?: boolean | (() => boolean)
    pendingPermission?: boolean | (() => boolean)
    livePromptTurn?: () =>
      { turnToken: string; signal: AbortSignal; promptMessageId?: string } | undefined
    frameworkId?: 'claude-code' | 'opencode' | 'codex' | 'codebuddy'
    openCodeHttp?: boolean
    providerSessionId?: string | null
    request?: (
      method: string,
      params: unknown,
      options?: { cancellationSignal?: AbortSignal }
    ) => Promise<unknown>
    followUpTimeoutMs?: number
    fetchImpl?: typeof fetch
    prepareFollowUp?: ConstructorParameters<typeof AcpNativeFollowUpWorkflow>[0]['prepareFollowUp']
    registerTurnInputs?: ConstructorParameters<
      typeof AcpNativeFollowUpWorkflow
    >[0]['registerTurnInputs']
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
        overrides.providerSessionId === undefined
          ? 'provider-1'
          : (overrides.providerSessionId ?? undefined),
      hasLivePrompt: () =>
        typeof overrides.livePrompt === 'function'
          ? overrides.livePrompt()
          : (overrides.livePrompt ?? true),
      hasPendingPermission: () =>
        typeof overrides.pendingPermission === 'function'
          ? overrides.pendingPermission()
          : (overrides.pendingPermission ?? false),
      livePrompt: () => {
        if (overrides.livePromptTurn) return overrides.livePromptTurn()
        const isLive =
          typeof overrides.livePrompt === 'function'
            ? overrides.livePrompt()
            : (overrides.livePrompt ?? true)
        return isLive
          ? {
              turnToken: 'turn-1',
              signal: new AbortController().signal,
              promptMessageId: 'prompt-live'
            }
          : undefined
      },
      sessionCwd: () => '/workspace',
      publishUserMessage: (input) => {
        published.push(input)
      },
      createMessageId: () => 'message-steer-1',
      fetchImpl: overrides.fetchImpl,
      ...(overrides.prepareFollowUp ? { prepareFollowUp: overrides.prepareFollowUp } : {}),
      ...(overrides.registerTurnInputs ? { registerTurnInputs: overrides.registerTurnInputs } : {}),
      ...(overrides.followUpTimeoutMs !== undefined
        ? { followUpTimeoutMs: overrides.followUpTimeoutMs }
        : {})
    })
  }
}

describe('AcpNativeFollowUpWorkflow', () => {
  it('Q03 rechecks the bound generation after preparing a follow-up', async () => {
    let current = true
    const close = vi.fn()
    const { workflow, request } = createWorkflow({
      prepareFollowUp: async () => {
        current = false
        return { prompt: [{ type: 'text', text: 'Queued' }], close }
      }
    })
    expect(
      await workflow.steerFollowUp({ sessionId: 'session-1', text: 'Queued' }, () => current)
    ).toMatchObject({ injected: false })
    expect(request).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('Q03 refuses a different live turn after asynchronous follow-up preparation', async () => {
    let finish!: (value: { prompt: readonly { type: 'text'; text: string }[] }) => void
    const pending = new Promise<{ prompt: readonly { type: 'text'; text: string }[] }>(
      (resolve) => {
        finish = resolve
      }
    )
    let token = 'turn-a'
    const { workflow, request } = createWorkflow({
      livePromptTurn: () => ({ turnToken: token, signal: new AbortController().signal }),
      prepareFollowUp: () => pending
    })
    const sending = workflow.steerFollowUp({ sessionId: 'session-1', text: 'queued intent' })
    token = 'turn-b'
    finish({ prompt: [{ type: 'text', text: 'queued intent' }] })
    expect(await sending).toMatchObject({ injected: false })
    expect(request).not.toHaveBeenCalled()
  })

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
      }),
      expect.objectContaining({ cancellationSignal: expect.any(AbortSignal) })
    )
    expect(published).toEqual([
      { sessionId: 'app-1', messageId: 'message-steer-1', text: 'focus on tests' }
    ])
  })

  it('injects CodeBuddy session/steer when standard ACP steering is not advertised', async () => {
    const { request, workflow } = createWorkflow({
      advertised: false,
      frameworkId: 'codebuddy',
      request: vi.fn(async () => ({ steered: true }))
    })

    await expect(
      workflow.steerFollowUp({ sessionId: 'app-1', text: 'focus on tests' })
    ).resolves.toEqual({
      injected: true,
      transport: 'codebuddy-acp-steer',
      messageId: 'message-steer-1'
    })
    expect(request).toHaveBeenCalledWith(
      CODEBUDDY_STEER_METHOD,
      {
        sessionId: 'provider-1',
        contentBlocks: [{ type: 'text', text: 'focus on tests' }]
      },
      expect.objectContaining({ cancellationSignal: expect.any(AbortSignal) })
    )
    expect(published).toEqual([
      { sessionId: 'app-1', messageId: 'message-steer-1', text: 'focus on tests' }
    ])
  })

  it('injects an advisory without publishing an ordinary user message', async () => {
    const { workflow } = createWorkflow()

    await expect(
      workflow.steerSideChatAdvisory({ sessionId: 'app-1', text: 'Context-only advisory' })
    ).resolves.toEqual({
      injected: true,
      promptMessageId: 'prompt-live'
    })
    expect(published).toEqual([])
  })

  it('refuses an advisory when the live prompt has no durable message identity', async () => {
    const { workflow } = createWorkflow({
      livePromptTurn: () => ({
        turnToken: 'turn-1',
        signal: new AbortController().signal
      })
    })

    await expect(
      workflow.steerSideChatAdvisory({ sessionId: 'app-1', text: 'Context-only advisory' })
    ).resolves.toEqual({ injected: false })
    expect(published).toEqual([])
  })

  it('refuses an advisory when Main changes turns while the advisory is prepared', async () => {
    let livePromptReads = 0
    const request = vi.fn(async () => ({ outcome: 'injected' }))
    const { workflow } = createWorkflow({
      request,
      livePromptTurn: () => {
        livePromptReads += 1
        return {
          turnToken: livePromptReads === 1 ? 'turn-1' : 'turn-2',
          signal: new AbortController().signal,
          promptMessageId: livePromptReads === 1 ? 'prompt-1' : 'prompt-2'
        }
      },
      prepareFollowUp: async () => ({
        prompt: [{ type: 'text' as const, text: 'Context-only advisory' }],
        uploads: []
      })
    })

    await expect(
      workflow.steerSideChatAdvisory({ sessionId: 'app-1', text: 'Context-only advisory' })
    ).resolves.toEqual({ injected: false })
    expect(request).not.toHaveBeenCalled()
    expect(published).toEqual([])
  })

  it('does not requeue an advisory after steering consumes it into a new Main turn', async () => {
    let originalTurnRunning = true
    const { workflow } = createWorkflow({
      request: vi.fn(async () => {
        originalTurnRunning = false
        return { outcome: 'startedNewTurn' }
      }),
      livePromptTurn: () =>
        originalTurnRunning
          ? {
              turnToken: 'turn-1',
              signal: new AbortController().signal,
              promptMessageId: 'prompt-live'
            }
          : undefined
    })
    const relay = new SideChatRelayOwner({
      targetState: () => 'running',
      appendRelay: async () => undefined
    })
    relay.bind({
      sideSessionId: 'side-1',
      sideChatId: 'chat-1',
      parentSessionId: 'app-1',
      projectId: 'project-1'
    })
    const queued = await relay.send({
      sideSessionId: 'side-1',
      target: 'main',
      text: 'Context-only advisory'
    })
    const commitSideChatRelays = vi.fn(async () => [])
    const mainRelay = createMainPromptSideChatRelay({
      relay,
      steerAdvisory: (request) => workflow.steerSideChatAdvisory(request),
      commitSideChatRelays,
      onDelivered: vi.fn()
    })

    await expect(mainRelay.tryInject('app-1', queued)).resolves.toMatchObject({
      status: 'injected'
    })
    expect(commitSideChatRelays).toHaveBeenCalledWith(
      expect.objectContaining({ relayIds: [queued.messageId], promptMessageId: 'prompt-live' })
    )
    expect(mainRelay.claim('app-1')).toBeUndefined()
    expect(published).toEqual([])
  })

  it('keeps an advisory consumed when Main finishes during steering', async () => {
    let liveTurnToken = 'turn-1'
    const { workflow } = createWorkflow({
      request: vi.fn(async () => {
        liveTurnToken = 'turn-2'
        return { outcome: 'injected' }
      }),
      livePromptTurn: () => ({
        turnToken: liveTurnToken,
        signal: new AbortController().signal,
        promptMessageId: liveTurnToken === 'turn-1' ? 'prompt-1' : 'prompt-2'
      })
    })

    await expect(
      workflow.steerSideChatAdvisory({ sessionId: 'app-1', text: 'Context-only advisory' })
    ).resolves.toEqual({ injected: true, promptMessageId: 'prompt-1' })
    expect(published).toEqual([])
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
    const close = vi.fn()
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
      ],
      close
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
      }),
      expect.objectContaining({ cancellationSignal: expect.any(AbortSignal) })
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
    expect(close).not.toHaveBeenCalled()
    workflow.releaseTurn('app-1', 'turn-1')
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes retained prepared resources during workflow teardown', async () => {
    const close = vi.fn()
    const { workflow } = createWorkflow({
      prepareFollowUp: async () => ({
        prompt: [{ type: 'text' as const, text: 'see file' }],
        close
      })
    })

    await workflow.steerFollowUp({ sessionId: 'app-1', text: 'see file' })
    expect(close).not.toHaveBeenCalled()

    workflow.clear()
    workflow.clear()
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes retained prepared resources when their session is superseded', async () => {
    const close = vi.fn()
    const { workflow } = createWorkflow({
      prepareFollowUp: async () => ({
        prompt: [{ type: 'text' as const, text: 'see file' }],
        close
      })
    })

    await workflow.steerFollowUp({ sessionId: 'app-1', text: 'see file' })
    expect(close).not.toHaveBeenCalled()

    workflow.releaseSession('app-1')
    workflow.releaseSession('app-1')
    expect(close).toHaveBeenCalledOnce()
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

  it.each(['claude-code', 'codex', 'codebuddy'] as const)(
    'refuses %s ACP steering when permission becomes pending during preparation',
    async (frameworkId) => {
      let pendingPermission = false
      const close = vi.fn()
      const { request, workflow } = createWorkflow({
        frameworkId,
        pendingPermission: () => pendingPermission,
        prepareFollowUp: async () => {
          pendingPermission = true
          return { prompt: [{ type: 'text' as const, text: 'late follow-up' }], close }
        }
      })

      await expect(
        workflow.steerFollowUp({ sessionId: 'app-1', text: 'late follow-up' })
      ).resolves.toEqual({ injected: false, reason: 'prompt-required' })
      expect(request).not.toHaveBeenCalled()
      expect(published).toEqual([])
      expect(close).toHaveBeenCalledOnce()
    }
  )

  it('refuses OpenCode HTTP follow-up while permission is pending', async () => {
    const fetchImpl = vi.fn<FetchImpl>()
    const { workflow } = createWorkflow({
      advertised: false,
      frameworkId: 'opencode',
      openCodeHttp: true,
      pendingPermission: true,
      fetchImpl
    })

    await expect(
      workflow.steerFollowUp({ sessionId: 'app-1', text: 'http-steer' })
    ).resolves.toEqual({ injected: false, reason: 'prompt-required' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(published).toEqual([])
  })

  it('posts OpenCode HTTP follow-up into the v1 session when ACP steering is not advertised', async () => {
    const fetchImpl = vi.fn<FetchImpl>(
      async () =>
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

  it('refuses OpenCode HTTP follow-up when the live prompt ends during preparation', async () => {
    let livePrompt = true
    const fetchImpl = vi.fn<FetchImpl>(
      async () =>
        ({
          ok: true,
          json: async () => ({
            info: { id: 'msg_1', role: 'user', sessionID: 'provider-1' },
            parts: [{ type: 'text', text: 'late' }]
          })
        }) as Response
    )
    const { workflow } = createWorkflow({
      advertised: false,
      frameworkId: 'opencode',
      openCodeHttp: true,
      livePrompt: () => livePrompt,
      fetchImpl,
      prepareFollowUp: async () => {
        livePrompt = false
        return { prompt: [{ type: 'text' as const, text: 'late' }] }
      }
    })
    await expect(workflow.steerFollowUp({ sessionId: 'app-1', text: 'late' })).resolves.toEqual({
      injected: false,
      reason: 'no-live-turn'
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(published).toEqual([])
  })

  it('refuses OpenCode v2 inbox admission that never lands in the ACP session', async () => {
    const fetchImpl = vi.fn<FetchImpl>(
      async () =>
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

  it('refuses ACP steering that never replies and does not persist a user message', async () => {
    const request = vi.fn(() => new Promise(() => undefined))
    const close = vi.fn()
    const { workflow } = createWorkflow({
      request,
      followUpTimeoutMs: 20,
      prepareFollowUp: async () => ({
        prompt: [{ type: 'text' as const, text: 'focus on tests' }],
        close
      })
    })
    await expect(
      workflow.steerFollowUp({ sessionId: 'app-1', text: 'focus on tests' })
    ).resolves.toEqual({ injected: false, reason: 'dispatch-failed' })
    expect(published).toEqual([])
    expect(close).toHaveBeenCalledOnce()
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

  it('materializes and advertises notebook inputs before steering, then commits after injection', async () => {
    const registerTurnInputs = vi.fn(async (input: { materializeOnly?: boolean }) =>
      input.materializeOnly
        ? [
            {
              sourceKind: 'upload-version' as const,
              inputFileVersionId: 'upload-version-1',
              filename: 'samples.csv',
              notebookPath: 'inputs/samples-123456789abc.csv'
            }
          ]
        : undefined
    )
    const request = vi.fn(async (_method: string, params: unknown) => {
      expect(registerTurnInputs).toHaveBeenCalledWith(
        expect.objectContaining({ materializeOnly: true })
      )
      expect(JSON.stringify(params)).toContain('inputs/samples-123456789abc.csv')
      expect(JSON.stringify(params)).toContain('use only the exact notebookPath')
      return { outcome: 'injected' }
    })
    const { workflow } = createWorkflow({
      request,
      registerTurnInputs,
      prepareFollowUp: async () => ({
        prompt: [{ type: 'text' as const, text: 'see file' }],
        notebookTurnInputs: {
          projectId: 'project-1',
          sessionId: 'app-1',
          livePromptMessageId: 'prompt-live',
          uploads: [],
          references: []
        }
      })
    })
    await expect(workflow.steerFollowUp({ sessionId: 'app-1', text: 'see file' })).resolves.toEqual(
      {
        injected: true,
        transport: 'acp-steering',
        messageId: 'message-steer-1'
      }
    )
    expect(registerTurnInputs).toHaveBeenNthCalledWith(1, {
      projectId: 'project-1',
      appSessionId: 'app-1',
      promptMessageId: 'prompt-live',
      uploads: [],
      references: [],
      materializeOnly: true
    })
    expect(registerTurnInputs).toHaveBeenNthCalledWith(2, {
      projectId: 'project-1',
      appSessionId: 'app-1',
      promptMessageId: 'prompt-live',
      uploads: [],
      references: []
    })
  })

  it('keeps a confirmed inject if the live prompt ends before notebook commit', async () => {
    const registerTurnInputs = vi.fn(async () => undefined)
    let liveTurnToken = 'turn-1'
    const { workflow } = createWorkflow({
      registerTurnInputs,
      livePromptTurn: () =>
        liveTurnToken
          ? { turnToken: liveTurnToken, signal: new AbortController().signal }
          : undefined,
      request: vi.fn(async () => {
        liveTurnToken = ''
        return { outcome: 'injected' }
      }),
      prepareFollowUp: async () => ({
        prompt: [{ type: 'text' as const, text: 'late' }],
        notebookTurnInputs: {
          projectId: 'project-1',
          sessionId: 'app-1',
          livePromptMessageId: 'prompt-live',
          uploads: [],
          references: []
        }
      })
    })
    await expect(workflow.steerFollowUp({ sessionId: 'app-1', text: 'late' })).resolves.toEqual({
      injected: true,
      transport: 'acp-steering',
      messageId: 'message-steer-1'
    })
    expect(registerTurnInputs).toHaveBeenCalledOnce()
    expect(registerTurnInputs).toHaveBeenCalledWith(
      expect.objectContaining({ materializeOnly: true })
    )
    expect(published).toEqual([{ sessionId: 'app-1', messageId: 'message-steer-1', text: 'late' }])
  })

  it('does not abort in-flight steering when the live prompt is cancelled', async () => {
    const controller = new AbortController()
    let cancellationSignal: AbortSignal | undefined
    const request = vi.fn(
      async (_method: string, _params: unknown, options?: { cancellationSignal?: AbortSignal }) => {
        cancellationSignal = options?.cancellationSignal
        controller.abort()
        return { outcome: 'injected' }
      }
    )
    const { workflow } = createWorkflow({
      request,
      livePromptTurn: () =>
        controller.signal.aborted ? undefined : { turnToken: 'turn-1', signal: controller.signal }
    })
    await expect(
      workflow.steerFollowUp({ sessionId: 'app-1', text: 'focus on tests' })
    ).resolves.toEqual({
      injected: true,
      transport: 'acp-steering',
      messageId: 'message-steer-1'
    })
    expect(cancellationSignal?.aborted).toBe(false)
    expect(published).toEqual([
      { sessionId: 'app-1', messageId: 'message-steer-1', text: 'focus on tests' }
    ])
  })

  it('does not commit notebook inputs when steering is refused', async () => {
    const registerTurnInputs = vi.fn(async () => undefined)
    const { workflow } = createWorkflow({
      request: vi.fn(async () => ({})),
      registerTurnInputs,
      prepareFollowUp: async () => ({
        prompt: [{ type: 'text' as const, text: 'see file' }],
        notebookTurnInputs: {
          projectId: 'project-1',
          sessionId: 'app-1',
          livePromptMessageId: 'prompt-live',
          uploads: [],
          references: []
        }
      })
    })
    await expect(workflow.steerFollowUp({ sessionId: 'app-1', text: 'see file' })).resolves.toEqual(
      { injected: false, reason: 'unrecognized-success' }
    )
    expect(registerTurnInputs).toHaveBeenCalledOnce()
    expect(registerTurnInputs).toHaveBeenCalledWith(
      expect.objectContaining({ materializeOnly: true })
    )
    expect(published).toEqual([])
  })
})

describe('finalizeNativeFollowUpPreparedContent', () => {
  it('closes prepared resources when image compatibility fails', async () => {
    const close = vi.fn()
    await expect(
      finalizeNativeFollowUpPreparedContent({
        content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }],
        projectId: 'project-1',
        sessionId: 'app-1',
        supportsImageInput: false,
        historyImageCount: 0,
        imageCompatibility: {
          prepare: vi.fn(async () => Promise.reject(new Error('relay failed')))
        },
        close
      })
    ).rejects.toThrow('relay failed')
    expect(close).toHaveBeenCalledOnce()
  })

  it('relays content through image compatibility without changing the live prompt id', async () => {
    const prepare = vi.fn(async () => [{ type: 'text' as const, text: 'relayed image' }])
    await expect(
      finalizeNativeFollowUpPreparedContent({
        content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }],
        projectId: 'project-1',
        sessionId: 'app-1',
        livePromptMessageId: 'prompt-live',
        supportsImageInput: false,
        historyImageCount: 0,
        imageCompatibility: { prepare }
      })
    ).resolves.toEqual({
      prompt: [{ type: 'text', text: 'relayed image' }],
      uploads: []
    })
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        supportsImageInput: false,
        sessionId: 'app-1',
        projectId: 'project-1'
      })
    )
  })

  it('defers live-prompt notebook inputs until inject is confirmed', async () => {
    const upload = {
      id: 'upload-1',
      sessionId: 'app-1',
      name: 'notes.md',
      originalName: 'notes.md',
      path: '/managed/notes.md',
      mimeType: 'text/markdown',
      size: 4,
      versionId: 'version-1'
    }
    await expect(
      finalizeNativeFollowUpPreparedContent({
        content: [{ type: 'text', text: 'see file' }],
        turnInputs: { uploads: [upload], references: [] },
        projectId: 'project-1',
        sessionId: 'app-1',
        livePromptMessageId: 'prompt-live',
        supportsImageInput: true,
        historyImageCount: 0
      })
    ).resolves.toEqual({
      prompt: [{ type: 'text', text: 'see file' }],
      uploads: [upload],
      notebookTurnInputs: {
        projectId: 'project-1',
        sessionId: 'app-1',
        livePromptMessageId: 'prompt-live',
        uploads: [upload],
        references: []
      }
    })
  })

  it('skips notebook inputs when the live prompt has no message id', async () => {
    await expect(
      finalizeNativeFollowUpPreparedContent({
        content: 'see file',
        turnInputs: { uploads: [], references: [] },
        projectId: 'project-1',
        sessionId: 'app-1',
        supportsImageInput: true,
        historyImageCount: 0
      })
    ).resolves.toEqual({
      prompt: [{ type: 'text', text: 'see file' }],
      uploads: []
    })
  })
})
