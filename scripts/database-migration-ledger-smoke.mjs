/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

import { PrismaClient } from '@prisma/client'

const BASELINE_ID = '0001_runtime_schema_baseline'
const BASELINE_CHECKSUM = 'e29d0483786c3ed2e1c9cd358369b254a54ccf54213931c5ef71a8fd4e161525'
const EXPECTED_MIGRATION_LEDGER = [
  { id: BASELINE_ID, checksum: BASELINE_CHECKSUM },
  {
    id: '0002_project_agent_context',
    checksum: 'f3b29cf4543d1739a0cd211ddea172dcfd18aa9d7c8f94d520913ab88cb977c6'
  },
  {
    id: '0003_granted_local_roots',
    checksum: '3bc5e32cdf7f793771d22fe3027f082c1ba8e3a5e4decab37bd0c92c7928bfc7'
  }
]
const LEGACY_PROJECT_ID = 'package-smoke-legacy-project'
const SQLITE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/

const assertApplicationMigrationLedger = (rows) => {
  if (
    rows.length !== EXPECTED_MIGRATION_LEDGER.length ||
    EXPECTED_MIGRATION_LEDGER.some(
      (expected, index) =>
        rows[index]?.id !== expected.id || rows[index]?.checksum !== expected.checksum
    )
  ) {
    throw new Error(
      'Packaged application did not record the expected application database migration ledger.'
    )
  }
}

const readDatabaseMigrationLedger = async (configRoot) => {
  const databasePath = join(configRoot, 'open-science.db').replaceAll('\\', '/')
  const client = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } })
  try {
    const tables = await client.$queryRawUnsafe(
      `SELECT "name" FROM "sqlite_schema" WHERE "type" = 'table' AND "name" = '_open_science_migrations'`
    )
    if (tables.length === 0) return null
    return await client.$queryRawUnsafe(
      'SELECT "id", "checksum" FROM "_open_science_migrations" ORDER BY "id"'
    )
  } finally {
    await client.$disconnect()
  }
}

const verifyDatabaseMigrationLedger = async (configRoot) => {
  const rows = await readDatabaseMigrationLedger(configRoot)
  if (!rows) throw new Error('Packaged application did not create the database migration ledger.')
  assertApplicationMigrationLedger(rows)
}

const seedLegacyDatabase = async (configRoot) => {
  await mkdir(configRoot, { recursive: true })
  const databasePath = join(configRoot, 'open-science.db').replaceAll('\\', '/')
  const client = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } })
  try {
    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)
    await client.$executeRawUnsafe(
      `INSERT INTO "Project" ("id", "name", "updatedAt") VALUES ('${LEGACY_PROJECT_ID}', 'Preserved package smoke project', CURRENT_TIMESTAMP)`
    )
  } finally {
    await client.$disconnect()
  }
}

const verifyLegacyProjectPreserved = async (configRoot) => {
  const databasePath = join(configRoot, 'open-science.db').replaceAll('\\', '/')
  const client = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } })
  try {
    const rows = await client.$queryRawUnsafe(
      `SELECT "name", "agentContext", "archivedAt" FROM "Project" WHERE "id" = '${LEGACY_PROJECT_ID}'`
    )
    if (
      rows.length !== 1 ||
      rows[0]?.name !== 'Preserved package smoke project' ||
      rows[0]?.agentContext !== ''
    ) {
      throw new Error('Packaged application did not preserve the legacy database fixture.')
    }
  } finally {
    await client.$disconnect()
  }
}

const parsePackagedSqliteVersion = (output) => {
  const sqliteVersion = output.match(
    /\[main\] database runtime verified: sqlite_version=(\d+\.\d+\.\d+)/
  )?.[1]
  if (!sqliteVersion) {
    throw new Error('Packaged application did not report its SQLite runtime version.')
  }
  return sqliteVersion
}

const writeDatabaseMigrationCertification = async ({ output, sqliteVersions, checks }) => {
  const versions = [...new Set(sqliteVersions)]
  if (
    versions.length !== 1 ||
    !SQLITE_VERSION_PATTERN.test(versions[0] ?? '') ||
    checks?.freshInstall !== 'passed' ||
    checks?.legacyAdoption !== 'passed' ||
    checks?.reopen !== 'passed' ||
    checks?.specialPath !== 'passed'
  ) {
    throw new Error('Packaged database migration certification is incomplete or inconsistent.')
  }
  const evidence = {
    schemaVersion: 1,
    compatibilityFloor: {
      migrationId: BASELINE_ID,
      migrationChecksum: BASELINE_CHECKSUM,
      sqliteVersion: versions[0]
    },
    checks
  }
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  return evidence
}

export {
  assertApplicationMigrationLedger,
  parsePackagedSqliteVersion,
  readDatabaseMigrationLedger,
  seedLegacyDatabase,
  verifyDatabaseMigrationLedger,
  verifyLegacyProjectPreserved,
  writeDatabaseMigrationCertification
}
