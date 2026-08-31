import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

import type { BackendRoutePlan } from './backend-route-planner'
import { AnthropicProviderBridge } from './anthropic-provider-bridge'
import type { ProviderRuntimeTarget } from './provider-accounts'
import { ProviderTransportOwner } from './provider-transport-owner'

const target: ProviderRuntimeTarget = {
  providerId: 'provider-a',
  providerType: 'custom',
  effectiveModel: 'model-a',
  apiEndpoints: ['anthropic'],
  provider: {
    type: 'custom',
    baseUrl: 'https://provider.example.test',
    model: 'model-a',
    key: 'synthetic-upstream-key',
    apiEndpoints: ['anthropic']
  },
  reasoningEffortProfile: { supported: false },
  frameworkCompatible: true,
  modelBridgeSupported: false,
  needsChatResponsesBridge: false,
  needsNativeResponsesCompatibility: false
}

const plan: BackendRoutePlan = {
  modelRoute: 'claude-anthropic',
  backendProviderId: target.providerId,
  sessionEffort: 'high',
  providerModelCatalog: [],
  transport: {
    kind: 'claude-anthropic',
    targets: [
      {
        id: 'provider-a/model-a',
        baseUrl: target.provider.baseUrl!,
        key: target.provider.key,
        model: 'model-a'
      }
    ],
    initialTargetId: 'provider-a/model-a'
  }
}

const customHeaders = (value: string | undefined): Record<string, string> =>
  Object.fromEntries(
    (value ?? '').split('\n').flatMap((line) => {
      const separator = line.indexOf(':')
      return separator < 0
        ? []
        : [[line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()]]
    })
  )

type ClaudeProviderConfiguration = NonNullable<
  Awaited<ReturnType<ProviderTransportOwner['acquire']>>['providerConfiguration']
>

const loadClaudeProviderEnvAdapter = (): ((
  config: ClaudeProviderConfiguration
) => Record<string, string>) => {
  const require = createRequire(import.meta.url)
  const source = readFileSync(
    require.resolve('@agentclientprotocol/claude-agent-acp/dist/acp-agent.js'),
    'utf8'
  )
  const start = source.indexOf('function createEnvForProvider(config)')
  const end = source.indexOf('\nfunction isValidBaseUrl', start)
  if (start < 0 || end < 0) throw new Error('Claude ACP provider environment adapter not found.')
  return runInNewContext(`${source.slice(start, end)}\ncreateEnvForProvider`) as (
    config: ClaudeProviderConfiguration
  ) => Record<string, string>
}

describe('Claude ACP provider configuration', () => {
  it('preserves the loopback credential through the real Claude adapter and terminalizes upstream 401', async () => {
    const upstreamFetch = vi.fn(async () =>
      Response.json(
        { error: { type: 'authentication_error', message: 'Synthetic credential rejected' } },
        { status: 401 }
      )
    )
    const owner = new ProviderTransportOwner({
      createAnthropicProviderBridge: (targets, initialTargetId) =>
        new AnthropicProviderBridge(targets, initialTargetId, upstreamFetch)
    })
    const generation = await owner.acquire({ activeTarget: target, plan })

    try {
      const adapterEnv = loadClaudeProviderEnvAdapter()(generation.providerConfiguration!)
      const headers = {
        ...customHeaders(adapterEnv.ANTHROPIC_CUSTOM_HEADERS),
        authorization: `Bearer ${adapterEnv.ANTHROPIC_AUTH_TOKEN}`,
        'content-type': 'application/json'
      }
      const send = (): Promise<Response> =>
        fetch(`${adapterEnv.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: 'ignored', messages: [] })
        })

      expect(adapterEnv.ANTHROPIC_AUTH_TOKEN).toBe('acp-proxy')
      expect(customHeaders(adapterEnv.ANTHROPIC_CUSTOM_HEADERS)).toEqual({
        'x-api-key': generation.environment?.ANTHROPIC_AUTH_TOKEN
      })

      const startedAt = performance.now()
      const first = await send()
      const second = await send()

      expect(performance.now() - startedAt).toBeLessThan(1_000)
      expect(first.status).toBe(400)
      expect(second.status).toBe(400)
      expect(first.headers.get('x-open-science-upstream-status')).toBe('401')
      expect(second.headers.get('x-open-science-upstream-status')).toBe('401')
      await expect(first.json()).resolves.toEqual({
        error: { type: 'authentication_error', message: 'Synthetic credential rejected' }
      })
      expect(upstreamFetch).toHaveBeenCalledOnce()
    } finally {
      await generation.release()
    }
  })
})
