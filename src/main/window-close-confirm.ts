import type { ActiveSessionInfo } from '../shared/storage'
import type {
  CloseConfirmChoice,
  CloseConfirmRequest,
  CloseConfirmResponse,
  CloseConfirmVariant
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
