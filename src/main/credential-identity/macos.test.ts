import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

it.each(['legacy-key', 'missing-key', 'wrong-key'])(
  'preserves research-only credentials during upgrade identity validation: %s',
  async (scenario) => {
    const paths = { configRoot: join(root, 'config'), profilePath: join(root, 'profile') }
    mkdirSync(paths.configRoot)
    mkdirSync(paths.profilePath)
    const path = join(paths.configRoot, 'research-execution-profiles.json')
    const ciphertext = Buffer.from('v10research-ciphertext')
    const contents = JSON.stringify({
      version: 1,
      profiles: [
        {
          profileId: '11111111-1111-4111-8111-111111111111',
          projectId: 'project',
          sourceSessionId: 'source',
          sourceIdentity: 'native-source',
          descriptorVersionId: 'descriptor',
          descriptorSha256: 'a'.repeat(64),
          planKey: 'baseline',
          displayName: 'Research',
          variables: {},
          allowedNetworkHosts: [],
          conditionChanges: [],
          credentialRefs: { provider: 'enc:' + ciphertext.toString('base64') },
          updatedAt: 1
        }
      ]
    })
    writeFileSync(path, contents)
    native.run.mockImplementation((_file: string, args: string[]) => ({
      status: 0,
      signal: null,
      stdout: JSON.stringify({
        schemaVersion: 1,
        platform: 'darwin',
        identity: args[0],
        status:
          scenario === 'missing-key'
            ? 'not-found'
            : args[0] === (scenario === 'legacy-key' ? 'Open Science' : 'Open-Science')
              ? 'exists'
              : 'not-found',
        reason: 'fixture',
        osStatus: 0
      })
    }))
    const { selectStartupCredentialIdentity, prepareCredentialValidation } =
      await import('./bootstrap')
    const cipher = {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn(() => Buffer.from('must-not-create')),
      decryptString: vi.fn(() => {
        if (scenario === 'wrong-key') throw new Error('private-plaintext-must-not-leak')
        return 'private-plaintext-must-not-leak'
      })
    }
    const identity = selectStartupCredentialIdentity({ platform: 'darwin', packaged: true })
    const recover = vi.fn()
    if (scenario === 'legacy-key') {
      expect(identity.appName).toBe('Open Science')
      prepareCredentialValidation(identity, paths)(cipher, recover)
      expect(cipher.decryptString).toHaveBeenCalledExactlyOnceWith(ciphertext)
      expect(recover).not.toHaveBeenCalled()
    } else {
      let failure: unknown
      try {
        prepareCredentialValidation(identity, paths)(cipher, recover)
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({ name: 'CredentialIdentityError' })
      expect(String(failure)).not.toContain('private-plaintext')
      expect(cipher.decryptString).toHaveBeenCalledTimes(scenario === 'wrong-key' ? 1 : 0)
    }
    expect(cipher.encryptString).not.toHaveBeenCalled()
    expect(readFileSync(path, 'utf8')).toBe(contents)
    expect(readdirSync(paths.configRoot)).toEqual(['research-execution-profiles.json'])
  }
)

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
