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

// The MAIN window's webContents is what actually gets searched and emits found-in-page. It needs no
// send(): results are delivered to the OVERLAY that issued the request, not echoed to the main window.
type FindTargetWebContents = {
  findInPage: (
    text: string,
    options: { findNext: boolean; forward: boolean; matchCase: boolean }
  ) => number
  stopFindInPage: (action: 'clearSelection') => void
  on: (
    event: 'found-in-page',
    listener: (event: unknown, result: WindowFindResult & { requestId: number }) => void
  ) => void
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
const registerWindowFindIpcHandlers = (deps: WindowFindIpcDeps = {}): void => {
  // Prefer the overlay->main registry (recorded when the overlay view was created); fall back to
  // fromWebContents for any non-overlay sender.
  const resolveMainWindow =
    deps.resolveMainWindow ??
    ((sender) =>
      (resolveFindOverlayOwner(sender)?.mainWindow as FindWindow | null) ??
      BrowserWindow.fromWebContents(sender))
  const activeRequests = new WeakMap<
    FindTargetWebContents,
    { nativeRequestId: number; rendererRequestId: number; replyTo: OverlayWebContents }
  >()
  const listening = new WeakSet<FindTargetWebContents>()

  const installResultListener = (webContents: FindTargetWebContents): void => {
    if (listening.has(webContents)) return
    listening.add(webContents)
    webContents.on('found-in-page', (_event, result) => {
      const activeRequest = activeRequests.get(webContents)
      if (!activeRequest || activeRequest.nativeRequestId !== result.requestId) return
      const update: WindowFindResult = {
        requestId: activeRequest.rendererRequestId,
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
        finalUpdate: result.finalUpdate
      }
      activeRequest.replyTo.send(WINDOW_FIND_RESULT_CHANNEL, update)
    })
  }

  ipcMain.on(WINDOW_FIND_REQUEST_CHANNEL, (event: IpcMainEvent, request: unknown): void => {
    if (!isWindowFindRequest(request) || request.text.length === 0) return
    const webContents = resolveMainWindow(event.sender)?.webContents
    if (!webContents) return

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
  })

  ipcMain.on(WINDOW_FIND_CLEAR_CHANNEL, (event: IpcMainEvent): void => {
    const webContents = resolveMainWindow(event.sender)?.webContents
    if (!webContents) return
    activeRequests.delete(webContents)
    webContents.stopFindInPage('clearSelection')
  })

  // The overlay asked to close (X button or its own Escape). Invoke the owner's close handle, which
  // hides the overlay view, clears the main selection, and refocuses the main window.
  ipcMain.on(WINDOW_FIND_CLOSE_CHANNEL, (event: IpcMainEvent): void => {
    resolveFindOverlayOwner(event.sender)?.closeOverlay()
  })
}

export { registerWindowFindIpcHandlers }
export type { WindowFindIpcDeps }
