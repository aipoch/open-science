import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawnSync = vi.hoisted(() => vi.fn())
const quitAndInstall = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ spawnSync }))

// createUpdateStrategy constructs a concrete strategy per platform. Both strategies touch native
// modules at construction (UpdateService reads app.getVersion(); ElectronUpdaterStrategy subscribes to
// autoUpdater), so stub them enough to instantiate without a real Electron runtime.
vi.mock('electron', () => ({
  app: {
    getPath: () => '/Applications/Open Science.app/Contents/MacOS/Open Science',
    getVersion: () => '0.0.0',
    isPackaged: false
  },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('electron-updater', () => ({
  autoUpdater: {
    on: () => {},
    autoDownload: true,
    autoInstallOnAppQuit: true,
    quitAndInstall
  }
}))

import { createUpdateStrategy } from './create-strategy'
import { ElectronUpdaterStrategy } from './electron-updater-strategy'
import { UpdateService } from './service'

describe('createUpdateStrategy', () => {
  beforeEach(() => {
    spawnSync.mockReset()
    quitAndInstall.mockReset()
    spawnSync.mockReturnValue({
      status: 0,
      stdout: '',
      stderr: 'Identifier=com.aipoch.open-science\nTeamIdentifier=87G9WFU9H3\n'
    })
  })

  it('uses ElectronUpdaterStrategy on win32', () => {
    expect(createUpdateStrategy('win32')).toBeInstanceOf(ElectronUpdaterStrategy)
  })

  it('uses ElectronUpdaterStrategy on linux', () => {
    expect(createUpdateStrategy('linux')).toBeInstanceOf(ElectronUpdaterStrategy)
  })

  it('constructs the in-place strategy with its install gate', async () => {
    const installGate = vi.fn(async () => ({ completed: true, reaped: true }))
    const strategy = createUpdateStrategy('win32', { installGate })

    await strategy.apply()

    expect(installGate).toHaveBeenCalledTimes(1)
    expect(quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('uses ElectronUpdaterStrategy on darwin for a packaged stable build', () => {
    expect(createUpdateStrategy('darwin', { isPackaged: true, version: '1.2.3' })).toBeInstanceOf(
      ElectronUpdaterStrategy
    )
  })

  it('falls back to the installer on darwin for an ad-hoc-signed packaged stable build', () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: '',
      stderr: 'Identifier=com.aipoch.open-science\nSignature=adhoc\nTeamIdentifier=not set\n'
    })

    expect(createUpdateStrategy('darwin', { isPackaged: true, version: '1.2.3' })).toBeInstanceOf(
      UpdateService
    )
  })

  it('falls back to the installer on darwin for a stable build signed by another team', () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: '',
      stderr: 'Identifier=com.aipoch.open-science\nTeamIdentifier=OTHERTEAM1\n'
    })

    expect(createUpdateStrategy('darwin', { isPackaged: true, version: '1.2.3' })).toBeInstanceOf(
      UpdateService
    )
  })

  it('falls back to the installer on darwin for another app signed by the official team', () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: '',
      stderr: 'Identifier=com.aipoch.another-app\nTeamIdentifier=87G9WFU9H3\n'
    })

    expect(createUpdateStrategy('darwin', { isPackaged: true, version: '1.2.3' })).toBeInstanceOf(
      UpdateService
    )
  })

  it('falls back to the installer when the installed mac signature cannot be read', () => {
    spawnSync.mockReturnValueOnce({
      status: 1,
      stdout: '',
      stderr: 'code object is not signed at all'
    })

    expect(createUpdateStrategy('darwin', { isPackaged: true, version: '1.2.3' })).toBeInstanceOf(
      UpdateService
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
