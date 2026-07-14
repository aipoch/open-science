import { ipcMain } from 'electron'

import { APP } from '../../shared/app-config'
import type { AppInfo, UpdateStatus } from '../../shared/update'
import { UpdateService } from './service'

// Registers the renderer-callable update commands. Returns the service so the scheduler can drive it.
export const registerUpdateIpcHandlers = (
  service: UpdateService = new UpdateService()
): UpdateService => {
  ipcMain.handle('update:get-app-info', (): AppInfo => ({
    name: APP.name,
    version: service.getStatus().current,
    copyright: APP.copyright
  }))
  ipcMain.handle('update:get-status', (): UpdateStatus => service.getStatus())
  ipcMain.handle('update:check', (): Promise<UpdateStatus> => service.check())
  ipcMain.handle('update:download', (): Promise<UpdateStatus> => service.download())
  ipcMain.handle('update:open-installer', (): Promise<UpdateStatus> => service.openInstaller())
  return service
}
