import {
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainEvent,
  type WebContentsDidStartNavigationEventParams
} from 'electron'
import { randomUUID } from 'node:crypto'

import { hasDelegatedActiveSession, type ActiveSessionInfo } from '../shared/storage'
import { englishNativeTranslator, type NativeTranslator } from './locale/main-process-messages'
import {
  WINDOW_CLOSE_CONFIRM_DISMISS_CHANNEL,
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
  // Destruction or cross-document main-frame navigation invalidates this page's request.
  onPageLost?: (cb: () => void) => () => void
  // Withdraw only this request from the renderer, including when native UI takes ownership.
  dismiss?: (requestId: string) => void
  // Subscribe to the confirm window's paired 'unresponsive'/'responsive' events; returns an
  // unsubscribe. Lets the coordinator fall back only on a SUSTAINED hang (renderer alive but wedged,
  // so render-process-gone never fires), never on a slow-but-alive renderer. Optional: absent in
  // tests that don't exercise the hang path.
  onRendererUnresponsive?: (cbs: { onHang: () => void; onRecover: () => void }) => () => void
  // Native fallback when the renderer can't answer (dead/hung, or no window at all). May reject;
  // the coordinator wraps it so a rejection never leaves the confirm unsettled.
  nativeFallback: (
    variant: CloseConfirmVariant,
    sessions: ActiveSessionInfo[]
  ) => Promise<NativeCloseConfirmResult>
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

// Coordinates a close/quit confirmation. Main computes `sessions` plus activity without a Session row,
// so the quit variant resolves without IPC only when both are idle; otherwise the renderer renders the
// modal and replies with the choice, with a native/proceed fallback if it can't.
export const createCloseConfirm = (
  deps: CloseConfirmDeps
): ((
  variant: CloseConfirmVariant,
  sessions: ActiveSessionInfo[],
  unlistedWorkActive?: boolean
) => Promise<CloseConfirmChoice>) => {
  const ackTimeoutMs = deps.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS
  const hangGraceMs = deps.hangGraceMs ?? DEFAULT_HANG_GRACE_MS

  return async (variant, sessions, unlistedWorkActive = false) => {
    if (variant === 'quit' && sessions.length === 0 && !unlistedWorkActive) return 'quit'
    const hasDelegatedWork = hasDelegatedActiveSession(sessions)
    const enforceDelegatedBlock = (choice: CloseConfirmChoice): CloseConfirmChoice =>
      hasDelegatedWork && choice === 'quit' ? (variant === 'quit' ? 'cancel' : 'minimize') : choice

    if (variant === 'close-to-tray') {
      const preference = await deps.getClosePreference().catch(() => undefined)
      if (preference) return enforceDelegatedBlock(preference)
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
        const result = await deps.nativeFallback(variant, sessions)
        const choice = enforceDelegatedBlock(result.choice)
        await persistPreference(choice, result.remember)
        return choice
      } catch {
        return enforceDelegatedBlock(
          variant === 'quit' ? 'quit' : variant === 'close-to-tray' ? 'minimize' : 'cancel'
        )
      }
    }

    if (!deps.isRendererAvailable()) return safeFallback()

    const requestId = deps.newRequestId()

    return new Promise<CloseConfirmChoice>((resolve) => {
      let settled = false
      let acked = false
      let fallbackStarted = false
      let hangTimer: ReturnType<typeof setTimeout> | undefined

      const dismiss = (): void => {
        try {
          deps.dismiss?.(requestId)
        } catch {
          // A disappearing renderer must not retain the confirmation lock.
        }
      }

      const finish = (choice: CloseConfirmChoice, remember = false): void => {
        if (settled) return
        settled = true
        clearTimeout(ackTimer)
        clearTimeout(hangTimer)
        offResponse()
        offGone()
        offHang?.()
        offPageLost?.()
        dismiss()
        const enforcedChoice = enforceDelegatedBlock(choice)
        void persistPreference(enforcedChoice, remember).then(() => resolve(enforcedChoice))
      }

      // Native UI owns the decision as soon as fallback starts, even if the renderer recovers.
      const startFallback = (): void => {
        if (settled || fallbackStarted) return
        fallbackStarted = true
        clearTimeout(ackTimer)
        clearTimeout(hangTimer)
        dismiss()
        void safeFallback().then(finish)
      }

      const offResponse = deps.onResponse((payload) => {
        if (settled || fallbackStarted || payload.requestId !== requestId) return
        if (payload.ack) {
          acked = true
          clearTimeout(ackTimer)
          return
        }
        if (payload.choice) finish(payload.choice, payload.remember)
      })

      const offGone = deps.onRenderGone(startFallback)
      const offPageLost = deps.onPageLost?.(() => {
        // Once a native dialog is open, page navigation no longer owns its decision.
        if (!fallbackStarted) finish('cancel')
      })

      // A sustained hang AFTER ack: the pre-ack window is already covered by ackTimer, and the modal
      // legitimately waits on the user, so only arm the grace timer once the renderer actually reports
      // 'unresponsive'; a paired 'responsive' cancels it. Crashes use onRenderGone; reloads and
      // normal destruction use onPageLost, independently of this timer.
      const offHang = deps.onRendererUnresponsive?.({
        onHang: () => {
          if (!acked || settled || fallbackStarted || hangTimer !== undefined) return
          hangTimer = setTimeout(startFallback, hangGraceMs)
        },
        onRecover: () => {
          clearTimeout(hangTimer)
          hangTimer = undefined
        }
      })

      const ackTimer = setTimeout(() => {
        if (!acked) startFallback()
      }, ackTimeoutMs)

      try {
        deps.send({ requestId, variant, sessions, unlistedWorkActive })
      } catch {
        startFallback()
      }
    })
  }
}

// Native fallback when the renderer can't render the modal (dead/hung, or no window — e.g. macOS
// after the window was closed but the app stays resident). The coordinator only reaches this with
// work running (an empty quit list fast-paths to 'quit'), so every reachable variant still asks. A
// destroyed window can't parent a dialog, so fall back to a windowless one.
const nativeFallback = async (
  getWindow: () => BrowserWindow | undefined,
  variant: CloseConfirmVariant,
  sessions: ActiveSessionInfo[],
  translate: NativeTranslator
): Promise<NativeCloseConfirmResult> => {
  const hasDelegatedWork = hasDelegatedActiveSession(sessions)
  const options =
    variant === 'persistence-failed'
      ? {
          type: 'warning' as const,
          buttons: [translate('Stay'), translate('Retry saving'), translate('Force quit')],
          defaultId: 0,
          cancelId: 0,
          title: 'Open Science',
          message: translate('Saving is not finished'),
          detail: translate(
            'Open Science could not confirm that all recent changes were saved. Retry saving, or force quit and risk losing recent changes.'
          )
        }
      : hasDelegatedWork
        ? {
            type: 'warning' as const,
            buttons: [
              variant === 'quit' ? translate('Return to tasks') : translate('Minimize to tray')
            ],
            defaultId: 0,
            cancelId: 0,
            title: 'Open Science',
            message: translate('Subagents are still running'),
            detail: translate(
              'Return to the running tasks and stop their subagents before quitting Open Science.'
            )
          }
        : variant === 'quit'
          ? {
              type: 'question' as const,
              buttons: [translate('Cancel'), translate('Quit', { context: 'verb' })],
              defaultId: 0,
              cancelId: 0,
              title: 'Open Science',
              message: translate('Quit Open Science?'),
              detail: translate('Work is still running and will be interrupted if you quit.')
            }
          : {
              type: 'question' as const,
              buttons: [translate('Minimize to tray'), translate('Quit', { context: 'verb' })],
              defaultId: 0,
              cancelId: 0,
              title: 'Open Science',
              message: translate('Minimize to tray or quit?'),
              detail: translate('Background work may still be running.'),
              checkboxLabel: translate("Don't ask again"),
              checkboxChecked: true
            }
  const window = getWindow()
  const { response, checkboxChecked } =
    window && !window.isDestroyed()
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options)
  if (variant === 'persistence-failed') {
    return { choice: response === 1 ? 'retry' : response === 2 ? 'force-quit' : 'cancel' }
  }
  if (hasDelegatedWork) return { choice: variant === 'quit' ? 'cancel' : 'minimize' }
  if (variant === 'quit') return { choice: response === 1 ? 'quit' : 'cancel' }
  return {
    choice: response === 1 ? 'quit' : 'minimize',
    remember: checkboxChecked
  }
}

// Wires createCloseConfirm to Electron IPC + the current main window (via getWindow, since the window
// can be recreated). Response listeners are per-confirm and removed when it settles.
export const createElectronCloseConfirm =
  (
    getWindow: () => BrowserWindow | undefined,
    preferences: ClosePreferenceAccess,
    translate: NativeTranslator = englishNativeTranslator
  ): ((
    variant: CloseConfirmVariant,
    sessions: ActiveSessionInfo[],
    unlistedWorkActive?: boolean
  ) => Promise<CloseConfirmChoice>) =>
  (variant, sessions, unlistedWorkActive) => {
    const window = getWindow()
    const webContents = window?.webContents
    return createCloseConfirm({
      // Reveal the window before asking: a tray/Ctrl+Q quit can arrive while the window is hidden
      // (minimized to tray), and a modal sent to a hidden window would never be seen — leaving the
      // confirm (and thus the quit) stuck. Restoring/showing/focusing guarantees the modal is visible.
      send: (payload) => {
        if (!window || window.isDestroyed()) return
        if (window.isMinimized()) window.restore()
        if (!window.isVisible()) window.show()
        window.focus()
        window.webContents.send(WINDOW_CLOSE_CONFIRM_REQUEST_CHANNEL, payload)
      },
      onResponse: (cb) => {
        const listener = (event: IpcMainEvent, payload: CloseConfirmResponse): void => {
          if (event.sender === webContents) cb(payload)
        }
        ipcMain.on(WINDOW_CLOSE_CONFIRM_RESPONSE_CHANNEL, listener)
        return () => ipcMain.removeListener(WINDOW_CLOSE_CONFIRM_RESPONSE_CHANNEL, listener)
      },
      isRendererAvailable: () => {
        return Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed())
      },
      onRenderGone: (cb) => {
        if (!window) return () => undefined
        window.webContents.on('render-process-gone', cb)
        return () => window.webContents.off('render-process-gone', cb)
      },
      onPageLost: (cb) => {
        if (!webContents) return () => undefined
        const onNavigation = (details: WebContentsDidStartNavigationEventParams): void => {
          if (details.isMainFrame && !details.isSameDocument) cb()
        }
        webContents.on('destroyed', cb)
        webContents.on('did-start-navigation', onNavigation)
        return () => {
          webContents.off('destroyed', cb)
          webContents.off('did-start-navigation', onNavigation)
        }
      },
      dismiss: (requestId) => {
        if (webContents && !webContents.isDestroyed()) {
          webContents.send(WINDOW_CLOSE_CONFIRM_DISMISS_CHANNEL, { requestId })
        }
      },
      onRendererUnresponsive: ({ onHang, onRecover }) => {
        if (!window) return () => undefined
        window.webContents.on('unresponsive', onHang)
        window.webContents.on('responsive', onRecover)
        return () => {
          window.webContents.off('unresponsive', onHang)
          window.webContents.off('responsive', onRecover)
        }
      },
      nativeFallback: (variant, sessions) =>
        nativeFallback(() => window, variant, sessions, translate),
      getClosePreference: preferences.get,
      setClosePreference: preferences.set,
      newRequestId: () => randomUUID()
    })(variant, sessions, unlistedWorkActive)
  }
