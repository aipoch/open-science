import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createProjectDbClient } from '../projects/prisma-client'
import { createDatabaseStartupOwner } from './database-startup-owner'
import { migrationSqlExecutor } from './migration-sql-executor'
import {
  checksumMigrationPayload,
  MIGRATION_MANIFEST,
  migrateApplicationDatabase,
  migrateApplicationDatabaseWithManifest,
  type MigrationManifestEntry
} from './migration-service'

const storageErrors = [
  'SQLITE_BUSY: database is locked',
  'SQLITE_LOCKED: database table is locked',
  'database table is locked',
  'SQLITE_IOERR: disk I/O error',
  'SQLITE_FULL: database or disk is full',
  'SQLITE_READONLY: attempt to write a readonly database',
  'EACCES: permission denied',
  'EPERM: operation not permitted'
]

// A real transactional migration whose verification only succeeds after its UPDATE.
const id = '9999_storage_failure_probe'
const statements = [`UPDATE "Project" SET "name" = 'after' WHERE "id" = 'probe'`] as const
const verifiers = [
  {
    kind: 'table-value-equals',
    version: 1,
    table: 'Project',
    keyColumn: 'id',
    keyValue: 'probe',
    valueColumn: 'name',
    expectedValue: 'after'
  }
] as const
const probeMigration: MigrationManifestEntry = {
  id,
  statements,
  verifiers,
  checksum: checksumMigrationPayload(id, statements, verifiers),
  backupOnApply: 'none',
  backupRetention: 'retain'
}

describe('D01 storage failures through the migration entry point', () => {
  let client: PrismaClient
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'open-science-storage-failure-'))
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'probe', name: 'before' } })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await client?.$disconnect()
    if (root) await rm(root, { recursive: true, force: true })
  })

  describe.each([
    'open',
    'migration',
    'validation',
    'pre-migration validation',
    'post-migration validation'
  ] as const)('%s', (phase) => {
    it.each(storageErrors)('can retry after removing %s', async (message) => {
      const failure = new Error(message)
      let injected = 0
      let enabled = true
      let migrationApplied = false
      const query = migrationSqlExecutor.query
      const execute = migrationSqlExecutor.execute
      if (phase === 'open') {
        const raw = client.$queryRaw.bind(client)
        vi.spyOn(client, '$queryRaw').mockImplementation((...args) => {
          if (enabled) {
            injected++
            throw failure
          }
          return raw(...args)
        })
      }
      vi.spyOn(migrationSqlExecutor, 'execute').mockImplementation(async (db, sql, ...values) => {
        if (sql === statements[0]) {
          if (enabled && phase === 'migration') {
            injected++
            throw failure
          }
          const result = await execute(db, sql, ...values)
          migrationApplied = true
          return result
        }
        return execute(db, sql, ...values)
      })
      vi.spyOn(migrationSqlExecutor, 'query').mockImplementation(async (db, sql, ...values) => {
        if (
          enabled &&
          ((phase === 'validation' && sql === 'PRAGMA foreign_key_check') ||
            (phase === 'pre-migration validation' &&
              !migrationApplied &&
              sql.includes('FROM "Project"')) ||
            (phase === 'post-migration validation' &&
              migrationApplied &&
              sql.includes('FROM "Project"')))
        ) {
          injected++
          throw failure
        }
        return query(db, sql, ...values)
      })
      const manifest =
        phase === 'migration' ||
        phase === 'pre-migration validation' ||
        phase === 'post-migration validation'
          ? [...MIGRATION_MANIFEST, probeMigration]
          : MIGRATION_MANIFEST
      const owner = createDatabaseStartupOwner({
        reportBlocked: vi.fn(),
        verifyDatabase: async () => {
          await migrateApplicationDatabaseWithManifest(client, manifest)
        }
      })
      const blocked = await owner.start()
      expect(injected).toBeGreaterThan(0)
      expect.soft(blocked).toMatchObject({ phase: 'blocked', error: { retryable: true } })
      if (blocked.phase === 'blocked') {
        expect.soft(blocked.error.code).not.toBe('database_validation_failed')
        expect.soft(blocked.error.code).not.toBe('database_runtime_unavailable')
      }
      enabled = false
      await expect(owner.retry()).resolves.toEqual({ phase: 'starting' })
    })
  })

  it('does not classify an initialization permission error as a missing engine', async () => {
    const failure = Object.assign(new Error('EACCES: permission denied opening database'), {
      name: 'PrismaClientInitializationError'
    })
    vi.spyOn(client, '$queryRaw').mockRejectedValueOnce(failure)
    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_open_failed',
      retryable: true,
      cause: failure
    })
  })
  it('retries validation after a real SQLite exclusive lock is released', async () => {
    const blocker = createProjectDbClient(root)
    const query = migrationSqlExecutor.query
    let locked = false
    let enabled = true
    await client.$queryRawUnsafe('PRAGMA busy_timeout = 1')
    vi.spyOn(migrationSqlExecutor, 'query').mockImplementation(async (db, sql, ...values) => {
      if (enabled && !locked && sql === 'PRAGMA integrity_check') {
        await blocker.$executeRawUnsafe('BEGIN EXCLUSIVE')
        locked = true
      }
      return query(db, sql, ...values)
    })
    const reportBlocked = vi.fn()
    const owner = createDatabaseStartupOwner({
      reportBlocked,
      verifyDatabase: async () => {
        await migrateApplicationDatabase(client)
      }
    })
    try {
      const result = await owner.start()
      expect(locked).toBe(true)
      expect(result).toMatchObject({
        phase: 'blocked',
        error: { code: 'database_open_failed', retryable: true }
      })
      expect(reportBlocked.mock.calls[0][0].cause.message).toMatch(/database is locked/i)
      await blocker.$executeRawUnsafe('ROLLBACK')
      locked = false
      enabled = false
      await expect(owner.retry()).resolves.toEqual({ phase: 'starting' })
    } finally {
      if (locked) await blocker.$executeRawUnsafe('ROLLBACK')
      await blocker.$disconnect()
    }
  })
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'retries after actual database file permissions are restored',
    async () => {
      const path = join(root, 'open-science.db')
      await client.$disconnect()
      await chmod(path, 0o000)
      const reportBlocked = vi.fn()
      const owner = createDatabaseStartupOwner({
        reportBlocked,
        verifyDatabase: async () => {
          await migrateApplicationDatabase(client)
        }
      })
      try {
        expect.soft(await owner.start()).toMatchObject({
          phase: 'blocked',
          error: { code: 'database_open_failed', retryable: true }
        })
        expect(reportBlocked).toHaveBeenCalledOnce()
        expect(reportBlocked.mock.calls[0][0].cause.message).toMatch(
          /unable to open (?:the )?database file/i
        )
        await chmod(path, 0o600)
        await expect(owner.retry()).resolves.toEqual({ phase: 'starting' })
      } finally {
        await chmod(path, 0o600)
      }
    }
  )
})
