import { afterEach, expect, it, vi } from 'vitest'
import { backendStartupStatusSchema } from './backend-startup'

const f = vi.hoisted(() => ({
  startupFailure: false,
  releaseInstallation: vi.fn(),
  writeExit: vi.fn(async () => {}),
  closeOwnership: vi.fn(async () => {}),
  closeNetwork: vi.fn(async () => {}),
  disposeCipher: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('./runtime-stop-confirmation', () => ({ writeRuntimeExit: f.writeExit }))
vi.mock('./storage/config-root', () => ({
  resolveBootstrapConfigRoot: () => '/isolated-fixture/config'
}))
vi.mock('./storage/electron-profile', () => ({
  resolveElectronProfile: () => '/isolated-fixture/profile'
}))
vi.mock('./update/installation-protection', () => ({
  installationRootForEntry: () => '/isolated-fixture/app',
  registerInstallationRuntime: () => ({ release: f.releaseInstallation })
}))

// Keep the real entry's startup/cancellation/exit handling; replace external process resources.
vi.mock('./runtime-ownership', () => ({
  RuntimeOwnershipConflict: class extends Error {},
  RuntimeDirectoryOwnership: class {
    acquireSync = vi.fn()
    close = f.closeOwnership
  },
  acquireRuntimeDirectorySync: () => ({ release: vi.fn() }),
  configureRuntimeDirectoryOwnership: vi.fn()
}))
vi.mock('./runtime-metadata', () => ({ configureRuntimeMetadata: vi.fn() }))
vi.mock('./runtime-helper', () => ({
  isRuntimeHelper: () => false,
  runRuntimeHelper: async () => false
}))
vi.mock('./runtime-lifecycle', () => ({ configureRuntimeLifecycle: vi.fn() }))
vi.mock('./runtime-network', () => ({ configureRuntimeNetwork: vi.fn() }))
vi.mock('./runtime-network-node', () => ({
  createNodeRuntimeNetwork: () => ({ close: f.closeNetwork })
}))
vi.mock('./secure-storage', () => ({ configureSecureStorageCipher: vi.fn() }))
vi.mock('./settings/credential-store-mode', () => ({
  configureCredentialStore: () => {
    if (f.startupFailure) throw new Error('isolated startup failure')
  },
  getCredentialStore: () => 'os'
}))
vi.mock('./credential-identity/node-cipher', () => ({
  initializeNodeWindowsProfileKey: vi.fn(),
  createNodeSecureStorageCipher: () => ({
    dispose: f.disposeCipher,
    decryptString: () => {
      throw new Error('fixture key cannot decrypt the existing ciphertext')
    }
  })
}))
vi.mock('./credential-identity/bootstrap', async () => {
  const { createCredentialAccess } = await import('./credential-identity/access')
  const identity = { backend: 'mac-keychain', appName: 'Open Science', exists: true } as const
  return {
    selectStartupCredentialIdentity: () => identity,
    prepareCredentialValidation:
      () =>
      (
        cipher: import('./secure-storage').SecureStorageCipher,
        recover: (error: import('./credential-identity/selection').CredentialIdentityError) => void
      ) => {
        createCredentialAccess({
          identity,
          cipher,
          probe: () => ({ status: 'exists' }),
          recover
        }).decryptString(Buffer.from('v10fixture'))
      }
  }
})
vi.mock('@aipoch/diagnostics/node', async (original) => ({
  ...(await original<typeof import('@aipoch/diagnostics/node')>()),
  createLogger: () => f.log,
  flushLogs: async () => {}
}))

const exitCode = process.exitCode
const listeners = new Map(
  (['SIGINT', 'SIGTERM'] as const).map((signal) => [signal, new Set(process.listeners(signal))])
)
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  process.exitCode = exitCode
  for (const [signal, previous] of listeners) {
    for (const listener of process.listeners(signal)) {
      if (!previous.has(listener)) process.removeListener(signal, listener)
    }
  }
})

it('reports credential recovery during startup as a failure after draining resources', async () => {
  process.exitCode = undefined
  const attemptId = 'a64f6d2b-5bc3-41fb-b63b-55ffb43af30b'
  vi.stubEnv('OPEN_SCIENCE_STARTUP_ATTEMPT', attemptId)
  // Keep startup reporting from sending on or unrefing the Vitest worker's real parent pipe.
  const send = vi.spyOn(process, 'send').mockImplementation(() => true)
  const unref = vi.spyOn(process.channel!, 'unref').mockImplementation(() => {})
  await import('./node-entry')
  await vi.waitFor(() => expect(process.exitCode).toBeDefined())
  expect(unref).toHaveBeenCalledOnce()
  expect(f.log.error).toHaveBeenCalledWith('credential recovery required', {
    reason: 'decryption-failed'
  })
  expect(f.closeNetwork).toHaveBeenCalledOnce()
  expect(f.closeOwnership).toHaveBeenCalledOnce()
  expect(f.disposeCipher).toHaveBeenCalledOnce()
  expect(process.exitCode).toBe(1)
  expect(process.env.OPEN_SCIENCE_STARTUP_ATTEMPT).toBeUndefined()
  const messages = send.mock.calls.map(([message]) => backendStartupStatusSchema.parse(message))
  expect(messages).toContainEqual({
    protocolVersion: 1,
    attemptId,
    stage: 'credentials',
    kind: 'failed',
    code: 'credential-unavailable',
    reason: 'decryption-failed'
  })
  expect(JSON.stringify(messages)).not.toContain('fixture key')
})

it.each(['directory', 'installation'] as const)(
  'replaces clean evidence when %s ownership release fails',
  async (kind) => {
    vi.resetModules()
    vi.clearAllMocks()
    f.startupFailure = true
    process.exitCode = undefined
    const failure = new Error('injected release failure')
    if (kind === 'directory') f.closeOwnership.mockRejectedValueOnce(failure)
    else
      f.releaseInstallation.mockImplementationOnce(() => {
        throw failure
      })
    const send = vi.spyOn(process, 'send').mockImplementation(() => true)
    vi.spyOn(process.channel!, 'unref').mockImplementation(() => {})
    try {
      await import('./node-entry')
      await vi.waitFor(() => expect(process.exitCode).toBe(1))
      expect(
        f.writeExit.mock.calls.map(
          (call) => (call as unknown as [string, { outcome: string }])[1].outcome
        )
      ).toEqual(['clean', 'failed'])
      expect(f.log.error).toHaveBeenCalledWith(
        'shutdown ownership release failed',
        expect.any(Object)
      )
      if (kind === 'directory') expect(f.releaseInstallation).not.toHaveBeenCalled()
    } finally {
      f.startupFailure = false
      send.mockRestore()
    }
  }
)
