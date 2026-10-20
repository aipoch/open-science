import { ipcMainHandle } from '../ipc-handler-registry'

import { createUpdateCommandOwner, type UpdateCommandOwner } from './command-owner'
import type { UpdateApplyOptions, UpdateDownloadOptions } from '../../shared/update'
import { createUpdateStrategy } from './create-strategy'
import type { UpdateStrategy } from './strategy'

// Registers the renderer-callable update commands. Returns the strategy so the scheduler can drive it.
export const registerUpdateIpcHandlers = (
  strategy: UpdateStrategy = createUpdateStrategy(),
  owner: UpdateCommandOwner = createUpdateCommandOwner(strategy),
  validateFrame?: (event: import('electron').IpcMainInvokeEvent) => void
): UpdateStrategy => {
  const handle: typeof ipcMainHandle = (channel, listener) => {
    ipcMainHandle(channel, (event, ...args) => {
      validateFrame?.(event)
      return listener(event, ...args)
    })
  }
  handle('update:recheck', () => owner.recheck())
  handle('update:recover', () => owner.recover())
  handle('update:get-app-info', () => owner.getAppInfo())
  handle('update:get-status', () => owner.getStatus())
  handle('update:check', () => owner.check())
  handle('update:download', (_event, options?: UpdateDownloadOptions) => owner.download(options))
  handle('update:cancel', () => owner.cancel())
  handle('update:apply', (_event, options?: UpdateApplyOptions) => owner.apply(options))
  return strategy
}

export type { UpdateCommandOwner }
export { createUpdateCommandOwner }
