import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient } from '../projects/prisma-client'
import { MIGRATION_MANIFEST, migrateApplicationDatabase } from './migration-service'
import { applySqliteMigrationOperations } from './sqlite-schema-migrations'

const createDatabaseAtMigration0015 = async (client: PrismaClient): Promise<void> => {
  const migration0016Index = MIGRATION_MANIFEST.findIndex(
    (migration) => migration.id === '0016_compute_job_sensitive_data_encryption'
  )
  const prefix = MIGRATION_MANIFEST.slice(0, migration0016Index)
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

describe('Compute Job sensitive data encryption migration', () => {
  let storageRoot: string | undefined
  let client: PrismaClient | undefined

  afterEach(async () => {
    await client?.$disconnect()
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  })

  it('preserves historical plaintext and marks it as legacy', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-compute-job-encryption-0016-'))
    const databasePath = join(storageRoot, 'open-science.db')
    client = createProjectDbClient(storageRoot)
    await createDatabaseAtMigration0015(client)
    await client.$executeRawUnsafe(`INSERT INTO "ComputeJob" (
      "id", "providerId", "shape", "sessionId", "projectId", "status", "intent", "command",
      "commandHash"
    ) VALUES (
      'legacy-job', 'ssh:legacy', 'direct_ssh', 'legacy-session', 'legacy-project', 'queued',
      'legacy intent', 'open-science:protected:v1:not-ciphertext', 'legacy-hash'
    )`)

    await expect(migrateApplicationDatabase(client, { databasePath })).resolves.toEqual({
      adoptedLegacy: false,
      applied: [
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
        '0027_project_session_defaults',
        '0028_database_numeric_and_null_constraints'
      ],
      from: '0015_session_model_call_usage',
      to: '0028_database_numeric_and_null_constraints'
    })
    await expect(
      access(`${databasePath}.before-0016_compute_job_sensitive_data_encryption.backup`)
    ).resolves.toBeUndefined()
    await expect(
      access(`${databasePath}.before-0017_agent_memory_project_scope.backup`)
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      access(`${databasePath}.before-0018_session_auxiliary_turn_usage.backup`)
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      access(`${databasePath}.before-0021_compute_job_analysis_constraints.backup`)
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      access(`${databasePath}.before-0022_memory_global_content_unique.backup`)
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      access(`${databasePath}.before-0023_compute_job_operation.backup`)
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      access(`${databasePath}.before-0024_compute_job_file_evidence.backup`)
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      access(`${databasePath}.before-0025_managed_file_version_foundation.backup`)
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      client.$queryRaw<
        Array<{ command: string; sensitiveDataEncrypted: boolean | null }>
      >`SELECT "command", "sensitiveDataEncrypted" FROM "ComputeJob" WHERE "id" = 'legacy-job'`
    ).resolves.toEqual([
      {
        command: 'open-science:protected:v1:not-ciphertext',
        sensitiveDataEncrypted: null
      }
    ])
  })
})
