import { homedir } from 'node:os'
import { join } from 'node:path'

import { app, ipcMain } from 'electron'

import type { CliLauncherStatus } from '../../shared/cli'
import { createLogger } from '../logger'
import {
  getCliLauncherStatus,
  installCliLauncher,
  uninstallCliLauncher,
  type CliLauncherEnv
} from './launcher'

const logger = createLogger('cli-install')

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

// Registers the renderer-callable command-line-tool commands (Settings -> General). Read is safe; the
// install/uninstall handlers write only the user's own shim and (on Windows) their own PATH entry, so
// they never need elevation. Every handler is guarded so a failure surfaces as a message, not a raw
// rejection.
const registerCliInstallIpcHandlers = (): void => {
  ipcMain.handle('cli:get-status', async (): Promise<CliLauncherStatus> => {
    try {
      return await getCliLauncherStatus(resolveEnv())
    } catch (error) {
      logger.error('cli get-status failed', error)
      return { installed: false, target: '', onPath: false }
    }
  })

  ipcMain.handle('cli:install', async (): Promise<CliLauncherStatus> => {
    const status = await installCliLauncher(resolveEnv())
    logger.info('installed cli launcher', { target: status.target, onPath: status.onPath })
    return status
  })

  ipcMain.handle('cli:uninstall', async (): Promise<CliLauncherStatus> => {
    const status = await uninstallCliLauncher(resolveEnv())
    logger.info('uninstalled cli launcher', { target: status.target })
    return status
  })
}

export { registerCliInstallIpcHandlers }
