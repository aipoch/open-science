import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createProjectDbClient } from '../projects/prisma-client'
import {
  MIGRATION_MANIFEST,
  migrateApplicationDatabase,
  verifyCurrentApplicationSchema
} from './migration-service'
import { applySqliteMigrationOperations } from './sqlite-schema-migrations'

const MIGRATION_ID = '0020_project_files_index_state'

const createDatabaseAtPreviousMigration = async (client: PrismaClient): Promise<void> => {
  const migrationIndex = MIGRATION_MANIFEST.findIndex((migration) => migration.id === MIGRATION_ID)
  const prefix = MIGRATION_MANIFEST.slice(0, migrationIndex)
  for (const migration of prefix) {
    for (const statement of migration.statements) await client.$executeRawUnsafe(statement)
    if ('operations' in migration) {
      await client.$transaction((transaction) =>
        applySqliteMigrationOperations(transaction, migration.operations)
      )
    }
  }
  await client.$executeRawUnsafe(`CREATE TABLE "_open_science_migrations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "checksum" TEXT NOT NULL,
    "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "_open_science_migrations_checksum_check"
      CHECK (length("checksum") = 64 AND "checksum" NOT GLOB '*[^0-9a-f]*')
  )`)
  for (const migration of prefix) {
    await client.$executeRawUnsafe(
      `INSERT INTO "_open_science_migrations" ("id", "checksum") VALUES (?, ?)`,
      migration.id,
      migration.checksum
    )
  }
}

describe('Project Files index state migration', () => {
  let storageRoot = ''
  let client: PrismaClient

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-project-files-state-migration-'))
    client = createProjectDbClient(storageRoot)
  })

  afterEach(async () => {
    await client.$disconnect()
    await rm(storageRoot, { recursive: true, force: true })
  })

  it('seeds a compatibility-first complete marker when upgrading the previous schema', async () => {
    const databasePath = join(storageRoot, 'open-science.db')
    await createDatabaseAtPreviousMigration(client)

    await expect(
      client.$queryRaw<Array<{ name: string }>>`
        SELECT "name" FROM "sqlite_schema"
        WHERE "type" = 'table' AND "name" = 'ManagedFileIndexState'
      `
    ).resolves.toEqual([])

    await expect(migrateApplicationDatabase(client, { databasePath })).resolves.toMatchObject({
      adoptedLegacy: false,
      applied: [MIGRATION_ID]
    })
    await expect(
      client.$queryRaw<Array<{ id: string; isReconciliationComplete: boolean }>>`
        SELECT "id", "isReconciliationComplete" FROM "ManagedFileIndexState"
      `
    ).resolves.toEqual([{ id: 'project-files-index', isReconciliationComplete: true }])
    await expect(verifyCurrentApplicationSchema(client)).resolves.toBeUndefined()

    await client.$executeRaw`
      UPDATE "ManagedFileIndexState"
      SET "isReconciliationComplete" = false
      WHERE "id" = 'project-files-index'
    `
    await expect(verifyCurrentApplicationSchema(client)).resolves.toBeUndefined()
  })

  it('enforces the singleton identity at the database boundary', async () => {
    await migrateApplicationDatabase(client)

    await expect(
      client.$executeRaw`
        INSERT INTO "ManagedFileIndexState" ("id", "isReconciliationComplete")
        VALUES ('other', true)
      `
    ).rejects.toThrow()
  })
})
