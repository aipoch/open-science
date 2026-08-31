import { describe, expect, expectTypeOf, it } from 'vitest'

import { isModelBridgeSupported } from './provider-registry'
import {
  canonicalSessionProviderId,
  CODEX_ISOLATED_PROVIDER_ID,
  CODEX_SHARED_PROVIDER_ID,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  getCodeBuddyInstallSources,
  getCodexInstallSources,
  getOpencodeInstallSources,
  isProviderCompatibleWith,
  isProviderUsableByFramework,
  preferredEndpoint,
  providerEndpoints,
  resolveCodexSubscriptionType,
  requiresChatCompletionsBridge
} from './settings'

describe('provider endpoint compatibility', () => {
  it("derives a provider's endpoints, defaulting absent to anthropic", () => {
    expect(providerEndpoints({ apiEndpoints: ['anthropic'] })).toEqual(['anthropic'])
    expect(providerEndpoints({ apiEndpoints: ['openai'] })).toEqual(['openai'])
    expect(providerEndpoints({ apiEndpoints: ['anthropic', 'openai'] })).toEqual([
      'anthropic',
      'openai'
    ])
    expect(providerEndpoints({ apiEndpoints: ['responses'] })).toEqual(['responses'])
    // Absent/empty ⇒ anthropic.
    expect(providerEndpoints({})).toEqual(['anthropic'])
  })

  it('is compatible only when provider and framework share an endpoint', () => {
    // Claude Code speaks anthropic only.
    expect(isProviderCompatibleWith(['anthropic'], ['anthropic'])).toBe(true)
    expect(isProviderCompatibleWith(['openai'], ['anthropic'])).toBe(false)
    expect(isProviderCompatibleWith(['anthropic', 'openai'], ['anthropic'])).toBe(true)
    // OpenCode speaks both.
    expect(isProviderCompatibleWith(['openai'], ['anthropic', 'openai'])).toBe(true)
    expect(isProviderCompatibleWith(['anthropic'], ['anthropic', 'openai'])).toBe(true)
    // Codex speaks Responses, which is intentionally distinct from Chat Completions.
    expect(isProviderCompatibleWith(['responses'], ['responses'])).toBe(true)
    expect(isProviderCompatibleWith(['openai'], ['responses'])).toBe(false)
    expect(isProviderCompatibleWith(['anthropic', 'openai'], ['responses'])).toBe(false)
  })

  it('prefers the OpenAI endpoint when both sides support it (both + both → openai)', () => {
    const openCodeEndpoint = preferredEndpoint(['anthropic', 'openai'], ['anthropic', 'openai'])
    expectTypeOf(openCodeEndpoint).toEqualTypeOf<'anthropic' | 'openai' | undefined>()
    expect(openCodeEndpoint).toBe('openai')
    // A both-provider on an anthropic-only framework falls back to the shared anthropic endpoint.
    expect(preferredEndpoint(['anthropic', 'openai'], ['anthropic'])).toBe('anthropic')
    // Single-endpoint providers resolve to that endpoint when shared.
    expect(preferredEndpoint(['openai'], ['anthropic', 'openai'])).toBe('openai')
    expect(preferredEndpoint(['anthropic'], ['anthropic', 'openai'])).toBe('anthropic')
    // Incompatible pair → no endpoint.
    expect(preferredEndpoint(['openai'], ['anthropic'])).toBeUndefined()
  })

  it('allows Chat Completions providers through Codex bridge without changing endpoint identity', () => {
    const codex = { id: 'codex' as const, supportedApiTypes: ['responses'] as const }

    expect(isProviderUsableByFramework({ type: 'custom', apiEndpoints: ['openai'] }, codex)).toBe(
      true
    )
    expect(
      isProviderUsableByFramework({ type: 'custom', apiEndpoints: ['anthropic', 'openai'] }, codex)
    ).toBe(true)
    expect(
      isProviderUsableByFramework({ type: 'custom', apiEndpoints: ['responses'] }, codex)
    ).toBe(true)
  })

  it('requires the Codex bridge only when Chat Completions is the provider best route', () => {
    const codex = { id: 'codex' as const, supportedApiTypes: ['responses'] as const }

    expect(requiresChatCompletionsBridge({ apiEndpoints: ['openai'] }, codex)).toBe(true)
    expect(requiresChatCompletionsBridge({ apiEndpoints: ['anthropic', 'openai'] }, codex)).toBe(
      true
    )
    expect(requiresChatCompletionsBridge({ apiEndpoints: ['responses'] }, codex)).toBe(false)
    expect(requiresChatCompletionsBridge({ apiEndpoints: ['openai', 'responses'] }, codex)).toBe(
      false
    )
  })

  it('uses a Chat compatibility transport for CodeBuddy only when OpenAI Chat is absent', () => {
    const codebuddy = { id: 'codebuddy' as const, supportedApiTypes: ['openai'] as const }

    expect(requiresChatCompletionsBridge({ apiEndpoints: ['responses'] }, codebuddy)).toBe(true)
    expect(requiresChatCompletionsBridge({ apiEndpoints: ['anthropic'] }, codebuddy)).toBe(true)
    expect(
      requiresChatCompletionsBridge({ apiEndpoints: ['openai', 'responses'] }, codebuddy)
    ).toBe(false)
    expect(
      isProviderUsableByFramework({ type: 'custom', apiEndpoints: ['responses'] }, codebuddy)
    ).toBe(true)
    expect(
      isProviderUsableByFramework({ type: 'custom', apiEndpoints: ['anthropic'] }, codebuddy)
    ).toBe(true)
  })

  it('marks a vendor model bridge-unsupported only when the registry lists it', () => {
    // Custom providers (no vendorId) are always assumed compatible — the key is what gets tested.
    expect(isModelBridgeSupported({}, 'deepseek-v4-flash')).toBe(true)
    // An official vendor with no bridgeUnsupportedModels: every listed model converts.
    expect(isModelBridgeSupported({ vendorId: 'deepseek' }, 'deepseek-v4-flash')).toBe(true)
    // A native Responses vendor: nothing is bridged, so always supported.
    expect(isModelBridgeSupported({ vendorId: 'openai' }, 'gpt-5.5')).toBe(true)
    // Undefined model ⇒ supported (nothing to reject yet).
    expect(isModelBridgeSupported({ vendorId: 'deepseek' }, undefined)).toBe(true)
  })

  it('allows Codex subscription profiles only with the Codex framework', () => {
    const codex = { id: 'codex' as const, supportedApiTypes: ['responses'] as const }
    const claude = { id: 'claude-code' as const, supportedApiTypes: ['anthropic'] as const }
    const opencode = {
      id: 'opencode' as const,
      supportedApiTypes: ['anthropic', 'openai'] as const
    }

    for (const type of ['codex-shared', 'codex-isolated'] as const) {
      expect(isProviderUsableByFramework({ type, apiEndpoints: ['responses'] }, codex)).toBe(true)
      expect(isProviderUsableByFramework({ type, apiEndpoints: ['responses'] }, claude)).toBe(false)
      expect(isProviderUsableByFramework({ type, apiEndpoints: ['responses'] }, opencode)).toBe(
        false
      )
    }
  })
})

describe('canonicalSessionProviderId', () => {
  it('maps legacy Codex provider ids onto the stored subscription identity', () => {
    expect(canonicalSessionProviderId(CODEX_ISOLATED_PROVIDER_ID)).toBe(
      CODEX_SUBSCRIPTION_PROVIDER_ID
    )
    expect(canonicalSessionProviderId(CODEX_SHARED_PROVIDER_ID)).toBe(
      CODEX_SUBSCRIPTION_PROVIDER_ID
    )
    expect(canonicalSessionProviderId(CODEX_SUBSCRIPTION_PROVIDER_ID)).toBe(
      CODEX_SUBSCRIPTION_PROVIDER_ID
    )
    expect(canonicalSessionProviderId('custom-provider')).toBe('custom-provider')
  })
})

describe('resolveCodexSubscriptionType', () => {
  it('prefers the persisted auth mode and falls back to the legacy provider type', () => {
    expect(
      resolveCodexSubscriptionType({ type: 'codex-isolated', codexAuthMode: 'imported' })
    ).toBe('codex-shared')
    expect(
      resolveCodexSubscriptionType({ type: 'codex-isolated', codexAuthMode: 'isolated' })
    ).toBe('codex-isolated')
    expect(resolveCodexSubscriptionType({ type: 'codex-shared' })).toBe('codex-shared')
    expect(resolveCodexSubscriptionType({ type: 'codex-isolated' })).toBe('codex-isolated')
  })
})

describe('getCodexInstallSources', () => {
  it('offers only app-managed and npm-global installation', () => {
    const sources = getCodexInstallSources()

    expect(sources.map((source) => source.id)).toEqual(['managed', 'npm'])
    expect(sources[0]?.requiresNpm).toBe(false)
    expect(sources[1]?.displayCommand).toBe('npm i -g @agentclientprotocol/codex-acp')
  })
})

describe('getCodeBuddyInstallSources', () => {
  it('offers only the app-managed install', () => {
    const sources = getCodeBuddyInstallSources()

    expect(sources.map((source) => source.id)).toEqual(['managed'])
    expect(sources[0]?.requiresNpm).toBe(false)
  })
})

describe('getOpencodeInstallSources', () => {
  it('leads with the app-managed download and includes npm on every platform', () => {
    const ids = getOpencodeInstallSources('darwin').map((source) => source.id)

    expect(ids[0]).toBe('managed')
    expect(ids).toContain('npm')
    const npm = getOpencodeInstallSources('darwin').find((source) => source.id === 'npm')
    expect(npm?.displayCommand).toBe('npm i -g opencode-ai')
  })

  it('offers the shell installer off Windows', () => {
    const script = getOpencodeInstallSources('linux').find(
      (source) => source.id === 'official-script'
    )

    expect(script?.displayCommand).toBe('curl -fsSL https://opencode.ai/install | bash')
  })

  it('hides the shell installer on Windows (no official PowerShell script)', () => {
    const ids = getOpencodeInstallSources('win32').map((source) => source.id)

    expect(ids).toEqual(['managed', 'npm'])
  })
})
