import { createCipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// Only the OS DPAPI boundary is synthetic. Inventory, profile validation, AES-GCM and directory
// leases use their production implementations; fixture secrets never leave the test directory.
vi.mock('./windows-profile-key', async (original) => {
  const actual = await original<typeof import('./windows-profile-key')>()
  return {
    ...actual,
    validateWindowsProfileKey: vi.fn(
      (options: Parameters<typeof actual.validateWindowsProfileKey>[0]) =>
        actual.validateWindowsProfileKey({
          ...options,
          validate: () => ({ status: 'valid' })
        })
    )
  }
})
vi.mock('./node-cipher', async (original) => {
  const actual = await original<typeof import('./node-cipher')>()
  return {
    ...actual,
    createNodeSecureStorageCipher: vi.fn(
      (identity: Parameters<typeof actual.createNodeSecureStorageCipher>[0], profilePath: string) =>
        actual.createNodeSecureStorageCipher(identity, profilePath, {
          readPassword: () => {
            throw new Error('Unexpected OS-vault access')
          },
          unprotect: (value) => Buffer.from(value)
        })
    ),
    initializeNodeWindowsProfileKey: vi.fn(() => {
      throw new Error('Selection must not initialize keys')
    })
  }
})

import {
  selectDefaultCliCredentialProfile,
  type DefaultCliProfileOptions
} from './legacy-cli-profile'
import { validateWindowsProfileKey } from './windows-profile-key'
import { createNodeSecureStorageCipher, initializeNodeWindowsProfileKey } from './node-cipher'
import { CredentialIdentityError } from './identity-contract'
import { credentialAccessInstalled } from './runtime'
import { readCredentialCiphertexts, verifyCredentialCiphertexts } from './ciphertext-inventory'
import {
  acquireRuntimeDirectorySync,
  acquireCredentialBootstrapLease,
  RuntimeOwnershipConflict,
  type RuntimeDirectoryLease
} from '../runtime-ownership'

let root: string
let options: DefaultCliProfileOptions
let legacy: string
let tracked: Map<string, Buffer>
let leases: RuntimeDirectoryLease[]
const desktopKey = Buffer.alloc(32, 0x31)
const legacyKey = Buffer.alloc(32, 0x52)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'legacy-profile-'))
  const home = join(root, 'home')
  options = {
    home,
    configRoot: join(home, '.open-science'),
    profilePath: join(home, 'app-data', 'Open-Science'),
    packaged: true,
    credentialStore: 'os',
    platform: 'win32',
    env: {},
    argv: ['node', 'backend', '--serve=44123']
  }
  legacy = join(options.configRoot, 'electron-profile')
  mkdirSync(options.configRoot, { recursive: true })
  tracked = new Map()
  leases = [acquireRuntimeDirectorySync(options.configRoot)]
  vi.clearAllMocks()
})
afterEach(() => {
  for (const [path, before] of tracked) expect(readFileSync(path).equals(before)).toBe(true)
  expect(initializeNodeWindowsProfileKey).not.toHaveBeenCalled()
  expect(credentialAccessInstalled()).toBe(false)
  for (const lease of leases) lease.release()
  rmSync(root, { recursive: true, force: true })
})

function save(path: string, contents: string): void {
  writeFileSync(path, contents)
  tracked.set(path, readFileSync(path))
}
function keyAt(profile: string, key: Buffer): void {
  mkdirSync(profile, { recursive: true })
  save(
    join(profile, 'Local State'),
    JSON.stringify({
      os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), key]).toString('base64') },
      fixtureRetained: true
    })
  )
}
function ciphertext(key: Buffer): Buffer {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  return Buffer.concat([
    Buffer.from('v10'),
    nonce,
    cipher.update('synthetic-regression-value'),
    cipher.final(),
    cipher.getAuthTag()
  ])
}
function settings(...keys: Buffer[]): void {
  const dataRoot = join(root, 'data')
  mkdirSync(dataRoot, { recursive: true })
  save(
    join(options.configRoot, 'settings.json'),
    JSON.stringify({
      version: 2,
      dataRoot,
      providers: keys.map((key) => ({ keyRef: `enc:${ciphertext(key).toString('base64')}` }))
    })
  )
}
function cookies(profile: string, key: Buffer): void {
  mkdirSync(profile, { recursive: true })
  const path = join(profile, 'Cookies')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE cookies(encrypted_value BLOB)')
  db.prepare('INSERT INTO cookies VALUES (?)').run(ciphertext(key))
  db.close()
  tracked.set(path, readFileSync(path))
}
function selected(): ReturnType<typeof selectDefaultCliCredentialProfile> {
  return selectDefaultCliCredentialProfile(options)
}
function assertReleased(profile: string): void {
  const bootstrap = acquireCredentialBootstrapLease({
    home: options.home,
    profilePath: profile,
    platform: 'win32'
  })
  const runtime = acquireRuntimeDirectorySync(profile)
  runtime.release()
  bootstrap.release()
}

it('prefers desktop credentials even when the historical CLI directory has a different key', () => {
  keyAt(options.profilePath, desktopKey)
  keyAt(legacy, legacyKey)
  settings(desktopKey)
  expect(selected().profilePath).toBe(options.profilePath)
  expect(
    vi.mocked(validateWindowsProfileKey).mock.calls.map(([value]) => value.profilePath)
  ).toEqual([options.profilePath])
})
it.each([false, true])(
  'recovers historical CLI credentials when a different desktop key exists=%s',
  (desktopExists) => {
    keyAt(legacy, legacyKey)
    settings(legacyKey)
    if (desktopExists) keyAt(options.profilePath, desktopKey)
    const result = selected()
    expect(result.profilePath).toBe(legacy)
    expect(result.validationCiphertexts?.length).toBeGreaterThan(0)
    const cipher = createNodeSecureStorageCipher(
      { backend: 'windows-dpapi', appName: 'Open-Science' },
      legacy
    )
    try {
      verifyCredentialCiphertexts(
        [
          ...result.validationCiphertexts!,
          ...readCredentialCiphertexts({ configRoot: options.configRoot, profilePath: legacy })
        ],
        (value) => cipher.decryptString(value)
      )
    } finally {
      cipher.dispose()
    }
    if (!desktopExists) expect(existsSync(join(options.profilePath, 'Local State'))).toBe(false)
    assertReleased(options.profilePath)
    assertReleased(legacy)
  }
)
it('recovers the development default without changing the config root', () => {
  for (const lease of leases) lease.release()
  options.packaged = false
  options.configRoot = join(options.home, '.open-science-project')
  options.profilePath += ' (DEV)'
  legacy = join(options.configRoot, 'electron-profile')
  mkdirSync(options.configRoot, { recursive: true })
  leases = [acquireRuntimeDirectorySync(options.configRoot)]
  keyAt(legacy, legacyKey)
  settings(legacyKey)
  expect(selected().profilePath).toBe(legacy)
})
it('does not fall back for mixed settings ciphertexts', () => {
  keyAt(options.profilePath, desktopKey)
  keyAt(legacy, legacyKey)
  settings(desktopKey, legacyKey)
  expect(selected).toThrow(expect.objectContaining({ reason: 'decryption-failed' }))
  assertReleased(options.profilePath)
  assertReleased(legacy)
})
it('preserves independent desktop cookies while recovering the historical CLI profile', () => {
  keyAt(options.profilePath, desktopKey)
  keyAt(legacy, legacyKey)
  settings(legacyKey)
  cookies(options.profilePath, desktopKey)
  cookies(legacy, legacyKey)
  expect(selected().profilePath).toBe(legacy)
})
it('does not omit incompatible ciphertexts in the legacy profile', () => {
  keyAt(options.profilePath, desktopKey)
  keyAt(legacy, legacyKey)
  settings(legacyKey)
  cookies(legacy, desktopKey)
  expect(selected).toThrow(expect.objectContaining({ reason: 'decryption-failed' }))
})
it('retains shared configuration and selected profile ciphertexts for final locked validation', () => {
  keyAt(legacy, legacyKey)
  settings(legacyKey)
  cookies(options.profilePath, legacyKey)
  cookies(legacy, legacyKey)
  const result = selected()
  expect(result.profilePath).toBe(legacy)
  expect(result.validationCiphertexts).toHaveLength(3)
})
it('does not infer an old profile from an existing directory with no key', () => {
  mkdirSync(legacy)
  settings(legacyKey)
  expect(selected).toThrow(expect.objectContaining({ reason: 'windows-profile-key-unavailable' }))
  expect(existsSync(join(legacy, 'Local State'))).toBe(false)
})
it('keeps a fresh desktop profile when there are no ciphertexts', () => {
  keyAt(legacy, legacyKey)
  settings()
  expect(selected().profilePath).toBe(options.profilePath)
  expect(createNodeSecureStorageCipher).not.toHaveBeenCalled()
  expect(existsSync(join(options.profilePath, 'Local State'))).toBe(false)
})
it('does not infer a shared credential binding from profile cookies alone', () => {
  keyAt(options.profilePath, desktopKey)
  keyAt(legacy, legacyKey)
  settings()
  cookies(options.profilePath, legacyKey)
  cookies(legacy, legacyKey)
  expect(selected()).toEqual({ profilePath: options.profilePath })
  expect(validateWindowsProfileKey).not.toHaveBeenCalled()
  expect(createNodeSecureStorageCipher).not.toHaveBeenCalled()
})
it('keeps desktop when both profiles can decrypt the existing ciphertexts', () => {
  keyAt(options.profilePath, desktopKey)
  keyAt(legacy, desktopKey)
  settings(desktopKey)
  expect(selected().profilePath).toBe(options.profilePath)
  expect(validateWindowsProfileKey).toHaveBeenCalledTimes(1)
})
it('does not mask an unreadable credential inventory with a legacy key', () => {
  keyAt(legacy, legacyKey)
  save(join(options.configRoot, 'settings.json'), '{invalid fixture JSON')
  expect(selected).toThrow()
  expect(validateWindowsProfileKey).not.toHaveBeenCalled()
})
it('does not mask a corrupt desktop Local State even if legacy can decrypt settings', () => {
  keyAt(options.profilePath, desktopKey)
  keyAt(legacy, legacyKey)
  settings(legacyKey)
  save(join(options.profilePath, 'Local State'), '{invalid fixture JSON')
  expect(selected).toThrow(
    expect.objectContaining({ diagnostic: { code: 'profile-invalid-json' } })
  )
  expect(validateWindowsProfileKey).toHaveBeenCalledTimes(1)
})
it.each(['EACCES', 'ETIMEDOUT'] as const)(
  'does not fall back after a native/access failure: %s',
  (systemCode) => {
    keyAt(options.profilePath, desktopKey)
    keyAt(legacy, legacyKey)
    settings(legacyKey)
    const failure = new CredentialIdentityError('windows-profile-key-unavailable', undefined, {
      code: systemCode === 'EACCES' ? 'profile-read-failed' : 'validator-timeout',
      systemCode
    })
    vi.mocked(validateWindowsProfileKey).mockImplementationOnce(() => {
      throw failure
    })
    expect(selected).toThrow(failure)
    expect(validateWindowsProfileKey).toHaveBeenCalledTimes(1)
  }
)
it('does not fall back after native decryption helper failure', () => {
  keyAt(options.profilePath, desktopKey)
  keyAt(legacy, legacyKey)
  settings(legacyKey)
  const failure = new CredentialIdentityError('native-secret-operation-failed', undefined, {
    code: 'secret-dpapi-failed'
  })
  vi.mocked(createNodeSecureStorageCipher).mockImplementationOnce(() => {
    throw failure
  })
  expect(selected).toThrow(failure)
  expect(validateWindowsProfileKey).toHaveBeenCalledTimes(1)
})
it.each(['runtime', 'bootstrap'] as const)(
  'preserves ownership conflict instead of switching profiles: %s',
  (kind) => {
    keyAt(options.profilePath, desktopKey)
    keyAt(legacy, legacyKey)
    settings(legacyKey)
    leases.push(
      kind === 'runtime'
        ? acquireRuntimeDirectorySync(options.profilePath)
        : acquireCredentialBootstrapLease({
            home: options.home,
            profilePath: options.profilePath,
            platform: 'win32'
          })
    )
    expect(selected).toThrow(RuntimeOwnershipConflict)
    expect(validateWindowsProfileKey).not.toHaveBeenCalled()
  }
)
it.each([
  'OPEN_SCIENCE_USER_DATA',
  'OPEN_SCIENCE_CONFIG_ROOT',
  'OPEN_SCIENCE_STORAGE_ROOT',
  'OPEN_SCIENCE_E2E_STORAGE_ROOT',
  'OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH',
  'OPEN_SCIENCE_CREDENTIAL_INVENTORY_SHA256'
])('does not override explicit launch identity: %s', (name) => {
  keyAt(legacy, legacyKey)
  settings(legacyKey)
  options.env = { [name]: join(root, 'explicit') }
  expect(selected()).toEqual({ profilePath: options.profilePath })
  expect(validateWindowsProfileKey).not.toHaveBeenCalled()
})
it.each(['desktop-arg', 'captured-attempt', 'nondefault-root', 'darwin', 'linux'])(
  'does not change a non-default or owned startup: %s',
  (kind) => {
    keyAt(legacy, legacyKey)
    settings(legacyKey)
    if (kind === 'desktop-arg') options.argv = ['node', '--desktop']
    if (kind === 'captured-attempt') options.startupAttemptId = 'captured-before-env-deletion'
    if (kind === 'nondefault-root') options.configRoot = join(root, 'custom')
    if (kind === 'darwin' || kind === 'linux') options.platform = kind
    expect(selected()).toEqual({ profilePath: options.profilePath })
    expect(validateWindowsProfileKey).not.toHaveBeenCalled()
  }
)
it('treats blank overrides consistently with the existing resolver', () => {
  keyAt(legacy, legacyKey)
  settings(legacyKey)
  options.env = {
    OPEN_SCIENCE_USER_DATA: ' ',
    OPEN_SCIENCE_CONFIG_ROOT: '',
    OPEN_SCIENCE_STORAGE_ROOT: ' '
  }
  expect(selected().profilePath).toBe(legacy)
})

it('uses the final credential mode instead of an argv os flag', () => {
  keyAt(legacy, legacyKey)
  settings(legacyKey)
  options = { ...options, credentialStore: 'file', argv: ['node', '--credential-store=os'] }
  expect(selected().profilePath).toBe(options.profilePath)
  expect(validateWindowsProfileKey).not.toHaveBeenCalled()
})
