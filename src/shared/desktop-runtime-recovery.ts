/** Desktop attachment state, independent of database startup and persisted business state. */
export type DesktopRuntimeRecoveryState = Readonly<{
  phase: 'connected' | 'disconnected' | 'reconnecting' | 'reconciling' | 'unavailable'
  epoch: number
  closing: boolean
  shutdownProgress?: boolean
  reason?:
    'connection-lost' | 'process-exited' | 'crash-limit' | 'recovery-timeout' | 'service-stopped'
  /** Safe lifecycle metadata only: never credentials, environment, or research content. */
  diagnostics?: string
  /** Set only after a new generation has passed the full synchronization barrier. */
  restartedGeneration?: string
}>

export class DesktopRuntimeDisconnectedError extends Error {
  readonly code = 'desktop-runtime-disconnected'
  constructor(message = 'The local service connection was lost.', options?: ErrorOptions) {
    super(message, options)
    this.name = 'DesktopRuntimeDisconnectedError'
  }
}

/** Classifies connection failures without relying on user-visible message text. */
export function isDesktopRuntimeConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  // A save/business failure may wrap a connection failure as its cause. Its own classification
  // must remain visible; suppress only errors explicitly owned by the connection boundary.
  return 'code' in error && error.code === 'desktop-runtime-disconnected'
}

export const DESKTOP_RUNTIME_RECOVERY_CHANNELS = {
  getState: 'desktop-runtime:get-state',
  reconnect: 'desktop-runtime:reconnect',
  quit: 'desktop-runtime:quit',
  reconciled: 'desktop-runtime:reconciled',
  stateChanged: 'desktop-runtime:state-changed'
} as const
