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
          message: 'database migration completed',
          data: expect.objectContaining({
            applied: ['0001_runtime_schema_baseline'],
            adoptedLegacy: true
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

    createDatabaseStartupLogging(log, '0.13.0').reportBlocked(error)

    const record = records[0]!
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
  })

  it('records non-blocking backup retirement failures', () => {
    const { log, records } = createLog()
    const options = createDatabaseStartupLogging(log, '0.13.0').migrationOptions(vi.fn())
    options.onBackupRetirementFailed?.({
      migrationId: '0001_runtime_schema_baseline',
      path: '/data/open-science.db.before-0001_runtime_schema_baseline.backup',
      error: Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })

    expect(records).toEqual([
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

    expect(records).toEqual([
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
