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
  vi.stubEnv('KDE_SESSION_VERSION', undefined)
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
    if (args.some((arg) => arg.startsWith('org.kde.kwalletd'))) {
      const value = args.includes('networkWallet')
        ? { type: 's', data: ['kdewallet'] }
        : { type: 'b', data: [args.includes('keyDoesNotExist') ? !exists : !locked] }
      return { status: 0, signal: null, stdout: JSON.stringify(value) }
    }
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
  it.each(['kwallet', 'kwallet5', 'kwallet6'] as const)(
    'reuses an explicitly selected %s key without consulting another service',
    async (linuxPasswordStore) => {
      const { selectStartupCredentialIdentity, prepareCredentialValidation } =
        await import('./bootstrap')
      const nativeCipher = cipher()
      nativeCipher.getSelectedStorageBackend.mockReturnValue(linuxPasswordStore)
      const identity = selectStartupCredentialIdentity({
        platform: 'linux',
        packaged: true,
        linuxPasswordStore
      })
      expect(identity).toMatchObject({
        backend: 'linux-kwallet',
        passwordStore: linuxPasswordStore,
        wallet: 'kdewallet'
      })
      prepareCredentialValidation(identity, paths(true))(nativeCipher, vi.fn())
      expect(nativeCipher.decryptString).toHaveBeenCalledWith(Buffer.from('v11original'))
      for (const [command, args] of native.run.mock.calls) {
        const daemon =
          linuxPasswordStore === 'kwallet' ? 'kwalletd' : `kwalletd${linuxPasswordStore.slice(-1)}`
        expect(command).toBe('/usr/bin/busctl')
        expect(args).toContain(`org.kde.${daemon}`)
        expect(args).toContain(`/modules/${daemon}`)
        expect(args.join(' ')).not.toMatch(
          /org.freedesktop.secrets|readPassword|writePassword|\bopen\b|Unlock|Create/
        )
        if (args.includes('keyDoesNotExist'))
          expect(args.slice(-3)).toEqual(['kdewallet', 'Chromium Keys', 'Chromium Safe Storage'])
      }
    }
  )

  it.each([
    ['4', 'kwallet'],
    ['5', 'kwallet5'],
    ['6', 'kwallet6'],
    [undefined, 'kwallet']
  ] as const)('matches Chromium KDE_SESSION_VERSION=%s to %s', async (version, backend) => {
    vi.stubEnv('XDG_CURRENT_DESKTOP', ' KDE : GNOME ')
    vi.stubEnv('KDE_SESSION_VERSION', version)
    const { selectStartupCredentialIdentity } = await import('./bootstrap')
    expect(selectStartupCredentialIdentity({ platform: 'linux', packaged: true })).toMatchObject({
      passwordStore: backend
    })
  })

  it.each([
    'locked',
    'disabled',
    'unavailable',
    'wrong type',
    'malformed',
    'wallet changed during probe'
  ])('blocks KWallet startup without cipher access when metadata is %s', async (state) => {
    const respondNormally = native.run.getMockImplementation()!
    let walletCalls = 0
    native.run.mockImplementation((command, args) => {
      if (state === 'unavailable') return { status: 1, stdout: '' }
      if (state === 'wrong type') return { status: 0, stdout: '{"type":"s","data":["true"]}' }
      if (state === 'malformed') return { status: 0, stdout: '{bad' }
      if (
        (state === 'locked' && args.includes('isOpen')) ||
        (state === 'disabled' && args.includes('isEnabled'))
      )
        return { status: 0, stdout: '{"type":"b","data":[false]}' }
      if (
        state === 'wallet changed during probe' &&
        args.includes('networkWallet') &&
        walletCalls++ > 0
      )
        return { status: 0, stdout: '{"type":"s","data":["otherwallet"]}' }
      return respondNormally(command, args)
    })
    const { selectStartupCredentialIdentity } = await import('./bootstrap')
    expect(() =>
      selectStartupCredentialIdentity({
        platform: 'linux',
        packaged: true,
        linuxPasswordStore: 'kwallet6'
      })
    ).toThrow(/recovery/i)
  })

  it('rejects a missing original KWallet key before ready and preserves ciphertext', async () => {
    respond(false)
    const { selectStartupCredentialIdentity, prepareCredentialValidation } =
      await import('./bootstrap')
    const location = paths(true)
    const original = readFileSync(join(location.configRoot, 'settings.json'))
    const identity = selectStartupCredentialIdentity({
      platform: 'linux',
      packaged: true,
      linuxPasswordStore: 'kwallet6'
    })
    expect(() => prepareCredentialValidation(identity, location)).toThrow(/recovery/i)
    expect(readFileSync(join(location.configRoot, 'settings.json'))).toEqual(original)
  })

  it.each(['wallet changed', 'key removed', 'backend changed', 'decrypt failed'])(
    'latches recovery before replacement writes when KWallet %s after selection',
    async (state) => {
      const { selectStartupCredentialIdentity, prepareCredentialValidation } =
        await import('./bootstrap')
      const identity = selectStartupCredentialIdentity({
        platform: 'linux',
        packaged: true,
        linuxPasswordStore: 'kwallet6'
      })
      const location = paths(true)
      const original = readFileSync(join(location.configRoot, 'settings.json'))
      const validate = prepareCredentialValidation(identity, location)
      const nativeCipher = cipher()
      nativeCipher.getSelectedStorageBackend.mockReturnValue(
        state === 'backend changed' ? 'kwallet5' : 'kwallet6'
      )
      if (state === 'key removed') respond(false)
      if (state === 'wallet changed') {
        const normal = native.run.getMockImplementation()!
        native.run.mockImplementation((command, args) =>
          args.includes('networkWallet')
            ? { status: 0, stdout: '{"type":"s","data":["otherwallet"]}' }
            : normal(command, args)
        )
      }
      if (state === 'decrypt failed')
        nativeCipher.decryptString.mockImplementation(() => {
          throw Error('invalid original key')
        })
      const recover = vi.fn()
      expect(() => validate(nativeCipher, recover)).toThrow(/recovery/i)
      const { credentialCipher, assertCredentialAccessAllowed } = await import('./runtime')
      expect(() => credentialCipher(nativeCipher).encryptString('replacement')).toThrow(/recovery/i)
      expect(() => assertCredentialAccessAllowed()).toThrow(/recovery/i)
      expect(nativeCipher.encryptString).not.toHaveBeenCalled()
      if (state !== 'decrypt failed')
        expect(nativeCipher.isEncryptionAvailable).not.toHaveBeenCalled()
      expect(recover).toHaveBeenCalledOnce()
      expect(readFileSync(join(location.configRoot, 'settings.json'))).toEqual(original)
    }
  )

  it.each([false, true])(
    'issue 3161: starts on KDE with the original available KWallet backend (ciphertexts=%s)',
    async (encrypted) => {
      vi.stubEnv('XDG_CURRENT_DESKTOP', 'KDE')
      vi.stubEnv('DESKTOP_SESSION', 'plasma')
      vi.stubEnv('KDE_SESSION_VERSION', '6')
      const { selectStartupCredentialIdentity, prepareCredentialValidation } =
        await import('./bootstrap')
      const { CredentialIdentityError } = await import('./selection')
      const location = paths(encrypted)
      const settingsPath = join(location.configRoot, 'settings.json')
      const original = encrypted ? readFileSync(settingsPath) : undefined
      const nativeCipher = cipher()
      nativeCipher.getSelectedStorageBackend.mockReturnValue('kwallet6')
      const recover = vi.fn()

      // Control only external OS replies. Selection, inventory, validation and access are real.
      // The baseline refuses KDE before it probes either available service or touches the cipher.
      let failure: unknown
      try {
        const identity = selectStartupCredentialIdentity({ platform: 'linux', packaged: true })
        expect(identity.appName).toBe('Open Science')
        prepareCredentialValidation(identity, location)(nativeCipher, recover)
      } catch (error) {
        failure =
          error instanceof CredentialIdentityError
            ? { name: error.name, reason: error.reason }
            : error
      }
      expect(failure, JSON.stringify(failure)).toBeUndefined()

      if (encrypted) {
        expect(nativeCipher.decryptString).toHaveBeenCalledWith(Buffer.from('v11original'))
        expect(readFileSync(settingsPath)).toEqual(original)
      }
      expect(nativeCipher.encryptString).not.toHaveBeenCalled()
      expect(recover).not.toHaveBeenCalled()
    }
  )

  it('issue 3161: forcing libsecret without the original key preserves existing ciphertext', async () => {
    vi.stubEnv('XDG_CURRENT_DESKTOP', 'KDE')
    vi.stubEnv('DESKTOP_SESSION', 'plasma')
    respond(false)
    const { selectStartupCredentialIdentity, prepareCredentialValidation } =
      await import('./bootstrap')
    const { CredentialIdentityError } = await import('./selection')
    const location = paths(true)
    const settingsPath = join(location.configRoot, 'settings.json')
    const original = readFileSync(settingsPath)
    const nativeCipher = cipher()

    const identity = selectStartupCredentialIdentity({
      platform: 'linux',
      packaged: true,
      linuxPasswordStore: 'gnome-libsecret'
    })
    let failure: unknown
    try {
      prepareCredentialValidation(identity, location)(nativeCipher, vi.fn())
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(CredentialIdentityError)
    expect(failure).toMatchObject({ reason: 'key-missing-for-existing-ciphertext' })
    expect(nativeCipher.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(nativeCipher.decryptString).not.toHaveBeenCalled()
    expect(nativeCipher.encryptString).not.toHaveBeenCalled()
    expect(readFileSync(settingsPath)).toEqual(original)
  })

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

  it('issue 3386: a transient Secret Service failure after validation does not stop the session', async () => {
    const { selectStartupCredentialIdentity, prepareCredentialValidation } =
      await import('./bootstrap')
    const nativeCipher = cipher()
    const recover = vi.fn()
    prepareCredentialValidation(
      selectStartupCredentialIdentity({ platform: 'linux', packaged: true }),
      paths(true)
    )(nativeCipher, recover)
    // gnome-keyring drops a short-lived busctl client (GNOME/gnome-keyring#195).
    native.run.mockReturnValue({ status: 1, signal: null, stdout: '' })
    const { credentialCipher, assertCredentialAccessAllowed } = await import('./runtime')
    // Each settings load asks whether credentials can be saved.
    for (let load = 0; load < 14; load++)
      expect(credentialCipher(nativeCipher).isEncryptionAvailable()).toBe(true)
    expect(() => assertCredentialAccessAllowed()).not.toThrow()
    expect(recover).not.toHaveBeenCalled()
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

  it.each(['basic', 'unknown-store'])(
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
    vi.stubEnv('XDG_CURRENT_DESKTOP', 'LXQt')
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
    ['Cinnamon:KDE', '', undefined, true],
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
      if (supported)
        expect(select().backend).toBe(
          desktop === 'Cinnamon:KDE' ? 'linux-kwallet' : 'linux-secret-service'
        )
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
