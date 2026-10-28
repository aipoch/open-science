import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { DownloadedUpdateHelper as SdkDownloadHelper } from 'electron-updater/out/DownloadedUpdateHelper'
import { expect, it, vi } from 'vitest'
import {
  ElectronUpdaterStrategy,
  type MinimalAutoUpdater,
  type MinimalCancellationToken
} from './electron-updater-strategy'
vi.mock('electron', () => ({
  app: { getVersion: () => '0.26.0' },
  BrowserWindow: { getAllWindows: () => [] },
  net: {}
}))
vi.mock('electron-updater', async () => ({
  AppImageUpdater: (await import('electron-updater/out/AppImageUpdater')).AppImageUpdater,
  DebUpdater: (await import('electron-updater/out/DebUpdater')).DebUpdater,
  autoUpdater: {},
  CancellationToken: class {
    cancelled = false
    cancel(): void {
      this.cancelled = true
    }
  }
}))
const requireRepo = createRequire(join(process.cwd(), 'package.json'))
const { AppUpdater } = requireRepo('electron-updater/out/AppUpdater')
const { DebUpdater } = requireRepo('electron-updater/out/DebUpdater')
const { CancellationToken } = requireRepo('builder-util-runtime')
const { NodeHttpExecutor } = requireRepo('builder-util/out/nodeHttpExecutor')
const { ElectronHttpExecutor } = requireRepo('electron-updater/out/electronHttpExecutor')
const { DownloadedUpdateHelper } = requireRepo('electron-updater/out/DownloadedUpdateHelper')
const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
const offline = async (): Promise<never> => {
  throw new Error('No network in audit')
}

type RealCacheSession = {
  strategy: ElectronUpdaterStrategy
  updater: MinimalAutoUpdater & EventEmitter
  helper: () => SdkDownloadHelper
}

// Use the installed updater's provider, transfer, SHA-512 stream and persisted/in-memory cache.
// Only the HTTP request adapter is Node-based so this loopback test needs no Electron process.
const realCacheFixture = async (
  rejectRetry = false
): Promise<
  RealCacheSession & {
    bytes: Buffer
    packageRequests: () => number
    freshSession: () => RealCacheSession
    corrupt: () => Promise<void>
    close: () => Promise<void>
  }
> => {
  const directory = await mkdtemp(join(tmpdir(), 'same-process-sdk-cache-'))
  const bytes = Buffer.from('verified installer bytes')
  const sha512 = createHash('sha512').update(bytes).digest('base64')
  const info = { version: '0.27.0', files: [{ url: 'installer.deb', sha512, size: bytes.length }] }
  let packageRequests = 0
  const server = createServer((request, response) => {
    if (request.url?.split('?')[0].endsWith('.yml')) {
      response.end(JSON.stringify(info))
    } else {
      packageRequests += 1
      const body = rejectRetry && packageRequests > 1 ? Buffer.alloc(bytes.length) : bytes
      response.writeHead(200, { 'Content-Length': body.length })
      response.end(body)
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected loopback server address')
  const config = join(directory, 'app-update.yml')
  await writeFile(config, 'updaterCacheDirName: sdk-regression\n')
  const freshSession = (): RealCacheSession => {
    const updater = new DebUpdater(undefined, {
      name: 'SdkCacheRegression',
      version: '0.26.0',
      isPackaged: true,
      appUpdateConfigPath: config,
      userDataPath: join(directory, 'profile'),
      baseCachePath: directory,
      whenReady: async () => {},
      quit: vi.fn(),
      relaunch: vi.fn(),
      onQuit: vi.fn()
    })
    const executor = new NodeHttpExecutor()
    executor.download = ElectronHttpExecutor.prototype.download
    updater.httpExecutor = executor
    updater._testOnlyOptions = { platform: 'linux' }
    updater.setFeedURL(`http://127.0.0.1:${address.port}/`)
    updater.logger = log
    updater.quitAndInstall = vi.fn()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.26.0',
      platform: 'linux',
      broadcast: () => {},
      installationGuard: () => false,
      fetchImpl: offline,
      createCancellationToken: () => new CancellationToken()
    })
    return {
      updater,
      strategy,
      helper: () => Reflect.get(updater, 'downloadedUpdateHelper') as SdkDownloadHelper
    }
  }
  const session = freshSession()
  try {
    await session.strategy.check()
    expect((await session.strategy.download()).state).toBe('ready')
    expect(await session.strategy.getInstaller()).toMatchObject({ format: 'deb' })
    expect(session.helper()).toBeInstanceOf(DownloadedUpdateHelper)
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return {
    ...session,
    bytes,
    packageRequests: () => packageRequests,
    freshSession,
    corrupt: async () => {
      const path = session.strategy.getStatus().localPath!
      const damaged = Buffer.from(bytes)
      damaged[0] ^= 1
      await writeFile(path, damaged)
      await utimes(path, new Date(), new Date(Date.now() + 1000))
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  }
}

it.each(['inspect', 'reveal'] as const)(
  'rechecks a modified same-process SDK cache after %s invalidates its installer',
  async (inspection) => {
    const fixture = await realCacheFixture()
    try {
      expect(fixture.packageRequests()).toBe(1)
      await fixture.corrupt()
      if (inspection === 'inspect') expect(await fixture.strategy.getInstaller()).toBeNull()
      else expect(await fixture.strategy.revealInstaller()).toBe('missing')
      expect(fixture.strategy.getStatus()).toMatchObject({
        state: 'available',
        installerMissing: true
      })
      const result = await fixture.strategy.download()
      expect(fixture.packageRequests()).toBe(2)
      expect(result.state).toBe('ready')
      expect(await readFile(result.localPath!)).toEqual(fixture.bytes)
      expect(await fixture.strategy.getInstaller()).toMatchObject({ format: 'deb' })
      expect(fixture.updater.quitAndInstall).not.toHaveBeenCalled()
    } finally {
      await fixture.close()
    }
  }
)

it('rejects a damaged replacement transfer instead of reconfirming its old SDK receipt', async () => {
  const fixture = await realCacheFixture(true)
  try {
    await fixture.corrupt()
    expect(await fixture.strategy.revealInstaller()).toBe('missing')
    const result = await fixture.strategy.download()
    expect(fixture.packageRequests()).toBe(2)
    expect(result.state).toBe('error')
    expect(result.error).toContain('checksum mismatch')
    expect(result.localPath).toBeUndefined()
    expect(await fixture.strategy.getInstaller()).toBeNull()
  } finally {
    await fixture.close()
  }
})

it('keeps healthy same-process and fresh-session SDK cache reuse unchanged', async () => {
  const fixture = await realCacheFixture()
  try {
    await fixture.updater.downloadUpdate(new CancellationToken())
    expect(fixture.packageRequests()).toBe(1)
    const fresh = fixture.freshSession()
    expect(await fresh.strategy.getInstaller()).toBeNull()
    await fresh.strategy.check()
    expect((await fresh.strategy.download()).state).toBe('ready')
    expect(fresh.helper()).not.toBe(fixture.helper())
    expect(fixture.packageRequests()).toBe(1)
    expect(await fresh.strategy.getInstaller()).toMatchObject({ format: 'deb' })
  } finally {
    await fixture.close()
  }
})

it('does not transfer or revive ready when cancelled during invalidated-cache cleanup', async () => {
  const fixture = await realCacheFixture()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const clearing = new Promise<void>((resolve) => {
    entered = resolve
  })
  const clear = fixture.helper().clear.bind(fixture.helper())
  vi.spyOn(fixture.helper(), 'clear').mockImplementationOnce(async () => {
    entered()
    await gate
    await clear()
  })
  try {
    await fixture.corrupt()
    expect(await fixture.strategy.revealInstaller()).toBe('missing')
    const retry = fixture.strategy.download()
    await clearing
    fixture.updater.emit('update-downloaded', {
      version: '0.27.0',
      downloadedFile: fixture.helper().file
    })
    expect(fixture.strategy.getStatus().state).toBe('downloading')
    expect(fixture.strategy.getStatus().localPath).toBeUndefined()
    await fixture.strategy.cancel()
    release()
    expect((await retry).state).toBe('available')
    expect(fixture.packageRequests()).toBe(1)
    expect(await fixture.strategy.getInstaller()).toBeNull()
    expect((await fixture.strategy.download()).state).toBe('ready')
    expect(fixture.packageRequests()).toBe(2)
  } finally {
    release()
    await fixture.close()
  }
})

it.each(['failed', 'unavailable'] as const)(
  'does not accept a modified SDK receipt when invalidated-cache reset is %s',
  async (failure) => {
    const fixture = await realCacheFixture()
    const helper = fixture.helper()
    const clear = helper.clear.bind(helper)
    if (failure === 'failed')
      vi.spyOn(helper, 'clear').mockRejectedValueOnce(new Error('cache cleanup failed'))
    else Reflect.set(helper, 'clear', undefined)
    try {
      await fixture.corrupt()
      expect(await fixture.strategy.revealInstaller()).toBe('missing')
      expect((await fixture.strategy.download()).state).toBe('error')
      expect(fixture.packageRequests()).toBe(1)
      expect(await fixture.strategy.getInstaller()).toBeNull()
      Reflect.set(helper, 'clear', clear)
      expect((await fixture.strategy.download()).state).toBe('ready')
      expect(fixture.packageRequests()).toBe(2)
    } finally {
      Reflect.set(helper, 'clear', clear)
      await fixture.close()
    }
  }
)

it.each([undefined, '00000000-0000-4000-8000-000000000001'])(
  'passes only an operation UUID to the real NSIS launcher (%s)',
  async (operationId) => {
    const { NsisUpdater } = requireRepo('electron-updater/out/NsisUpdater')
    const spawnLog = vi.fn(async () => {})
    const dispatchError = vi.fn()
    const updater = {
      installerPath: 'installer.exe',
      openScienceUpdateOperation: operationId,
      spawnLog,
      dispatchError
    }
    expect(
      NsisUpdater.prototype.doInstall.call(updater, { isSilent: false, isForceRunAfter: true })
    ).toBe(true)
    expect(spawnLog).toHaveBeenCalledWith(
      'installer.exe',
      operationId
        ? ['--updated', `--open-science-update-operation=${operationId}`, '--force-run']
        : ['--updated', '--force-run']
    )
    updater.openScienceUpdateOperation = '../untrusted-path'
    expect(NsisUpdater.prototype.doInstall.call(updater, {})).toBe(false)
    expect(spawnLog).toHaveBeenCalledTimes(1)
    expect(dispatchError).toHaveBeenCalledOnce()
  }
)

it.each([
  ['x64', 'latest-linux'],
  ['arm64', 'latest-linux-arm64']
])('uses the installed updater architecture channel for %s', (arch, channel) => {
  const { Provider } = requireRepo('electron-updater/out/providers/Provider')
  // Upstream Provider.getChannelFilePrefix reads process.env.TEST_UPDATER_ARCH || process.arch.
  // Exercise its own test seam; a custom app channel would receive the architecture suffix twice.
  vi.stubEnv('TEST_UPDATER_ARCH', arch)
  try {
    const provider = new Provider({ platform: 'linux', executor: {} })
    expect(provider.getDefaultChannelName()).toBe(channel)
  } finally {
    vi.unstubAllEnvs()
  }
})

it.each([true, false])(
  'handles real updater cache completion with cancellation=%s',
  async (cancelled) => {
    const temp = await mkdtemp(join(tmpdir(), 'release-update-cache-'))
    let entered!: () => void, release!: () => void
    const enteredPromise = new Promise<void>((r) => {
      entered = r
    })
    const validation = new Promise<void>((r) => {
      release = r
    })
    const updater = new EventEmitter() as EventEmitter &
      MinimalAutoUpdater & {
        _logger: typeof log
        getOrCreateDownloadHelper: () => Promise<unknown>
      }
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true
    updater._logger = log
    updater.checkForUpdates = async () => {
      updater.emit('checking-for-update')
      updater.emit('update-available', { version: '0.27.0' })
    }
    updater.quitAndInstall = vi.fn()
    updater.getOrCreateDownloadHelper = async () => ({
      cacheDirForPendingUpdate: temp,
      cacheDir: temp,
      validateDownloadedPath: async (p: string) => {
        entered()
        await validation
        return p
      },
      setDownloadedFile: async () => {}
    })
    let token: MinimalCancellationToken | undefined
    updater.downloadUpdate = (t?: MinimalCancellationToken): Promise<unknown> => {
      if (!t) throw new Error('Expected cancellation token')
      token = t
      return AppUpdater.prototype.executeDownload.call(updater, {
        fileExtension: 'exe',
        fileInfo: {
          url: new URL('https://cdn.example/app.exe'),
          info: { url: 'app.exe', sha512: Buffer.alloc(64).toString('base64') }
        },
        downloadUpdateOptions: {
          cancellationToken: t,
          requestHeaders: {},
          updateInfoAndProvider: { info: { version: '0.27.0' } }
        },
        task: async () => {
          throw new Error('Network task must not run for cache')
        },
        done: async (e: unknown) => updater.emit('update-downloaded', e)
      })
    }
    const s = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.26.0',
      platform: 'win32',
      arch: 'x64',
      fetchImpl: offline,
      broadcast: () => {},
      createCancellationToken: () => new CancellationToken()
    })
    try {
      await s.check()
      const downloading = s.download()
      await enteredPromise
      if (cancelled) expect((await s.cancel()).state).toBe('available')
      expect(token?.cancelled).toBe(cancelled)
      release()
      await downloading
      expect(s.getStatus().state).toBe(cancelled ? 'available' : 'ready')
      expect(updater.quitAndInstall).not.toHaveBeenCalled()
    } finally {
      release()
      await rm(temp, { recursive: true, force: true })
    }
  }
)

it('does not claim an AppImage size for an unknown Linux provider that may download deb', async () => {
  const files = [
    { url: 'aipoch-open-science-0.27.0-linux-x64.AppImage', size: 900 },
    { url: 'aipoch-open-science_0.27.0_amd64.deb', size: 600 }
  ]
  const updater = new EventEmitter() as EventEmitter & MinimalAutoUpdater
  updater.checkForUpdates = async () =>
    updater.emit('update-available', { version: '0.27.0', files })
  updater.downloadUpdate = vi.fn()
  updater.quitAndInstall = vi.fn()
  const strategy = new ElectronUpdaterStrategy({
    updater,
    currentVersion: '0.26.0',
    platform: 'linux',
    arch: 'x64',
    fetchImpl: offline,
    broadcast: () => {}
  })
  await strategy.check()
  let selected: { info: { size: number } } | undefined
  const provider = {
    resolveFiles: () =>
      files.map((info) => ({ url: new URL(info.url, 'https://cdn.example/'), info }))
  }
  DebUpdater.prototype.doDownloadUpdate.call(
    {
      executeDownload: (o: { fileInfo: { info: { size: number } } }) => {
        selected = o.fileInfo
        return Promise.resolve([])
      }
    },
    { updateInfoAndProvider: { provider, info: { version: '0.27.0', files } } }
  )
  expect(selected?.info.size).toBe(600)
  expect(strategy.getStatus().totalBytes).toBeUndefined()
})

it.each(['download-progress', 'update-downloaded', 'error'])(
  'ignores cancelled provider %s while an immediate retry waits for cleanup',
  async (event) => {
    let finish!: () => void
    const draining = new Promise<void>((resolve) => {
      finish = resolve
    })
    const updater = Object.assign(new EventEmitter(), {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      checkForUpdates: async () => {
        updater.emit('update-available', { version: '0.27.0' })
      },
      downloadUpdate: vi.fn(async () => {
        await draining
      }),
      quitAndInstall: vi.fn()
    })
    const broadcasts = vi.fn()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.26.0',
      platform: 'win32',
      broadcast: broadcasts,
      fetchImpl: offline
    })
    await strategy.check()
    const first = strategy.download()
    await strategy.cancel()
    const second = strategy.download()
    const waiting = strategy.getStatus()
    broadcasts.mockClear()
    updater.emit(
      event,
      event === 'error' ? new Error('cancelled transfer') : { percent: 100, total: 900 }
    )
    expect(strategy.getStatus()).toBe(waiting)
    expect(broadcasts).not.toHaveBeenCalled()
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
    updater.downloadUpdate.mockImplementationOnce(async () => {
      updater.emit('update-downloaded', { version: '0.27.0' })
    })
    finish()
    await Promise.all([first, second])
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2)
    expect(strategy.getStatus().state).toBe('ready')
  }
)

it.each(['deb', 'AppImage'])(
  'uses the actual %s provider format for the Linux estimate',
  async (format) => {
    const { AppImageUpdater } = requireRepo('electron-updater/out/AppImageUpdater')
    const Provider = format === 'deb' ? DebUpdater : AppImageUpdater
    const updater = new Provider(undefined, {
      version: '0.26.0',
      name: 'test',
      isPackaged: true,
      appUpdateConfigPath: '',
      userDataPath: '',
      baseCachePath: '',
      whenReady: async () => {},
      relaunch: () => {},
      quit: () => {},
      onQuit: () => {}
    })
    const files = [
      { url: 'aipoch-open-science-0.27.0-linux-x86_64.AppImage', size: 900 },
      { url: 'aipoch-open-science_0.27.0_amd64.deb', size: 600 }
    ]
    updater.checkForUpdates = async () =>
      updater.emit('update-available', { version: '0.27.0', files })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      platform: 'linux',
      arch: 'x64',
      broadcast: () => {},
      fetchImpl: offline
    })
    await strategy.check()
    expect(strategy.getStatus().totalBytes).toBe(format === 'deb' ? 600 : 900)
    updater.emit('update-available', {
      version: '0.27.0',
      files: files.filter((file) => !file.url.endsWith(`.${format}`))
    })
    expect(strategy.getStatus().totalBytes).toBeUndefined()
  }
)
