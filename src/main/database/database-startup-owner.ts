import type { DatabaseStartupState } from '../../shared/database-startup'
import { DatabaseMigrationError, type SchemaMigrationProgress } from './migration-service'

type DatabaseStartupOwnerDeps = {
  reportBlocked: (error: DatabaseMigrationError) => void
  verifyDatabase: (onProgress: (progress: SchemaMigrationProgress) => void) => Promise<void>
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
    for (const listener of listeners) listener(state)
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
        return state
      })
      .catch((error: unknown) => {
        if (!(error instanceof DatabaseMigrationError)) throw error
        try {
          deps.reportBlocked(error)
        } catch {
          // A diagnostic sink failure must not bypass the database compatibility gate.
        }
        const blocked: DatabaseStartupState = {
          phase: 'blocked',
          error: {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            ...(error.migrationId ? { migrationId: error.migrationId } : {})
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
