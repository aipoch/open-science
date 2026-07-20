import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { ElectronUpdaterStrategy } from './electron-updater-strategy'

// The default autoUpdater is never exercised here (every test injects a FakeUpdater); mock the module
// so importing the strategy doesn't pull a real Electron runtime into the test process. A stub
// CancellationToken stands in for the real class so the default token factory works in download().
vi.mock('electron-updater', () => ({
  autoUpdater: {},
  CancellationToken: class {
    cancelled = false
    cancel(): void {
      this.cancelled = true
    }
  }
}))

// Minimal fake of electron-updater's autoUpdater: an EventEmitter plus the methods/flags we drive.
class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  checkForUpdates = vi.fn(async () => {
    this.emit('checking-for-update')
    this.emit('update-available', { version: '0.3.0', releaseNotes: 'notes' })
  })
  downloadUpdate = vi.fn(async () => {
    this.emit('download-progress', { percent: 42 })
    this.emit('update-downloaded', { version: '0.3.0' })
  })
  quitAndInstall = vi.fn()
}

// Fake fetch returning a version.json manifest, so notes hydration never touches the network.
const manifestFetch = (manifest: object): typeof fetch =>
  vi.fn(async () => ({ ok: true, json: async () => manifest })) as unknown as typeof fetch

// Fake fetch that always fails, standing in for "no manifest reachable".
const offlineFetch = (): typeof fetch =>
  vi.fn(async () => {
    throw new Error('no network in test')
  }) as unknown as typeof fetch

describe('ElectronUpdaterStrategy', () => {
  it('disables auto download/install on construction', () => {
    const updater = new FakeUpdater()
    new ElectronUpdaterStrategy({ updater, currentVersion: '0.2.0', broadcast: vi.fn() })
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
  })

  it('maps check → available with restart applyKind', async () => {
    const broadcast = vi.fn()
    const updater = new FakeUpdater()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast,
      fetchImpl: offlineFetch()
    })
    const status = await strategy.check()
    expect(status.state).toBe('available')
    expect(status.latest).toBe('0.3.0')
    expect(status.applyKind).toBe('restart')
    expect(broadcast).toHaveBeenCalledWith(
      'update:status',
      expect.objectContaining({ state: 'available' })
    )
  })

  it('maps download → progress then ready', async () => {
    const broadcast = vi.fn()
    const updater = new FakeUpdater()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast,
      fetchImpl: offlineFetch()
    })
    await strategy.check()
    const status = await strategy.download()
    expect(broadcast).toHaveBeenCalledWith('update:progress', 42)
    expect(status.state).toBe('ready')
  })

  it('cancel aborts an in-flight download and resets the status to available', async () => {
    const updater = new FakeUpdater()
    let release: (() => void) | undefined
    let seenToken: { cancelled: boolean } | undefined
    // Hang the download until released, then mimic electron-updater rejecting a cancelled download.
    updater.downloadUpdate = vi.fn(async (token?: { cancelled: boolean }) => {
      seenToken = token
      await new Promise<void>((resolve) => (release = resolve))
      if (token?.cancelled) throw new Error('cancelled')
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    await strategy.check()

    const downloading = strategy.download()
    const cancelled = await strategy.cancel()
    expect(cancelled.state).toBe('available')
    expect(seenToken?.cancelled).toBe(true)

    // The rejected downloadUpdate must not clobber the reset status with an error.
    release?.()
    const final = await downloading
    expect(final.state).toBe('available')
    expect(final.error).toBeUndefined()
  })

  it('cancel is a no-op when nothing is downloading', async () => {
    const updater = new FakeUpdater()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    await strategy.check()
    const status = await strategy.cancel()
    expect(status.state).toBe('available')
  })

  it('reports up-to-date when no update is available', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-not-available', { version: '0.2.0' })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn()
    })
    const status = await strategy.check()
    expect(status.state).toBe('up-to-date')
  })

  it('surfaces errors as status error', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('error', new Error('boom'))
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn()
    })
    const status = await strategy.check()
    expect(status.state).toBe('error')
    expect(status.error).toBe('boom')
  })

  it('apply installs silently and relaunches (quitAndInstall(true, true))', async () => {
    const updater = new FakeUpdater()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn()
    })
    await strategy.apply()
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('apply runs the install gate before quitAndInstall when the teardown is clean', async () => {
    const updater = new FakeUpdater()
    const gate = vi.fn(async () => ({ completed: true, reaped: true }))
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn()
    })
    strategy.setInstallGate(gate)

    await strategy.apply()

    expect(gate).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('apply refuses to install and reports an error when the teardown times out', async () => {
    const updater = new FakeUpdater()
    const gate = vi.fn(async () => ({ completed: false, reaped: false }))
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      installGate: gate
    })

    const status = await strategy.apply()

    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(status.state).toBe('error')
  })

  it('apply refuses to install when the teardown completed but a tree was not cleanly reaped', async () => {
    const updater = new FakeUpdater()
    const gate = vi.fn(async () => ({ completed: true, reaped: false }))
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      installGate: gate
    })

    const status = await strategy.apply()

    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(status.state).toBe('error')
  })

  it('hydrates notes from the CDN manifest when the version matches', async () => {
    const updater = new FakeUpdater()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: manifestFetch({ version: '0.3.0', downloads: {}, notes: '## Highlights\n- new' })
    })
    const status = await strategy.check()
    expect(status.notes).toBe('## Highlights\n- new')
  })

  it('keeps the GitHub-link fallback when the manifest version does not match', async () => {
    const updater = new FakeUpdater()
    // No releaseNotes in the feed, so without a matching manifest the notes stay empty.
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-available', { version: '0.3.0' })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: manifestFetch({ version: '0.3.1', downloads: {}, notes: 'stale notes' })
    })
    const status = await strategy.check()
    expect(status.notes).toBe('')
  })

  it('keeps the fallback when the manifest fetch fails', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-available', { version: '0.3.0' })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    const status = await strategy.check()
    expect(status.notes).toBe('')
  })
})
