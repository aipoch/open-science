import { describe, expect, it } from 'vitest'
import { createManagedOutputRedactor, redactManagedOutput } from './managed-output-redaction'

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

  it.each([
    'fixture"credential',
    'fixture\\credential',
    'fixture\ncredential',
    'fixture\\',
    'fixture"'
  ])('redacts JSON credential logs across every chunk boundary', (secret) => {
    const encoded = JSON.stringify(secret).slice(1, -1)
    const text = JSON.stringify({ credential: secret })
    const expected = '{"credential":"[redacted]"}'
    expect(redactManagedOutput(text, [secret])).toBe(expected)
    for (let cut = 1; cut < encoded.length; cut++) {
      const redactor = createManagedOutputRedactor([secret])
      const first = redactor.push('{"credential":"' + encoded.slice(0, cut))
      expect(first).toBe('{"credential":"')
      const second = redactor.push(encoded.slice(cut) + '"}')
      expect(first + second + redactor.finish()).toBe(expected)
    }
    const redactor = createManagedOutputRedactor([secret])
    expect([...text].map((part) => redactor.push(part)).join('') + redactor.finish()).toBe(expected)
  })

  it('waits for the longest overlapping raw or JSON match before releasing output', () => {
    const secrets = ['fixture\\', 'fixture\\\\']
    const text = secrets
      .flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)])
      .join(' | ')
    const expected = '[redacted] | [redacted] | [redacted] | [redacted]'
    expect(redactManagedOutput(text, secrets)).toBe(expected)
    for (let cut = 0; cut <= text.length; cut++) {
      const redactor = createManagedOutputRedactor(secrets)
      expect(
        redactor.push(text.slice(0, cut)) + redactor.push(text.slice(cut)) + redactor.finish()
      ).toBe(expected)
    }
    const redactor = createManagedOutputRedactor(secrets)
    expect([...text].map((part) => redactor.push(part)).join('') + redactor.finish()).toBe(expected)
  })

  it('does not rescan replacement markers as credential text', () => {
    const secrets = ['fixture-long', 'redacted']
    const text = 'fixture-long redacted'
    expect(redactManagedOutput(text, secrets)).toBe('[redacted] [redacted]')
    const redactor = createManagedOutputRedactor(secrets)
    expect([...text].map((part) => redactor.push(part)).join('') + redactor.finish()).toBe(
      '[redacted] [redacted]'
    )
  })

  it('withholds an ambiguous complete match or partial JSON escape at EOF', () => {
    const secret = 'fixture\\\\'
    const encoded = JSON.stringify(secret).slice(1, -1)
    for (let cut = 1; cut <= encoded.length; cut++) {
      const redactor = createManagedOutputRedactor([secret])
      expect(redactor.push(encoded.slice(0, cut)) + redactor.finish()).toBe('[redacted]')
      expect(redactor.finish()).toBe('')
    }
  })

  it('does not buffer ordinary output when there are no credentials', () => {
    const redactor = createManagedOutputRedactor()
    expect(redactor.push('early')).toBe('early')
    expect(redactor.push('late')).toBe('late')
    expect(redactor.finish()).toBe('')
  })
})
