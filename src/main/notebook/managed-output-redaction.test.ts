import { describe, expect, it } from 'vitest'
import { createManagedOutputRedactor } from './managed-output-redaction'

describe('managed process output boundary', () => {
  it('never releases a secret split at any possible chunk boundary', () => {
    const secret = 'fixture-credential-0123456789'
    for (let cut = 1; cut < secret.length; cut++) {
      const redactor = createManagedOutputRedactor([secret])
      const first = redactor.push(`before ${secret.slice(0, cut)}`)
      expect(first).toBe('before ')
      const second = redactor.push(`${secret.slice(cut)} after`)
      expect(first + second + redactor.finish()).toBe('before [redacted] after')
    }
  })

  it('supports character-by-character output, repeated secrets and incomplete EOF', () => {
    const redactor = createManagedOutputRedactor(['fixture-secret'])
    const result =
      [...'fixture-secret fixture-secret fixture-sec'].map((part) => redactor.push(part)).join('') +
      redactor.finish()
    expect(result).toBe('[redacted] [redacted] [redacted]')
  })

  it('does not buffer ordinary output when there are no credentials', () => {
    const redactor = createManagedOutputRedactor()
    expect(redactor.push('early')).toBe('early')
    expect(redactor.push('late')).toBe('late')
    expect(redactor.finish()).toBe('')
  })
})
