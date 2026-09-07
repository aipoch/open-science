import type { DatabaseStartupState, StartupEnvironment } from '../../shared/database-startup'
import { createLogger, errorLogFields } from '../logger'
import { DatabaseMigrationError, type SchemaMigrationProgress } from './migration-service'

const log = createLogger('database-startup-owner')

type DatabaseStartupOwnerDeps = {
  reportBlocked: (error: DatabaseMigrationError) => void
  verifyDatabase: (onProgress: (progress: SchemaMigrationProgress) => void) => Promise<void>
  // Optional: composes the pre-redacted cause-chain stack shared through the "create an issue"
  // draft. Kept injectable so the owner stays free of os concerns.
  buildDiagnostics?: (error: DatabaseMigrationError) => string | undefined
  // Optional: runtime environment facts for the issue draft's Environment table. Collected by the
  // caller, which owns the app version and runtime versions.
  environment?: StartupEnvironment
}

type DatabaseStartupOwner = {
  getState: () => DatabaseStartupState
  start: () => Promise<DatabaseStartupState>
  retry: () => Promise<DatabaseStartupState>
  complete: () => void
  whenVerified: () => Promise<void>
  whenAttemptSettled: () => Promise<void>
  isMigrating: () => boolean
  subscribe: (listener: (state: DatabaseStartupState) => void) => () => void
}

const createDatabaseStartupOwner = (deps: DatabaseStartupOwnerDeps): DatabaseStartupOwner => {
  let state: DatabaseStartupState = { phase: 'checking' }
  let activeAttempt: Promise<DatabaseStartupState> | undefined
  let verified = false
  let resolveVerified: (() => void) | undefined
  const verifiedPromise = new Promise<void>((resolve) => {
    resolveVerified = resolve
  })
  const listeners = new Set<(state: DatabaseStartupState) => void>()

  const publish = (next: DatabaseStartupState): void => {
    state = next
    for (const listener of listeners) {
      try {
        listener(next)
      } catch (error) {
        try {
          log.warn('database startup notification failed', errorLogFields(error))
        } catch {
          // Notification and diagnostic failures cannot change database readiness.
        }
      }
    }
  }

  const runAttempt = (): Promise<DatabaseStartupState> => {
    if (activeAttempt) return activeAttempt
    if (verified) return Promise.resolve(state)

    publish({ phase: 'checking' })
    const pending = deps
      .verifyDatabase((progress) => publish(progress))
      .then(() => {
        verified = true
        resolveVerified?.()
        // `ready` still waits for runtime composition; this only leaves the database-checking copy.
        publish({ phase: 'starting' })
        return state
      })
      .catch((error: unknown) => {
        const classified =
          error instanceof DatabaseMigrationError
            ? error
            : new DatabaseMigrationError(
                'database_startup_unavailable',
                'Open Science could not finish checking its database.',
                true,
                undefined,
                { cause: error }
              )
        try {
          deps.reportBlocked(classified)
        } catch {
          // A diagnostic sink failure must not bypass the database compatibility gate.
        }
        let diagnostics: string | undefined
        try {
          diagnostics = deps.buildDiagnostics?.(classified)
        } catch {
          // Diagnostics are a best-effort aid for issue reports; they must not mask the block.
        }
        const blocked: DatabaseStartupState = {
          phase: 'blocked',
          error: {
            code: classified.code,
            message: classified.message,
            retryable: classified.retryable,
            ...(classified.migrationId ? { migrationId: classified.migrationId } : {}),
            ...(deps.environment ? { environment: deps.environment } : {}),
            ...(diagnostics ? { diagnostics } : {})
          }
        }
        publish(blocked)
        return blocked
      })
      .finally(() => {
        if (activeAttempt === pending) activeAttempt = undefined
      })

    activeAttempt = pending
    return pending
  }

  return {
    getState: () => state,
    start: runAttempt,
    retry: () => {
      if (state.phase !== 'blocked' || !state.error.retryable) return Promise.resolve(state)
      return runAttempt()
    },
    complete: () => {
      if (!verified) throw new Error('Database startup cannot complete before verification.')
      publish({ phase: 'ready' })
    },
    whenVerified: () => verifiedPromise,
    whenAttemptSettled: async () => {
      await activeAttempt
    },
    isMigrating: () => state.phase === 'migrating' && activeAttempt !== undefined,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

export { createDatabaseStartupOwner }
export type { DatabaseStartupOwner, DatabaseStartupOwnerDeps }
