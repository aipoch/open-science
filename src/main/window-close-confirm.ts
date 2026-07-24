import { BrowserWindow, dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'

import type { ActiveSessionInfo } from '../shared/storage'
import {
  WINDOW_CLOSE_CONFIRM_REQUEST_CHANNEL,
  WINDOW_CLOSE_CONFIRM_RESPONSE_CHANNEL,
  type CloseActionPreference,
  type CloseConfirmChoice,
  type CloseConfirmRequest,
  type CloseConfirmResponse,
  type CloseConfirmVariant
} from '../shared/window-controls'

export type NativeCloseConfirmResult = {
  choice: CloseConfirmChoice
  remember?: boolean
}

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
  // Subscribe to the confirm window's paired 'unresponsive'/'responsive' events; returns an
  // unsubscribe. Lets the coordinator fall back only on a SUSTAINED hang (renderer alive but wedged,
  // so render-process-gone never fires), never on a slow-but-alive renderer. Optional: absent in
  // tests that don't exercise the hang path.
  onRendererUnresponsive?: (cbs: { onHang: () => void; onRecover: () => void }) => () => void
  // Native fallback when the renderer can't answer (dead/hung, or no window at all). May reject;
  // the coordinator wraps it so a rejection never leaves the confirm unsettled.
  nativeFallback: (variant: CloseConfirmVariant) => Promise<NativeCloseConfirmResult>
  // Read/write the saved Windows titlebar-close behavior. Persistence failures fall back to asking.
  getClosePreference: () => Promise<CloseActionPreference | undefined>
  setClosePreference: (preference: CloseActionPreference) => Promise<void>
  newRequestId: () => string
  // Grace period for the modal-mounted ack before falling back. Defaults to 500ms.
  ackTimeoutMs?: number
  // Grace period after an ACKed modal goes 'unresponsive' before falling back. Defaults to 10s so a
  // brief hang the renderer recovers from doesn't yank the modal out from under the user.
  hangGraceMs?: number
}

export type ClosePreferenceAccess = {
  get: () => Promise<CloseActionPreference | undefined>
  set: (preference: CloseActionPreference) => Promise<void>
}

const DEFAULT_ACK_TIMEOUT_MS = 500
const DEFAULT_HANG_GRACE_MS = 10_000

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
  const hangGraceMs = deps.hangGraceMs ?? DEFAULT_HANG_GRACE_MS

  return async (variant, sessions) => {
    if (variant === 'quit' && sessions.length === 0) return 'quit'

    if (variant === 'close-to-tray') {
      const preference = await deps.getClosePreference().catch(() => undefined)
      if (preference) return preference
    }

    const persistPreference = async (
      choice: CloseConfirmChoice,
      remember = false
    ): Promise<void> => {
      if (variant === 'close-to-tray' && remember && (choice === 'minimize' || choice === 'quit')) {
        await deps.setClosePreference(choice).catch(() => undefined)
      }
    }

    // Never let a fallback rejection leave the confirm unsettled: a stranded promise would pin the
    // caller's in-flight guard forever and permanently block quit. On failure, keep the app resident
    // for close-to-tray and proceed for quit.
    const safeFallback = async (): Promise<CloseConfirmChoice> => {
      try {
        const result = await deps.nativeFallback(variant)
        await persistPreference(result.choice, result.remember)
        return result.choice
      } catch {
        return variant === 'quit' ? 'quit' : 'minimize'
      }
    }

    if (!deps.isRendererAvailable()) return safeFallback()

    const requestId = deps.newRequestId()

    return new Promise<CloseConfirmChoice>((resolve) => {
      let settled = false
      let acked = false
      let fallbackStarted = false
      let hangTimer: ReturnType<typeof setTimeout> | undefined

      const finish = (choice: CloseConfirmChoice, remember = false): void => {
        if (settled) return
        settled = true
        clearTimeout(ackTimer)
        clearTimeout(hangTimer)
        offResponse()
        offGone()
        offHang?.()
        void persistPreference(choice, remember).then(() => resolve(choice))
      }

      // Known limitation (cosmetic): when a fallback settles the confirm, a modal the renderer had
      // already shown (ack path) stays on screen. A late click on it is dropped — the response
      // listener is removed and `settled` guards it — so it merely closes locally with no effect.
      // Fully dismissing it would need a main->renderer dismiss message; not worth the protocol
      // surface for a rare hang/timeout case.
      const startFallback = (): void => {
        if (fallbackStarted) return
        fallbackStarted = true
        clearTimeout(ackTimer)
        clearTimeout(hangTimer)
        void safeFallback().then(finish)
      }

      const offResponse = deps.onResponse((payload) => {
        if (payload.requestId !== requestId) return
        if (payload.ack) {
          acked = true
          clearTimeout(ackTimer)
          return
        }
        if (payload.choice) finish(payload.choice, payload.remember)
      })

      const offGone = deps.onRenderGone(startFallback)

      // A sustained hang AFTER ack: the pre-ack window is already covered by ackTimer, and the modal
      // legitimately waits on the user, so only arm the grace timer once the renderer actually reports
      // 'unresponsive'; a paired 'responsive' cancels it. This chain is deliberately separate from
      // onRenderGone: a crash/reload never emits 'responsive' (recovery is same-process only), so a
      // reloaded renderer is covered by render-process-gone -> startFallback, not by this timer.
      const offHang = deps.onRendererUnresponsive?.({
        onHang: () => {
          if (!acked || settled) return
          hangTimer = setTimeout(startFallback, hangGraceMs)
        },
        onRecover: () => clearTimeout(hangTimer)
      })

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
): Promise<NativeCloseConfirmResult> => {
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
          detail: 'Background work may still be running.',
          checkboxLabel: "Don't ask again",
          checkboxChecked: true
        }
  const window = getWindow()
  const { response, checkboxChecked } =
    window && !window.isDestroyed()
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options)
  if (variant === 'quit') return { choice: response === 1 ? 'quit' : 'cancel' }
  return {
    choice: response === 1 ? 'quit' : 'minimize',
    remember: checkboxChecked
  }
}

// Wires createCloseConfirm to Electron IPC + the current main window (via getWindow, since the window
// can be recreated). Response listeners are per-confirm and removed when it settles.
export const createElectronCloseConfirm = (
  getWindow: () => BrowserWindow | undefined,
  preferences: ClosePreferenceAccess
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
    onRendererUnresponsive: ({ onHang, onRecover }) => {
      const window = getWindow()
      if (!window) return () => undefined
      window.webContents.on('unresponsive', onHang)
      window.webContents.on('responsive', onRecover)
      return () => {
        window.webContents.off('unresponsive', onHang)
        window.webContents.off('responsive', onRecover)
      }
    },
    nativeFallback: (variant) => nativeFallback(getWindow, variant),
    getClosePreference: preferences.get,
    setClosePreference: preferences.set,
    newRequestId: () => randomUUID()
  })
