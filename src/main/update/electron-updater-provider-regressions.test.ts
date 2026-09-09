import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { ElectronUpdaterStrategy } from './electron-updater-strategy'
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
    cancel() {
      this.cancelled = true
    }
  }
}))
const requireRepo = createRequire(join(process.cwd(), 'package.json'))
const { AppUpdater } = requireRepo('electron-updater/out/AppUpdater')
const { DebUpdater } = requireRepo('electron-updater/out/DebUpdater')
const { CancellationToken } = requireRepo('builder-util-runtime')
const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
const offline = async () => {
  throw new Error('No network in audit')
}

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
    const updater = new EventEmitter() as any
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
    let token: any
    updater.downloadUpdate = (t: any) => {
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
        done: async (e: any) => updater.emit('update-downloaded', e)
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
      expect(token.cancelled).toBe(cancelled)
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
  const updater = new EventEmitter() as any
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
  let selected: any
  const provider = {
    resolveFiles: () =>
      files.map((info) => ({ url: new URL(info.url, 'https://cdn.example/'), info }))
  }
  DebUpdater.prototype.doDownloadUpdate.call(
    {
      executeDownload: (o: any) => {
        selected = o.fileInfo
        return Promise.resolve([])
      }
    },
    { updateInfoAndProvider: { provider, info: { version: '0.27.0', files } } }
  )
  expect(selected.info.size).toBe(600)
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
