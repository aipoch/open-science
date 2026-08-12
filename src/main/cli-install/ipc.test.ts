import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Captures the handlers registered via ipcMain.handle so tests can invoke them directly.
const handlers = new Map<string, (...args: unknown[]) => unknown>()

const { launcher, logger } = vi.hoisted(() => ({
  launcher: {
    ensureCliLauncherCurrent: vi.fn(),
    getCliLauncherStatus: vi.fn(),
    installCliLauncher: vi.fn(),
    uninstallCliLauncher: vi.fn()
  },
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/repo',
    getPath: (name: string) => (name === 'home' ? '/home/u' : '/home/u/.config/os')
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

vi.mock('../logger', () => ({
  createLogger: () => logger
}))

vi.mock('./launcher', () => launcher)

import { createCliCommandOwner, registerCliInstallIpcHandlers, type CliCommandOwner } from './ipc'

const INSTALLED = { installed: true, target: '/home/u/.local/bin/open-science', onPath: true }

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  registerCliInstallIpcHandlers()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('registerCliInstallIpcHandlers', () => {
  it('delegates every channel to one injected command owner', async () => {
    handlers.clear()
    const owner: CliCommandOwner = {
      getStatus: vi.fn().mockResolvedValue(INSTALLED),
      install: vi.fn().mockResolvedValue(INSTALLED),
      uninstall: vi.fn().mockResolvedValue({ ...INSTALLED, installed: false })
    }

    expect(registerCliInstallIpcHandlers(owner)).toBe(owner)
    await expect(handlers.get('cli:get-status')?.()).resolves.toBe(INSTALLED)
    await expect(handlers.get('cli:install')?.()).resolves.toBe(INSTALLED)
    await expect(handlers.get('cli:uninstall')?.()).resolves.toMatchObject({ installed: false })
  })

  it('registers the three cli channels', () => {
    expect([...handlers.keys()].sort()).toEqual(['cli:get-status', 'cli:install', 'cli:uninstall'])
  })

  it('install delegates to the launcher with a resolved env and returns its status', async () => {
    launcher.installCliLauncher.mockResolvedValue(INSTALLED)

    const result = await handlers.get('cli:install')!()

    expect(result).toEqual(INSTALLED)
    expect(launcher.installCliLauncher).toHaveBeenCalledTimes(1)
    // The env is resolved from Electron/process, not hard-coded.
    const env = launcher.installCliLauncher.mock.calls[0][0]
    expect(env).toMatchObject({ platform: process.platform, packaged: false, homeDir: '/home/u' })
    expect(env.cliEntryPath).toContain('cli')
  })

  it('uninstall delegates to the launcher', async () => {
    launcher.uninstallCliLauncher.mockResolvedValue({ ...INSTALLED, installed: false })
    const result = await handlers.get('cli:uninstall')!()
    expect(result).toMatchObject({ installed: false })
    expect(launcher.uninstallCliLauncher).toHaveBeenCalledTimes(1)
  })

  it('get-status returns a safe default instead of rejecting when the launcher throws', async () => {
    launcher.getCliLauncherStatus.mockRejectedValue(new Error('fs blew up'))
    const result = await handlers.get('cli:get-status')!()
    expect(result).toEqual({ installed: false, target: '', onPath: false })
  })

  it('reconciles an AppImage launcher through the owner and logs failures', async () => {
    vi.stubEnv('APPIMAGE', '/home/u/Open Science.AppImage')
    launcher.ensureCliLauncherCurrent.mockRejectedValue(new Error('read only'))

    await expect(createCliCommandOwner().ensureCurrent()).resolves.toBeUndefined()

    expect(launcher.ensureCliLauncherCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ appImagePath: '/home/u/Open Science.AppImage' })
    )
    expect(logger.error).toHaveBeenCalledWith(
      'cli launcher reconciliation failed',
      expect.any(Error)
    )
  })
})
