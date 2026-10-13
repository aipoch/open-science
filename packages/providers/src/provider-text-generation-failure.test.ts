import { expect, it } from 'vitest'
import {
  providerErrorDetails,
  providerTextGenerationFailure
} from './provider-text-generation-failure'
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
