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
  app: Pick<App, 'on' | 'removeListener' | 'exit'> & { quit: () => void }
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
  let disposed = false
  let quitTimeout: ReturnType<typeof setTimeout> | undefined
  const clearQuitTimeout = (): void => {
    if (quitTimeout) clearTimeout(quitTimeout)
    quitTimeout = undefined
  }
  const maybeQuit = (): void => {
    if (!pendingQuit || !attemptSettled || quitIssued || disposed) return
    // A blocked startup never installs the application lifecycle. A verified startup hands the quit
    // request to that lifecycle so every runtime owner created during composition is torn down normally.
    if (!released && deps.owner.getState().phase !== 'blocked') {
      // Bound only the post-verification handoff. Never interrupt a database migration for an
      // ordinary quit; a stalled runtime cannot provide its cooperative disposer before completion.
      quitTimeout ??= setTimeout(() => {
        quitIssued = true
        deps.app.exit(0)
      }, 5_000)
      return
    }
    quitIssued = true
    clearQuitTimeout()
    deps.app.quit()
  }
  const onBeforeQuit = (event: Electron.Event): void => {
    const phase = deps.owner.getState().phase
    if (!deps.owner.isMigrating() && phase !== 'starting' && phase !== 'ready') return
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
    disposed = true
    clearQuitTimeout()
    deps.app.removeListener('before-quit', onBeforeQuit)
  }
  return {
    dispose,
    release: () => {
      released = true
      clearQuitTimeout()
      deps.app.removeListener('before-quit', onBeforeQuit)
      maybeQuit()
    }
  }
}

export { installDatabaseStartupQuitGuard, registerDatabaseStartupIpc }
export type { DatabaseStartupIpcDeps, DatabaseStartupQuitGuard, DatabaseStartupQuitGuardDeps }
