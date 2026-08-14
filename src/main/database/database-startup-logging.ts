import { errorLogFields, type Logger } from '../logger'
import { startDiagnosticOperation, type DiagnosticOperation } from '../diagnostics/operation'
import {
  type DatabaseMigrationError,
  type SchemaMigrationOptions,
  type SchemaMigrationProgress
} from './migration-service'

type DatabaseStartupLogging = {
  reportBlocked: (error: DatabaseMigrationError) => void
  migrationOptions: (
    forwardProgress: (progress: SchemaMigrationProgress) => void
  ) => SchemaMigrationOptions
}

const createDatabaseStartupLogging = (log: Logger, appVersion: string): DatabaseStartupLogging => {
  let operation: DiagnosticOperation | undefined

  return {
    reportBlocked: (error) => {
      operation?.fail(error, {
        code: error.code,
        migrationId: error.migrationId ?? null,
        retryable: error.retryable
      })
      log.error('database startup blocked', {
        appVersion,
        code: error.code,
        migrationId: error.migrationId ?? null,
        retryable: error.retryable,
        details: errorLogFields(error)
      })
    },
    migrationOptions: (forwardProgress) => {
      operation = startDiagnosticOperation(log, {
        operation: 'database-startup',
        fields: { appVersion }
      })
      return {
        onProgress: (progress) => {
          operation?.phase(
            progress.phase,
            progress.phase === 'migrating' ? { migrationId: progress.migrationId } : undefined
          )
          log.info(
            progress.phase === 'checking'
              ? 'database migration checking'
              : 'database migration started',
            progress.phase === 'migrating' ? { migrationId: progress.migrationId } : undefined
          )
          forwardProgress(progress)
        },
        onCompatibilityVerified: ({ sqliteVersion }) => {
          operation?.phase('runtime-verified', { sqliteVersion })
          log.info(`database runtime verified: sqlite_version=${sqliteVersion}`)
        },
        onBackupReady: ({ migrationId, path, reused }) => {
          log.info('database pre-migration backup ready', {
            migrationId,
            backupPath: path,
            reused
          })
        },
        onBackupRetired: ({ migrationId, path }) => {
          log.info('database migration backup retired', { migrationId, backupPath: path })
        },
        onBackupRetirementFailed: ({ migrationId, path, error }) => {
          log.warn('database migration backup retirement failed', {
            migrationId,
            backupPath: path ?? null,
            ...errorLogFields(error)
          })
        },
        onCompleted: ({ from, to, applied, adoptedLegacy }) => {
          log.info('database migration completed', { from, to, applied, adoptedLegacy })
          operation?.complete({
            appliedCount: applied.length,
            adoptedLegacy,
            from: from ?? null,
            to
          })
        }
      }
    }
  }
}

export { createDatabaseStartupLogging }
export type { DatabaseStartupLogging }
