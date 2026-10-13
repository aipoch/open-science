import { afterEach, expect, it, vi } from 'vitest'
import { backendStartupStatusSchema } from './backend-startup'

const f = vi.hoisted(() => ({
  closeOwnership: vi.fn(async () => {}),
  closeNetwork: vi.fn(async () => {}),
  disposeCipher: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
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
  configureCredentialStore: vi.fn(),
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
  // The Vitest worker has a real parent pipe: intercept only this entry's send boundary.
  const send = vi.spyOn(process, 'send').mockImplementation(() => true)
  await import('./node-entry')
  await vi.waitFor(() => expect(process.exitCode).toBeDefined())
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
