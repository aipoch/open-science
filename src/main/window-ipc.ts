import { BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron'

import { ipcMainHandle } from './ipc-handler-registry'

import { WINDOW_CLOSE_CHANNEL } from '../shared/window-controls'
import { isInterfaceScale } from '../shared/interface-scale'

// The minimal window surface the close handler needs; keeps the resolver injectable for tests.
type ClosableWindow = {
  close: () => void
  webContents?: {
    getZoomFactor?: () => number
    setZoomFactor: (factor: number) => void
  }
}

type WindowIpcDeps = {
  // Maps the invoking web contents back to its window. Defaults to Electron's own lookup.
  resolveWindow?: (sender: WebContents) => ClosableWindow | null
}

// Renderer fallback for Cmd+W / Ctrl+W: when no preview panel is open, the renderer asks to close the
// window that owns it. Closing defers to that window's own 'close' handling (e.g. hide-to-tray), so
// this stays a thin bridge rather than a second place that decides window lifecycle.
const registerWindowIpcHandlers = (deps: WindowIpcDeps = {}): void => {
  registerWindowCloseIpcHandler(deps)
  registerWindowZoomIpcHandler(deps)
}

const registerWindowCloseIpcHandler = (deps: WindowIpcDeps = {}): void => {
  const resolveWindow = deps.resolveWindow ?? ((sender) => BrowserWindow.fromWebContents(sender))

  ipcMainHandle(WINDOW_CLOSE_CHANNEL, (event: IpcMainInvokeEvent): void => {
    resolveWindow(event.sender)?.close()
  })
}

const registerWindowZoomIpcHandler = (deps: WindowIpcDeps = {}): void => {
  const resolveWindow = deps.resolveWindow ?? ((sender) => BrowserWindow.fromWebContents(sender))

  ipcMainHandle('window:set-zoom-factor', (event: IpcMainInvokeEvent, factor: unknown): void => {
    if (!isInterfaceScale(factor)) return
    const webContents = resolveWindow(event.sender)?.webContents
    // Avoid triggering a compositor/layout update when startup reapplies the default 100% factor.
    if (!webContents || webContents.getZoomFactor?.() === factor) return
    webContents.setZoomFactor(factor)
  })
}

export { registerWindowCloseIpcHandler, registerWindowIpcHandlers, registerWindowZoomIpcHandler }
