import { describe, expect, it, vi } from 'vitest'
import { bufferChatCompletionsToolNames } from '@aipoch/providers/protocol'

import type { ProviderRuntimeTarget } from './provider-accounts'
import type { BackendRoutePlan, BackendTransportPlan } from './backend-route-planner'
import {
  ProviderTransportOwner,
  type ProviderTransportOwnerOptions
} from './provider-transport-owner'
import {
  ProtocolForwardingBridge,
  type ProtocolForwardingBridgeTarget
} from './protocol-forwarding-bridge'
import { MessagesBridge, type MessagesBridgeTarget } from './messages-bridge'
import type { ChatCompletionsCompatibilityTarget } from './chat-completions-compatibility'

type ResponsesToChatCompletionsBridgeStub = ReturnType<
  NonNullable<ProviderTransportOwnerOptions['createResponsesToChatCompletionsBridge']>
>
type NativeProxyStub = ReturnType<
  NonNullable<ProviderTransportOwnerOptions['createNativeResponsesProxy']>
>
type MessagesBridgeStub = ReturnType<
  NonNullable<ProviderTransportOwnerOptions['createMessagesBridge']>
>
type OpenAiBridgeStub = ReturnType<
  NonNullable<ProviderTransportOwnerOptions['createProtocolForwardingBridge']>
>
type ChatCompatibilityBridgeStub = ReturnType<
  NonNullable<ProviderTransportOwnerOptions['createChatCompletionsCompatibilityBridge']>
>

const makeTarget = (): ProviderRuntimeTarget => ({
  providerId: 'provider-a',
  providerType: 'custom',
  effectiveModel: 'model-a',
  apiEndpoints: ['chat-completions'],
  provider: {
    type: 'custom',
    baseUrl: 'https://provider.example/v1',
    chatCompletionsBaseUrl: 'https://provider.example/v1',
    model: 'model-a',
    key: 'plain-provider-key',
    apiEndpoints: ['chat-completions']
  },
  reasoningEffortProfile: {
    supported: true,
    slots: ['low', 'medium', 'high', 'xhigh', 'max']
  },
  frameworkCompatible: true,
  modelBridgeSupported: true,
  needsChatResponsesToChatCompletionsBridge: true,
  needsNativeResponsesCompatibility: false
})

const makeResponsesToChatCompletionsBridge = (
  index: number
): ResponsesToChatCompletionsBridgeStub => ({
  start: vi.fn(async () => ({
    baseUrl: `http://127.0.0.1:${41000 + index}/v1`,
    token: `bridge-token-${index}`,
    continuityToken: `continuity-${index}`
  })),
  close: vi.fn(async () => undefined),
  selectSkills: vi.fn(async () => []),
  registerReviewerSession: vi.fn(),
  unregisterReviewerSession: vi.fn(() => false),
  registerToolLessSession: vi.fn(),
  unregisterToolLessSession: vi.fn(() => false),
  registerHostMessageSession: vi.fn(),
  unregisterHostMessageSession: vi.fn(() => false),
  setReasoningEffort: vi.fn(),
  setModelTarget: vi.fn(),
  setTarget: vi.fn()
})

const makeNativeProxy = (startError?: Error, closeError?: Error): NativeProxyStub => ({
  start: vi.fn(async () => {
    if (startError) throw startError
    return {
      baseUrl: 'http://127.0.0.1:42000/v1',
      token: 'proxy-token',
      kind: 'responses-compatibility' as const
    }
  }),
  close: vi.fn(async () => {
    if (closeError) throw closeError
  }),
  selectSkills: vi.fn(async () => []),
  registerReviewerSession: vi.fn(),
  unregisterReviewerSession: vi.fn(() => false),
  registerToolLessSession: vi.fn(),
  unregisterToolLessSession: vi.fn(() => false),
  registerHostMessageSession: vi.fn(),
  unregisterHostMessageSession: vi.fn(() => false),
  setModelTarget: vi.fn(),
  setTarget: vi.fn()
})

const makeMessagesBridge = (): MessagesBridgeStub => ({
  start: vi.fn(async () => ({
    baseUrl: 'http://127.0.0.1:43000',
    token: 'anthropic-bridge-token'
  })),
  close: vi.fn(async () => undefined),
  setTarget: vi.fn(() => true),
  clearErrorReplay: vi.fn()
})

const makeOpenAiBridge = (index: number, startError?: Error): OpenAiBridgeStub => ({
  start: vi.fn(async () => {
    if (startError) throw startError
    return { baseUrl: `http://127.0.0.1:${44000 + index}`, token: `openai-token-${index}` }
  }),
  close: vi.fn(async () => undefined),
  setTarget: vi.fn(() => true),
  clearErrorReplay: vi.fn()
})

const makeChatCompatibilityBridge = (): ChatCompatibilityBridgeStub => ({
  start: vi.fn(async () => ({
    baseUrl: 'http://127.0.0.1:45000',
    token: 'chat-compatibility-token'
  })),
  close: vi.fn(async () => undefined)
})

const makePlan = (transport: BackendTransportPlan): BackendRoutePlan => ({
  modelRoute:
    transport.kind === 'claude-anthropic'
      ? 'claude-anthropic'
      : transport.kind === 'codex-chat'
        ? 'codex-bridge'
        : 'codex-responses-compatibility',
  backendProviderId: 'provider-a',
  sessionEffort: 'high',
  providerModelCatalog: [],
  transport
})

describe('ProviderTransportOwner harness leases', () => {
  const makeHarnessTarget = (): ProviderRuntimeTarget => ({ ...makeTarget(), configRevision: 3 })

  const makeCodexHarnessTarget = (): ProviderRuntimeTarget => ({
    ...makeHarnessTarget(),
    providerType: 'codex-isolated',
    apiEndpoints: ['responses'],
    provider: { type: 'codex-isolated', apiEndpoints: ['responses'], model: 'model-a' }
  })

  const sendCodexRequest = (
    connection: { baseUrl: string; token: string },
    body: Record<string, unknown> = {},
    signal?: AbortSignal
  ): Promise<Response> =>
    fetch(`${connection.baseUrl}/v1/responses`, {
      method: 'POST',
      signal,
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json',
        'ChatGPT-Account-Id': 'client-cannot-select-account',
        cookie: 'client-cannot-inject-cookie'
      },
      body: JSON.stringify({
        model: 'client-model',
        input: [],
        store: false,
        stream: true,
        ...body
      })
    })

  it('binds the Codex account once and resolves private credentials for every request', async () => {
    const upstream = vi.fn<typeof fetch>(
      async () =>
        new Response('data: {"type":"response.completed","response":{}}\n\n', {
          headers: { 'content-type': 'text/event-stream' }
        })
    )
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({
        endpoint: 'https://chatgpt.com/backend-api/codex/responses',
        accessToken: 'private-preflight-token',
        accountId: 'account-one'
      })
      .mockResolvedValueOnce({
        endpoint: 'https://chatgpt.com/backend-api/codex/responses',
        accessToken: 'private-token-one',
        accountId: 'account-one'
      })
      .mockResolvedValueOnce({
        endpoint: 'http://127.0.0.2:42000/imported/responses',
        accessToken: 'private-token-two',
        accountId: 'account-one'
      })
    const bind = vi.fn<(target: ProviderRuntimeTarget) => typeof resolve>(() => resolve)
    const owner = new ProviderTransportOwner({
      bindCodexHarnessConnection: bind,
      createProtocolForwardingBridge: (targets, id, options) =>
        new ProtocolForwardingBridge(targets, id, upstream, options)
    })
    const target = makeCodexHarnessTarget()
    const acquiring = owner.acquireHarness(target, new AbortController().signal)
    expect(bind).toHaveBeenCalledOnce()
    target.configRevision = 4
    const lease = await acquiring
    expect(bind.mock.calls[0][0]).toMatchObject({ configRevision: 3 })
    expect(resolve).toHaveBeenCalledOnce()
    expect(JSON.stringify(lease)).not.toMatch(/private-token|account-one|chatgpt\.com/)
    const tools = [{ type: 'function', name: 'sum', parameters: { type: 'object' } }]
    const input = [
      { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      { type: 'function_call', call_id: 'call-1', name: 'sum', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call-1', output: '42' }
    ]
    try {
      for (let index = 0; index < 2; index++) {
        const response = await sendCodexRequest(lease.connection, {
          tools,
          input,
          instructions: 'Instructions',
          max_output_tokens: 64,
          reasoning: { effort: 'high' }
        })
        expect(await response.text()).toContain('response.completed')
      }
      expect(resolve).toHaveBeenCalledTimes(3)
      expect(upstream).toHaveBeenCalledTimes(2)
      for (const [index, [url, init]] of upstream.mock.calls.entries()) {
        expect(String(url)).toBe(
          index
            ? 'http://127.0.0.2:42000/imported/responses'
            : 'https://chatgpt.com/backend-api/codex/responses'
        )
        const headers = new Headers(init?.headers)
        expect(headers.get('authorization')).toBe(
          index ? 'Bearer private-token-two' : 'Bearer private-token-one'
        )
        expect(headers.get('ChatGPT-Account-Id')).toBe('account-one')
        expect(headers.get('cookie')).toBeNull()
        expect(init?.redirect).toBe('error')
        expect(init?.credentials).toBe('omit')
        expect(JSON.parse(String(init?.body))).toEqual({
          model: 'model-a',
          store: false,
          stream: true,
          input,
          tools,
          instructions: 'Instructions',
          reasoning: { effort: 'high' }
        })
      }
    } finally {
      await lease.release()
    }
    await expect(sendCodexRequest(lease.connection)).rejects.toThrow()
  })

  it('returns sanitized Codex 401 errors without retrying or caching an expired credential', async () => {
    const resolve = vi.fn(async () => ({
      endpoint: 'https://chatgpt.com/backend-api/codex/responses',
      accessToken: 'PRIVATE_CREDENTIAL',
      accountId: 'PRIVATE_ACCOUNT'
    }))
    const upstream = vi.fn<typeof fetch>(async () =>
      Response.json(
        { error: { code: 'invalid_api_key', message: 'PRIVATE_CREDENTIAL PRIVATE_ACCOUNT' } },
        { status: 401, headers: { 'x-private-header': 'PRIVATE_CREDENTIAL' } }
      )
    )
    const owner = new ProviderTransportOwner({
      bindCodexHarnessConnection: () => resolve,
      createProtocolForwardingBridge: (targets, id, options) =>
        new ProtocolForwardingBridge(targets, id, upstream, options)
    })
    const lease = await owner.acquireHarness(makeCodexHarnessTarget(), new AbortController().signal)
    try {
      for (let index = 0; index < 2; index++) {
        const response = await sendCodexRequest(lease.connection)
        expect(response.status).toBe(401)
        expect(response.headers.get('x-private-header')).toBeNull()
        const text = await response.text()
        expect(text).toContain('invalid_api_key')
        expect(text).not.toMatch(/PRIVATE_CREDENTIAL|PRIVATE_ACCOUNT/)
        expect(upstream).toHaveBeenCalledTimes(index + 1)
      }
      expect(resolve).toHaveBeenCalledTimes(3)
    } finally {
      await lease.release()
    }
  })

  it.each([
    'https://evil.example/responses',
    'https://chatgpt.com/backend-api/codex/responses?key=PRIVATE_CREDENTIAL',
    'https://PRIVATE_CREDENTIAL@chatgpt.com/backend-api/codex/responses',
    'http://remote.example/responses',
    'file:///tmp/responses'
  ])('rejects an unapproved Codex endpoint without sending credentials: %s', async (endpoint) => {
    const upstream = vi.fn<typeof fetch>()
    const owner = new ProviderTransportOwner({
      bindCodexHarnessConnection: () => async () => ({
        endpoint,
        accessToken: 'PRIVATE_CREDENTIAL',
        accountId: 'PRIVATE_ACCOUNT'
      }),
      createProtocolForwardingBridge: (targets, id, options) =>
        new ProtocolForwardingBridge(targets, id, upstream, options)
    })
    await expect(
      owner.acquireHarness(makeCodexHarnessTarget(), new AbortController().signal)
    ).rejects.toThrow('Invalid Codex harness endpoint.')
    expect(upstream).not.toHaveBeenCalled()
  })

  it('does not follow a Codex redirect or expose its location to the ACP client', async () => {
    const upstream = vi.fn<typeof fetch>(
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example/private' } })
    )
    const owner = new ProviderTransportOwner({
      bindCodexHarnessConnection: () => async () => ({
        endpoint: 'https://chatgpt.com/backend-api/codex/responses',
        accessToken: 'private',
        accountId: 'account'
      }),
      createProtocolForwardingBridge: (targets, id, options) =>
        new ProtocolForwardingBridge(targets, id, upstream, options)
    })
    const lease = await owner.acquireHarness(makeCodexHarnessTarget(), new AbortController().signal)
    try {
      const response = await sendCodexRequest(lease.connection)
      expect(response.status).toBe(502)
      expect(response.headers.get('location')).toBeNull()
      expect(upstream).toHaveBeenCalledOnce()
      expect(upstream.mock.calls[0][1]?.redirect).toBe('error')
    } finally {
      await lease.release()
    }
  })

  it('cancels Codex credential resolution on lease release before credentials reach upstream', async () => {
    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let requestSignal!: AbortSignal
    const upstream = vi.fn<typeof fetch>()
    let resolving = 0
    const owner = new ProviderTransportOwner({
      bindCodexHarnessConnection: () => async (signal) => {
        if (resolving++ === 0)
          return {
            endpoint: 'https://chatgpt.com/backend-api/codex/responses',
            accessToken: 'private',
            accountId: 'account'
          }
        requestSignal = signal
        resolveStarted()
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('PRIVATE_CREDENTIAL')), {
            once: true
          })
        })
        return { endpoint: '', accessToken: '', accountId: '' }
      },
      createProtocolForwardingBridge: (targets, id, options) =>
        new ProtocolForwardingBridge(targets, id, upstream, options)
    })
    const lease = await owner.acquireHarness(makeCodexHarnessTarget(), new AbortController().signal)
    const pending = sendCodexRequest(lease.connection).then(
      (response) => response.text(),
      () => 'closed'
    )
    await started
    await lease.release()
    expect(requestSignal.aborted).toBe(true)
    expect(await pending).not.toContain('PRIVATE_CREDENTIAL')
    expect(upstream).not.toHaveBeenCalled()
  })

  it('requires a host-owned authentication binder for Codex subscription leases', async () => {
    const createBridge = vi.fn(() => makeOpenAiBridge(0))
    const owner = new ProviderTransportOwner({ createProtocolForwardingBridge: createBridge })
    await expect(
      owner.acquireHarness(makeCodexHarnessTarget(), new AbortController().signal)
    ).rejects.toThrow()
    expect(createBridge).not.toHaveBeenCalled()
  })

  it('stops a revoked Codex lease before forwarding and hides authentication diagnostics', async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({
        endpoint: 'https://chatgpt.com/backend-api/codex/responses',
        accessToken: 'PRIVATE_CREDENTIAL',
        accountId: 'PRIVATE_ACCOUNT'
      })
      .mockRejectedValue(new Error('Revoked PRIVATE_CREDENTIAL PRIVATE_ACCOUNT'))
    const upstream = vi.fn<typeof fetch>()
    const owner = new ProviderTransportOwner({
      bindCodexHarnessConnection: () => resolve,
      createProtocolForwardingBridge: (targets, id, options) =>
        new ProtocolForwardingBridge(targets, id, upstream, options)
    })
    const lease = await owner.acquireHarness(makeCodexHarnessTarget(), new AbortController().signal)
    try {
      const response = await sendCodexRequest(lease.connection)
      expect(response.status).toBe(502)
      expect(await response.text()).not.toMatch(/PRIVATE_CREDENTIAL|PRIVATE_ACCOUNT/)
      expect(upstream).not.toHaveBeenCalled()
    } finally {
      await lease.release()
    }
  })

  it('does not send late credentials after a client cancels the request', async () => {
    const credentials = {
      endpoint: 'https://chatgpt.com/backend-api/codex/responses',
      accessToken: 'private',
      accountId: 'account'
    }
    let finish!: (value: typeof credentials) => void
    let started!: () => void
    const accepted = new Promise<void>((resolve) => {
      started = resolve
    })
    let requestSignal!: AbortSignal
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(credentials)
      .mockImplementationOnce((signal: AbortSignal) => {
        requestSignal = signal
        started()
        return new Promise((resolve) => {
          finish = resolve
        })
      })
    const upstream = vi.fn<typeof fetch>()
    const owner = new ProviderTransportOwner({
      bindCodexHarnessConnection: () => resolve,
      createProtocolForwardingBridge: (targets, id, options) =>
        new ProtocolForwardingBridge(targets, id, upstream, options)
    })
    const lease = await owner.acquireHarness(makeCodexHarnessTarget(), new AbortController().signal)
    try {
      const controller = new AbortController()
      const pending = sendCodexRequest(lease.connection, {}, controller.signal)
      const result = pending.catch(() => undefined)
      await accepted
      const aborted = new Promise<void>((resolve) => {
        requestSignal.addEventListener('abort', () => resolve(), { once: true })
      })
      controller.abort()
      await aborted
      finish(credentials)
      await result
      expect(upstream).not.toHaveBeenCalled()
    } finally {
      await lease.release()
    }
  })

  it.each(['responses', 'messages'] as const)(
    'forwards native %s without conversion and revokes the lease',
    async (wire) => {
      const upstream = vi.fn<typeof fetch>(
        async () =>
          new Response('data: {"native":true}\n\n', {
            headers: { 'content-type': 'text/event-stream' }
          })
      )
      const owner = new ProviderTransportOwner({
        createProtocolForwardingBridge: (targets, id, options) =>
          new ProtocolForwardingBridge(targets, id, upstream, options),
        createMessagesBridge: (targets, id, options) =>
          new MessagesBridge(targets, id, upstream, undefined, options)
      })
      const target = makeHarnessTarget()
      target.apiEndpoints = [wire]
      target.provider = { ...target.provider, vendorId: 'anthropic', apiEndpoints: [wire] }
      const lease = await owner.acquireHarness(target, new AbortController().signal)
      try {
        expect(lease.route.protocol).toBe(wire)
        const path = `${lease.connection.baseUrl}/v1/${wire}`
        expect(
          (
            await fetch(path, {
              method: 'POST',
              headers: { authorization: 'Bearer wrong' },
              body: '{}'
            })
          ).status
        ).toBe(401)
        expect(upstream).not.toHaveBeenCalled()
        const image = {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'AA==' }
        }
        const native =
          wire === 'messages'
            ? { messages: [{ role: 'user', content: [image] }], max_tokens: 64 }
            : {
                input: [
                  {
                    role: 'user',
                    content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }]
                  }
                ]
              }
        const result = await fetch(path, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${lease.connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ ...native, model: 'override', stream: true })
        })
        expect(await result.text()).toBe('data: {"native":true}\n\n')
        const [url, init] = upstream.mock.calls[0]
        expect(String(url)).toBe(`https://provider.example/v1/${wire}`)
        expect(JSON.parse(String(init?.body))).toMatchObject({
          ...native,
          model: 'model-a',
          stream: true
        })
        const headers = new Headers(init?.headers)
        expect(headers.get(wire === 'messages' ? 'x-api-key' : 'authorization')).toBe(
          wire === 'messages' ? 'plain-provider-key' : 'Bearer plain-provider-key'
        )
      } finally {
        await lease.release()
      }
      await expect(fetch(`${lease.connection.baseUrl}/v1/${wire}`)).rejects.toThrow()
    }
  )

  it('selects native Responses with the host-owned xAI OAuth owner', async () => {
    const bridge = { ...makeOpenAiBridge(0), clearErrorReplay: vi.fn() }
    const createXaiOAuthProviderBridge = vi.fn(
      () =>
        bridge as unknown as ReturnType<
          NonNullable<ProviderTransportOwnerOptions['createXaiOAuthProviderBridge']>
        >
    )
    const getXaiOAuthAccessToken = vi.fn(async () => 'private')
    const owner = new ProviderTransportOwner({
      createXaiOAuthProviderBridge,
      getXaiOAuthAccessToken
    })
    const target = makeHarnessTarget()
    target.providerType = 'xai-subscription'
    target.provider = { ...target.provider, type: 'xai-subscription', key: undefined }
    target.apiEndpoints = ['messages', 'chat-completions', 'responses']
    const lease = await owner.acquireHarness(target, new AbortController().signal)
    expect(lease.route.protocol).toBe('responses')
    expect(createXaiOAuthProviderBridge).toHaveBeenCalledWith(
      [{ id: lease.route.id, model: 'model-a' }],
      lease.route.id,
      'responses',
      getXaiOAuthAccessToken
    )
    await lease.release()
    expect(bridge.close).toHaveBeenCalledOnce()
  })

  it.each([
    { providerType: 'claude-subscription' },
    { disconnectedAt: 1 },
    { configRevision: undefined },
    { configRevision: -1 },
    { configRevision: 1.5 },
    { providerId: '' },
    { apiEndpoints: [] },
    { effectiveModel: ' ' },
    { provider: { ...makeTarget().provider, type: 'xai-subscription' } },
    { provider: { ...makeTarget().provider, baseUrl: '', chatCompletionsBaseUrl: '' } },
    { provider: { ...makeTarget().provider, chatCompletionsBaseUrl: 'file:///tmp/model' } },
    {
      provider: {
        ...makeTarget().provider,
        chatCompletionsBaseUrl: 'https://user:secret@example.test'
      }
    }
  ])(
    'rejects unsupported or incomplete targets before opening a connection: %j',
    async (override) => {
      const createBridge = vi.fn(() => makeOpenAiBridge(0))
      const owner = new ProviderTransportOwner({ createProtocolForwardingBridge: createBridge })
      await expect(
        owner.acquireHarness(
          { ...makeHarnessTarget(), ...override } as ProviderRuntimeTarget,
          new AbortController().signal
        )
      ).rejects.toThrow()
      expect(createBridge).not.toHaveBeenCalled()
    }
  )

  it('snapshots the route and health target without exposing upstream credentials', async () => {
    const bridge = makeOpenAiBridge(0)
    const observe = vi.fn()
    let targets: readonly ProtocolForwardingBridgeTarget[] = []
    const owner = new ProviderTransportOwner({
      createProtocolForwardingBridge: (value) => {
        targets = value
        return bridge
      },
      onProviderFailure: observe,
      nextGenerationId: () => 'harness-generation'
    })
    const target = makeHarnessTarget()
    const acquiring = owner.acquireHarness(target, new AbortController().signal)
    target.configRevision = 4
    target.provider.key = 'new-key'
    const lease = await acquiring
    expect(lease.route).toEqual({
      id: 'harness-generation',
      providerId: 'provider-a',
      configRevision: 3,
      model: 'model-a',
      protocol: 'chat-completions'
    })
    expect(targets[0]).toMatchObject({
      endpoint: 'https://provider.example/v1/chat/completions',
      model: 'model-a',
      key: 'plain-provider-key'
    })
    expect(JSON.stringify(lease)).not.toMatch(/plain-provider-key|new-key|provider\.example/)
    expect(Object.isFrozen(lease.route)).toBe(true)
    expect(Object.isFrozen(lease.connection)).toBe(true)
    const failure = {
      category: 'auth' as const,
      status: 401,
      startedAt: 1,
      endpoint: 'chat-completions' as const,
      model: 'model-a'
    }
    await targets[0]?.onProviderFailure?.(failure)
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        configRevision: 3,
        provider: expect.objectContaining({ key: 'plain-provider-key' })
      }),
      failure
    )
    const firstRelease = lease.release()
    expect(lease.release()).toBe(firstRelease)
    await firstRelease
    expect(bridge.close).toHaveBeenCalledTimes(1)
  })

  it('rejects pre-cancelled acquisition and cleans up a start cancelled before it resolves', async () => {
    const controller = new AbortController()
    const bridge = makeOpenAiBridge(0)
    const owner = new ProviderTransportOwner({ createProtocolForwardingBridge: () => bridge })
    controller.abort()
    await expect(owner.acquireHarness(makeHarnessTarget(), controller.signal)).rejects.toThrow()
    expect(bridge.start).not.toHaveBeenCalled()
    const duringStart = new AbortController()
    let finish!: (value: { baseUrl: string; token: string }) => void
    vi.mocked(bridge.start).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const acquiring = owner.acquireHarness(makeHarnessTarget(), duringStart.signal)
    duringStart.abort()
    finish({ baseUrl: 'http://127.0.0.1:44000', token: 'local' })
    await expect(acquiring).rejects.toThrow()
    expect(bridge.close).toHaveBeenCalledTimes(1)
  })

  it('preserves both startup and cleanup errors', async () => {
    const startError = new Error('start failed')
    const closeError = new Error('close failed')
    const bridge = makeOpenAiBridge(0, startError)
    vi.mocked(bridge.close).mockRejectedValue(closeError)
    const owner = new ProviderTransportOwner({ createProtocolForwardingBridge: () => bridge })
    await expect(
      owner.acquireHarness(makeHarnessTarget(), new AbortController().signal)
    ).rejects.toMatchObject({ errors: [startError, closeError] })
    expect(bridge.close).toHaveBeenCalledTimes(1)
  })

  it('keeps release failures observable to every caller', async () => {
    const bridge = makeOpenAiBridge(0)
    const closeError = new Error('close failed')
    vi.mocked(bridge.close).mockRejectedValue(closeError)
    const owner = new ProviderTransportOwner({ createProtocolForwardingBridge: () => bridge })
    const lease = await owner.acquireHarness(makeHarnessTarget(), new AbortController().signal)
    await expect(lease.release()).rejects.toBe(closeError)
    await expect(lease.release()).rejects.toBe(closeError)
    expect(bridge.close).toHaveBeenCalledTimes(1)
  })

  it('authenticates loopback tool exchanges, pins the model, and isolates generations', async () => {
    const upstreamFetch = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer plain-provider-key')
      const request = JSON.parse(String(init?.body))
      expect(request.model).toBe('model-a')
      if (request.messages.at(-1)?.role === 'tool') {
        expect(request.messages.at(-1)).toMatchObject({ tool_call_id: 'call-1', content: '42' })
        return Response.json({
          choices: [{ message: { role: 'assistant', content: '42 rows' } }],
          usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 }
        })
      }
      return Response.json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'count_rows', arguments: '{}' }
                }
              ]
            }
          }
        ]
      })
    })
    const owner = new ProviderTransportOwner({
      createProtocolForwardingBridge: (targets, id) =>
        new ProtocolForwardingBridge(targets, id, upstreamFetch)
    })
    const first = await owner.acquireHarness(makeHarnessTarget(), new AbortController().signal)
    const second = await owner.acquireHarness(makeHarnessTarget(), new AbortController().signal)
    const send = (token: string, messages: unknown[]): Promise<Response> =>
      fetch(`${second.connection.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'caller-cannot-switch-model', messages })
      })
    try {
      expect(first.route.id).not.toBe(second.route.id)
      expect((await send(first.connection.token, [])).status).toBe(401)
      expect(upstreamFetch).not.toHaveBeenCalled()
      await first.release()
      const messages: unknown[] = [{ role: 'user', content: 'Count the rows' }]
      const response = await send(second.connection.token, messages)
      const toolCall = (await response.json()).choices[0].message
      expect(toolCall.tool_calls[0].function.name).toBe('count_rows')
      messages.push(toolCall, { role: 'tool', tool_call_id: 'call-1', content: '42' })
      const result = await (await send(second.connection.token, messages)).json()
      expect(result.choices[0].message.content).toBe('42 rows')
      expect(result.usage.total_tokens).toBe(23)
      expect(upstreamFetch).toHaveBeenCalledTimes(2)
    } finally {
      await Promise.all([first.release(), second.release()])
    }
    await expect(send(second.connection.token, [])).rejects.toThrow()
  })
})

describe('ProviderTransportOwner generations', () => {
  it('routes only CodeBuddy model traffic through its image-normalizing bridge', async () => {
    const selector = makeResponsesToChatCompletionsBridge(0)
    const bridge = makeOpenAiBridge(0)
    let targets: readonly ProtocolForwardingBridgeTarget[] = []
    const createResponsesToChatCompletionsBridge = vi.fn(() => selector)
    const owner = new ProviderTransportOwner({
      createResponsesToChatCompletionsBridge,
      createProtocolForwardingBridge: (registered) => {
        targets = registered
        return bridge
      }
    })
    const target = makeTarget()
    const plan: BackendRoutePlan = {
      ...makePlan({ kind: 'direct' }),
      modelRoute: 'codebuddy-openai'
    }

    const generation = await owner.acquire({ activeTarget: target, plan })
    await generation.providerTransportLease?.selectSkills?.('use pubmed', [])

    expect(selector.start).not.toHaveBeenCalled()
    expect(createResponsesToChatCompletionsBridge).toHaveBeenCalledWith(expect.any(Object), {
      skillSelectorFailureMode: 'throw'
    })
    expect(selector.selectSkills).toHaveBeenCalledWith('use pubmed', [], undefined, undefined)
    expect(bridge.start).toHaveBeenCalledOnce()
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({
      wire: 'chat-completions',
      endpoint: 'https://provider.example/v1/chat/completions',
      key: 'plain-provider-key',
      model: 'model-a',
      adaptRequest: expect.any(Function)
    })
    expect(generation.provider).toMatchObject({
      chatCompletionsBaseUrl: 'http://127.0.0.1:44000/v1',
      key: 'openai-token-0',
      model: 'model-a'
    })
    expect(generation.providerConfiguration).toBeUndefined()
    expect(generation.environment?.NO_PROXY).toBe(generation.environment?.no_proxy)
    await generation.release()
    expect(selector.close).toHaveBeenCalledOnce()
    expect(bridge.close).toHaveBeenCalledOnce()
  })

  it('routes CodeBuddy xAI subscription traffic through the OAuth bridge', async () => {
    const selector = makeResponsesToChatCompletionsBridge(0)
    const oauthBridge = makeOpenAiBridge(0)
    const openAiBridge = makeOpenAiBridge(1)
    const createXaiOAuthProviderBridge = vi.fn(() => oauthBridge as never)
    const createProtocolForwardingBridge = vi.fn(() => openAiBridge)
    const createResponsesToChatCompletionsBridge = vi.fn(() => selector)
    const getXaiOAuthAccessToken = vi.fn(async () => 'oauth-access-token')
    const owner = new ProviderTransportOwner({
      createResponsesToChatCompletionsBridge,
      createProtocolForwardingBridge,
      createXaiOAuthProviderBridge,
      getXaiOAuthAccessToken
    })
    const base = makeTarget()
    const activeTarget: ProviderRuntimeTarget = {
      ...base,
      providerId: 'builtin-xai-subscription',
      providerType: 'xai-subscription',
      provider: {
        ...base.provider,
        type: 'xai-subscription',
        vendorId: 'xai',
        key: undefined,
        model: 'grok-4.6'
      },
      effectiveModel: 'grok-4.6'
    }

    const generation = await owner.acquire({
      activeTarget,
      plan: {
        ...makePlan({ kind: 'direct' }),
        modelRoute: 'codebuddy-openai'
      }
    })

    expect(createXaiOAuthProviderBridge).toHaveBeenCalledWith(
      [{ id: expect.any(String), model: 'grok-4.6' }],
      expect.any(String),
      'chat-completions',
      getXaiOAuthAccessToken,
      expect.objectContaining({ adaptChatCompletionsRequest: expect.any(Function) })
    )
    expect(createProtocolForwardingBridge).not.toHaveBeenCalled()
    expect(createResponsesToChatCompletionsBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'http://127.0.0.1:44000/v1',
        key: 'openai-token-0'
      }),
      { skillSelectorFailureMode: 'throw' }
    )
    await generation.release()
  })

  it('closes both CodeBuddy transports when its model bridge fails to start', async () => {
    const startError = new Error('CodeBuddy bridge start failed')
    const selector = makeResponsesToChatCompletionsBridge(0)
    const bridge = makeOpenAiBridge(0, startError)
    const owner = new ProviderTransportOwner({
      createResponsesToChatCompletionsBridge: () => selector,
      createProtocolForwardingBridge: () => bridge
    })

    await expect(
      owner.acquire({
        activeTarget: makeTarget(),
        plan: {
          ...makePlan({ kind: 'direct' }),
          modelRoute: 'codebuddy-openai'
        }
      })
    ).rejects.toBe(startError)

    expect(bridge.close).toHaveBeenCalledOnce()
    expect(selector.close).toHaveBeenCalledOnce()
  })

  it.each([
    {
      wire: 'responses' as const,
      apiEndpoints: ['responses'] as const,
      endpoint: 'https://provider.example/v1/responses'
    },
    {
      wire: 'messages' as const,
      apiEndpoints: ['messages'] as const,
      endpoint: 'https://provider.example/v1/messages'
    }
  ])('routes a $wire-only CodeBuddy provider through Chat compatibility', async (testCase) => {
    const selector = makeResponsesToChatCompletionsBridge(0)
    const bridge = makeChatCompatibilityBridge()
    let compatibilityTarget: ChatCompletionsCompatibilityTarget | undefined
    const createResponsesToChatCompletionsBridge = vi.fn(() => selector)
    const owner = new ProviderTransportOwner({
      createResponsesToChatCompletionsBridge,
      createChatCompletionsCompatibilityBridge: (target) => {
        compatibilityTarget = target
        return bridge
      }
    })
    const activeTarget: ProviderRuntimeTarget = {
      ...makeTarget(),
      apiEndpoints: [...testCase.apiEndpoints],
      provider: {
        ...makeTarget().provider,
        apiEndpoints: [...testCase.apiEndpoints],
        chatCompletionsBaseUrl: 'https://provider.example/v1'
      },
      needsChatResponsesToChatCompletionsBridge: true
    }
    const generation = await owner.acquire({
      activeTarget,
      plan: {
        ...makePlan({ kind: 'codebuddy-provider-compatibility', wire: testCase.wire }),
        modelRoute: 'codebuddy-openai'
      }
    })

    expect(compatibilityTarget).toMatchObject({
      wire: testCase.wire,
      endpoint: testCase.endpoint,
      model: 'model-a',
      key: 'plain-provider-key',
      adaptRequest: expect.any(Function)
    })
    expect(createResponsesToChatCompletionsBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'http://127.0.0.1:45000/v1',
        key: 'chat-compatibility-token'
      }),
      { skillSelectorFailureMode: 'throw' }
    )
    expect(generation.provider).toMatchObject({
      chatCompletionsBaseUrl: 'http://127.0.0.1:45000/v1',
      apiEndpoints: ['chat-completions']
    })
    await generation.release()
    expect(bridge.close).toHaveBeenCalledOnce()
    expect(selector.close).toHaveBeenCalledOnce()
  })

  it('creates independent Responses generations and releases each idempotently', async () => {
    const bridges: ReturnType<typeof makeResponsesToChatCompletionsBridge>[] = []
    let generation = 0
    const owner = new ProviderTransportOwner({
      createResponsesToChatCompletionsBridge: () => {
        const bridge = makeResponsesToChatCompletionsBridge(bridges.length)
        bridges.push(bridge)
        return bridge
      },
      nextGenerationId: () => `generation-${++generation}`
    })
    const request = {
      activeTarget: makeTarget(),
      plan: makePlan({ kind: 'codex-chat', targets: [] })
    }

    const first = await owner.acquire(request)
    const second = await owner.acquire(request)
    first.responsesConnection?.lease.setReasoningEffort?.('low')
    second.responsesConnection?.lease.setReasoningEffort?.('high')
    first.responsesConnection?.lease.registerHostMessageSession?.('side-session', [], {
      failClosedUnknownKeys: true
    })
    await first.release()
    await first.release()
    await second.release()

    expect(bridges).toHaveLength(2)
    expect(bridges[0]?.setReasoningEffort).toHaveBeenCalledWith('low')
    expect(bridges[0]?.setReasoningEffort).not.toHaveBeenCalledWith('high')
    expect(bridges[1]?.setReasoningEffort).toHaveBeenCalledWith('high')
    expect(bridges[0]?.registerHostMessageSession).toHaveBeenCalledWith('side-session', [], {
      failClosedUnknownKeys: true
    })
    expect(bridges[1]?.registerHostMessageSession).not.toHaveBeenCalled()
    expect(bridges[0]?.close).toHaveBeenCalledTimes(1)
    expect(bridges[1]?.close).toHaveBeenCalledTimes(1)
  })

  it('isolates native compatibility host-message scopes between generations', async () => {
    const proxies: NativeProxyStub[] = []
    const owner = new ProviderTransportOwner({
      createNativeResponsesProxy: () => {
        const proxy = makeNativeProxy()
        proxies.push(proxy)
        return proxy
      }
    })
    const request = {
      activeTarget: {
        ...makeTarget(),
        needsChatResponsesToChatCompletionsBridge: false,
        needsNativeResponsesCompatibility: true
      },
      plan: makePlan({ kind: 'codex-responses-compatibility' as const, targets: [] })
    }

    const first = await owner.acquire(request)
    const second = await owner.acquire(request)
    first.responsesConnection?.lease.registerHostMessageSession?.('side-session', [], {
      failClosedUnknownKeys: true
    })

    expect(proxies).toHaveLength(2)
    expect(proxies[0]?.registerHostMessageSession).toHaveBeenCalledWith('side-session', [], {
      failClosedUnknownKeys: true
    })
    expect(proxies[1]?.registerHostMessageSession).not.toHaveBeenCalled()

    await first.release()
    await second.release()
    expect(proxies[0]?.close).toHaveBeenCalledOnce()
    expect(proxies[1]?.close).toHaveBeenCalledOnce()
  })

  it('uses the native Responses base for compatibility targets', async () => {
    const proxy = makeNativeProxy()
    let targetBaseUrl: string | undefined
    let targetVendorId: string | undefined
    const owner = new ProviderTransportOwner({
      createNativeResponsesProxy: (target) => {
        targetBaseUrl = target.baseUrl
        targetVendorId = target.vendorId
        return proxy
      }
    })
    const activeTarget: ProviderRuntimeTarget = {
      ...makeTarget(),
      needsChatResponsesToChatCompletionsBridge: false,
      needsNativeResponsesCompatibility: true,
      apiEndpoints: ['responses'],
      provider: {
        ...makeTarget().provider,
        apiEndpoints: ['responses'],
        vendorId: 'deepseek',
        chatCompletionsBaseUrl: 'https://api.deepseek.com/v1',
        responsesBaseUrl: 'https://api.deepseek.com'
      }
    }

    const generation = await owner.acquire({
      activeTarget,
      plan: makePlan({ kind: 'codex-responses-compatibility', targets: [] })
    })

    expect(targetBaseUrl).toBe('https://api.deepseek.com')
    expect(targetVendorId).toBe('deepseek')
    await generation.release()
  })

  it('closes a half-started native compatibility generation and preserves its start error', async () => {
    const startError = new Error('native compatibility start failed')
    const closeError = new Error('native compatibility close failed')
    const proxy = makeNativeProxy(startError, closeError)
    const owner = new ProviderTransportOwner({
      createNativeResponsesProxy: () => proxy,
      nextGenerationId: () => 'native-generation'
    })

    await expect(
      owner.acquire({
        activeTarget: {
          ...makeTarget(),
          needsChatResponsesToChatCompletionsBridge: false,
          needsNativeResponsesCompatibility: true
        },
        plan: makePlan({ kind: 'codex-responses-compatibility', targets: [] })
      })
    ).rejects.toBe(startError)

    expect(proxy.close).toHaveBeenCalledTimes(1)
  })

  it('owns Claude bridge credentials, retargeting, bypass aliases, and idempotent release', async () => {
    const bridge = makeMessagesBridge()
    const owner = new ProviderTransportOwner({
      createMessagesBridge: () => bridge
    })

    const generation = await owner.acquire({
      activeTarget: makeTarget(),
      plan: makePlan({
        kind: 'claude-anthropic',
        targets: [
          {
            id: 'provider-a/model-a',
            baseUrl: 'https://provider.example',
            key: 'plain-provider-key',
            model: 'model-a'
          }
        ],
        initialTargetId: 'provider-a/model-a'
      })
    })

    expect(generation.environment).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:43000',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-bridge-token',
      ANTHROPIC_API_KEY: 'anthropic-bridge-token'
    })
    expect(generation.providerConfiguration).toEqual({
      providerId: 'main',
      apiType: 'anthropic',
      baseUrl: 'http://127.0.0.1:43000',
      headers: { 'x-api-key': 'anthropic-bridge-token' }
    })
    expect(generation.environment?.NO_PROXY).toBe(generation.environment?.no_proxy)
    expect(generation.messagesBridgeLease?.setTarget('provider-a/model-a')).toBe(true)
    await generation.release()
    await generation.messagesBridgeLease?.release()

    expect(bridge.setTarget).toHaveBeenCalledWith('provider-a/model-a')
    expect(bridge.close).toHaveBeenCalledTimes(1)
  })

  it('closes every OpenCode bridge after a partial multi-provider start failure', async () => {
    const startError = new Error('second OpenCode bridge failed')
    const bridges = [makeOpenAiBridge(0), makeOpenAiBridge(1, startError)]
    let bridgeIndex = 0
    const owner = new ProviderTransportOwner({
      createProtocolForwardingBridge: () => bridges[bridgeIndex++]!
    })
    const targetA = makeTarget()
    const targetB: ProviderRuntimeTarget = {
      ...makeTarget(),
      providerId: 'provider-b',
      effectiveModel: 'model-b',
      provider: { ...makeTarget().provider, model: 'model-b' }
    }

    await expect(
      owner.acquire({
        activeTarget: targetA,
        plan: {
          ...makePlan({ kind: 'direct' }),
          modelRoute: 'opencode-openai',
          transport: {
            kind: 'opencode-openai',
            targets: [
              { id: 'opencode/provider-a/model-a', target: targetA },
              { id: 'opencode/provider-b/model-b', target: targetB }
            ]
          }
        }
      })
    ).rejects.toBe(startError)

    expect(bridges[0]?.close).toHaveBeenCalledTimes(1)
    expect(bridges[1]?.close).toHaveBeenCalledTimes(1)
  })

  it('uses TokenHub x-api-key authentication for OpenCode Anthropic traffic', async () => {
    const bridge = makeMessagesBridge()
    let targets: readonly MessagesBridgeTarget[] = []
    const owner = new ProviderTransportOwner({
      createMessagesBridge: (registered) => {
        targets = registered
        return bridge
      }
    })
    const target: ProviderRuntimeTarget = {
      ...makeTarget(),
      apiEndpoints: ['messages'],
      needsChatResponsesToChatCompletionsBridge: false,
      provider: {
        ...makeTarget().provider,
        vendorId: 'tencent',
        apiEndpoints: ['messages']
      }
    }

    const generation = await owner.acquire({
      activeTarget: target,
      plan: {
        ...makePlan({ kind: 'direct' }),
        modelRoute: 'opencode-anthropic',
        transport: {
          kind: 'opencode-anthropic',
          targets: [{ id: 'opencode/provider-a/model-a', target }]
        }
      }
    })

    expect(targets).toEqual([
      expect.objectContaining({
        baseUrl: 'https://provider.example',
        key: 'plain-provider-key',
        model: 'model-a',
        useApiKeyHeader: true
      })
    ])
    await generation.release()
  })

  it('invalidates OpenCode replay caches across A to B to A target changes', async () => {
    const upstreamFetch = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string }
      return body.model === 'model-a'
        ? Response.json({ error: { message: 'Invalid model-a request' } }, { status: 400 })
        : Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] })
    })
    const owner = new ProviderTransportOwner({
      createProtocolForwardingBridge: (targets, initialTargetId) => {
        expect(
          targets.every((target) => target.adaptStream === bufferChatCompletionsToolNames)
        ).toBe(true)
        return new ProtocolForwardingBridge(targets, initialTargetId, upstreamFetch)
      }
    })
    const targetA = makeTarget()
    const targetB: ProviderRuntimeTarget = {
      ...makeTarget(),
      providerId: 'provider-b',
      effectiveModel: 'model-b',
      provider: { ...makeTarget().provider, model: 'model-b' }
    }
    const targetAId = 'opencode/provider-a/model-a'
    const targetBId = 'opencode/provider-b/model-b'
    const generation = await owner.acquire({
      activeTarget: targetA,
      plan: {
        ...makePlan({ kind: 'direct' }),
        modelRoute: 'opencode-openai',
        transport: {
          kind: 'opencode-openai',
          targets: [
            { id: targetAId, target: targetA },
            { id: targetBId, target: targetB }
          ]
        }
      }
    })
    const providerA = generation.providerModelCatalog?.find(
      ({ provider }) => provider.model === 'model-a'
    )?.provider
    expect(generation.providerConfiguration).toBeUndefined()
    if (!providerA?.chatCompletionsBaseUrl || !providerA.key)
      throw new Error('Missing provider A loopback')
    const sendA = (): Promise<Response> =>
      fetch(`${providerA.chatCompletionsBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${providerA.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'ignored', messages: [] })
      })

    try {
      expect((await sendA()).status).toBe(400)
      expect(generation.providerTransportLease?.setTarget(targetBId)).toBe(true)
      expect(generation.providerTransportLease?.setTarget(targetAId)).toBe(true)
      expect((await sendA()).status).toBe(400)
      expect(upstreamFetch).toHaveBeenCalledTimes(2)
    } finally {
      await generation.release()
    }
  })

  it('owns the native Codex provider projection, retargeting, and release', async () => {
    const bridge = makeOpenAiBridge(0)
    const owner = new ProviderTransportOwner({
      createProtocolForwardingBridge: () => bridge
    })
    const activeTarget: ProviderRuntimeTarget = {
      ...makeTarget(),
      apiEndpoints: ['responses'],
      provider: { ...makeTarget().provider, apiEndpoints: ['responses'] },
      needsChatResponsesToChatCompletionsBridge: false
    }
    const initialTargetId = 'codex/provider-a/model-a'

    const generation = await owner.acquire({
      activeTarget,
      plan: {
        ...makePlan({ kind: 'direct' }),
        modelRoute: 'codex-responses',
        transport: {
          kind: 'codex-native-responses',
          targets: [{ id: initialTargetId, target: activeTarget }],
          initialTargetId
        }
      }
    })

    expect(generation.provider).toMatchObject({
      baseUrl: 'http://127.0.0.1:44000',
      chatCompletionsBaseUrl: 'http://127.0.0.1:44000/v1',
      key: 'openai-token-0',
      model: 'model-a',
      apiEndpoints: ['responses']
    })
    expect(generation.providerConfiguration).toBeUndefined()
    expect(generation.providerTransportLease?.setTarget(initialTargetId)).toBe(true)
    expect(generation.environment?.NO_PROXY).toBe(generation.environment?.no_proxy)
    await generation.release()
    await generation.providerTransportLease?.release()

    expect(bridge.setTarget).toHaveBeenCalledWith(initialTargetId)
    expect(bridge.close).toHaveBeenCalledTimes(1)
  })
})
