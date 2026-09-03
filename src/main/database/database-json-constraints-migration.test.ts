import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient } from '../projects/prisma-client'
import { MIGRATION_MANIFEST, migrateApplicationDatabase } from './migration-service'
import { applySqliteMigrationOperations } from './sqlite-schema-migrations'

const MIGRATION_ID = '0008_database_json_constraints'
// Hosted Windows runners rebuild tables and copy SQLite backups under disk
// contention. The Windows full-test workflow default is 60s; these suites
// finish later without hanging.
const WINDOWS_SQLITE_TEST_TIMEOUT_MS = 120_000

const createDatabaseAtMigration0007 = async (client: PrismaClient): Promise<void> => {
  const migration0008Index = MIGRATION_MANIFEST.findIndex(
    (migration) => migration.id === MIGRATION_ID
  )
  const prefix = MIGRATION_MANIFEST.slice(0, migration0008Index)
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

const seedValidAffectedRows = async (client: PrismaClient): Promise<void> => {
  await client.$executeRawUnsafe(
    `INSERT INTO "Project" ("id","name","updatedAt") VALUES ('project','Project',CURRENT_TIMESTAMP)`
  )
  await client.$executeRawUnsafe(
    `INSERT INTO "ProjectPreviewState" ("projectId","panelState","items","updatedAt") VALUES ('project','collapsed','[{"id":"preview"}]',CURRENT_TIMESTAMP)`
  )
  await client.$executeRawUnsafe(
    `INSERT INTO "NotificationInboxItem" ("sequence","id","dedupeKey","kind","sessionId","originId","title","summary") VALUES (11,'notification','notification','task.completed','session','origin','Title','Summary')`
  )
  await client.$executeRawUnsafe(
    `INSERT INTO "Review" ("id","projectId","sessionId","turnMessageId","lifecycle","scope","reviewerLog","updatedAt") VALUES ('review','project','session','message','running','{"paths":["result.txt"]}','[{"event":"started"}]',CURRENT_TIMESTAMP)`
  )
  await client.$executeRawUnsafe(
    `INSERT INTO "Finding" ("id","reviewId","status","locator") VALUES ('finding','review','warn','{"path":"result.txt"}')`
  )
  await client.$executeRawUnsafe(
    `INSERT INTO "ReviewFindingDisposition" ("id","sourceFindingId","sequence","trigger","outcome","assessmentSnapshot") VALUES ('disposition','finding',1,'aborted','unaddressed','{"reason":"stopped"}')`
  )
  await client.$executeRawUnsafe(
    `INSERT INTO "ReviewScopeSnapshot" ("id","projectId","sessionId","reviewId","scopeTurnMessageId","snapshotJson","checksum","storageKey","blockCount") VALUES ('scope-snapshot','project','session','review','message','{"blocks":[]}','checksum','snapshot.json',0)`
  )
  await client.$executeRawUnsafe(
    `INSERT INTO "FileOriginSession" ("projectId","sessionId","updatedAt") VALUES ('project','session',CURRENT_TIMESTAMP)`
  )
  await client.$executeRawUnsafe(
    `INSERT INTO "ArtifactLineage" ("id","projectId","sessionId","normalizedFilename","filename","updatedAt") VALUES ('lineage','project','session','result.txt','result.txt',CURRENT_TIMESTAMP)`
  )
  await client.$executeRawUnsafe(
    `INSERT INTO "ArtifactVersion" (
      "id","artifactId","versionNumber","filename","artifactRunId","rootFrameId","agentFrameId",
      "messageBranchId","runtimeSegmentId","promptMessageId","state","contentStorageKey",
      "evidenceStorageKey","sizeBytes","checksum","evidenceJson","evidenceChecksum","updatedAt"
    ) VALUES (
      'version','lineage',1,'result.txt','run','root','agent','branch','segment','prompt','staging',
      'content','evidence.json',0,'checksum','{"sources":[]}','evidence-checksum',CURRENT_TIMESTAMP
    )`
  )
  await client.$executeRawUnsafe(
    `INSERT INTO "ArtifactVersionInput" (
      "id","artifactVersionId","ordinal","inputFileVersionId","sourceKind","sourceFileId",
      "sourceArtifactVersionId","sourceProjectId","sourceSessionId","filename","sizeBytes",
      "checksum","storageKey","strongestAssociation"
    ) VALUES (
      'input','version',0,'version','artifact-version','lineage','version','project','session',
      'result.txt',0,'checksum','content','turn-attached'
    )`
  )
  await client.$executeRawUnsafe(
    `INSERT INTO "ManagedFile" (
      "seq","source","sourceFileId","projectId","sessionId","displayName","storageKey",
      "sizeBytes","sortAtMs","updatedAt"
    ) VALUES (13,'artifact','lineage','project','session','result.txt','content',0,0,CURRENT_TIMESTAMP)`
  )
  await client.$executeRawUnsafe(
    `INSERT INTO "ComputeJob" (
      "id","providerId","shape","sessionId","projectId","status","intent","command","commandHash",
      "resourceRequest","inputManifest","outputManifest","harvestConfig","remoteHandle"
    ) VALUES (
      'job','ssh:host','direct_ssh','session','project','submitted','intent','command','hash',
      '{"cpu":1}','[]','[]','{}','{"jobId":"remote"}'
    )`
  )
  await client.$executeRawUnsafe(
    `INSERT INTO "ComputeHost" ("id","providerId","displayName","sshAlias","sshOverrides","probeResult","updatedAt") VALUES ('host','ssh:host','Host','host','{}','{"reachable":true}',CURRENT_TIMESTAMP)`
  )
}

describe('database JSON constraints migration', () => {
  let storageRoot: string | undefined
  let client: PrismaClient | undefined

  afterEach(async () => {
    await client?.$disconnect()
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  })

  it(
    'preserves valid rows, indexes, foreign keys, and AUTOINCREMENT boundaries',
    async () => {
      storageRoot = await mkdtemp(join(tmpdir(), 'open-science-json-0008-'))
      const databasePath = join(storageRoot, 'open-science.db')
      client = createProjectDbClient(storageRoot)
      await createDatabaseAtMigration0007(client)
      await seedValidAffectedRows(client)
      await client.$executeRawUnsafe(
        `INSERT INTO "NotificationInboxItem" ("sequence","id","dedupeKey","kind","originId","title","summary") VALUES (41,'deleted-notification','deleted-notification','task.completed','deleted-origin','Title','Summary')`
      )
      await client.$executeRawUnsafe(
        `DELETE FROM "NotificationInboxItem" WHERE "id" = 'deleted-notification'`
      )
      await client.$executeRawUnsafe(`DELETE FROM "ManagedFile"`)
      await client.$executeRawUnsafe(
        `INSERT INTO "ManagedFile" (
        "seq","source","sourceFileId","projectId","sessionId","displayName","storageKey",
        "sizeBytes","sortAtMs","updatedAt"
      ) VALUES (43,'upload','deleted-file','project','session','deleted.txt','deleted-content',0,0,CURRENT_TIMESTAMP)`
      )
      await client.$executeRawUnsafe(`DELETE FROM "ManagedFile"`)

      await expect(migrateApplicationDatabase(client, { databasePath })).resolves.toEqual({
        adoptedLegacy: false,
        applied: [
          MIGRATION_ID,
          '0009_vision_evidence',
          '0010_compute_password_auth',
          '0011_cross_resource_tags',
          '0012_tag_ordering',
          '0013_session_projection',
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
          '0027_project_session_defaults'
        ],
        from: '0007_notification_attention_metadata',
        to: '0027_project_session_defaults'
      })
      await expect(access(`${databasePath}.before-${MIGRATION_ID}.backup`)).resolves.toBeUndefined()
      await expect(
        access(`${databasePath}.before-0011_cross_resource_tags.backup`)
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(`${databasePath}.before-0012_tag_ordering.backup`)).rejects.toMatchObject(
        {
          code: 'ENOENT'
        }
      )
      await expect(
        access(`${databasePath}.before-0013_session_projection.backup`)
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(
        access(`${databasePath}.before-0014_review_query_indexes.backup`)
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(
        access(`${databasePath}.before-0015_session_model_call_usage.backup`)
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(
        access(`${databasePath}.before-0016_compute_job_sensitive_data_encryption.backup`)
      ).rejects.toMatchObject({ code: 'ENOENT' })
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
        client.$queryRaw<Array<{ scope: string; reviewerLog: string }>>`
        SELECT "scope", "reviewerLog" FROM "Review" WHERE "id" = 'review'
      `
      ).resolves.toEqual([
        { scope: '{"paths":["result.txt"]}', reviewerLog: '[{"event":"started"}]' }
      ])
      await expect(
        client.$queryRaw<Array<{ evidenceJson: string; strongestAssociation: string }>>`
        SELECT "ArtifactVersion"."evidenceJson", "ArtifactVersionInput"."strongestAssociation"
        FROM "ArtifactVersion"
        JOIN "ArtifactVersionInput"
          ON "ArtifactVersionInput"."artifactVersionId" = "ArtifactVersion"."id"
        WHERE "ArtifactVersion"."id" = 'version'
      `
      ).resolves.toEqual([
        { evidenceJson: '{"sources":[]}', strongestAssociation: 'turn-attached' }
      ])
      await expect(client.$queryRawUnsafe('PRAGMA foreign_key_check')).resolves.toEqual([])

      await client.$executeRawUnsafe(
        `INSERT INTO "NotificationInboxItem" ("id","dedupeKey","kind","originId","title","summary") VALUES ('next-notification','next-notification','task.completed','next-origin','Title','Summary')`
      )
      await client.$executeRawUnsafe(
        `INSERT INTO "ManagedFile" (
        "source","sourceFileId","projectId","sessionId","displayName","storageKey",
        "sizeBytes","sortAtMs","updatedAt"
      ) VALUES ('upload','next-file','project','session','next.txt','next-content',0,1,CURRENT_TIMESTAMP)`
      )
      await expect(
        client.$queryRaw<Array<{ sequence: number }>>`
        SELECT "sequence" FROM "NotificationInboxItem" WHERE "id" = 'next-notification'
      `
      ).resolves.toEqual([{ sequence: 42 }])
      await expect(
        client.$queryRaw<Array<{ seq: number }>>`
        SELECT "seq" FROM "ManagedFile" WHERE "sourceFileId" = 'next-file'
      `
      ).resolves.toEqual([{ seq: 44 }])
    },
    WINDOWS_SQLITE_TEST_TIMEOUT_MS
  )

  it(
    'fails closed and rolls back all rebuilt tables when historical data is invalid',
    async () => {
      storageRoot = await mkdtemp(join(tmpdir(), 'open-science-json-0008-invalid-'))
      const databasePath = join(storageRoot, 'open-science.db')
      client = createProjectDbClient(storageRoot)
      await createDatabaseAtMigration0007(client)
      await client.$executeRawUnsafe(
        `INSERT INTO "Project" ("id","name","updatedAt") VALUES ('project','Project',CURRENT_TIMESTAMP)`
      )
      await client.$executeRawUnsafe(
        `INSERT INTO "ProjectPreviewState" ("projectId","panelState","items","updatedAt") VALUES ('project','collapsed','[]',CURRENT_TIMESTAMP)`
      )
      await client.$executeRawUnsafe(
        `INSERT INTO "NotificationInboxItem" ("id","dedupeKey","kind","originId","title","summary") VALUES ('invalid','invalid','custom.kind','origin','Title','Summary')`
      )

      await expect(migrateApplicationDatabase(client, { databasePath })).rejects.toMatchObject({
        code: 'database_validation_failed',
        migrationId: MIGRATION_ID
      })
      await expect(
        client.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "_open_science_migrations" ORDER BY "id" DESC LIMIT 1
      `
      ).resolves.toEqual([{ id: '0007_notification_attention_metadata' }])
      await expect(
        client.$queryRaw<Array<{ kind: string }>>`
        SELECT "kind" FROM "NotificationInboxItem" WHERE "id" = 'invalid'
      `
      ).resolves.toEqual([{ kind: 'custom.kind' }])
      await expect(
        client.$queryRaw<Array<{ sql: string }>>`
        SELECT "sql" FROM "sqlite_schema" WHERE "type" = 'table' AND "name" = 'ProjectPreviewState'
      `
      ).resolves.not.toEqual([
        expect.objectContaining({
          sql: expect.stringContaining('ProjectPreviewState_panelState_check')
        })
      ])
      await expect(access(`${databasePath}.before-${MIGRATION_ID}.backup`)).resolves.toBeUndefined()
    },
    WINDOWS_SQLITE_TEST_TIMEOUT_MS
  )
})
