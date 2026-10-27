import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateManifest, UpdateRecoveryStatus } from '../../shared/update'
import { allowedDuringServiceStop } from '../service-command-admission'
import { ElectronUpdaterStrategy, type MinimalAutoUpdater } from './electron-updater-strategy'
import { inspectInstallerFile } from './current-installer'
import { UpdateService } from './service'

vi.mock('electron-updater', () => ({
  AppImageUpdater: class {},
  DebUpdater: class {},
  autoUpdater: {},
  CancellationToken: class {
    cancelled = false
    cancel(): void {
      this.cancelled = true
    }
  }
}))

const directories: string[] = []
const makeDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'installer-reveal-'))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

const makeProvider = (path: string): EventEmitter & MinimalAutoUpdater =>
  Object.assign(new EventEmitter(), {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: async function (this: EventEmitter) {
      this.emit('update-available', { version: '1.1.0' })
    },
    downloadUpdate: vi.fn(async function (this: EventEmitter) {
      this.emit('update-downloaded', { version: '1.1.0', downloadedFile: path })
    }),
    quitAndInstall: vi.fn()
  })

describe('read-only current installer commands', () => {
  it('keeps inspection and reveal admitted while the service is stopped', () => {
    expect(allowedDuringServiceStop('update:get-installer')).toBe(true)
    expect(allowedDuringServiceStop('update:reveal-installer')).toBe(true)
    expect(allowedDuringServiceStop('update:download')).toBe(false)
  })

  it('exposes only a completed manifest download, using the source format with the actual saved name', async () => {
    const directory = await makeDirectory()
    const path = join(directory, 'my-update')
    const bytes = Buffer.from('verified installer')
    const download = {
      url: 'https://cdn/app.dmg',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex')
    }
    const manifest: UpdateManifest = {
      version: '1.1.0',
      releaseDate: '',
      notes: '',
      downloads: { 'mac-arm64': download }
    }
    const showItemInFolder = vi.fn()
    const openPath = vi.fn(async () => '')
    const service = new UpdateService({
      currentVersion: '1.0.0',
      platform: 'darwin',
      arch: 'arm64',
      manifestUrl: 'https://cdn/version.json',
      installationGuard: () => false,
      broadcast: vi.fn(),
      promptSavePath: async () => path,
      showItemInFolder,
      openPath,
      fetchImpl: async (input) => {
        const url = String(input)
        const response = new Response(
          url.endsWith('version.json') ? JSON.stringify(manifest) : bytes
        )
        Object.defineProperty(response, 'url', { value: url })
        return response
      }
    })
    expect(await service.getInstaller()).toBeNull()
    await service.check()
    expect(await service.revealInstaller()).toBe('unavailable')
    expect((await service.download()).state).toBe('ready')
    expect(await service.getInstaller()).toEqual({
      fileName: 'my-update',
      format: 'dmg',
      platform: 'darwin'
    })
    expect(await service.revealInstaller()).toBe('revealed')
    expect(showItemInFolder).toHaveBeenCalledExactlyOnceWith(path)
    expect(openPath).not.toHaveBeenCalled()

    manifest.downloads['mac-arm64'] = { ...download, url: 'https://cdn/reissued-app.dmg' }
    expect((await service.check()).state).toBe('available')
    expect(await service.getInstaller()).toBeNull()
    expect(await service.revealInstaller()).toBe('unavailable')
    expect((await service.download()).state).toBe('ready')
    await rm(path)
    expect(await service.revealInstaller()).toBe('missing')
    expect(service.getStatus()).toMatchObject({ state: 'available' })
    expect(service.getStatus()).not.toHaveProperty('localPath')
    expect((await service.download()).state).toBe('ready')
    expect(await service.getInstaller()).toMatchObject({ format: 'dmg' })

    // A reveal during the existing OS-open request must retain applying until it settles, then
    // return the latest downloadable state rather than a stale applying RPC result.
    let opened!: () => void
    const openEntered = new Promise<void>((resolve) => {
      opened = resolve
    })
    let finishOpen!: () => void
    const openFinished = new Promise<void>((resolve) => {
      finishOpen = resolve
    })
    openPath.mockImplementationOnce(async () => {
      opened()
      await openFinished
      return ''
    })
    const applying = service.apply()
    await openEntered
    await rm(path)
    expect(await service.revealInstaller()).toBe('missing')
    expect(service.getStatus().state).toBe('applying')
    finishOpen()
    expect((await applying).state).toBe('available')
    expect(service.getStatus().state).toBe('available')
  })

  it('preserves a downloaded provider package through install failure and makes a missing package downloadable again', async () => {
    const directory = await makeDirectory()
    const path = join(directory, 'app.deb')
    await writeFile(path, 'complete')
    const provider = makeProvider(path)
    const showItemInFolder = vi.fn()
    const installGate = vi.fn(async () => {
      throw new Error('save failed')
    })
    const strategy = new ElectronUpdaterStrategy({
      updater: provider,
      currentVersion: '1.0.0',
      platform: 'linux',
      broadcast: vi.fn(),
      installGate,
      showItemInFolder,
      fetchImpl: async () => {
        throw new Error('offline')
      }
    })
    await strategy.check()
    await strategy.download()
    expect(await strategy.getInstaller()).toMatchObject({ fileName: 'app.deb', format: 'deb' })
    await strategy.apply()
    expect(await strategy.revealInstaller()).toBe('revealed')
    expect(showItemInFolder).toHaveBeenCalledExactlyOnceWith(path)
    expect(provider.quitAndInstall).not.toHaveBeenCalled()
    await rm(path)
    expect(await strategy.revealInstaller()).toBe('missing')
    expect(strategy.getStatus().state).toBe('available')
    expect(strategy.getStatus()).not.toHaveProperty('localPath')
    await strategy.apply()
    expect(installGate).toHaveBeenCalledTimes(1)
    await writeFile(path, 'redownloaded')
    await strategy.download()
    expect(provider.downloadUpdate).toHaveBeenCalledTimes(2)
    expect(await strategy.getInstaller()).toMatchObject({ format: 'deb' })
  })

  it('clears a missing package without changing an unknown installation outcome or enabling retry', async () => {
    const directory = await makeDirectory()
    const path = join(directory, 'app.deb')
    await writeFile(path, 'complete')
    const provider = makeProvider(path)
    const recovery: UpdateRecoveryStatus = {
      phase: 'handoff',
      runtime: 'unknown',
      installation: 'unknown',
      canCancel: false,
      canRetryInstall: false,
      canRecover: false
    }
    const strategy = new ElectronUpdaterStrategy({
      updater: provider,
      currentVersion: '1.0.0',
      platform: 'linux',
      broadcast: vi.fn(),
      fetchImpl: async () => {
        throw new Error('offline')
      }
    })
    await strategy.check()
    await strategy.download()
    await strategy.getInstaller()
    strategy.publishLifecycleStatus({ recovery })
    await rm(path)
    expect(await strategy.revealInstaller()).toBe('missing')
    expect(strategy.getStatus()).toMatchObject({ state: 'ready', recovery })
    await strategy.download()
    await strategy.apply()
    expect(provider.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(provider.quitAndInstall).not.toHaveBeenCalled()
  })

  it('supersedes the old locator when the provider reissues the same version with another checksum', async () => {
    const directory = await makeDirectory()
    const path = join(directory, 'app.deb')
    await writeFile(path, 'complete')
    const provider = makeProvider(path)
    let sha512 = Buffer.alloc(64, 1).toString('base64')
    provider.checkForUpdates = async () =>
      provider.emit('update-available', {
        version: '1.1.0',
        files: [{ url: 'app.deb', sha512 }]
      })
    provider.downloadUpdate = vi.fn(async () =>
      provider.emit('update-downloaded', {
        version: '1.1.0',
        downloadedFile: path,
        files: [{ url: 'app.deb', sha512 }]
      })
    )
    const strategy = new ElectronUpdaterStrategy({
      updater: provider,
      currentVersion: '1.0.0',
      platform: 'linux',
      broadcast: vi.fn(),
      fetchImpl: async () => {
        throw new Error('offline')
      }
    })
    await strategy.check()
    await strategy.download()
    expect(await strategy.getInstaller()).toMatchObject({ format: 'deb' })
    expect((await strategy.check()).state).toBe('ready')
    expect(await strategy.getInstaller()).toMatchObject({ format: 'deb' })
    sha512 = Buffer.alloc(64, 2).toString('base64')
    expect((await strategy.check()).state).toBe('available')
    expect(strategy.getStatus()).not.toHaveProperty('localPath')
    expect(await strategy.revealInstaller()).toBe('unavailable')
  })

  it('invalidates a reissued artifact while preserving restrictive recovery until the existing recovery flow succeeds', async () => {
    const directory = await makeDirectory()
    const path = join(directory, 'app.deb')
    await writeFile(path, 'complete')
    const provider = makeProvider(path)
    let sha512 = Buffer.alloc(64, 1).toString('base64')
    let refreshed = false
    provider.checkForUpdates = async () => {
      provider.emit('update-available', { version: '1.1.0', files: [{ url: 'app.deb', sha512 }] })
      if (refreshed) throw new Error('provider failed after publishing refreshed metadata')
    }
    provider.downloadUpdate = vi.fn(async () =>
      provider.emit('update-downloaded', {
        version: '1.1.0',
        downloadedFile: path,
        files: [{ url: 'app.deb', sha512 }]
      })
    )
    const recovery: UpdateRecoveryStatus = {
      phase: 'handoff',
      runtime: 'unknown',
      installation: 'unknown',
      canCancel: false,
      canRecover: false,
      canRetryInstall: false
    }
    const strategy = new ElectronUpdaterStrategy({
      updater: provider,
      currentVersion: '1.0.0',
      platform: 'linux',
      broadcast: vi.fn(),
      fetchImpl: async () => {
        throw new Error('offline')
      },
      recoverInstall: async () => ({ recovery: undefined, reason: undefined, error: undefined })
    })
    await strategy.check()
    await strategy.download()
    await strategy.getInstaller()
    strategy.publishLifecycleStatus({
      recovery,
      error: 'Original installation outcome is unknown',
      reason: 'install-failed'
    })
    sha512 = Buffer.alloc(64, 2).toString('base64')
    refreshed = true
    expect(await strategy.check()).toMatchObject({
      state: 'ready',
      recovery,
      installerMissing: true,
      error: 'Original installation outcome is unknown',
      reason: 'install-failed'
    })
    expect(strategy.getStatus()).not.toHaveProperty('localPath')
    expect(await strategy.revealInstaller()).toBe('unavailable')
    await strategy.download()
    await strategy.apply()
    expect(provider.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(provider.quitAndInstall).not.toHaveBeenCalled()
    expect((await strategy.recover()).state).toBe('available')
  })

  it('discards a stale asynchronous reveal after a new target replaces the downloaded artifact', async () => {
    const directory = await makeDirectory()
    const path = join(directory, 'app.zip')
    await writeFile(path, 'complete')
    const provider = makeProvider(path)
    const showItemInFolder = vi.fn()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let delayed = false
    const strategy = new ElectronUpdaterStrategy({
      updater: provider,
      currentVersion: '1.0.0',
      platform: 'darwin',
      broadcast: vi.fn(),
      showItemInFolder,
      fetchImpl: async () => {
        throw new Error('offline')
      },
      inspectInstallerFile: async (file) => {
        if (delayed) await gate
        return inspectInstallerFile(file)
      }
    })
    await strategy.check()
    await strategy.download()
    await strategy.getInstaller()
    delayed = true
    const revealing = strategy.revealInstaller()
    provider.emit('update-available', { version: '1.2.0' })
    release()
    expect(await revealing).toBe('unavailable')
    expect(showItemInFolder).not.toHaveBeenCalled()
    expect(strategy.getStatus()).toMatchObject({ state: 'available', latest: '1.2.0' })
    expect(await strategy.getInstaller()).toBeNull()
  })

  it('does not start an installer when its file disappears while the existing install gate is pending', async () => {
    const directory = await makeDirectory()
    const path = join(directory, 'app.deb')
    await writeFile(path, 'complete')
    const provider = makeProvider(path)
    let finishGate!: () => void
    const gate = new Promise<void>((resolve) => {
      finishGate = resolve
    })
    const strategy = new ElectronUpdaterStrategy({
      updater: provider,
      currentVersion: '1.0.0',
      platform: 'linux',
      broadcast: vi.fn(),
      installGate: async () => {
        await gate
        return { completed: true, reaped: true }
      },
      fetchImpl: async () => {
        throw new Error('offline')
      }
    })
    await strategy.check()
    await strategy.download()
    await strategy.getInstaller()
    const installing = strategy.apply()
    await Promise.resolve()
    expect(strategy.getStatus().state).toBe('applying')
    await rm(path)
    expect(await strategy.revealInstaller()).toBe('missing')
    expect(strategy.getStatus()).toMatchObject({ state: 'applying', installerMissing: true })
    finishGate()
    await installing
    expect(strategy.getStatus().state).toBe('available')
    expect(provider.quitAndInstall).not.toHaveBeenCalled()
  })
})
