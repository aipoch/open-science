import { describe, expect, it, vi } from 'vitest'

// createUpdateStrategy constructs a concrete strategy per platform. Both strategies touch native
// modules at construction (UpdateService reads app.getVersion(); ElectronUpdaterStrategy subscribes to
// autoUpdater), so stub them enough to instantiate without a real Electron runtime.
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('electron-updater', () => ({
  autoUpdater: { on: () => {}, autoDownload: true, autoInstallOnAppQuit: true }
}))

import { createUpdateStrategy } from './create-strategy'
import { ElectronUpdaterStrategy } from './electron-updater-strategy'
import { UpdateService } from './service'

describe('createUpdateStrategy', () => {
  it('uses ElectronUpdaterStrategy on win32', () => {
    expect(createUpdateStrategy('win32')).toBeInstanceOf(ElectronUpdaterStrategy)
  })

  it('uses ElectronUpdaterStrategy on linux', () => {
    expect(createUpdateStrategy('linux')).toBeInstanceOf(ElectronUpdaterStrategy)
  })

  it('uses ElectronUpdaterStrategy on darwin for a packaged stable build', () => {
    expect(createUpdateStrategy('darwin', { isPackaged: true, version: '1.2.3' })).toBeInstanceOf(
      ElectronUpdaterStrategy
    )
  })

  it('falls back to UpdateService on darwin for a nightly (prerelease) build', () => {
    expect(
      createUpdateStrategy('darwin', { isPackaged: true, version: '1.2.3-nightly.abc1234' })
    ).toBeInstanceOf(UpdateService)
  })

  it('falls back to UpdateService on darwin for an unpackaged (dev) build', () => {
    expect(createUpdateStrategy('darwin', { isPackaged: false, version: '1.2.3' })).toBeInstanceOf(
      UpdateService
    )
  })
})
