import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'

import { WINDOW_CLOSE_CHANNEL } from '../shared/window-controls'

// The minimal window surface the close handler needs; keeps the resolver injectable for tests.
type ClosableWindow = { close: () => void }

type WindowIpcDeps = {
  // Maps the invoking web contents back to its window. Defaults to Electron's own lookup.
  resolveWindow?: (sender: WebContents) => ClosableWindow | null
}

// Renderer fallback for Cmd+W / Ctrl+W: when no preview panel is open, the renderer asks to close the
// window that owns it. Closing defers to that window's own 'close' handling (e.g. hide-to-tray), so
// this stays a thin bridge rather than a second place that decides window lifecycle.
const registerWindowIpcHandlers = (deps: WindowIpcDeps = {}): void => {
  const resolveWindow = deps.resolveWindow ?? ((sender) => BrowserWindow.fromWebContents(sender))

  ipcMain.handle(WINDOW_CLOSE_CHANNEL, (event: IpcMainInvokeEvent): void => {
    resolveWindow(event.sender)?.close()
  })
}

export { registerWindowIpcHandlers }
