import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { MIGRATION_MANIFEST } from '../src/main/database/migration-service'
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
      'fad3ef7da9f26b7d6da2321ca44674d5c96238ab65515714b51dfe76df7fe10a'
    )
    expect(() => assertApplicationMigrationLedger(MIGRATION_MANIFEST)).not.toThrow()
    expect(() => assertApplicationMigrationLedger(MIGRATION_MANIFEST.slice(0, -1))).toThrow(
      /expected application database migration ledger/
    )
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
