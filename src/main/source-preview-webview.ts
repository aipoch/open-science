import { webFrameMain, type BrowserWindow, type WebContents, type WebPreferences } from 'electron'
import { isAllowedSourceDescendantNavigation } from './navigation-policy'
import {
  parseHttpsSourceUrl,
  SOURCE_PREVIEW_CONTEXT_MENU_CHANNEL,
  SOURCE_PREVIEW_NAVIGATION_BLOCKED_CHANNEL
} from '../shared/source-preview'

const activeSources = new WeakMap<object, WebContents>()
export const getActiveSourceContents = (owner: object): WebContents | undefined => {
  const contents = activeSources.get(owner)
  return contents && !contents.isDestroyed() ? contents : undefined
}

// The DOM owns guest lifetime. Main owns security and the focused source used by page find.
export const installSourcePreviewWebviews = (window: BrowserWindow): void => {
  const host = window.webContents
  const session = host.session
  const guests = new Set<WebContents>()
  const cleanups = new Map<WebContents, () => void>()
  const willAttach = (
    event: Electron.Event,
    preferences: WebPreferences,
    params: Record<string, string>
  ): void => {
    if (
      !parseHttpsSourceUrl(params.src ?? '') ||
      params.partition ||
      params.preload ||
      params.webpreferences ||
      params.allowpopups ||
      params.nodeintegration ||
      params.nodeintegrationinsubframes ||
      params.disablewebsecurity ||
      params.plugins ||
      params.blinkfeatures ||
      params.disableblinkfeatures ||
      preferences.enableBlinkFeatures ||
      preferences.disableBlinkFeatures ||
      preferences.preload
    ) {
      event.preventDefault()
      return
    }
    Object.assign(preferences, {
      session,
      sandbox: true,
      contextIsolation: true,
      webSecurity: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false
    })
    delete preferences.preload
  }
  const didAttach = (_event: Electron.Event, guest: WebContents): void => {
    if (guest.session !== session) {
      guest.close({ waitForBeforeUnload: false })
      return
    }
    guests.add(guest)
    const alive = (): boolean => guests.has(guest) && !guest.isDestroyed() && !host.isDestroyed()
    guest.setWindowOpenHandler(() => ({ action: 'deny' }))
    const blocked = (url: string): void => {
      if (alive()) host.send(SOURCE_PREVIEW_NAVIGATION_BLOCKED_CHANNEL, { guestId: guest.id, url })
    }
    const navigate = (
      event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>
    ): void => {
      if (
        !(event.isMainFrame
          ? parseHttpsSourceUrl(event.url)
          : isAllowedSourceDescendantNavigation(event.url))
      ) {
        event.preventDefault()
        if (event.isMainFrame) blocked(event.url)
      }
    }
    const redirect = (
      event: Electron.Event,
      url: string,
      _inPlace: boolean,
      isMainFrame: boolean
    ): void => {
      if (!(isMainFrame ? parseHttpsSourceUrl(url) : isAllowedSourceDescendantNavigation(url))) {
        event.preventDefault()
        if (isMainFrame) blocked(url)
      }
    }
    const focus = (): void => {
      if (alive()) activeSources.set(host, guest)
    }
    const input = (event: Electron.Event, value: Electron.Input): void => {
      if (alive() && !value.isComposing && value.key !== 'Process')
        host.emit('before-input-event', event, value)
    }
    const rememberContextTarget = (
      _event: Electron.Event,
      _url: string,
      _status: number,
      _statusText: string,
      _mainFrame: boolean,
      processId: number,
      routingId: number
    ): void => {
      const frame = webFrameMain.fromId(processId, routingId)
      if (!frame || !parseHttpsSourceUrl(frame.url)) return
      // Ordinary DOM bookkeeping only: no preload, IPC, or privileged API is exposed to the site.
      // OOPIF :hover can be empty even for a real right-click; capture the actual event target.
      void frame
        .executeJavaScript(
          `(() => {
        const key = '__openScienceSourceContextMenu';
        if (Object.hasOwn(window, key)) return;
        window[key] = null;
        window.addEventListener('contextmenu', (event) => {
          if (!event.isTrusted) return;
          window[key] = event.composedPath().some(target =>
            target instanceof Element && target.closest('[data-preview-context-menu-passthrough]')
          );
        }, true);
      })()`
        )
        .catch(() => {
          /* The document may have navigated or detached. */
        })
    }
    let menuGeneration = 0
    const contextMenu = async (
      _event: Electron.Event,
      params: Electron.ContextMenuParams
    ): Promise<void> => {
      const generation = ++menuGeneration
      const frame = params.frame
      if (
        !alive() ||
        params.isEditable ||
        params.formControlType !== 'none' ||
        !frame ||
        frame.isDestroyed()
      )
        return
      const frameUrl = frame.url
      if (!parseHttpsSourceUrl(frameUrl)) return
      try {
        // Consume the clicked frame's snapshot, never a later frame with the same URL.
        const passthrough = await frame.executeJavaScript(`(() => {
          const value = window.__openScienceSourceContextMenu;
          window.__openScienceSourceContextMenu = null;
          return value;
        })()`)
        if (
          passthrough !== false ||
          generation !== menuGeneration ||
          !alive() ||
          frame.isDestroyed() ||
          frame.detached ||
          frame.url !== frameUrl
        )
          return
        const zoom = host.getZoomFactor()
        host.send(SOURCE_PREVIEW_CONTEXT_MENU_CHANNEL, {
          guestId: guest.id,
          x: params.x / zoom,
          y: params.y / zoom
        })
      } catch {
        // A destroyed/navigated frame cannot open an application menu.
      }
    }
    const cleanup = (): void => {
      guests.delete(guest)
      cleanups.delete(guest)
      if (activeSources.get(host) === guest) activeSources.delete(host)
      guest.removeListener('will-frame-navigate', navigate)
      guest.removeListener('will-redirect', redirect)
      guest.removeListener('focus', focus)
      guest.removeListener('before-input-event', input)
      guest.removeListener('context-menu', contextMenu)
      guest.removeListener('did-frame-navigate', rememberContextTarget)
      guest.removeListener('destroyed', cleanup)
    }
    cleanups.set(guest, cleanup)
    guest.on('will-frame-navigate', navigate)
    guest.on('will-redirect', redirect)
    guest.on('focus', focus)
    guest.on('before-input-event', input)
    guest.on('context-menu', contextMenu)
    guest.on('did-frame-navigate', rememberContextTarget)
    guest.once('destroyed', cleanup)
  }
  const download = (
    event: Electron.Event,
    _item: Electron.DownloadItem,
    guest: WebContents
  ): void => {
    if (guests.has(guest)) event.preventDefault()
  }
  const hostFocus = (): void => {
    activeSources.delete(host)
  }
  host.on('will-attach-webview', willAttach)
  host.on('did-attach-webview', didAttach)
  host.on('focus', hostFocus)
  session.on('will-download', download)
  window.on('closed', () => {
    for (const cleanup of cleanups.values()) cleanup()
    activeSources.delete(host)
    host.removeListener('will-attach-webview', willAttach)
    host.removeListener('did-attach-webview', didAttach)
    host.removeListener('focus', hostFocus)
    session.removeListener('will-download', download)
  })
}
