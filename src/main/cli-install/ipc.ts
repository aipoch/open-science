import { desktopInteraction } from '../desktop-interaction'

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

const resolveCliLauncherEnv = (): CliLauncherEnv =>
  desktopInteraction('Desktop CLI launcher installation').cliLauncherEnvironment()

const createCliCommandOwner = (
  environment: () => CliLauncherEnv = resolveCliLauncherEnv
): CliCommandOwnerWithLifecycle => ({
  ensureCurrent: async (): Promise<void> => {
    try {
      const status = await ensureCliLauncherCurrent(environment())
      if (status) logger.info('updated cli launcher', { target: status.target })
    } catch (error) {
      logger.error('cli launcher reconciliation failed', error)
    }
  },
  getStatus: async (): Promise<CliLauncherStatus> => {
    try {
      return await getCliLauncherStatus(environment())
    } catch (error) {
      logger.error('cli get-status failed', error)
      throw error
    }
  },
  install: async (): Promise<CliLauncherStatus> => {
    const status = await installCliLauncher(environment())
    logger.info('installed cli launcher', { target: status.target, onPath: status.onPath })
    return status
  },
  uninstall: async (): Promise<CliLauncherStatus> => {
    const status = await uninstallCliLauncher(environment())
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
