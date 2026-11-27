import { describe, expect, it } from 'vitest'
import { getCustomProviderBaseUrlError } from './provider-url-policy'

describe('trusted HTTP provider URLs', () => {
  it('accepts a remote HTTP URL only when the caller supplies an explicit grant', () => {
    expect(getCustomProviderBaseUrlError('http://gateway.example/v1')).toBe(
      'Remote model URLs must use HTTPS. HTTP is only allowed for localhost or loopback addresses.'
    )
    expect(
      getCustomProviderBaseUrlError('http://gateway.example/v1', { allowInsecureHttp: true })
    ).toBeUndefined()
  })
})
