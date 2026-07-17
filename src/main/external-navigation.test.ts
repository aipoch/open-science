import { describe, expect, it } from 'vitest'

import { isAllowedExternalUrl } from './external-navigation'

describe('external navigation allowlist', () => {
  it.each(['https://example.com/file', 'http://localhost:3000/help'])('allows %s', (url) =>
    expect(isAllowedExternalUrl(url)).toBe(true)
  )

  it.each([
    'file:///Users/example/secrets.txt',
    'javascript:alert(1)',
    'data:text/html,unsafe',
    'open-science://preview/file',
    'not a url'
  ])('rejects %s', (url) => expect(isAllowedExternalUrl(url)).toBe(false))
})
