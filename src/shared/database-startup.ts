type DatabaseStartupErrorCode =
  | 'database_runtime_unavailable'
  | 'database_open_failed'
  | 'database_newer_than_app'
  | 'database_history_invalid'
  | 'database_migration_failed'
  | 'database_validation_failed'
  | 'database_startup_unavailable'

type DatabaseStartupError = {
  code: DatabaseStartupErrorCode
  message: string
  migrationId?: string
  retryable: boolean
  // Pre-redacted environment + stack summary for the "create an issue" draft. Composed in the main
  // process, which owns the app version and the original error cause chain; the renderer only
  // embeds it verbatim into the GitHub issue URL.
  diagnostics?: string
}

type DatabaseStartupState =
  | { phase: 'checking' }
  | { phase: 'migrating'; migrationId: string }
  | { phase: 'ready' }
  | { phase: 'blocked'; error: DatabaseStartupError }

const DATABASE_STARTUP_CHANNELS = {
  getState: 'database-startup:get-state',
  retry: 'database-startup:retry',
  quit: 'database-startup:quit',
  stateChanged: 'database-startup:state-changed'
} as const

export { DATABASE_STARTUP_CHANNELS }
export type { DatabaseStartupError, DatabaseStartupErrorCode, DatabaseStartupState }
