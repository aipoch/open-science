import { afterEach, describe, expect, it, vi } from 'vitest'

// Toggleable keychain state so the reduced-protection fallback (keychain unavailable) can be tested
// alongside the normal encrypted path. Hoisted so the vi.mock factory can read it.
const keychain = vi.hoisted(() => ({ available: true }))

// Fake safeStorage: a reversible "encryption" so the crypto wrapper's base64/prefix handling and
// round-trip contract can be tested without a real OS keychain. encryptString mirrors Electron by
// throwing when encryption is unavailable, so the wrapper's fallback branch is exercised faithfully.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => keychain.available,
    encryptString: (plaintext: string) => {
      if (!keychain.available) throw new Error('Encryption is not available.')

      return Buffer.from(`cipher:${plaintext}`, 'utf8')
    },
    decryptString: (buffer: Buffer) => {
      if (!keychain.available) throw new Error('Encryption is not available.')

      const decoded = buffer.toString('utf8')

      if (!decoded.startsWith('cipher:')) {
        throw new Error('bad ciphertext')
      }

      return decoded.slice('cipher:'.length)
    }
  }
}))

const { decryptKey, encryptKey, maskKey, tryDecryptKey } = await import('./crypto')

afterEach(() => {
  keychain.available = true
})

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

  it('fails closed instead of writing a reversible ref when encryption is unavailable', () => {
    keychain.available = false

    expect(() => encryptKey('sk-secret-value')).toThrow(/secure credential storage is unavailable/i)
  })

  it('still reads a legacy plain: ref so it can be migrated after upgrade', () => {
    const legacyRef = `plain:${Buffer.from('sk-degraded').toString('base64')}`
    expect(tryDecryptKey(legacyRef)).toBe('sk-degraded')
  })

  it('masks long keys as prefix…suffix and short keys as bullets', () => {
    expect(maskKey('sk-abcdef1234')).toBe('sk-a…1234')
    expect(maskKey('short')).toBe('•••••')
    expect(maskKey('')).toBe('')
  })
})
