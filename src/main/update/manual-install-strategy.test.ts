import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ElectronUpdaterStrategy, type ElectronUpdaterDeps } from './electron-updater-strategy'
import { UpdateService } from './service'
import { ManualInstallerFallback } from './manual-install'

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
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
// Keep the fixture return shape inferred so mock signatures remain exact.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function setup(download = true) {
  const directory = await mkdtemp(join(tmpdir(), 'manual-provider-test-'))
  directories.push(directory)
  const bytes = Buffer.from('complete installer from the update channel')
  const name = 'aipoch-open-science-2.0.0-win-x64-setup.exe'
  const path = join(directory, name)
  await writeFile(path, bytes)
  const file = {
    url: name,
    size: bytes.length,
    sha512: createHash('sha512').update(bytes).digest('base64')
  }
  class Updater extends EventEmitter {
    autoDownload = false
    autoInstallOnAppQuit = false
    checkForUpdates = vi.fn(async () => {
      this.emit('update-available', { version: '2.0.0', files: [file] })
    })
    downloadUpdate = vi.fn(async () => {
      this.emit('update-downloaded', { version: '2.0.0', files: [file], downloadedFile: path })
    })
    quitAndInstall = vi.fn()
  }
  const updater = new Updater()
  const reveal = vi.fn(async () => {})
  const common: ElectronUpdaterDeps = {
    updater,
    currentVersion: '1.0.0',
    platform: 'win32',
    arch: 'x64',
    broadcast: vi.fn(),
    installationGuard: () => false,
    fetchImpl: async () => {
      throw new Error('no notes')
    },
    manualInstallStorePath: join(directory, 'receipt.json'),
    verifyManualInstallerSignature: async () => {},
    revealManualInstallerFile: reveal,
    markUpdateShutdown: () => () => {},
    manualInstallRecovery: async (...args) => terminalObservation(...args)
  }
  const terminalObservation = (
    ...args: Parameters<NonNullable<ElectronUpdaterDeps['manualInstallRecovery']>>
  ): ReturnType<NonNullable<ElectronUpdaterDeps['manualInstallRecovery']>> =>
    common.manualInstallRecovery === initialObservation
      ? Promise.resolve('pending' as const)
      : common.manualInstallRecovery!(...args)
  const initialObservation = common.manualInstallRecovery
  const strategy = new ElectronUpdaterStrategy(common)
  await strategy.check()
  if (download) await strategy.download()
  return { directory, updater, common, strategy, path, bytes, reveal }
}

// Use a real rename failure rather than mocking the fallback's failure-recording method.
async function blockReceipt(path: string): Promise<void> {
  await rm(path, { force: true })
  await mkdir(path)
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function setupManifest(download = true) {
  const f = await setup(false)
  const artifact = {
    url: 'https://updates.example/aipoch-open-science-2.0.0-mac-arm64.dmg',
    size: f.bytes.length,
    sha256: createHash('sha256').update(f.bytes).digest('hex')
  }
  const fetchImpl = vi.fn(async (url: unknown) => {
    if (String(url).endsWith('version.json'))
      return new Response(
        JSON.stringify({ version: '2.0.0', downloads: { 'mac-arm64': artifact } })
      )
    const response = new Response(f.bytes, {
      headers: { 'content-length': String(f.bytes.length) }
    })
    Object.defineProperty(response, 'url', { value: artifact.url })
    return response
  })
  const configuration = {
    ...f.common,
    platform: 'darwin' as const,
    arch: 'arm64',
    fetchImpl: fetchImpl as typeof fetch,
    manifestUrl: 'https://updates.example/version.json',
    promptSavePath: async () => join(f.directory, 'installer.dmg'),
    openPath: vi.fn(async () => ''),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  }
  const service = new UpdateService(configuration)
  await service.check()
  if (download) await service.download()
  return { ...f, service, configuration, fetchImpl, receipt: configuration.manualInstallStorePath! }
}

it.each(['rejection', 'error event'] as const)(
  'settles an Electron download %s when the failure receipt cannot be persisted',
  async (failure) => {
    const f = await setup(false)
    const receipt = f.common.manualInstallStorePath!
    await blockReceipt(receipt)
    f.updater.downloadUpdate.mockImplementationOnce(async () => {
      if (failure === 'error event') f.updater.emit('error', new Error('transfer failed'))
      else throw new Error('transfer failed')
    })
    await expect(f.strategy.download()).resolves.toMatchObject({
      state: 'error',
      error: 'transfer failed'
    })
    expect(f.strategy.getStatus().state).toBe('error')
    expect(await f.strategy.getManualInstall()).toMatchObject({
      kind: 'website',
      reason: 'download-failed'
    })
    await rm(receipt, { recursive: true })
    expect(await f.strategy.download()).toMatchObject({ state: 'ready' })
    expect(f.updater.downloadUpdate).toHaveBeenCalledTimes(2)
  }
)

it('settles a manifest download failure and releases its claim when the receipt cannot be persisted', async () => {
  const f = await setupManifest(false)
  await blockReceipt(f.receipt)
  const response = new Response('forbidden', { status: 403 })
  Object.defineProperty(response, 'url', { value: f.service.getStatus().download!.url })
  f.fetchImpl.mockResolvedValueOnce(response)
  await expect(f.service.download()).resolves.toMatchObject({
    state: 'error',
    error: expect.stringContaining('403')
  })
  expect(f.service.getStatus().state).toBe('error')
  expect(f.configuration.log.warn).toHaveBeenCalled()
  expect(await f.service.getManualInstall()).toMatchObject({
    kind: 'website',
    reason: 'download-failed'
  })
  await rm(f.receipt, { recursive: true })
  expect(await f.service.download()).toMatchObject({ state: 'ready' })
})

it.each(['prepareInstallHandoff', 'beforeInstallHandoff', 'executeInstall'] as const)(
  'preserves Electron %s failure cleanup when the failure receipt cannot be persisted',
  async (stage) => {
    const f = await setup(false)
    const receipt = f.common.manualInstallStorePath!
    const failure = vi.fn(async () => {
      await blockReceipt(receipt)
      throw new Error('installation hook failed')
    })
    const release = vi.fn()
    const rollback = vi.fn()
    const cancel = vi.fn()
    const strategy = new ElectronUpdaterStrategy({
      ...f.common,
      prepareInstallHandoff: async () => ({
        operationId: 'test-operation',
        handoff: vi.fn(),
        cancel
      }),
      releaseInstallHandoff: release,
      markUpdateShutdown: () => rollback,
      [stage]: failure
    })
    await strategy.check()
    await strategy.download()
    await expect(strategy.apply()).resolves.toMatchObject({
      state: stage === 'beforeInstallHandoff' ? 'ready' : 'error',
      reason: 'install-failed',
      error: 'installation hook failed',
      ...(stage === 'prepareInstallHandoff'
        ? { recovery: { phase: 'preparing', runtime: 'running', installation: 'unchanged' } }
        : {})
    })
    expect(release).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledTimes(stage === 'prepareInstallHandoff' ? 0 : 1)
    expect(rollback).toHaveBeenCalledTimes(stage === 'executeInstall' ? 1 : 0)
    expect(f.updater.quitAndInstall).not.toHaveBeenCalled()
    // A released apply claim allows the SDK's next completed download to own the status again.
    await rm(receipt, { recursive: true })
    expect(await strategy.download()).toMatchObject({ state: 'ready' })
    expect(strategy.getStatus().recovery?.installation).not.toBe('pending')
  }
)

it('handles an Electron installer error event without throwing when its failure receipt cannot be persisted', async () => {
  const f = await setup(false)
  const rollback = vi.fn()
  const release = vi.fn()
  const strategy = new ElectronUpdaterStrategy({
    ...f.common,
    executeInstall: async () => {},
    markUpdateShutdown: () => rollback,
    releaseInstallHandoff: release
  })
  await strategy.check()
  await strategy.download()
  await strategy.apply()
  await blockReceipt(f.common.manualInstallStorePath!)
  expect(() => f.updater.emit('error', new Error('installer failed'))).not.toThrow()
  expect(strategy.getStatus()).toMatchObject({
    state: 'error',
    reason: 'install-failed',
    error: 'installer failed'
  })
  expect(rollback).toHaveBeenCalledOnce()
  expect(release).toHaveBeenCalledOnce()
})

it('preserves the manifest installer-open error and releases apply ownership when its receipt write fails', async () => {
  const f = await setupManifest()
  f.configuration.openPath.mockImplementationOnce(async () => {
    await blockReceipt(f.receipt)
    return 'native launch rejected'
  })
  await expect(f.service.apply()).resolves.toMatchObject({
    state: 'ready',
    error: 'Could not open the update installer: native launch rejected'
  })
  expect(f.service.getStatus().recovery).toBeUndefined()
  expect(f.configuration.log.warn).toHaveBeenCalled()
  await rm(f.receipt, { recursive: true })
  await f.service.apply()
  expect(f.configuration.openPath).toHaveBeenCalledTimes(2)
})

it('still refuses Electron native submission if the pending receipt cannot be persisted', async () => {
  const f = await setup(false)
  const receipt = f.common.manualInstallStorePath!
  const observe = vi.fn(async () => {})
  const rollback = vi.fn()
  const strategy = new ElectronUpdaterStrategy({
    ...f.common,
    beforeInstallHandoff: async () => blockReceipt(receipt),
    observeManualInstallHandoff: observe,
    markUpdateShutdown: () => rollback
  })
  await strategy.check()
  await strategy.download()
  await expect(strategy.apply()).resolves.toMatchObject({
    state: 'error',
    reason: 'install-failed',
    error: expect.stringMatching(/EISDIR|EPERM|EACCES/)
  })
  expect(f.updater.quitAndInstall).not.toHaveBeenCalled()
  expect(observe).not.toHaveBeenCalled()
  expect(rollback).toHaveBeenCalledOnce()
})

it('restores manifest error state without submitting an installer if the pending receipt cannot be persisted', async () => {
  const f = await setupManifest()
  await blockReceipt(f.receipt)
  await expect(f.service.apply()).rejects.toThrow(/EISDIR|EPERM|EACCES/)
  expect(f.service.getStatus()).toMatchObject({
    state: 'ready',
    error: expect.stringMatching(/EISDIR|EPERM|EACCES/)
  })
  expect(f.configuration.openPath).not.toHaveBeenCalled()
  await rm(f.receipt, { recursive: true })
  await f.service.apply()
  expect(f.configuration.openPath).toHaveBeenCalledOnce()
})

it.each(['recovered', 'cancelled', 'installed'] as const)(
  'publishes the actual %s recovery result when updating the fallback receipt fails',
  async (outcome) => {
    const f = await setup(false)
    const result = { outcome, recovery: undefined, reason: undefined, error: undefined }
    const recoverInstall = vi.fn(async () => result)
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const strategy = new ElectronUpdaterStrategy({ ...f.common, recoverInstall, log })
    await strategy.check()
    await strategy.download()
    strategy.publishLifecycleStatus({
      reason: 'install-failed',
      recovery: {
        phase: 'stopped',
        runtime: 'stopped-clean',
        installation: 'unchanged',
        canCancel: true,
        canRecover: true,
        canRetryInstall: false
      }
    })
    await blockReceipt(f.common.manualInstallStorePath!)
    expect(await strategy.recover()).toMatchObject({ state: 'ready', ...result })
    expect(strategy.getStatus().recovery).toBeUndefined()
    expect(log.warn).toHaveBeenCalled()
    expect(recoverInstall).toHaveBeenCalledOnce()
  }
)

it.each(['electron', 'manifest'] as const)(
  'keeps an unresolved %s native handoff blocked while the fallback receipt is unwritable',
  async (provider) => {
    const f = await setupManifest()
    const owner = provider === 'electron' ? f.strategy : f.service
    if (provider === 'electron') await owner.download()
    await owner.apply()
    await blockReceipt(f.receipt)
    if (provider === 'electron')
      expect(() => f.updater.emit('error', new Error('native result unknown'))).not.toThrow()
    for (const command of ['check', 'download', 'apply', 'cancel', 'recover', 'recheck'] as const)
      await owner[command]()
    expect(owner.getStatus().recovery).toMatchObject({
      installation: 'pending',
      canRetryInstall: false
    })
    expect((await owner.getManualInstall()).kind).toBe('blocked')
    expect(f.updater.quitAndInstall).toHaveBeenCalledTimes(provider === 'electron' ? 1 : 0)
    expect(f.configuration.openPath).toHaveBeenCalledTimes(provider === 'manifest' ? 1 : 0)
  }
)

it('qualifies and reveals a reconstructed complete NSIS executable after real handoff failure', async () => {
  const f = await setup()
  f.common.manualInstallRecovery = async () => 'failed'
  expect(f.strategy.getStatus().manualInstall).toBeUndefined()
  f.updater.quitAndInstall.mockImplementation(() => {
    throw new Error('native launch failed')
  })
  await f.strategy.apply()
  expect(await f.strategy.getManualInstall()).toMatchObject({ kind: 'local', format: 'nsis' })
  await f.strategy.revealManualInstaller()
  expect(f.reveal).toHaveBeenCalledExactlyOnceWith(f.path)
  const receipt = JSON.parse(await readFile(f.common.manualInstallStorePath!, 'utf8'))
  expect(receipt.attempt.state).toBe('failed')
})

it('persists unresolved native handoff and prevents every recovery command bypass after restart', async () => {
  const f = await setup()
  await f.strategy.apply()
  const cancelInstall = vi.fn(async () => ({ outcome: 'cancelled' as const }))
  const recoverInstall = vi.fn(async () => ({ outcome: 'recovered' as const }))
  const recheckInstall = vi.fn(async () => ({ recovery: undefined }))
  const restarted = new ElectronUpdaterStrategy({
    ...f.common,
    cancelInstall,
    recoverInstall,
    recheckInstall
  })
  expect(restarted.getStatus().recovery?.installation).toBe('pending')
  const checks = f.updater.checkForUpdates.mock.calls.length
  await restarted.check()
  await restarted.apply()
  await restarted.cancel()
  await restarted.recover()
  await restarted.recheck()
  expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(checks)
  expect(cancelInstall).not.toHaveBeenCalled()
  expect(recoverInstall).not.toHaveBeenCalled()
  expect(recheckInstall).not.toHaveBeenCalled()
  expect((await restarted.getManualInstall()).kind).toBe('blocked')
})

it('retains the package through safe recovery, and rehydrates the updater before automatic retry', async () => {
  const f = await setup()
  f.common.manualInstallRecovery = async () => 'failed'
  f.updater.quitAndInstall.mockImplementationOnce(() => {
    throw new Error('native launch failed')
  })
  await f.strategy.apply()
  const restarted = new ElectronUpdaterStrategy(f.common)
  expect((await restarted.getManualInstall()).kind).toBe('local')
  const downloads = f.updater.downloadUpdate.mock.calls.length
  await restarted.apply()
  expect(f.updater.downloadUpdate).toHaveBeenCalledTimes(downloads + 1)
  expect(restarted.getStatus().state).toBe('ready')
})

it('disambiguates the actual downloaded architecture in a multi-architecture Mac feed', async () => {
  const f = await setup()
  f.common.manualInstallRecovery = async () => 'failed'
  const updater = f.updater
  const files = ['x64', 'arm64'].map((arch) => ({
    url: `aipoch-open-science-2.0.0-mac-${arch}.zip`,
    size: f.bytes.length,
    sha512: createHash('sha512').update(f.bytes).digest('base64')
  }))
  const archive = join(f.directory, 'update.zip')
  await writeFile(archive, f.bytes)
  updater.downloadUpdate.mockImplementation(async () => {
    updater.emit('update-downloaded', { version: '2.0.0', downloadedFile: archive, files })
  })
  const strategy = new ElectronUpdaterStrategy({
    ...f.common,
    manualInstallStorePath: null,
    platform: 'darwin',
    arch: 'arm64'
  })
  updater.emit('update-available', { version: '2.0.0', files })
  await strategy.download()
  updater.quitAndInstall.mockImplementation(() => {
    throw new Error('native failed')
  })
  await strategy.apply()
  expect(await strategy.getManualInstall()).toMatchObject({
    kind: 'local',
    format: 'zip',
    arch: 'arm64'
  })
})

it('preserves manifest download provenance and never launches an installer during file reveal', async () => {
  const f = await setup()
  const download = {
    url: 'https://updates.example/aipoch-open-science-2.0.0-mac-arm64.dmg',
    size: f.bytes.length,
    sha256: createHash('sha256').update(f.bytes).digest('hex')
  }
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith('version.json'))
      return new Response(
        JSON.stringify({ version: '2.0.0', downloads: { 'mac-arm64': download } })
      )
    const response = new Response(f.bytes, {
      headers: { 'content-length': String(f.bytes.length) }
    })
    Object.defineProperty(response, 'url', { value: download.url })
    return response
  }) as unknown as typeof fetch
  const openPath = vi.fn(async () => 'native launch rejected')
  const configuration = {
    currentVersion: '1.0.0',
    platform: 'darwin' as const,
    arch: 'arm64',
    fetchImpl,
    manifestUrl: 'https://updates.example/version.json',
    promptSavePath: async () => join(f.directory, 'installer.dmg'),
    installationGuard: () => false,
    openPath,
    broadcast: vi.fn(),
    manualInstallStorePath: join(f.directory, 'manifest-receipt.json'),
    verifyManualInstallerSignature: async () => {},
    revealManualInstallerFile: f.reveal
  }
  const service = new UpdateService(configuration)
  await service.check()
  await service.download()
  await service.apply()
  expect(await service.getManualInstall()).toMatchObject({ kind: 'local', format: 'dmg' })
  const restarted = new UpdateService(configuration)
  expect(restarted.getStatus().download).toEqual(download)
  const owner = (await import('./command-owner')).createUpdateCommandOwner(restarted)
  const ready = await owner.check()
  expect(ready.manualInstall).toMatchObject({ kind: 'local', format: 'dmg' })
  expect(ready.reason).toBeUndefined()
  expect(ready.recovery).toBeUndefined()
  await restarted.revealManualInstaller()
  expect(openPath).toHaveBeenCalledTimes(1)
  expect(f.reveal).toHaveBeenCalledTimes(1)
})

it('keeps protected executor recovery authoritative without creating a native pending attempt', async () => {
  const f = await setup()
  const observe = vi.fn(async () => {})
  const recoverInstall = vi.fn(async () => ({ outcome: 'recovered' as const, recovery: undefined }))
  const strategy = new ElectronUpdaterStrategy({
    ...f.common,
    manualInstallStorePath: null,
    observeManualInstallHandoff: observe,
    executeInstall: async () => {
      throw new Error('protected executor failed before replacement')
    },
    recoverInstall
  })
  await strategy.check()
  await strategy.download()
  await strategy.apply()
  expect(observe).not.toHaveBeenCalled()
  await strategy.recover()
  expect(recoverInstall).toHaveBeenCalledOnce()
  expect((await strategy.getManualInstall()).kind).toBe('local')
})

it('requires native terminal evidence before recovering an asynchronous handoff failure while the runtime is stopped', async () => {
  const f = await setup()
  const settled = vi.fn().mockResolvedValue('pending')
  const recoverInstall = vi.fn(async () => ({ outcome: 'recovered' as const, recovery: undefined }))
  const strategy = new ElectronUpdaterStrategy({
    ...f.common,
    manualInstallStorePath: null,
    manualInstallRecovery: settled,
    recoverInstall
  })
  await strategy.check()
  await strategy.download()
  await strategy.apply()
  f.updater.emit('error', new Error('asynchronous native error'))
  expect(strategy.getStatus().recovery).toMatchObject({
    installation: 'pending',
    canRecover: true,
    canRetryInstall: false
  })
  strategy.publishLifecycleStatus({
    recovery: {
      phase: 'stopped',
      runtime: 'stopped-clean',
      installation: 'unchanged',
      canCancel: true,
      canRecover: true,
      canRetryInstall: false
    }
  })
  await strategy.recover()
  expect(recoverInstall).not.toHaveBeenCalled()
  settled.mockResolvedValue('failed')
  await strategy.recover()
  expect(recoverInstall).toHaveBeenCalledOnce()
  expect((await strategy.getManualInstall()).kind).toBe('local')
})

it('retains protected handoff provenance across restart while the existing installation record gates recovery', async () => {
  const f = await setup()
  const observe = vi.fn(async () => {})
  const executor = new ElectronUpdaterStrategy({
    ...f.common,
    observeManualInstallHandoff: observe,
    executeInstall: async () => {}
  })
  await executor.check()
  await executor.download()
  await executor.apply()
  expect(observe).not.toHaveBeenCalled()
  const stored = JSON.parse(await readFile(f.common.manualInstallStorePath!, 'utf8'))
  expect(stored.artifact.version).toBe('2.0.0')
  expect(stored.attempt).toBeUndefined()
  let safe = false
  const recoverInstall = vi.fn(async () => {
    safe = true
    return { outcome: 'recovered' as const, recovery: undefined }
  })
  const restarted = new ElectronUpdaterStrategy({
    ...f.common,
    inspectManualInstallSafety: async () => safe,
    recoverInstall
  })
  expect(restarted.getStatus().latest).toBe('2.0.0')
  expect((await restarted.getManualInstall()).kind).toBe('blocked')
  await restarted.recover()
  expect(recoverInstall).toHaveBeenCalledOnce()
  expect((await restarted.getManualInstall()).kind).toBe('local')
})

it('publishes a reachable retry/manual status during scheduler startup for a known failed native attempt', async () => {
  const f = await setup()
  f.common.manualInstallRecovery = async () => 'failed'
  f.updater.quitAndInstall.mockImplementation(() => {
    throw new Error('native launch failed')
  })
  await f.strategy.apply()
  const restarted = new ElectronUpdaterStrategy(f.common)
  const owner = (await import('./command-owner')).createUpdateCommandOwner(restarted)
  const status = await owner.check() // Same action the startup scheduler invokes; no hidden manual command.
  expect(status).toMatchObject({ state: 'ready', manualInstall: { kind: 'local', format: 'nsis' } })
  expect(status.reason).toBeUndefined()
  expect(status.recovery).toBeUndefined() // UpdateDialog selects its dismissible retry view, not S13.
})

it('keeps asynchronous native handoff protected against checks, newer feed events and new downloads', async () => {
  const f = await setup()
  await f.strategy.apply()
  f.updater.emit('error', new Error('native handoff result unknown'))
  const checks = f.updater.checkForUpdates.mock.calls.length
  const downloads = f.updater.downloadUpdate.mock.calls.length
  const receipt = await readFile(f.common.manualInstallStorePath!, 'utf8')
  await f.strategy.check()
  await f.strategy.download()
  f.updater.emit('update-available', { version: '3.0.0' })
  f.updater.emit('update-not-available', { version: '1.0.0' })
  expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(checks)
  expect(f.updater.downloadUpdate).toHaveBeenCalledTimes(downloads)
  expect(await readFile(f.common.manualInstallStorePath!, 'utf8')).toBe(receipt)
  expect(f.strategy.getStatus().latest).toBe('2.0.0')
})

it('keeps the Linux DEB distribution instructions after a transfer fails before a local file exists', async () => {
  const f = await setup()
  const strategy = new ElectronUpdaterStrategy({
    ...f.common,
    manualInstallStorePath: null,
    platform: 'linux',
    arch: 'x64'
  })
  f.updater.emit('update-available', {
    version: '2.0.0',
    files: [{ url: 'aipoch-open-science_2.0.0_amd64.deb', size: 400 }]
  })
  f.updater.downloadUpdate.mockRejectedValueOnce(new Error('connection lost'))
  await strategy.download()
  expect(await strategy.getManualInstall()).toMatchObject({
    kind: 'website',
    reason: 'download-failed',
    format: 'deb'
  })
})

it('lets the existing manifest recovery UI action recheck native evidence and publish a reachable fallback after restart', async () => {
  const f = await setup()
  const target = join(f.directory, 'manifest.dmg')
  const download = {
    url: 'https://updates.example/aipoch-open-science-2.0.0-mac-arm64.dmg',
    size: f.bytes.length,
    sha256: createHash('sha256').update(f.bytes).digest('hex')
  }
  const recovery = vi.fn().mockResolvedValue('pending')
  const openPath = vi.fn(async () => '')
  const fetchImpl = vi.fn(async (url: unknown) => {
    if (String(url).endsWith('version.json'))
      return new Response(
        JSON.stringify({ version: '2.0.0', downloads: { 'mac-arm64': download } })
      )
    const response = new Response(f.bytes, {
      headers: { 'content-length': String(f.bytes.length) }
    })
    Object.defineProperty(response, 'url', { value: download.url })
    return response
  }) as unknown as typeof fetch
  const configuration = {
    platform: 'darwin' as const,
    arch: 'arm64',
    currentVersion: '1.0.0',
    manifestUrl: 'https://updates.example/version.json',
    fetchImpl,
    promptSavePath: async () => target,
    openPath,
    broadcast: vi.fn(),
    installationGuard: () => false,
    manualInstallStorePath: join(f.directory, 'manifest-recovery.json'),
    manualInstallRecovery: recovery,
    inspectManualInstallSafety: async () => true,
    verifyManualInstallerSignature: async () => {}
  }
  const service = new UpdateService(configuration)
  await service.check()
  await service.download()
  await service.apply()
  const restarted = new UpdateService(configuration)
  const owner = (await import('./command-owner')).createUpdateCommandOwner(restarted)
  expect((await owner.check()).recovery).toMatchObject({
    installation: 'pending',
    canRecover: true
  })
  expect((await owner.recover()).manualInstall).toBeUndefined()
  expect(openPath).toHaveBeenCalledTimes(1)
  recovery.mockResolvedValue('failed')
  const status = await owner.recover() // RuntimeUpdateDialog S13 Retry calls this existing owner action.
  expect(status).toMatchObject({ state: 'ready', manualInstall: { kind: 'local', format: 'dmg' } })
  expect(status.reason).toBeUndefined()
  expect(status.recovery).toBeUndefined()
  expect(openPath).toHaveBeenCalledTimes(1)
  const downloads = vi.mocked(fetchImpl).mock.calls.length
  await owner.check()
  expect(fetchImpl).toHaveBeenCalledTimes(downloads)
})

it('does not infer terminal failure from a synchronous native submission exception', async () => {
  const f = await setup()
  f.updater.quitAndInstall.mockImplementation(() => {
    throw new Error('submission result unknown')
  })
  await f.strategy.apply({ relaunch: false })
  expect(f.strategy.getStatus().recovery).toMatchObject({
    installation: 'pending',
    canRecover: true,
    canRetryInstall: false
  })
  expect((await f.strategy.getManualInstall()).kind).toBe('blocked')
  const receipt = JSON.parse(await readFile(f.common.manualInstallStorePath!, 'utf8'))
  expect(receipt.attempt.state).toBe('pending')
  expect(receipt.attempt.operationId).toMatch(/^[0-9a-f-]{36}$/)
})

it('releases the apply claim if durable failure cleanup cannot be written', async () => {
  const f = await setup()
  const clear = vi
    .spyOn(ManualInstallerFallback.prototype, 'clearFailure')
    .mockImplementationOnce(() => {
      throw new Error('disk full')
    })
  try {
    expect(await f.strategy.apply()).toMatchObject({ state: 'ready', error: 'disk full' })
    expect(f.updater.quitAndInstall).not.toHaveBeenCalled()
    await f.strategy.apply()
    expect(f.updater.quitAndInstall).toHaveBeenCalledOnce()
  } finally {
    clear.mockRestore()
  }
})
