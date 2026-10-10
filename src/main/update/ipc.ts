import { ipcMainHandle } from '../ipc-handler-registry'

import { createUpdateCommandOwner, type UpdateCommandOwner } from './command-owner'
import type { UpdateApplyOptions, UpdateDownloadOptions } from '../../shared/update'
import { createUpdateStrategy } from './create-strategy'
import type { UpdateStrategy } from './strategy'

// Registers the renderer-callable update commands. Returns the strategy so the scheduler can drive it.
export const registerUpdateIpcHandlers = (
  strategy: UpdateStrategy = createUpdateStrategy(),
  owner: UpdateCommandOwner = createUpdateCommandOwner(strategy)
): UpdateStrategy => {
  ipcMainHandle('update:get-app-info', () => owner.getAppInfo())
  ipcMainHandle('update:get-status', () => owner.getStatus())
  ipcMainHandle('update:check', () => owner.check())
  ipcMainHandle('update:download', (_event, options?: UpdateDownloadOptions) =>
    owner.download(options)
  )
  ipcMainHandle('update:cancel', () => owner.cancel())
  ipcMainHandle('update:apply', (_event, options?: UpdateApplyOptions) => owner.apply(options))
  return strategy
}

export type { UpdateCommandOwner }
export { createUpdateCommandOwner }
