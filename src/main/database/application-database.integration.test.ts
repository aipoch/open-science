import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Prisma, PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { applyRuntimeSchemaBaseline } from './legacy-baseline-adapter'
import { ProjectRepository } from '../projects/repository'
import {
  createProjectDbClient,
  disconnectProjectDbClient,
  migrateApplicationDatabase,
  getProjectDbClient
} from '../projects/prisma-client'
import { ReviewRepository } from '../reviewer/repository'

// Proves the application database schema and migration adapters are compatible with the generated
// Prisma client against a real SQLite database. Requires the query engine from development installs.

let storageRoot: string | undefined
let disconnect: (() => Promise<void>) | undefined

const removeAgentMemoryTriggers = async (client: PrismaClient): Promise<void> => {
  await client.$executeRawUnsafe('DROP TRIGGER "MemoryEntry_fts_insert"')
  await client.$executeRawUnsafe('DROP TRIGGER "MemoryEntry_fts_delete"')
  await client.$executeRawUnsafe('DROP TRIGGER "MemoryEntry_fts_update"')
  await client.$executeRawUnsafe('DROP TRIGGER "MemoryCategory_about_you_delete"')
  await client.$executeRawUnsafe('DROP TRIGGER "MemoryCategory_about_you_update"')
  await client.$executeRawUnsafe('DROP TRIGGER "MemoryCategory_custom_limit"')
  await client.$executeRawUnsafe('DROP TABLE "MemoryEntryFts"')
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

const removeComputeAnalysisSchema = async (client: PrismaClient): Promise<void> => {
  await client.$executeRawUnsafe('DROP TABLE "ComputeJobOperation"')
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
    '"analysisState" TEXT',
    '"analysisMessageId" TEXT',
    '"analysisUpdatedAt" DATETIME'
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
        !['analysisState', 'analysisMessageId', 'analysisUpdatedAt'].includes(name)
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

afterEach(async () => {
  await disconnect?.()
  disconnect = undefined

  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('application database (integration)', () => {
  it('covers every Prisma scalar field in the runtime SQLite schema', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-project-schema-parity-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)

    for (const model of Prisma.dmmf.datamodel.models) {
      const tableName = model.dbName ?? model.name
      const columns = await client.$queryRawUnsafe<Array<{ name: string }>>(
        `PRAGMA table_info("${tableName.replaceAll('"', '""')}")`
      )
      const runtimeColumns = new Set(columns.map((column) => column.name))
      const missingColumns = model.fields
        .filter((field) => field.kind === 'scalar')
        .map((field) => field.dbName ?? field.name)
        .filter((fieldName) => !runtimeColumns.has(fieldName))

      expect(missingColumns, `${tableName} runtime DDL is missing Prisma columns`).toEqual([])
    }
  })

  it('adds visibility and pin state to an existing Project without rewriting its activity time', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-project-archive-migration-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)
    await client.$executeRawUnsafe(
      `INSERT INTO "Project" ("id", "name", "updatedAt") VALUES ('project-1', 'Project', '2026-08-06T00:00:00.000Z')`
    )

    await migrateApplicationDatabase(client)

    await expect(
      client.project.findUniqueOrThrow({ where: { id: 'project-1' } })
    ).resolves.toMatchObject({
      archivedAt: null,
      pinned: false,
      updatedAt: new Date('2026-08-06T00:00:00.000Z')
    })
  })

  it('adds the Agent Context column to an existing Project table with an empty default', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-project-agent-context-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)
    await client.$executeRawUnsafe(
      `INSERT INTO "Project" ("id", "name", "updatedAt") VALUES ('project-1', 'Project', '2026-08-06T00:00:00.000Z')`
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
      ]
    })

    await expect(
      client.project.findUniqueOrThrow({ where: { id: 'project-1' } })
    ).resolves.toMatchObject({ agentContext: '' })
  })

  it('creates the Permission Grant authority table with constrained scopes and owner cascade', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-permission-grant-schema-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    const columns = await client.$queryRawUnsafe<Array<{ name: string }>>(
      'PRAGMA table_info("PermissionGrant")'
    )
    expect(columns.map((column) => column.name)).toEqual([
      'id',
      'capabilityKind',
      'capabilityKey',
      'qualifierMode',
      'qualifierValue',
      'scopeKind',
      'projectId',
      'sessionId',
      'fingerprint',
      'revision',
      'createdAt'
    ])

    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    await client.$executeRawUnsafe(
      `INSERT INTO "PermissionGrant" ("id", "capabilityKind", "capabilityKey", "scopeKind", "projectId", "fingerprint") VALUES ('grant-1', 'execution', 'exec:agent/shell', 'project', 'project-1', 'fingerprint-1')`
    )
    await expect(
      client.$executeRawUnsafe(
        `INSERT INTO "PermissionGrant" ("id", "capabilityKind", "capabilityKey", "scopeKind", "projectId", "sessionId", "fingerprint") VALUES ('grant-invalid', 'execution', 'exec:agent/shell', 'global', 'project-1', 'session-1', 'fingerprint-invalid')`
      )
    ).rejects.toThrow()

    await client.project.delete({ where: { id: 'project-1' } })
    await expect(
      client.$queryRawUnsafe<Array<{ id: string }>>('SELECT "id" FROM "PermissionGrant"')
    ).resolves.toEqual([])
  })

  it('creates the Granted Local Root table with a unique path index', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-granted-root-schema-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)

    const columns = await client.$queryRawUnsafe<Array<{ name: string }>>(
      'PRAGMA table_info("GrantedLocalRoot")'
    )
    expect(columns.map((column) => column.name)).toEqual([
      'id',
      'path',
      'name',
      'access',
      'createdAt',
      'updatedAt'
    ])

    const indexes = await client.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'GrantedLocalRoot'`
    )
    expect(indexes.map((index) => index.name)).toContain('GrantedLocalRoot_path_key')

    await client.$executeRawUnsafe(
      `INSERT INTO "GrantedLocalRoot" ("id", "path", "name", "access", "updatedAt") VALUES ('root-1', '/data/one', 'one', 'ro', CURRENT_TIMESTAMP)`
    )
    await expect(
      client.$executeRawUnsafe(
        `INSERT INTO "GrantedLocalRoot" ("id", "path", "name", "access", "updatedAt") VALUES ('root-2', '/data/one', 'one', 'rw', CURRENT_TIMESTAMP)`
      )
    ).rejects.toThrow()

    // Migrating again is idempotent against the now-populated table.
    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
  })

  it('creates an unread-task table that rejects duplicate session IDs', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-unread-task-schema-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)

    const columns = await client.$queryRawUnsafe<Array<{ name: string }>>(
      'PRAGMA table_info("UnreadTaskSession")'
    )
    expect(columns.map((column) => column.name)).toEqual(['id', 'sessionId'])

    await client.$executeRawUnsafe(
      'INSERT INTO "UnreadTaskSession" ("sessionId") VALUES (\'session-1\')'
    )
    await expect(
      client.$executeRawUnsafe(
        'INSERT INTO "UnreadTaskSession" ("sessionId") VALUES (\'session-1\')'
      )
    ).rejects.toThrow()
  })

  it('rejects unsupported File Origin lifecycle states in a fresh database', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-origin-state-constraint-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    await client.fileOriginSession.create({
      data: {
        projectId: 'project-1',
        sessionId: 'session-1',
        state: 'active'
      }
    })

    await expect(
      client.fileOriginSession.update({
        where: { projectId_sessionId: { projectId: 'project-1', sessionId: 'session-1' } },
        data: { state: 'unsupported' }
      })
    ).rejects.toThrow()
  })

  it('upgrades an unconstrained File Origin table without losing valid rows', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-origin-state-migration-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

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
    await client.$executeRawUnsafe(
      `INSERT INTO "FileOriginSession" ("projectId", "sessionId", "state", "updatedAt") VALUES ('project-1', 'session-1', 'active', CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(`CREATE TABLE "ArtifactLineage" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "projectId" TEXT NOT NULL,
      "sessionId" TEXT NOT NULL,
      "normalizedFilename" TEXT NOT NULL,
      "filename" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "ArtifactLineage_projectId_sessionId_fkey" FOREIGN KEY ("projectId", "sessionId") REFERENCES "FileOriginSession" ("projectId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE
    )`)
    await client.$executeRawUnsafe(
      `INSERT INTO "ArtifactLineage" ("id", "projectId", "sessionId", "normalizedFilename", "filename", "updatedAt") VALUES ('artifact-1', 'project-1', 'session-1', 'result.png', 'result.png', CURRENT_TIMESTAMP)`
    )

    await migrateApplicationDatabase(client)

    await expect(
      client.fileOriginSession.findUniqueOrThrow({
        where: { projectId_sessionId: { projectId: 'project-1', sessionId: 'session-1' } }
      })
    ).resolves.toMatchObject({ state: 'active' })
    await expect(
      client.artifactLineage.findUniqueOrThrow({ where: { id: 'artifact-1' } })
    ).resolves.toMatchObject({ projectId: 'project-1', sessionId: 'session-1' })
    await expect(
      client.$queryRawUnsafe<Array<Record<string, unknown>>>('PRAGMA foreign_key_check')
    ).resolves.toEqual([])
    await expect(
      client.fileOriginSession.update({
        where: { projectId_sessionId: { projectId: 'project-1', sessionId: 'session-1' } },
        data: { state: 'unsupported' }
      })
    ).rejects.toThrow()
  })

  it('blocks a legacy constraint migration without rewriting unsupported values', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-origin-state-invalid-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

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
    await client.$executeRawUnsafe(
      `INSERT INTO "FileOriginSession" ("projectId", "sessionId", "state", "updatedAt") VALUES ('project-1', 'session-1', 'corrupt', CURRENT_TIMESTAMP)`
    )

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
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
            length: 7,
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/)
          }
        }
      }
    })
    await expect(
      client.$queryRawUnsafe<Array<{ state: string }>>(
        `SELECT state FROM "FileOriginSession" WHERE "projectId" = 'project-1' AND "sessionId" = 'session-1'`
      )
    ).resolves.toEqual([{ state: 'corrupt' }])
  })

  it('refuses to rebuild a legacy table that contains unknown columns', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-origin-state-future-column-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await client.$executeRawUnsafe(`CREATE TABLE "FileOriginSession" (
      "projectId" TEXT NOT NULL,
      "sessionId" TEXT NOT NULL,
      "titleSnapshot" TEXT,
      "state" TEXT NOT NULL DEFAULT 'active',
      "deletedAt" DATETIME,
      "deletionOperationId" TEXT,
      "retainedReviewIdsJson" TEXT,
      "futureMarker" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      PRIMARY KEY ("projectId", "sessionId")
    )`)
    await client.$executeRawUnsafe(
      `INSERT INTO "FileOriginSession" ("projectId", "sessionId", "state", "futureMarker", "updatedAt") VALUES ('project-1', 'session-1', 'active', 'keep-me', CURRENT_TIMESTAMP)`
    )

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed',
      cause: {
        name: 'DatabaseValidationError',
        data: {
          kind: 'unknown-columns',
          table: 'FileOriginSession',
          actual: ['futureMarker']
        }
      }
    })
    await expect(
      client.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info('FileOriginSession')`)
    ).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'futureMarker' })]))
    await expect(
      client.$queryRawUnsafe<Array<{ futureMarker: string }>>(
        `SELECT "futureMarker" FROM "FileOriginSession" WHERE "projectId" = 'project-1' AND "sessionId" = 'session-1'`
      )
    ).resolves.toEqual([{ futureMarker: 'keep-me' }])
  })

  it('rejects unsupported lifecycle and source values across core Provenance records', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-provenance-constraints-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    await client.artifactLineage.create({
      data: {
        id: 'artifact-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        normalizedFilename: 'result.png',
        filename: 'result.png'
      }
    })
    await client.uploadFile.create({
      data: {
        id: 'upload-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        filename: 'input.csv',
        originalFilename: 'input.csv'
      }
    })
    await client.uploadVersion.create({
      data: {
        id: 'upload-version-1',
        uploadFileId: 'upload-1',
        versionNumber: 1,
        state: 'ready',
        contentStorageKey: 'uploads/input.csv',
        filename: 'input.csv',
        originalFilename: 'input.csv',
        sizeBytes: 3n,
        checksum: 'a'.repeat(64)
      }
    })
    await client.artifactMessageSnapshot.create({
      data: {
        id: 'message-snapshot-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        rootFrameId: 'root-1',
        agentFrameId: 'agent-1',
        messageBranchId: 'branch-1',
        terminalMessageId: 'message-1',
        state: 'ready',
        storageKey: 'messages/message-1.json',
        checksum: 'b'.repeat(64),
        messageCount: 1
      }
    })
    await client.artifactVersion.create({
      data: {
        id: 'artifact-version-1',
        artifactId: 'artifact-1',
        versionNumber: 1,
        filename: 'result.png',
        artifactRunId: 'artifact-run-1',
        rootFrameId: 'root-1',
        agentFrameId: 'agent-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-1',
        promptMessageId: 'prompt-1',
        state: 'pending',
        contentStorageKey: 'artifacts/result.png',
        evidenceStorageKey: 'artifacts/evidence.json',
        sizeBytes: 3n,
        checksum: 'c'.repeat(64),
        evidenceJson: '{}',
        evidenceChecksum: 'd'.repeat(64),
        evidenceSchemaVersion: 1
      }
    })
    await client.artifactVersionInput.create({
      data: {
        id: 'input-1',
        artifactVersionId: 'artifact-version-1',
        ordinal: 0,
        inputFileVersionId: 'upload-version-1',
        sourceKind: 'upload-version',
        sourceFileId: 'upload-1',
        sourceUploadVersionId: 'upload-version-1',
        sourceVersionNumber: 1,
        sourceProjectId: 'project-1',
        sourceSessionId: 'session-1',
        filename: 'input.csv',
        sizeBytes: 3n,
        checksum: 'a'.repeat(64),
        storageKey: 'uploads/input.csv',
        strongestAssociation: 'turn-attached'
      }
    })
    await client.review.create({
      data: {
        id: 'review-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        turnMessageId: 'message-1'
      }
    })
    await client.reviewScopeSnapshot.create({
      data: {
        id: 'review-snapshot-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        reviewId: 'review-1',
        scopeTurnMessageId: 'message-1',
        state: 'ready',
        snapshotJson: '{}',
        checksum: 'e'.repeat(64),
        storageKey: 'reviews/review-1.json',
        blockCount: 0
      }
    })

    await expect(
      client.uploadVersion.update({
        where: { id: 'upload-version-1' },
        data: { state: 'unsupported' }
      })
    ).rejects.toThrow()
    await expect(
      client.artifactMessageSnapshot.update({
        where: { id: 'message-snapshot-1' },
        data: { state: 'unsupported' }
      })
    ).rejects.toThrow()
    await expect(
      client.artifactVersion.update({
        where: { id: 'artifact-version-1' },
        data: { state: 'unsupported' }
      })
    ).rejects.toThrow()
    await expect(
      client.artifactVersionInput.update({
        where: { id: 'input-1' },
        data: { sourceKind: 'unsupported' }
      })
    ).rejects.toThrow()
    await expect(
      client.$executeRawUnsafe(
        `UPDATE "ArtifactVersionInput" SET "sourceArtifactVersionId" = 'artifact-version-1' WHERE "id" = 'input-1'`
      )
    ).rejects.toThrow()
    await expect(
      client.$executeRawUnsafe(
        `UPDATE "ArtifactVersionInput" SET "inputFileVersionId" = 'different-upload-version' WHERE "id" = 'input-1'`
      )
    ).rejects.toThrow()
    await expect(
      client.reviewScopeSnapshot.update({
        where: { id: 'review-snapshot-1' },
        data: { state: 'unsupported' }
      })
    ).rejects.toThrow()
  })

  it('adds the typed input source constraint to a legacy input table', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-input-source-migration-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    await client.$executeRawUnsafe('PRAGMA foreign_keys = OFF')
    await client.$executeRawUnsafe('DROP TABLE "ArtifactVersionInput"')
    await client.$executeRawUnsafe(`CREATE TABLE "ArtifactVersionInput" (
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
      CONSTRAINT "ArtifactVersionInput_sourceKind_check" CHECK ("sourceKind" IN ('artifact-version', 'upload-version'))
    )`)
    await client.$executeRawUnsafe('PRAGMA foreign_keys = ON')
    await client.$executeRawUnsafe('DROP TABLE "VisionEvidence"')
    await client.$executeRawUnsafe('DROP TABLE "TagAssignment"')
    await client.$executeRawUnsafe('DROP TABLE "Tag"')
    await removeAgentMemoryTriggers(client)
    // Simulate a current pre-ledger schema with the targeted legacy table shape.
    await client.$executeRawUnsafe('DROP TABLE "_open_science_migrations"')
    await client.$executeRawUnsafe('ALTER TABLE "Project" DROP COLUMN "agentContext"')
    await removeComputePasswordAuthSchema(client)
    await removeComputeAnalysisSchema(client)
    await client.$executeRawUnsafe('ALTER TABLE "ComputeJob" DROP COLUMN "sensitiveDataEncrypted"')

    await migrateApplicationDatabase(client)
    await client.$executeRawUnsafe('PRAGMA foreign_keys = OFF')
    await expect(
      client.$executeRawUnsafe(`INSERT INTO "ArtifactVersionInput" (
        "id", "artifactVersionId", "ordinal", "inputFileVersionId", "sourceKind", "sourceFileId",
        "sourceProjectId", "sourceSessionId", "filename", "sizeBytes", "checksum", "storageKey",
        "strongestAssociation"
      ) VALUES (
        'input-invalid', 'artifact-version-1', 0, 'upload-version-1', 'upload-version', 'upload-1',
        'project-1', 'session-1', 'input.csv', 3, '${'a'.repeat(64)}', 'uploads/input.csv',
        'turn-attached'
      )`)
    ).rejects.toThrow()
  })

  it('backfills and freezes filenames when upgrading legacy Artifact Versions', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-filename-migration-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    await client.artifactLineage.create({
      data: {
        id: 'artifact-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        normalizedFilename: 'result.png',
        filename: 'Result.png'
      }
    })
    await client.artifactVersion.create({
      data: {
        id: 'artifact-version-1',
        artifactId: 'artifact-1',
        versionNumber: 1,
        filename: 'Result.png',
        artifactRunId: 'artifact-run-1',
        rootFrameId: 'root-1',
        agentFrameId: 'agent-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-1',
        promptMessageId: 'prompt-1',
        state: 'pending',
        contentStorageKey: 'artifacts/result.png',
        evidenceStorageKey: 'artifacts/evidence.json',
        sizeBytes: 3n,
        checksum: 'a'.repeat(64),
        evidenceJson: '{}',
        evidenceChecksum: 'b'.repeat(64),
        evidenceSchemaVersion: 1
      }
    })

    const versionColumns = await client.$queryRawUnsafe<Array<{ name: string }>>(
      `PRAGMA table_info('ArtifactVersion')`
    )
    const legacyColumnList = versionColumns
      .map((column) => column.name)
      .filter((column) => column !== 'filename')
      .map((column) => `"${column.replaceAll('"', '""')}"`)
      .join(', ')
    await client.$executeRawUnsafe('PRAGMA foreign_keys = OFF')
    await client.$executeRawUnsafe(
      `CREATE TABLE "ArtifactVersionLegacy" AS SELECT ${legacyColumnList} FROM "ArtifactVersion"`
    )
    await client.$executeRawUnsafe('DROP TABLE "ArtifactVersion"')
    await client.$executeRawUnsafe(
      'ALTER TABLE "ArtifactVersionLegacy" RENAME TO "ArtifactVersion"'
    )
    await client.$executeRawUnsafe('PRAGMA foreign_keys = ON')
    await client.$executeRawUnsafe('DROP TABLE "VisionEvidence"')
    await client.$executeRawUnsafe('DROP TABLE "TagAssignment"')
    await client.$executeRawUnsafe('DROP TABLE "Tag"')
    await removeAgentMemoryTriggers(client)
    // Simulate a current pre-ledger schema with the targeted legacy table shape.
    await client.$executeRawUnsafe('DROP TABLE "_open_science_migrations"')
    await client.$executeRawUnsafe('ALTER TABLE "Project" DROP COLUMN "agentContext"')
    await removeComputePasswordAuthSchema(client)
    await removeComputeAnalysisSchema(client)
    await client.$executeRawUnsafe('ALTER TABLE "ComputeJob" DROP COLUMN "sensitiveDataEncrypted"')

    await migrateApplicationDatabase(client)

    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: 'artifact-version-1' } })
    ).resolves.toMatchObject({ filename: 'Result.png' })
    const migratedColumns = await client.$queryRawUnsafe<
      Array<{ name: string; notnull: bigint | number }>
    >(`PRAGMA table_info('ArtifactVersion')`)
    expect(migratedColumns.find((column) => column.name === 'filename')).toMatchObject({
      notnull: 1n
    })
    await expect(
      client.artifactVersion.update({
        where: { id: 'artifact-version-1' },
        data: { filename: '' }
      })
    ).rejects.toThrow()
  })

  it('does not hide additive migration failures when the requested column remains absent', async () => {
    const migrationFailure = new Error('simulated SQLite disk I/O failure')
    const client = {
      $executeRawUnsafe: vi.fn(async (ddl: string) => {
        if (ddl.includes('ALTER TABLE "Finding" ADD COLUMN "status"')) {
          throw migrationFailure
        }
        return 0
      }),
      $queryRawUnsafe: vi.fn(async () => [])
    } as unknown as PrismaClient

    await expect(
      applyRuntimeSchemaBaseline(client, {
        pendingCheckConstraints: [],
        verificationTarget: 'baseline'
      })
    ).rejects.toBe(migrationFailure)
  })

  it('releases and recreates the shared client for exclusive migration validation', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-project-client-drain-'))
    disconnect = disconnectProjectDbClient

    const first = await getProjectDbClient(storageRoot)
    await disconnectProjectDbClient()
    const second = await getProjectDbClient(storageRoot)

    expect(second).not.toBe(first)
    await expect(second.$queryRawUnsafe('PRAGMA integrity_check')).resolves.toBeDefined()
  })

  it('backs up legacy data through the shared client on a portable storage path', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open science 数据 legacy backup-'))
    const databasePath = join(storageRoot, 'open-science.db')
    const backupPath = `${databasePath}.before-0001_runtime_schema_baseline.backup`
    const seedClient = createProjectDbClient(storageRoot)
    try {
      await seedClient.$executeRawUnsafe(`CREATE TABLE "Project" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "description" TEXT NOT NULL DEFAULT '',
        "isExample" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL
      )`)
      await seedClient.$executeRaw`
        INSERT INTO "Project" ("id", "name", "updatedAt")
        VALUES (${'legacy-project'}, ${'Preserved'}, ${new Date('2026-01-02T03:04:05Z')})
      `
    } finally {
      await seedClient.$disconnect()
    }

    disconnect = disconnectProjectDbClient
    const client = await getProjectDbClient(storageRoot)

    await expect(access(backupPath)).resolves.toBeUndefined()
    await expect(
      client.project.findUniqueOrThrow({ where: { id: 'legacy-project' } })
    ).resolves.toMatchObject({ name: 'Preserved' })

    const backupClient = new PrismaClient({
      datasources: { db: { url: `file:${backupPath.replaceAll('\\', '/')}` } }
    })
    try {
      await expect(
        backupClient.$queryRaw<Array<{ id: string; name: string }>>`
          SELECT "id", "name" FROM "Project"
        `
      ).resolves.toEqual([{ id: 'legacy-project', name: 'Preserved' }])
      await expect(
        backupClient.$queryRaw<Array<{ name: string }>>`
          SELECT "name" FROM "sqlite_schema" WHERE "name" = '_open_science_migrations'
        `
      ).resolves.toEqual([])
    } finally {
      await backupClient.$disconnect()
    }
  })

  it('round-trips artifact lineage versions and enforces their session-scoped ordering keys', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-provenance-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)

    const provenanceTables = await client.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('FileOriginSession', 'ArtifactLineage', 'ArtifactVersion', 'ArtifactVersionInput', 'ArtifactMessageSnapshot', 'UploadFile', 'UploadVersion', 'ReviewFindingDisposition', 'ReviewScopeSnapshot') ORDER BY name`
    )
    expect(provenanceTables.map((table) => table.name)).toEqual([
      'ArtifactLineage',
      'ArtifactMessageSnapshot',
      'ArtifactVersion',
      'ArtifactVersionInput',
      'FileOriginSession',
      'ReviewFindingDisposition',
      'ReviewScopeSnapshot',
      'UploadFile',
      'UploadVersion'
    ])
    const findingColumns = await client.$queryRawUnsafe<Array<{ name: string }>>(
      `PRAGMA table_info('Finding')`
    )
    const managedFileColumns = await client.$queryRawUnsafe<Array<{ name: string }>>(
      `PRAGMA table_info('ManagedFile')`
    )
    const messageSnapshotColumns = await client.$queryRawUnsafe<Array<{ name: string }>>(
      `PRAGMA table_info('ArtifactMessageSnapshot')`
    )
    expect(findingColumns.map((column) => column.name)).toContain('artifactBindingState')
    expect(managedFileColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['sourceVersionId', 'checksum'])
    )
    expect(messageSnapshotColumns.map((column) => column.name)).toContain('checksum')

    await client.fileOriginSession.create({
      data: {
        projectId: 'project-1',
        sessionId: 'session-1',
        titleSnapshot: 'Sine analysis'
      }
    })
    await client.artifactLineage.create({
      data: {
        id: 'artifact-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        normalizedFilename: 'sin.png',
        filename: 'sin.png'
      }
    })

    const version = await client.artifactVersion.create({
      data: {
        id: 'version-1',
        artifactId: 'artifact-1',
        versionNumber: 1,
        filename: 'sin.png',
        artifactRunId: 'artifact-run-1',
        writeOperationId: 'write-1',
        writeRequestChecksum: 'a'.repeat(64),
        rootFrameId: 'root-frame-1',
        agentFrameId: 'agent-frame-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-segment-1',
        promptMessageId: 'prompt-1',
        state: 'pending',
        contentStorageKey:
          'artifacts/project-1/session-1/.provenance/artifact-1/versions/version-1/content',
        evidenceStorageKey:
          'artifacts/project-1/session-1/.provenance/artifact-1/versions/version-1/evidence.json',
        contentType: 'image/png',
        sizeBytes: 3n,
        checksum: 'b'.repeat(64),
        evidenceJson: '{"schema_version":1}',
        evidenceChecksum: 'c'.repeat(64),
        evidenceSchemaVersion: 1
      }
    })

    expect(version.versionNumber).toBe(1)
    expect(version.state).toBe('pending')

    await expect(
      client.artifactLineage.create({
        data: {
          id: 'artifact-2',
          projectId: 'project-1',
          sessionId: 'session-1',
          normalizedFilename: 'sin.png',
          filename: 'Sin.png'
        }
      })
    ).rejects.toThrow()

    await expect(
      client.artifactVersion.create({
        data: {
          ...version,
          id: 'version-2',
          writeOperationId: 'write-2'
        }
      })
    ).rejects.toThrow()

    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
  })

  it('ensures the schema (no seed) and round-trips CRUD', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-projects-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)

    const repository = new ProjectRepository(() => Promise.resolve(client))

    // A fresh install starts with no projects; the user creates the first one.
    expect(await repository.list()).toEqual([])

    // Ensuring again is idempotent (table already exists, still no seed).
    await migrateApplicationDatabase(client)
    expect(await repository.list()).toEqual([])

    const indexes = await client.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('ManagedFile', 'ManagedFileSessionSync')`
    )
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        'ManagedFile_projectId_source_sourceFileId_key',
        'ManagedFile_projectId_source_storageKey_key',
        'ManagedFile_projectId_source_deletedAt_sortAtMs_seq_idx',
        'ManagedFile_projectId_sessionId_source_deletedAt_sortAtMs_seq_idx',
        'ManagedFileSessionSync_projectId_deletedAt_groupSortAtMs_sessionId_idx'
      ])
    )

    // Create reads/writes every column type Prisma expects (TEXT, BOOLEAN, DATETIME defaults).
    const created = await repository.create({ name: 'Reproduction', description: 'demo' })
    expect(created.name).toBe('Reproduction')
    expect(created.description).toBe('demo')
    expect(created.isExample).toBe(false)
    expect(created.createdAt).toBeGreaterThan(0)
    expect(created.updatedAt).toBeGreaterThan(0)

    const fetched = await repository.get(created.id)
    expect(fetched?.name).toBe('Reproduction')

    const renamed = await repository.update({
      id: created.id,
      name: 'Renamed',
      expectedUpdatedAt: created.updatedAt
    })
    expect(renamed.name).toBe('Renamed')

    const pinned = await repository.update({
      id: created.id,
      pinned: true,
      expectedUpdatedAt: renamed.updatedAt
    })
    expect(pinned.pinned).toBe(true)
    expect(pinned.updatedAt).toBe(renamed.updatedAt)

    const archivedAt = renamed.updatedAt + 1000
    const archived = await repository.updateArchive(
      { id: created.id, archived: true, expectedArchivedAt: null },
      archivedAt
    )
    expect(archived.archivedAt).toBe(archivedAt)
    expect(archived.updatedAt).toBe(renamed.updatedAt)

    const restored = await repository.updateArchive(
      { id: created.id, archived: false, expectedArchivedAt: archivedAt },
      archivedAt + 1
    )
    expect(restored.archivedAt).toBeUndefined()
    expect(restored.updatedAt).toBe(renamed.updatedAt)

    // Any project is deletable — there is no protected default.
    await repository.delete(created.id)
    expect(await repository.get(created.id)).toBeNull()
    expect(await repository.list()).toEqual([])
  })

  it('rejects a stale Project update when the system clock moves backward', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-project-revision-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)

    const repository = new ProjectRepository(() => Promise.resolve(client))
    const created = await repository.create({ name: 'Original' })

    // Put the durable timestamp ahead of the database engine's wall clock. This models a Project
    // created before the system clock moved backward without changing the machine running the test.
    const futureUpdatedAt = new Date('2100-01-01T00:00:00.000Z')
    await client.project.update({
      where: { id: created.id },
      data: { updatedAt: futureUpdatedAt }
    })

    // SQLite applies this only inside the temporary test database. It deterministically reproduces
    // Prisma's wall-clock @updatedAt moving backward by retaining the previously durable value.
    await client.$executeRawUnsafe(`CREATE TRIGGER freeze_project_updated_at
      AFTER UPDATE OF name ON "Project"
      WHEN NEW."updatedAt" <= OLD."updatedAt"
      BEGIN
        UPDATE "Project" SET "updatedAt" = OLD."updatedAt" WHERE "id" = NEW."id";
      END`)

    const staleSnapshot = await repository.get(created.id)
    expect(staleSnapshot).not.toBeNull()

    const firstUpdate = await repository.update({
      id: created.id,
      name: 'First writer',
      expectedUpdatedAt: staleSnapshot!.updatedAt
    })
    expect(firstUpdate.name).toBe('First writer')

    await expect(
      repository.update({
        id: created.id,
        name: 'Stale writer',
        expectedUpdatedAt: staleSnapshot!.updatedAt
      })
    ).rejects.toThrow('Project changed elsewhere.')
  })

  it('does not roll back activity time when a concurrent edit races with archiving', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-project-archive-race-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)

    const repository = new ProjectRepository(() => Promise.resolve(client))
    const created = await repository.create({ name: 'Before edit' })
    const concurrentUpdatedAt = new Date('2099-01-01T00:00:00.000Z')
    const archivedAt = created.updatedAt + 1000

    await client.$executeRawUnsafe(`
      CREATE TRIGGER "simulate_concurrent_project_edit"
      BEFORE UPDATE OF "archivedAt" ON "Project"
      FOR EACH ROW
      BEGIN
        UPDATE "Project"
        SET "name" = 'Edited concurrently',
            "updatedAt" = '${concurrentUpdatedAt.toISOString()}'
        WHERE "id" = OLD."id";
      END
    `)

    await expect(
      repository.updateArchive(
        { id: created.id, archived: true, expectedArchivedAt: null },
        archivedAt
      )
    ).resolves.toMatchObject({
      name: 'Edited concurrently',
      archivedAt,
      updatedAt: concurrentUpdatedAt.getTime()
    })
  })

  // Verifies the runtime FINDING_TABLE_DDL + migration guard are byte-compatible with the Prisma
  // generated client for the reflagCount column (issue 15).
  it('Finding.reflagCount DDL column is Prisma-compatible and migration guard is idempotent', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-reflag-parity-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    // Fresh install: FINDING_TABLE_DDL already contains reflagCount; client can read/write it.
    await migrateApplicationDatabase(client)

    const reviewRepo = new ReviewRepository(() => Promise.resolve(client))

    const review = await reviewRepo.createReview({
      projectId: 'p1',
      sessionId: 's1',
      turnMessageId: 'm1',
      scope: { turnMessageId: 'm1', blocks: [], artifactVersionIds: [] }
    })

    await reviewRepo.addChecks(review.id, [
      { status: 'fail', claim: 'test claim', evidence: 'test evidence', sortIndex: 0 }
    ])

    const [stored] = await reviewRepo.getReviewsForSession('s1')
    // New finding defaults to 0.
    expect(stored.checks[0]!.reflagCount).toBe(0)

    // Increment and verify the Prisma client can read the updated value.
    await reviewRepo.incrementReflagCount(review.id, stored.checks[0]!.id)
    const [updated] = await reviewRepo.getReviewsForSession('s1')
    expect(updated.checks[0]!.reflagCount).toBe(1)

    // Migration guard is idempotent — calling migrateApplicationDatabase a second time must not throw.
    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
  })

  // Simulates an old DB that has the Finding table without reflagCount; the migration guard must add
  // the column without error, and existing rows must read back with reflagCount = 0.
  it('migration guard adds reflagCount to an old DB without the column', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-reflag-migrate-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    // Simulate an old DB: create the Finding table WITHOUT reflagCount (pre-issue-15 DDL).
    await client.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Review" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "projectId" TEXT NOT NULL,
      "sessionId" TEXT NOT NULL,
      "turnMessageId" TEXT NOT NULL,
      "scope" TEXT NOT NULL DEFAULT '{}',
      "lifecycle" TEXT NOT NULL DEFAULT 'running',
      "outcome" TEXT,
      "errorMessage" TEXT,
      "model" TEXT NOT NULL DEFAULT '',
      "reviewerLog" TEXT NOT NULL DEFAULT '[]',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)
    await client.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Finding" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "reviewId" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'pass',
      "resolution" TEXT NOT NULL DEFAULT 'open',
      "claim" TEXT NOT NULL DEFAULT '',
      "evidence" TEXT NOT NULL DEFAULT '',
      "locator" TEXT NOT NULL DEFAULT '{}',
      "artifactVersionId" TEXT,
      "sortIndex" INTEGER NOT NULL DEFAULT 0,
      CONSTRAINT "Finding_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`)

    // Insert a row into the old schema (no reflagCount column yet).
    await client.$executeRawUnsafe(
      `INSERT INTO "Review" ("id","projectId","sessionId","turnMessageId","scope","lifecycle","model","reviewerLog","updatedAt") VALUES ('r1','p1','s1','m1','{}','running','','[]',CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "Finding" ("id","reviewId","claim","evidence") VALUES ('f1','r1','old claim','old evidence')`
    )

    // Run migrateApplicationDatabase — the migration guard must add reflagCount without error.
    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
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
      ]
    })

    // Running it again is idempotent (guard catches duplicate-column error).
    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })

    // The old row reads back with reflagCount = 0 (the column default).
    const reviewRepo = new ReviewRepository(() => Promise.resolve(client))
    const [stored] = await reviewRepo.getReviewsForSession('s1')
    expect(stored.checks[0]!.reflagCount).toBe(0)
  })
})
