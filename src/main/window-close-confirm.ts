import { BrowserWindow, dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'

import type { ActiveSessionInfo } from '../shared/storage'
import {
  WINDOW_CLOSE_CONFIRM_REQUEST,
  WINDOW_CLOSE_CONFIRM_RESPONSE,
  type CloseConfirmChoice,
  type CloseConfirmRequest,
  type CloseConfirmResponse,
  type CloseConfirmVariant
} from '../shared/window-controls'

// Structural (Electron-free) plumbing so the coordinator is unit-testable. The Electron glue that
// satisfies this lives in createElectronCloseConfirm (added in a later task).
export type CloseConfirmDeps = {
  // Send the request to the renderer (webContents.send).
  send: (payload: CloseConfirmRequest) => void
  // Subscribe to renderer responses for the lifetime of one confirm; returns an unsubscribe.
  onResponse: (cb: (payload: CloseConfirmResponse) => void) => () => void
  // Whether a live renderer exists to receive the request (window + webContents present, not gone).
  isRendererAvailable: () => boolean
  // Subscribe to render-process-gone for the confirm window; returns an unsubscribe.
  onRenderGone: (cb: () => void) => () => void
  // Native fallback when the renderer can't answer: a message box for close-to-tray, or 'quit' for
  // the quit variant (a dead UI must never block quit).
  nativeFallback: (variant: CloseConfirmVariant) => Promise<CloseConfirmChoice>
  newRequestId: () => string
  // Grace period for the modal-mounted ack before falling back. Defaults to 500ms.
  ackTimeoutMs?: number
}

const DEFAULT_ACK_TIMEOUT_MS = 500

// Coordinates a close/quit confirmation. Main computes `sessions`, so the quit variant with an empty
// list resolves without any IPC; otherwise the renderer renders the modal and replies the choice,
// with a native/proceed fallback if it can't.
export const createCloseConfirm = (
  deps: CloseConfirmDeps
): ((
  variant: CloseConfirmVariant,
  sessions: ActiveSessionInfo[]
) => Promise<CloseConfirmChoice>) => {
  const ackTimeoutMs = deps.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS

  return (variant, sessions) => {
    if (variant === 'quit' && sessions.length === 0) return Promise.resolve('quit')
    if (!deps.isRendererAvailable()) return deps.nativeFallback(variant)

    const requestId = deps.newRequestId()

    return new Promise<CloseConfirmChoice>((resolve) => {
      let settled = false
      let acked = false
      let fallbackStarted = false

      const finish = (choice: CloseConfirmChoice): void => {
        if (settled) return
        settled = true
        clearTimeout(ackTimer)
        offResponse()
        offGone()
        resolve(choice)
      }

      const startFallback = (): void => {
        if (fallbackStarted) return
        fallbackStarted = true
        clearTimeout(ackTimer)
        void deps.nativeFallback(variant).then(finish)
      }

      const offResponse = deps.onResponse((payload) => {
        if (payload.requestId !== requestId) return
        if (payload.ack) {
          acked = true
          clearTimeout(ackTimer)
          return
        }
        if (payload.choice) finish(payload.choice)
      })

      const offGone = deps.onRenderGone(startFallback)

      const ackTimer = setTimeout(() => {
        if (!acked) startFallback()
      }, ackTimeoutMs)

      deps.send({ requestId, variant, sessions })
    })
  }
}

// Native fallback when the renderer can't render the modal. close-to-tray shows an OS message box;
// quit proceeds (returns 'quit') because a dead/gone UI must not be able to block quit.
const nativeFallback = async (
  getWindow: () => BrowserWindow | undefined,
  variant: CloseConfirmVariant
): Promise<CloseConfirmChoice> => {
  if (variant === 'quit') return 'quit'
  const window = getWindow()
  const options = {
    type: 'question' as const,
    buttons: ['Minimize to tray', 'Quit'],
    defaultId: 0,
    cancelId: 0,
    title: 'Open Science',
    message: 'Minimize to tray or quit?',
    detail: 'Background work may still be running.'
  }
  const { response } = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options)
  return response === 1 ? 'quit' : 'minimize'
}

// Wires createCloseConfirm to Electron IPC + the current main window (via getWindow, since the window
// can be recreated). Response listeners are per-confirm and removed when it settles.
export const createElectronCloseConfirm = (
  getWindow: () => BrowserWindow | undefined
): ((variant: CloseConfirmVariant, sessions: ActiveSessionInfo[]) => Promise<CloseConfirmChoice>) =>
  createCloseConfirm({
    send: (payload) => getWindow()?.webContents.send(WINDOW_CLOSE_CONFIRM_REQUEST, payload),
    onResponse: (cb) => {
      const listener = (_event: unknown, payload: CloseConfirmResponse): void => cb(payload)
      ipcMain.on(WINDOW_CLOSE_CONFIRM_RESPONSE, listener)
      return () => ipcMain.removeListener(WINDOW_CLOSE_CONFIRM_RESPONSE, listener)
    },
    isRendererAvailable: () => {
      const window = getWindow()
      return Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed())
    },
    onRenderGone: (cb) => {
      const window = getWindow()
      if (!window) return () => undefined
      window.webContents.on('render-process-gone', cb)
      return () => window.webContents.off('render-process-gone', cb)
    },
    nativeFallback: (variant) => nativeFallback(getWindow, variant),
    newRequestId: () => randomUUID()
  })
