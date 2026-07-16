import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { ElectronUpdaterStrategy } from './electron-updater-strategy'

// The default autoUpdater is never exercised here (every test injects a FakeUpdater); mock the module
// so importing the strategy doesn't pull a real Electron runtime into the test process.
vi.mock('electron-updater', () => ({ autoUpdater: {} }))

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
    const strategy = new ElectronUpdaterStrategy({ updater, currentVersion: '0.2.0', broadcast })
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
    const strategy = new ElectronUpdaterStrategy({ updater, currentVersion: '0.2.0', broadcast })
    await strategy.check()
    const status = await strategy.download()
    expect(broadcast).toHaveBeenCalledWith('update:progress', 42)
    expect(status.state).toBe('ready')
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
})
