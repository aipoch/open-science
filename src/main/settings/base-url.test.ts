import { describe, expect, it } from 'vitest'

import {
  normalizeAnthropicBaseUrl,
  openAiChatCompletionsUrl,
  openAiCompletionsBase
} from './base-url'

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

describe('openAiCompletionsBase / openAiChatCompletionsUrl', () => {
  // Official vendors: openaiBaseUrl is an EXACT, version-carrying base — used verbatim, only
  // /chat/completions appended. No /v1 is injected, so GLM's non-/v1 path works.
  it('uses an official vendor openaiBaseUrl verbatim', () => {
    expect(openAiChatCompletionsUrl({ openaiBaseUrl: 'https://api.deepseek.com/v1' })).toBe(
      'https://api.deepseek.com/v1/chat/completions'
    )
    expect(openAiChatCompletionsUrl({ openaiBaseUrl: 'https://openrouter.ai/api/v1' })).toBe(
      'https://openrouter.ai/api/v1/chat/completions'
    )
    expect(openAiChatCompletionsUrl({ openaiBaseUrl: 'https://api.z.ai/api/paas/v4' })).toBe(
      'https://api.z.ai/api/paas/v4/chat/completions'
    )
    expect(
      openAiChatCompletionsUrl({ openaiBaseUrl: 'https://open.bigmodel.cn/api/paas/v4' })
    ).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions')
    // openaiBaseUrl wins over an Anthropic baseUrl on the same provider.
    expect(
      openAiChatCompletionsUrl({
        openaiBaseUrl: 'https://api.z.ai/api/paas/v4',
        baseUrl: 'https://api.z.ai/api/anthropic'
      })
    ).toBe('https://api.z.ai/api/paas/v4/chat/completions')
  })

  // Custom gateways: baseUrl is a user ROOT (the form promises "trailing /v1 added automatically").
  it('adds /v1 to a bare custom gateway root', () => {
    expect(openAiCompletionsBase({ baseUrl: 'https://gw.example.com' })).toBe(
      'https://gw.example.com/v1'
    )
    expect(openAiChatCompletionsUrl({ baseUrl: 'https://gw.example.com' })).toBe(
      'https://gw.example.com/v1/chat/completions'
    )
  })

  // Regression guard: a custom root WITH a path prefix must still get /v1 (not be treated like an
  // already-versioned official base). Previously this wrongly produced `/proxy/chat/completions`.
  it('adds /v1 to a custom gateway root that has a path prefix', () => {
    expect(openAiChatCompletionsUrl({ baseUrl: 'https://host/proxy' })).toBe(
      'https://host/proxy/v1/chat/completions'
    )
  })

  it('collapses a redundant /v1 or full endpoint pasted into a custom root', () => {
    expect(openAiChatCompletionsUrl({ baseUrl: 'https://gw.example.com/v1' })).toBe(
      'https://gw.example.com/v1/chat/completions'
    )
    expect(
      openAiChatCompletionsUrl({ baseUrl: 'https://gw.example.com/v1/chat/completions' })
    ).toBe('https://gw.example.com/v1/chat/completions')
  })

  it('preserves a query string instead of concatenating past it', () => {
    expect(openAiChatCompletionsUrl({ baseUrl: 'https://host/api?tenant=x' })).toBe(
      'https://host/api/v1/chat/completions?tenant=x'
    )
    expect(openAiChatCompletionsUrl({ openaiBaseUrl: 'https://host/api/paas/v4?tenant=x' })).toBe(
      'https://host/api/paas/v4/chat/completions?tenant=x'
    )
  })

  it('tolerates whitespace and trailing slashes', () => {
    expect(openAiChatCompletionsUrl({ openaiBaseUrl: '  https://api.z.ai/api/paas/v4/  ' })).toBe(
      'https://api.z.ai/api/paas/v4/chat/completions'
    )
  })

  it('returns undefined when neither base is set', () => {
    expect(openAiCompletionsBase({})).toBeUndefined()
    expect(openAiChatCompletionsUrl({})).toBeUndefined()
  })
})
