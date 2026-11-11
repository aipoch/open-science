import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FILE_DIALOG_UI_CHANNEL } from '../shared/file-dialog-ui'
import { resolveLocaleFromTags } from '../shared/locale'
import { FileDialogUiSession } from './file-dialog-ui-state'
import type { FileDialogHelperRequest, FileDialogResult } from './file-dialog-protocol'

export async function showHtmlFileDialog(
  request: FileDialogHelperRequest
): Promise<FileDialogResult> {
  const page = process.env.ELECTRON_RENDERER_URL
    ? new URL('file-dialog.html', `${process.env.ELECTRON_RENDERER_URL}/`).href
    : pathToFileURL(join(__dirname, '../renderer/file-dialog.html')).href
  const window = new BrowserWindow({
    title: request.options.title || 'Open-Science',
    width: 720,
    height: 600,
    minWidth: 540,
    minHeight: 460,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/file-dialog.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
  window.setMenu(null)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  )
  const result = new Promise<FileDialogResult>((resolve, reject) => {
    let settled = false
    const finish = (selection: FileDialogResult): void => {
      if (settled) return
      settled = true
      resolve(selection)
    }
    const session = new FileDialogUiSession(
      request,
      {
        locale: resolveLocaleFromTags([app.getLocale()]),
        shortcuts: [
          { kind: 'downloads', path: app.getPath('downloads') },
          { kind: 'home', path: app.getPath('home') },
          { kind: 'desktop', path: app.getPath('desktop') }
        ]
      },
      finish,
      (errorCode) => process.send?.({ type: 'selection-error', errorCode })
    )
    let busy = false
    ipcMain.handle(FILE_DIALOG_UI_CHANNEL, async (event, action: unknown) => {
      if (
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url !== page
      )
        throw new Error('File dialog caller is unavailable.')
      if (busy || settled) throw new Error('File dialog action is unavailable.')
      if (action && typeof action === 'object' && 'type' in action && action.type === 'failed') {
        settled = true
        reject(new Error('File dialog initialization failed.'))
        return { type: 'done' }
      }
      busy = true
      try {
        return await session.action(action)
      } finally {
        busy = false
      }
    })
    window.once('closed', () =>
      finish(
        request.kind === 'save'
          ? { canceled: true, filePath: '' }
          : { canceled: true, filePaths: [] }
      )
    )
    window.webContents.once('render-process-gone', () => {
      if (!settled) {
        settled = true
        reject(new Error('File dialog renderer exited.'))
      }
    })
    void window
      .loadURL(page)
      .then(() => {
        window.show()
        window.focus()
      })
      .catch(reject)
  })
  try {
    return await result
  } finally {
    ipcMain.removeHandler(FILE_DIALOG_UI_CHANNEL)
    if (!window.isDestroyed()) window.destroy()
  }
}
