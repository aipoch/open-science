import { ipcMain } from 'electron'

import { APP } from '../../shared/app-config'
import type { AppInfo, UpdateStatus } from '../../shared/update'
import { UpdateService } from './service'
import type { UpdateStrategy } from './strategy'

// Registers the renderer-callable update commands. Returns the strategy so the scheduler can drive it.
export const registerUpdateIpcHandlers = (
  strategy: UpdateStrategy = new UpdateService()
): UpdateStrategy => {
  ipcMain.handle('update:get-app-info', (): AppInfo => ({
    name: APP.name,
    version: strategy.getStatus().current,
    copyright: APP.copyright
  }))
  ipcMain.handle('update:get-status', (): UpdateStatus => strategy.getStatus())
  ipcMain.handle('update:check', (): Promise<UpdateStatus> => strategy.check())
  ipcMain.handle('update:download', (): Promise<UpdateStatus> => strategy.download())
  ipcMain.handle('update:apply', (): Promise<UpdateStatus> => strategy.apply())
  return strategy
}
