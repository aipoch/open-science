import type { App, BrowserWindow, IpcMain } from 'electron'

import { DATABASE_STARTUP_CHANNELS } from '../../shared/database-startup'
import { createLogger, errorLogFields } from '../logger'
import type { DatabaseStartupOwner } from './database-startup-owner'

const log = createLogger('database-startup-ipc')

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
      try {
        if (!window.isDestroyed())
          window.webContents.send(DATABASE_STARTUP_CHANNELS.stateChanged, state)
      } catch (error) {
        try {
          log.warn('database startup window notification failed', errorLogFields(error))
        } catch {
          // Continue delivering to the remaining windows even if logging fails.
        }
      }
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
  owner: Pick<DatabaseStartupOwner, 'getState' | 'isMigrating' | 'whenAttemptSettled'>
}

type DatabaseStartupQuitGuard = {
  dispose: () => void
  release: () => void
}

const installDatabaseStartupQuitGuard = (
  deps: DatabaseStartupQuitGuardDeps
): DatabaseStartupQuitGuard => {
  let attemptSettled = false
  let pendingQuit = false
  let quitIssued = false
  let released = false
  const maybeQuit = (): void => {
    if (!pendingQuit || !attemptSettled || quitIssued) return
    // A blocked startup never installs the application lifecycle. A verified startup hands the quit
    // request to that lifecycle so every runtime owner created during composition is torn down normally.
    if (!released && deps.owner.getState().phase !== 'blocked') return
    quitIssued = true
    deps.app.quit()
  }
  const onBeforeQuit = (event: Electron.Event): void => {
    if (!deps.owner.isMigrating()) return
    event.preventDefault()
    if (pendingQuit) return
    pendingQuit = true
    void deps.owner.whenAttemptSettled().finally(() => {
      attemptSettled = true
      maybeQuit()
    })
  }
  deps.app.on('before-quit', onBeforeQuit)
  const dispose = (): void => {
    deps.app.removeListener('before-quit', onBeforeQuit)
  }
  return {
    dispose,
    release: () => {
      released = true
      dispose()
      maybeQuit()
    }
  }
}

export { installDatabaseStartupQuitGuard, registerDatabaseStartupIpc }
export type { DatabaseStartupIpcDeps, DatabaseStartupQuitGuard, DatabaseStartupQuitGuardDeps }
