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
  },
  {
    id: '0004_review_assessment_snapshots',
    checksum: '03422aa2279cbbe4d26cee14f7cd1d17dcce54243ddad8981e760b61ad87214f'
  },
  {
    id: '0005_project_preview_state_owner_fk',
    checksum: '09a04241d1ff56a81ec574dc0259db4f689503cf641094b9c197eda8a82cd631'
  },
  {
    id: '0006_database_domain_constraints',
    checksum: '3cb84b96954d412b7d68bf3b2b21a5de8ad428b1e6b5d57c69919118e660b904'
  },
  {
    id: '0007_notification_attention_metadata',
    checksum: 'fad3ef7da9f26b7d6da2321ca44674d5c96238ab65515714b51dfe76df7fe10a'
  },
  {
    id: '0008_database_json_constraints',
    checksum: 'c4e978ff2a0176b61cf9d07f80a521c5444ec716d11804c6d26b9d8757766423'
  },
  {
    id: '0009_vision_evidence',
    checksum: 'ac24cc106a57fbd5560231b14a292274ebc586344ceb363c2953f4ebb6d01d19'
  },
  {
    id: '0010_compute_password_auth',
    checksum: '351de2963203b618a4f9379ed4daaa7a187579e0c4183d92b9c50ecdf989c2a5'
  },
  {
    id: '0011_cross_resource_tags',
    checksum: 'fd269c67c41caf4b0863d04564165a0373737817c5ec742a3160739324e1d3c1'
  },
  {
    id: '0012_tag_ordering',
    checksum: '2cbc89454c8642d65806366add598ef4547fb7f513e04c267d1ad0274a472e2f'
  },
  {
    id: '0013_session_projection',
    checksum: '00054ba3c572066bfec22f6043cae26900277c90ab68d9cae2f1acbb5a25a7fd'
  },
  {
    id: '0014_review_query_indexes',
    checksum: 'bdb9bd9a3acd807d651a944f64330e11fa01306f0b8d95c08e8114de15a4046c'
  },
  {
    id: '0015_session_model_call_usage',
    checksum: '84f09b9d29ee3ce9ea82ce73ded6a866c20330586932afc0626975faa462a875'
  },
  {
    id: '0016_compute_job_sensitive_data_encryption',
    checksum: 'b8cf55e358a0a99ad38b412c9e460560c79be4707c0906bc8d90c5c151cf9e3f'
  },
  {
    id: '0017_agent_memory_project_scope',
    checksum: '0e27d60b24a623fd0b080266be42e4560ad7dd4188c93b081ee94a655c800ba9'
  },
  {
    id: '0018_session_auxiliary_turn_usage',
    checksum: 'ceb7280f5f87150c99c5807bf88353ed0fa2b589f8c862fc62e4d2a81e2a01fc'
  },
  {
    id: '0019_session_usage_attribution',
    checksum: 'c505fe7e55e8428d29e8506ad305c04fd46d8def53385a1f7839fba21047ab9d'
  },
  {
    id: '0020_compute_job_analysis_state',
    checksum: 'b2bc8f9fd195a08a27af0e6ed2c78e0425002341ce1261952014130da1ea1a8d'
  },
  {
    id: '0021_compute_job_analysis_constraints',
    checksum: 'e842f932594ee6f4e250befc7f2e7966a680f556ca908bea2b61a9c45752f270'
  },
  {
    id: '0022_memory_global_content_unique',
    checksum: '0f02a6cace6991db4377da8a2f8d52dad221cb2fede595bf11bab90c64737ac8'
  },
  {
    id: '0023_compute_job_operation',
    checksum: 'c625e336996c7dd1eba64da8ccd306104ccd68cf219e60ee2c3889749f86b079'
  },
  {
    id: '0024_compute_job_file_evidence',
    checksum: '438500a5ce6a1069ecc353c8fa60549dacf6d2eef6a0f572571b7261ea3a88bb'
  },
  {
    id: '0025_managed_file_version_foundation',
    checksum: 'e6f5810debdccba77634ed6a1baeab72d6bb1ff34b56ae5766e01ff4489f33c1'
  },
  {
    id: '0026_compute_job_remote_cleanup',
    checksum: 'c9c0dff928daa4eafe5b8910c4202ddba83f740e92cb243a4fa0dc8e323cba7b'
  },
  {
    id: '0027_project_session_defaults',
    checksum: 'af7f3740a6032de71789e25567ee6605f961ee0dea3b89df2b47f9a589e738c7'
  }
]
const LEGACY_PROJECT_ID = 'package-smoke-legacy-project'
const SQLITE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/

const assertApplicationMigrationLedger = (
  rows,
  expectedMigrationCount = EXPECTED_MIGRATION_LEDGER.length
) => {
  if (
    !Number.isSafeInteger(expectedMigrationCount) ||
    expectedMigrationCount < 1 ||
    expectedMigrationCount > EXPECTED_MIGRATION_LEDGER.length
  ) {
    throw new Error('Expected migration count is outside the supported application ledger.')
  }
  const expectedLedger = EXPECTED_MIGRATION_LEDGER.slice(0, expectedMigrationCount)
  if (
    rows.length !== expectedLedger.length ||
    expectedLedger.some(
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

const verifyDatabaseMigrationLedger = async (configRoot, expectedMigrationCount) => {
  const rows = await readDatabaseMigrationLedger(configRoot)
  if (!rows) throw new Error('Packaged application did not create the database migration ledger.')
  assertApplicationMigrationLedger(rows, expectedMigrationCount)
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
