import { visionEvidenceMigration } from '../../src/main/database/migrations/0009-vision-evidence'
import type { PrismaClient } from '@prisma/client'

import {
  MIGRATION_MANIFEST,
  type MigrationManifestEntry
} from '../../src/main/database/migration-service'
import { applySqliteMigrationOperations } from '../../src/main/database/sqlite-schema-migrations'

// Historical fixtures must replay immutable history, not erase the ledger of a newer schema.
export const createDatabaseAtReleasedManifest = async (
  client: PrismaClient,
  manifest: readonly MigrationManifestEntry[] = MIGRATION_MANIFEST.filter(
    ({ id }) => id < '0049_pascalcase_table_names'
  )
): Promise<void> => {
  await client.$executeRawUnsafe('PRAGMA foreign_keys = OFF')
  try {
    // Replay the same immutable history with one commit instead of fsync for every DDL statement.
    await client.$transaction(
      async (transaction) => {
        for (const migration of manifest) {
          for (const statement of migration.statements)
            await transaction.$executeRawUnsafe(statement)
          await applySqliteMigrationOperations(transaction, migration.operations ?? [])
          // Match the production runner's repair of the inbound reference after the frozen 0025 rebuild.
          if (migration.id === '0025_managed_file_version_foundation')
            await applySqliteMigrationOperations(transaction, visionEvidenceMigration.operations)
        }
        await transaction.$executeRawUnsafe(`CREATE TABLE "_open_science_migrations" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "checksum" TEXT NOT NULL,
          "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "_open_science_migrations_checksum_check"
            CHECK (length("checksum") = 64 AND "checksum" NOT GLOB '*[^0-9a-f]*')
        )`)
        for (const migration of manifest) {
          await transaction.$executeRawUnsafe(
            'INSERT INTO "_open_science_migrations" ("id", "checksum") VALUES (?, ?)',
            migration.id,
            migration.checksum
          )
        }
      },
      { timeout: 120_000 }
    )
  } finally {
    await client.$executeRawUnsafe('PRAGMA foreign_keys = ON')
  }
}
