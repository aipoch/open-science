import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const fixture = vi.hoisted(() => ({
  overridePath: '',
  spawn: vi.fn((...args: unknown[]) => {
    void args
    return {
      status: 0 as number | null,
      signal: null as string | null,
      error: undefined as Error | undefined,
      stdout: ''
    }
  })
}))
vi.mock('node:child_process', () => ({ spawnSync: (...args: unknown[]) => fixture.spawn(...args) }))
vi.mock('node:module', async (original) => {
  const actual = await original<typeof import('node:module')>()
  return {
    ...actual,
    createRequire: (url: string) => {
      const require = actual.createRequire(url)
      return (id: string) =>
        fixture.overridePath && id === '@aipoch/credential-identity-probe-native'
          ? { executablePath: fixture.overridePath, validatorExecutablePath: fixture.overridePath }
          : require(id)
    }
  }
})
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const originalMas = Object.getOwnPropertyDescriptor(process, 'mas')
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  Object.defineProperty(process, 'mas', { value: false, configurable: true })
  fixture.overridePath = ''
  fixture.spawn.mockReset().mockReturnValue({
    status: 0,
    signal: null,
    error: undefined,
    stdout: JSON.stringify({
      schemaVersion: 1,
      platform: 'darwin',
      identity: 'Open-Science',
      status: 'exists'
    })
  })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
  if (originalMas) Object.defineProperty(process, 'mas', originalMas)
  else Reflect.deleteProperty(process, 'mas')
})

it.each(['ENOENT', 'EACCES', 'ETIMEDOUT'])(
  'preserves the Windows validator process failure %s without raw output',
  async (code) => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    fixture.spawn.mockReturnValue({
      status: null,
      signal: null,
      error: Object.assign(new Error('PRIVATE-PATH'), { code }),
      stdout: 'PRIVATE-HELPER-OUTPUT'
    })
    const { validateWindowsKey } = await import('./windows-profile-key')
    expect(validateWindowsKey(Buffer.from('fixture'))).toEqual({
      status: 'error',
      diagnostic: {
        code: code === 'ETIMEDOUT' ? 'validator-timeout' : 'validator-start-failed',
        systemCode: code
      }
    })
  }
)

it('retains the numeric DPAPI error but excludes untrusted native fields', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  fixture.spawn.mockReturnValue({
    status: 0,
    signal: null,
    error: undefined,
    stdout: JSON.stringify({
      schemaVersion: 1,
      platform: 'win32',
      status: 'error',
      reason: 'dpapi-unprotect-failed',
      errorCode: 13,
      secret: 'PRIVATE-SECRET'
    })
  })
  const { validateWindowsKey } = await import('./windows-profile-key')
  expect(validateWindowsKey(Buffer.from('fixture'))).toEqual({
    status: 'error',
    diagnostic: { code: 'dpapi-unprotect-failed', osStatus: 13 }
  })
})

it.each([
  'PRIVATE-OUTPUT',
  'null',
  '[]',
  '{"schemaVersion":99}',
  '{"schemaVersion":1,"platform":"win32","status":"PRIVATE-STATUS"}'
])('rejects malformed Windows helper output without echoing it: %s', async (stdout) => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  fixture.spawn.mockReturnValue({ status: 0, signal: null, error: undefined, stdout })
  const { validateWindowsKey } = await import('./windows-profile-key')
  expect(validateWindowsKey(Buffer.from('fixture'))).toEqual({
    status: 'error',
    diagnostic: { code: 'validator-invalid-response' }
  })
})

it.each([
  ['invalid-key-size', 0, 'profile-key-invalid'],
  ['input-read-failed', 0, 'validator-input-failed'],
  ['invalid-ciphertext-size', 0, 'validator-input-failed'],
  ['binary-input-mode-unavailable', 0, 'validator-input-failed'],
  ['PRIVATE-REASON', 0, 'validator-failed'],
  ['PRIVATE-REASON', 13, 'validator-failed']
])('omits Windows status for non-DPAPI failure %s (%s)', async (reason, errorCode, code) => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  fixture.spawn.mockReturnValue({
    status: 0,
    signal: null,
    error: undefined,
    stdout: JSON.stringify({
      schemaVersion: 1,
      platform: 'win32',
      status: 'error',
      reason,
      errorCode
    })
  })
  const { validateWindowsKey } = await import('./windows-profile-key')
  expect(validateWindowsKey(Buffer.from('fixture'))).toEqual({
    status: 'error',
    diagnostic: { code }
  })
})

it.each([0, -1, 1.5, 0x100000000, 'PRIVATE-CODE'])(
  'drops an invalid native system code: %s',
  async (errorCode) => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    fixture.spawn.mockReturnValue({
      status: 0,
      signal: null,
      error: undefined,
      stdout: JSON.stringify({
        schemaVersion: 1,
        platform: 'win32',
        status: 'error',
        reason: 'dpapi-unprotect-failed',
        errorCode
      })
    })
    const { validateWindowsKey } = await import('./windows-profile-key')
    expect(validateWindowsKey(Buffer.from('fixture'))).toEqual({
      status: 'error',
      diagnostic: { code: 'dpapi-unprotect-failed' }
    })
  }
)

it('retains abnormal validator exit status without its output', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  fixture.spawn.mockReturnValue({
    status: 7,
    signal: null,
    error: undefined,
    stdout: 'PRIVATE-OUTPUT'
  })
  const { validateWindowsKey } = await import('./windows-profile-key')
  expect(validateWindowsKey(Buffer.from('fixture'))).toEqual({
    status: 'error',
    diagnostic: { code: 'validator-failed', exitCode: 7 }
  })
})

it('resolves the real package entry without loading or executing a native binding', async () => {
  const { probeCredentialIdentity } = await import('./probe')
  const entry = createRequire(import.meta.url)('@aipoch/credential-identity-probe-native') as {
    executablePath: string
  }
  expect(probeCredentialIdentity('Open-Science')).toEqual({ status: 'exists' })
  expect(fixture.spawn).toHaveBeenCalledWith(
    entry.executablePath,
    ['Open-Science'],
    expect.objectContaining({
      timeout: 10000,
      maxBuffer: 4096,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  )
})

it('maps an installed package executable out of app.asar before spawning it', async () => {
  fixture.overridePath =
    '/Applications/Open-Science.app/Contents/Resources/app.asar/node_modules/@aipoch/credential-identity-probe-native/build/Release/credential_identity_probe'
  const { probeCredentialIdentity } = await import('./probe')
  probeCredentialIdentity('Open-Science')
  expect(fixture.spawn.mock.calls[0][0]).toBe(
    fixture.overridePath.replace('app.asar/', 'app.asar.unpacked/')
  )
})

it.each([
  '',
  '{}',
  'not JSON',
  JSON.stringify({
    schemaVersion: 1,
    platform: 'darwin',
    identity: 'Open Science',
    status: 'not-found'
  }),
  JSON.stringify({
    schemaVersion: 1,
    platform: 'darwin',
    identity: 'Open-Science',
    status: 'anything'
  })
])('fails closed on unexpected helper output %s', async (stdout) => {
  fixture.spawn.mockReturnValue({ status: 0, signal: null, error: undefined, stdout })
  const { probeCredentialIdentity } = await import('./probe')
  expect(probeCredentialIdentity('Open-Science')).toEqual({ status: 'error' })
})

it.each(['access-blocked', 'error', 'not-found'] as const)(
  'preserves helper state %s without a secret call',
  async (status) => {
    fixture.spawn.mockReturnValue({
      status: 0,
      signal: null,
      error: undefined,
      stdout: JSON.stringify({
        schemaVersion: 1,
        platform: 'darwin',
        identity: 'Open-Science',
        status
      })
    })
    const { probeCredentialIdentity } = await import('./probe')
    expect(probeCredentialIdentity('Open-Science')).toEqual({ status })
  }
)

it('blocks MAS and timed-out helpers rather than inventing an absent credential', async () => {
  const { probeCredentialIdentity } = await import('./probe')
  Object.defineProperty(process, 'mas', { value: true, configurable: true })
  expect(probeCredentialIdentity('Open-Science')).toEqual({ status: 'unsupported' })
  expect(fixture.spawn).not.toHaveBeenCalled()
  Object.defineProperty(process, 'mas', { value: false, configurable: true })
  fixture.spawn.mockReturnValue({
    status: null,
    signal: 'SIGTERM',
    error: new Error('timeout'),
    stdout: ''
  })
  expect(probeCredentialIdentity('Open-Science')).toEqual({ status: 'error' })
})

it('passes only DPAPI ciphertext over stdin to the separate Windows key-read executable', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  fixture.overridePath =
    'C:\\app\\resources\\app.asar\\node_modules\\probe\\credential_key_validator.exe'
  fixture.spawn.mockReturnValue({
    status: 0,
    signal: null,
    error: undefined,
    stdout: JSON.stringify({ schemaVersion: 1, platform: 'win32', status: 'valid' })
  })
  const { validateWindowsKey } = await import('./windows-profile-key')
  const ciphertext = Buffer.from([0, 26, 13, 10, 255])
  expect(validateWindowsKey(ciphertext)).toEqual({ status: 'valid' })
  expect(fixture.spawn).toHaveBeenCalledWith(
    fixture.overridePath.replace('app.asar\\', 'app.asar.unpacked\\'),
    [],
    expect.objectContaining({ input: ciphertext, stdio: ['pipe', 'pipe', 'ignore'] })
  )
})

it.each([
  ['keychain-locked', 0],
  ['keychain-search-incomplete', 0],
  ['keychain-search-list-changed', 0],
  ['keychain-state-changed', 0],
  ['invalid-item-reference', 0],
  ['item-keychain-unavailable', -25293],
  ['item-keychain-outside-search-list', 0],
  ['metadata-query-failed', -25308]
])('preserves safe native diagnostics for %s', async (reason, osStatus) => {
  fixture.spawn.mockReturnValue({
    status: 0,
    signal: null,
    error: undefined,
    stdout: JSON.stringify({
      schemaVersion: 1,
      platform: 'darwin',
      identity: 'Open-Science',
      status: 'access-blocked',
      reason,
      osStatus,
      account: 'private-account',
      secret: 'private-secret'
    })
  })
  const { probeCredentialIdentity } = await import('./probe')
  expect(probeCredentialIdentity('Open-Science')).toEqual({
    status: 'access-blocked',
    reason,
    osStatus
  })
})

it.each([
  ['unknown-private-value', 'private-status'],
  ['password=private-secret', 0.5],
  [{ secret: 'private-secret' }, 2147483648]
])(
  'omits untrusted diagnostic fields without changing blocked status',
  async (reason, osStatus) => {
    fixture.spawn.mockReturnValue({
      status: 0,
      signal: null,
      error: undefined,
      stdout: JSON.stringify({
        schemaVersion: 1,
        platform: 'darwin',
        identity: 'Open-Science',
        status: 'access-blocked',
        reason,
        osStatus
      })
    })
    const { probeCredentialIdentity } = await import('./probe')
    expect(probeCredentialIdentity('Open-Science')).toEqual({ status: 'access-blocked' })
  }
)
