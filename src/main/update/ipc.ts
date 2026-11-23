import { ipcMainHandle } from '../ipc-handler-registry'

import { createUpdateCommandOwner, type UpdateCommandOwner } from './command-owner'
import type { UpdateApplyOptions, UpdateDownloadOptions } from '../../shared/update'
import { createUpdateStrategy } from './create-strategy'
import type { UpdateStrategy } from './strategy'

// Registers the renderer-callable update commands. Returns the strategy so the scheduler can drive it.
export const registerUpdateIpcHandlers = (
  strategy: UpdateStrategy = createUpdateStrategy(),
  owner: UpdateCommandOwner | undefined = undefined,
  validateFrame?: (event: import('electron').IpcMainInvokeEvent) => void,
  openProcessManager?: () => Promise<boolean>
): UpdateStrategy => {
  const commandOwner = owner ?? createUpdateCommandOwner(strategy, openProcessManager)
  const handle: typeof ipcMainHandle = (channel, listener) => {
    ipcMainHandle(channel, (event, ...args) => {
      validateFrame?.(event)
      return listener(event, ...args)
    })
  }
  handle('update:recheck', () => commandOwner.recheck())
  if (strategy.setAutomaticDownloads) {
    handle('update:set-automatic-downloads', (_event, enabled: boolean) =>
      strategy.setAutomaticDownloads!(enabled)
    )
  }
  handle('update:recover', () => commandOwner.recover())
  handle('update:get-app-info', () => commandOwner.getAppInfo())
  handle('update:get-status', () => commandOwner.getStatus())
  handle('update:get-installer', () => commandOwner.getInstaller())
  handle('update:reveal-installer', () => commandOwner.revealInstaller())
  handle('update:check', () => commandOwner.check())
  handle('update:download', (_event, options?: UpdateDownloadOptions) =>
    commandOwner.download(options)
  )
  handle('update:cancel', () => commandOwner.cancel())
  handle('update:apply', (_event, options?: UpdateApplyOptions) => commandOwner.apply(options))
  handle('update:open-process-manager', () => commandOwner.openProcessManager?.() ?? false)
  return strategy
}

export type { UpdateCommandOwner }
export { createUpdateCommandOwner }
