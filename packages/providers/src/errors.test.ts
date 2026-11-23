import { expect, it } from 'vitest'
import { providerErrorDetails, providerErrorExcerpt, providerTextGenerationFailure } from './errors'
it('redacts diagnostics before limiting them and does not interpret arbitrary error wording', () => {
  const key = 'synthetic-key-123456'
  const details = providerErrorDetails(
    new Error(`Failure ${key} api_key="${key}"\n${'x'.repeat(5000)}`),
    [key]
  )
  expect(details).not.toContain(key)
  expect(details.length).toBeLessThanOrEqual(4096)
  expect(providerTextGenerationFailure(new Error('529 overloaded, api_key=secret'))).toBeUndefined()
  expect(
    providerTextGenerationFailure(new Error('[provider-failure:unavailable:999]'))
  ).toBeUndefined()
})

it.each([
  [
    "Unsupported parameter: 'temperature'. Echoed private content",
    "Unsupported parameter: 'temperature'"
  ],
  [
    "This model's maximum context length is 8192 tokens. However, you requested 9111 tokens for tenant secret",
    "This model's maximum context length is 8192 tokens. However, you requested 9111 tokens"
  ],
  ['Rate limit reached for organization private-id', 'Rate limit reached'],
  ['Incorrect API key provided: opaque-value', 'Incorrect API key provided'],
  ['Maximum call stack size exceeded at /private/source.ts', 'Maximum call stack size exceeded'],
  ['Unsupported parameter: company_private_parameter', undefined],
  ['<html>Incorrect API key provided</html>', undefined],
  ['Unknown failure with private user content', undefined]
])('retains only known public wording from %s', (message, expected) => {
  expect(providerErrorExcerpt(message)).toBe(expected)
})
