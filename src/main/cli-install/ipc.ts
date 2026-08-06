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
  type CliLauncherEnv
} from './launcher'

const logger = createLogger('cli-install')

type CliCommandOwner = Readonly<{
  getStatus: () => Promise<CliLauncherStatus>
  install: () => Promise<CliLauncherStatus>
  uninstall: () => Promise<CliLauncherStatus>
}>

// Resolves the launcher environment from Electron at call time. Packaged builds ship the CLI under
// resources/cli (see electron-builder.yml extraResources); in dev it lives in the repo's cli/ dir.
const resolveEnv = (): CliLauncherEnv => ({
  platform: process.platform,
  appExecPath: process.execPath,
  cliEntryPath: app.isPackaged
    ? join(process.resourcesPath, 'cli', 'index.mjs')
    : join(app.getAppPath(), 'cli', 'index.mjs'),
  packaged: app.isPackaged,
  homeDir: app.getPath('home') ?? homedir(),
  userDataDir: app.getPath('userData'),
  pathVar: process.env.PATH ?? ''
})

const createCliCommandOwner = (): CliCommandOwner => ({
  getStatus: async (): Promise<CliLauncherStatus> => {
    try {
      return await getCliLauncherStatus(resolveEnv())
    } catch (error) {
      logger.error('cli get-status failed', error)
      return { installed: false, target: '', onPath: false }
    }
  },
  install: async (): Promise<CliLauncherStatus> => {
    const status = await installCliLauncher(resolveEnv())
    logger.info('installed cli launcher', { target: status.target, onPath: status.onPath })
    return status
  },
  uninstall: async (): Promise<CliLauncherStatus> => {
    const status = await uninstallCliLauncher(resolveEnv())
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
