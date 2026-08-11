import { ipcMain } from 'electron'

import type { UnreadTaskViewState } from '../../shared/notifications'

type UnreadTaskIpcController = {
  syncViewState(state: UnreadTaskViewState): Promise<void>
}

type UnreadTaskIpcDeps = {
  getMainWindow: () =>
    | {
        webContents: unknown
      }
    | undefined
  controller: UnreadTaskIpcController
  onError?: (error: unknown) => void
  probeTimeoutMs?: number
}

export type UnreadTaskVisibilityProbe = {
  confirmSessionVisible(sessionId: string): Promise<boolean>
}

const MAX_SESSION_ID_LENGTH = 512

// Treats renderer IPC as untrusted input: only a bounded visible id and challenge may reach main.
const normalizeViewState = (input: unknown): UnreadTaskViewState | undefined => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined

  const value = input as Partial<UnreadTaskViewState>
  if (value.visibleSessionId !== undefined && typeof value.visibleSessionId !== 'string') {
    return undefined
  }
  if ((value.visibleSessionId?.length ?? 0) > MAX_SESSION_ID_LENGTH) return undefined
  if (
    value.challengeId !== undefined &&
    (!Number.isSafeInteger(value.challengeId) || value.challengeId <= 0)
  ) {
    return undefined
  }

  const visibleSessionId = value.visibleSessionId?.trim() || undefined

  return {
    ...(value.challengeId === undefined ? {} : { challengeId: value.challengeId }),
    ...(visibleSessionId ? { visibleSessionId } : {})
  }
}

// Registers one bidirectional legacy-named channel: ordinary renderer projections update message
// read state, while numbered challenges provide a fresh, fail-closed visibility acknowledgement.
export const registerUnreadTaskIpc = (deps: UnreadTaskIpcDeps): UnreadTaskVisibilityProbe => {
  const pendingChallenges = new Map<
    number,
    { sessionId: string; resolve: (visible: boolean) => void; timer: ReturnType<typeof setTimeout> }
  >()
  let nextChallengeId = 0

  // Every challenge settles once and releases its timeout regardless of response order.
  const settleChallenge = (challengeId: number, visible: boolean): void => {
    const pending = pendingChallenges.get(challengeId)
    if (!pending) return

    pendingChallenges.delete(challengeId)
    clearTimeout(pending.timer)
    pending.resolve(visible)
  }

  ipcMain.on('notifications:sync-unread-view', (event, input: unknown) => {
    // Ignore preview/devtools/forged senders: only the current main window owns navigation state.
    if (event.sender !== deps.getMainWindow()?.webContents) return

    const state = normalizeViewState(input)

    if (!state) return

    if (state.challengeId !== undefined) {
      // Challenge replies prove visibility only when both the id and requested session match.
      const pending = pendingChallenges.get(state.challengeId)
      settleChallenge(
        state.challengeId,
        pending !== undefined && state.visibleSessionId === pending.sessionId
      )
      return
    }

    void deps.controller.syncViewState(state).then(
      () => undefined,
      (error) => {
        deps.onError?.(error)
      }
    )
  })

  return {
    // Ask the renderer for current visibility rather than trusting an earlier projection that may
    // predate a modal, navigation change, or focus transition. Timeout and send failures mean false.
    confirmSessionVisible: (sessionId) => {
      const webContents = deps.getMainWindow()?.webContents as
        | {
            isDestroyed?: () => boolean
            send?: (channel: string, challengeId: number) => void
          }
        | undefined
      if (!webContents?.send || webContents.isDestroyed?.()) return Promise.resolve(false)

      nextChallengeId = nextChallengeId >= Number.MAX_SAFE_INTEGER ? 1 : nextChallengeId + 1
      const challengeId = nextChallengeId

      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(
          () => settleChallenge(challengeId, false),
          deps.probeTimeoutMs ?? 500
        )
        pendingChallenges.set(challengeId, { sessionId, resolve, timer })

        try {
          webContents.send?.('notifications:probe-unread-view', challengeId)
        } catch (error) {
          deps.onError?.(error)
          settleChallenge(challengeId, false)
        }
      })
    }
  }
}
