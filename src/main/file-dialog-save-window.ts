import { app, BrowserWindow, ipcMain, nativeTheme, screen, type BaseWindow } from 'electron'
import { createLogger, startDiagnosticOperation } from '@aipoch/diagnostics/node'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FILE_DIALOG_UI_CHANNEL } from '../shared/file-dialog-ui'
import { resolveLocaleFromTags } from '../shared/locale'
import { FileDialogUiSession } from './file-dialog-ui-state'
import {
  FILE_DIALOG_DISPLAY_TIMEOUT_MS,
  type FileDialogSaveResult,
  type FileDialogWindowRequest
} from './file-dialog-protocol'

type FileDialogOperation = ReturnType<typeof startDiagnosticOperation>

const SAVE_DIALOG_MIN_CONTENT_HEIGHT = 252
let activeSaveDialog: BrowserWindow | undefined

const resizeSaveDialog = (window: BrowserWindow, requestedHeight: number): void => {
  const bounds = window.getBounds()
  const workArea = screen.getDisplayMatching(bounds).workArea
  const [contentWidth, currentHeight] = window.getContentSize()
  // Electron uses DIP for window sizes; the renderer reports CSS pixels at its current zoom.
  const desiredHeight = Math.ceil(requestedHeight * window.webContents.getZoomFactor())
  const frameHeight = Math.max(0, bounds.height - currentHeight)
  const maxHeight = Math.max(1, workArea.height - frameHeight)
  const minHeight = Math.min(SAVE_DIALOG_MIN_CONTENT_HEIGHT, maxHeight)
  const contentHeight = Math.min(maxHeight, Math.max(minHeight, desiredHeight))
  const [minimumWidth, minimumHeight] = window.getMinimumSize()
  if (minimumHeight !== minHeight + frameHeight)
    window.setMinimumSize(minimumWidth, minHeight + frameHeight)
  if (currentHeight !== contentHeight) window.setContentSize(contentWidth, contentHeight)
  const resizedBounds = window.getBounds()
  const y = Math.max(
    workArea.y,
    Math.min(resizedBounds.y, workArea.y + workArea.height - resizedBounds.height)
  )
  if (y !== resizedBounds.y) window.setPosition(resizedBounds.x, y)
}

const restoreParentWindow = (parent: BaseWindow): void => {
  if (parent.isDestroyed()) return
  if (process.platform === 'darwin') app.focus({ steal: true })
  if (parent.isMinimized()) parent.restore()
  if (!parent.isVisible()) parent.show()
  parent.focus()
}

// Keep the save picker in the desktop process so Electron owns its parent/modal relationship.
export async function showInProcessFileDialog(
  request: FileDialogWindowRequest,
  parent: BaseWindow,
  signal?: AbortSignal
): Promise<FileDialogSaveResult> {
  signal?.throwIfAborted()
  if (parent.isDestroyed()) throw new Error('Desktop command window is no longer available.')
  if (activeSaveDialog && !activeSaveDialog.isDestroyed())
    throw new Error('A file dialog is already open.')

  const page = process.env.ELECTRON_RENDERER_URL
    ? new URL('file-dialog.html', `${process.env.ELECTRON_RENDERER_URL}/`).href
    : pathToFileURL(join(__dirname, '../renderer/file-dialog.html')).href
  nativeTheme.themeSource = request.appearance.followsSystem ? 'system' : request.appearance.theme
  const operation: FileDialogOperation = startDiagnosticOperation(
    createLogger('native-file-dialog'),
    {
      operation: 'native-file-dialog',
      operationId: request.operationId,
      fields: {
        kind: request.kind,
        platform: process.platform,
        presentation: 'html',
        processModel: 'in-process',
        parented: true
      }
    }
  )
  const window = new BrowserWindow({
    parent,
    modal: true,
    title: request.options.title || 'Open-Science',
    width: 600,
    height: SAVE_DIALOG_MIN_CONTENT_HEIGHT,
    minWidth: 480,
    minHeight: SAVE_DIALOG_MIN_CONTENT_HEIGHT,
    useContentSize: true,
    show: false,
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
  activeSaveDialog = window
  window.setMenu(null)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  )

  let displayTimer: ReturnType<typeof setTimeout> | undefined
  let revealTimer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  let parentClosed: (() => void) | undefined
  let requestedContentHeight = SAVE_DIALOG_MIN_CONTENT_HEIGHT
  const resize = (height = requestedContentHeight): void => {
    if (window.isDestroyed()) return
    if (!Number.isFinite(height) || height <= 0)
      throw new Error('Invalid file dialog content height.')
    requestedContentHeight = height
    const previousHeight = window.getContentSize()[1]
    resizeSaveDialog(window, requestedContentHeight)
    const contentHeight = window.getContentSize()[1]
    if (contentHeight !== previousHeight)
      operation.phase('resized', { requestedHeight: requestedContentHeight, contentHeight })
  }
  const displayChanged = (): void => resize()
  screen.on('display-metrics-changed', displayChanged)
  window.on('moved', displayChanged)
  const reportWindow = (phase: 'created' | 'renderer-ready' | 'shown' | 'focused'): void => {
    operation.phase(phase, { visible: window.isVisible(), focused: window.isFocused() })
  }
  reportWindow('created')

  const result = new Promise<FileDialogSaveResult>((resolve, reject) => {
    let settled = false
    window.on('focus', () => {
      if (!settled && window.isVisible()) reportWindow('focused')
    })
    let loaded = false
    let rendererReady = false
    let revealing = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    abort = (): void => fail(new Error('File dialog was cancelled.'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    parentClosed = (): void => fail(new Error('Desktop command window is no longer available.'))
    parent.once('closed', parentClosed)
    const reveal = (): void => {
      if (!loaded || !rendererReady || revealing || settled) return
      revealing = true
      window.show()
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
    const finish = (selection: FileDialogSaveResult): void => {
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
            operation.phase('optional-folder-unavailable', {
              errorCode: `optional-${kind}-unavailable`
            })
            return []
          }
        })
      },
      finish,
      (errorCode) => operation.phase('selection-rejected', { errorCode })
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
        const requestedHeight =
          'height' in action && typeof action.height === 'number'
            ? action.height
            : SAVE_DIALOG_MIN_CONTENT_HEIGHT
        resize(requestedHeight)
        if (!rendererReady) {
          rendererReady = true
          reportWindow('renderer-ready')
          reveal()
        }
        return { type: 'done' }
      }
      if (action && typeof action === 'object' && 'type' in action && action.type === 'resize') {
        if (!('height' in action) || typeof action.height !== 'number')
          throw new Error('Invalid dialog size request.')
        resize(action.height)
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
    window.once('closed', () => finish({ canceled: true, filePath: '' }))
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

  let outcome: 'completed' | 'cancelled' | undefined
  let failure: unknown
  let failed = false
  try {
    const selected = await result
    operation.phase(selected.canceled ? 'cancelled' : 'selected')
    outcome = selected.canceled ? 'cancelled' : 'completed'
    return selected
  } catch (error) {
    failed = true
    failure = error
    throw error
  } finally {
    clearTimeout(displayTimer)
    clearTimeout(revealTimer)
    if (abort) signal?.removeEventListener('abort', abort)
    if (parentClosed) parent.removeListener('closed', parentClosed)
    screen.removeListener('display-metrics-changed', displayChanged)
    ipcMain.removeHandler(FILE_DIALOG_UI_CHANNEL)
    if (activeSaveDialog === window) activeSaveDialog = undefined
    if (!window.isDestroyed()) window.destroy()
    operation.phase('closed')
    if (failed) operation.fail(failure)
    else if (outcome === 'cancelled') operation.cancel()
    else if (outcome === 'completed') operation.complete()
    await new Promise<void>((resolve) => setImmediate(resolve))
    restoreParentWindow(parent)
  }
}
