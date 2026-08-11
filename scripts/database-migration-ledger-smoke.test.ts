import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

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
    expect(() =>
      assertApplicationMigrationLedger([
        {
          id: '0001_runtime_schema_baseline',
          checksum: 'e29d0483786c3ed2e1c9cd358369b254a54ccf54213931c5ef71a8fd4e161525'
        },
        {
          id: '0002_project_agent_context',
          checksum: 'f3b29cf4543d1739a0cd211ddea172dcfd18aa9d7c8f94d520913ab88cb977c6'
        }
      ])
    ).not.toThrow()
    expect(() =>
      assertApplicationMigrationLedger([
        {
          id: '0001_runtime_schema_baseline',
          checksum: 'e29d0483786c3ed2e1c9cd358369b254a54ccf54213931c5ef71a8fd4e161525'
        }
      ])
    ).toThrow(/expected application database migration ledger/)
  })

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
