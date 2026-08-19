import { describe, expect, it, vi } from 'vitest'

import type { ProviderRuntimeTarget } from './provider-accounts'
import type { BackendRoutePlan, BackendTransportPlan } from './backend-route-planner'
import {
  ProviderTransportOwner,
  type ProviderTransportOwnerOptions
} from './provider-transport-owner'
import { OpenAiProviderBridge } from './openai-provider-bridge'

type ResponsesBridgeStub = ReturnType<
  NonNullable<ProviderTransportOwnerOptions['createResponsesBridge']>
>
type NativeProxyStub = ReturnType<
  NonNullable<ProviderTransportOwnerOptions['createNativeResponsesProxy']>
>
type AnthropicBridgeStub = ReturnType<
  NonNullable<ProviderTransportOwnerOptions['createAnthropicProviderBridge']>
>
type OpenAiBridgeStub = ReturnType<
  NonNullable<ProviderTransportOwnerOptions['createOpenAiProviderBridge']>
>

const makeTarget = (): ProviderRuntimeTarget => ({
  providerId: 'provider-a',
  providerType: 'custom',
  effectiveModel: 'model-a',
  apiEndpoints: ['openai'],
  provider: {
    type: 'custom',
    baseUrl: 'https://provider.example/v1',
    openaiBaseUrl: 'https://provider.example/v1',
    model: 'model-a',
    key: 'plain-provider-key',
    apiEndpoints: ['openai']
  },
  reasoningEffortProfile: {
    supported: true,
    slots: ['low', 'medium', 'high', 'xhigh', 'max']
  },
  frameworkCompatible: true,
  modelBridgeSupported: true,
  needsChatResponsesBridge: true,
  needsNativeResponsesCompatibility: false
})

const makeResponsesBridge = (index: number): ResponsesBridgeStub => ({
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

const makeAnthropicBridge = (): AnthropicBridgeStub => ({
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

describe('ProviderTransportOwner generations', () => {
  it('creates independent Responses generations and releases each idempotently', async () => {
    const bridges: ReturnType<typeof makeResponsesBridge>[] = []
    let generation = 0
    const owner = new ProviderTransportOwner({
      createResponsesBridge: () => {
        const bridge = makeResponsesBridge(bridges.length)
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
    first.responsesBridge?.lease.setReasoningEffort?.('low')
    second.responsesBridge?.lease.setReasoningEffort?.('high')
    first.responsesBridge?.lease.registerHostMessageSession?.('side-session', [], {
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
        needsChatResponsesBridge: false,
        needsNativeResponsesCompatibility: true
      },
      plan: makePlan({ kind: 'codex-responses-compatibility' as const, targets: [] })
    }

    const first = await owner.acquire(request)
    const second = await owner.acquire(request)
    first.responsesBridge?.lease.registerHostMessageSession?.('side-session', [], {
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
          needsChatResponsesBridge: false,
          needsNativeResponsesCompatibility: true
        },
        plan: makePlan({ kind: 'codex-responses-compatibility', targets: [] })
      })
    ).rejects.toBe(startError)

    expect(proxy.close).toHaveBeenCalledTimes(1)
  })

  it('owns Claude bridge credentials, retargeting, bypass aliases, and idempotent release', async () => {
    const bridge = makeAnthropicBridge()
    const owner = new ProviderTransportOwner({
      createAnthropicProviderBridge: () => bridge
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
    expect(generation.environment?.NO_PROXY).toBe(generation.environment?.no_proxy)
    expect(generation.anthropicBridgeLease?.setTarget('provider-a/model-a')).toBe(true)
    await generation.release()
    await generation.anthropicBridgeLease?.release()

    expect(bridge.setTarget).toHaveBeenCalledWith('provider-a/model-a')
    expect(bridge.close).toHaveBeenCalledTimes(1)
  })

  it('closes every OpenCode bridge after a partial multi-provider start failure', async () => {
    const startError = new Error('second OpenCode bridge failed')
    const bridges = [makeOpenAiBridge(0), makeOpenAiBridge(1, startError)]
    let bridgeIndex = 0
    const owner = new ProviderTransportOwner({
      createOpenAiProviderBridge: () => bridges[bridgeIndex++]!
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

  it('invalidates OpenCode replay caches across A to B to A target changes', async () => {
    const upstreamFetch = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string }
      return body.model === 'model-a'
        ? Response.json({ error: { message: 'Invalid model-a request' } }, { status: 400 })
        : Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] })
    })
    const owner = new ProviderTransportOwner({
      createOpenAiProviderBridge: (targets, initialTargetId) =>
        new OpenAiProviderBridge(targets, initialTargetId, upstreamFetch)
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
    if (!providerA?.openaiBaseUrl || !providerA.key) throw new Error('Missing provider A loopback')
    const sendA = (): Promise<Response> =>
      fetch(`${providerA.openaiBaseUrl}/chat/completions`, {
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
      createOpenAiProviderBridge: () => bridge
    })
    const activeTarget: ProviderRuntimeTarget = {
      ...makeTarget(),
      apiEndpoints: ['responses'],
      provider: { ...makeTarget().provider, apiEndpoints: ['responses'] },
      needsChatResponsesBridge: false
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
      openaiBaseUrl: 'http://127.0.0.1:44000/v1',
      key: 'openai-token-0',
      model: 'model-a',
      apiEndpoints: ['responses']
    })
    expect(generation.providerTransportLease?.setTarget(initialTargetId)).toBe(true)
    expect(generation.environment?.NO_PROXY).toBe(generation.environment?.no_proxy)
    await generation.release()
    await generation.providerTransportLease?.release()

    expect(bridge.setTarget).toHaveBeenCalledWith(initialTargetId)
    expect(bridge.close).toHaveBeenCalledTimes(1)
  })
})
