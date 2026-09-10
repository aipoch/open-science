import { EventEmitter } from 'node:events'
import { mkdtemp, rename, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { ElectronUpdaterStrategy } from './electron-updater-strategy'
import { UpdateService } from './service'
import { downloadInstaller } from './downloader'
import { resilientDownload } from '../net/resilient-download'
vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0' },
  BrowserWindow: {},
  dialog: {},
  shell: {}
}))
vi.mock('electron-updater', () => ({
  autoUpdater: {},
  CancellationToken: class {
    cancelled = false
    cancel(): void {
      this.cancelled = true
    }
  }
}))
vi.mock('./downloader', () => ({ downloadInstaller: vi.fn() }))
const offline = async (): Promise<never> => {
  throw new Error('offline fixture')
}
const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}
class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  checkForUpdates = vi.fn(async () => {
    this.emit('update-available', { version: '1.1.0' })
  })
  downloadUpdate = vi.fn(async () => {})
  quitAndInstall = vi.fn()
}
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.clearAllMocks()
})
const createInplace = (updater: FakeUpdater, extra = {}): ElectronUpdaterStrategy =>
  new ElectronUpdaterStrategy({
    updater,
    currentVersion: '1.0.0',
    platform: 'linux',
    arch: 'x64',
    broadcast: vi.fn(),
    fetchImpl: offline,
    ...extra
  })
it('keeps a cancelled in-place download available after late progress and completion', async () => {
  const updater = new FakeUpdater()
  const finish = deferred()
  const started = deferred()
  updater.downloadUpdate.mockImplementation(async () => {
    started.resolve()
    await finish.promise
    updater.emit('update-downloaded', { version: '1.1.0' })
  })
  const strategy = createInplace(updater)
  await strategy.check()
  const pending = strategy.download()
  await started.promise
  await strategy.cancel()
  expect(strategy.getStatus().state).toBe('available')
  updater.emit('download-progress', { percent: 99, total: 100, transferred: 99 })
  expect.soft(strategy.getStatus().state).toBe('available')
  finish.resolve()
  await pending
  expect(strategy.getStatus().state).toBe('available')
})
const body = Buffer.from('verified installer fixture')
const sha256 = createHash('sha256').update(body).digest('hex')
const download = { url: 'https://cdn.example/installer.dmg', size: body.length, sha256 }
async function manual(renameImpl?: (a: string, b: string) => Promise<void>): Promise<{
  service: UpdateService
  target: string
  openPath: ReturnType<typeof vi.fn<() => Promise<string>>>
}> {
  const root = await mkdtemp(join(tmpdir(), 'update-audit-probe-'))
  roots.push(root)
  const target = join(root, 'installer.dmg')
  vi.mocked(downloadInstaller).mockImplementation(async (d, path, deps = {}) =>
    resilientDownload(d.url, path, {
      expectedSha256: d.sha256,
      expectedSize: d.size,
      expectedOrigin: 'https://cdn.example',
      signal: deps.signal,
      onProgress: deps.onProgress,
      deps: {
        renameImpl,
        fetchImpl: async () => {
          const response = new Response(body)
          Object.defineProperty(response, 'url', { value: download.url })
          return response
        }
      }
    })
  )
  const openPath = vi.fn(async () => '')
  const service = new UpdateService({
    platform: 'darwin',
    arch: 'arm64',
    currentVersion: '1.0.0',
    manifestUrl: 'https://cdn.example/version.json',
    broadcast: vi.fn(),
    promptSavePath: async () => target,
    openPath,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          version: '1.1.0',
          releaseDate: '',
          notes: '',
          downloads: { 'mac-arm64': download }
        })
      )
  })
  await service.check()
  return { service, target, openPath }
}
it('keeps a cancelled manual download available after the final rename', async () => {
  const entered = deferred(),
    finish = deferred()
  const { service } = await manual(async (a, b) => {
    if (a.endsWith('.part')) {
      entered.resolve()
      await finish.promise
    }
    await rename(a, b)
  })
  const pending = service.download()
  await entered.promise
  await service.cancel()
  expect(service.getStatus().state).toBe('available')
  finish.resolve()
  await pending
  expect(service.getStatus().state).toBe('available')
})
it('refuses to open a same-size replacement of a verified installer', async () => {
  const { service, target, openPath } = await manual()
  await service.download()
  expect(service.getStatus().state).toBe('ready')
  expect(
    createHash('sha256')
      .update(await readFile(target))
      .digest('hex')
  ).toBe(sha256)
  await writeFile(target, Buffer.alloc(body.length, 88))
  await service.apply()
  expect(openPath).not.toHaveBeenCalled()
  expect(
    createHash('sha256')
      .update(await readFile(target))
      .digest('hex')
  ).not.toBe(sha256)
})
it('omits a Linux estimate when the updater package format is unknown and the feed has both formats', async () => {
  const updater = new FakeUpdater()
  const strategy = createInplace(updater)
  updater.emit('update-available', {
    version: '1.1.0',
    files: [
      { url: 'Open-Science-1.1.0-x64.AppImage', size: 300 },
      { url: 'open-science_1.1.0_amd64.deb', size: 200 }
    ]
  })
  expect(strategy.getStatus().totalBytes).toBeUndefined()
  // This updater port supplies no package-format fact; selecting either size would be a guess.
})
it('rechecks the install gate without downloading again once research work stops', async () => {
  const updater = new FakeUpdater()
  const gate = vi.fn(async () => ({
    completed: false,
    reaped: false,
    blockedBy: ['agent' as const]
  }))
  const strategy = createInplace(updater, { installGate: gate })
  updater.downloadUpdate.mockImplementation(async () => {
    updater.emit('update-downloaded', { version: '1.1.0' })
  })
  await strategy.check()
  await strategy.download()
  await strategy.apply()
  expect(updater.quitAndInstall).not.toHaveBeenCalled()
  gate.mockResolvedValue({ completed: true, reaped: true, blockedBy: [] })
  await strategy.apply()
  expect.soft(gate).toHaveBeenCalledTimes(2)
  expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
  expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
})

it('opens an unchanged verified manual installer', async () => {
  const { service, target, openPath } = await manual()
  await service.download()
  await service.apply()
  expect(openPath).toHaveBeenCalledExactlyOnceWith(target)
})
it('allows an active in-place transfer to become ready', async () => {
  const updater = new FakeUpdater()
  updater.downloadUpdate.mockImplementation(async () => {
    updater.emit('download-progress', { percent: 99, total: 100, transferred: 99 })
    updater.emit('update-downloaded', { version: '1.1.0' })
  })
  const strategy = createInplace(updater)
  await strategy.check()
  await strategy.download()
  expect(strategy.getStatus().state).toBe('ready')
})

it('rejects cancelled transfer events while a retry is waiting for the old transfer to drain', async () => {
  const updater = new FakeUpdater()
  const firstStarted = deferred(),
    finishFirst = deferred(),
    secondStarted = deferred(),
    finishSecond = deferred()
  updater.downloadUpdate
    .mockImplementationOnce(async () => {
      firstStarted.resolve()
      await finishFirst.promise
    })
    .mockImplementationOnce(async () => {
      secondStarted.resolve()
      await finishSecond.promise
      updater.emit('update-downloaded', { version: '1.1.0' })
    })
  const strategy = createInplace(updater)
  await strategy.check()
  const first = strategy.download()
  await firstStarted.promise
  await strategy.cancel()
  const retry = strategy.download()
  const waiting = strategy.getStatus()
  updater.emit('download-progress', { percent: 99, total: 100, transferred: 99 })
  updater.emit('update-downloaded', { version: '1.1.0' })
  updater.emit('error', new Error('old transfer failed'))
  expect.soft(strategy.getStatus()).toBe(waiting)
  expect.soft(updater.downloadUpdate).toHaveBeenCalledTimes(1)
  finishFirst.resolve()
  await secondStarted.promise
  finishSecond.resolve()
  await Promise.all([first, retry])
  expect(strategy.getStatus()).toMatchObject({ state: 'ready', error: undefined })
})

it.each(['truncated', 'directory', 'missing'] as const)(
  'refuses an installer whose path is %s',
  async (change) => {
    const { service, target, openPath } = await manual()
    await service.download()
    if (change === 'truncated') await writeFile(target, body.subarray(0, 3))
    else {
      await rm(target)
      if (change === 'directory') await (await import('node:fs/promises')).mkdir(target)
    }
    await service.apply()
    expect(openPath).not.toHaveBeenCalled()
    expect(service.getStatus()).toMatchObject({ state: 'available', localPath: undefined })
  }
)
