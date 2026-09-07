import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient } from '../projects/prisma-client'
import { MIGRATION_MANIFEST, migrateApplicationDatabase } from './migration-service'
import { visionEvidenceMigration } from './migrations/0009-vision-evidence'
import { applySqliteMigrationOperations } from './sqlite-schema-migrations'

describe('Compute Job harvest retry migration', () => {
  let root: string
  let client: ReturnType<typeof createProjectDbClient>
  afterEach(async () => {
    await client?.$disconnect()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('preserves historical jobs and cancellation ownership while allowing pending harvest errors', async () => {
    root = await mkdtemp(join(tmpdir(), 'harvest-retry-migration-'))
    client = createProjectDbClient(root)
    const prefix = MIGRATION_MANIFEST.slice(
      0,
      MIGRATION_MANIFEST.findIndex((entry) => entry.id === '0031_project_archive_revision') + 1
    )
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
      "id" TEXT NOT NULL PRIMARY KEY, "checksum" TEXT NOT NULL,
      "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "_open_science_migrations_checksum_check" CHECK (length("checksum") = 64 AND "checksum" NOT GLOB '*[^0-9a-f]*')
    )`)
    for (const migration of prefix) {
      await client.$executeRawUnsafe(
        'INSERT INTO "_open_science_migrations" (id, checksum) VALUES (?, ?)',
        migration.id,
        migration.checksum
      )
    }
    for (const id of ['pending', 'historical']) {
      await client.$executeRawUnsafe(
        `INSERT INTO "ComputeJob" (id, "providerId", shape, "sessionId", "projectId", intent, command, "commandHash", status)
        VALUES (?, 'ssh:test', 'direct_ssh', 'session', 'project', 'research', 'true', 'hash', 'success')`,
        id
      )
    }
    await client.$executeRawUnsafe(
      `UPDATE "ComputeJob" SET "harvestedAt" = 123, "harvestError" = 'old error', "leftOnRemote" = '[]' WHERE id = 'historical'`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ComputeJobOperation" (id, "jobId", kind, "updatedAt") VALUES ('operation', 'pending', 'cancel', 456)`
    )
    const jobsBefore = await client.$queryRawUnsafe('SELECT * FROM "ComputeJob" ORDER BY id')
    const operationsBefore = await client.$queryRawUnsafe('SELECT * FROM "ComputeJobOperation"')
    const indexesBefore = await client.$queryRawUnsafe(
      `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ComputeJob' ORDER BY name`
    )

    await migrateApplicationDatabase(client, { databasePath: join(root, 'open-science.db') })
    expect(await client.$queryRawUnsafe('SELECT * FROM "ComputeJob" ORDER BY id')).toEqual(
      jobsBefore
    )
    expect(await client.$queryRawUnsafe('SELECT * FROM "ComputeJobOperation"')).toEqual(
      operationsBefore
    )
    expect(
      await client.$queryRawUnsafe(
        `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ComputeJob' ORDER BY name`
      )
    ).toEqual(indexesBefore)
    await expect(
      client.$executeRawUnsafe(
        `UPDATE "ComputeJob" SET "harvestError" = 'harvest pending: Local free-space check failed.' WHERE id = 'pending'`
      )
    ).resolves.toBe(1)
    await expect(
      client.$executeRawUnsafe(`UPDATE "ComputeJob" SET "leftOnRemote" = '[]' WHERE id = 'pending'`)
    ).rejects.toThrow(/CHECK constraint failed/)
    expect(await client.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([])
    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
    await client.$executeRawUnsafe(`DELETE FROM "ComputeJob" WHERE id = 'pending'`)
    expect(await client.$queryRawUnsafe('SELECT * FROM "ComputeJobOperation"')).toEqual([])
  })
})
