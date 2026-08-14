import { homedir } from 'node:os'
import { join } from 'node:path'

import { app } from 'electron'

import { ipcMainHandle } from '../ipc-handler-registry'

import type { CliLauncherStatus } from '../../shared/cli'
import { createLogger } from '../logger'
import {
  getCliLauncherStatus,
  installCliLauncher,
  uninstallCliLauncher,
  ensureCliLauncherCurrent,
  type CliLauncherEnv
} from './launcher'

const logger = createLogger('cli-install')

type CliCommandOwner = Readonly<{
  getStatus: () => Promise<CliLauncherStatus>
  install: () => Promise<CliLauncherStatus>
  uninstall: () => Promise<CliLauncherStatus>
}>

type CliCommandOwnerWithLifecycle = CliCommandOwner &
  Readonly<{
    ensureCurrent: () => Promise<void>
  }>

// Resolves the launcher environment from Electron at call time. Packaged builds ship the CLI under
// resources/cli (see electron-builder.yml extraResources); in dev it lives in the repo's cli/ dir.
const resolveCliLauncherEnv = (): CliLauncherEnv => ({
  platform: process.platform,
  appExecPath: process.execPath,
  cliEntryPath: app.isPackaged
    ? join(process.resourcesPath, 'cli', 'index.mjs')
    : join(app.getAppPath(), 'cli', 'index.mjs'),
  appImagePath: process.env.APPIMAGE,
  packaged: app.isPackaged,
  homeDir: app.getPath('home') ?? homedir(),
  userDataDir: app.getPath('userData'),
  pathVar: process.env.PATH ?? ''
})

const createCliCommandOwner = (): CliCommandOwnerWithLifecycle => ({
  ensureCurrent: async (): Promise<void> => {
    try {
      const status = await ensureCliLauncherCurrent(resolveCliLauncherEnv())
      if (status) logger.info('updated cli launcher', { target: status.target })
    } catch (error) {
      logger.error('cli launcher reconciliation failed', error)
    }
  },
  getStatus: async (): Promise<CliLauncherStatus> => {
    try {
      return await getCliLauncherStatus(resolveCliLauncherEnv())
    } catch (error) {
      logger.error('cli get-status failed', error)
      return { installed: false, target: '', onPath: false }
    }
  },
  install: async (): Promise<CliLauncherStatus> => {
    const status = await installCliLauncher(resolveCliLauncherEnv())
    logger.info('installed cli launcher', { target: status.target, onPath: status.onPath })
    return status
  },
  uninstall: async (): Promise<CliLauncherStatus> => {
    const status = await uninstallCliLauncher(resolveCliLauncherEnv())
    logger.info('uninstalled cli launcher', { target: status.target })
    return status
  }
})

// Registers the renderer-callable command-line-tool commands (Settings -> General). The same owner
// can be injected into Host commands without changing launcher error/result behavior.
const registerCliInstallIpcHandlers = (
  owner: CliCommandOwner = createCliCommandOwner()
): CliCommandOwner => {
  ipcMainHandle('cli:get-status', () => owner.getStatus())
  ipcMainHandle('cli:install', () => owner.install())
  ipcMainHandle('cli:uninstall', () => owner.uninstall())
  return owner
}

export type { CliCommandOwner }
export { registerCliInstallIpcHandlers, createCliCommandOwner }
