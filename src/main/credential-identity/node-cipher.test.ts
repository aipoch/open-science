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
  it.each([0, 31_000])(
    'decrypts legacy ciphertext when helper authorization completes after %i ms',
    async (delay) => {
      const actual =
        await vi.importActual<typeof import('node:child_process')>('node:child_process')
      vi.mocked(createRequire).mockReturnValue((() => ({
        secretExecutablePath: process.execPath
      })) as unknown as NodeJS.Require)
      // Exercise a real subprocess and the production timeout without accessing an OS vault.
      vi.mocked(spawnSync).mockImplementation((executable, args, options) => {
        expect(args).toEqual(['read-key', 'Open Science'])
        return actual.spawnSync(
          executable,
          ['-e', `setTimeout(() => process.stdout.write('fixture-vault-password'), ${delay})`],
          options
        )
      })
      const cipher = createNodeSecureStorageCipher(fixtures[0].identity, '/unused')
      try {
        const ciphertext = Buffer.concat([Buffer.from('v10'), Buffer.from(fixtures[0].hex, 'hex')])
        expect(cipher.decryptString(ciphertext)).toBe('fixture-科学-secret')
      } finally {
        cipher.dispose()
        vi.mocked(createRequire).mockRestore()
        vi.mocked(spawnSync).mockRestore()
      }
    },
    40_000
  )
  it('retains a non-secret timeout diagnostic when reading existing legacy credentials', () => {
    vi.mocked(createRequire).mockReturnValue((() => ({
      secretExecutablePath: process.execPath
    })) as unknown as NodeJS.Require)
    vi.mocked(spawnSync).mockReturnValue({
      error: Object.assign(new Error('private path must not be exposed'), { code: 'ETIMEDOUT' }),
      status: null,
      signal: 'SIGTERM',
      pid: 1,
      output: [],
      stderr: Buffer.alloc(0),
      stdout: Buffer.alloc(0)
    } as ReturnType<typeof spawnSync>)
    const cipher = createNodeSecureStorageCipher(fixtures[0].identity, '/unused')
    try {
      const ciphertext = Buffer.concat([Buffer.from('v10'), Buffer.from(fixtures[0].hex, 'hex')])
      let failure: unknown
      try {
        cipher.decryptString(ciphertext)
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({ diagnostic: { systemCode: 'ETIMEDOUT' } })
      expect(JSON.stringify(failure)).not.toContain('private path')
    } finally {
      cipher.dispose()
      vi.mocked(createRequire).mockRestore()
      vi.mocked(spawnSync).mockRestore()
    }
  })

  it.each([
    {
      result: { error: Object.assign(new Error('PRIVATE'), { code: 'ENOENT' }) },
      code: 'secret-start-failed'
    },
    { result: { status: 1 }, code: 'secret-exit-failed' },
    { result: { status: null, signal: 'SIGTERM' }, code: 'secret-signalled' },
    { result: { status: 0 }, code: 'secret-empty-response' }
  ])(
    'classifies $code without replacing the existing key, then permits a fresh read',
    ({ result, code }) => {
      vi.mocked(createRequire).mockReturnValue((() => ({
        secretExecutablePath: process.execPath
      })) as unknown as NodeJS.Require)
      vi.mocked(spawnSync)
        .mockReturnValueOnce({
          pid: 1,
          output: [],
          stderr: Buffer.alloc(0),
          stdout: Buffer.alloc(0),
          status: null,
          signal: null,
          ...result
        } as ReturnType<typeof spawnSync>)
        .mockReturnValueOnce({
          pid: 2,
          output: [],
          stderr: Buffer.alloc(0),
          stdout: Buffer.from('fixture-vault-password'),
          status: 0,
          signal: null
        })
      const cipher = createNodeSecureStorageCipher(fixtures[0].identity, '/unused')
      const ciphertext = Buffer.concat([Buffer.from('v10'), Buffer.from(fixtures[0].hex, 'hex')])
      const original = Buffer.from(ciphertext)
      try {
        let failure: unknown
        try {
          cipher.decryptString(ciphertext)
        } catch (error) {
          failure = error
        }
        expect(failure).toMatchObject({
          reason: 'native-secret-operation-failed',
          diagnostic: { code }
        })
        expect(JSON.stringify(failure)).not.toContain('PRIVATE')
        expect(cipher.decryptString(ciphertext)).toBe('fixture-科学-secret')
        expect(ciphertext).toEqual(original)
        expect(spawnSync).toHaveBeenLastCalledWith(
          process.execPath,
          ['read-key', 'Open Science'],
          expect.objectContaining({ input: Buffer.alloc(0) })
        )
      } finally {
        cipher.dispose()
        vi.mocked(createRequire).mockRestore()
        vi.mocked(spawnSync).mockRestore()
      }
    }
  )

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
