import { describe, expect, it } from 'vitest'

import { normalizeAnthropicBaseUrl } from './base-url'

describe('normalizeAnthropicBaseUrl', () => {
  it('leaves a bare gateway root untouched', () => {
    expect(normalizeAnthropicBaseUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com')
  })

  it('strips a redundant trailing /v1 the client would double up', () => {
    // The claude client (and the validation probe) always append `/v1/messages`, so a base URL that
    // already carries `/v1` would resolve to `.../v1/v1/messages` → 404 without this normalization.
    expect(normalizeAnthropicBaseUrl('https://api.anthropic.com/v1')).toBe(
      'https://api.anthropic.com'
    )
  })

  it('strips a pasted full /v1/messages endpoint back to the base', () => {
    expect(normalizeAnthropicBaseUrl('https://api.anthropic.com/v1/messages')).toBe(
      'https://api.anthropic.com'
    )
  })

  it('trims whitespace and trailing slashes before and after stripping /v1', () => {
    expect(normalizeAnthropicBaseUrl('  https://api.anthropic.com/v1/  ')).toBe(
      'https://api.anthropic.com'
    )
  })

  it('is case-insensitive about the version segment', () => {
    expect(normalizeAnthropicBaseUrl('https://api.anthropic.com/V1')).toBe(
      'https://api.anthropic.com'
    )
  })

  it('only strips a whole trailing /v1 segment, not a substring', () => {
    // A path segment that merely ends in "v1" (e.g. an api version folder named "apiv1") must survive.
    expect(normalizeAnthropicBaseUrl('https://api.anthropic.com/apiv1')).toBe(
      'https://api.anthropic.com/apiv1'
    )
  })

  it('returns an empty string unchanged', () => {
    expect(normalizeAnthropicBaseUrl('')).toBe('')
  })
})
