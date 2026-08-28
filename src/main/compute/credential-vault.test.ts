import { describe, expect, it, vi } from 'vitest'

import { CredentialVault, type ComputeCredentialCipher } from './credential-vault'

const cipher = (backend: string): ComputeCredentialCipher => ({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => backend,
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
  decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, '')
})

describe('Compute password secure-storage capability', () => {
  it('uses the available OS cipher backend on Windows', () => {
    const vault = new CredentialVault(
      { getCredential: vi.fn(async () => null) },
      cipher('os_crypt'),
      'win32'
    )

    expect(vault.capability()).toEqual({ available: true })
    expect(vault.encrypt('windows protected secret').toString()).toBe(
      'encrypted:windows protected secret'
    )
  })

  it('fails closed for Electron basic_text on Linux', () => {
    const vault = new CredentialVault(
      { getCredential: vi.fn(async () => null) },
      cipher('basic_text'),
      'linux'
    )

    expect(vault.capability()).toEqual({
      available: false,
      reason: 'secure_storage_unavailable'
    })
    expect(() => vault.encrypt('must not persist')).toThrowError(
      expect.objectContaining({ code: 'secure_storage_unavailable' })
    )
  })

  it('decrypts stored ciphertext after restart without projecting credential material', async () => {
    const vault = new CredentialVault(
      {
        getCredential: vi.fn(async () => ({ ciphertext: Buffer.from('encrypted:restart secret') }))
      },
      cipher('gnome_libsecret'),
      'linux'
    )
    const use = vi.fn(async () => 'probe complete')

    await expect(vault.withPassword('host-1', use)).resolves.toBe('probe complete')
    expect(use).toHaveBeenCalledWith('restart secret')
    await expect(vault.credentialStatus('host-1')).resolves.toBe('configured')
  })

  it('projects copied or corrupt ciphertext as unavailable without exposing it', async () => {
    const vault = new CredentialVault(
      { getCredential: vi.fn(async () => ({ ciphertext: Buffer.from('foreign ciphertext') })) },
      {
        ...cipher('gnome_libsecret'),
        decryptString: () => {
          throw new Error('machine-bound ciphertext')
        }
      },
      'linux'
    )

    await expect(vault.credentialStatus('host-1')).resolves.toBe('unavailable')
  })

  it('binds an operation fingerprint to its complete intent without exposing the password', () => {
    const vault = new CredentialVault(
      { getCredential: vi.fn(async () => null) },
      cipher('gnome_libsecret'),
      'linux'
    )
    const intent = JSON.stringify(['reset_password', 'ssh:cluster', 1, 'new secret'])

    const fingerprint = vault.bindOperationIntent(intent)

    expect(fingerprint).not.toContain('new secret')
    expect(vault.bindOperationIntent(intent, fingerprint)).toBe(fingerprint)
    expect(() =>
      vault.bindOperationIntent(
        JSON.stringify(['reset_password', 'ssh:cluster', 1, 'different secret']),
        fingerprint
      )
    ).toThrowError(expect.objectContaining({ code: 'credential_conflict' }))
  })
})
