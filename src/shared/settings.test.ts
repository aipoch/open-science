import { describe, expect, it } from 'vitest'

import { isProviderCompatibleWith, preferredEndpoint, providerEndpoints } from './settings'

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
