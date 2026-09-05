import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient } from '../projects/prisma-client'
import { MIGRATION_MANIFEST, migrateApplicationDatabase } from './migration-service'
import { visionEvidenceMigration } from './migrations/0009-vision-evidence'
import { applySqliteMigrationOperations } from './sqlite-schema-migrations'

const createDatabaseAtMigration0025 = async (client: PrismaClient): Promise<void> => {
  const migration0026Index = MIGRATION_MANIFEST.findIndex(
    (migration) => migration.id === '0026_compute_job_remote_cleanup'
  )
  const prefix = MIGRATION_MANIFEST.slice(0, migration0026Index)
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

describe('Compute Job remote cleanup migration', () => {
  let storageRoot: string | undefined
  let client: ReturnType<typeof createProjectDbClient> | undefined

  afterEach(async () => {
    await client?.$disconnect()
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  })

  it('keeps historical Jobs pending until remote cleanup is explicitly settled', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-job-cleanup-migration-'))
    const databasePath = join(storageRoot, 'open-science.db')
    client = createProjectDbClient(storageRoot)
    await createDatabaseAtMigration0025(client)
    await client.$executeRawUnsafe(`INSERT INTO "ComputeJob" (
      "id", "providerId", "shape", "sessionId", "projectId", "intent", "command",
      "commandHash", "status"
    ) VALUES (
      'historical-job', 'ssh:retired-host', 'direct_ssh', 'session-1', 'project-1',
      'completed research', 'true', 'hash', 'success'
    )`)

    await expect(migrateApplicationDatabase(client, { databasePath })).resolves.toMatchObject({
      applied: [
        '0026_compute_job_remote_cleanup',
        '0027_project_session_defaults',
        '0028_database_numeric_and_null_constraints'
      ],
      from: '0025_managed_file_version_foundation',
      to: '0028_database_numeric_and_null_constraints'
    })
    await expect(
      client.$queryRawUnsafe<Array<{ remoteCleanupDisposition: string }>>(
        `SELECT "remoteCleanupDisposition" FROM "ComputeJob" WHERE "id" = 'historical-job'`
      )
    ).resolves.toEqual([{ remoteCleanupDisposition: 'pending' }])
    await expect(
      client.$executeRawUnsafe(
        `UPDATE "ComputeJob" SET "remoteCleanupDisposition" = 'corrupt' WHERE "id" = 'historical-job'`
      )
    ).rejects.toThrow(/CHECK constraint failed/)
  })
})
