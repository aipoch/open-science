import { isAllowedSourceDescendantNavigation } from './navigation-policy'
import {
  ipcMain,
  WebContentsView,
  type BrowserWindow,
  type IpcMainEvent,
  type WebContents
} from 'electron'
import {
  SOURCE_PREVIEW_LOAD_STATE_CHANNEL,
  SOURCE_PREVIEW_RELEASE_CHANNEL,
  SOURCE_PREVIEW_UPDATE_VIEW_CHANNEL,
  parseHttpsSourceUrl,
  type SourcePreviewLoadState,
  type SourcePreviewViewUpdate
} from '../shared/source-preview'

// The remote top-level document has its own origin and no application preload. Keeping the default
// Session preserves normal Chromium cookies/cache; third-party cookie exceptions are unnecessary.
const activeSources = new WeakMap<object, WebContents>()
export const getActiveSourceContents = (owner: object): WebContents | undefined => {
  const contents = activeSources.get(owner)
  return contents && !contents.isDestroyed() ? contents : undefined
}

const isUpdate = (value: unknown): value is SourcePreviewViewUpdate => {
  if (!value || typeof value !== 'object') return false
  const request = value as SourcePreviewViewUpdate
  return (
    typeof request.instanceId === 'string' &&
    request.instanceId.length > 0 &&
    request.instanceId.length < 128 &&
    typeof request.sourceUrl === 'string' &&
    !!parseHttpsSourceUrl(request.sourceUrl) &&
    Number.isSafeInteger(request.attempt) &&
    request.attempt >= 0 &&
    (request.bounds === null ||
      (!!request.bounds &&
        (['x', 'y', 'width', 'height'] as const).every((key) =>
          Number.isFinite(request.bounds?.[key])
        ) &&
        request.bounds.width > 0 &&
        request.bounds.height > 0))
  )
}

export const createSourcePreviewViews = (
  window: BrowserWindow,
  createView = (options: Electron.WebContentsViewConstructorOptions) => new WebContentsView(options)
): { destroy: () => void } => {
  const host = window.webContents
  const session = host.session
  const entries = new Map<
    string,
    { view: WebContentsView; sourceUrl: string; attempt: number; navigationId: number }
  >()
  const released = new Set<string>()
  let navigationId = 0
  let destroyed = false
  const trusted = (event: IpcMainEvent): boolean =>
    !destroyed &&
    !host.isDestroyed() &&
    event.sender === host &&
    event.senderFrame === host.mainFrame
  const close = (id: string): void => {
    const entry = entries.get(id)
    if (!entry) return
    entries.delete(id)
    if (activeSources.get(host) === entry.view.webContents) activeSources.delete(host)
    if (!window.isDestroyed()) window.contentView.removeChildView(entry.view)
    // Remote beforeunload cannot retain a closed tab or the application's privileged owner.
    if (!entry.view.webContents.isDestroyed())
      entry.view.webContents.close({ waitForBeforeUnload: false })
  }
  const clear = (): void => {
    for (const id of entries.keys()) {
      released.add(id)
      close(id)
    }
  }
  const update = (event: IpcMainEvent, value: unknown): void => {
    if (!trusted(event) || !isUpdate(value) || released.has(value.instanceId)) return
    const { instanceId, attempt } = value
    const sourceUrl = parseHttpsSourceUrl(value.sourceUrl)!.href
    let entry = entries.get(instanceId)
    if (entry && (entry.sourceUrl !== sourceUrl || entry.attempt > attempt)) return
    if (entry && entry.attempt < attempt) {
      close(instanceId)
      entry = undefined
    }
    if (!entry) {
      const view = createView({
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true
        }
      })
      const contents = view.webContents
      const current = { view, sourceUrl, attempt, navigationId: ++navigationId }
      entry = current
      entries.set(instanceId, current)
      view.setVisible(false)
      // Insert underneath the separately owned find overlay, regardless of creation order.
      window.contentView.addChildView(view, 0)
      const alive = (): boolean =>
        entries.get(instanceId) === current && !host.isDestroyed() && !contents.isDestroyed()
      let lastState: SourcePreviewLoadState | undefined
      const publish = (state: SourcePreviewLoadState): void => {
        if (!alive()) return
        lastState = state
        if (state.phase !== 'loaded') view.setVisible(false)
        host.send(SOURCE_PREVIEW_LOAD_STATE_CHANNEL, { ...state, instanceId })
      }
      const base = (): { navigationId: number; sourceUrl: string; currentUrl: string } => ({
        navigationId: current.navigationId,
        sourceUrl,
        currentUrl: contents.getURL() || sourceUrl
      })
      const fail = (
        failure: 'blocked' | 'certificate' | 'network',
        errorCode?: number,
        errorDescription?: string
      ): void => {
        if (!alive()) return
        view.setVisible(false)
        publish({ ...base(), phase: 'failed', failure, errorCode, errorDescription })
      }
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
      contents.on('will-frame-navigate', (event) => {
        if (
          !(event.isMainFrame
            ? parseHttpsSourceUrl(event.url)
            : isAllowedSourceDescendantNavigation(event.url))
        ) {
          event.preventDefault()
          if (event.isMainFrame) fail('blocked')
        }
      })
      contents.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
        if (!(isMainFrame ? parseHttpsSourceUrl(url) : isAllowedSourceDescendantNavigation(url))) {
          event.preventDefault()
          if (isMainFrame) fail('blocked')
        }
      })
      contents.on('did-start-navigation', (details) => {
        if (!details.isMainFrame || details.isSameDocument || !alive()) return
        current.navigationId = ++navigationId
        view.setVisible(false)
        publish({ ...base(), currentUrl: details.url, phase: 'loading' })
      })
      contents.on('did-navigate', (_event, url, status, text) => {
        if (!alive()) return
        publish(
          status >= 400
            ? {
                ...base(),
                currentUrl: url,
                phase: 'failed',
                failure: 'http',
                httpStatusCode: status,
                httpStatusText: text
              }
            : {
                ...base(),
                currentUrl: url,
                phase: 'loaded',
                httpStatusCode: status,
                httpStatusText: text
              }
        )
      })
      contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
        // A hash/history change cannot turn an HTTP failure into a successful document.
        if (isMainFrame && alive() && lastState) publish({ ...lastState, currentUrl: url })
      })
      contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3)
          fail(code <= -200 && code > -300 ? 'certificate' : 'network', code, description)
      })
      contents.on('render-process-gone', () =>
        fail('network', undefined, 'Renderer process exited')
      )
      contents.on('before-input-event', (event, input) => {
        if (alive()) host.emit('before-input-event', event, input)
      })
      contents.on('focus', () => {
        if (alive()) activeSources.set(host, contents)
      })
      publish({ ...base(), phase: 'loading' })
      // did-fail-load supplies actionable failure details; handle the duplicate rejected promise.
      void contents.loadURL(sourceUrl).catch(() => undefined)
    }
    const { view } = entry
    const bounds = value.bounds
    if (!bounds) {
      view.setVisible(false)
      if (activeSources.get(host) === view.webContents) activeSources.delete(host)
      return
    }
    const zoom = host.getZoomFactor()
    const area = window.getContentBounds()
    const x = Math.max(0, Math.round(bounds.x * zoom))
    const y = Math.max(0, Math.round(bounds.y * zoom))
    const width = Math.max(
      0,
      Math.min(area.width, Math.round((bounds.x + bounds.width) * zoom)) - x
    )
    const height = Math.max(
      0,
      Math.min(area.height, Math.round((bounds.y + bounds.height) * zoom)) - y
    )
    view.setBounds({ x, y, width, height })
    view.webContents.setZoomFactor(zoom)
    view.setVisible(width > 0 && height > 0)
  }
  const release = (event: IpcMainEvent, sourceUrl: unknown, instanceId: unknown): void => {
    if (
      !trusted(event) ||
      typeof instanceId !== 'string' ||
      entries.get(instanceId)?.sourceUrl !== sourceUrl
    )
      return
    released.add(instanceId)
    close(instanceId)
  }
  // The iframe sandbox previously prevented downloads. Preserve that boundary for remote pages
  // without changing downloads owned by other WebContents sharing this Session.
  const onDownload = (
    event: Electron.Event,
    _item: Electron.DownloadItem,
    contents: WebContents
  ): void => {
    if ([...entries.values()].some((entry) => entry.view.webContents === contents))
      event.preventDefault()
  }
  const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
    if (details.isMainFrame && !details.isSameDocument) {
      clear()
      released.clear()
    }
  }
  const onHostFocus = (): void => {
    activeSources.delete(host)
  }
  const destroy = (): void => {
    if (destroyed) return
    destroyed = true
    clear()
    ipcMain.removeListener(SOURCE_PREVIEW_UPDATE_VIEW_CHANNEL, update)
    ipcMain.removeListener(SOURCE_PREVIEW_RELEASE_CHANNEL, release)
    host.removeListener('did-start-navigation', onNavigation)
    host.removeListener('render-process-gone', clear)
    host.removeListener('focus', onHostFocus)
    window.removeListener('closed', destroy)
    session.removeListener('will-download', onDownload)
  }
  ipcMain.on(SOURCE_PREVIEW_UPDATE_VIEW_CHANNEL, update)
  ipcMain.on(SOURCE_PREVIEW_RELEASE_CHANNEL, release)
  host.on('did-start-navigation', onNavigation)
  host.on('render-process-gone', clear)
  host.on('focus', onHostFocus)
  window.on('closed', destroy)
  session.on('will-download', onDownload)
  return { destroy }
}
