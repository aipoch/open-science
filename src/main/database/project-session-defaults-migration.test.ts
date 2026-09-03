import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient } from '../projects/prisma-client'
import { MIGRATION_MANIFEST, migrateApplicationDatabase } from './migration-service'
import { visionEvidenceMigration } from './migrations/0009-vision-evidence'
import { applySqliteMigrationOperations } from './sqlite-schema-migrations'

const createDatabaseAtMigration0026 = async (client: PrismaClient): Promise<void> => {
  const migration0027Index = MIGRATION_MANIFEST.findIndex(
    (migration) => migration.id === '0027_project_session_defaults'
  )
  const prefix = MIGRATION_MANIFEST.slice(0, migration0027Index)
  await client.$executeRawUnsafe('PRAGMA foreign_keys = OFF')
  for (const migration of prefix) {
    for (const statement of migration.statements) await client.$executeRawUnsafe(statement)
    if ('operations' in migration) {
      await client.$transaction((transaction) =>
        applySqliteMigrationOperations(transaction, migration.operations)
      )
    }
  }
  await client.$transaction((transaction) =>
    applySqliteMigrationOperations(transaction, visionEvidenceMigration.operations)
  )
  await client.$executeRawUnsafe('PRAGMA foreign_keys = ON')
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

describe('Project Session defaults migration', () => {
  let storageRoot: string | undefined
  let client: ReturnType<typeof createProjectDbClient> | undefined

  afterEach(async () => {
    await client?.$disconnect()
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  })

  it('adds an empty JSON object for historical Projects without rewriting related tables', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-project-defaults-migration-'))
    const databasePath = join(storageRoot, 'open-science.db')
    client = createProjectDbClient(storageRoot)
    await createDatabaseAtMigration0026(client)
    await client.$executeRawUnsafe(
      `INSERT INTO "Project" ("id", "name", "updatedAt") VALUES ('historical-project', 'Historical', CURRENT_TIMESTAMP)`
    )

    await expect(migrateApplicationDatabase(client, { databasePath })).resolves.toMatchObject({
      applied: ['0027_project_session_defaults'],
      from: '0026_compute_job_remote_cleanup',
      to: '0027_project_session_defaults'
    })
    await expect(
      client.$queryRawUnsafe<Array<{ sessionDefaults: string }>>(
        `SELECT "sessionDefaults" FROM "Project" WHERE "id" = 'historical-project'`
      )
    ).resolves.toEqual([{ sessionDefaults: '{}' }])
    await expect(
      client.$queryRawUnsafe<Array<{ table: string }>>(`PRAGMA foreign_key_list("Session")`)
    ).resolves.toContainEqual(expect.objectContaining({ table: 'Project' }))
  })
})
