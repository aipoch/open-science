import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RemoteItInstallation } from '../../shared/remote-access'
import type { WebServiceController } from '../web-service'
import type {
  detectRemoteIt,
  disableRemoteItConnectLink,
  enableRemoteItServices,
  ensureRemoteItConnectLink
} from './remoteit'
import { RemoteAccessRepository } from './repository'
import { normalizeRemoteItPublicUrl, RemoteAccessService } from './service'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const createRepository = async (): Promise<RemoteAccessRepository> => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-remote-service-'))
  roots.push(root)
  return new RemoteAccessRepository(root)
}

const remoteRequest = (host: string): IncomingMessage =>
  ({
    method: 'GET',
    url: '/',
    headers: { host },
    socket: { remoteAddress: '203.0.113.10' }
  }) as unknown as IncomingMessage

const remoteResponse = (): ServerResponse =>
  ({
    setHeader: vi.fn(),
    writeHead: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis()
  }) as unknown as ServerResponse

const webController = (port = 4180): WebServiceController => ({
  ensureStarted: vi.fn().mockResolvedValue({
    port,
    url: `http://127.0.0.1:${port}/?token=local-only`
  }),
  close: vi.fn().mockResolvedValue(undefined),
  dispose: vi.fn().mockResolvedValue(undefined),
  closeExternalConnections: vi.fn(),
  onStopped: vi.fn(() => vi.fn()),
  isRunning: vi.fn(() => true),
  runningPort: vi.fn(() => port)
})

const readyInstallation = (serviceId?: string): RemoteItInstallation => ({
  installed: true,
  loggedIn: true,
  registered: true,
  binaryPath: '/usr/local/bin/remoteit',
  version: '4.1.0',
  account: 'person@example.com',
  deviceId: 'device-1',
  service: serviceId
    ? {
        id: serviceId,
        host: '127.0.0.1',
        port: 4180,
        enabled: true,
        ready: true
      }
    : undefined
})

const createReadyDeps = (): {
  detectRemoteIt: ReturnType<typeof vi.fn<typeof detectRemoteIt>>
  enableRemoteIt: ReturnType<typeof vi.fn<typeof enableRemoteItServices>>
  ensureRemoteItLink: ReturnType<typeof vi.fn<typeof ensureRemoteItConnectLink>>
  disableRemoteItLink: ReturnType<typeof vi.fn<typeof disableRemoteItConnectLink>>
} => {
  let nextService = 0
  return {
    detectRemoteIt: vi
      .fn<typeof detectRemoteIt>()
      .mockImplementation(async (serviceId) => readyInstallation(serviceId)),
    enableRemoteIt: vi
      .fn<typeof enableRemoteItServices>()
      .mockImplementation(async (_binaryPath, _port, managedServices) => {
        const appServiceId = managedServices.appServiceId ?? 'app-service'
        const browserServiceId =
          managedServices.browserServiceId ?? `browser-service-${++nextService}`
        const activeServiceId = managedServices.active === 'app' ? appServiceId : browserServiceId
        return {
          installation: readyInstallation(activeServiceId),
          appServiceId,
          browserServiceId
        }
      }),
    ensureRemoteItLink: vi
      .fn<typeof ensureRemoteItConnectLink>()
      .mockResolvedValue('https://open-science.connect.remote.it'),
    disableRemoteItLink: vi.fn<typeof disableRemoteItConnectLink>().mockResolvedValue(undefined)
  }
}

describe('RemoteAccessService', () => {
  it('keeps the app available and blocks mutations when persisted configuration cannot load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-remote-service-invalid-config-'))
    roots.push(root)
    const path = join(root, 'remote-access.json')
    await writeFile(path, '{')
    const repository = new RemoteAccessRepository(root)
    const save = vi.spyOn(repository, 'save')
    const deps = createReadyDeps()

    const service = await RemoteAccessService.create({
      repository,
      ...deps,
      broadcast: vi.fn()
    })

    expect(service.snapshot(true, true)).toMatchObject({
      canManage: false,
      canManagePairing: false,
      mode: 'off',
      enabled: false,
      lifecycle: 'error',
      error: expect.stringContaining('Remote access configuration could not be loaded')
    })
    await expect(service.detect()).resolves.toMatchObject({ lifecycle: 'error' })
    await expect(service.setMode('remoteit')).rejects.toThrow(
      'Remote access configuration could not be loaded'
    )
    await expect(service.approve({ requestId: 'request-1', decision: 'always' })).rejects.toThrow(
      'Remote access configuration could not be loaded'
    )
    await expect(service.reject('request-1')).rejects.toThrow(
      'Remote access configuration could not be loaded'
    )
    await expect(service.revoke('browser-1')).rejects.toThrow(
      'Remote access configuration could not be loaded'
    )
    expect(deps.detectRemoteIt).not.toHaveBeenCalled()
    expect(deps.enableRemoteIt).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    await expect(readFile(path, 'utf8')).resolves.toBe('{')
  })

  it('creates a private App service and explicitly disables its Persistent Public URL', async () => {
    const repository = await createRepository()
    const deps = createReadyDeps()
    const controller = webController()
    const service = await RemoteAccessService.create({
      repository,
      ...deps,
      broadcast: vi.fn()
    })
    service.attachWebController(controller)

    await expect(service.setMode('remoteit')).resolves.toMatchObject({
      mode: 'remoteit',
      enabled: true,
      lifecycle: 'running',
      accessUrl: undefined,
      remoteIt: { service: { id: 'app-service' } }
    })
    expect(controller.ensureStarted).toHaveBeenCalledWith(44100, { attached: true })
    expect(deps.enableRemoteIt).toHaveBeenCalledWith(
      '/usr/local/bin/remoteit',
      4180,
      expect.objectContaining({
        active: 'app',
        appServiceId: undefined,
        browserServiceId: undefined,
        onServiceIdsDiscovered: expect.any(Function)
      })
    )
    expect(deps.disableRemoteItLink).toHaveBeenCalledWith('/usr/local/bin/remoteit', 'app-service')
    expect(deps.ensureRemoteItLink).not.toHaveBeenCalled()
    expect(await repository.load()).toMatchObject({
      mode: 'remoteit',
      remoteItAppServiceId: 'app-service',
      remoteItBrowserServiceId: 'browser-service-1'
    })
  })

  it('creates an isolated Browser service and enables its verified Persistent Public URL', async () => {
    const repository = await createRepository()
    const deps = createReadyDeps()
    const service = await RemoteAccessService.create({
      repository,
      ...deps,
      broadcast: vi.fn()
    })
    const controller = webController()
    service.attachWebController(controller)

    await expect(service.setMode('remoteit-public')).resolves.toMatchObject({
      mode: 'remoteit-public',
      enabled: true,
      lifecycle: 'running',
      accessUrl: 'https://open-science.connect.remote.it/',
      remoteItPublicUrl: 'https://open-science.connect.remote.it/'
    })
    expect(deps.enableRemoteIt).toHaveBeenCalledWith(
      '/usr/local/bin/remoteit',
      4180,
      expect.objectContaining({
        active: 'browser',
        appServiceId: undefined,
        browserServiceId: undefined,
        onServiceIdsDiscovered: expect.any(Function)
      })
    )
    expect(deps.ensureRemoteItLink).toHaveBeenCalledWith(
      '/usr/local/bin/remoteit',
      'browser-service-1'
    )
    expect(deps.disableRemoteItLink).toHaveBeenCalledWith('/usr/local/bin/remoteit', 'app-service')
    expect(await repository.load()).toMatchObject({
      mode: 'remoteit-public',
      remoteItAppServiceId: 'app-service',
      remoteItBrowserServiceId: 'browser-service-1',
      remoteItPublicUrl: 'https://open-science.connect.remote.it/'
    })
  })

  it('keeps separate service IDs while switching between App and Browser access', async () => {
    const repository = await createRepository()
    const deps = createReadyDeps()
    const service = await RemoteAccessService.create({
      repository,
      ...deps,
      broadcast: vi.fn()
    })
    const controller = webController()
    service.attachWebController(controller)

    await service.setMode('remoteit')
    await service.setMode('remoteit-public')
    await service.setMode('remoteit')

    expect(controller.closeExternalConnections).toHaveBeenCalledTimes(2)
    expect(deps.disableRemoteItLink).toHaveBeenCalledTimes(5)
    expect(deps.disableRemoteItLink).toHaveBeenNthCalledWith(
      5,
      '/usr/local/bin/remoteit',
      'browser-service-1'
    )

    expect(deps.enableRemoteIt).toHaveBeenNthCalledWith(
      3,
      '/usr/local/bin/remoteit',
      4180,
      expect.objectContaining({
        active: 'app',
        appServiceId: 'app-service',
        browserServiceId: 'browser-service-1',
        onServiceIdsDiscovered: expect.any(Function)
      })
    )
    expect(await repository.load()).toMatchObject({
      remoteItAppServiceId: 'app-service',
      remoteItBrowserServiceId: 'browser-service-1'
    })
  })

  it('rejects the saved public Browser host and pairs an App request after switching modes', async () => {
    const repository = await createRepository()
    const deps = createReadyDeps()
    deps.ensureRemoteItLink.mockResolvedValue('https://browser-session.r3proxy.com')
    const service = await RemoteAccessService.create({
      repository,
      ...deps,
      broadcast: vi.fn()
    })
    service.attachWebController(webController())

    await service.setMode('remoteit-public')
    await service.setMode('remoteit')

    await expect(
      service.webAccess.authorizeHttp(
        remoteRequest('browser-session.r3proxy.com'),
        remoteResponse(),
        new URL('https://browser-session.r3proxy.com/')
      )
    ).resolves.toBe('denied')
    await expect(
      service.webAccess.authorizeHttp(
        remoteRequest('private-app.r3proxy.com'),
        remoteResponse(),
        new URL('https://private-app.r3proxy.com/')
      )
    ).resolves.toBe('handled')
    expect(service.snapshot(true).pendingRequests).toHaveLength(1)
  })

  it('ignores an invalid legacy Browser URL when authorizing App access', async () => {
    const repository = await createRepository()
    await repository.save({
      version: 4,
      mode: 'remoteit',
      remoteItAppServiceId: 'app-service',
      remoteItBrowserServiceId: 'browser-service',
      remoteItPublicUrl: 'not-a-url',
      trustedBrowsers: []
    })
    const service = await RemoteAccessService.create({
      repository,
      ...createReadyDeps(),
      broadcast: vi.fn()
    })
    service.attachWebController(webController())
    await service.restore()

    await expect(
      service.webAccess.authorizeHttp(
        remoteRequest('private-app.r3proxy.com'),
        remoteResponse(),
        new URL('https://private-app.r3proxy.com/')
      )
    ).resolves.toBe('handled')
    expect(service.snapshot(true).pendingRequests).toHaveLength(1)
  })

  it('disconnects the revoked trusted browser immediately', async () => {
    const repository = await createRepository()
    await repository.save({
      version: 4,
      mode: 'remoteit-public',
      trustedBrowsers: [
        {
          id: 'trusted-browser',
          browser: 'Safari',
          platform: 'macOS',
          tokenHash: '00',
          createdAt: 1,
          lastSeenAt: 1
        }
      ]
    })
    const service = await RemoteAccessService.create({
      repository,
      ...createReadyDeps(),
      broadcast: vi.fn()
    })
    const controller = {
      ...webController(),
      closeExternalConnections: vi.fn()
    }
    service.attachWebController(controller)
    let releaseSave: (() => void) | undefined
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    vi.spyOn(repository, 'save').mockReturnValue(saveGate)

    const revocation = service.revoke('trusted-browser')

    await vi.waitFor(() =>
      expect(controller.closeExternalConnections).toHaveBeenCalledWith('trusted-browser')
    )
    releaseSave?.()
    await revocation
  })

  it('does not retain an unclaimed trusted browser when access is disabled during approval', async () => {
    const repository = await createRepository()
    const service = await RemoteAccessService.create({
      repository,
      ...createReadyDeps(),
      broadcast: vi.fn()
    })
    service.attachWebController(webController())
    await service.setMode('remoteit')
    await service.webAccess.authorizeHttp(
      remoteRequest('private-app.r3proxy.com'),
      remoteResponse(),
      new URL('https://private-app.r3proxy.com/')
    )
    const [pending] = service.snapshot(true).pendingRequests
    let releaseSave: (() => void) | undefined
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    const persist = repository.save.bind(repository)
    const save = vi.spyOn(repository, 'save')
    save
      .mockImplementationOnce(async (value) => {
        await saveGate
        await persist(value)
      })
      .mockImplementation((value) => persist(value))

    const approval = service.approve({ requestId: pending.id, decision: 'always' })
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
    const disabling = service.disable()
    await Promise.resolve()
    releaseSave?.()
    await Promise.all([approval, disabling])

    expect((await repository.load()).trustedBrowsers).toHaveLength(0)
  })

  it('soft-disables access without deleting either provider service', async () => {
    const repository = await createRepository()
    const deps = createReadyDeps()
    const service = await RemoteAccessService.create({
      repository,
      ...deps,
      broadcast: vi.fn()
    })
    const controller = webController()
    service.attachWebController(controller)

    await service.setMode('remoteit-public')
    await expect(service.disable()).resolves.toMatchObject({
      mode: 'off',
      enabled: false,
      lifecycle: 'disabled',
      accessUrl: undefined
    })
    expect(deps.enableRemoteIt).toHaveBeenCalledTimes(1)
    expect(controller.closeExternalConnections).toHaveBeenCalledWith()
    expect((await repository.load()).mode).toBe('off')
  })

  it('marks remote access unavailable when the attached Web service stops and repairs on detect', async () => {
    const repository = await createRepository()
    const deps = createReadyDeps()
    const service = await RemoteAccessService.create({
      repository,
      ...deps,
      broadcast: vi.fn()
    })
    let stopped: (() => void) | undefined
    const controller = {
      ...webController(),
      onStopped: vi.fn((listener: () => void) => {
        stopped = listener
        return vi.fn()
      })
    }
    service.attachWebController(controller)
    await service.setMode('remoteit')

    stopped?.()

    expect(service.snapshot(true)).toMatchObject({
      mode: 'remoteit',
      enabled: false,
      lifecycle: 'error'
    })
    expect(service.snapshot(true).error).toMatch(/web service stopped/i)

    await expect(service.detect()).resolves.toMatchObject({
      mode: 'remoteit',
      enabled: true,
      lifecycle: 'running'
    })
    expect(controller.ensureStarted).toHaveBeenCalledTimes(2)
  })

  it('does not report Running when the attached Web service stops during provider setup', async () => {
    const repository = await createRepository()
    const deps = createReadyDeps()
    let releaseProvider: (() => void) | undefined
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })
    deps.enableRemoteIt.mockImplementation(async () => {
      await providerGate
      return {
        installation: readyInstallation('app-service'),
        appServiceId: 'app-service',
        browserServiceId: 'browser-service'
      }
    })
    const service = await RemoteAccessService.create({
      repository,
      ...deps,
      broadcast: vi.fn()
    })
    let stopped: (() => void) | undefined
    let webRunning = true
    const controller = {
      ...webController(),
      isRunning: vi.fn(() => webRunning),
      onStopped: vi.fn((listener: () => void) => {
        stopped = listener
        return vi.fn()
      })
    }
    service.attachWebController(controller)

    const starting = service.setMode('remoteit')
    await vi.waitFor(() => expect(deps.enableRemoteIt).toHaveBeenCalledOnce())
    webRunning = false
    stopped?.()
    releaseProvider?.()

    await expect(starting).resolves.toMatchObject({
      mode: 'remoteit',
      enabled: false,
      lifecycle: 'error'
    })
    expect(service.snapshot(true).error).toMatch(/web service stopped/i)
  })

  it('does not republish running state when shutdown interrupts provider setup', async () => {
    const repository = await createRepository()
    const deps = createReadyDeps()
    let releaseProvider: (() => void) | undefined
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })
    deps.enableRemoteIt.mockImplementation(async () => {
      await providerGate
      return {
        installation: readyInstallation('app-service'),
        appServiceId: 'app-service',
        browserServiceId: 'browser-service'
      }
    })
    const published: ReturnType<RemoteAccessService['snapshot']>[] = []
    const serviceHolder: { current?: RemoteAccessService } = {}
    const service = await RemoteAccessService.create({
      repository,
      ...deps,
      broadcast: vi.fn(() => published.push(serviceHolder.current!.snapshot(true)))
    })
    serviceHolder.current = service
    service.attachWebController(webController())

    const starting = service.setMode('remoteit')
    await vi.waitFor(() => expect(deps.enableRemoteIt).toHaveBeenCalledOnce())
    let shutdownSettled = false
    const shutdown = service.shutdown().then(() => {
      shutdownSettled = true
    })
    const postShutdownPublication = published.length

    await Promise.resolve()
    expect(shutdownSettled).toBe(false)
    releaseProvider?.()
    await shutdown

    await expect(starting).resolves.toMatchObject({
      mode: 'off',
      enabled: false,
      lifecycle: 'disabled'
    })
    expect(service.snapshot(true)).toMatchObject({
      mode: 'off',
      enabled: false,
      lifecycle: 'disabled'
    })
    expect(published.slice(postShutdownPublication)).not.toContainEqual(
      expect.objectContaining({ enabled: true, lifecycle: 'running' })
    )
  })

  it('does not restart remote access when shutdown interrupts detection', async () => {
    const repository = await createRepository()
    const deps = createReadyDeps()
    const published: ReturnType<RemoteAccessService['snapshot']>[] = []
    const serviceHolder: { current?: RemoteAccessService } = {}
    const service = await RemoteAccessService.create({
      repository,
      ...deps,
      broadcast: vi.fn(() => published.push(serviceHolder.current!.snapshot(true)))
    })
    serviceHolder.current = service
    service.attachWebController(webController())
    await service.setMode('remoteit')
    let releaseDetection: (() => void) | undefined
    const detectionGate = new Promise<void>((resolve) => {
      releaseDetection = resolve
    })
    deps.detectRemoteIt.mockImplementationOnce(async () => {
      await detectionGate
      return readyInstallation('app-service')
    })

    const detecting = service.detect()
    await vi.waitFor(() => expect(deps.detectRemoteIt).toHaveBeenCalledTimes(2))
    const shutdown = service.shutdown()
    const postShutdownPublication = published.length
    releaseDetection?.()
    await shutdown

    await expect(detecting).resolves.toMatchObject({
      mode: 'off',
      enabled: false,
      lifecycle: 'disabled'
    })
    expect(service.snapshot(true)).toMatchObject({
      mode: 'off',
      enabled: false,
      lifecycle: 'disabled'
    })
    expect(published.slice(postShutdownPublication)).not.toContainEqual(
      expect.objectContaining({ enabled: true, lifecycle: 'running' })
    )
  })

  it('fails closed and keeps the setup error attached to the selected mode', async () => {
    const repository = await createRepository()
    const service = await RemoteAccessService.create({
      repository,
      detectRemoteIt: vi.fn<typeof detectRemoteIt>().mockResolvedValue({
        installed: false,
        loggedIn: false,
        registered: false
      }),
      enableRemoteIt: vi.fn<typeof enableRemoteItServices>(),
      ensureRemoteItLink: vi.fn<typeof ensureRemoteItConnectLink>(),
      disableRemoteItLink: vi.fn<typeof disableRemoteItConnectLink>(),
      broadcast: vi.fn()
    })
    const controller = webController()
    service.attachWebController(controller)

    await expect(service.setMode('remoteit')).resolves.toMatchObject({
      mode: 'remoteit',
      enabled: false,
      lifecycle: 'error',
      error: expect.stringContaining('not installed')
    })
    expect(controller.ensureStarted).not.toHaveBeenCalled()
    expect((await repository.load()).mode).toBe('off')
  })

  it('fails closed and disconnects remote clients when provider detection fails', async () => {
    const repository = await createRepository()
    const deps = createReadyDeps()
    const service = await RemoteAccessService.create({
      repository,
      ...deps,
      broadcast: vi.fn()
    })
    const controller = webController()
    service.attachWebController(controller)
    await service.setMode('remoteit')
    deps.detectRemoteIt.mockRejectedValueOnce(new Error('provider probe failed'))

    await expect(service.detect()).resolves.toMatchObject({
      mode: 'remoteit',
      enabled: false,
      lifecycle: 'error',
      error: 'provider probe failed'
    })
    expect(controller.closeExternalConnections).toHaveBeenCalledOnce()
  })

  it('runs the full local Device and service setup when Detect follows a pre-install selection', async () => {
    const repository = await createRepository()
    const installedWithoutDevice: RemoteItInstallation = {
      installed: true,
      loggedIn: true,
      registered: false,
      binaryPath: '/usr/local/bin/remoteit',
      version: '4.1.0'
    }
    const detectProvider = vi
      .fn<typeof detectRemoteIt>()
      .mockResolvedValueOnce({
        installed: false,
        loggedIn: false,
        registered: false
      })
      .mockResolvedValue(installedWithoutDevice)
    const prepareProvider = vi.fn<typeof enableRemoteItServices>().mockResolvedValue({
      installation: readyInstallation('app-service'),
      appServiceId: 'app-service',
      browserServiceId: 'browser-service'
    })
    const service = await RemoteAccessService.create({
      repository,
      detectRemoteIt: detectProvider,
      enableRemoteIt: prepareProvider,
      ensureRemoteItLink: vi.fn<typeof ensureRemoteItConnectLink>(),
      disableRemoteItLink: vi.fn<typeof disableRemoteItConnectLink>().mockResolvedValue(undefined),
      broadcast: vi.fn()
    })
    service.attachWebController(webController())

    await expect(service.setMode('remoteit')).resolves.toMatchObject({
      mode: 'remoteit',
      enabled: false,
      lifecycle: 'error'
    })
    expect(prepareProvider).not.toHaveBeenCalled()

    await expect(service.detect()).resolves.toMatchObject({
      mode: 'remoteit',
      enabled: true,
      lifecycle: 'running',
      remoteIt: { registered: true, service: { id: 'app-service' } }
    })
    expect(prepareProvider).toHaveBeenCalledOnce()
    expect(prepareProvider).toHaveBeenCalledWith(
      '/usr/local/bin/remoteit',
      4180,
      expect.objectContaining({
        active: 'app',
        appServiceId: undefined,
        browserServiceId: undefined,
        onServiceIdsDiscovered: expect.any(Function)
      })
    )
  })

  it('repairs Browser access and refreshes its URL when Detect runs', async () => {
    const repository = await createRepository()
    const deps = createReadyDeps()
    const service = await RemoteAccessService.create({
      repository,
      ...deps,
      broadcast: vi.fn()
    })
    const controller = webController()
    service.attachWebController(controller)

    await service.setMode('remoteit-public')
    await expect(service.detect()).resolves.toMatchObject({
      mode: 'remoteit-public',
      enabled: true,
      accessUrl: 'https://open-science.connect.remote.it/'
    })
    expect(deps.ensureRemoteItLink).toHaveBeenCalledTimes(2)
    expect(controller.closeExternalConnections).toHaveBeenCalledOnce()
    expect(deps.enableRemoteIt).toHaveBeenLastCalledWith(
      '/usr/local/bin/remoteit',
      4180,
      expect.objectContaining({
        active: 'browser',
        appServiceId: 'app-service',
        browserServiceId: 'browser-service-1',
        onServiceIdsDiscovered: expect.any(Function)
      })
    )
  })

  it('repairs an unavailable App route when Detect runs', async () => {
    const repository = await createRepository()
    const deps = createReadyDeps()
    const service = await RemoteAccessService.create({
      repository,
      ...deps,
      broadcast: vi.fn()
    })
    const controller = webController()
    service.attachWebController(controller)

    await service.setMode('remoteit')
    deps.detectRemoteIt.mockResolvedValueOnce({
      ...readyInstallation('app-service'),
      service: {
        id: 'app-service',
        host: '127.0.0.1',
        port: 4180,
        enabled: false,
        ready: false
      }
    })

    await expect(service.detect()).resolves.toMatchObject({
      mode: 'remoteit',
      enabled: true,
      lifecycle: 'running',
      remoteIt: { service: { id: 'app-service', enabled: true, ready: true } }
    })
    expect(controller.closeExternalConnections).toHaveBeenCalledOnce()
    expect(deps.enableRemoteIt).toHaveBeenCalledTimes(2)
    expect(deps.enableRemoteIt).toHaveBeenLastCalledWith(
      '/usr/local/bin/remoteit',
      4180,
      expect.objectContaining({
        active: 'app',
        appServiceId: 'app-service',
        browserServiceId: 'browser-service-1',
        onServiceIdsDiscovered: expect.any(Function)
      })
    )
  })

  it('reuses service IDs saved before a transient post-creation status failure', async () => {
    const repository = await createRepository()
    const deps = createReadyDeps()
    let attempt = 0
    deps.enableRemoteIt.mockImplementation(async (_binaryPath, _port, managedServices) => {
      attempt += 1
      if (attempt === 1) {
        await managedServices.onServiceIdsDiscovered?.({
          appServiceId: 'app-created',
          browserServiceId: 'browser-created'
        })
        throw new Error('Remote.It status is temporarily unavailable.')
      }
      return {
        installation: readyInstallation('app-created'),
        appServiceId: managedServices.appServiceId ?? 'unexpected-app',
        browserServiceId: managedServices.browserServiceId ?? 'unexpected-browser'
      }
    })
    const service = await RemoteAccessService.create({
      repository,
      ...deps,
      broadcast: vi.fn()
    })
    service.attachWebController(webController())

    await expect(service.setMode('remoteit')).resolves.toMatchObject({
      enabled: false,
      lifecycle: 'error'
    })
    expect(await repository.load()).toMatchObject({
      remoteItAppServiceId: 'app-created',
      remoteItBrowserServiceId: 'browser-created'
    })

    await expect(service.setMode('remoteit')).resolves.toMatchObject({
      enabled: true,
      lifecycle: 'running'
    })
    expect(deps.enableRemoteIt).toHaveBeenLastCalledWith(
      '/usr/local/bin/remoteit',
      4180,
      expect.objectContaining({
        appServiceId: 'app-created',
        browserServiceId: 'browser-created'
      })
    )
  })

  it('validates provider browser endpoints without accepting arbitrary hosts', () => {
    expect(
      normalizeRemoteItPublicUrl(' https://open-science.p020.r3proxy.com/path?ignored=1 ')
    ).toBe('https://open-science.p020.r3proxy.com/')
    expect(normalizeRemoteItPublicUrl('https://open-science.connect.remote.it/path')).toBe(
      'https://open-science.connect.remote.it/'
    )
    expect(() => normalizeRemoteItPublicUrl('http://open-science.p020.r3proxy.com')).toThrow(
      'invalid HTTPS browser URL'
    )
    expect(() => normalizeRemoteItPublicUrl('https://attacker.example.com')).toThrow(
      'invalid HTTPS browser URL'
    )
  })
})
