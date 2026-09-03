import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { formatLine, type Logger } from '../logger'
import { createProjectDbClient } from '../projects/prisma-client'
import { createDatabaseStartupLogging } from './database-startup-logging'
import { DatabaseValidationError } from './database-validation-error'
import { DatabaseMigrationError, migrateApplicationDatabase } from './migration-service'

describe('database startup logging', () => {
  let storageRoot: string | undefined
  let client: PrismaClient | undefined

  afterEach(async () => {
    await client?.$disconnect()
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  })

  const createLog = (): {
    log: Logger
    records: Array<{ level: string; message: string; data?: unknown }>
  } => {
    const records: Array<{ level: string; message: string; data?: unknown }> = []
    const write =
      (level: string) =>
      (message: string, data?: unknown): void => {
        records.push({ level, message, data })
      }
    return {
      log: {
        debug: write('debug'),
        info: write('info'),
        warn: write('warn'),
        error: write('error')
      },
      records
    }
  }

  it('records the migration lifecycle through the production logging adapter', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-startup-log-'))
    const databasePath = join(storageRoot, 'open-science.db')
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)
    const { log, records } = createLog()
    const progress = vi.fn()

    await migrateApplicationDatabase(client, {
      ...createDatabaseStartupLogging(log, '0.13.0').migrationOptions(progress),
      databasePath
    })

    expect(progress).toHaveBeenCalledWith({ phase: 'checking' })
    expect(progress).toHaveBeenCalledWith({
      phase: 'migrating',
      migrationId: '0001_runtime_schema_baseline'
    })
    expect(progress).toHaveBeenCalledWith({
      phase: 'migrating',
      migrationId: '0002_project_agent_context'
    })
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'info', message: 'database migration checking' }),
        expect.objectContaining({
          level: 'info',
          message: 'database migration started',
          data: { migrationId: '0001_runtime_schema_baseline' }
        }),
        expect.objectContaining({
          level: 'info',
          message: 'database pre-migration backup ready',
          data: expect.objectContaining({ migrationId: '0001_runtime_schema_baseline' })
        }),
        expect.objectContaining({
          level: 'info',
          message: 'database migration started',
          data: { migrationId: '0002_project_agent_context' }
        }),
        expect.objectContaining({
          level: 'info',
          message: 'database migration completed',
          data: expect.objectContaining({
            applied: [
              '0001_runtime_schema_baseline',
              '0002_project_agent_context',
              '0003_granted_local_roots',
              '0004_review_assessment_snapshots',
              '0005_project_preview_state_owner_fk',
              '0006_database_domain_constraints',
              '0007_notification_attention_metadata',
              '0008_database_json_constraints',
              '0009_vision_evidence',
              '0010_compute_password_auth',
              '0011_cross_resource_tags',
              '0012_tag_ordering',
              '0013_session_projection',
              '0014_review_query_indexes',
              '0015_session_model_call_usage',
              '0016_compute_job_sensitive_data_encryption',
              '0017_agent_memory_project_scope',
              '0018_session_auxiliary_turn_usage',
              '0019_session_usage_attribution',
              '0020_compute_job_analysis_state',
              '0021_compute_job_analysis_constraints',
              '0022_memory_global_content_unique',
              '0023_compute_job_operation',
              '0024_compute_job_file_evidence',
              '0025_managed_file_version_foundation',
              '0026_compute_job_remote_cleanup',
              '0027_project_session_defaults'
            ],
            adoptedLegacy: true
          })
        })
      ])
    )
    expect(
      records.filter(({ message }) => message === 'database pre-migration backup ready')
    ).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ migrationId: '0001_runtime_schema_baseline' })
      })
    ])
  })

  it('records a timed operation for each database startup attempt', () => {
    const { log, records } = createLog()
    const options = createDatabaseStartupLogging(log, '0.13.0').migrationOptions(vi.fn())

    options.onProgress?.({ phase: 'checking' })
    options.onCompatibilityVerified?.({ sqliteVersion: '3.49.1' })
    options.onCompleted?.({
      from: '0004_review_assessment_snapshots',
      to: '0004_review_assessment_snapshots',
      applied: [],
      adoptedLegacy: false
    })

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'operation phase',
          data: expect.objectContaining({
            operation: 'database-startup',
            phase: 'runtime-verified',
            elapsedMs: expect.any(Number),
            phaseDurationMs: expect.any(Number)
          })
        }),
        expect.objectContaining({
          message: 'operation completed',
          data: expect.objectContaining({
            operation: 'database-startup',
            outcome: 'completed',
            appliedCount: 0,
            durationMs: expect.any(Number)
          })
        })
      ])
    )
  })

  it('records structured validation details through the mandatory redactor', () => {
    const sensitiveValue = 'customer-secret-value'
    const cause = new DatabaseValidationError('Schema mismatch.', {
      kind: 'test-mismatch',
      table: 'Project',
      actual: { password: sensitiveValue },
      expected: { type: 'TEXT' }
    })
    const error = new DatabaseMigrationError(
      'database_validation_failed',
      'The existing database does not satisfy the required schema contract.',
      false,
      '0001_runtime_schema_baseline',
      { cause }
    )
    const { log, records } = createLog()

    const logging = createDatabaseStartupLogging(log, '0.13.0')
    logging.migrationOptions(vi.fn())
    logging.reportBlocked(error)

    const record = records.find(({ message }) => message === 'database startup blocked')!
    const line = formatLine('error', 'main', record.message, record.data)
    expect(line).not.toContain(sensitiveValue)
    expect(JSON.parse(line)).toMatchObject({
      level: 'error',
      msg: 'database startup blocked',
      data: {
        appVersion: '0.13.0',
        code: 'database_validation_failed',
        details: {
          cause: {
            data: {
              kind: 'test-mismatch',
              actual: { password: '[redacted]' }
            }
          }
        }
      }
    })
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'error',
          message: 'operation failed',
          data: expect.objectContaining({
            operation: 'database-startup',
            outcome: 'failed',
            code: 'database_validation_failed'
          })
        })
      ])
    )
  })

  it('records non-blocking backup retirement failures', () => {
    const { log, records } = createLog()
    const options = createDatabaseStartupLogging(log, '0.13.0').migrationOptions(vi.fn())
    options.onBackupRetirementFailed?.({
      migrationId: '0001_runtime_schema_baseline',
      path: '/data/open-science.db.before-0001_runtime_schema_baseline.backup',
      error: Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })

    expect(
      records.filter(({ message }) => message === 'database migration backup retirement failed')
    ).toEqual([
      expect.objectContaining({
        level: 'warn',
        message: 'database migration backup retirement failed',
        data: expect.objectContaining({
          migrationId: '0001_runtime_schema_baseline',
          code: 'EACCES',
          error: 'permission denied'
        })
      })
    ])
  })

  it('records successful backup retirement', () => {
    const { log, records } = createLog()
    const options = createDatabaseStartupLogging(log, '0.13.0').migrationOptions(vi.fn())
    const path = '/data/open-science.db.before-0001_runtime_schema_baseline.backup'

    options.onBackupRetired?.({ migrationId: '0001_runtime_schema_baseline', path })

    expect(
      records.filter(({ message }) => message === 'database migration backup retired')
    ).toEqual([
      {
        level: 'info',
        message: 'database migration backup retired',
        data: {
          migrationId: '0001_runtime_schema_baseline',
          backupPath: path
        }
      }
    ])
  })
})
