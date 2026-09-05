import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  MIGRATION_MANIFEST,
  migrateApplicationDatabase
} from '../src/main/database/migration-service'
import {
  assertApplicationMigrationLedger,
  parsePackagedSqliteVersion,
  seedLegacyDatabase,
  verifyLegacyProjectPreserved,
  writeDatabaseMigrationCertification
} from './database-migration-ledger-smoke.mjs'
import { PrismaClient } from '@prisma/client'

const rebuildComputeJobWithoutAnalysisConstraints = async (
  client: PrismaClient,
  dropAnalysisColumns: boolean
): Promise<void> => {
  await client.$executeRawUnsafe('ALTER TABLE "ComputeJob" DROP COLUMN "fileEvidence"')
  await client.$executeRawUnsafe('ALTER TABLE "ComputeJob" DROP COLUMN "producerRunId"')
  const [{ sql }] = await client.$queryRawUnsafe<Array<{ sql: string }>>(
    `SELECT "sql" FROM "sqlite_schema" WHERE "type" = 'table' AND "name" = 'ComputeJob'`
  )
  const removedLines = [
    '"remoteCleanupDisposition" TEXT',
    'CONSTRAINT "ComputeJob_remoteCleanupDisposition_check"',
    'CONSTRAINT "ComputeJob_analysisState_check"',
    'CONSTRAINT "ComputeJob_analysisBundle_check"',
    'CONSTRAINT "ComputeJob_analysisConsumption_check"',
    ...(dropAnalysisColumns
      ? ['"analysisState" TEXT', '"analysisMessageId" TEXT', '"analysisUpdatedAt" DATETIME']
      : [])
  ]
  const legacyDdl = sql
    .split('\n')
    .filter((line) => removedLines.every((removed) => !line.includes(removed)))
    .join('\n')
    .replace(/CREATE TABLE (?:IF NOT EXISTS )?"ComputeJob"/u, 'CREATE TABLE "__legacy_ComputeJob"')
  const columns = await client.$queryRawUnsafe<Array<{ name: string }>>(
    `PRAGMA table_info('ComputeJob')`
  )
  const copiedColumns = columns
    .map(({ name }) => name)
    .filter(
      (name) =>
        name !== 'remoteCleanupDisposition' &&
        (!dropAnalysisColumns ||
          !['analysisState', 'analysisMessageId', 'analysisUpdatedAt'].includes(name))
    )
    .map((name) => `"${name}"`)
    .join(', ')

  await client.$executeRawUnsafe(legacyDdl)
  await client.$executeRawUnsafe(
    `INSERT INTO "__legacy_ComputeJob" (${copiedColumns}) SELECT ${copiedColumns} FROM "ComputeJob"`
  )
  await client.$executeRawUnsafe('DROP TABLE "ComputeJob"')
  await client.$executeRawUnsafe('ALTER TABLE "__legacy_ComputeJob" RENAME TO "ComputeJob"')
  await client.$executeRawUnsafe(
    'CREATE INDEX "ComputeJob_providerId_idx" ON "ComputeJob"("providerId")'
  )
  await client.$executeRawUnsafe(
    'CREATE INDEX "ComputeJob_sessionId_idx" ON "ComputeJob"("sessionId")'
  )
  await client.$executeRawUnsafe('CREATE INDEX "ComputeJob_status_idx" ON "ComputeJob"("status")')
}

describe('packaged database migration ledger smoke', () => {
  it('pins every packaged application migration identity and checksum', () => {
    expect(MIGRATION_MANIFEST.slice(-6).map(({ id, checksum }) => ({ id, checksum }))).toEqual([
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
      },
      {
        id: '0028_database_numeric_and_null_constraints',
        checksum: '7ee2e3ec746080d5e1bedcddaea5ded1b080d8bcbc8ec59ed4139ff8c5e5de4a'
      }
    ])
    expect(() => assertApplicationMigrationLedger(MIGRATION_MANIFEST)).not.toThrow()
    expect(() => assertApplicationMigrationLedger(MIGRATION_MANIFEST.slice(0, -1))).toThrow(
      /expected application database migration ledger/
    )
  })

  it('adds automatic-analysis state without reclassifying historical Compute Jobs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-ledger-job-analysis-'))
    const databasePath = join(root, 'open-science.db').replaceAll('\\', '/')
    const client = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } })

    try {
      await migrateApplicationDatabase(client)
      for (const [id, consumed] of [
        ['legacy-pending', false],
        ['legacy-consumed', true]
      ] as const) {
        await client.computeJob.create({
          data: {
            id,
            providerId: 'ssh:legacy',
            shape: 'direct_ssh',
            sessionId: 'legacy-session',
            projectId: 'legacy-project',
            status: 'success',
            intent: id,
            command: 'true',
            commandHash: id,
            notifiedAt: new Date('2026-01-01'),
            ...(consumed ? { notificationConsumedAt: new Date('2026-01-02') } : {})
          }
        })
      }
      await rebuildComputeJobWithoutAnalysisConstraints(client, true)
      await client.$executeRawUnsafe(
        `DELETE FROM "_open_science_migrations" WHERE "id" IN ('0020_compute_job_analysis_state', '0021_compute_job_analysis_constraints', '0022_memory_global_content_unique', '0023_compute_job_operation', '0024_compute_job_file_evidence', '0025_managed_file_version_foundation', '0026_compute_job_remote_cleanup', '0027_project_session_defaults', '0028_database_numeric_and_null_constraints')`
      )

      await migrateApplicationDatabase(client)

      await expect(
        client.computeJob.findUnique({ where: { id: 'legacy-pending' } })
      ).resolves.toMatchObject({
        analysisState: null,
        analysisMessageId: null,
        analysisUpdatedAt: null,
        notificationConsumedAt: null
      })
      await expect(
        client.computeJob.findUnique({ where: { id: 'legacy-consumed' } })
      ).resolves.toMatchObject({
        analysisState: null,
        analysisMessageId: null,
        analysisUpdatedAt: null,
        notificationConsumedAt: expect.any(Date)
      })
    } finally {
      await client.$disconnect()
      await rm(root, { force: true, recursive: true })
    }
  })

  it('blocks analysis constraints when a historical Compute Job has an invalid state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-ledger-job-analysis-invalid-'))
    const databasePath = join(root, 'open-science.db').replaceAll('\\', '/')
    const client = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } })

    try {
      await migrateApplicationDatabase(client)
      await rebuildComputeJobWithoutAnalysisConstraints(client, false)
      await client.$executeRawUnsafe(
        `DELETE FROM "_open_science_migrations" WHERE "id" IN ('0021_compute_job_analysis_constraints', '0022_memory_global_content_unique', '0023_compute_job_operation', '0024_compute_job_file_evidence', '0025_managed_file_version_foundation', '0026_compute_job_remote_cleanup', '0027_project_session_defaults', '0028_database_numeric_and_null_constraints')`
      )
      await client.$executeRawUnsafe(`INSERT INTO "ComputeJob" (
        "id", "providerId", "shape", "sessionId", "projectId", "status", "intent",
        "command", "commandHash", "analysisState", "analysisMessageId", "analysisUpdatedAt"
      ) VALUES (
        'invalid-analysis-state', 'ssh:legacy', 'direct_ssh', 'legacy-session', 'legacy-project',
        'success', 'invalid analysis state', 'true', 'invalid-analysis-state', 'unknown',
        'message-1', '2026-01-01T00:00:00.000Z'
      )`)

      await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
        migrationId: '0021_compute_job_analysis_constraints'
      })
      await expect(
        client.$queryRawUnsafe<Array<{ analysisState: string }>>(
          `SELECT "analysisState" FROM "ComputeJob" WHERE "id" = 'invalid-analysis-state'`
        )
      ).resolves.toEqual([{ analysisState: 'unknown' }])
    } finally {
      await client.$disconnect()
      await rm(root, { force: true, recursive: true })
    }
  })

  it('blocks the global Memory index without deleting duplicate historical entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-ledger-memory-duplicate-'))
    const databasePath = join(root, 'open-science.db').replaceAll('\\', '/')
    const client = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } })

    try {
      await migrateApplicationDatabase(client)
      await client.$executeRawUnsafe('DROP INDEX "MemoryEntry_global_contentKey_key"')
      await client.$executeRawUnsafe(
        `DELETE FROM "_open_science_migrations" WHERE "id" IN ('0022_memory_global_content_unique', '0023_compute_job_operation', '0024_compute_job_file_evidence', '0025_managed_file_version_foundation', '0026_compute_job_remote_cleanup', '0027_project_session_defaults', '0028_database_numeric_and_null_constraints')`
      )
      await client.memoryEntry.createMany({
        data: [
          {
            id: 'duplicate-global-1',
            categoryId: 'memory-category-about-you',
            content: 'same global fact',
            contentKey: 'same global fact',
            origin: 'user'
          },
          {
            id: 'duplicate-global-2',
            categoryId: 'memory-category-about-you',
            content: 'Same global fact',
            contentKey: 'same global fact',
            origin: 'user'
          }
        ]
      })

      await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
        migrationId: '0022_memory_global_content_unique'
      })
      await expect(
        client.memoryEntry.count({ where: { contentKey: 'same global fact', projectId: null } })
      ).resolves.toBe(2)
    } finally {
      await client.$disconnect()
      await rm(root, { force: true, recursive: true })
    }
  })

  it('adds usage attribution columns without changing existing usage rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-ledger-usage-attribution-'))
    const databasePath = join(root, 'open-science.db').replaceAll('\\', '/')
    const client = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } })

    try {
      await migrateApplicationDatabase(client)
      await client.project.create({
        data: { id: 'legacy-project', name: 'Legacy project' }
      })
      await client.session.create({
        data: {
          id: 'legacy-session',
          number: 1,
          projectId: 'legacy-project',
          title: 'Legacy session',
          status: 'idle',
          presentedStatus: 'idle',
          createdAtMs: 1n,
          updatedAtMs: 2n
        }
      })
      await client.sessionTurnUsage.create({
        data: {
          sessionId: 'legacy-session',
          messageId: 'legacy-message',
          completedAtMs: 2n,
          inputTokens: 10n,
          cacheTokens: 3n,
          outputTokens: 4n,
          isRootFrame: true
        }
      })
      await client.sessionModelCallUsage.create({
        data: {
          sessionId: 'legacy-session',
          messageId: 'legacy-message',
          callId: 'legacy-call',
          callIndex: 0,
          inputTokens: 10n,
          cacheTokens: 3n,
          outputTokens: 4n
        }
      })
      await client.sessionAuxiliaryTurnUsage.create({
        data: {
          sessionId: 'legacy-session',
          eventId: 'legacy-event',
          source: 'side-chat',
          frameworkId: 'claude-agent-sdk',
          completedAtMs: 3n,
          inputTokens: 5n,
          cacheTokens: 1n,
          outputTokens: 2n
        }
      })

      await client.$executeRawUnsafe('ALTER TABLE "SessionTurnUsage" DROP COLUMN "frameworkId"')
      await client.$executeRawUnsafe('ALTER TABLE "SessionTurnUsage" DROP COLUMN "providerId"')
      await client.$executeRawUnsafe('ALTER TABLE "SessionTurnUsage" DROP COLUMN "model"')
      await client.$executeRawUnsafe('ALTER TABLE "SessionModelCallUsage" DROP COLUMN "providerId"')
      await client.$executeRawUnsafe(
        'ALTER TABLE "SessionAuxiliaryTurnUsage" DROP COLUMN "providerId"'
      )
      await client.$executeRawUnsafe(
        `DELETE FROM "_open_science_migrations" WHERE "id" IN ('0019_session_usage_attribution', '0020_compute_job_analysis_state', '0021_compute_job_analysis_constraints', '0022_memory_global_content_unique', '0023_compute_job_operation', '0024_compute_job_file_evidence', '0025_managed_file_version_foundation', '0026_compute_job_remote_cleanup', '0027_project_session_defaults', '0028_database_numeric_and_null_constraints')`
      )
      await rebuildComputeJobWithoutAnalysisConstraints(client, true)

      await migrateApplicationDatabase(client)

      await expect(
        client.sessionTurnUsage.findUnique({
          where: {
            sessionId_messageId: { sessionId: 'legacy-session', messageId: 'legacy-message' }
          }
        })
      ).resolves.toMatchObject({
        frameworkId: null,
        providerId: null,
        model: null,
        inputTokens: 10n,
        outputTokens: 4n
      })
      await expect(
        client.sessionModelCallUsage.findUnique({
          where: { sessionId_callId: { sessionId: 'legacy-session', callId: 'legacy-call' } }
        })
      ).resolves.toMatchObject({ providerId: null, inputTokens: 10n, outputTokens: 4n })
      await expect(
        client.sessionAuxiliaryTurnUsage.findUnique({
          where: { sessionId_eventId: { sessionId: 'legacy-session', eventId: 'legacy-event' } }
        })
      ).resolves.toMatchObject({
        providerId: null,
        frameworkId: 'claude-agent-sdk',
        inputTokens: 5n,
        outputTokens: 2n
      })
    } finally {
      await client.$disconnect()
      await rm(root, { force: true, recursive: true })
    }
  })

  it('adds Review query indexes without changing existing Review or Finding rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-ledger-review-indexes-'))
    const databasePath = join(root, 'open-science.db').replaceAll('\\', '/')
    const client = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } })

    try {
      await migrateApplicationDatabase(client)
      const review = await client.review.create({
        data: {
          id: 'legacy-review',
          projectId: 'legacy-project',
          sessionId: 'legacy-session',
          turnMessageId: 'legacy-turn'
        }
      })
      const finding = await client.finding.create({
        data: { id: 'legacy-finding', reviewId: review.id }
      })
      await client.$executeRawUnsafe('DROP INDEX "Review_projectId_sessionId_createdAt_idx"')
      await client.$executeRawUnsafe('DROP INDEX "Review_sessionId_idx"')
      await client.$executeRawUnsafe('DROP INDEX "Finding_reviewId_idx"')
      await client.$executeRawUnsafe(
        `DELETE FROM "_open_science_migrations"
         WHERE "id" IN (
           '0014_review_query_indexes',
           '0015_session_model_call_usage',
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
         )`
      )
      await rebuildComputeJobWithoutAnalysisConstraints(client, true)
      await client.$executeRawUnsafe(
        'ALTER TABLE "ComputeJob" DROP COLUMN "sensitiveDataEncrypted"'
      )

      await migrateApplicationDatabase(client)

      await expect(client.review.findUnique({ where: { id: review.id } })).resolves.toBeTruthy()
      await expect(client.finding.findUnique({ where: { id: finding.id } })).resolves.toBeTruthy()
      const indexes = await client.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT "name" FROM "sqlite_schema"
         WHERE "type" = 'index'
           AND "name" IN ('Review_projectId_sessionId_createdAt_idx', 'Review_sessionId_idx', 'Finding_reviewId_idx')
         ORDER BY "name"`
      )
      expect(indexes.map(({ name }) => name)).toEqual([
        'Finding_reviewId_idx',
        'Review_projectId_sessionId_createdAt_idx',
        'Review_sessionId_idx'
      ])
    } finally {
      await client.$disconnect()
      await rm(root, { force: true, recursive: true })
    }
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

  it('applies the compute authentication persistence columns and named checks to a legacy database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-ledger-auth-persistence-'))
    await seedLegacyDatabase(root)
    const databasePath = join(root, 'open-science.db').replaceAll('\\', '/')
    const client = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } })

    try {
      await migrateApplicationDatabase(client)

      const jobColumns = await client.$queryRawUnsafe<Array<{ name: string }>>(
        `PRAGMA table_info('ComputeJob')`
      )
      const credentialColumns = await client.$queryRawUnsafe<Array<{ name: string; pk: bigint }>>(
        `PRAGMA table_info('ComputeCredential')`
      )
      const operationColumns = await client.$queryRawUnsafe<
        Array<{ name: string; notnull: bigint; dflt_value: string | null }>
      >(`PRAGMA table_info('ComputeAuthOperation')`)
      expect(jobColumns.map(({ name }) => name)).not.toContain('lastHarvestError')
      expect(credentialColumns.map(({ name }) => name)).not.toContain('id')
      expect(credentialColumns.find(({ name }) => name === 'computeHostId')).toMatchObject({
        pk: 1n
      })
      expect(operationColumns.map(({ name }) => name)).toEqual(
        expect.arrayContaining(['operationKind', 'requestFingerprint'])
      )
      expect(operationColumns.find(({ name }) => name === 'operationKind')).toMatchObject({
        notnull: 1n,
        dflt_value: null
      })
      expect(operationColumns.find(({ name }) => name === 'requestFingerprint')).toMatchObject({
        notnull: 1n
      })

      const tableSchemas = await client.$queryRawUnsafe<Array<{ name: string; sql: string }>>(
        `SELECT "name", "sql" FROM "sqlite_schema"
         WHERE "type" = 'table' AND "name" IN ('ComputeHost', 'ComputeAuthOperation')`
      )
      const schemaByTable = new Map(tableSchemas.map(({ name, sql }) => [name, sql]))
      expect(schemaByTable.get('ComputeHost')).toContain(
        'CONSTRAINT "ComputeHost_authenticationMode_check"'
      )
      expect(schemaByTable.get('ComputeHost')).toContain(
        'CONSTRAINT "ComputeHost_authenticationRevision_check"'
      )
      expect(schemaByTable.get('ComputeAuthOperation')).toContain(
        'CONSTRAINT "ComputeAuthOperation_resultRevision_check"'
      )
      expect(schemaByTable.get('ComputeAuthOperation')).toContain(
        'CONSTRAINT "ComputeAuthOperation_operationKind_check"'
      )
      expect(schemaByTable.get('ComputeAuthOperation')).not.toContain("'legacy'")
    } finally {
      await client.$disconnect()
      await rm(root, { force: true, recursive: true })
    }
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
