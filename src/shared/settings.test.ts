import { describe, expect, it } from 'vitest'

import {
  getOpencodeInstallSources,
  isProviderCompatibleWith,
  preferredEndpoint,
  providerEndpoints
} from './settings'

describe('provider endpoint compatibility', () => {
  it('expands a provider apiType into its endpoints', () => {
    expect(providerEndpoints('anthropic')).toEqual(['anthropic'])
    expect(providerEndpoints('openai')).toEqual(['openai'])
    expect(providerEndpoints('both')).toEqual(['anthropic', 'openai'])
  })

  it('is compatible only when provider and framework share an endpoint', () => {
    // Claude Code speaks anthropic only.
    expect(isProviderCompatibleWith('anthropic', ['anthropic'])).toBe(true)
    expect(isProviderCompatibleWith('openai', ['anthropic'])).toBe(false)
    expect(isProviderCompatibleWith('both', ['anthropic'])).toBe(true)
    // OpenCode speaks both.
    expect(isProviderCompatibleWith('openai', ['anthropic', 'openai'])).toBe(true)
    expect(isProviderCompatibleWith('anthropic', ['anthropic', 'openai'])).toBe(true)
  })

  it('prefers the OpenAI endpoint when both sides support it (both + both → openai)', () => {
    expect(preferredEndpoint('both', ['anthropic', 'openai'])).toBe('openai')
    // A both-provider on an anthropic-only framework falls back to the shared anthropic endpoint.
    expect(preferredEndpoint('both', ['anthropic'])).toBe('anthropic')
    // Single-endpoint providers resolve to that endpoint when shared.
    expect(preferredEndpoint('openai', ['anthropic', 'openai'])).toBe('openai')
    expect(preferredEndpoint('anthropic', ['anthropic', 'openai'])).toBe('anthropic')
    // Incompatible pair → no endpoint.
    expect(preferredEndpoint('openai', ['anthropic'])).toBeUndefined()
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
