import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimeStartupOptions } from '../runtime-startup-options'
import { clearApplicationShutdownTrigger } from '../application-shutdown-trigger'

const fixture = vi.hoisted(() => ({ prepare: vi.fn(), updater: null as unknown }))
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '1.0.0',
    getPath: (name: string) =>
      ({
        appData: '/account/appData',
        userData: '/profiles/initiator',
        exe: '/Applications/Science.app/Contents/MacOS/Science'
      })[name]
  },
  shell: {}
}))
vi.mock('electron-updater', () => ({
  get autoUpdater() {
    return fixture.updater
  },
  CancellationToken: class {
    cancelled = false
    cancel(): void {
      this.cancelled = true
    }
  },
  AppImageUpdater: class {},
  DebUpdater: class {}
}))
vi.mock('./mac-update-handoff', () => ({ prepareMacUpdateHandoff: fixture.prepare }))

import { ElectronUpdaterStrategy } from './electron-updater-strategy'
afterEach(() => {
  clearApplicationShutdownTrigger()
  vi.clearAllMocks()
})

it('default Mac admission resumes the initiating Desktop profile while retaining shared runtime data', async () => {
  const sha512 = Buffer.alloc(64, 1).toString('base64')
  const updater = Object.assign(new EventEmitter(), {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    installerPath: '/cache/target.zip',
    updateInfoAndProvider: {
      info: { version: '2.0.0' },
      provider: {
        resolveFiles: () => [{ url: new URL('https://example.test/target.zip'), info: { sha512 } }]
      }
    },
    checkForUpdates: vi.fn(async () => undefined),
    downloadUpdate: vi.fn(async () => {
      updater.emit('update-downloaded', {
        version: '2.0.0',
        downloadedFile: '/cache/target.zip',
        files: [{ url: 'target.zip', sha512 }]
      })
    }),
    quitAndInstall: vi.fn()
  })
  fixture.updater = updater
  fixture.prepare.mockResolvedValue({
    operationId: 'native-operation',
    handoff: vi.fn(),
    cancel: vi.fn()
  })
  const ownerOptions: RuntimeStartupOptions = {
    profilePath: '/profiles/service-owner',
    configRoot: '/research/config',
    dataRoot: '/research/data',
    port: 0,
    host: '127.0.0.1',
    credentialStore: 'os'
  }
  const strategy = new ElectronUpdaterStrategy({
    platform: 'darwin',
    arch: 'arm64',
    currentVersion: '1.0.0',
    getStartupOptions: () => ownerOptions,
    broadcast: vi.fn(),
    installationGuard: () => false,
    fetchImpl: vi.fn(async () => {
      throw new Error('offline fixture')
    }),
    inspectInstallerFile: async (path) => ({
      realPath: path,
      device: 1,
      inode: 1,
      size: 10,
      modified: 1
    })
  })
  updater.emit('update-available', { version: '2.0.0', files: [{ url: 'target.zip', sha512 }] })
  await strategy.download()
  expect(strategy.getStatus().error).toBeUndefined()
  expect(strategy.getStatus()).toMatchObject({ state: 'ready' })
  const applied = await strategy.apply()
  expect(applied.state).not.toBe('error')
  expect(fixture.prepare).toHaveBeenCalledOnce()
  expect(fixture.prepare.mock.calls[0][1]).toMatchObject({
    applicationPath: '/Applications/Science.app',
    profilePath: '/profiles/initiator',
    startupOptions: { ...ownerOptions, profilePath: '/profiles/initiator' }
  })
  expect(ownerOptions.profilePath).toBe('/profiles/service-owner')
  expect(updater.quitAndInstall).toHaveBeenCalledOnce()
})
