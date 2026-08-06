import { ipcMainHandle } from '../ipc-handler-registry'

import { APP } from '../../shared/app-config'
import type { AppInfo, UpdateStatus } from '../../shared/update'
import { createUpdateStrategy } from './create-strategy'
import type { UpdateStrategy } from './strategy'

type UpdateCommandOwner = Readonly<{
  getAppInfo: () => AppInfo
  getStatus: () => UpdateStatus
  check: () => Promise<UpdateStatus>
  download: () => Promise<UpdateStatus>
  cancel: () => Promise<UpdateStatus>
  apply: () => Promise<UpdateStatus>
}>

const createUpdateCommandOwner = (strategy: UpdateStrategy): UpdateCommandOwner => ({
  getAppInfo: (): AppInfo => ({
    name: APP.name,
    version: strategy.getStatus().current,
    copyright: APP.copyright
  }),
  getStatus: () => strategy.getStatus(),
  check: () => strategy.check(),
  download: () => strategy.download(),
  cancel: () => strategy.cancel(),
  apply: () => strategy.apply()
})

// Registers the renderer-callable update commands. Returns the strategy so the scheduler can drive it.
export const registerUpdateIpcHandlers = (
  strategy: UpdateStrategy = createUpdateStrategy(),
  owner: UpdateCommandOwner = createUpdateCommandOwner(strategy)
): UpdateStrategy => {
  ipcMainHandle('update:get-app-info', () => owner.getAppInfo())
  ipcMainHandle('update:get-status', () => owner.getStatus())
  ipcMainHandle('update:check', () => owner.check())
  ipcMainHandle('update:download', () => owner.download())
  ipcMainHandle('update:cancel', () => owner.cancel())
  ipcMainHandle('update:apply', () => owner.apply())
  return strategy
}

export type { UpdateCommandOwner }
export { createUpdateCommandOwner }
