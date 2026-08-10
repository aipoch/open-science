import type { App, BrowserWindow, IpcMain } from 'electron'

import { DATABASE_STARTUP_CHANNELS } from '../../shared/database-startup'
import type { DatabaseStartupOwner } from './database-startup-owner'

type DatabaseStartupIpcDeps = {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>
  owner: DatabaseStartupOwner
  quit: () => void
  getWindows: () => readonly Pick<BrowserWindow, 'isDestroyed' | 'webContents'>[]
}

const registerDatabaseStartupIpc = (deps: DatabaseStartupIpcDeps): (() => void) => {
  deps.ipcMain.handle(DATABASE_STARTUP_CHANNELS.getState, () => deps.owner.getState())
  deps.ipcMain.handle(DATABASE_STARTUP_CHANNELS.retry, () => deps.owner.retry())
  deps.ipcMain.handle(DATABASE_STARTUP_CHANNELS.quit, () => deps.quit())

  const unsubscribe = deps.owner.subscribe((state) => {
    for (const window of deps.getWindows()) {
      if (!window.isDestroyed())
        window.webContents.send(DATABASE_STARTUP_CHANNELS.stateChanged, state)
    }
  })

  return () => {
    unsubscribe()
    deps.ipcMain.removeHandler(DATABASE_STARTUP_CHANNELS.getState)
    deps.ipcMain.removeHandler(DATABASE_STARTUP_CHANNELS.retry)
    deps.ipcMain.removeHandler(DATABASE_STARTUP_CHANNELS.quit)
  }
}

type DatabaseStartupQuitGuardDeps = {
  app: Pick<App, 'on' | 'removeListener'> & { quit: () => void }
  owner: Pick<DatabaseStartupOwner, 'isMigrating' | 'whenAttemptSettled'>
}

const installDatabaseStartupQuitGuard = (deps: DatabaseStartupQuitGuardDeps): (() => void) => {
  let pendingQuit = false
  const onBeforeQuit = (event: Electron.Event): void => {
    if (!deps.owner.isMigrating()) return
    event.preventDefault()
    if (pendingQuit) return
    pendingQuit = true
    void deps.owner.whenAttemptSettled().finally(() => {
      pendingQuit = false
      deps.app.quit()
    })
  }
  deps.app.on('before-quit', onBeforeQuit)
  return () => deps.app.removeListener('before-quit', onBeforeQuit)
}

export { installDatabaseStartupQuitGuard, registerDatabaseStartupIpc }
export type { DatabaseStartupIpcDeps, DatabaseStartupQuitGuardDeps }
