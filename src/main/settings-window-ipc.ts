import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { ipcMainHandle } from './ipc-handler-registry'
import { createSettingsWindow, isTrustedAppContents } from './windows'
import { isSettingsWebContents } from './settings-window-policy'
import {
  SETTINGS_WINDOW_CHANNELS as C,
  isSettingsWindowRequest,
  isSettingsWorkspaceNavigation,
  type SettingsWindowState
} from '../shared/settings-window'

export const registerSettingsWindowIpcHandlers = (): (() => void) => {
  let settings: BrowserWindow | undefined
  let owner: BrowserWindow | undefined
  let navigationToken = 0
  let state: SettingsWindowState = { revision: 0 }
  const hide = (restoreTrigger = true): void => {
    navigationToken++
    state = { ...state, visible: false, route: undefined, revision: state.revision + 1 }
    if (settings && !settings.isDestroyed()) {
      settings.webContents.send(C.opened, state)
      settings.hide()
      if (owner && !owner.isDestroyed()) owner.focus()
      if (restoreTrigger && owner && !owner.isDestroyed()) owner.webContents.send(C.opened, state)
    }
  }
  const trusted = (event: IpcMainInvokeEvent): void => {
    if (!isTrustedAppContents(event.sender) || event.senderFrame !== event.sender.mainFrame)
      throw new Error('Untrusted settings window caller.')
  }
  const requireOwner = (event: IpcMainInvokeEvent): void => {
    trusted(event)
    if (event.sender !== owner?.webContents) throw new Error('Workspace no longer owns settings.')
  }
  const requireSettings = (event: IpcMainInvokeEvent): void => {
    trusted(event)
    if (event.sender !== settings?.webContents)
      throw new Error('Settings window is no longer current.')
  }
  ipcMainHandle(C.open, (event, request: unknown = {}) => {
    trusted(event)
    if (isSettingsWebContents(event.sender) || !isSettingsWindowRequest(request))
      throw new Error('Invalid settings request.')
    const nextOwner = BrowserWindow.fromWebContents(event.sender)
    if (!nextOwner) throw new Error('Workspace is unavailable.')
    navigationToken++
    owner = nextOwner
    state = { ...request, visible: true, revision: state.revision + 1 }
    owner.webContents.send(C.opened, state)
    if (settings && !settings.isDestroyed() && settings.webContents.isCrashed()) settings.destroy()
    if (!settings || settings.isDestroyed()) {
      const window = createSettingsWindow()
      settings = window
      // Reuse the renderer to retain form drafts and pending Undo. Main-window destruction and
      // application teardown still destroy it, so a hidden auxiliary window cannot strand the app.
      window.on('close', (close) => {
        close.preventDefault()
        hide()
      })
      window.on('closed', () => {
        if (settings === window) settings = undefined
      })
      nextOwner.once('closed', () => {
        if (!window.isDestroyed()) window.destroy()
      })
    } else {
      settings.webContents.send(C.opened, state)
      if (settings.isMinimized()) settings.restore()
      settings.show()
      settings.focus()
    }
  })
  ipcMainHandle(C.ready, (event) => {
    requireSettings(event)
    return state
  })
  ipcMainHandle(C.context, (event, context: unknown) => {
    trusted(event)
    // Main publishes selection before the first settings window exists as well.
    if (!owner || event.sender !== owner.webContents) return
    if (!isSettingsWindowRequest(context)) throw new Error('Invalid settings context.')
    state = { ...state, activeProjectId: context.activeProjectId, revision: state.revision + 1 }
    if (settings && !settings.isDestroyed())
      settings.webContents.send(C.opened, { ...state, route: undefined })
  })
  ipcMainHandle(C.navigate, (event, request: unknown) => {
    requireSettings(event)
    if (!isSettingsWorkspaceNavigation(request) || !owner || owner.isDestroyed())
      throw new Error('Workspace navigation is unavailable.')
    owner.show()
    owner.focus()
    owner.webContents.send(C.navigation, { ...request, navigationToken: ++navigationToken })
  })
  ipcMainHandle(C.navigated, (event, token: unknown) => {
    requireOwner(event)
    if (token !== navigationToken) return
    hide(false)
    owner?.focus()
  })
  return () => {
    if (settings && !settings.isDestroyed()) settings.destroy()
    settings = undefined
  }
}
