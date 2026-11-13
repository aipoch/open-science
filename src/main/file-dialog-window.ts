import { app, BrowserWindow, ipcMain, nativeTheme, screen } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FILE_DIALOG_UI_CHANNEL } from '../shared/file-dialog-ui'
import { resolveLocaleFromTags } from '../shared/locale'
import { FileDialogUiSession } from './file-dialog-ui-state'
import {
  FILE_DIALOG_DISPLAY_TIMEOUT_MS,
  type FileDialogHelperRequest,
  type FileDialogResult
} from './file-dialog-protocol'

export async function showHtmlFileDialog(
  request: FileDialogHelperRequest
): Promise<FileDialogResult> {
  const page = process.env.ELECTRON_RENDERER_URL
    ? new URL('file-dialog.html', `${process.env.ELECTRON_RENDERER_URL}/`).href
    : pathToFileURL(join(__dirname, '../renderer/file-dialog.html')).href
  nativeTheme.themeSource = request.appearance.followsSystem ? 'system' : request.appearance.theme
  const window = new BrowserWindow({
    title: request.options.title || 'Open-Science',
    width: 600,
    height: request.kind === 'save' ? 340 : 560,
    minWidth: 480,
    minHeight: request.kind === 'save' ? 340 : 320,
    useContentSize: true,
    show: false,
    // Keep the caller's taskbar entry without making the helper window unfocusable.
    skipTaskbar: process.platform === 'win32',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/file-dialog.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false
    }
  })
  window.setMenu(null)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  )
  let displayTimer: ReturnType<typeof setTimeout> | undefined
  let revealTimer: ReturnType<typeof setTimeout> | undefined
  let foregroundTimer: ReturnType<typeof setTimeout> | undefined
  const reportWindow = (phase: 'created' | 'renderer-ready' | 'shown' | 'focused'): void => {
    process.send?.({
      type: 'window-state',
      phase,
      visible: window.isVisible(),
      focused: window.isFocused(),
      ...(process.platform === 'darwin' ? { dockVisible: app.dock?.isVisible() } : {})
    })
  }
  reportWindow('created')
  let refocus: ((message: unknown) => void) | undefined
  const result = new Promise<FileDialogResult>((resolve, reject) => {
    let settled = false
    window.on('focus', () => {
      if (!settled && window.isVisible()) reportWindow('focused')
    })
    let loaded = false
    let rendererReady = false
    let revealing = false
    refocus = (message: unknown): void => {
      if (
        !message ||
        typeof message !== 'object' ||
        !('type' in message) ||
        message.type !== 'focus' ||
        !('operationId' in message) ||
        message.operationId !== request.operationId ||
        !revealing ||
        settled ||
        window.isDestroyed()
      )
        return
      // Accessory helpers are absent from Cmd-Tab. Reactivate the existing picker through its owner.
      if (process.platform === 'darwin') app.focus({ steal: true })
      if (window.isMinimized()) window.restore()
      window.show()
      window.moveTop()
      window.focus()
    }
    process.on('message', refocus)
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    const releaseForeground = (): void => {
      if (!window.isDestroyed()) window.setAlwaysOnTop(false)
    }
    const reveal = (): void => {
      if (!loaded || !rendererReady || revealing || settled) return
      revealing = true
      // GUI helpers must explicitly show after React mounts. A short normal-level raise bridges
      // the cross-process owner gap without leaving the picker above other applications.
      if (process.platform === 'darwin') app.focus({ steal: true })
      if (process.platform === 'win32') {
        window.setAlwaysOnTop(true)
        foregroundTimer = setTimeout(releaseForeground, 1200)
        window.once('blur', releaseForeground)
      }
      window.show()
      window.moveTop()
      window.focus()
      const confirmVisible = (): void => {
        if (settled || window.isDestroyed()) return
        if (!window.isVisible()) {
          fail(new Error('File dialog window did not become visible.'))
          return
        }
        clearTimeout(displayTimer)
        reportWindow('shown')
      }
      if (window.isVisible()) confirmVisible()
      else revealTimer = setTimeout(confirmVisible, 100)
    }
    displayTimer = setTimeout(
      () => fail(new Error('File dialog initialization timed out.')),
      FILE_DIALOG_DISPLAY_TIMEOUT_MS - 1000
    )
    const finish = (selection: FileDialogResult): void => {
      if (settled) return
      settled = true
      resolve(selection)
    }
    const session = new FileDialogUiSession(
      request,
      {
        locale: request.appearance.locale ?? resolveLocaleFromTags([app.getLocale()]),
        appearance: request.appearance,
        shortcuts: (['downloads', 'home', 'desktop'] as const).flatMap((kind) => {
          try {
            return [{ kind, path: app.getPath(kind) }]
          } catch {
            // Optional OS folders can be absent in redirected or isolated Windows profiles.
            process.send?.({ type: 'selection-error', errorCode: `optional-${kind}-unavailable` })
            return []
          }
        })
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
      if (settled) throw new Error('File dialog action is unavailable.')
      if (action && typeof action === 'object' && 'type' in action && action.type === 'failed') {
        fail(new Error('File dialog initialization failed.'))
        return { type: 'done' }
      }
      if (action && typeof action === 'object' && 'type' in action && action.type === 'ready') {
        if (!rendererReady) {
          rendererReady = true
          reportWindow('renderer-ready')
          reveal()
        }
        return { type: 'done' }
      }
      if (action && typeof action === 'object' && 'type' in action && action.type === 'resize') {
        if (!('expanded' in action) || typeof action.expanded !== 'boolean')
          throw new Error('Invalid dialog size request.')
        const bounds = window.getBounds()
        const area = screen.getDisplayMatching(bounds).workArea
        const frameHeight = bounds.height - window.getContentBounds().height
        const contentHeight = action.expanded ? (request.kind === 'save' ? 536 : 588) : 340
        const height = Math.min(contentHeight + frameHeight, area.height)
        window.setBounds({
          x: bounds.x,
          y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
          width: bounds.width,
          height
        })
        return { type: 'done' }
      }
      if (busy) throw new Error('File dialog action is unavailable.')
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
    window.webContents.once('render-process-gone', () =>
      fail(new Error('File dialog renderer exited.'))
    )
    window.webContents.once('preload-error', () => fail(new Error('File dialog preload failed.')))
    void window
      .loadURL(page)
      .then(() => {
        loaded = true
        reveal()
      })
      .catch(() => fail(new Error('File dialog page failed to load.')))
  })
  try {
    return await result
  } finally {
    clearTimeout(displayTimer)
    clearTimeout(revealTimer)
    clearTimeout(foregroundTimer)
    if (refocus) process.removeListener('message', refocus)
    ipcMain.removeHandler(FILE_DIALOG_UI_CHANNEL)
    if (!window.isDestroyed()) window.destroy()
  }
}
