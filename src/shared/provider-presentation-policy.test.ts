import { expect, it } from 'vitest'
import { providerErrorDetails } from './provider-error'
import { getCustomProviderBaseUrlError, customProviderRequiresKey } from './provider-url-policy'
it('normalizes Electron envelopes before portable redaction and marker removal', () => {
  expect(
    providerErrorDetails(
      new Error(
        "Error invoking remote method 'settings:test': Error: [provider-text-generation:http-error] [provider-failure:authentication:401] Access denied for secret"
      ),
      ['secret']
    )
  ).toBe('Access denied for [REDACTED]')
})
it('keeps credential/form policy in the host while applying transport URL security', () => {
  expect(customProviderRequiresKey('http://127.0.0.1:1234')).toBe(false)
  expect(customProviderRequiresKey('https://gateway.example')).toBe(true)
  expect(getCustomProviderBaseUrlError('http://gateway.example')).toBeTruthy()
  expect(getCustomProviderBaseUrlError('https://gateway.example')).toBeUndefined()
})
