import { describe, expect, it } from 'vitest'

import { normalizeLoopbackOAuthRedirectUri } from './oauth-redirect'

describe('normalizeLoopbackOAuthRedirectUri', () => {
  it('normalizes an IPv4 loopback redirect URI', () => {
    expect(normalizeLoopbackOAuthRedirectUri('http://127.0.0.1:8080/callback')).toBe(
      'http://127.0.0.1:8080/callback'
    )
  })

  it.each([
    ['an invalid URL', 'not a URL', 'OAuth redirect URI must be a valid URL.'],
    [
      'HTTPS',
      'https://127.0.0.1:8080/callback',
      'OAuth redirect URI must be an http://127.0.0.1 loopback URL.'
    ],
    [
      'localhost',
      'http://localhost:8080/callback',
      'OAuth redirect URI must be an http://127.0.0.1 loopback URL.'
    ],
    [
      'credentials',
      'http://user:password@127.0.0.1:8080/callback',
      'OAuth redirect URI must be an http://127.0.0.1 loopback URL.'
    ],
    [
      'a fragment',
      'http://127.0.0.1:8080/callback#fragment',
      'OAuth redirect URI must be an http://127.0.0.1 loopback URL.'
    ]
  ])('rejects %s', (_case, value, message) => {
    expect(() => normalizeLoopbackOAuthRedirectUri(value)).toThrow(message)
  })
})
