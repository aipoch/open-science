import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('node:child_process', () => ({ spawnSync: native.run }))
let root: string
beforeEach(() => {
  vi.resetModules()
  root = mkdtempSync(join(tmpdir(), 'macos-credential-bootstrap-'))
  vi.stubGlobal(
    'process',
    Object.defineProperties(Object.create(process), {
      platform: { value: 'darwin' },
      mas: { value: false }
    })
  )
  native.run.mockReset()
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(root, { recursive: true, force: true })
})

// Execute the real selection, inventory, validation and later-access owners. Only the helper
// process and Electron cipher are doubles; native query classification has its own injected tests.
it.each([
  'new identity',
  'both identities',
  'legacy identity',
  'blocked new with legacy',
  'uncertain fresh',
  'key unavailable',
  'fresh',
  'orphaned ciphertext',
  'uncertain absence',
  'duplicate',
  'access denied',
  'decrypt failure',
  'later state change'
])('preserves macOS credential ownership through bootstrap and access: %s', async (scenario) => {
  const paths = { configRoot: join(root, 'config'), profilePath: join(root, 'profile') }
  mkdirSync(paths.configRoot)
  mkdirSync(paths.profilePath)
  const settingsPath = join(paths.configRoot, 'settings.json')
  const settings = JSON.stringify({
    version: 2,
    providers: [{ keyRef: `enc:${Buffer.from('v10original').toString('base64')}` }]
  })
  const fresh = ['fresh', 'later state change', 'uncertain fresh'].includes(scenario)
  const selectedLegacy = ['legacy identity', 'blocked new with legacy'].includes(scenario)
  if (!fresh) writeFileSync(settingsPath, settings)
  const identities = new Set(
    ['legacy identity', 'blocked new with legacy', 'uncertain absence'].includes(scenario)
      ? ['Open Science']
      : ['fresh', 'orphaned ciphertext'].includes(scenario)
        ? []
        : scenario === 'both identities'
          ? ['Open-Science', 'Open Science']
          : ['Open-Science']
  )
  let later = false
  native.run.mockImplementation((_file: string, args: string[]) => {
    const identity = args[0]
    const changed = later && scenario === 'later state change'
    const status =
      changed ||
      ['uncertain absence', 'uncertain fresh'].includes(scenario) ||
      (scenario === 'blocked new with legacy' && identity === 'Open-Science')
        ? 'access-blocked'
        : scenario === 'key unavailable' && native.run.mock.calls.length > 1
          ? 'not-found'
          : scenario === 'duplicate'
            ? 'error'
            : identities.has(identity)
              ? 'exists'
              : 'not-found'
    return {
      status: 0,
      signal: null,
      stdout: JSON.stringify({
        schemaVersion: 1,
        platform: 'darwin',
        identity,
        status,
        reason: changed
          ? 'keychain-search-list-changed'
          : status === 'access-blocked'
            ? 'keychain-locked'
            : status === 'error'
              ? 'ambiguous-account'
              : status === 'exists'
                ? 'account-metadata-found'
                : 'account-not-found',
        osStatus: 0,
        secret: 'never-log-raw-response'
      })
    }
  })
  const { selectStartupCredentialIdentity, prepareCredentialValidation } =
    await import('./bootstrap')
  const { credentialCipher, assertCredentialAccessAllowed } = await import('./runtime')
  const cipher = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`v10${value}`)),
    decryptString: vi.fn(() => {
      if (['access denied', 'decrypt failure'].includes(scenario)) throw Error('OS read failed')
      return 'original'
    })
  }
  const recover = vi.fn()
  const start = (): void => {
    const identity = selectStartupCredentialIdentity({ platform: 'darwin', packaged: true })
    expect(identity.appName).toBe(selectedLegacy ? 'Open Science' : 'Open-Science')
    prepareCredentialValidation(identity, paths)(cipher, recover)
  }
  if (
    [
      'uncertain absence',
      'uncertain fresh',
      'duplicate',
      'orphaned ciphertext',
      'access denied',
      'decrypt failure',
      'key unavailable'
    ].includes(scenario)
  ) {
    expect(start).toThrow(/recovery/i)
    expect(cipher.encryptString).not.toHaveBeenCalled()
    if (['access denied', 'decrypt failure', 'key unavailable'].includes(scenario)) {
      expect(assertCredentialAccessAllowed).toThrow(/recovery/i)
      expect(() => credentialCipher(cipher).encryptString('replacement')).toThrow(/recovery/i)
      expect(recover).toHaveBeenCalledOnce()
    } else expect(cipher.decryptString).not.toHaveBeenCalled()
  } else {
    start()
    if (scenario === 'fresh') {
      expect(cipher.decryptString).not.toHaveBeenCalled()
      expect(credentialCipher(cipher).encryptString('first')).toEqual(Buffer.from('v10first'))
    } else if (scenario === 'later state change') {
      later = true
      expect(() => credentialCipher(cipher).encryptString('replacement')).toThrow(/recovery/i)
      expect(cipher.encryptString).not.toHaveBeenCalled()
      const { formatLine } = await import('../logger')
      const error = recover.mock.calls[0][0]
      const line = formatLine('error', 'credentials', 'recovery', { identityProbe: error.probe })
      expect(JSON.parse(line).data.identityProbe.reason).toBe('keychain-search-list-changed')
      expect(line).not.toContain('never-log-raw-response')
    } else expect(cipher.decryptString).toHaveBeenCalledWith(Buffer.from('v10original'))
  }
  if (!fresh) expect(readFileSync(settingsPath, 'utf8')).toBe(settings)
  const queried = native.run.mock.calls.map(([, args]) => (args as string[])[0])
  const selectionCount = [
    'legacy identity',
    'blocked new with legacy',
    'fresh',
    'orphaned ciphertext',
    'uncertain absence',
    'uncertain fresh',
    'duplicate'
  ].includes(scenario)
    ? 2
    : 1
  expect(queried.slice(0, selectionCount)).toEqual(
    selectionCount === 2 ? ['Open-Science', 'Open Science'] : ['Open-Science']
  )
  // Later secret access rechecks only the chosen identity, never retries another key.
  expect(
    queried
      .slice(selectionCount)
      .every((name) => name === (selectedLegacy ? 'Open Science' : 'Open-Science'))
  ).toBe(true)
})
