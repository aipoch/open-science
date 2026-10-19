import { describe, expect, it } from 'vitest'

import {
  resolveMessagesBaseUrl,
  resolveMessagesUrl,
  resolveResponsesUrl,
  normalizeMessagesRootUrl,
  resolveChatCompletionsUrl,
  resolveChatCompletionsBaseUrl
} from './endpoints'

describe('resolveMessagesBaseUrl', () => {
  it('returns the versioned base expected by clients that append /messages', () => {
    expect(resolveMessagesBaseUrl('https://gateway.example')).toBe('https://gateway.example/v1')
    expect(resolveMessagesBaseUrl('https://gateway.example/v1')).toBe('https://gateway.example/v1')
    expect(resolveMessagesBaseUrl('https://gateway.example/v1/messages')).toBe(
      'https://gateway.example/v1'
    )
  })
})

describe('normalizeMessagesRootUrl', () => {
  it('leaves a bare gateway root untouched', () => {
    expect(normalizeMessagesRootUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com')
  })

  it('strips a redundant trailing /v1 the client would double up', () => {
    // The claude client (and the validation probe) always append `/v1/messages`, so a base URL that
    // already carries `/v1` would resolve to `.../v1/v1/messages` → 404 without this normalization.
    expect(normalizeMessagesRootUrl('https://api.anthropic.com/v1')).toBe(
      'https://api.anthropic.com'
    )
  })

  it('strips a pasted full /v1/messages endpoint back to the base', () => {
    expect(normalizeMessagesRootUrl('https://api.anthropic.com/v1/messages')).toBe(
      'https://api.anthropic.com'
    )
  })

  it('trims whitespace and trailing slashes before and after stripping /v1', () => {
    expect(normalizeMessagesRootUrl('  https://api.anthropic.com/v1/  ')).toBe(
      'https://api.anthropic.com'
    )
  })

  it('is case-insensitive about the version segment', () => {
    expect(normalizeMessagesRootUrl('https://api.anthropic.com/V1')).toBe(
      'https://api.anthropic.com'
    )
  })

  it('only strips a whole trailing /v1 segment, not a substring', () => {
    // A path segment that merely ends in "v1" (e.g. an api version folder named "apiv1") must survive.
    expect(normalizeMessagesRootUrl('https://api.anthropic.com/apiv1')).toBe(
      'https://api.anthropic.com/apiv1'
    )
  })

  it('returns an empty string unchanged', () => {
    expect(normalizeMessagesRootUrl('')).toBe('')
  })
})

describe('resolveChatCompletionsBaseUrl / resolveChatCompletionsUrl', () => {
  // Official vendors: chatCompletionsBaseUrl is an EXACT, version-carrying base — used verbatim, only
  // /chat/completions appended. No /v1 is injected, so GLM's non-/v1 path works.
  it('uses an official vendor chatCompletionsBaseUrl verbatim', () => {
    expect(
      resolveChatCompletionsUrl({ chatCompletionsBaseUrl: 'https://api.deepseek.com/v1' })
    ).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(
      resolveChatCompletionsUrl({ chatCompletionsBaseUrl: 'https://openrouter.ai/api/v1' })
    ).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(
      resolveChatCompletionsUrl({ chatCompletionsBaseUrl: 'https://api.z.ai/api/paas/v4' })
    ).toBe('https://api.z.ai/api/paas/v4/chat/completions')
    expect(
      resolveChatCompletionsUrl({ chatCompletionsBaseUrl: 'https://open.bigmodel.cn/api/paas/v4' })
    ).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions')
    // chatCompletionsBaseUrl wins over an Anthropic baseUrl on the same provider.
    expect(
      resolveChatCompletionsUrl({
        chatCompletionsBaseUrl: 'https://api.z.ai/api/paas/v4',
        baseUrl: 'https://api.z.ai/api/anthropic'
      })
    ).toBe('https://api.z.ai/api/paas/v4/chat/completions')
  })

  // Custom gateways: baseUrl is a user ROOT (the form promises "trailing /v1 added automatically").
  it('adds /v1 to a bare custom gateway root', () => {
    expect(resolveChatCompletionsBaseUrl({ baseUrl: 'https://gw.example.com' })).toBe(
      'https://gw.example.com/v1'
    )
    expect(resolveChatCompletionsUrl({ baseUrl: 'https://gw.example.com' })).toBe(
      'https://gw.example.com/v1/chat/completions'
    )
  })

  // Regression guard: a custom root WITH a path prefix must still get /v1 (not be treated like an
  // already-versioned official base). Previously this wrongly produced `/proxy/chat/completions`.
  it('adds /v1 to a custom gateway root that has a path prefix', () => {
    expect(resolveChatCompletionsUrl({ baseUrl: 'https://host/proxy' })).toBe(
      'https://host/proxy/v1/chat/completions'
    )
  })

  it('collapses a redundant /v1 or full endpoint pasted into a custom root', () => {
    expect(resolveChatCompletionsUrl({ baseUrl: 'https://gw.example.com/v1' })).toBe(
      'https://gw.example.com/v1/chat/completions'
    )
    expect(
      resolveChatCompletionsUrl({ baseUrl: 'https://gw.example.com/v1/chat/completions' })
    ).toBe('https://gw.example.com/v1/chat/completions')
  })

  it('preserves a query string instead of concatenating past it', () => {
    expect(resolveChatCompletionsUrl({ baseUrl: 'https://host/api?tenant=x' })).toBe(
      'https://host/api/v1/chat/completions?tenant=x'
    )
    expect(
      resolveChatCompletionsUrl({ chatCompletionsBaseUrl: 'https://host/api/paas/v4?tenant=x' })
    ).toBe('https://host/api/paas/v4/chat/completions?tenant=x')
  })

  it('tolerates whitespace and trailing slashes', () => {
    expect(
      resolveChatCompletionsUrl({ chatCompletionsBaseUrl: '  https://api.z.ai/api/paas/v4/  ' })
    ).toBe('https://api.z.ai/api/paas/v4/chat/completions')
  })

  it('returns undefined when neither base is set', () => {
    expect(resolveChatCompletionsBaseUrl({})).toBeUndefined()
    expect(resolveChatCompletionsUrl({})).toBeUndefined()
  })
})

describe('complete tool-less API URLs', () => {
  it.each(['', '/v1', '/v1/', '/v1/responses', '/v1/responses/'])(
    'normalizes a Responses custom root with %s',
    (suffix) => {
      expect(resolveResponsesUrl({ baseUrl: `https://host/proxy${suffix}?tenant=a` })).toBe(
        'https://host/proxy/v1/responses?tenant=a'
      )
    }
  )
  it('preserves exact versioned official bases and rejects missing Responses targets', () => {
    expect(resolveResponsesUrl({ chatCompletionsBaseUrl: 'https://host/api/v3?tenant=a' })).toBe(
      'https://host/api/v3/responses?tenant=a'
    )
    expect(resolveResponsesUrl({})).toBeUndefined()
    expect(resolveResponsesUrl({ baseUrl: 'not a URL' })).toBeUndefined()
  })
  it.each(['', '/v1', '/v1/messages/'])('preserves Messages queries with %s', (suffix) => {
    expect(resolveMessagesUrl(`https://host/proxy${suffix}?tenant=a`)).toBe(
      'https://host/proxy/v1/messages?tenant=a'
    )
  })
})

describe('slash-heavy endpoint inputs', () => {
  const slashes = '/'.repeat(100_000)

  it('preserves non-trailing runs while normalizing appended endpoint paths', () => {
    const root = `https://host/proxy${slashes}tail`
    expect(normalizeMessagesRootUrl(root)).toBe(root)
    expect(resolveChatCompletionsBaseUrl({ chatCompletionsBaseUrl: root })).toBe(root)
    expect(resolveChatCompletionsUrl({ baseUrl: root })).toBe(
      'https://host/proxy/tail/v1/chat/completions'
    )
    expect(resolveResponsesUrl({ baseUrl: root })).toBe('https://host/proxy/tail/v1/responses')
  })

  it('removes long trailing runs and keeps query/hash content intact', () => {
    expect(normalizeMessagesRootUrl(`  https://host/proxy/V1/messages${slashes}  `)).toBe(
      'https://host/proxy'
    )
    expect(
      resolveChatCompletionsBaseUrl({ chatCompletionsBaseUrl: `https://host/v1${slashes}` })
    ).toBe('https://host/v1')
    const query = `?tenant=${slashes}tail#route`
    expect(resolveMessagesUrl(`https://host/proxy/v1/messages${slashes}${query}`)).toBe(
      `https://host/proxy/v1/messages${query}`
    )
    expect(resolveChatCompletionsUrl({ baseUrl: `https://host/proxy/v1${slashes}${query}` })).toBe(
      `https://host/proxy/v1/chat/completions${query}`
    )
    expect(
      resolveResponsesUrl({ baseUrl: `https://host/proxy/v1/responses${slashes}${query}` })
    ).toBe(`https://host/proxy/v1/responses${query}`)
  })

  it('retains the plain-string fallback for malformed bases', () => {
    const root = `not a URL${slashes}tail`
    expect(resolveChatCompletionsUrl({ baseUrl: root })).toBe(`${root}/v1/chat/completions`)
    expect(resolveMessagesBaseUrl(`not a URL/v1${slashes}`)).toBe('not a URL/v1')
  })
})
