import { describe, expect, it } from 'vitest'

import { isModelBridgeSupported } from './provider-registry'
import {
  getCodexInstallSources,
  getOpencodeInstallSources,
  isProviderCompatibleWith,
  isProviderUsableByFramework,
  preferredEndpoint,
  providerEndpoints
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
    expect(preferredEndpoint(['anthropic', 'openai'], ['anthropic', 'openai'])).toBe('openai')
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
})

describe('getCodexInstallSources', () => {
  it('offers only app-managed and npm-global installation', () => {
    const sources = getCodexInstallSources()

    expect(sources.map((source) => source.id)).toEqual(['managed', 'npm'])
    expect(sources[0]?.requiresNpm).toBe(false)
    expect(sources[1]?.displayCommand).toBe('npm i -g @agentclientprotocol/codex-acp')
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
