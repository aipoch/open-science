/** Desktop attachment state, independent of database startup and persisted business state. */
export type DesktopRuntimeRecoveryState = Readonly<{
  phase: 'connected' | 'disconnected' | 'reconnecting' | 'reconciling' | 'unavailable'
  epoch: number
  closing: boolean
}>

export const DESKTOP_RUNTIME_RECOVERY_CHANNELS = {
  getState: 'desktop-runtime:get-state',
  reconnect: 'desktop-runtime:reconnect',
  quit: 'desktop-runtime:quit',
  reconciled: 'desktop-runtime:reconciled',
  stateChanged: 'desktop-runtime:state-changed'
} as const
