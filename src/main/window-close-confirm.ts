import { BrowserWindow, dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'

import type { ActiveSessionInfo } from '../shared/storage'
import {
  WINDOW_CLOSE_CONFIRM_REQUEST_CHANNEL,
  WINDOW_CLOSE_CONFIRM_RESPONSE_CHANNEL,
  type CloseConfirmChoice,
  type CloseConfirmRequest,
  type CloseConfirmResponse,
  type CloseConfirmVariant
} from '../shared/window-controls'

// Structural (Electron-free) plumbing so the coordinator is unit-testable; the Electron glue that
// satisfies this is createElectronCloseConfirm below.
export type CloseConfirmDeps = {
  // Send the request to the renderer (webContents.send).
  send: (payload: CloseConfirmRequest) => void
  // Subscribe to renderer responses for the lifetime of one confirm; returns an unsubscribe.
  onResponse: (cb: (payload: CloseConfirmResponse) => void) => () => void
  // Whether a live renderer exists to receive the request (window + webContents present, not gone).
  isRendererAvailable: () => boolean
  // Subscribe to render-process-gone for the confirm window; returns an unsubscribe.
  onRenderGone: (cb: () => void) => () => void
  // Native fallback when the renderer can't answer (dead/hung, or no window at all). May reject;
  // the coordinator wraps it so a rejection never leaves the confirm unsettled.
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

    // Never let a fallback rejection leave the confirm unsettled: a stranded promise would pin the
    // caller's in-flight guard forever and permanently block quit. On failure, keep the app resident
    // for close-to-tray and proceed for quit.
    const safeFallback = (): Promise<CloseConfirmChoice> =>
      deps.nativeFallback(variant).catch(() => (variant === 'quit' ? 'quit' : 'minimize'))

    if (!deps.isRendererAvailable()) return safeFallback()

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
        void safeFallback().then(finish)
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

// Native fallback when the renderer can't render the modal (dead/hung, or no window — e.g. macOS
// after the window was closed but the app stays resident). The coordinator only reaches this with
// work running (an empty quit list fast-paths to 'quit'), so both variants still ASK: quit offers
// Quit/Cancel, close-to-tray offers Minimize/Quit. A destroyed window can't parent a dialog, so fall
// back to a windowless one.
const nativeFallback = async (
  getWindow: () => BrowserWindow | undefined,
  variant: CloseConfirmVariant
): Promise<CloseConfirmChoice> => {
  const options =
    variant === 'quit'
      ? {
          type: 'question' as const,
          buttons: ['Cancel', 'Quit'],
          defaultId: 0,
          cancelId: 0,
          title: 'Open Science',
          message: 'Quit Open Science?',
          detail: 'Work is still running and will be interrupted if you quit.'
        }
      : {
          type: 'question' as const,
          buttons: ['Minimize to tray', 'Quit'],
          defaultId: 0,
          cancelId: 0,
          title: 'Open Science',
          message: 'Minimize to tray or quit?',
          detail: 'Background work may still be running.'
        }
  const window = getWindow()
  const { response } =
    window && !window.isDestroyed()
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options)
  if (variant === 'quit') return response === 1 ? 'quit' : 'cancel'
  return response === 1 ? 'quit' : 'minimize'
}

// Wires createCloseConfirm to Electron IPC + the current main window (via getWindow, since the window
// can be recreated). Response listeners are per-confirm and removed when it settles.
export const createElectronCloseConfirm = (
  getWindow: () => BrowserWindow | undefined
): ((variant: CloseConfirmVariant, sessions: ActiveSessionInfo[]) => Promise<CloseConfirmChoice>) =>
  createCloseConfirm({
    // Reveal the window before asking: a tray/Ctrl+Q quit can arrive while the window is hidden
    // (minimized to tray), and a modal sent to a hidden window would never be seen — leaving the
    // confirm (and thus the quit) stuck. Restoring/showing/focusing guarantees the modal is visible.
    send: (payload) => {
      const window = getWindow()
      if (!window || window.isDestroyed()) return
      if (window.isMinimized()) window.restore()
      if (!window.isVisible()) window.show()
      window.focus()
      window.webContents.send(WINDOW_CLOSE_CONFIRM_REQUEST_CHANNEL, payload)
    },
    onResponse: (cb) => {
      const listener = (_event: unknown, payload: CloseConfirmResponse): void => cb(payload)
      ipcMain.on(WINDOW_CLOSE_CONFIRM_RESPONSE_CHANNEL, listener)
      return () => ipcMain.removeListener(WINDOW_CLOSE_CONFIRM_RESPONSE_CHANNEL, listener)
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
