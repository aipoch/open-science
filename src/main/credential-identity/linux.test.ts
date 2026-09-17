import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { CredentialIdentity } from './selection'

const native = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('node:child_process', () => ({ spawnSync: native.run }))

let root: string
beforeEach(() => {
  vi.resetModules()
  root = mkdtempSync(join(tmpdir(), 'linux-credentials-'))
  vi.stubGlobal(
    'process',
    Object.defineProperty(Object.create(process), 'platform', { value: 'linux' })
  )
  vi.stubEnv('XDG_CURRENT_DESKTOP', 'GNOME')
  vi.stubEnv('DESKTOP_SESSION', '')
  vi.stubEnv('KDE_FULL_SESSION', undefined)
  vi.stubEnv('GNOME_DESKTOP_SESSION_ID', undefined)
  native.run.mockReset()
  respond(true)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(root, { recursive: true, force: true })
})

const respond = (exists: boolean, locked = false): void => {
  native.run.mockImplementation((_command: string, args: string[]) => {
    const value = args.includes('SearchItems')
      ? {
          type: 'aoao',
          data: [
            exists && !locked ? ['/org/freedesktop/secrets/item/key'] : [],
            locked ? ['/org/freedesktop/secrets/item/key'] : []
          ]
        }
      : args.includes('ReadAlias')
        ? { type: 'o', data: ['/org/freedesktop/secrets/collection/login'] }
        : { type: 'v', data: [{ type: 'b', data: false }] }
    return { status: 0, signal: null, stdout: JSON.stringify(value) }
  })
}
const paths = (encrypted = false): { configRoot: string; profilePath: string } => {
  const result = { configRoot: join(root, 'config'), profilePath: join(root, 'profile') }
  mkdirSync(result.configRoot)
  mkdirSync(result.profilePath)
  if (encrypted)
    writeFileSync(
      join(result.configRoot, 'settings.json'),
      JSON.stringify({
        version: 2,
        providers: [{ keyRef: `enc:${Buffer.from('v11original').toString('base64')}` }]
      })
    )
  return result
}
const cipher = (): {
  getSelectedStorageBackend: Mock<() => string>
  isEncryptionAvailable: Mock<() => boolean>
  encryptString: Mock<(value: string) => Buffer>
  decryptString: Mock<() => string>
} => ({
  getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(`v11${value}`)),
  decryptString: vi.fn(() => 'original secret')
})

describe('Linux OS credentials through production bootstrap and access', () => {
  it.each([true, false])(
    'preserves the main technical identity (packaged=%s) without macOS name probing',
    async (packaged) => {
      const { selectStartupCredentialIdentity } = await import('./bootstrap')
      const identity = selectStartupCredentialIdentity({ platform: 'linux', packaged })
      expect(identity).toMatchObject({
        backend: 'linux-secret-service',
        appName: `Open Science${packaged ? '' : ' (DEV)'}`,
        exists: true
      })
      for (const [command, args] of native.run.mock.calls) {
        expect(command).toBe('/usr/bin/busctl')
        if (args.includes('SearchItems'))
          expect(args.slice(-2)).toEqual(['application', identity.appName])
        expect(args.join(' ')).not.toMatch(/GetSecret|CreateItem|Unlock|Delete/)
      }
    }
  )

  it('initializes a fresh supported OS backend without a fallback', async () => {
    respond(false)
    const { selectStartupCredentialIdentity, prepareCredentialValidation } =
      await import('./bootstrap')
    const identity = selectStartupCredentialIdentity({ platform: 'linux', packaged: true })
    const nativeCipher = cipher()
    prepareCredentialValidation(identity, paths())(nativeCipher, vi.fn())
    const { credentialCipher } = await import('./runtime')
    expect(credentialCipher(nativeCipher).encryptString('new')).toEqual(Buffer.from('v11new'))
    expect(nativeCipher.getSelectedStorageBackend).toHaveBeenCalled()
  })

  it('reuses original profile/key/ciphertexts without rewriting their files', async () => {
    const { selectStartupCredentialIdentity, prepareCredentialValidation } =
      await import('./bootstrap')
    const location = paths(true)
    const original = readFileSync(join(location.configRoot, 'settings.json'))
    const nativeCipher = cipher()
    prepareCredentialValidation(
      selectStartupCredentialIdentity({ platform: 'linux', packaged: true }),
      location
    )(nativeCipher, vi.fn())
    expect(nativeCipher.decryptString).toHaveBeenCalledWith(Buffer.from('v11original'))
    expect(nativeCipher.encryptString).not.toHaveBeenCalled()
    expect(readFileSync(join(location.configRoot, 'settings.json'))).toEqual(original)
  })

  it('rejects a missing key with ciphertext before any cipher access', async () => {
    respond(false)
    const { selectStartupCredentialIdentity, prepareCredentialValidation } =
      await import('./bootstrap')
    expect(() =>
      prepareCredentialValidation(
        selectStartupCredentialIdentity({ platform: 'linux', packaged: true }),
        paths(true)
      )
    ).toThrow(/recovery/i)
  })

  it.each(['locked', 'unavailable', 'duplicate', 'invalid response'])(
    'preserves evidence when metadata is %s',
    async (failure) => {
      if (failure === 'locked') respond(true, true)
      else
        native.run.mockReturnValue(
          failure === 'unavailable'
            ? { status: 1, stdout: '' }
            : {
                status: 0,
                stdout:
                  failure === 'duplicate'
                    ? JSON.stringify({ type: 'aoao', data: [['/a', '/b'], []] })
                    : '{bad'
              }
        )
      const { selectStartupCredentialIdentity } = await import('./bootstrap')
      expect(() => selectStartupCredentialIdentity({ platform: 'linux', packaged: true })).toThrow(
        /recovery/i
      )
    }
  )

  it.each(['basic_text', 'kwallet5', 'unknown', 'unavailable', 'decrypt failure'])(
    'blocks initialization and later writes on %s',
    async (failure) => {
      const { selectStartupCredentialIdentity, prepareCredentialValidation } =
        await import('./bootstrap')
      const nativeCipher = cipher()
      if (failure === 'unavailable') nativeCipher.isEncryptionAvailable.mockReturnValue(false)
      else if (failure === 'decrypt failure')
        nativeCipher.decryptString.mockImplementation(() => {
          throw Error('denied')
        })
      else nativeCipher.getSelectedStorageBackend.mockReturnValue(failure)
      const recover = vi.fn()
      const validate = prepareCredentialValidation(
        selectStartupCredentialIdentity({ platform: 'linux', packaged: true }),
        paths(true)
      )
      expect(() => validate(nativeCipher, recover)).toThrow(/recovery/i)
      const { credentialCipher, assertCredentialAccessAllowed } = await import('./runtime')
      expect(() => credentialCipher(nativeCipher).encryptString('replacement')).toThrow(/recovery/i)
      expect(() => assertCredentialAccessAllowed()).toThrow(/recovery/i)
      expect(nativeCipher.encryptString).not.toHaveBeenCalled()
      expect(recover).toHaveBeenCalledOnce()
    }
  )

  it('latches a later credential failure after successful startup validation', async () => {
    const { selectStartupCredentialIdentity, prepareCredentialValidation } =
      await import('./bootstrap')
    const nativeCipher = cipher()
    const recover = vi.fn()
    prepareCredentialValidation(
      selectStartupCredentialIdentity({ platform: 'linux', packaged: true }),
      paths(true)
    )(nativeCipher, recover)
    nativeCipher.decryptString.mockImplementation(() => {
      throw Error('access revoked')
    })
    const { credentialCipher, assertCredentialAccessAllowed } = await import('./runtime')
    expect(() => credentialCipher(nativeCipher).decryptString(Buffer.from('v11later'))).toThrow(
      /recovery/i
    )
    expect(() => credentialCipher(nativeCipher).encryptString('replacement')).toThrow(/recovery/i)
    expect(() => assertCredentialAccessAllowed()).toThrow(/recovery/i)
    expect(nativeCipher.encryptString).not.toHaveBeenCalled()
    expect(recover).toHaveBeenCalledOnce()
  })

  it('latches a backend-query exception before any secret or persistence operation', async () => {
    const { selectStartupCredentialIdentity, prepareCredentialValidation } =
      await import('./bootstrap')
    const nativeCipher = cipher()
    nativeCipher.getSelectedStorageBackend.mockImplementation(() => {
      throw Error('backend unavailable')
    })
    const recover = vi.fn()
    const validate = prepareCredentialValidation(
      selectStartupCredentialIdentity({ platform: 'linux', packaged: true }),
      paths(true)
    )
    expect(() => validate(nativeCipher, recover)).toThrow(/recovery/i)
    const { assertCredentialAccessAllowed } = await import('./runtime')
    expect(() => assertCredentialAccessAllowed()).toThrow(/recovery/i)
    expect(nativeCipher.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(recover).toHaveBeenCalledOnce()
  })

  it.each(['kwallet', 'kwallet5', 'kwallet6', 'basic', 'unknown-store'])(
    'does not substitute Secret Service for explicitly selected %s',
    async (linuxPasswordStore) => {
      const { selectStartupCredentialIdentity } = await import('./bootstrap')
      expect(() =>
        selectStartupCredentialIdentity({ platform: 'linux', packaged: true, linuxPasswordStore })
      ).toThrow(/recovery/i)
      expect(native.run).not.toHaveBeenCalled()
    }
  )

  it('allows an explicit supported backend without changing desktop selection', async () => {
    vi.stubEnv('XDG_CURRENT_DESKTOP', 'KDE')
    const { selectStartupCredentialIdentity } = await import('./bootstrap')
    expect(() => selectStartupCredentialIdentity({ platform: 'linux', packaged: true })).toThrow(
      /recovery/i
    )
    expect(native.run).not.toHaveBeenCalled()
    expect(
      selectStartupCredentialIdentity({
        platform: 'linux',
        packaged: true,
        linuxPasswordStore: 'gnome-libsecret'
      }).backend
    ).toBe('linux-secret-service')
  })

  it.each(['missing', 'locked'])(
    'rejects an existing key with a %s default collection',
    async (state) => {
      native.run.mockImplementation((_command: string, args: string[]) => ({
        status: 0,
        stdout: JSON.stringify(
          args.includes('SearchItems')
            ? { type: 'aoao', data: [['/org/freedesktop/secrets/item/key'], []] }
            : args.includes('ReadAlias')
              ? { type: 'o', data: [state === 'missing' ? '/' : '/collection/login'] }
              : { type: 'v', data: [{ type: 'b', data: true }] }
        )
      }))
      const { selectStartupCredentialIdentity } = await import('./bootstrap')
      expect(() => selectStartupCredentialIdentity({ platform: 'linux', packaged: true })).toThrow(
        /recovery/i
      )
    }
  )

  it.each([
    ['Cinnamon:KDE', '', undefined, false],
    [' GNOME : KDE ', '', undefined, true],
    ['', 'gnome', 'true', true],
    ['', 'deepin', undefined, true],
    ['', 'ukui', undefined, true],
    ['', 'xfce-session', undefined, true],
    ['', 'cinnamon', undefined, false],
    ['', 'kde', undefined, false]
  ] as const)(
    'matches Chromium desktop selection for %s / %s',
    async (desktop, session, kde, supported) => {
      vi.stubEnv('XDG_CURRENT_DESKTOP', desktop)
      vi.stubEnv('DESKTOP_SESSION', session)
      vi.stubEnv('KDE_FULL_SESSION', kde)
      const { selectStartupCredentialIdentity } = await import('./bootstrap')
      const select = (): CredentialIdentity =>
        selectStartupCredentialIdentity({ platform: 'linux', packaged: true })
      if (supported) expect(select().backend).toBe('linux-secret-service')
      else {
        expect(select).toThrow(/recovery/i)
        expect(native.run).not.toHaveBeenCalled()
      }
    }
  )

  it('blocks a key disappearing between selection and first secret access', async () => {
    const { selectStartupCredentialIdentity, prepareCredentialValidation } =
      await import('./bootstrap')
    const validate = prepareCredentialValidation(
      selectStartupCredentialIdentity({ platform: 'linux', packaged: true }),
      paths(true)
    )
    respond(false)
    const nativeCipher = cipher()
    expect(() => validate(nativeCipher, vi.fn())).toThrow(/recovery/i)
    expect(nativeCipher.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(nativeCipher.decryptString).not.toHaveBeenCalled()
  })
  it('keeps explicit headless file mode but refuses desktop file mode', async () => {
    const { configureCredentialStore, getCredentialStore } =
      await import('../settings/credential-store-mode')
    expect(() => configureCredentialStore(['--credential-store=file'], 'linux', false)).toThrow(
      /headless/
    )
    configureCredentialStore(['--credential-store=file'], 'linux', true)
    const { selectStartupCredentialIdentity, prepareCredentialValidation } =
      await import('./bootstrap')
    const identity = selectStartupCredentialIdentity({
      platform: 'linux',
      packaged: true,
      credentialStore: getCredentialStore()
    })
    const nativeCipher = cipher()
    prepareCredentialValidation(identity, paths())(nativeCipher, vi.fn())
    expect(identity.backend).toBe('file')
    expect(native.run).not.toHaveBeenCalled()
    expect(nativeCipher.isEncryptionAvailable).not.toHaveBeenCalled()
  })
})
