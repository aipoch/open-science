import { expect, it } from 'vitest'
import { isSensitiveDiagnosticKey, redactSensitiveText } from './diagnostic-redaction'

it.each(['clientSecret', 'OPENAI_API_KEY', 'password', 'refreshToken'])(
  'recognizes credential key %s',
  (key) => {
    expect(isSensitiveDiagnosticKey(key)).toBe(true)
  }
)
it.each(['inputTokens', 'cached_tokens', 'totalTokenUsage', 'tokenBudget'])(
  'preserves metric key %s',
  (key) => {
    expect(isSensitiveDiagnosticKey(key)).toBe(false)
  }
)
it.each([
  'Error: client_secret="opaque-secret"',
  'Authorization: Bearer opaque-secret',
  'https://example.org?api_key=opaque-secret',
  '{"client\\u0053ecret":"opaque-secret"}',
  '{"safe":"first", "clientSecret":"opaque-secret", "status":"ready"}',
  'message "unexpected quote; payload={"client\\u0053ecret":"opaque-secret"}'
])('redacts sensitive values in %s', (text) => {
  const output = redactSensitiveText(text)
  expect(output).not.toContain('opaque-secret')
  expect(output).toContain('[redacted]')
})
it('retains escaped non-secret JSON text and handles escaped quotes in secret values', () => {
  const text = JSON.stringify({
    message: 'quote " and slash \\',
    clientSecret: 'opaque " secret',
    status: 'ready'
  })
  expect(JSON.parse(redactSensitiveText(text))).toEqual({
    message: 'quote " and slash \\',
    clientSecret: '[redacted]',
    status: 'ready'
  })
})
it.each(['field' + '\t'.repeat(100_000) + '!', '"' + '\\"'.repeat(100_000)])(
  'processes malformed adversarial input without superlinear regex backtracking',
  (text) => {
    const start = performance.now()
    expect(redactSensitiveText(text)).toBe(text)
    expect(performance.now() - start).toBeLessThan(1_000)
  }
)
