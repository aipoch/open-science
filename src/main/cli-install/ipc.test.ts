import { beforeEach, describe, expect, it, vi } from 'vitest'

// Captures the handlers registered via ipcMain.handle so tests can invoke them directly.
const handlers = new Map<string, (...args: unknown[]) => unknown>()

const { launcher } = vi.hoisted(() => ({
  launcher: {
    getCliLauncherStatus: vi.fn(),
    installCliLauncher: vi.fn(),
    uninstallCliLauncher: vi.fn()
  }
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
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() })
}))

vi.mock('./launcher', () => launcher)

import { registerCliInstallIpcHandlers } from './ipc'

const INSTALLED = { installed: true, target: '/home/u/.local/bin/open-science', onPath: true }

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  registerCliInstallIpcHandlers()
})

describe('registerCliInstallIpcHandlers', () => {
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
})
