import { getActiveSourceContents } from './source-preview-webview'
import { BrowserWindow, ipcMain, type IpcMainEvent, type WebContents } from 'electron'

import { resolveFindOverlayOwner } from './find-overlay-registry'
import {
  WINDOW_FIND_CLEAR_CHANNEL,
  WINDOW_FIND_CLOSE_CHANNEL,
  WINDOW_FIND_REQUEST_CHANNEL,
  WINDOW_FIND_RESULT_CHANNEL,
  type WindowFindRequest,
  type WindowFindResult
} from '../shared/window-controls'

// The main renderer or its focused source guest gets searched and emits found-in-page. It needs no
// send(): results are delivered to the OVERLAY that issued the request, not echoed to the main window.
type FindTargetWebContents = {
  isDestroyed?: () => boolean
  focus?: () => void
  findInPage: (
    text: string,
    options: { findNext: boolean; forward: boolean; matchCase: boolean }
  ) => number
  stopFindInPage: (action: 'clearSelection') => void
  on: (
    event: 'found-in-page',
    listener: (event: unknown, result: WindowFindResult & { requestId: number }) => void
  ) => void
  once: (event: 'destroyed', listener: () => void) => void
  removeListener: {
    (event: 'found-in-page', listener: (event: unknown, result: WindowFindResult) => void): void
    (event: 'destroyed', listener: () => void): void
  }
}
type FindWindow = { webContents: FindTargetWebContents }

// The OVERLAY webContents issues requests and receives results. It is a separate WebContents (a
// WebContentsView) so its own query text is never part of the main window's search.
type OverlayWebContents = { send: (channel: string, payload: WindowFindResult) => void }

type WindowFindIpcDeps = {
  // Maps the overlay that issued a request to the MAIN window whose content should be searched.
  // Defaults to BrowserWindow.fromWebContents, which resolves the owning BrowserWindow of a child
  // WebContentsView to its parent.
  resolveMainWindow?: (sender: WebContents) => FindWindow | null
  resolveSearchTarget?: (window: FindWindow) => FindTargetWebContents
}

const isWindowFindRequest = (value: unknown): value is WindowFindRequest => {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<WindowFindRequest>
  return (
    typeof request.text === 'string' &&
    typeof request.findNext === 'boolean' &&
    typeof request.forward === 'boolean'
  )
}

// Registers native page-find for the overlay->main-window flow. The overlay owns the query UI; main
// searches its own webContents and forwards each result back to the overlay that asked. The active
// request is tracked per searched webContents so an asynchronous result from an earlier query cannot
// overwrite the overlay's current count.
const registerWindowFindIpcHandlers = (deps: WindowFindIpcDeps = {}): (() => void) => {
  // Prefer the overlay->main registry (recorded when the overlay view was created); fall back to
  // fromWebContents for any non-overlay sender.
  const resolveMainWindow =
    deps.resolveMainWindow ??
    ((sender) =>
      (resolveFindOverlayOwner(sender)?.mainWindow as FindWindow | null) ??
      BrowserWindow.fromWebContents(sender))
  const resolveTarget = (sender: WebContents): FindTargetWebContents | undefined => {
    const owner = resolveMainWindow(sender)
    return (
      (owner &&
        (deps.resolveSearchTarget?.(owner) ??
          getActiveSourceContents(owner.webContents) ??
          owner.webContents)) ||
      undefined
    )
  }
  const searchedTargets = new WeakMap<OverlayWebContents, FindTargetWebContents>()
  const activeRequests = new WeakMap<
    FindTargetWebContents,
    { nativeRequestId: number; rendererRequestId: number; replyTo: OverlayWebContents }
  >()
  const listening = new Map<FindTargetWebContents, () => void>()

  const installResultListener = (webContents: FindTargetWebContents): void => {
    if (listening.has(webContents)) return
    const onResult = (_event: unknown, result: WindowFindResult): void => {
      const activeRequest = activeRequests.get(webContents)
      if (!activeRequest || activeRequest.nativeRequestId !== result.requestId) return
      const update: WindowFindResult = {
        requestId: activeRequest.rendererRequestId,
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
        finalUpdate: result.finalUpdate
      }
      activeRequest.replyTo.send(WINDOW_FIND_RESULT_CHANNEL, update)
    }
    const cleanup = (): void => {
      activeRequests.delete(webContents)
      listening.delete(webContents)
      webContents.removeListener('found-in-page', onResult)
      webContents.removeListener('destroyed', cleanup)
    }
    listening.set(webContents, cleanup)
    webContents.on('found-in-page', onResult)
    webContents.once('destroyed', cleanup)
  }

  const onRequest = (event: IpcMainEvent, request: unknown): void => {
    if (!isWindowFindRequest(request) || request.text.length === 0) return
    const webContents = resolveTarget(event.sender)
    if (!webContents) return

    const previous = searchedTargets.get(event.sender)
    if (previous && previous !== webContents) {
      activeRequests.delete(previous)
      if (listening.has(previous)) previous.stopFindInPage('clearSelection')
    }
    searchedTargets.set(event.sender, webContents)
    const owner = resolveFindOverlayOwner(event.sender)
    if (owner) {
      owner.clearSearch = () => onClear(event)
      owner.focusSource = () => {
        if (webContents.isDestroyed?.()) return false
        if (resolveTarget(event.sender) !== webContents) return false
        webContents.focus?.()
        return true
      }
    }
    installResultListener(webContents)
    activeRequests.set(webContents, {
      nativeRequestId: webContents.findInPage(request.text, {
        findNext: request.findNext,
        forward: request.forward,
        matchCase: false
      }),
      rendererRequestId: request.requestId,
      replyTo: event.sender
    })
  }

  const onClear = (event: IpcMainEvent): void => {
    const webContents = searchedTargets.get(event.sender) ?? resolveTarget(event.sender)
    if (!webContents) return
    activeRequests.delete(webContents)
    if (!webContents.isDestroyed?.()) webContents.stopFindInPage('clearSelection')
    searchedTargets.delete(event.sender)
    const owner = resolveFindOverlayOwner(event.sender)
    if (owner) owner.clearSearch = undefined
  }

  // The overlay asked to close (X button or its own Escape). Invoke the owner's close handle, which
  // hides the overlay view, clears the main selection, and refocuses the main window.
  const onClose = (event: IpcMainEvent): void => {
    onClear(event)
    resolveFindOverlayOwner(event.sender)?.closeOverlay()
  }

  const cleanup = (): void => {
    ipcMain.removeListener(WINDOW_FIND_REQUEST_CHANNEL, onRequest)
    ipcMain.removeListener(WINDOW_FIND_CLEAR_CHANNEL, onClear)
    ipcMain.removeListener(WINDOW_FIND_CLOSE_CHANNEL, onClose)
    for (const stopListening of listening.values()) stopListening()
  }
  try {
    ipcMain.on(WINDOW_FIND_REQUEST_CHANNEL, onRequest)
    ipcMain.on(WINDOW_FIND_CLEAR_CHANNEL, onClear)
    ipcMain.on(WINDOW_FIND_CLOSE_CHANNEL, onClose)
    return cleanup
  } catch (error) {
    cleanup()
    throw error
  }
}

export { registerWindowFindIpcHandlers }
export type { WindowFindIpcDeps }
