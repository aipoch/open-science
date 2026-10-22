import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ElectronUpdaterStrategy, type ElectronUpdaterDeps } from './electron-updater-strategy'
import { UpdateService } from './service'
import { UpdateLifecycleError } from '../../shared/update'

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
    markUpdateShutdown: () => () => {}
  }
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

it('offers warned verified instructions after a real SDK prepare refusal without launching the installer', async () => {
  const f = await setup(false)
  let safe: boolean | 'quit-required' = 'quit-required'
  const prepareInstall = vi.fn(async () => {
    throw new UpdateLifecycleError('installation-busy', 'Another runtime uses this installation', {
      phase: 'preparing',
      runtime: 'running',
      installation: 'unchanged',
      canCancel: true,
      canRetryInstall: false,
      canRecover: false,
      detail: 'other-runtime'
    })
  })
  const strategy = new ElectronUpdaterStrategy({
    ...f.common,
    prepareInstall,
    inspectManualInstallSafety: async () => safe
  })
  await strategy.check()
  await strategy.download()
  await strategy.apply()
  expect(strategy.getStatus()).toMatchObject({
    state: 'ready',
    reason: 'installation-busy',
    recovery: { phase: 'preparing', installation: 'unchanged', detail: 'other-runtime' }
  })
  const offer = await strategy.getManualInstall()
  expect(offer).toMatchObject({ kind: 'local', requiresQuitAndReleaseOccupancy: true })
  expect(strategy.getStatus().manualInstall).toEqual(offer)
  expect(await strategy.revealManualInstaller()).toMatchObject({
    kind: 'local',
    requiresQuitAndReleaseOccupancy: true
  })
  expect(f.reveal).toHaveBeenCalledExactlyOnceWith(f.path)
  expect(f.updater.quitAndInstall).not.toHaveBeenCalled()
  expect(
    JSON.parse(await readFile(f.common.manualInstallStorePath!, 'utf8')).attempt
  ).toBeUndefined()
  safe = false
  strategy.publishLifecycleStatus({ blockedBy: ['agent'] })
  // Do not broadcast a spread-carried local result from the prior qualification while new checks run.
  expect(strategy.getStatus().manualInstall).toBeUndefined()
  expect((await strategy.revealManualInstaller()).kind).toBe('blocked')
  expect(f.reveal).toHaveBeenCalledOnce()
})

it('does not classify generic SDK installation-busy as pre-native occupancy', async () => {
  const f = await setup(false)
  const strategy = new ElectronUpdaterStrategy({
    ...f.common,
    prepareInstall: async () => {
      throw new UpdateLifecycleError('installation-busy', 'An update is in progress')
    },
    inspectManualInstallSafety: async () => 'quit-required'
  })
  await strategy.check()
  await strategy.download()
  await strategy.apply()
  expect((await strategy.getManualInstall()).kind).toBe('blocked')
  expect(f.updater.quitAndInstall).not.toHaveBeenCalled()
  expect(f.reveal).not.toHaveBeenCalled()
})

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

it('preserves an explicit OS open refusal and automatic retry while auxiliary storage is unwritable', async () => {
  const f = await setupManifest()
  await blockReceipt(f.receipt)
  f.configuration.openPath.mockResolvedValueOnce('No application is associated with this file')
  expect(await f.service.apply()).toMatchObject({
    state: 'ready',
    error: 'Could not open the update installer: No application is associated with this file'
  })
  expect(f.service.getStatus().recovery).toBeUndefined()
  expect((await f.service.getManualInstall()).kind).toBe('local')
  await f.service.apply()
  expect(f.configuration.openPath).toHaveBeenCalledTimes(2)
  expect((await f.service.getManualInstall()).kind).toBe('blocked')
})

it('preserves Electron download and native handoff when auxiliary storage is unwritable', async () => {
  const f = await setup(false)
  await blockReceipt(f.common.manualInstallStorePath!)
  expect(await f.strategy.download()).toMatchObject({ state: 'ready' })
  await f.strategy.apply()
  expect(f.updater.quitAndInstall).toHaveBeenCalledOnce()
  f.updater.emit('error', new Error('native result unknown'))
  expect(f.strategy.getStatus().recovery?.installation).toBe('pending')
  expect((await f.strategy.getManualInstall()).kind).toBe('blocked')
})

it('preserves verified manifest download and submission when auxiliary storage is unwritable', async () => {
  const f = await setupManifest(false)
  await blockReceipt(f.receipt)
  expect(await f.service.download()).toMatchObject({ state: 'ready' })
  await f.service.apply()
  expect(f.configuration.openPath).toHaveBeenCalledOnce()
  expect((await f.service.getManualInstall()).kind).toBe('blocked')
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
      canRecover: false,
      canRetryInstall: false
    })
    expect((await owner.getManualInstall()).kind).toBe('blocked')
    expect(f.updater.quitAndInstall).toHaveBeenCalledTimes(provider === 'electron' ? 1 : 0)
    expect(f.configuration.openPath).toHaveBeenCalledTimes(provider === 'manifest' ? 1 : 0)
  }
)

it.each([false, true])(
  'routes a safe pre-install failure by standalone eligibility (extra packages: %s)',
  async (extraPackages) => {
    const f = await setup(false)
    const strategy = new ElectronUpdaterStrategy({
      ...f.common,
      prepareInstallHandoff: async () => {
        throw new Error('preparation failed')
      },
      inspectManualInstallSafety: async () => true
    })
    f.updater.downloadUpdate.mockImplementation(async () => {
      f.updater.emit('update-downloaded', {
        version: '2.0.0',
        downloadedFile: f.path,
        files: [
          {
            url: 'aipoch-open-science-2.0.0-win-x64-setup.exe',
            size: f.bytes.length,
            sha512: createHash('sha512').update(f.bytes).digest('base64')
          }
        ],
        ...(extraPackages ? { packages: { x64: {} } } : {})
      })
    })
    await strategy.check()
    await strategy.download()
    await strategy.apply()
    expect((await strategy.getManualInstall()).kind).toBe(extraPackages ? 'website' : 'local')
    await strategy.revealManualInstaller()
    expect(f.reveal).toHaveBeenCalledTimes(extraPackages ? 0 : 1)
    expect(f.updater.quitAndInstall).not.toHaveBeenCalled()
  }
)

it('keeps original installation protection authoritative after restart', async () => {
  const f = await setup()
  await f.strategy.apply()
  const prepareInstall = vi.fn(async () => ({
    reason: 'installation-busy' as const,
    recovery: {
      phase: 'install-check' as const,
      runtime: 'unknown' as const,
      installation: 'pending' as const,
      canCancel: false,
      canRecover: true,
      canRetryInstall: false
    }
  }))
  const restarted = new ElectronUpdaterStrategy({
    ...f.common,
    prepareInstall,
    inspectManualInstallSafety: async () => false
  })
  expect((await restarted.check()).state).toBe('available')
  await restarted.download()
  expect(await restarted.apply()).toMatchObject({ recovery: { installation: 'pending' } })
  expect(prepareInstall).toHaveBeenCalledOnce()
  expect(f.updater.quitAndInstall).toHaveBeenCalledOnce()
  expect((await restarted.getManualInstall()).kind).toBe('blocked')
})

it.each(['electron', 'manifest'] as const)(
  'does not let old %s fallback records hijack Check updates',
  async (provider) => {
    const f = await setupManifest()
    const stored = JSON.parse(await readFile(f.receipt, 'utf8'))
    stored.failure = 'install'
    await writeFile(f.receipt, JSON.stringify(stored))
    const restarted =
      provider === 'electron'
        ? new ElectronUpdaterStrategy(f.common)
        : new UpdateService(f.configuration)
    expect(restarted.getStatus().state).toBe('idle')
    expect((await restarted.getManualInstall()).kind).toBe('blocked')
    expect(await restarted.check()).toMatchObject({ state: 'available', latest: '2.0.0' })
    expect(restarted.getStatus().localPath).toBeUndefined()
  }
)

it('disambiguates the actual downloaded architecture in a multi-architecture Mac feed', async () => {
  const f = await setup()
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
    arch: 'arm64',
    prepareInstallHandoff: async () => {
      throw new Error('preparation failed')
    }
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

it('does not require fallback qualification to open a manifest installer verified by the provider', async () => {
  const f = await setupManifest(false)
  const { ManualInstallerFallback } = await import('./manual-install')
  const capture = vi
    .spyOn(ManualInstallerFallback.prototype, 'capture')
    .mockRejectedValueOnce(new Error('auxiliary verification unavailable'))
  try {
    expect(await f.service.download()).toMatchObject({ state: 'ready' })
    await f.service.apply()
    expect(f.configuration.openPath).toHaveBeenCalledOnce()
    expect((await f.service.getManualInstall()).kind).toBe('blocked')
  } finally {
    capture.mockRestore()
  }
})

it('keeps protected executor recovery authoritative without creating a native pending attempt', async () => {
  const f = await setup()
  const recoverInstall = vi.fn(async () => ({ outcome: 'recovered' as const, recovery: undefined }))
  const strategy = new ElectronUpdaterStrategy({
    ...f.common,
    manualInstallStorePath: null,
    executeInstall: async () => {
      throw new Error('protected executor failed before replacement')
    },
    recoverInstall
  })
  await strategy.check()
  await strategy.download()
  await strategy.apply()
  await strategy.recover()
  expect(recoverInstall).toHaveBeenCalledOnce()
  expect((await strategy.getManualInstall()).kind).toBe('local')
})

it('keeps legacy handoff unknown despite SDK errors and later runtime recovery snapshots', async () => {
  const f = await setup(false)
  const recoverInstall = vi.fn(async () => ({ outcome: 'recovered' as const, recovery: undefined }))
  const strategy = new ElectronUpdaterStrategy({
    ...f.common,
    manualInstallStorePath: null,
    recoverInstall
  })
  await strategy.check()
  await strategy.download()
  await strategy.apply()
  f.updater.emit('error', new Error('asynchronous native error'))
  strategy.publishLifecycleStatus({ recovery: undefined, reason: undefined, state: 'ready' })
  await strategy.recover()
  await strategy.apply()
  expect(recoverInstall).not.toHaveBeenCalled()
  expect(f.updater.quitAndInstall).toHaveBeenCalledOnce()
  expect((await strategy.getManualInstall()).kind).toBe('blocked')
})

it('leaves protected startup recovery authoritative without restoring a fallback offer', async () => {
  const f = await setup(false)
  const executor = new ElectronUpdaterStrategy({ ...f.common, executeInstall: async () => {} })
  await executor.check()
  await executor.download()
  await executor.apply()
  const recoverInstall = vi.fn(async () => ({ outcome: 'recovered' as const, recovery: undefined }))
  const restarted = new ElectronUpdaterStrategy({ ...f.common, recoverInstall })
  expect(restarted.getStatus().state).toBe('idle')
  await restarted.recover()
  expect(recoverInstall).toHaveBeenCalledOnce()
  expect((await restarted.getManualInstall()).kind).toBe('blocked')
  expect((await restarted.check()).state).toBe('available')
})

it.each(['electron', 'manifest'] as const)(
  'ignores historical pending and failed %s fallback records without granting an entry',
  async (provider) => {
    const f = await setupManifest()
    const stored = JSON.parse(await readFile(f.receipt, 'utf8'))
    for (const state of ['pending', 'failed']) {
      stored.attempt = { state, version: '2.0.0', identity: stored.artifact.identity }
      stored.failure = 'install'
      await writeFile(f.receipt, JSON.stringify(stored))
      const restarted =
        provider === 'electron'
          ? new ElectronUpdaterStrategy(f.common)
          : new UpdateService(f.configuration)
      expect((await restarted.getManualInstall()).kind).toBe('blocked')
      expect(await restarted.check()).toMatchObject({ state: 'available', latest: '2.0.0' })
      expect(restarted.getStatus().manualInstall).toBeUndefined()
      expect(restarted.getStatus().localPath).toBeUndefined()
    }
  }
)

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

it('does not restore manifest handoff authority from its auxiliary cache', async () => {
  const f = await setupManifest()
  await f.service.apply()
  const restarted = new UpdateService(f.configuration)
  expect((await restarted.check()).state).toBe('available')
  expect((await restarted.getManualInstall()).kind).toBe('blocked')
  expect(f.configuration.openPath).toHaveBeenCalledOnce()
})

it('does not infer terminal failure from a synchronous native submission exception', async () => {
  const f = await setup()
  f.updater.quitAndInstall.mockImplementation(() => {
    throw new Error('submission result unknown')
  })
  await f.strategy.apply({ relaunch: false })
  expect(f.strategy.getStatus().recovery).toMatchObject({
    installation: 'pending',
    canRecover: false,
    canRetryInstall: false
  })
  expect((await f.strategy.getManualInstall()).kind).toBe('blocked')
})

it('does not require fallback provenance before an Electron native handoff', async () => {
  const f = await setup(false)
  const { ManualInstallerFallback } = await import('./manual-install')
  const capture = vi
    .spyOn(ManualInstallerFallback.prototype, 'capture')
    .mockRejectedValueOnce(new Error('auxiliary verification unavailable'))
  try {
    await f.strategy.download()
    await f.strategy.apply()
    expect(f.updater.quitAndInstall).toHaveBeenCalledOnce()
    f.updater.emit('error', new Error('unknown native result'))
    expect((await f.strategy.getManualInstall()).kind).toBe('blocked')
  } finally {
    capture.mockRestore()
  }
})
