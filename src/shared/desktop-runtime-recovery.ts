/** Fixed backend startup categories, projected from the private startup protocol's allowlists. */
export type DesktopRuntimeStartupFailure = Readonly<{
  stage: 'bootstrap' | 'credentials' | 'storage' | 'database' | 'runtime' | 'endpoint'
  code: 'credential-unavailable' | 'startup-failed'
  reason?: string
  diagnostic?: Readonly<{
    code: string
    source?: string
    stage?: string
    reason?: string
    systemCode?: string
    osStatus?: number
    exitCode?: number
    signal?: string
  }>
}>

/** Desktop attachment state, independent of database startup and persisted business state. */
export type DesktopRuntimeRecoveryState = Readonly<{
  phase: 'connected' | 'disconnected' | 'reconnecting' | 'reconciling' | 'unavailable'
  epoch: number
  /** Attached service identity; available before renderer snapshot reconciliation. */
  generation?: string
  closing: boolean
  shutdownProgress?: boolean
  reason?:
    | 'connection-lost'
    | 'process-exited'
    | 'crash-limit'
    | 'recovery-timeout'
    | 'service-stopped'
    | 'startup-failed'
  /** Most recent safe startup failure; cleared after successful synchronization. */
  startupFailure?: DesktopRuntimeStartupFailure
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
  restartApp: 'desktop-runtime:restart-app',
  quit: 'desktop-runtime:quit',
  reconciled: 'desktop-runtime:reconciled',
  stateChanged: 'desktop-runtime:state-changed'
} as const

/** Only a live browser-profile inventory conflict offers an application restart as its remedy. */
export function desktopRecoveryNeedsAppRestart(state: DesktopRuntimeRecoveryState): boolean {
  const failure = state.startupFailure
  const diagnostic = failure?.diagnostic
  return (
    state.phase !== 'connected' &&
    failure?.code === 'credential-unavailable' &&
    failure.reason === 'ciphertext-inventory-unavailable' &&
    diagnostic?.code === 'inventory-failed' &&
    diagnostic.source === 'cookies' &&
    (diagnostic.reason === 'source-changed' ||
      (diagnostic.reason === 'operation-failed' &&
        ['EBUSY', 'EPERM', 'EACCES'].includes(diagnostic.systemCode ?? '')))
  )
}
