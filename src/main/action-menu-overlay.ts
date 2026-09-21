import {
  ipcMain,
  WebContentsView,
  webContents,
  type BrowserWindow,
  type IpcMainEvent,
  type WebContents
} from 'electron'
import {
  isNativeActionMenuRequest,
  type NativeActionMenuRequest,
  type NativeActionMenuResult
} from '../shared/action-menu-overlay'

// One transparent menu surface per owner; it never hides, snapshots or reloads the underlying page.
export const createActionMenuOverlay = (
  window: BrowserWindow,
  paths: { preload: string; html: string; url?: string }
): { destroy: () => void } => {
  const host = window.webContents
  let view: WebContentsView | undefined
  let rendererReady = false
  let current: NativeActionMenuRequest | undefined
  let previousFocus: WebContents | undefined
  let destroyed = false
  let closedId: string | undefined
  const trusted = (event: IpcMainEvent, sender: WebContents | undefined): boolean =>
    !destroyed &&
    !!sender &&
    !sender.isDestroyed() &&
    event.sender === sender &&
    event.senderFrame === sender.mainFrame
  const close = (action?: string, restoreFocus = true): void => {
    if (!current) return
    const result: NativeActionMenuResult = { id: current.id, ...(action ? { action } : {}) }
    closedId = current.id
    current = undefined
    view?.setVisible(false)
    if (view && !view.webContents.isDestroyed())
      view.webContents.send('action-menu:hide', result.id)
    if (restoreFocus && !window.isDestroyed()) {
      if (previousFocus && !previousFocus.isDestroyed()) previousFocus.focus()
      else if (!host.isDestroyed()) host.focus()
    }
    previousFocus = undefined
    if (!host.isDestroyed()) host.send('action-menu:closed', result)
  }
  const open = (event: IpcMainEvent, request: unknown): void => {
    if (!trusted(event, host) || !isNativeActionMenuRequest(request) || request.id === closedId)
      return
    if (current && current.id !== request.id) {
      const focus = previousFocus
      close(undefined, false)
      previousFocus = focus
    }
    // A replacement preserves the original focus owner; late responses cannot act on the new menu.
    if (!current && !previousFocus) previousFocus = webContents.getFocusedWebContents() ?? host
    current = request
    if (!view) {
      view = new WebContentsView({
        webPreferences: {
          preload: paths.preload,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false
        }
      })
      view.setBackgroundColor('#00000000')
      view.setVisible(false)
      window.contentView.addChildView(view)
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      view.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && (input.meta || input.control)) {
          close()
          host.emit('before-input-event', event, input)
        }
      })
      view.webContents.on('will-navigate', (event) => event.preventDefault())
      view.webContents.on('render-process-gone', () => {
        close()
        dispose()
      })
      const load = paths.url
        ? view.webContents.loadURL(paths.url)
        : view.webContents.loadFile(paths.html)
      void load.catch(() => {
        close()
        dispose()
      })
    }
    publish()
  }
  const publish = (): void => {
    if (!rendererReady || !current || !view || view.webContents.isDestroyed()) return
    view.webContents.setZoomFactor(host.getZoomFactor())
    const { width, height } = window.getContentBounds()
    view.setBounds({ x: 0, y: 0, width, height })
    view.webContents.send('action-menu:show', current)
  }
  const mounted = (event: IpcMainEvent): void => {
    if (!trusted(event, view?.webContents)) return
    rendererReady = true
    publish()
  }

  const ready = (event: IpcMainEvent, id: unknown): void => {
    if (!trusted(event, view?.webContents) || !current || id !== current.id || !view) return
    // Re-adding an existing child raises it above every native webpage, regardless of creation order.
    window.contentView.addChildView(view)
    view.setVisible(true)
    view.webContents.focus()
  }
  const result = (event: IpcMainEvent, value: unknown): void => {
    if (!trusted(event, view?.webContents) || !current || !value || typeof value !== 'object')
      return
    const response = value as NativeActionMenuResult
    if (response.id !== current.id) return
    if (
      response.action !== undefined &&
      !current.entries.some(
        (entry) => entry.kind === 'action' && entry.action === response.action && !entry.disabled
      )
    )
      return
    close(response.action)
  }
  const dismiss = (event: IpcMainEvent, id: unknown): void => {
    if (trusted(event, host) && current?.id === id) close()
  }
  const onResize = (): void => {
    close()
  }
  const onBlur = (): void => {
    close(undefined, false)
  }
  const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
    if (details.isMainFrame && !details.isSameDocument) close(undefined, false)
  }
  const dispose = (): void => {
    if (!view) return
    if (!window.isDestroyed()) window.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false })
    view = undefined
    rendererReady = false
  }
  ipcMain.on('action-menu:open', open)
  ipcMain.on('action-menu:close', dismiss)
  ipcMain.on('action-menu:ready', ready)
  ipcMain.on('action-menu:mounted', mounted)
  ipcMain.on('action-menu:result', result)
  window.on('resize', onResize)
  window.on('blur', onBlur)
  host.on('did-start-navigation', onNavigation)
  return {
    destroy: () => {
      destroyed = true
      close(undefined, false)
      dispose()
      ipcMain.removeListener('action-menu:open', open)
      ipcMain.removeListener('action-menu:close', dismiss)
      ipcMain.removeListener('action-menu:ready', ready)
      ipcMain.removeListener('action-menu:mounted', mounted)
      ipcMain.removeListener('action-menu:result', result)
      window.removeListener('resize', onResize)
      window.removeListener('blur', onBlur)
      host.removeListener('did-start-navigation', onNavigation)
    }
  }
}
