import { describe, expect, it, vi } from 'vitest'

// Fake safeStorage: a reversible "encryption" so the crypto wrapper's base64/prefix handling and
// round-trip contract can be tested without a real OS keychain.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`cipher:${plaintext}`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const decoded = buffer.toString('utf8')

      if (!decoded.startsWith('cipher:')) {
        throw new Error('bad ciphertext')
      }

      return decoded.slice('cipher:'.length)
    }
  }
}))

const { decryptKey, encryptKey, maskKey, tryDecryptKey } = await import('./crypto')

describe('crypto', () => {
  it('round-trips a key through encrypt/decrypt with the enc: prefix', () => {
    const keyRef = encryptKey('sk-secret-value')

    expect(keyRef.startsWith('enc:')).toBe(true)
    expect(decryptKey(keyRef)).toBe('sk-secret-value')
  })

  it('throws on a malformed key reference', () => {
    expect(() => decryptKey('plain-nonsense')).toThrow(/malformed/i)
  })

  it('tryDecryptKey returns undefined instead of throwing on bad input', () => {
    expect(tryDecryptKey(undefined)).toBeUndefined()
    expect(tryDecryptKey('enc:' + Buffer.from('garbage').toString('base64'))).toBeUndefined()
  })

  it('masks long keys as prefix…suffix and short keys as bullets', () => {
    expect(maskKey('sk-abcdef1234')).toBe('sk-a…1234')
    expect(maskKey('short')).toBe('•••••')
    expect(maskKey('')).toBe('')
  })
})
