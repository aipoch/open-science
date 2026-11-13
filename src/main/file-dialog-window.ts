import { app, BrowserWindow, ipcMain, nativeTheme, screen, type BaseWindow } from 'electron'
import { createLogger, startDiagnosticOperation } from '@aipoch/diagnostics/node'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FILE_DIALOG_UI_CHANNEL } from '../shared/file-dialog-ui'
import { resolveLocaleFromTags } from '../shared/locale'
import { FileDialogUiSession } from './file-dialog-ui-state'
import {
  FILE_DIALOG_DISPLAY_TIMEOUT_MS,
  type FileDialogResult,
  type FileDialogWindowRequest
} from './file-dialog-protocol'

type FileDialogOperation = ReturnType<typeof startDiagnosticOperation>

// Save dialogs are owned by the desktop process so the parent/modal relationship remains intact.
let activeInProcessDialog: BrowserWindow | undefined
const SAVE_DIALOG_CONTENT_HEIGHT = 252

const operationFields = (window: BrowserWindow): { visible: boolean; focused: boolean } => ({
  visible: window.isVisible(),
  focused: window.isFocused()
})

const restoreParentWindow = (parent: BaseWindow | undefined): void => {
  if (!parent || parent.isDestroyed()) return
  if (process.platform === 'darwin') app.focus({ steal: true })
  if (parent.isMinimized()) parent.restore()
  if (!parent.isVisible()) parent.show()
  parent.focus()
}

export async function showHtmlFileDialog(
  request: FileDialogWindowRequest,
  parent?: BaseWindow,
  signal?: AbortSignal
): Promise<FileDialogResult> {
  const inProcess = parent !== undefined || !process.send
  if (inProcess && activeInProcessDialog && !activeInProcessDialog.isDestroyed())
    throw new Error('A file dialog is already open.')

  const page = process.env.ELECTRON_RENDERER_URL
    ? new URL('file-dialog.html', `${process.env.ELECTRON_RENDERER_URL}/`).href
    : pathToFileURL(join(__dirname, '../renderer/file-dialog.html')).href
  nativeTheme.themeSource = request.appearance.followsSystem ? 'system' : request.appearance.theme
  const operation: FileDialogOperation | undefined = inProcess
    ? startDiagnosticOperation(createLogger('native-file-dialog'), {
        operation: 'native-file-dialog',
        operationId: request.operationId,
        fields: {
          kind: request.kind,
          platform: process.platform,
          presentation: 'html',
          processModel: 'in-process',
          parented: Boolean(parent)
        }
      })
    : undefined
  const window = new BrowserWindow({
    ...(parent ? { parent, modal: true } : {}),
    title: request.options.title || 'Open-Science',
    width: 600,
    height: request.kind === 'save' ? SAVE_DIALOG_CONTENT_HEIGHT : 560,
    minWidth: 480,
    minHeight: request.kind === 'save' ? SAVE_DIALOG_CONTENT_HEIGHT : 320,
    useContentSize: true,
    show: false,
    // Keep the legacy helper out of the taskbar; in-process dialogs use their parent instead.
    ...(!inProcess && process.platform === 'win32' ? { skipTaskbar: true } : {}),
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
  if (inProcess) activeInProcessDialog = window
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
  let abort: (() => void) | undefined
  const reportWindow = (phase: 'created' | 'renderer-ready' | 'shown' | 'focused'): void => {
    const fields = operationFields(window)
    if (operation) operation.phase(phase, fields)
    else
      process.send?.({
        type: 'window-state',
        phase,
        ...fields,
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
    if (!inProcess) {
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
        // Legacy helper dialogs still need an explicit focus request after app activation.
        if (process.platform === 'darwin') app.focus({ steal: true })
        if (window.isMinimized()) window.restore()
        window.show()
        window.moveTop()
        window.focus()
      }
      process.on('message', refocus)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    abort = (): void => fail(new Error('File dialog was cancelled.'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const releaseForeground = (): void => {
      if (!window.isDestroyed()) window.setAlwaysOnTop(false)
    }
    const reveal = (): void => {
      if (!loaded || !rendererReady || revealing || settled) return
      revealing = true
      if (!inProcess) {
        // Legacy helper dialogs are separate applications and need a short foreground bridge.
        if (process.platform === 'darwin') app.focus({ steal: true })
        if (process.platform === 'win32') {
          window.setAlwaysOnTop(true)
          foregroundTimer = setTimeout(releaseForeground, 1200)
          window.once('blur', releaseForeground)
        }
      }
      window.show()
      if (!inProcess) window.moveTop()
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
            const errorCode = `optional-${kind}-unavailable`
            if (operation) operation.phase('optional-folder-unavailable', { errorCode })
            else process.send?.({ type: 'selection-error', errorCode })
            return []
          }
        })
      },
      finish,
      (errorCode) => {
        if (operation) operation.phase('selection-rejected', { errorCode })
        else process.send?.({ type: 'selection-error', errorCode })
      }
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
        const contentWidth = window.getContentSize()[0]
        const contentHeight = action.expanded
          ? request.kind === 'save'
            ? 536
            : 588
          : request.kind === 'save'
            ? SAVE_DIALOG_CONTENT_HEIGHT
            : 340
        window.setContentSize(contentWidth, Math.min(contentHeight, area.height))
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
  let outcome: 'completed' | 'cancelled' | undefined
  let failure: unknown
  let failed = false
  try {
    const selected = await result
    if (operation) {
      operation.phase(selected.canceled ? 'cancelled' : 'selected')
      outcome = selected.canceled ? 'cancelled' : 'completed'
    }
    return selected
  } catch (error) {
    failed = true
    failure = error
    throw error
  } finally {
    clearTimeout(displayTimer)
    clearTimeout(revealTimer)
    clearTimeout(foregroundTimer)
    if (refocus) process.removeListener('message', refocus)
    if (abort) signal?.removeEventListener('abort', abort)
    ipcMain.removeHandler(FILE_DIALOG_UI_CHANNEL)
    if (activeInProcessDialog === window) activeInProcessDialog = undefined
    if (!window.isDestroyed()) window.destroy()
    operation?.phase('closed')
    if (operation) {
      if (failed) operation.fail(failure)
      else if (outcome === 'cancelled') operation.cancel()
      else if (outcome === 'completed') operation.complete()
    }
    if (inProcess) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      restoreParentWindow(parent)
    }
  }
}
