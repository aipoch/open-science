import { ipcMainHandle } from '../ipc-handler-registry'

import { APP } from '../../shared/app-config'
import type { AppInfo, UpdateStatus } from '../../shared/update'
import { createUpdateStrategy } from './create-strategy'
import type { UpdateStrategy } from './strategy'

// Registers the renderer-callable update commands. Returns the strategy so the scheduler can drive it.
export const registerUpdateIpcHandlers = (
  strategy: UpdateStrategy = createUpdateStrategy()
): UpdateStrategy => {
  ipcMainHandle('update:get-app-info', (): AppInfo => ({
    name: APP.name,
    version: strategy.getStatus().current,
    copyright: APP.copyright
  }))
  ipcMainHandle('update:get-status', (): UpdateStatus => strategy.getStatus())
  ipcMainHandle('update:check', (): Promise<UpdateStatus> => strategy.check())
  ipcMainHandle('update:download', (): Promise<UpdateStatus> => strategy.download())
  ipcMainHandle('update:cancel', (): Promise<UpdateStatus> => strategy.cancel())
  ipcMainHandle('update:apply', (): Promise<UpdateStatus> => strategy.apply())
  return strategy
}
