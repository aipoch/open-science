import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { backendStartupStatusSchema } from './backend-startup'
import { createElectronCallerContext } from './caller-context'
import { ApplicationCallerLeaseRegistry } from './caller-lifecycle'

const f = vi.hoisted(() => ({
  initLogs: vi.fn(),
  startupFailure: false,
  healthyCredentials: false,
  releaseInstallation: vi.fn(),
  writeExit: vi.fn(async () => {}),
  closeOwnership: vi.fn(async () => {}),
  closeNetwork: vi.fn(async () => {}),
  disposeCipher: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  spawn: vi.fn(() => ({ once: vi.fn(), unref: vi.fn() })),
  lifecycle: vi.fn<typeof import('./runtime-lifecycle').configureRuntimeLifecycle>(),
  startDesktop: vi.fn<typeof import('./desktop-runtime-transport').startDesktopRuntimeTransport>(),
  startControl: vi.fn<typeof import('./runtime-control').startRuntimeControl>(),
  createRuntime: vi.fn<typeof import('./core-runtime').createCoreRuntime>(),
  createWeb: vi.fn<typeof import('./web-service').createWebServiceController>(),
  verifyDatabase: vi.fn(async () => ({})),
  disconnectDatabase: vi.fn(async () => {}),
  unsubscribeLocale: vi.fn(),
  locale: {
    initialize: vi.fn(() => 'locale'),
    setPreference: vi.fn(() => 'updated-locale'),
    snapshot: vi.fn(() => 'locale-snapshot')
  },
  networkInfo: vi.fn(() => 'network-info'),
  connectivity: vi.fn(async () => 'connected'),
  desktop: {
    endpoint: { port: 44101 },
    close: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    hasActiveDocuments: vi.fn(() => true),
    requestNative: vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true)
  },
  control: { close: vi.fn(async () => {}) },
  runtime: {
    prepareForQuit: vi.fn(async () => 'completed'),
    dispose: vi.fn(async () => {}),
    abortDesktopUpdate: vi.fn(),
    bindRemoteAccess: vi.fn(),
    permissionApprovalPresence: { acquire: vi.fn(() => () => {}) },
    applicationCommands: {
      desktop: {
        commandNames: vi.fn(() => ['sessions:list']),
        invoke: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'runtime-result')
      }
    }
  },
  web: { ensureStarted: vi.fn(async () => ({ port: 44100 })), dispose: vi.fn(async () => {}) },
  remote: {
    webAccess: {},
    attachWebController: vi.fn(),
    restore: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {})
  },
  desktopLifecycle: { request: vi.fn(async () => 'accepted'), disconnect: vi.fn(async () => {}) }
}))

vi.mock('./runtime-stop-confirmation', () => ({ writeRuntimeExit: f.writeExit }))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: f.spawn
}))
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
  acquireCredentialBootstrapLease: () => ({ release: vi.fn() }),
  configureRuntimeDirectoryOwnership: vi.fn()
}))
vi.mock('./runtime-metadata', () => ({ configureRuntimeMetadata: vi.fn() }))
vi.mock('./runtime-helper', () => ({
  isRuntimeHelper: () => false,
  runRuntimeHelper: async () => false
}))
vi.mock('./runtime-lifecycle', () => ({ configureRuntimeLifecycle: f.lifecycle }))
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
    isEncryptionAvailable: () => true,
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
        if (f.healthyCredentials) return
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
  initLogger: f.initLogs,
  flushLogs: async () => {}
}))

// Exercise the entry's real composition and database readiness gate without opening services.
vi.mock('./storage-root', () => ({ resolveDataRoot: () => '/isolated-fixture/data' }))
vi.mock('./storage/initialize-location', () => ({
  prepareApplicationLocations: async () => ({
    settingsStore: {},
    repository: { getSettings: async () => ({ localePreference: 'system' }) }
  })
}))
vi.mock('./projects/prisma-client', () => ({
  getProjectDbClient: f.verifyDatabase,
  disconnectProjectDbClient: f.disconnectDatabase
}))
vi.mock('./locale/owner', () => ({
  LocalePreferenceOwner: class {
    initialize = f.locale.initialize
    setPreference = f.locale.setPreference
    snapshot = f.locale.snapshot
    subscribe = (): (() => void) => f.unsubscribeLocale
  }
}))
vi.mock('./network-ipc', () => ({
  createNetworkCommandOwner: () => ({ getInfo: f.networkInfo, checkConnectivity: f.connectivity })
}))
vi.mock('./desktop-runtime-transport', () => ({ startDesktopRuntimeTransport: f.startDesktop }))
vi.mock('./runtime-control', () => ({ startRuntimeControl: f.startControl }))
vi.mock('./core-runtime', () => ({ createCoreRuntime: f.createRuntime }))
vi.mock('./web-service', () => ({ createWebServiceController: f.createWeb }))
vi.mock('./remote-access/service', () => ({
  RemoteAccessService: { create: async () => f.remote }
}))
vi.mock('./desktop-runtime-lifecycle', () => ({
  createDesktopRuntimeLifecycle: () => f.desktopLifecycle
}))
vi.mock('./desktop-interaction', () => ({
  configureDesktopFileInteraction: vi.fn(),
  configureDesktopShellInteraction: vi.fn(),
  createRemoteDesktopFileInteraction: vi.fn(),
  createRemoteDesktopShellInteraction: vi.fn(),
  DesktopCapabilityUnavailable: class extends Error {}
}))
vi.mock('./office-preview/application-commands', () => ({
  configureOfficePreviewHost: vi.fn(),
  createRemoteOfficePreviewHost: vi.fn()
}))
vi.mock('./reviewer/paged-preview-host', () => ({ configureDesktopReviewer: vi.fn() }))

const exitCode = process.exitCode
const listeners = new Map(
  (['SIGINT', 'SIGTERM'] as const).map((signal) => [signal, new Set(process.listeners(signal))])
)
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  f.healthyCredentials = false
  f.startupFailure = false
  f.startDesktop.mockResolvedValue(
    f.desktop as unknown as Awaited<ReturnType<typeof f.startDesktop>>
  )
  f.startControl.mockResolvedValue(f.control as Awaited<ReturnType<typeof f.startControl>>)
  f.createRuntime.mockResolvedValue(
    f.runtime as unknown as Awaited<ReturnType<typeof f.createRuntime>>
  )
  f.createWeb.mockReturnValue(f.web as unknown as ReturnType<typeof f.createWeb>)
  process.exitCode = undefined
})
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
  expect(f.initLogs).toHaveBeenCalledWith({ logDir: expect.stringMatching(/config[/\\]logs$/) })
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

const startHealthyRuntime = async (): Promise<MockInstance<NonNullable<typeof process.send>>> => {
  f.healthyCredentials = true
  vi.stubEnv('OPEN_SCIENCE_STARTUP_ATTEMPT', 'a64f6d2b-5bc3-41fb-b63b-55ffb43af30b')
  const send = vi.spyOn(process, 'send').mockImplementation(() => true)
  vi.spyOn(process.channel!, 'unref').mockImplementation(() => {})
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  await import('./node-entry')
  return send
}

const waitForReady = async (
  send: Awaited<ReturnType<typeof startHealthyRuntime>>
): Promise<void> => {
  await vi.waitFor(() =>
    expect(
      send.mock.calls.some(
        ([message]) => backendStartupStatusSchema.parse(message).kind === 'ready'
      )
    ).toBe(true)
  )
}

it('publishes readiness only after the endpoint opens and drains services once on quit', async () => {
  const endpoint = Promise.withResolvers<{ port: number }>()
  f.web.ensureStarted.mockReturnValueOnce(endpoint.promise)
  const send = await startHealthyRuntime()
  await vi.waitFor(() => expect(f.web.ensureStarted).toHaveBeenCalledOnce())
  expect(
    send.mock.calls.some(([message]) => backendStartupStatusSchema.parse(message).kind === 'ready')
  ).toBe(false)
  expect(f.initLogs.mock.invocationCallOrder[0]).toBeLessThan(
    f.createRuntime.mock.invocationCallOrder[0]
  )
  endpoint.resolve({ port: 44100 })
  await waitForReady(send)
  expect(f.remote.attachWebController).toHaveBeenCalledWith(f.web)
  expect(f.remote.restore).toHaveBeenCalledOnce()
  const stages = send.mock.calls.map(([message]) => backendStartupStatusSchema.parse(message).stage)
  expect(stages).toEqual(['credentials', 'storage', 'database', 'runtime', 'endpoint', 'endpoint'])

  f.lifecycle.mock.calls[0][0].quit()
  f.lifecycle.mock.calls[0][0].quit()
  await vi.waitFor(() => expect(process.exitCode).toBe(0))
  const closes = [
    f.remote.shutdown,
    f.control.close,
    f.desktop.close,
    f.web.dispose,
    f.runtime.dispose,
    f.disconnectDatabase,
    f.closeNetwork
  ]
  for (const close of closes) expect(close).toHaveBeenCalledOnce()
  for (let index = 1; index < closes.length; index++)
    expect(closes[index - 1].mock.invocationCallOrder[0]).toBeLessThan(
      closes[index].mock.invocationCallOrder[0]
    )
  expect(f.unsubscribeLocale).toHaveBeenCalledOnce()
  expect(f.disposeCipher).toHaveBeenCalledOnce()
  expect(f.writeExit).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ outcome: 'clean' })
  )
  expect(f.releaseInstallation.mock.invocationCallOrder[0]).toBeGreaterThan(
    f.writeExit.mock.invocationCallOrder[0]
  )
})

it('keeps startup commands bounded until database verification and hands off to runtime owners', async () => {
  const database = Promise.withResolvers<object>()
  f.verifyDatabase.mockReturnValueOnce(database.promise)
  const send = await startHealthyRuntime()
  await vi.waitFor(() => expect(f.verifyDatabase).toHaveBeenCalledOnce())
  const transport = f.startDesktop.mock.calls[0][0]
  const callerContext = createElectronCallerContext(7)
  const callers = new ApplicationCallerLeaseRegistry()
  const invocation = { args: [], callerContext, callerLease: callers.acquire(callerContext).lease }
  expect(transport.commands.commandNames()).toEqual([
    'locale:initialize',
    'locale:set-preference',
    'network:get-info',
    'network:check-connectivity'
  ])
  expect(await transport.commands.invoke('locale:initialize', invocation)).toBe('locale')
  expect(
    await transport.commands.invoke('locale:set-preference', {
      ...invocation,
      args: [{ preference: 'de' }]
    })
  ).toBe('updated-locale')
  expect(f.locale.setPreference).toHaveBeenCalledWith('de')
  expect(await transport.commands.invoke('network:get-info', invocation)).toBe('network-info')
  expect(await transport.commands.invoke('network:check-connectivity', invocation)).toBe(
    'connected'
  )
  expect(() => transport.commands.invoke('sessions:list', invocation)).toThrow('still starting')
  expect(transport.permissionApprovalPresence!.acquire()).toBeUndefined()
  expect(await transport.hostCommands!.invoke('locale:snapshot', invocation)).toBe(
    'locale-snapshot'
  )
  await expect(transport.hostCommands!.invoke('sessions:list', invocation)).rejects.toThrow(
    'still starting'
  )
  const lifecycle = transport.createLifecycle!()
  expect(() => lifecycle.request({ operation: 'inspect' })).toThrow('still starting')
  expect(f.createRuntime).not.toHaveBeenCalled()
  const ensureWeb = f.startControl.mock.calls[0][2]
  const isStopping = f.startControl.mock.calls[0][5]!
  await expect(ensureWeb(44102)).rejects.toThrow('still starting')
  expect(isStopping()).toBe(false)

  database.resolve({})
  await waitForReady(send)
  expect(transport.commands.commandNames()).toEqual(['sessions:list'])
  expect(await transport.commands.invoke('sessions:list', invocation)).toBe('runtime-result')
  expect(await transport.hostCommands!.invoke('sessions:list', invocation)).toBe('runtime-result')
  expect(f.runtime.applicationCommands.desktop.invoke).toHaveBeenCalledWith(
    'sessions:list',
    invocation
  )
  expect(transport.permissionApprovalPresence!.acquire()).toEqual(expect.any(Function))
  expect(f.runtime.permissionApprovalPresence.acquire).toHaveBeenCalledOnce()
  expect(await ensureWeb(44102)).toEqual({ port: 44100 })
  expect(f.web.ensureStarted).toHaveBeenLastCalledWith(44102, { attached: false })
  expect(await lifecycle.request({ operation: 'inspect' })).toBe('accepted')
  expect(f.desktopLifecycle.request).toHaveBeenCalledWith({ operation: 'inspect' })
  await lifecycle.disconnect()
  expect(f.desktopLifecycle.disconnect).toHaveBeenCalledOnce()
  expect(f.runtime.abortDesktopUpdate).toHaveBeenCalledOnce()
  transport.requestShutdown!()
  await vi.waitFor(() => expect(process.exitCode).toBe(0))
  expect(transport.isStopping!()).toBe(true)
  expect(isStopping()).toBe(true)
  callers.dispose()
})

it('preserves renderer durability decisions and delegates restart to the connected desktop', async () => {
  const send = await startHealthyRuntime()
  await waitForReady(send)
  const options = f.createRuntime.mock.calls[0][0]
  expect(options.canRequestDesktopCredential?.()).toBe(true)
  f.desktop.requestNative.mockResolvedValueOnce(false)
  expect(await options.confirmRendererDurability?.('data-root-handoff')).toBe(false)
  expect(f.desktop.requestNative).toHaveBeenLastCalledWith({
    operation: 'renderer-flush',
    policy: 'data-root-handoff'
  })
  options.notifyRendererDurabilityAborted?.()
  expect(f.desktop.requestNative).toHaveBeenLastCalledWith({ operation: 'renderer-flush-aborted' })
  f.desktop.isConnected.mockReturnValueOnce(false)
  expect(await options.confirmRendererDurability?.('data-root-handoff')).toBe(true)

  const lifecycle = f.lifecycle.mock.calls[0][0]
  lifecycle.relaunch()
  lifecycle.quit()
  await vi.waitFor(() => expect(process.exitCode).toBe(0))
  await vi.dynamicImportSettled()
  expect(f.desktop.requestNative).toHaveBeenLastCalledWith({ operation: 'runtime-relaunch' })
  expect(f.runtime.prepareForQuit).toHaveBeenCalledOnce()
  expect(f.spawn).not.toHaveBeenCalled()
})

it('retains ownership and records failed shutdown when a running service cannot drain', async () => {
  const send = await startHealthyRuntime()
  await waitForReady(send)
  f.runtime.dispose.mockRejectedValueOnce(new Error('service drain failed'))
  f.createWeb.mock.calls[0][0].requestQuit()
  await vi.waitFor(() => expect(process.exitCode).toBe(1))
  expect(f.disconnectDatabase).toHaveBeenCalledOnce()
  expect(f.closeNetwork).toHaveBeenCalledOnce()
  expect(f.writeExit).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ outcome: 'failed' })
  )
  expect(f.closeOwnership).not.toHaveBeenCalled()
  expect(f.releaseInstallation).not.toHaveBeenCalled()
})

it('waits for database verification to settle before honoring a startup shutdown request', async () => {
  const database = Promise.withResolvers<object>()
  f.verifyDatabase.mockReturnValueOnce(database.promise)
  const send = await startHealthyRuntime()
  await vi.waitFor(() => expect(f.verifyDatabase).toHaveBeenCalledOnce())
  const terminate = process
    .listeners('SIGTERM')
    .find((listener) => !listeners.get('SIGTERM')!.has(listener))!
  terminate('SIGTERM')
  expect(f.disconnectDatabase).not.toHaveBeenCalled()
  expect(f.closeOwnership).not.toHaveBeenCalled()
  expect(process.exitCode).toBeUndefined()
  database.resolve({})
  await vi.waitFor(() => expect(process.exitCode).toBe(0))
  expect(f.createRuntime).not.toHaveBeenCalled()
  expect(f.disconnectDatabase).toHaveBeenCalledOnce()
  expect(f.closeOwnership).toHaveBeenCalledOnce()
  expect(
    send.mock.calls.map(([message]) => backendStartupStatusSchema.parse(message).kind)
  ).not.toContain('ready')
  expect(
    send.mock.calls.map(([message]) => backendStartupStatusSchema.parse(message).kind)
  ).not.toContain('failed')
})
