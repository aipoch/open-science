import { access, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient } from '../projects/prisma-client'
import { RUNTIME_SCHEMA_TABLE_DDL_BY_NAME } from './migrations/0001-runtime-schema-baseline'
import {
  BASELINE_CHECKSUM,
  MIGRATION_MANIFEST,
  PROJECT_AGENT_CONTEXT_CHECKSUM,
  checksumMigrationPayload,
  classifyDatabaseFailure,
  migrateApplicationDatabase,
  migrateApplicationDatabaseWithManifest,
  verifyCurrentApplicationSchema,
  type MigrationManifestEntry
} from './migration-service'

const futureTestMigration = (): MigrationManifestEntry => {
  const id = '0017_test_suffix'
  const statements = [`UPDATE "Project" SET "name" = "name" WHERE 0`] as const
  const verifiers = [{ kind: 'table-exists', version: 1, table: 'Project' }] as const
  return {
    id,
    statements,
    verifiers,
    checksum: checksumMigrationPayload(id, statements, verifiers),
    backupOnApply: 'none',
    backupRetention: 'retain'
  }
}

const createDatabaseAtMigration0005 = async (client: PrismaClient): Promise<void> => {
  const migration0006Index = MIGRATION_MANIFEST.findIndex(
    (migration) => migration.id === '0006_database_domain_constraints'
  )
  const prefix = MIGRATION_MANIFEST.slice(0, migration0006Index)
  for (const migration of prefix) {
    if ('operations' in migration && migration.operations.length > 0) {
      throw new Error(`Unexpected operation in ${migration.id} test prefix.`)
    }
    for (const statement of migration.statements) await client.$executeRawUnsafe(statement)
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

const removeComputePasswordAuthSchema = async (client: PrismaClient): Promise<void> => {
  await client.$executeRawUnsafe('DROP TABLE "ComputeCredential"')
  await client.$executeRawUnsafe('DROP TABLE "ComputeAuthOperation"')
  await client.$executeRawUnsafe('DROP TABLE "ComputeHost"')
  await client.$executeRawUnsafe(`CREATE TABLE "ComputeHost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "shape" TEXT NOT NULL DEFAULT 'direct_ssh',
    "sshAlias" TEXT NOT NULL,
    "sshOverrides" TEXT,
    "scratchRoot" TEXT,
    "scratchPinned" BOOLEAN NOT NULL DEFAULT false,
    "concurrencyLimit" INTEGER,
    "probeResult" TEXT,
    "detailsDoc" TEXT NOT NULL DEFAULT '',
    "detailsUpdatedAt" DATETIME,
    "detailsUpdatedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  )`)
  await client.$executeRawUnsafe(
    'CREATE UNIQUE INDEX "ComputeHost_providerId_key" ON "ComputeHost"("providerId")'
  )
}

const removeAgentMemoryTriggers = async (client: PrismaClient): Promise<void> => {
  await client.$executeRawUnsafe('DROP TRIGGER "MemoryEntry_fts_insert"')
  await client.$executeRawUnsafe('DROP TRIGGER "MemoryEntry_fts_delete"')
  await client.$executeRawUnsafe('DROP TRIGGER "MemoryEntry_fts_update"')
  await client.$executeRawUnsafe('DROP TRIGGER "MemoryCategory_about_you_delete"')
  await client.$executeRawUnsafe('DROP TRIGGER "MemoryCategory_about_you_update"')
  await client.$executeRawUnsafe('DROP TRIGGER "MemoryCategory_custom_limit"')
  await client.$executeRawUnsafe('DROP TABLE "MemoryEntryFts"')
}

const LEGACY_PERMISSION_GRANT_TABLE_DDL = `CREATE TABLE "PermissionGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "capabilityKind" TEXT NOT NULL,
    "capabilityKey" TEXT NOT NULL,
    "qualifierMode" TEXT NOT NULL DEFAULT 'none',
    "qualifierValue" TEXT,
    "scopeKind" TEXT NOT NULL,
    "projectId" TEXT,
    "sessionId" TEXT,
    "fingerprint" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME,
    CONSTRAINT "PermissionGrant_capabilityKind_check" CHECK ("capabilityKind" IN ('customize_mutation', 'mcp_tool', 'execution', 'file_operation', 'skill_operation', 'builtin_tool')),
    CONSTRAINT "PermissionGrant_capabilityKey_check" CHECK (length(trim("capabilityKey")) > 0),
    CONSTRAINT "PermissionGrant_qualifier_check" CHECK (
      ("qualifierMode" IN ('none', 'any') AND "qualifierValue" IS NULL) OR
      ("qualifierMode" IN ('category', 'exact') AND "qualifierValue" IS NOT NULL AND length(trim("qualifierValue")) > 0)
    ),
    CONSTRAINT "PermissionGrant_scope_check" CHECK (
      ("scopeKind" = 'global' AND "projectId" IS NULL AND "sessionId" IS NULL) OR
      ("scopeKind" = 'project' AND "projectId" IS NOT NULL AND "sessionId" IS NULL) OR
      ("scopeKind" = 'session' AND "projectId" IS NOT NULL AND "sessionId" IS NOT NULL)
    ),
    CONSTRAINT "PermissionGrant_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "PermissionGrant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`

const LEGACY_ARTIFACT_VERSION_INPUT_TABLE_DDL = `CREATE TABLE "ArtifactVersionInput" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "artifactVersionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "inputFileVersionId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceFileId" TEXT NOT NULL,
    "sourceArtifactVersionId" TEXT,
    "sourceUploadVersionId" TEXT,
    "sourceVersionNumber" INTEGER,
    "sourceCreatedAt" DATETIME,
    "sourceProjectId" TEXT NOT NULL,
    "sourceSessionId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT,
    "sizeBytes" BIGINT NOT NULL,
    "checksum" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "strongestAssociation" TEXT NOT NULL,
    CONSTRAINT "ArtifactVersionInput_sourceKind_check" CHECK ("sourceKind" IN ('artifact-version', 'upload-version')),
    CONSTRAINT "ArtifactVersionInput_sourceIdentity_check" CHECK (
      ("sourceKind" = 'artifact-version' AND "sourceArtifactVersionId" IS NOT NULL AND "sourceUploadVersionId" IS NULL AND "inputFileVersionId" = "sourceArtifactVersionId") OR
      ("sourceKind" = 'upload-version' AND "sourceUploadVersionId" IS NOT NULL AND "sourceArtifactVersionId" IS NULL AND "inputFileVersionId" = "sourceUploadVersionId")
    ),
    CONSTRAINT "ArtifactVersionInput_artifactVersionId_fkey" FOREIGN KEY ("artifactVersionId") REFERENCES "ArtifactVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersionInput_sourceArtifactVersionId_fkey" FOREIGN KEY ("sourceArtifactVersionId") REFERENCES "ArtifactVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersionInput_sourceUploadVersionId_fkey" FOREIGN KEY ("sourceUploadVersionId") REFERENCES "UploadVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersionInput_sourceProjectId_sourceSessionId_fkey" FOREIGN KEY ("sourceProjectId", "sourceSessionId") REFERENCES "FileOriginSession" ("projectId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE
);`

describe('application database migrations', () => {
  let storageRoot: string | undefined
  let client: PrismaClient | undefined

  afterEach(async () => {
    await client?.$disconnect()
    if (storageRoot) await rm(storageRoot, { force: true, recursive: true })
  })

  it.each([
    {
      name: 'missing Prisma engine',
      error: Object.assign(new Error('runtime failed'), {
        name: 'PrismaClientInitializationError',
        code: 'ENOENT'
      }),
      phase: 'open' as const,
      expected: { code: 'database_runtime_unavailable', retryable: false }
    },
    {
      name: 'read-only database',
      error: Object.assign(new Error('attempt to write a readonly database'), { code: 'P2010' }),
      phase: 'migration' as const,
      expected: { code: 'database_migration_failed', retryable: true }
    },
    {
      name: 'locked database',
      error: Object.assign(new Error('write failed'), { code: 'SQLITE_BUSY' }),
      phase: 'migration' as const,
      expected: { code: 'database_migration_failed', retryable: true }
    },
    {
      name: 'full disk',
      error: Object.assign(new Error('database or disk is full'), { code: 'P2010' }),
      phase: 'migration' as const,
      expected: { code: 'database_migration_failed', retryable: true }
    }
  ])('classifies a $name without exposing engine text', ({ error, phase, expected }) => {
    const classified = classifyDatabaseFailure(error, phase)

    expect(classified).toMatchObject(expected)
    expect(classified.message).not.toContain(error.message)
  })

  it('uses a platform-neutral checksum for the frozen baseline payload', () => {
    expect(BASELINE_CHECKSUM).toBe(
      'e29d0483786c3ed2e1c9cd358369b254a54ccf54213931c5ef71a8fd4e161525'
    )
    expect(PROJECT_AGENT_CONTEXT_CHECKSUM).toBe(
      'f3b29cf4543d1739a0cd211ddea172dcfd18aa9d7c8f94d520913ab88cb977c6'
    )
    const verifier = [{ kind: 'table-exists', version: 1, table: 'probe' }] as const
    expect(checksumMigrationPayload('0001_test', ['one\r\ntwo'], verifier)).toBe(
      checksumMigrationPayload('0001_test', ['one\ntwo'], verifier)
    )
    expect(
      checksumMigrationPayload(
        '0001_test',
        [],
        [{ kind: 'table-exists', version: 1, table: 'probe\r\nname' }]
      )
    ).toBe(
      checksumMigrationPayload(
        '0001_test',
        [],
        [{ kind: 'table-exists', version: 1, table: 'probe\nname' }]
      )
    )
    const operation = (canonicalTableDdl: string) =>
      [
        {
          kind: 'rebuild-table-set',
          version: 1,
          tables: [{ tableName: 'Probe', canonicalTableDdl, columns: ['id'] }],
          dropOrder: ['Probe'],
          indexes: []
        }
      ] as const
    expect(checksumMigrationPayload('0001_test', [], verifier, operation('one\r\ntwo'))).toBe(
      checksumMigrationPayload('0001_test', [], verifier, operation('one\ntwo'))
    )
  })

  it('records the runtime baseline once for a fresh database', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open science 数据 baseline-'))
    client = createProjectDbClient(storageRoot)
    const compatibility: Array<{ sqliteVersion: string }> = []

    await expect(
      migrateApplicationDatabase(client, {
        onCompatibilityVerified: (value) => compatibility.push(value)
      })
    ).resolves.toEqual({
      adoptedLegacy: false,
      applied: [
        '0001_runtime_schema_baseline',
        '0002_project_agent_context',
        '0003_granted_local_roots',
        '0004_review_assessment_snapshots',
        '0005_project_preview_state_owner_fk',
        '0006_database_domain_constraints',
        '0007_notification_attention_metadata',
        '0008_database_json_constraints',
        '0009_vision_evidence',
        '0010_compute_password_auth',
        '0011_cross_resource_tags',
        '0012_tag_ordering',
        '0013_session_projection',
        '0014_review_query_indexes',
        '0015_session_model_call_usage',
        '0016_agent_memory_project_scope'
      ],
      from: null,
      to: '0016_agent_memory_project_scope'
    })
    expect(compatibility).toEqual([{ sqliteVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/) }])
    await expect(
      client.project.create({ data: { id: 'project-1', name: 'Project' } })
    ).resolves.toMatchObject({ id: 'project-1' })

    await client.$disconnect()
    client = createProjectDbClient(storageRoot)

    await expect(migrateApplicationDatabase(client)).resolves.toEqual({
      adoptedLegacy: false,
      applied: [],
      from: '0016_agent_memory_project_scope',
      to: '0016_agent_memory_project_scope'
    })
  })

  it('materializes the generated current target after applying the full manifest', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-current-target-'))
    client = createProjectDbClient(storageRoot)

    await migrateApplicationDatabase(client)

    await expect(verifyCurrentApplicationSchema(client)).resolves.toBeUndefined()
  })

  it('rejects the obsolete pre-release agent memory ledger without rewriting it', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-pre-release-memory-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.memoryEntry.create({
      data: {
        id: 'memory-1',
        categoryId: 'memory-category-about-you',
        content: 'Prefers concise answers',
        contentKey: 'prefers concise answers',
        origin: 'user'
      }
    })
    await client.$executeRawUnsafe(
      `UPDATE "_open_science_migrations" SET "id" = ?, "checksum" = ? WHERE "id" = ?`,
      '0016_agent_memory',
      '43bd42fc137a0a88fb513f701db6e3e19ed3bdb5b8ead5691b5fad3fb68fb01a',
      '0016_agent_memory_project_scope'
    )

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_history_invalid',
      migrationId: '0016_agent_memory'
    })
    await expect(
      client.memoryEntry.findMany({ orderBy: { id: 'asc' }, select: { id: true, content: true } })
    ).resolves.toEqual([{ id: 'memory-1', content: 'Prefers concise answers' }])
    await expect(
      client.$queryRaw<Array<{ checksum: string; id: string }>>`
        SELECT "id", "checksum" FROM "_open_science_migrations"
        WHERE "id" IN ('0016_agent_memory', '0016_agent_memory_project_scope')
      `
    ).resolves.toEqual([
      {
        id: '0016_agent_memory',
        checksum: '43bd42fc137a0a88fb513f701db6e3e19ed3bdb5b8ead5691b5fad3fb68fb01a'
      }
    ])
  })

  it('keeps historical aggregate-only turn usage when adding exact model-call storage', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-model-call-usage-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.$executeRawUnsafe('DROP TABLE "SessionModelCallUsage"')
    await client.$executeRawUnsafe('ALTER TABLE "SessionTurnUsage" DROP COLUMN "cachedReadTokens"')
    await client.$executeRawUnsafe('ALTER TABLE "SessionTurnUsage" DROP COLUMN "cachedWriteTokens"')
    await client.$executeRawUnsafe('ALTER TABLE "SessionTurnUsage" DROP COLUMN "modelCallCount"')
    await client.$executeRawUnsafe(
      `DELETE FROM "_open_science_migrations" WHERE "id" IN ('0015_session_model_call_usage', '0016_agent_memory_project_scope')`
    )
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    await client.$executeRawUnsafe(`INSERT INTO "Session" (
      "id", "number", "projectId", "title", "status", "presentedStatus", "createdAtMs", "updatedAtMs"
    ) VALUES ('session-1', 1, 'project-1', 'Session', 'idle', 'idle', 1, 2)`)
    await client.$executeRawUnsafe(`INSERT INTO "SessionTurnUsage" (
      "sessionId", "messageId", "completedAtMs", "inputTokens", "cacheTokens", "outputTokens", "isRootFrame"
    ) VALUES ('session-1', 'message-1', 2, 10, 4, 3, true)`)

    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
      applied: ['0015_session_model_call_usage', '0016_agent_memory_project_scope']
    })
    await expect(
      client.sessionTurnUsage.findUnique({
        where: { sessionId_messageId: { sessionId: 'session-1', messageId: 'message-1' } }
      })
    ).resolves.toMatchObject({
      cachedReadTokens: null,
      cachedWriteTokens: null,
      modelCallCount: null
    })
    await expect(client.sessionModelCallUsage.count()).resolves.toBe(0)
  })

  it('upgrades a pre-ledger ComputeJob table while preserving historical rows', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-3a-to-current-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "ComputeJob" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "providerId" TEXT NOT NULL,
      "shape" TEXT NOT NULL,
      "sessionId" TEXT NOT NULL,
      "projectId" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'submitted',
      "intent" TEXT NOT NULL,
      "command" TEXT NOT NULL,
      "commandHash" TEXT NOT NULL,
      "environment" TEXT,
      "resourceRequest" TEXT,
      "inputManifest" TEXT,
      "outputManifest" TEXT,
      "harvestConfig" TEXT,
      "timeoutSeconds" INTEGER,
      "remoteWorkdir" TEXT,
      "remoteHandle" TEXT,
      "exitCode" INTEGER,
      "stdoutTail" TEXT,
      "stderrTail" TEXT,
      "errorCode" TEXT,
      "lastPollError" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "submittedAt" DATETIME,
      "startedAt" DATETIME,
      "finishedAt" DATETIME,
      "harvestedAt" DATETIME
    )`)
    await client.$executeRawUnsafe(
      `INSERT INTO "ComputeJob" ("id","providerId","shape","sessionId","projectId","intent","command","commandHash","status","createdAt")
       VALUES ('old-job-1','ssh:test','direct_ssh','s1','p1','legacy intent','echo ok','hash123','submitted',CURRENT_TIMESTAMP)`
    )

    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
      adoptedLegacy: true,
      applied: [
        '0001_runtime_schema_baseline',
        '0002_project_agent_context',
        '0003_granted_local_roots',
        '0004_review_assessment_snapshots',
        '0005_project_preview_state_owner_fk',
        '0006_database_domain_constraints',
        '0007_notification_attention_metadata',
        '0008_database_json_constraints',
        '0009_vision_evidence',
        '0010_compute_password_auth',
        '0011_cross_resource_tags',
        '0012_tag_ordering',
        '0013_session_projection',
        '0014_review_query_indexes',
        '0015_session_model_call_usage',
        '0016_agent_memory_project_scope'
      ]
    })
    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
    await expect(
      client.$queryRaw<
        Array<{
          id: string
          intent: string
          harvestError: string | null
          leftOnRemote: boolean | null
          notifiedAt: Date | null
          notificationConsumedAt: Date | null
        }>
      >`SELECT "id", "intent", "harvestError", "leftOnRemote", "notifiedAt", "notificationConsumedAt"
        FROM "ComputeJob" WHERE "id" = 'old-job-1'`
    ).resolves.toEqual([
      {
        id: 'old-job-1',
        intent: 'legacy intent',
        harvestError: null,
        leftOnRemote: null,
        notifiedAt: null,
        notificationConsumedAt: null
      }
    ])
  })

  it('preserves existing jobs while adding authentication failures idempotently', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-compute-auth-job-errors-'))
    client = createProjectDbClient(storageRoot)
    await createDatabaseAtMigration0005(client)
    await client.$executeRawUnsafe(
      `INSERT INTO "Project" ("id", "name", "updatedAt") VALUES ('project-1', 'Project', CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(`INSERT INTO "ComputeJob" (
      "id", "providerId", "shape", "sessionId", "projectId", "status", "intent",
      "command", "commandHash", "errorCode"
    ) VALUES (
      'job-preserved', 'ssh:host', 'direct_ssh', 'session-1', 'project-1', 'failed',
      'intent', 'command', 'hash', 'job_failed'
    )`)

    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
      applied: expect.arrayContaining(['0010_compute_password_auth']),
      to: '0016_agent_memory_project_scope'
    })
    await expect(
      client.$executeRawUnsafe(
        `UPDATE "ComputeJob" SET "errorCode" = 'authentication_failed' WHERE "id" = 'job-preserved'`
      )
    ).resolves.toBe(1)
    await expect(
      client.$queryRaw<Array<{ id: string; errorCode: string }>>`
        SELECT "id", "errorCode" FROM "ComputeJob" WHERE "id" = 'job-preserved'
      `
    ).resolves.toEqual([{ id: 'job-preserved', errorCode: 'authentication_failed' }])
    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
  })

  it('replays 0006 when its constraint indexes are incomplete', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-0006-index-replay-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.$executeRawUnsafe('DROP INDEX "ComputeJob_status_idx"')
    await removeComputePasswordAuthSchema(client)
    await client.$executeRawUnsafe(`DELETE FROM "_open_science_migrations"
      WHERE "id" IN ('0006_database_domain_constraints', '0007_notification_attention_metadata', '0008_database_json_constraints', '0009_vision_evidence', '0010_compute_password_auth', '0011_cross_resource_tags', '0012_tag_ordering', '0013_session_projection', '0014_review_query_indexes', '0015_session_model_call_usage', '0016_agent_memory_project_scope')`)

    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
      applied: [
        '0006_database_domain_constraints',
        '0007_notification_attention_metadata',
        '0008_database_json_constraints',
        '0009_vision_evidence',
        '0010_compute_password_auth',
        '0011_cross_resource_tags',
        '0012_tag_ordering',
        '0013_session_projection',
        '0014_review_query_indexes',
        '0015_session_model_call_usage',
        '0016_agent_memory_project_scope'
      ],
      from: '0005_project_preview_state_owner_fk',
      to: '0016_agent_memory_project_scope'
    })
    await expect(verifyCurrentApplicationSchema(client)).resolves.toBeUndefined()
  })

  it('upgrades valid 0005 rows while preserving known retired columns', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-0006-upgrade-'))
    client = createProjectDbClient(storageRoot)
    await createDatabaseAtMigration0005(client)
    await client.$executeRawUnsafe('ALTER TABLE "Review" ADD COLUMN "summary" TEXT')
    await client.$executeRawUnsafe('ALTER TABLE "Review" ADD COLUMN "checks" TEXT')
    await client.$executeRawUnsafe('ALTER TABLE "Review" ADD COLUMN "reasoning" TEXT')
    await client.$executeRawUnsafe('ALTER TABLE "Finding" ADD COLUMN "severity" TEXT')
    await client.$executeRawUnsafe(`INSERT INTO "Review" (
      "id", "projectId", "sessionId", "turnMessageId", "lifecycle", "outcome",
      "updatedAt", "summary", "checks", "reasoning"
    ) VALUES (
      'review-1', 'project-1', 'session-1', 'message-1', 'complete', 'pass',
      CURRENT_TIMESTAMP, 'summary', 'checks', 'reasoning'
    )`)
    await client.$executeRawUnsafe(`INSERT INTO "Finding" (
      "id", "reviewId", "status", "resolution", "sortIndex", "reflagCount", "severity"
    ) VALUES ('finding-1', 'review-1', 'warn', 'resolved', 2, 1, 'legacy')`)
    await client.$executeRawUnsafe(`INSERT INTO "ReviewFindingDisposition" (
      "id", "sourceFindingId", "causeReviewId", "sequence", "trigger", "outcome"
    ) VALUES (
      'disposition-1', 'finding-1', 'review-1', 1, 'review_submission', 'resolved'
    )`)
    await client.$executeRawUnsafe(`INSERT INTO "ReviewScopeSnapshot" (
      "id", "projectId", "sessionId", "reviewId", "scopeTurnMessageId", "state",
      "snapshotJson", "checksum", "storageKey", "blockCount"
    ) VALUES (
      'snapshot-1', 'project-1', 'session-1', 'review-1', 'message-1', 'ready',
      '{}', 'checksum', 'snapshot-key', 0
    )`)
    await client.$executeRawUnsafe(`INSERT INTO "ComputeJob" (
      "id", "providerId", "shape", "sessionId", "projectId", "status", "intent",
      "command", "commandHash", "errorCode", "timeoutSeconds", "notifiedAt",
      "notificationConsumedAt"
    ) VALUES (
      'job-1', 'ssh:host', 'direct_ssh', 'session-1', 'project-1', 'failed', 'intent',
      'command', 'hash', 'job_failed', 60, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )`)
    await client.$executeRawUnsafe(`INSERT INTO "ComputeHost" (
      "id", "providerId", "displayName", "shape", "sshAlias", "scratchRoot",
      "scratchPinned", "concurrencyLimit", "detailsUpdatedAt", "detailsUpdatedBy", "updatedAt"
    ) VALUES (
      'host-1', 'ssh:host', 'Host', 'direct_ssh', 'host', '/scratch', true, 2,
      CURRENT_TIMESTAMP, 'user', CURRENT_TIMESTAMP
    )`)
    await client.$executeRawUnsafe(`INSERT INTO "GrantedLocalRoot" (
      "id", "path", "name", "access", "updatedAt"
    ) VALUES ('root-1', '/data', 'Data', 'rw', CURRENT_TIMESTAMP)`)

    await expect(migrateApplicationDatabase(client)).resolves.toEqual({
      adoptedLegacy: false,
      applied: [
        '0006_database_domain_constraints',
        '0007_notification_attention_metadata',
        '0008_database_json_constraints',
        '0009_vision_evidence',
        '0010_compute_password_auth',
        '0011_cross_resource_tags',
        '0012_tag_ordering',
        '0013_session_projection',
        '0014_review_query_indexes',
        '0015_session_model_call_usage',
        '0016_agent_memory_project_scope'
      ],
      from: '0005_project_preview_state_owner_fk',
      to: '0016_agent_memory_project_scope'
    })
    await expect(
      client.$queryRaw<
        Array<{
          summary: string
          checks: string
          reasoning: string
          severity: string
          dispositionCount: bigint
          snapshotCount: bigint
          jobCount: bigint
          hostCount: bigint
          rootCount: bigint
        }>
      >`SELECT
        "Review"."summary", "Review"."checks", "Review"."reasoning", "Finding"."severity",
        (SELECT COUNT(*) FROM "ReviewFindingDisposition") AS "dispositionCount",
        (SELECT COUNT(*) FROM "ReviewScopeSnapshot") AS "snapshotCount",
        (SELECT COUNT(*) FROM "ComputeJob") AS "jobCount",
        (SELECT COUNT(*) FROM "ComputeHost") AS "hostCount",
        (SELECT COUNT(*) FROM "GrantedLocalRoot") AS "rootCount"
      FROM "Review" JOIN "Finding" ON "Finding"."reviewId" = "Review"."id"`
    ).resolves.toEqual([
      {
        summary: 'summary',
        checks: 'checks',
        reasoning: 'reasoning',
        severity: 'legacy',
        dispositionCount: 1n,
        snapshotCount: 1n,
        jobCount: 1n,
        hostCount: 1n,
        rootCount: 1n
      }
    ])
    await expect(
      client.$queryRaw<
        Array<{
          authenticationMode: string
          authenticationRevision: number
          sshAlias: string
          credentialCount: bigint
        }>
      >`SELECT
        "authenticationMode", "authenticationRevision", "sshAlias",
        (SELECT COUNT(*) FROM "ComputeCredential") AS "credentialCount"
      FROM "ComputeHost" WHERE "id" = 'host-1'`
    ).resolves.toEqual([
      {
        authenticationMode: 'ssh_config',
        authenticationRevision: 1,
        sshAlias: 'host',
        credentialCount: 0n
      }
    ])
    await expect(verifyCurrentApplicationSchema(client)).resolves.toBeUndefined()
  })

  it('rolls back 0006 when historical rows violate the new contract', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-0006-invalid-'))
    client = createProjectDbClient(storageRoot)
    await createDatabaseAtMigration0005(client)
    await client.$executeRawUnsafe(`INSERT INTO "Review" (
      "id", "projectId", "sessionId", "turnMessageId", "lifecycle", "updatedAt"
    ) VALUES ('invalid-review', 'project-1', 'session-1', 'message-1', 'unknown', CURRENT_TIMESTAMP)`)

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed',
      migrationId: '0006_database_domain_constraints'
    })
    await expect(
      client.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "_open_science_migrations" ORDER BY "id" DESC LIMIT 1
      `
    ).resolves.toEqual([{ id: '0005_project_preview_state_owner_fk' }])
    await expect(
      client.$queryRaw<Array<{ lifecycle: string }>>`
        SELECT "lifecycle" FROM "Review" WHERE "id" = 'invalid-review'
      `
    ).resolves.toEqual([{ lifecycle: 'unknown' }])
    await expect(
      client.$queryRaw<Array<{ sql: string }>>`
        SELECT "sql" FROM "sqlite_schema" WHERE "type" = 'table' AND "name" = 'Review'
      `
    ).resolves.toEqual([{ sql: expect.not.stringContaining('Review_lifecycle_check') }])
  })

  it('rejects schema objects outside the generated current target', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-current-drift-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.$executeRawUnsafe('CREATE TABLE "UnversionedDrift" ("id" TEXT PRIMARY KEY)')

    await expect(verifyCurrentApplicationSchema(client)).rejects.toThrow(/unexpected tables/)
  })

  it('keeps a recovery snapshot when final verification rejects current schema drift', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-final-verification-'))
    const databasePath = join(storageRoot, 'open-science.db')
    const backupPath = `${databasePath}.before-0001_runtime_schema_baseline.backup`
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client, { databasePath })
    await client.$executeRawUnsafe('VACUUM INTO ?', backupPath)
    await client.$executeRawUnsafe('CREATE TABLE "UnversionedDrift" ("id" TEXT PRIMARY KEY)')
    const retiredManifest = MIGRATION_MANIFEST.map((migration) => ({
      ...migration,
      backupOnApply: 'none' as const,
      backupRetention: 'delete-after-success' as const
    }))
    const retired: unknown[] = []

    await expect(
      migrateApplicationDatabaseWithManifest(client, retiredManifest, {
        databasePath,
        onBackupRetired: (event) => retired.push(event)
      })
    ).rejects.toMatchObject({
      code: 'database_validation_failed',
      migrationId: '0016_agent_memory_project_scope'
    })
    expect(retired).toEqual([])
    await expect(access(backupPath)).resolves.toBeUndefined()
  })

  it('applies a pending manifest suffix after the recorded baseline', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-suffix-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    const future = futureTestMigration()

    await expect(
      migrateApplicationDatabaseWithManifest(client, [...MIGRATION_MANIFEST, future])
    ).resolves.toEqual({
      adoptedLegacy: false,
      applied: ['0017_test_suffix'],
      from: '0016_agent_memory_project_scope',
      to: '0017_test_suffix'
    })
    await expect(
      client.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "_open_science_migrations" ORDER BY "id"
      `
    ).resolves.toEqual([
      { id: '0001_runtime_schema_baseline' },
      { id: '0002_project_agent_context' },
      { id: '0003_granted_local_roots' },
      { id: '0004_review_assessment_snapshots' },
      { id: '0005_project_preview_state_owner_fk' },
      { id: '0006_database_domain_constraints' },
      { id: '0007_notification_attention_metadata' },
      { id: '0008_database_json_constraints' },
      { id: '0009_vision_evidence' },
      { id: '0010_compute_password_auth' },
      { id: '0011_cross_resource_tags' },
      { id: '0012_tag_ordering' },
      { id: '0013_session_projection' },
      { id: '0014_review_query_indexes' },
      { id: '0015_session_model_call_usage' },
      { id: '0016_agent_memory_project_scope' },
      { id: '0017_test_suffix' }
    ])
  })

  it('does not back up a migration that does not request a backup', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-no-backup-suffix-'))
    const databasePath = join(storageRoot, 'open-science.db')
    const backupEvents: unknown[] = []
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client, { databasePath })

    await migrateApplicationDatabaseWithManifest(
      client,
      [...MIGRATION_MANIFEST, futureTestMigration()],
      {
        databasePath,
        onBackupReady: (event) => backupEvents.push(event)
      }
    )

    expect(backupEvents).toEqual([])
  })

  it('creates recovery snapshots while retaining only the newest two for a ledger database', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-agent-context-backup-'))
    const databasePath = join(storageRoot, 'open-science.db')
    const backupPath = `${databasePath}.before-0002_project_agent_context.backup`
    const backupEvents: unknown[] = []
    client = createProjectDbClient(storageRoot)
    for (const statement of MIGRATION_MANIFEST[0]!.statements) {
      await client.$executeRawUnsafe(statement)
    }
    await client.$executeRawUnsafe(`CREATE TABLE "_open_science_migrations" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "checksum" TEXT NOT NULL,
      "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)
    await client.$executeRaw`
      INSERT INTO "_open_science_migrations" ("id", "checksum")
      VALUES (${'0001_runtime_schema_baseline'}, ${MIGRATION_MANIFEST[0]!.checksum})
    `
    await client.$executeRaw`
      INSERT INTO "Project" ("id", "name", "updatedAt")
      VALUES (${'project-1'}, ${'Preserved'}, ${new Date('2026-01-02T03:04:05Z')})
    `

    await expect(
      migrateApplicationDatabase(client, {
        databasePath,
        onBackupReady: (event) => backupEvents.push(event)
      })
    ).resolves.toEqual({
      adoptedLegacy: false,
      applied: [
        '0002_project_agent_context',
        '0003_granted_local_roots',
        '0004_review_assessment_snapshots',
        '0005_project_preview_state_owner_fk',
        '0006_database_domain_constraints',
        '0007_notification_attention_metadata',
        '0008_database_json_constraints',
        '0009_vision_evidence',
        '0010_compute_password_auth',
        '0011_cross_resource_tags',
        '0012_tag_ordering',
        '0013_session_projection',
        '0014_review_query_indexes',
        '0015_session_model_call_usage',
        '0016_agent_memory_project_scope'
      ],
      from: '0001_runtime_schema_baseline',
      to: '0016_agent_memory_project_scope'
    })
    expect(backupEvents).toEqual([
      {
        migrationId: '0002_project_agent_context',
        path: backupPath,
        reused: false
      },
      {
        migrationId: '0003_granted_local_roots',
        path: `${databasePath}.before-0003_granted_local_roots.backup`,
        reused: false
      },
      {
        migrationId: '0004_review_assessment_snapshots',
        path: `${databasePath}.before-0004_review_assessment_snapshots.backup`,
        reused: false
      },
      {
        migrationId: '0005_project_preview_state_owner_fk',
        path: `${databasePath}.before-0005_project_preview_state_owner_fk.backup`,
        reused: false
      },
      {
        migrationId: '0006_database_domain_constraints',
        path: `${databasePath}.before-0006_database_domain_constraints.backup`,
        reused: false
      },
      {
        migrationId: '0007_notification_attention_metadata',
        path: `${databasePath}.before-0007_notification_attention_metadata.backup`,
        reused: false
      },
      {
        migrationId: '0008_database_json_constraints',
        path: `${databasePath}.before-0008_database_json_constraints.backup`,
        reused: false
      },
      {
        migrationId: '0009_vision_evidence',
        path: `${databasePath}.before-0009_vision_evidence.backup`,
        reused: false
      },
      {
        migrationId: '0010_compute_password_auth',
        path: `${databasePath}.before-0010_compute_password_auth.backup`,
        reused: false
      },
      {
        migrationId: '0011_cross_resource_tags',
        path: `${databasePath}.before-0011_cross_resource_tags.backup`,
        reused: false
      },
      {
        migrationId: '0012_tag_ordering',
        path: `${databasePath}.before-0012_tag_ordering.backup`,
        reused: false
      },
      {
        migrationId: '0013_session_projection',
        path: `${databasePath}.before-0013_session_projection.backup`,
        reused: false
      },
      {
        migrationId: '0014_review_query_indexes',
        path: `${databasePath}.before-0014_review_query_indexes.backup`,
        reused: false
      },
      {
        migrationId: '0015_session_model_call_usage',
        path: `${databasePath}.before-0015_session_model_call_usage.backup`,
        reused: false
      },
      {
        migrationId: '0016_agent_memory_project_scope',
        path: `${databasePath}.before-0016_agent_memory_project_scope.backup`,
        reused: false
      }
    ])
    await expect(access(backupPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(`${databasePath}.before-0012_tag_ordering.backup`)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(
      access(`${databasePath}.before-0011_cross_resource_tags.backup`)
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      access(`${databasePath}.before-0013_session_projection.backup`)
    ).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(
      access(`${databasePath}.before-0014_review_query_indexes.backup`)
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      access(`${databasePath}.before-0015_session_model_call_usage.backup`)
    ).resolves.toBeUndefined()
    await expect(
      access(`${databasePath}.before-0016_agent_memory_project_scope.backup`)
    ).resolves.toBeUndefined()
    await expect(
      client.$queryRaw<Array<{ agentContext: string; name: string }>>`
        SELECT "agentContext", "name" FROM "Project" WHERE "id" = 'project-1'
      `
    ).resolves.toEqual([{ agentContext: '', name: 'Preserved' }])
  })

  it('rolls back a future migration and its ledger row when verification fails', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-suffix-rollback-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    const futureBase = futureTestMigration()
    const statements = [
      `CREATE TABLE "MigrationSuffixProbe" ("id" TEXT NOT NULL PRIMARY KEY)`
    ] as const
    const verifiers = [
      { kind: 'table-exists', version: 1, table: 'MissingMigrationSuffixProbe' }
    ] as const
    const future = {
      ...futureBase,
      statements,
      verifiers,
      checksum: checksumMigrationPayload(futureBase.id, statements, verifiers)
    }

    await expect(
      migrateApplicationDatabaseWithManifest(client, [...MIGRATION_MANIFEST, future])
    ).rejects.toMatchObject({
      code: 'database_validation_failed',
      migrationId: '0017_test_suffix'
    })
    await expect(
      client.$queryRaw<Array<{ name: string }>>`
        SELECT "name" FROM "sqlite_schema"
        WHERE "type" = 'table' AND "name" = 'MigrationSuffixProbe'
      `
    ).resolves.toEqual([])
    await expect(
      client.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "_open_science_migrations" ORDER BY "id"
      `
    ).resolves.toEqual([
      { id: '0001_runtime_schema_baseline' },
      { id: '0002_project_agent_context' },
      { id: '0003_granted_local_roots' },
      { id: '0004_review_assessment_snapshots' },
      { id: '0005_project_preview_state_owner_fk' },
      { id: '0006_database_domain_constraints' },
      { id: '0007_notification_attention_metadata' },
      { id: '0008_database_json_constraints' },
      { id: '0009_vision_evidence' },
      { id: '0010_compute_password_auth' },
      { id: '0011_cross_resource_tags' },
      { id: '0012_tag_ordering' },
      { id: '0013_session_projection' },
      { id: '0014_review_query_indexes' },
      { id: '0015_session_model_call_usage' },
      { id: '0016_agent_memory_project_scope' }
    ])
  })

  it('prunes to two recovery snapshots before a later migration fails', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-failed-bounded-backups-'))
    const databasePath = join(storageRoot, 'open-science.db')
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client, { databasePath })
    await client.$executeRawUnsafe(
      'VACUUM INTO ?',
      `${databasePath}.before-0010_compute_password_auth.backup`
    )
    await client.$executeRawUnsafe(
      'VACUUM INTO ?',
      `${databasePath}.before-0011_cross_resource_tags.backup`
    )
    const futureBase = futureTestMigration()
    const statements = [
      `CREATE TABLE "MigrationSuffixProbe" ("id" TEXT NOT NULL PRIMARY KEY)`
    ] as const
    const verifiers = [
      { kind: 'table-exists', version: 1, table: 'MissingMigrationSuffixProbe' }
    ] as const
    const future = {
      ...futureBase,
      statements,
      verifiers,
      checksum: checksumMigrationPayload(futureBase.id, statements, verifiers),
      backupOnApply: 'required' as const
    }

    await expect(
      migrateApplicationDatabaseWithManifest(client, [...MIGRATION_MANIFEST, future], {
        databasePath
      })
    ).rejects.toMatchObject({
      code: 'database_validation_failed',
      migrationId: future.id
    })
    await expect(
      readdir(storageRoot).then((entries) =>
        entries.filter((entry) => entry.endsWith('.backup')).sort()
      )
    ).resolves.toEqual([`open-science.db.before-${future.id}.backup`])
  })

  it('rejects a migration when its required column is missing', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-column-verifier-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    const futureBase = futureTestMigration()
    const verifiers = [
      { kind: 'column-exists', version: 1, table: 'Project', column: 'missingColumn' }
    ] as const
    const future = {
      ...futureBase,
      verifiers,
      checksum: checksumMigrationPayload(futureBase.id, futureBase.statements, verifiers)
    }

    await expect(
      migrateApplicationDatabaseWithManifest(client, [...MIGRATION_MANIFEST, future])
    ).rejects.toMatchObject({
      code: 'database_validation_failed',
      migrationId: '0017_test_suffix'
    })
  })

  it('adopts a pre-ledger database and then applies the full manifest suffix', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-legacy-suffix-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)
    await client.$executeRaw`
      INSERT INTO "Project" ("id", "name", "updatedAt")
      VALUES (${'legacy-project'}, ${'Preserved'}, ${new Date('2026-01-02T03:04:05Z')})
    `
    const future = futureTestMigration()

    await expect(
      migrateApplicationDatabaseWithManifest(client, [...MIGRATION_MANIFEST, future])
    ).resolves.toMatchObject({
      adoptedLegacy: true,
      applied: [
        '0001_runtime_schema_baseline',
        '0002_project_agent_context',
        '0003_granted_local_roots',
        '0004_review_assessment_snapshots',
        '0005_project_preview_state_owner_fk',
        '0006_database_domain_constraints',
        '0007_notification_attention_metadata',
        '0008_database_json_constraints',
        '0009_vision_evidence',
        '0010_compute_password_auth',
        '0011_cross_resource_tags',
        '0012_tag_ordering',
        '0013_session_projection',
        '0014_review_query_indexes',
        '0015_session_model_call_usage',
        '0016_agent_memory_project_scope',
        '0017_test_suffix'
      ],
      to: '0017_test_suffix'
    })
    await expect(
      client.project.findUniqueOrThrow({ where: { id: 'legacy-project' } })
    ).resolves.toMatchObject({ name: 'Preserved' })
  })

  it('rejects an extra current-shaped foreign key on another pre-ledger table', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-unknown-suffix-fk-'))
    client = createProjectDbClient(storageRoot)
    const findingDdl = RUNTIME_SCHEMA_TABLE_DDL_BY_NAME.Finding
    const currentForeignKey = findingDdl.match(/(CONSTRAINT[\s\S]+)\n\);$/)?.[1]
    if (!currentForeignKey) throw new Error('Finding baseline FK fixture is unavailable.')
    await client.$executeRawUnsafe(findingDdl.replace(/\n\);$/, `,\n    ${currentForeignKey}\n);`))

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed',
      migrationId: '0001_runtime_schema_baseline',
      cause: {
        name: 'DatabaseValidationError',
        data: {
          kind: 'foreign-key-definition-mismatch',
          table: 'Finding'
        }
      }
    })
    await expect(
      client.$queryRaw<Array<{ name: string }>>`
        SELECT name FROM sqlite_schema
        WHERE name = '_open_science_migrations'
      `
    ).resolves.toEqual([])
  })

  it('migrates legacy Preview ownership while pruning orphan rows', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-preview-owner-fk-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)
    await client.$executeRawUnsafe(`CREATE TABLE "ProjectPreviewState" (
      "projectId" TEXT NOT NULL PRIMARY KEY,
      "panelState" TEXT NOT NULL,
      "activeItemId" TEXT,
      "items" TEXT NOT NULL DEFAULT '[]',
      "updatedAt" DATETIME NOT NULL
    )`)
    const updatedAt = new Date('2026-01-02T03:04:05Z')
    await client.$executeRaw`
      INSERT INTO "Project" ("id", "name", "updatedAt")
      VALUES (${'legacy-project'}, ${'Preserved'}, ${updatedAt})
    `
    await client.$executeRaw`
      INSERT INTO "ProjectPreviewState" (
        "projectId", "panelState", "activeItemId", "items", "updatedAt"
      ) VALUES
        (${'legacy-project'}, ${'open'}, NULL, ${'[]'}, ${updatedAt}),
        (${'orphan-project'}, ${'collapsed'}, NULL, ${'[]'}, ${updatedAt})
    `

    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
      applied: expect.arrayContaining(['0005_project_preview_state_owner_fk'])
    })
    await expect(
      client.$queryRaw<Array<{ projectId: string }>>`
        SELECT "projectId" FROM "ProjectPreviewState" ORDER BY "projectId"
      `
    ).resolves.toEqual([{ projectId: 'legacy-project' }])
    await expect(
      client.$queryRawUnsafe<
        Array<{ table: string; from: string; to: string; on_delete: string; on_update: string }>
      >('PRAGMA foreign_key_list("ProjectPreviewState")')
    ).resolves.toContainEqual(
      expect.objectContaining({
        table: 'Project',
        from: 'projectId',
        to: 'id',
        on_delete: 'CASCADE',
        on_update: 'CASCADE'
      })
    )

    await client.project.delete({ where: { id: 'legacy-project' } })
    await expect(client.projectPreviewState.count()).resolves.toBe(0)
    await expect(
      client.projectPreviewState.create({
        data: { projectId: 'missing-project', panelState: 'collapsed', items: '[]' }
      })
    ).rejects.toThrow()
  })

  it('replays preview ownership migration when an adopted FK table contains orphan rows', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-preview-owner-adoption-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'legacy-project', name: 'Preserved' } })
    await client.projectPreviewState.create({
      data: { projectId: 'legacy-project', panelState: 'open', items: '[]' }
    })

    await client.$executeRawUnsafe('PRAGMA foreign_keys = OFF')
    await client.$executeRaw`
      INSERT INTO "ProjectPreviewState" (
        "projectId", "panelState", "activeItemId", "items", "updatedAt"
      ) VALUES (
        ${'orphan-project'}, ${'collapsed'}, NULL, ${'[]'}, ${new Date('2026-01-02T03:04:05Z')}
      )
    `
    await client.$executeRawUnsafe('PRAGMA foreign_keys = ON')
    await removeComputePasswordAuthSchema(client)
    await client.$executeRawUnsafe('DROP TABLE "VisionEvidence"')
    await removeAgentMemoryTriggers(client)
    await client.$executeRawUnsafe('DROP TABLE "_open_science_migrations"')

    await expect(
      migrateApplicationDatabaseWithManifest(client, MIGRATION_MANIFEST.slice(0, -7))
    ).rejects.toMatchObject({
      code: 'database_validation_failed',
      migrationId: '0001_runtime_schema_baseline'
    })

    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
      adoptedLegacy: true,
      applied: expect.arrayContaining(['0005_project_preview_state_owner_fk'])
    })
    await expect(
      client.$queryRaw<Array<{ projectId: string }>>`
        SELECT "projectId" FROM "ProjectPreviewState" ORDER BY "projectId"
      `
    ).resolves.toEqual([{ projectId: 'legacy-project' }])
    await expect(
      client.$queryRawUnsafe<Array<{ table: string }>>(
        'PRAGMA foreign_key_check("ProjectPreviewState")'
      )
    ).resolves.toEqual([])
  })
  it('blocks a database containing a migration from a newer application', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-newer-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Preserved' } })
    await client.$executeRaw`
      INSERT INTO "_open_science_migrations" ("id", "checksum")
      VALUES (${'9999_future_schema'}, ${'f'.repeat(64)})
    `

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_newer_than_app',
      retryable: false
    })
    await expect(client.project.count()).resolves.toBe(1)
  })

  it('blocks a migration history whose recorded baseline was changed', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-checksum-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.$executeRaw`
      UPDATE "_open_science_migrations"
      SET "checksum" = ${'0'.repeat(64)}
      WHERE "id" = ${'0001_runtime_schema_baseline'}
    `

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_history_invalid',
      retryable: false
    })
  })

  it('blocks a required legacy backup when the database path is unavailable', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-missing-backup-path-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)

    await expect(migrateApplicationDatabase(client, { databasePath: '' })).rejects.toMatchObject({
      code: 'database_migration_failed',
      migrationId: '0001_runtime_schema_baseline'
    })
    await expect(
      client.$queryRaw<Array<{ name: string }>>`
        SELECT "name" FROM "sqlite_schema"
        WHERE "type" = 'table' AND "name" = '_open_science_migrations'
      `
    ).resolves.toEqual([])
  })

  it('adopts a pre-ledger database without losing existing projects', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-legacy-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)
    await client.$executeRaw`
      INSERT INTO "Project" ("id", "name", "updatedAt")
      VALUES (${'legacy-project'}, ${'Preserved'}, ${new Date('2026-01-02T03:04:05Z')})
    `

    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
      adoptedLegacy: true,
      applied: [
        '0001_runtime_schema_baseline',
        '0002_project_agent_context',
        '0003_granted_local_roots',
        '0004_review_assessment_snapshots',
        '0005_project_preview_state_owner_fk',
        '0006_database_domain_constraints',
        '0007_notification_attention_metadata',
        '0008_database_json_constraints',
        '0009_vision_evidence',
        '0010_compute_password_auth',
        '0011_cross_resource_tags',
        '0012_tag_ordering',
        '0013_session_projection',
        '0014_review_query_indexes',
        '0015_session_model_call_usage',
        '0016_agent_memory_project_scope'
      ]
    })
    await expect(
      client.project.findUniqueOrThrow({ where: { id: 'legacy-project' } })
    ).resolves.toMatchObject({ name: 'Preserved', archivedAt: null })
  })

  it('repairs frozen pre-ledger ComputeJob columns without losing existing rows', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-legacy-compute-job-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "ComputeJob" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "providerId" TEXT NOT NULL,
      "shape" TEXT NOT NULL,
      "sessionId" TEXT NOT NULL,
      "projectId" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'submitted',
      "intent" TEXT NOT NULL,
      "command" TEXT NOT NULL,
      "commandHash" TEXT NOT NULL,
      "environment" TEXT,
      "resourceRequest" TEXT,
      "inputManifest" TEXT,
      "outputManifest" TEXT,
      "harvestConfig" TEXT,
      "timeoutSeconds" INTEGER,
      "remoteWorkdir" TEXT,
      "remoteHandle" TEXT,
      "exitCode" INTEGER,
      "stdoutTail" TEXT,
      "stderrTail" TEXT,
      "errorCode" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "submittedAt" DATETIME,
      "startedAt" DATETIME,
      "finishedAt" DATETIME,
      "harvestedAt" DATETIME
    )`)
    await client.$executeRaw`
      INSERT INTO "ComputeJob" (
        "id", "providerId", "shape", "sessionId", "projectId", "intent", "command",
        "commandHash", "status", "createdAt"
      ) VALUES (
        ${'legacy-job'}, ${'ssh:test'}, ${'direct_ssh'}, ${'legacy-session'},
        ${'legacy-project'}, ${'preserved intent'}, ${'echo ok'}, ${'hash123'},
        ${'submitted'}, ${new Date('2026-01-02T03:04:05Z')}
      )
    `

    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
      adoptedLegacy: true,
      applied: MIGRATION_MANIFEST.map((migration) => migration.id)
    })
    await expect(
      client.computeJob.findUniqueOrThrow({ where: { id: 'legacy-job' } })
    ).resolves.toMatchObject({
      intent: 'preserved intent',
      lastPollError: null,
      harvestError: null,
      leftOnRemote: null,
      notifiedAt: null,
      notificationConsumedAt: null
    })
    await expect(verifyCurrentApplicationSchema(client)).resolves.toBeUndefined()
  })

  it('keeps explicitly retired Review and Finding columns after final verification', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-retired-columns-'))
    client = createProjectDbClient(storageRoot)
    await createDatabaseAtMigration0005(client)
    await client.$executeRawUnsafe(
      `INSERT INTO "Project" ("id", "name", "updatedAt") VALUES ('legacy-project', 'Preserved', CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe('ALTER TABLE "Review" ADD COLUMN "summary" TEXT')
    await client.$executeRawUnsafe('ALTER TABLE "Review" ADD COLUMN "checks" TEXT')
    await client.$executeRawUnsafe('ALTER TABLE "Review" ADD COLUMN "reasoning" TEXT')
    await client.$executeRawUnsafe('ALTER TABLE "Finding" ADD COLUMN "severity" TEXT')
    await client.$executeRaw`
      INSERT INTO "Review" (
        "id", "projectId", "sessionId", "turnMessageId", "updatedAt",
        "summary", "checks", "reasoning"
      ) VALUES (
        ${'legacy-review'}, ${'legacy-project'}, ${'legacy-session'}, ${'legacy-message'},
        ${new Date('2026-01-02T03:04:05Z')}, ${'retained summary'}, ${'retained checks'},
        ${'retained reasoning'}
      )
    `
    await client.$executeRaw`
      INSERT INTO "Finding" ("id", "reviewId", "severity")
      VALUES (${'legacy-finding'}, ${'legacy-review'}, ${'retained severity'})
    `
    await client.$executeRawUnsafe('ALTER TABLE "Project" DROP COLUMN "agentContext"')
    await client.$executeRawUnsafe('DROP TABLE "_open_science_migrations"')

    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
      adoptedLegacy: true,
      applied: [
        '0001_runtime_schema_baseline',
        '0002_project_agent_context',
        '0003_granted_local_roots',
        '0004_review_assessment_snapshots',
        '0005_project_preview_state_owner_fk',
        '0006_database_domain_constraints',
        '0007_notification_attention_metadata',
        '0008_database_json_constraints',
        '0009_vision_evidence',
        '0010_compute_password_auth',
        '0011_cross_resource_tags',
        '0012_tag_ordering',
        '0013_session_projection',
        '0014_review_query_indexes',
        '0015_session_model_call_usage',
        '0016_agent_memory_project_scope'
      ]
    })
    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
    await expect(
      client.$queryRaw<
        Array<{ summary: string; checks: string; reasoning: string; severity: string }>
      >`
        SELECT "Review"."summary", "Review"."checks", "Review"."reasoning", "Finding"."severity"
        FROM "Review" JOIN "Finding" ON "Finding"."reviewId" = "Review"."id"
        WHERE "Review"."id" = 'legacy-review'
      `
    ).resolves.toEqual([
      {
        summary: 'retained summary',
        checks: 'retained checks',
        reasoning: 'retained reasoning',
        severity: 'retained severity'
      }
    ])
  })

  it('adopts the pre-ledger permission grant table emitted by v0.9 through v0.10', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-legacy-permissions-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)
    await client.$executeRawUnsafe(LEGACY_PERMISSION_GRANT_TABLE_DDL)
    await client.$executeRaw`
      INSERT INTO "Project" ("id", "name", "updatedAt")
      VALUES (${'legacy-project'}, ${'Preserved'}, ${new Date('2026-01-02T03:04:05Z')})
    `
    await client.$executeRaw`
      INSERT INTO "PermissionGrant" (
        "id", "capabilityKind", "capabilityKey", "scopeKind", "projectId", "fingerprint"
      ) VALUES (
        ${'legacy-grant'}, ${'execution'}, ${'exec:agent/shell'}, ${'project'},
        ${'legacy-project'}, ${'legacy-fingerprint'}
      )
    `

    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
      adoptedLegacy: true,
      applied: [
        '0001_runtime_schema_baseline',
        '0002_project_agent_context',
        '0003_granted_local_roots',
        '0004_review_assessment_snapshots',
        '0005_project_preview_state_owner_fk',
        '0006_database_domain_constraints',
        '0007_notification_attention_metadata',
        '0008_database_json_constraints',
        '0009_vision_evidence',
        '0010_compute_password_auth',
        '0011_cross_resource_tags',
        '0012_tag_ordering',
        '0013_session_projection',
        '0014_review_query_indexes',
        '0015_session_model_call_usage',
        '0016_agent_memory_project_scope'
      ]
    })
    await expect(
      client.permissionGrant.findUniqueOrThrow({ where: { id: 'legacy-grant' } })
    ).resolves.toMatchObject({
      capabilityKind: 'execution',
      capabilityKey: 'exec:agent/shell',
      projectId: 'legacy-project'
    })
    await expect(verifyCurrentApplicationSchema(client)).resolves.toBeUndefined()
  })

  it('rejects a grouped legacy permission constraint with different semantics', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-invalid-permissions-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(
      LEGACY_PERMISSION_GRANT_TABLE_DDL.replace(
        '"qualifierValue" IS NULL) OR',
        '"qualifierValue" IS NOT NULL) OR'
      )
    )

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed',
      migrationId: '0001_runtime_schema_baseline',
      cause: {
        name: 'DatabaseValidationError',
        data: {
          kind: 'check-constraint-mismatch',
          table: 'PermissionGrant',
          constraint: 'PermissionGrant_qualifier_check',
          expected: expect.any(String),
          actual: expect.any(String)
        }
      }
    })
    await expect(
      client.$queryRaw<Array<{ name: string }>>`
        SELECT "name" FROM "sqlite_schema"
        WHERE "name" = '_open_science_migrations'
      `
    ).resolves.toEqual([])
  })

  it('adopts the equivalent legacy artifact input identity check before canonical rebuild', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-legacy-input-check-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(LEGACY_ARTIFACT_VERSION_INPUT_TABLE_DDL)

    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
      adoptedLegacy: true,
      applied: [
        '0001_runtime_schema_baseline',
        '0002_project_agent_context',
        '0003_granted_local_roots',
        '0004_review_assessment_snapshots',
        '0005_project_preview_state_owner_fk',
        '0006_database_domain_constraints',
        '0007_notification_attention_metadata',
        '0008_database_json_constraints',
        '0009_vision_evidence',
        '0010_compute_password_auth',
        '0011_cross_resource_tags',
        '0012_tag_ordering',
        '0013_session_projection',
        '0014_review_query_indexes',
        '0015_session_model_call_usage',
        '0016_agent_memory_project_scope'
      ]
    })
    await expect(verifyCurrentApplicationSchema(client)).resolves.toBeUndefined()
    await expect(
      client.$queryRaw<Array<{ sql: string }>>`
        SELECT "sql" FROM "sqlite_schema"
        WHERE "type" = 'table' AND "name" = 'ArtifactVersionInput'
      `
    ).resolves.toEqual([
      {
        sql: expect.stringContaining(
          '"sourceArtifactVersionId" IS NULL AND "sourceUploadVersionId" IS NOT NULL'
        )
      }
    ])
  })

  it('describes an invalid legacy value without exposing its raw content', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-invalid-value-'))
    client = createProjectDbClient(storageRoot)
    const sensitiveValue = 'Bearer customer-secret-value'
    await client.$executeRawUnsafe(`CREATE TABLE "FileOriginSession" (
      "projectId" TEXT NOT NULL,
      "sessionId" TEXT NOT NULL,
      "titleSnapshot" TEXT,
      "state" TEXT NOT NULL DEFAULT 'active',
      "deletedAt" DATETIME,
      "deletionOperationId" TEXT,
      "retainedReviewIdsJson" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      PRIMARY KEY ("projectId", "sessionId")
    )`)
    await client.$executeRaw`
      INSERT INTO "FileOriginSession" (
        "projectId", "sessionId", "state", "updatedAt"
      ) VALUES (${'project-1'}, ${'session-1'}, ${sensitiveValue}, ${new Date('2026-01-02T03:04:05Z')})
    `

    let failure: unknown
    try {
      await migrateApplicationDatabase(client)
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      code: 'database_validation_failed',
      cause: {
        name: 'DatabaseValidationError',
        data: {
          kind: 'unsupported-value',
          table: 'FileOriginSession',
          column: 'state',
          expected: ['active', 'deleting', 'deleted'],
          actual: {
            type: 'string',
            length: sensitiveValue.length,
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/)
          }
        }
      }
    })
    expect(String((failure as Error & { cause?: Error }).cause?.message)).not.toContain(
      sensitiveValue
    )
    expect(
      JSON.stringify((failure as Error & { cause?: { data?: unknown } }).cause?.data)
    ).not.toContain(sensitiveValue)
  })

  it('adopts the pre-ledger permission seed table from the final baseline', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-permission-seed-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "PermissionGrantSeed" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "appliedAt" DATETIME NOT NULL
    )`)
    const appliedAt = new Date('2026-08-09T00:00:00.000Z')
    await client.$executeRaw`
      INSERT INTO "PermissionGrantSeed" ("id", "appliedAt")
      VALUES (${'global-customize-v1'}, ${appliedAt})
    `

    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
      adoptedLegacy: true,
      applied: [
        '0001_runtime_schema_baseline',
        '0002_project_agent_context',
        '0003_granted_local_roots',
        '0004_review_assessment_snapshots',
        '0005_project_preview_state_owner_fk',
        '0006_database_domain_constraints',
        '0007_notification_attention_metadata',
        '0008_database_json_constraints',
        '0009_vision_evidence',
        '0010_compute_password_auth',
        '0011_cross_resource_tags',
        '0012_tag_ordering',
        '0013_session_projection',
        '0014_review_query_indexes',
        '0015_session_model_call_usage',
        '0016_agent_memory_project_scope'
      ]
    })
    await expect(
      client.permissionGrantSeed.findUniqueOrThrow({ where: { id: 'global-customize-v1' } })
    ).resolves.toEqual({ id: 'global-customize-v1', appliedAt })
    await expect(verifyCurrentApplicationSchema(client)).resolves.toBeUndefined()
  })

  it('retains only the two newest restorable snapshots after adopting a legacy database', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-backup-'))
    const databasePath = join(storageRoot, 'open-science.db')
    const backupPath = `${databasePath}.before-0001_runtime_schema_baseline.backup`
    const agentContextBackupPath = `${databasePath}.before-0002_project_agent_context.backup`
    const visionEvidenceBackupPath = `${databasePath}.before-0009_vision_evidence.backup`
    const computePasswordAuthBackupPath = `${databasePath}.before-0010_compute_password_auth.backup`
    const crossResourceTagsBackupPath = `${databasePath}.before-0011_cross_resource_tags.backup`
    const tagOrderingBackupPath = `${databasePath}.before-0012_tag_ordering.backup`
    const sessionProjectionBackupPath = `${databasePath}.before-0013_session_projection.backup`
    const reviewQueryIndexesBackupPath = `${databasePath}.before-0014_review_query_indexes.backup`
    const modelCallUsageBackupPath = `${databasePath}.before-0015_session_model_call_usage.backup`
    const agentMemoryBackupPath = `${databasePath}.before-0016_agent_memory_project_scope.backup`
    const backupEvents: unknown[] = []
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)
    await client.$executeRaw`
      INSERT INTO "Project" ("id", "name", "updatedAt")
      VALUES (${'legacy-project'}, ${'Preserved'}, ${new Date('2026-01-02T03:04:05Z')})
    `

    await expect(
      migrateApplicationDatabase(client, {
        databasePath,
        onBackupReady: (event) => {
          backupEvents.push(event)
          throw new Error('simulated backup diagnostic failure')
        }
      })
    ).resolves.toMatchObject({
      adoptedLegacy: true,
      applied: [
        '0001_runtime_schema_baseline',
        '0002_project_agent_context',
        '0003_granted_local_roots',
        '0004_review_assessment_snapshots',
        '0005_project_preview_state_owner_fk',
        '0006_database_domain_constraints',
        '0007_notification_attention_metadata',
        '0008_database_json_constraints',
        '0009_vision_evidence',
        '0010_compute_password_auth',
        '0011_cross_resource_tags',
        '0012_tag_ordering',
        '0013_session_projection',
        '0014_review_query_indexes',
        '0015_session_model_call_usage',
        '0016_agent_memory_project_scope'
      ]
    })
    expect(backupEvents).toEqual([
      {
        migrationId: '0001_runtime_schema_baseline',
        path: backupPath,
        reused: false
      },
      {
        migrationId: '0002_project_agent_context',
        path: agentContextBackupPath,
        reused: false
      },
      {
        migrationId: '0003_granted_local_roots',
        path: `${databasePath}.before-0003_granted_local_roots.backup`,
        reused: false
      },
      {
        migrationId: '0004_review_assessment_snapshots',
        path: `${databasePath}.before-0004_review_assessment_snapshots.backup`,
        reused: false
      },
      {
        migrationId: '0005_project_preview_state_owner_fk',
        path: `${databasePath}.before-0005_project_preview_state_owner_fk.backup`,
        reused: false
      },
      {
        migrationId: '0006_database_domain_constraints',
        path: `${databasePath}.before-0006_database_domain_constraints.backup`,
        reused: false
      },
      {
        migrationId: '0007_notification_attention_metadata',
        path: `${databasePath}.before-0007_notification_attention_metadata.backup`,
        reused: false
      },
      {
        migrationId: '0008_database_json_constraints',
        path: `${databasePath}.before-0008_database_json_constraints.backup`,
        reused: false
      },
      {
        migrationId: '0009_vision_evidence',
        path: `${databasePath}.before-0009_vision_evidence.backup`,
        reused: false
      },
      {
        migrationId: '0010_compute_password_auth',
        path: `${databasePath}.before-0010_compute_password_auth.backup`,
        reused: false
      },
      {
        migrationId: '0011_cross_resource_tags',
        path: `${databasePath}.before-0011_cross_resource_tags.backup`,
        reused: false
      },
      {
        migrationId: '0012_tag_ordering',
        path: `${databasePath}.before-0012_tag_ordering.backup`,
        reused: false
      },
      {
        migrationId: '0013_session_projection',
        path: sessionProjectionBackupPath,
        reused: false
      },
      {
        migrationId: '0014_review_query_indexes',
        path: reviewQueryIndexesBackupPath,
        reused: false
      },
      {
        migrationId: '0015_session_model_call_usage',
        path: modelCallUsageBackupPath,
        reused: false
      },
      {
        migrationId: '0016_agent_memory_project_scope',
        path: agentMemoryBackupPath,
        reused: false
      }
    ])
    await expect(
      readdir(storageRoot).then((entries) =>
        entries.filter((entry) => entry.endsWith('.backup')).sort()
      )
    ).resolves.toEqual([
      'open-science.db.before-0015_session_model_call_usage.backup',
      'open-science.db.before-0016_agent_memory_project_scope.backup'
    ])
    await expect(access(backupPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(agentContextBackupPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(visionEvidenceBackupPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(computePasswordAuthBackupPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(crossResourceTagsBackupPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(tagOrderingBackupPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(sessionProjectionBackupPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(reviewQueryIndexesBackupPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(modelCallUsageBackupPath)).resolves.toBeUndefined()
    await expect(access(agentMemoryBackupPath)).resolves.toBeUndefined()
    await expect(client.project.count()).resolves.toBe(1)

    const backupClient = new PrismaClient({
      datasources: { db: { url: `file:${modelCallUsageBackupPath.replaceAll('\\', '/')}` } }
    })
    try {
      await expect(
        backupClient.$queryRaw<Array<{ id: string; name: string }>>`
          SELECT "id", "name" FROM "Project" WHERE "id" = 'legacy-project'
        `
      ).resolves.toEqual([{ id: 'legacy-project', name: 'Preserved' }])
      await expect(
        backupClient.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "_open_science_migrations" ORDER BY "id" DESC LIMIT 1
        `
      ).resolves.toEqual([{ id: '0014_review_query_indexes' }])
    } finally {
      await backupClient.$disconnect()
    }
  })

  it('rejects an unknown pre-ledger table without changing it', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-unknown-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(
      'CREATE TABLE "FutureApplicationTable" ("id" TEXT NOT NULL PRIMARY KEY, "value" TEXT)'
    )
    await client.$executeRaw`
      INSERT INTO "FutureApplicationTable" ("id", "value") VALUES (${'future-1'}, ${'keep-me'})
    `

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed',
      retryable: false
    })
    await expect(
      client.$queryRawUnsafe<Array<{ value: string }>>(
        'SELECT "value" FROM "FutureApplicationTable" WHERE "id" = \'future-1\''
      )
    ).resolves.toEqual([{ value: 'keep-me' }])
    await expect(
      client.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT "name" FROM "sqlite_schema" WHERE "name" = '_open_science_migrations'`
      )
    ).resolves.toEqual([])
  })

  it('reuses the original backup when a failed legacy migration is retried', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-backup-retry-'))
    const databasePath = join(storageRoot, 'open-science.db')
    const backupEvents: Array<{ reused: boolean }> = []
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(
      'CREATE TABLE "FutureApplicationTable" ("id" TEXT NOT NULL PRIMARY KEY)'
    )
    const options = {
      databasePath,
      onBackupReady: (event: { reused: boolean }): void => {
        backupEvents.push(event)
      }
    }

    await expect(migrateApplicationDatabase(client, options)).rejects.toMatchObject({
      code: 'database_validation_failed'
    })
    await expect(migrateApplicationDatabase(client, options)).rejects.toMatchObject({
      code: 'database_validation_failed'
    })
    expect(backupEvents).toEqual([
      expect.objectContaining({ reused: false }),
      expect.objectContaining({ reused: true })
    ])
  })

  it('blocks migration when an existing backup is not a valid SQLite database', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-invalid-backup-'))
    const databasePath = join(storageRoot, 'open-science.db')
    const backupPath = `${databasePath}.before-0001_runtime_schema_baseline.backup`
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(
      'CREATE TABLE "FutureApplicationTable" ("id" TEXT NOT NULL PRIMARY KEY)'
    )
    await writeFile(backupPath, 'not a SQLite database', 'utf8')

    await expect(migrateApplicationDatabase(client, { databasePath })).rejects.toMatchObject({
      code: 'database_migration_failed',
      migrationId: '0001_runtime_schema_baseline'
    })
    await expect(
      client.$queryRaw<Array<{ name: string }>>`
        SELECT "name" FROM "sqlite_schema"
        WHERE "name" = '_open_science_migrations'
      `
    ).resolves.toEqual([])
  })

  it('rejects a backup whose index contents fail SQLite integrity_check', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-corrupt-index-backup-'))
    const databasePath = join(storageRoot, 'open-science.db')
    const backupPath = `${databasePath}.before-0001_runtime_schema_baseline.backup`
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "FutureApplicationTable" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "leftValue" TEXT NOT NULL,
      "rightValue" TEXT NOT NULL
    )`)
    await client.$executeRawUnsafe(
      'CREATE INDEX "FutureApplicationTable_left_idx" ON "FutureApplicationTable"("leftValue")'
    )
    await client.$executeRawUnsafe(
      'CREATE INDEX "FutureApplicationTable_right_idx" ON "FutureApplicationTable"("rightValue")'
    )
    await client.$executeRaw`
      INSERT INTO "FutureApplicationTable" ("id", "leftValue", "rightValue")
      VALUES (${'one'}, ${'alpha'}, ${'zulu'}), (${'two'}, ${'beta'}, ${'yankee'})
    `
    await client.$executeRawUnsafe('VACUUM INTO ?', backupPath)

    const backupWriter = new PrismaClient({
      datasources: { db: { url: `file:${backupPath.replaceAll('\\', '/')}` } }
    })
    try {
      const roots = await backupWriter.$queryRawUnsafe<Array<{ name: string; rootpage: bigint }>>(`
        SELECT "name", "rootpage" FROM "sqlite_schema"
        WHERE "name" IN (
          'FutureApplicationTable_left_idx',
          'FutureApplicationTable_right_idx'
        )
      `)
      const leftRoot = roots.find(
        ({ name }) => name === 'FutureApplicationTable_left_idx'
      )!.rootpage
      const rightRoot = roots.find(
        ({ name }) => name === 'FutureApplicationTable_right_idx'
      )!.rootpage
      await backupWriter.$executeRawUnsafe('PRAGMA writable_schema = ON')
      await backupWriter.$executeRawUnsafe(
        `UPDATE "sqlite_schema"
         SET "rootpage" = CASE "name"
           WHEN 'FutureApplicationTable_left_idx' THEN ?
           ELSE ?
         END
         WHERE "name" IN (
           'FutureApplicationTable_left_idx',
           'FutureApplicationTable_right_idx'
         )`,
        rightRoot,
        leftRoot
      )
      await backupWriter.$executeRawUnsafe('PRAGMA writable_schema = OFF')
    } finally {
      await backupWriter.$disconnect()
    }

    const backupReader = new PrismaClient({
      datasources: { db: { url: `file:${backupPath.replaceAll('\\', '/')}` } }
    })
    try {
      await expect(
        backupReader.$queryRawUnsafe<Array<{ quick_check: string }>>('PRAGMA quick_check')
      ).resolves.toEqual([{ quick_check: 'ok' }])
      const integrity =
        await backupReader.$queryRawUnsafe<Array<{ integrity_check: string }>>(
          'PRAGMA integrity_check'
        )
      expect(integrity).not.toEqual([{ integrity_check: 'ok' }])
    } finally {
      await backupReader.$disconnect()
    }

    const ready: unknown[] = []
    let failure: unknown
    try {
      await migrateApplicationDatabase(client, {
        databasePath,
        onBackupReady: (event) => ready.push(event)
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      code: 'database_migration_failed',
      migrationId: '0001_runtime_schema_baseline'
    })
    expect((failure as Error).cause).toMatchObject({
      name: 'DatabaseValidationError',
      data: { kind: 'backup-integrity-check-failed' }
    })
    expect(ready).toEqual([])
  })

  it('compares backup contents with duplicate-row multiplicity', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-duplicate-backup-row-'))
    const databasePath = join(storageRoot, 'open-science.db')
    const backupPath = `${databasePath}.before-0001_runtime_schema_baseline.backup`
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "FutureApplicationTable" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "value" TEXT NOT NULL
    )`)
    await client.$executeRaw`
      INSERT INTO "FutureApplicationTable" ("value") VALUES (${'preserved'})
    `
    await client.$executeRawUnsafe('VACUUM INTO ?', backupPath)
    await client.$executeRawUnsafe(`
      INSERT INTO "sqlite_sequence" ("name", "seq")
      SELECT "name", "seq" FROM "sqlite_sequence"
      WHERE "name" = 'FutureApplicationTable'
      LIMIT 1
    `)

    const ready: unknown[] = []
    let failure: unknown
    try {
      await migrateApplicationDatabase(client, {
        databasePath,
        onBackupReady: (event) => ready.push(event)
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      code: 'database_migration_failed',
      migrationId: '0001_runtime_schema_baseline'
    })
    expect((failure as Error).cause).toMatchObject({
      name: 'DatabaseValidationError',
      data: { kind: 'backup-content-mismatch', table: 'sqlite_sequence' }
    })
    expect(ready).toEqual([])
  })

  it('blocks migration when an existing backup belongs to another database', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-foreign-backup-'))
    const databasePath = join(storageRoot, 'open-science.db')
    const backupPath = `${databasePath}.before-0001_runtime_schema_baseline.backup`
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)
    await client.$executeRaw`
      INSERT INTO "Project" ("id", "name", "updatedAt")
      VALUES (${'source-project'}, ${'Source'}, ${new Date('2026-01-02T03:04:05Z')})
    `

    await client.$disconnect()
    client = undefined
    await copyFile(databasePath, backupPath)
    const foreignClient = new PrismaClient({
      datasources: { db: { url: `file:${backupPath.replaceAll('\\', '/')}` } }
    })
    try {
      await foreignClient.$executeRaw`
        UPDATE "Project" SET "id" = ${'foreign-project'}, "name" = ${'Foreign'}
        WHERE "id" = ${'source-project'}
      `
    } finally {
      await foreignClient.$disconnect()
    }
    client = createProjectDbClient(storageRoot)

    let failure: unknown
    try {
      await migrateApplicationDatabase(client, { databasePath })
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      code: 'database_migration_failed',
      migrationId: '0001_runtime_schema_baseline'
    })
    expect((failure as Error).cause).toMatchObject({
      name: 'DatabaseValidationError',
      data: { kind: 'backup-content-mismatch', table: 'Project' }
    })
    await expect(
      client.$queryRaw<Array<{ id: string; name: string }>>`
        SELECT "id", "name" FROM "Project"
      `
    ).resolves.toEqual([{ id: 'source-project', name: 'Source' }])
    await expect(
      client.$queryRaw<Array<{ name: string }>>`
        SELECT "name" FROM "sqlite_schema"
        WHERE "name" = '_open_science_migrations'
      `
    ).resolves.toEqual([])
  })

  it('leaves legacy data and the ledger untouched when backup creation fails', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-backup-failure-'))
    const unavailableDatabasePath = join(storageRoot, 'missing', 'open-science.db')
    const temporaryBackupPath = `${unavailableDatabasePath}.before-0001_runtime_schema_baseline.backup.tmp`
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)
    await client.$executeRaw`
      INSERT INTO "Project" ("id", "name", "updatedAt")
      VALUES (${'legacy-project'}, ${'Preserved'}, ${new Date('2026-01-02T03:04:05Z')})
    `

    await expect(
      migrateApplicationDatabase(client, { databasePath: unavailableDatabasePath })
    ).rejects.toMatchObject({
      code: 'database_migration_failed',
      migrationId: '0001_runtime_schema_baseline'
    })
    await expect(
      client.$queryRaw<Array<{ id: string; name: string }>>`
        SELECT "id", "name" FROM "Project"
      `
    ).resolves.toEqual([{ id: 'legacy-project', name: 'Preserved' }])
    await expect(
      client.$queryRaw<Array<{ name: string }>>`
        SELECT "name" FROM "sqlite_schema"
        WHERE "name" = '_open_science_migrations'
      `
    ).resolves.toEqual([])
    await expect(access(temporaryBackupPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('backs up a legacy database before deleting the snapshot after a successful migration', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-retired-backup-'))
    const databasePath = join(storageRoot, 'open-science.db')
    const backupPath = `${databasePath}.before-0001_runtime_schema_baseline.backup`
    const agentContextBackupPath = `${databasePath}.before-0002_project_agent_context.backup`
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)
    await client.$executeRaw`
      INSERT INTO "Project" ("id", "name", "updatedAt")
      VALUES (${'legacy-project'}, ${'Preserved'}, ${new Date('2026-01-02T03:04:05Z')})
    `
    const retiredManifest = MIGRATION_MANIFEST.map((migration) => ({
      ...migration,
      backupOnApply: 'required' as const,
      backupRetention: 'delete-after-success' as const
    }))
    const ready: unknown[] = []
    const retired: unknown[] = []

    await migrateApplicationDatabaseWithManifest(client, retiredManifest, {
      databasePath,
      onBackupReady: (event) => ready.push(event),
      onBackupRetired: (event) => retired.push(event)
    })

    expect(ready).toEqual([
      expect.objectContaining({
        migrationId: '0001_runtime_schema_baseline',
        path: backupPath,
        reused: false
      }),
      expect.objectContaining({
        migrationId: '0002_project_agent_context',
        path: agentContextBackupPath,
        reused: false
      }),
      expect.objectContaining({
        migrationId: '0003_granted_local_roots',
        path: `${databasePath}.before-0003_granted_local_roots.backup`,
        reused: false
      }),
      expect.objectContaining({
        migrationId: '0004_review_assessment_snapshots',
        path: `${databasePath}.before-0004_review_assessment_snapshots.backup`,
        reused: false
      }),
      expect.objectContaining({
        migrationId: '0005_project_preview_state_owner_fk',
        path: `${databasePath}.before-0005_project_preview_state_owner_fk.backup`,
        reused: false
      }),
      expect.objectContaining({
        migrationId: '0006_database_domain_constraints',
        path: `${databasePath}.before-0006_database_domain_constraints.backup`,
        reused: false
      }),
      expect.objectContaining({
        migrationId: '0007_notification_attention_metadata',
        path: `${databasePath}.before-0007_notification_attention_metadata.backup`,
        reused: false
      }),
      expect.objectContaining({
        migrationId: '0008_database_json_constraints',
        path: `${databasePath}.before-0008_database_json_constraints.backup`,
        reused: false
      }),
      expect.objectContaining({
        migrationId: '0009_vision_evidence',
        path: `${databasePath}.before-0009_vision_evidence.backup`,
        reused: false
      }),
      expect.objectContaining({
        migrationId: '0010_compute_password_auth',
        path: `${databasePath}.before-0010_compute_password_auth.backup`,
        reused: false
      }),
      expect.objectContaining({
        migrationId: '0011_cross_resource_tags',
        path: `${databasePath}.before-0011_cross_resource_tags.backup`,
        reused: false
      }),
      expect.objectContaining({
        migrationId: '0012_tag_ordering',
        path: `${databasePath}.before-0012_tag_ordering.backup`,
        reused: false
      }),
      expect.objectContaining({
        migrationId: '0013_session_projection',
        path: `${databasePath}.before-0013_session_projection.backup`,
        reused: false
      }),
      expect.objectContaining({
        migrationId: '0014_review_query_indexes',
        path: `${databasePath}.before-0014_review_query_indexes.backup`,
        reused: false
      }),
      expect.objectContaining({
        migrationId: '0015_session_model_call_usage',
        path: `${databasePath}.before-0015_session_model_call_usage.backup`,
        reused: false
      }),
      expect.objectContaining({
        migrationId: '0016_agent_memory_project_scope',
        path: `${databasePath}.before-0016_agent_memory_project_scope.backup`,
        reused: false
      })
    ])
    expect(retired).toEqual([
      { migrationId: '0001_runtime_schema_baseline', path: backupPath },
      { migrationId: '0002_project_agent_context', path: agentContextBackupPath },
      {
        migrationId: '0003_granted_local_roots',
        path: `${databasePath}.before-0003_granted_local_roots.backup`
      },
      {
        migrationId: '0004_review_assessment_snapshots',
        path: `${databasePath}.before-0004_review_assessment_snapshots.backup`
      },
      {
        migrationId: '0005_project_preview_state_owner_fk',
        path: `${databasePath}.before-0005_project_preview_state_owner_fk.backup`
      },
      {
        migrationId: '0006_database_domain_constraints',
        path: `${databasePath}.before-0006_database_domain_constraints.backup`
      },
      {
        migrationId: '0007_notification_attention_metadata',
        path: `${databasePath}.before-0007_notification_attention_metadata.backup`
      },
      {
        migrationId: '0008_database_json_constraints',
        path: `${databasePath}.before-0008_database_json_constraints.backup`
      },
      {
        migrationId: '0009_vision_evidence',
        path: `${databasePath}.before-0009_vision_evidence.backup`
      },
      {
        migrationId: '0010_compute_password_auth',
        path: `${databasePath}.before-0010_compute_password_auth.backup`
      },
      {
        migrationId: '0011_cross_resource_tags',
        path: `${databasePath}.before-0011_cross_resource_tags.backup`
      },
      {
        migrationId: '0012_tag_ordering',
        path: `${databasePath}.before-0012_tag_ordering.backup`
      },
      {
        migrationId: '0013_session_projection',
        path: `${databasePath}.before-0013_session_projection.backup`
      },
      {
        migrationId: '0014_review_query_indexes',
        path: `${databasePath}.before-0014_review_query_indexes.backup`
      },
      {
        migrationId: '0015_session_model_call_usage',
        path: `${databasePath}.before-0015_session_model_call_usage.backup`
      },
      {
        migrationId: '0016_agent_memory_project_scope',
        path: `${databasePath}.before-0016_agent_memory_project_scope.backup`
      }
    ])
    await expect(access(backupPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(agentContextBackupPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      client.$queryRaw<Array<{ id: string; name: string }>>`SELECT "id", "name" FROM "Project"`
    ).resolves.toEqual([{ id: 'legacy-project', name: 'Preserved' }])
  })

  it('prunes historical retained backups to the newest two without deleting an unknown backup', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-bounded-backups-'))
    const databasePath = join(storageRoot, 'open-science.db')
    const unknownBackupName = 'open-science.db.before-9999_future.backup'
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client, { databasePath })
    for (const migration of MIGRATION_MANIFEST) {
      await writeFile(`${databasePath}.before-${migration.id}.backup`, migration.id, 'utf8')
    }
    await writeFile(join(storageRoot, unknownBackupName), 'future', 'utf8')
    const retired: unknown[] = []

    await expect(
      migrateApplicationDatabase(client, {
        databasePath,
        onBackupRetired: (event) => retired.push(event)
      })
    ).resolves.toMatchObject({ applied: [] })

    await expect(
      readdir(storageRoot).then((entries) =>
        entries.filter((entry) => entry.endsWith('.backup')).sort()
      )
    ).resolves.toEqual([
      'open-science.db.before-0015_session_model_call_usage.backup',
      'open-science.db.before-0016_agent_memory_project_scope.backup',
      unknownBackupName
    ])
    expect(retired).toHaveLength(MIGRATION_MANIFEST.length - 2)
    expect(retired).toEqual(
      expect.arrayContaining(
        MIGRATION_MANIFEST.slice(0, -2).map((migration) =>
          expect.objectContaining({ migrationId: migration.id })
        )
      )
    )
  })

  it('does not report backup retirement when no backup exists', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-no-retired-backup-'))
    const databasePath = join(storageRoot, 'open-science.db')
    const backupPath = `${databasePath}.before-0001_runtime_schema_baseline.backup`
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client, { databasePath })
    const retiredManifest = MIGRATION_MANIFEST.map((migration) => ({
      ...migration,
      backupOnApply: 'none' as const,
      backupRetention: 'delete-after-success' as const
    }))
    const retired: unknown[] = []

    await expect(
      migrateApplicationDatabaseWithManifest(client, retiredManifest, {
        databasePath,
        onBackupRetired: (event) => retired.push(event)
      })
    ).resolves.toMatchObject({ applied: [] })
    expect(retired).toEqual([])
    await expect(access(backupPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports retained backup pruning failure without blocking a valid database', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-retirement-failure-'))
    const databasePath = join(storageRoot, 'open-science.db')
    const backupPath = `${databasePath}.before-0001_runtime_schema_baseline.backup`
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client, { databasePath })
    await mkdir(backupPath)
    await writeFile(join(backupPath, 'keep'), 'occupied', 'utf8')
    const failures: unknown[] = []

    await expect(
      migrateApplicationDatabase(client, {
        databasePath,
        onBackupRetirementFailed: (event) => failures.push(event)
      })
    ).resolves.toMatchObject({ applied: [] })
    expect(failures).toEqual([
      expect.objectContaining({
        migrationId: '0001_runtime_schema_baseline',
        path: backupPath,
        error: expect.any(Error)
      })
    ])
    await expect(access(backupPath)).resolves.toBeUndefined()
  })

  it.each([
    ['view', `CREATE VIEW "future_project_view" AS SELECT "id" FROM "Project"`],
    [
      'trigger',
      `CREATE TRIGGER "future_project_trigger" AFTER INSERT ON "Project"
       BEGIN UPDATE "Project" SET "name" = "name" WHERE "id" = NEW."id"; END`
    ]
  ])('rejects an unknown legacy %s without dropping it', async (kind, ddl) => {
    storageRoot = await mkdtemp(join(tmpdir(), `open-science-database-${kind}-`))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)
    await client.$executeRawUnsafe(ddl)

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed'
    })
    await expect(
      client.$queryRaw<Array<{ name: string }>>`
        SELECT "name" FROM "sqlite_schema" WHERE "type" = ${kind}
      `
    ).resolves.toHaveLength(1)
  })

  it('rejects a same-named index with the wrong uniqueness and columns', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-index-parity-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "UnreadTaskSession" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "sessionId" TEXT NOT NULL
    )`)
    await client.$executeRawUnsafe(
      `CREATE INDEX "UnreadTaskSession_sessionId_key" ON "UnreadTaskSession"("id")`
    )

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed'
    })
    await expect(
      client.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) AS "count" FROM "_open_science_migrations"
      `
    ).rejects.toThrow()
  })

  it('rejects a current column name with an incompatible storage definition', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-column-parity-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" INTEGER NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "archivedAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed'
    })
  })

  it.each([
    ['inline CHECK', '"name" TEXT NOT NULL CHECK (length("name") > 0)'],
    ['inline UNIQUE', '"name" TEXT NOT NULL UNIQUE'],
    ['inline COLLATE', '"name" TEXT NOT NULL COLLATE NOCASE'],
    ['unnamed table CHECK', '"name" TEXT NOT NULL', 'CHECK (length("name") > 0)'],
    ['unnamed table UNIQUE', '"name" TEXT NOT NULL', 'UNIQUE ("name")']
  ])('rejects an extra legacy %s constraint', async (_kind, nameDefinition, tableConstraint?) => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-constraint-parity-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      ${nameDefinition},
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "archivedAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL${tableConstraint ? `, ${tableConstraint}` : ''}
    )`)

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed'
    })
    await expect(
      client.$queryRaw<Array<{ name: string }>>`
        SELECT "name" FROM "sqlite_schema" WHERE "name" = '_open_science_migrations'
      `
    ).resolves.toEqual([])
  })

  it('rejects unsupported legacy table options', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-table-options-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "archivedAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    ) WITHOUT ROWID`)

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed'
    })
  })

  it('rejects an unconsumed inline primary-key modifier', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-column-modifier-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY DESC,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "archivedAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed'
    })
  })

  it('rolls back baseline schema changes when the ledger insert fails', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-rollback-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "_open_science_migrations" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "checksum" TEXT NOT NULL CHECK ("checksum" = 'reject-insert'),
      "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_migration_failed'
    })
    await expect(
      client.$queryRaw<Array<{ name: string }>>`
        SELECT "name" FROM "sqlite_schema"
        WHERE "type" = 'table' AND "name" = 'Project'
      `
    ).resolves.toEqual([])
    await expect(
      client.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) AS "count" FROM "_open_science_migrations"
      `
    ).resolves.toEqual([{ count: 0n }])
  })
})
