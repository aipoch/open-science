import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  MIGRATION_MANIFEST,
  migrateApplicationDatabase
} from '../src/main/database/migration-service'
import {
  assertApplicationMigrationLedger,
  parsePackagedSqliteVersion,
  seedLegacyDatabase,
  verifyLegacyProjectPreserved,
  writeDatabaseMigrationCertification
} from './database-migration-ledger-smoke.mjs'
import { PrismaClient } from '@prisma/client'

describe('packaged database migration ledger smoke', () => {
  it('pins every packaged application migration identity and checksum', () => {
    expect(MIGRATION_MANIFEST.at(-1)?.checksum).toBe(
      'bdb9bd9a3acd807d651a944f64330e11fa01306f0b8d95c08e8114de15a4046c'
    )
    expect(() => assertApplicationMigrationLedger(MIGRATION_MANIFEST)).not.toThrow()
    expect(() => assertApplicationMigrationLedger(MIGRATION_MANIFEST.slice(0, -1))).toThrow(
      /expected application database migration ledger/
    )
  })

  it('adds Review query indexes without changing existing Review or Finding rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-ledger-review-indexes-'))
    const databasePath = join(root, 'open-science.db').replaceAll('\\', '/')
    const client = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } })

    try {
      await migrateApplicationDatabase(client)
      const review = await client.review.create({
        data: {
          id: 'legacy-review',
          projectId: 'legacy-project',
          sessionId: 'legacy-session',
          turnMessageId: 'legacy-turn'
        }
      })
      const finding = await client.finding.create({
        data: { id: 'legacy-finding', reviewId: review.id }
      })
      await client.$executeRawUnsafe('DROP INDEX "Review_projectId_sessionId_createdAt_idx"')
      await client.$executeRawUnsafe('DROP INDEX "Review_sessionId_idx"')
      await client.$executeRawUnsafe('DROP INDEX "Finding_reviewId_idx"')
      await client.$executeRawUnsafe(
        `DELETE FROM "_open_science_migrations" WHERE "id" = '0014_review_query_indexes'`
      )

      await migrateApplicationDatabase(client)

      await expect(client.review.findUnique({ where: { id: review.id } })).resolves.toBeTruthy()
      await expect(client.finding.findUnique({ where: { id: finding.id } })).resolves.toBeTruthy()
      const indexes = await client.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT "name" FROM "sqlite_schema"
         WHERE "type" = 'index'
           AND "name" IN ('Review_projectId_sessionId_createdAt_idx', 'Review_sessionId_idx', 'Finding_reviewId_idx')
         ORDER BY "name"`
      )
      expect(indexes.map(({ name }) => name)).toEqual([
        'Finding_reviewId_idx',
        'Review_projectId_sessionId_createdAt_idx',
        'Review_sessionId_idx'
      ])
    } finally {
      await client.$disconnect()
      await rm(root, { force: true, recursive: true })
    }
  })

  it('accepts only an explicitly selected immutable released migration prefix', () => {
    const releasedLedger = MIGRATION_MANIFEST.slice(0, -1)
    expect(() =>
      assertApplicationMigrationLedger(releasedLedger, releasedLedger.length)
    ).not.toThrow()
    expect(() => assertApplicationMigrationLedger(releasedLedger)).toThrow(
      /expected application database migration ledger/
    )
    expect(() =>
      assertApplicationMigrationLedger(
        releasedLedger.map((entry, index) =>
          index === releasedLedger.length - 1 ? { ...entry, checksum: '0'.repeat(64) } : entry
        ),
        releasedLedger.length
      )
    ).toThrow(/expected application database migration ledger/)
    expect(() =>
      assertApplicationMigrationLedger(MIGRATION_MANIFEST, releasedLedger.length)
    ).toThrow(/expected application database migration ledger/)
  })

  it('applies the compute authentication persistence columns and named checks to a legacy database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-ledger-auth-persistence-'))
    await seedLegacyDatabase(root)
    const databasePath = join(root, 'open-science.db').replaceAll('\\', '/')
    const client = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } })

    try {
      await migrateApplicationDatabase(client)

      const jobColumns = await client.$queryRawUnsafe<Array<{ name: string }>>(
        `PRAGMA table_info('ComputeJob')`
      )
      const credentialColumns = await client.$queryRawUnsafe<Array<{ name: string; pk: bigint }>>(
        `PRAGMA table_info('ComputeCredential')`
      )
      const operationColumns = await client.$queryRawUnsafe<
        Array<{ name: string; notnull: bigint; dflt_value: string | null }>
      >(`PRAGMA table_info('ComputeAuthOperation')`)
      expect(jobColumns.map(({ name }) => name)).not.toContain('lastHarvestError')
      expect(credentialColumns.map(({ name }) => name)).not.toContain('id')
      expect(credentialColumns.find(({ name }) => name === 'computeHostId')).toMatchObject({
        pk: 1n
      })
      expect(operationColumns.map(({ name }) => name)).toEqual(
        expect.arrayContaining(['operationKind', 'requestFingerprint'])
      )
      expect(operationColumns.find(({ name }) => name === 'operationKind')).toMatchObject({
        notnull: 1n,
        dflt_value: null
      })
      expect(operationColumns.find(({ name }) => name === 'requestFingerprint')).toMatchObject({
        notnull: 1n
      })

      const tableSchemas = await client.$queryRawUnsafe<Array<{ name: string; sql: string }>>(
        `SELECT "name", "sql" FROM "sqlite_schema"
         WHERE "type" = 'table' AND "name" IN ('ComputeHost', 'ComputeAuthOperation')`
      )
      const schemaByTable = new Map(tableSchemas.map(({ name, sql }) => [name, sql]))
      expect(schemaByTable.get('ComputeHost')).toContain(
        'CONSTRAINT "ComputeHost_authenticationMode_check"'
      )
      expect(schemaByTable.get('ComputeHost')).toContain(
        'CONSTRAINT "ComputeHost_authenticationRevision_check"'
      )
      expect(schemaByTable.get('ComputeAuthOperation')).toContain(
        'CONSTRAINT "ComputeAuthOperation_resultRevision_check"'
      )
      expect(schemaByTable.get('ComputeAuthOperation')).toContain(
        'CONSTRAINT "ComputeAuthOperation_operationKind_check"'
      )
      expect(schemaByTable.get('ComputeAuthOperation')).not.toContain("'legacy'")
    } finally {
      await client.$disconnect()
      await rm(root, { force: true, recursive: true })
    }
  })

  it.each([0, 1.5, Number.NaN, MIGRATION_MANIFEST.length + 1])(
    'rejects unsupported expected migration count %s',
    (expectedMigrationCount) => {
      expect(() =>
        assertApplicationMigrationLedger(MIGRATION_MANIFEST, expectedMigrationCount)
      ).toThrow(/migration count is outside the supported application ledger/)
    }
  )

  it('records the packaged SQLite compatibility floor and certified matrix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-ledger-smoke-evidence-'))
    const output = join(root, 'database-migration-certification.json')
    try {
      expect(
        parsePackagedSqliteVersion(
          '[main] database runtime verified: sqlite_version=3.46.0\nOpen Science Web: ready'
        )
      ).toBe('3.46.0')

      await writeDatabaseMigrationCertification({
        output,
        sqliteVersions: ['3.46.0', '3.46.0'],
        checks: {
          freshInstall: 'passed',
          legacyAdoption: 'passed',
          reopen: 'passed',
          specialPath: 'passed'
        }
      })

      await expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({
        schemaVersion: 1,
        compatibilityFloor: {
          migrationId: '0001_runtime_schema_baseline',
          sqliteVersion: '3.46.0'
        },
        checks: { reopen: 'passed', specialPath: 'passed' }
      })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('seeds a supported pre-ledger fixture without a migration ledger', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-ledger-smoke-fixture-'))
    try {
      await seedLegacyDatabase(root)
      const databasePath = join(root, 'open-science.db').replaceAll('\\', '/')
      const client = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } })
      try {
        await expect(client.$queryRawUnsafe('SELECT "id" FROM "Project"')).resolves.toHaveLength(1)
        await expect(
          client.$queryRawUnsafe(
            `SELECT "name" FROM "sqlite_schema" WHERE "name" = '_open_science_migrations'`
          )
        ).resolves.toHaveLength(0)
      } finally {
        await client.$disconnect()
      }
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('rejects a legacy fixture without the migrated Agent Context default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-ledger-smoke-agent-context-'))
    try {
      await seedLegacyDatabase(root)
      const databasePath = join(root, 'open-science.db').replaceAll('\\', '/')
      const client = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } })
      try {
        await client.$executeRawUnsafe(
          `ALTER TABLE "Project" ADD COLUMN "agentContext" TEXT NOT NULL DEFAULT ''`
        )
        await client.$executeRawUnsafe(
          `UPDATE "Project" SET "agentContext" = 'unexpected' WHERE "id" = 'package-smoke-legacy-project'`
        )
      } finally {
        await client.$disconnect()
      }

      await expect(verifyLegacyProjectPreserved(root)).rejects.toThrow(
        /preserve the legacy database fixture/
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
