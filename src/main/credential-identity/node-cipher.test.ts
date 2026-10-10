import { describe, expect, it, vi } from 'vitest'
import { createCipheriv } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeSecureStorageCipher, initializeNodeWindowsProfileKey } from './node-cipher'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import type { CredentialIdentity } from './selection'

vi.mock('node:child_process', { spy: true })
vi.mock('node:module', { spy: true })

// Vectors independently generated with OpenSSL AES-128-CBC and the pinned Chromium KDF.
const fixtures: Array<{ identity: CredentialIdentity; prefix: string; hex: string }> = [
  {
    identity: { backend: 'mac-keychain', appName: 'Open Science', exists: true },
    prefix: 'v10',
    hex: 'd4b81452ace5eb19df68d8fdf1bfc5655f7873c8b7626ac287332f0997d74333'
  },
  {
    identity: { backend: 'linux-secret-service', appName: 'Open Science', exists: true },
    prefix: 'v11',
    hex: '00e1482772249f9ea6e2d787623ba5247e98933eb634798912ccd83a5dd192f4'
  },
  {
    identity: {
      backend: 'linux-kwallet',
      appName: 'Open Science',
      exists: true,
      passwordStore: 'kwallet6',
      wallet: 'fixture'
    },
    prefix: 'v11',
    hex: '00e1482772249f9ea6e2d787623ba5247e98933eb634798912ccd83a5dd192f4'
  }
]

describe('Node OSCrypt-compatible cipher', () => {
  it('launches the packaged DPAPI helper outside app.asar', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'node-cipher-packaged-'))
    const executable = join(directory, 'app.asar', 'native', 'credential_secret.exe')
    vi.mocked(createRequire).mockReturnValue((() => ({
      secretExecutablePath: executable
    })) as unknown as NodeJS.Require)
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: Buffer.from('protected-key')
    } as ReturnType<typeof spawnSync>)
    try {
      initializeNodeWindowsProfileKey(directory)
      expect(spawnSync).toHaveBeenCalledWith(
        join(directory, 'app.asar.unpacked', 'native', 'credential_secret.exe'),
        ['protect'],
        expect.objectContaining({ windowsHide: true })
      )
    } finally {
      vi.mocked(createRequire).mockRestore()
      vi.mocked(spawnSync).mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })
  it.each(fixtures)(
    'reads and writes the existing $identity.backend format',
    ({ identity, prefix, hex }) => {
      const readPassword = vi.fn(() => Buffer.from('fixture-vault-password'))
      const cipher = createNodeSecureStorageCipher(identity, '/unused', {
        readPassword,
        unprotect: () => {
          throw new Error('wrong backend')
        }
      })
      const expected = Buffer.concat([Buffer.from(prefix), Buffer.from(hex, 'hex')])
      expect(cipher.decryptString(expected)).toBe('fixture-科学-secret')
      expect(cipher.encryptString('fixture-科学-secret')).toEqual(expected)
      expect(readPassword).toHaveBeenCalledWith(identity, false)
      cipher.dispose()
      expect(() => cipher.encryptString('after-close')).toThrow('recovery')
    }
  )
  it('does not create a missing key while trying to read existing ciphertext', () => {
    const identity = { backend: 'mac-keychain', appName: 'Open-Science', exists: false } as const
    const readPassword = vi.fn(() => {
      throw new Error('unavailable')
    })
    const cipher = createNodeSecureStorageCipher(identity, '/unused', {
      readPassword,
      unprotect: vi.fn()
    })
    expect(() => cipher.decryptString(Buffer.from('v10invalid'))).toThrow()
    expect(readPassword).toHaveBeenCalledWith(identity, false)
  })
  it('refuses OS encryption in explicit file mode rather than fabricating a key', () => {
    const readPassword = vi.fn()
    const cipher = createNodeSecureStorageCipher(
      { backend: 'file', appName: 'Open-Science' },
      '/unused',
      { readPassword, unprotect: vi.fn() }
    )
    expect(cipher.isEncryptionAvailable()).toBe(false)
    expect(() => cipher.encryptString('secret')).toThrow()
    expect(readPassword).not.toHaveBeenCalled()
  })
  it('preserves Windows v10 nonce/tag layout and authenticates ciphertext', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'node-cipher-'))
    const key = Buffer.alloc(32, 0x63),
      nonce = Buffer.alloc(12, 0x42)
    try {
      await writeFile(
        join(directory, 'Local State'),
        JSON.stringify({
          os_crypt: { encrypted_key: Buffer.from('DPAPIfixture').toString('base64') }
        })
      )
      const cipher = createNodeSecureStorageCipher(
        { backend: 'windows-dpapi', appName: 'Open-Science' },
        directory,
        { readPassword: vi.fn(), unprotect: () => Buffer.from(key) }
      )
      const producer = createCipheriv('aes-256-gcm', key, nonce)
      const record = Buffer.concat([
        Buffer.from('v10'),
        nonce,
        producer.update('fixture', 'utf8'),
        producer.final(),
        producer.getAuthTag()
      ])
      expect(cipher.decryptString(record)).toBe('fixture')
      const created = cipher.encryptString('fixture-科学-secret')
      expect(created.subarray(0, 3).toString()).toBe('v10')
      expect(cipher.decryptString(created)).toBe('fixture-科学-secret')
      record[record.length - 1] ^= 1
      expect(() => cipher.decryptString(record)).toThrow()
      cipher.dispose()
    } finally {
      key.fill(0)
      await rm(directory, { recursive: true, force: true })
    }
  })
})
