// Startup recovery is available before a compatible backend connection exists.
export type RuntimeStartupIssue = {
  reason: 'version-mismatch' | 'legacy-service' | 'startup-recovery-required'
  desktopVersion: string
  runtimeVersion?: string
  pid?: number
  port?: number
  entryPath?: string
  diagnostics?: string
  // Only main may authorize stopping an authenticated, verified Node Runtime.
  canStop: boolean
  canRecover: boolean
}
export type RuntimeStartupState =
  | { phase: 'idle' }
  | { phase: 'ready' }
  | { phase: 'blocked'; issue: RuntimeStartupIssue }
  | { phase: 'stopping' | 'recovering'; issue: RuntimeStartupIssue }

export const RUNTIME_STARTUP_CHANNELS = {
  getState: 'runtime-startup:get-state',
  onStateChanged: 'runtime-startup:state-changed',
  stopAndContinue: 'runtime-startup:stop-and-continue',
  recover: 'runtime-startup:recover',
  quit: 'runtime-startup:quit'
} as const
