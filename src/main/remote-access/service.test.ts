import { mkdtemp, rm } from 'node:fs/promises'
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

const webController = (port = 4180): WebServiceController => ({
  ensureStarted: vi.fn().mockResolvedValue({
    port,
    url: `http://127.0.0.1:${port}/?token=local-only`
  }),
  close: vi.fn().mockResolvedValue(undefined),
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
    service.attachWebController(webController())

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
    service.attachWebController(webController())

    await service.setMode('remoteit')
    await service.setMode('remoteit-public')
    await service.setMode('remoteit')

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

  it('soft-disables access without deleting either provider service', async () => {
    const repository = await createRepository()
    const deps = createReadyDeps()
    const service = await RemoteAccessService.create({
      repository,
      ...deps,
      broadcast: vi.fn()
    })
    service.attachWebController(webController())

    await service.setMode('remoteit-public')
    await expect(service.disable()).resolves.toMatchObject({
      mode: 'off',
      enabled: false,
      lifecycle: 'disabled',
      accessUrl: undefined
    })
    expect(deps.enableRemoteIt).toHaveBeenCalledTimes(1)
    expect((await repository.load()).mode).toBe('off')
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
    service.attachWebController(webController())

    await service.setMode('remoteit-public')
    await expect(service.detect()).resolves.toMatchObject({
      mode: 'remoteit-public',
      enabled: true,
      accessUrl: 'https://open-science.connect.remote.it/'
    })
    expect(deps.ensureRemoteItLink).toHaveBeenCalledTimes(2)
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
