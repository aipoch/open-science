import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient } from '../projects/prisma-client'
import { ManagedFileIndexRepository } from '../project-files/repository'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { verifyCurrentRuntimeSchema } from './legacy-baseline-adapter'
import {
  BASELINE_CHECKSUM,
  MIGRATION_MANIFEST,
  PROJECT_AGENT_CONTEXT_CHECKSUM,
  checksumMigrationPayload,
  classifyDatabaseFailure,
  migrateApplicationDatabase,
  migrateApplicationDatabaseWithManifest,
  type MigrationManifestEntry
} from './migration-service'

const materializeVersioningBaseline = async (client: PrismaClient): Promise<void> => {
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
    VALUES (${MIGRATION_MANIFEST[0]!.id}, ${MIGRATION_MANIFEST[0]!.checksum})
  `
  await client.$executeRawUnsafe(`
    INSERT INTO "FileOriginSession"
      ("projectId", "sessionId", "state", "createdAt", "updatedAt")
    VALUES ('project-versioning', 'session-versioning', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `)
  await client.$executeRawUnsafe(`
    INSERT INTO "ArtifactLineage"
      ("id", "projectId", "sessionId", "normalizedFilename", "filename", "createdAt", "updatedAt")
    VALUES
      ('artifact-file', 'project-versioning', 'session-versioning', 'report.md', 'report.md', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `)
  await client.$executeRawUnsafe(`
    INSERT INTO "ArtifactVersion"
      ("id", "artifactId", "versionNumber", "filename", "artifactRunId", "rootFrameId",
       "agentFrameId", "messageBranchId", "runtimeSegmentId", "promptMessageId", "state",
       "contentStorageKey", "evidenceStorageKey", "sizeBytes", "checksum", "evidenceJson",
       "evidenceChecksum", "evidenceSchemaVersion", "createdAt", "updatedAt")
    VALUES
      ('artifact-v1', 'artifact-file', 1, 'report.md', 'run-1', 'root-1', 'agent-1', 'branch-1',
       'segment-1', 'prompt-1', 'finalized', 'artifact/v1.md', 'artifact/v1-evidence.json', 10,
       'checksum-a1', '{}', 'evidence-a1', 1, '2026-01-01T00:00:00.000Z', CURRENT_TIMESTAMP),
      ('artifact-v2', 'artifact-file', 2, 'report.md', 'run-2', 'root-2', 'agent-2', 'branch-2',
       'segment-2', 'prompt-2', 'finalized', 'artifact/v2.md', 'artifact/v2-evidence.json', 20,
       'checksum-a2', '{}', 'evidence-a2', 1, '2026-01-02T00:00:00.000Z', CURRENT_TIMESTAMP),
      ('artifact-v3-staging', 'artifact-file', 3, 'report.md', 'run-3', 'root-3', 'agent-3',
       'branch-3', 'segment-3', 'prompt-3', 'staging', 'artifact/v3.md',
       'artifact/v3-evidence.json', 30, 'checksum-a3', '{}', 'evidence-a3', 1,
       '2026-01-03T00:00:00.000Z', CURRENT_TIMESTAMP)
  `)
  await client.$executeRawUnsafe(`
    INSERT INTO "UploadFile"
      ("id", "projectId", "sessionId", "filename", "originalFilename", "createdAt", "updatedAt")
    VALUES
      ('upload-file', 'project-versioning', 'session-versioning', 'notes.txt', 'notes.txt', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `)
  await client.$executeRawUnsafe(`
    INSERT INTO "UploadVersion"
      ("id", "uploadFileId", "versionNumber", "state", "contentStorageKey", "filename",
       "originalFilename", "sizeBytes", "checksum", "createdAt", "registeredAt", "updatedAt")
    VALUES
      ('upload-v1', 'upload-file', 1, 'ready', 'upload/v1.txt', 'notes.txt', 'notes.txt', 10,
       'checksum-u1', '2026-01-01T00:00:00.000Z', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('upload-v2', 'upload-file', 2, 'ready', 'upload/v2.txt', 'notes.txt', 'notes.txt', 20,
       'checksum-u2', '2026-01-02T00:00:00.000Z', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `)
  await client.$executeRawUnsafe(`
    INSERT INTO "ManagedFile"
      ("source", "sourceFileId", "sourceVersionId", "checksum", "projectId", "sessionId",
       "displayName", "storageKey", "sizeBytes", "sortAtMs", "createdAt", "updatedAt")
    VALUES
      ('artifact', 'artifact-file', 'artifact-v1', 'checksum-a1', 'project-versioning',
       'session-versioning', 'report.md', 'artifact/v1.md', 10, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('upload', 'upload-file', 'upload-v1', 'checksum-u1', 'project-versioning',
       'session-versioning', 'notes.txt', 'upload/v1.txt', 10, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `)
}

const futureTestMigration = (): MigrationManifestEntry => {
  const id = '0005_test_suffix'
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
        '0004_managed_file_version_foundation'
      ],
      from: null,
      to: '0004_managed_file_version_foundation'
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
      from: '0004_managed_file_version_foundation',
      to: '0004_managed_file_version_foundation'
    })
  })

  it('materializes the generated current target after applying the full manifest', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-current-target-'))
    client = createProjectDbClient(storageRoot)

    await migrateApplicationDatabase(client)

    await expect(verifyCurrentRuntimeSchema(client)).resolves.toBeUndefined()
  })

  it('backfills explicit heads and derivation chains while preserving legacy storage names', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-versioning-migration-'))
    client = createProjectDbClient(storageRoot)
    await materializeVersioningBaseline(client)

    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
      adoptedLegacy: false,
      applied: [
        '0002_project_agent_context',
        '0003_granted_local_roots',
        '0004_managed_file_version_foundation'
      ],
      to: '0004_managed_file_version_foundation'
    })

    await expect(
      client.$queryRaw<Array<{ id: string; currentVersionId: string | null }>>`
        SELECT "id", "currentVersionId" FROM "ArtifactLineage"
      `
    ).resolves.toEqual([{ id: 'artifact-file', currentVersionId: 'artifact-v2' }])
    await expect(
      client.$queryRaw<Array<{ id: string; currentVersionId: string | null }>>`
        SELECT "id", "currentVersionId" FROM "UploadFile"
      `
    ).resolves.toEqual([{ id: 'upload-file', currentVersionId: 'upload-v2' }])
    await expect(
      client.$queryRaw<
        Array<{
          id: string
          basedOnVersionId: string | null
          originKind: string
          storedFilename: string | null
          managedVisibleAt: Date | null
        }>
      >`
        SELECT "id", "basedOnVersionId", "originKind", "storedFilename", "managedVisibleAt"
        FROM "ArtifactVersion" ORDER BY "versionNumber"
      `
    ).resolves.toEqual([
      {
        id: 'artifact-v1',
        basedOnVersionId: null,
        originKind: 'agent_generated',
        storedFilename: null,
        managedVisibleAt: new Date('2026-01-01T00:00:00.000Z')
      },
      {
        id: 'artifact-v2',
        basedOnVersionId: 'artifact-v1',
        originKind: 'agent_generated',
        storedFilename: null,
        managedVisibleAt: new Date('2026-01-02T00:00:00.000Z')
      },
      {
        id: 'artifact-v3-staging',
        basedOnVersionId: 'artifact-v2',
        originKind: 'agent_generated',
        storedFilename: null,
        managedVisibleAt: null
      }
    ])
    await expect(
      client.$queryRaw<Array<{ source: string; sourceVersionId: string; storageKey: string }>>`
        SELECT "source", "sourceVersionId", "storageKey" FROM "ManagedFile" ORDER BY "source"
      `
    ).resolves.toEqual([
      { source: 'artifact', sourceVersionId: 'artifact-v2', storageKey: 'artifact/v2.md' },
      { source: 'upload', sourceVersionId: 'upload-v2', storageKey: 'upload/v2.txt' }
    ])
  })

  it('builds derivation chains from the previous readable version across staging gaps', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-versioning-readable-chain-'))
    client = createProjectDbClient(storageRoot)
    await materializeVersioningBaseline(client)
    await client.$executeRawUnsafe(`
      INSERT INTO "ArtifactVersion"
        ("id", "artifactId", "versionNumber", "filename", "artifactRunId", "rootFrameId",
         "agentFrameId", "messageBranchId", "runtimeSegmentId", "promptMessageId", "state",
         "contentStorageKey", "evidenceStorageKey", "sizeBytes", "checksum", "evidenceJson",
         "evidenceChecksum", "evidenceSchemaVersion", "createdAt", "updatedAt")
      VALUES
        ('artifact-v4', 'artifact-file', 4, 'report.md', 'run-4', 'root-4', 'agent-4', 'branch-4',
         'segment-4', 'prompt-4', 'finalized', 'artifact/v4.md', 'artifact/v4-evidence.json', 40,
         'checksum-a4', '{}', 'evidence-a4', 1, '2026-01-04T00:00:00.000Z', CURRENT_TIMESTAMP)
    `)
    await client.$executeRawUnsafe(`
      INSERT INTO "UploadVersion"
        ("id", "uploadFileId", "versionNumber", "state", "contentStorageKey", "filename",
         "originalFilename", "sizeBytes", "checksum", "createdAt", "registeredAt", "updatedAt")
      VALUES
        ('upload-v3-staging', 'upload-file', 3, 'staging', 'upload/v3.txt', 'notes.txt',
         'notes.txt', 30, 'checksum-u3', '2026-01-03T00:00:00.000Z', CURRENT_TIMESTAMP,
         CURRENT_TIMESTAMP),
        ('upload-v4', 'upload-file', 4, 'ready', 'upload/v4.txt', 'notes.txt', 'notes.txt', 40,
         'checksum-u4', '2026-01-04T00:00:00.000Z', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `)

    await migrateApplicationDatabase(client)

    await expect(
      client.$queryRaw<Array<{ id: string; basedOnVersionId: string | null }>>`
        SELECT "id", "basedOnVersionId" FROM "ArtifactVersion" WHERE "id" = 'artifact-v4'
      `
    ).resolves.toEqual([{ id: 'artifact-v4', basedOnVersionId: 'artifact-v2' }])
    await expect(
      client.$queryRaw<Array<{ id: string; basedOnVersionId: string | null }>>`
        SELECT "id", "basedOnVersionId" FROM "UploadVersion" WHERE "id" = 'upload-v4'
      `
    ).resolves.toEqual([{ id: 'upload-v4', basedOnVersionId: 'upload-v2' }])
  })

  it('rebuilds missing and stale ManagedFile head projections without reviving tombstones', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-versioning-projection-'))
    client = createProjectDbClient(storageRoot)
    await materializeVersioningBaseline(client)
    await client.$executeRawUnsafe(`
      UPDATE "ArtifactVersion"
      SET "contentType" = 'text/markdown', "messageId" = 'message-v2'
      WHERE "id" = 'artifact-v2'
    `)
    await client.$executeRawUnsafe(`
      UPDATE "UploadVersion"
      SET "contentType" = 'text/plain', "filename" = 'stored-notes-v2.txt',
          "originalFilename" = 'Original notes.txt'
      WHERE "id" = 'upload-v2'
    `)
    await client.$executeRawUnsafe(`
      UPDATE "ManagedFile"
      SET "displayName" = 'stale.md', "storageKey" = 'artifact/stale.md', "mimeType" = 'wrong',
          "sizeBytes" = 999, "checksum" = 'stale', "mtimeMs" = 3, "sortAtMs" = 4,
          "deletedAt" = '2026-02-01T00:00:00.000Z', "deleteOperationId" = 'delete-1'
      WHERE "source" = 'artifact' AND "sourceFileId" = 'artifact-file'
    `)
    await client.$executeRawUnsafe(`
      UPDATE "ManagedFile"
      SET "messageId" = 'message-preserved', "displayName" = 'stale-upload-name.txt',
          "sortAtMs" = 987654321
      WHERE "source" = 'upload' AND "sourceFileId" = 'upload-file'
    `)
    await client.$executeRawUnsafe(`
      INSERT INTO "UploadFile"
        ("id", "projectId", "sessionId", "filename", "originalFilename", "createdAt", "updatedAt")
      VALUES
        ('upload-missing', 'project-versioning', 'session-versioning', 'stored-data.csv',
         '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `)
    await client.$executeRawUnsafe(`
      INSERT INTO "UploadVersion"
        ("id", "uploadFileId", "versionNumber", "state", "contentStorageKey", "filename",
         "originalFilename", "contentType", "sizeBytes", "checksum", "createdAt", "registeredAt",
         "updatedAt")
      VALUES
        ('upload-missing-v1', 'upload-missing', 1, 'ready', 'upload/missing-v1.csv',
         'stored-data.csv', '', 'text/csv', 30, 'checksum-missing',
         '2026-01-03T00:00:00.000Z', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `)
    await client.managedFileSessionSync.create({
      data: {
        projectId: 'project-versioning',
        sessionId: 'session-versioning',
        filesRevision: 7,
        groupSortAtMs: 777,
        artifactCount: 1,
        uploadCount: 1
      }
    })
    await client.$executeRawUnsafe(`
      INSERT INTO "ArtifactLineage"
        ("id", "projectId", "sessionId", "normalizedFilename", "filename", "createdAt", "updatedAt")
      VALUES
        ('artifact-headless', 'project-versioning', 'session-versioning', 'headless.md', 'headless.md',
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `)
    await client.$executeRawUnsafe(`
      INSERT INTO "ArtifactVersion"
        ("id", "artifactId", "versionNumber", "filename", "artifactRunId", "rootFrameId",
         "agentFrameId", "messageBranchId", "runtimeSegmentId", "promptMessageId", "state",
         "contentStorageKey", "evidenceStorageKey", "sizeBytes", "checksum", "evidenceJson",
         "evidenceChecksum", "evidenceSchemaVersion", "createdAt", "updatedAt")
      VALUES
        ('artifact-headless-staging', 'artifact-headless', 1, 'headless.md', 'run-headless',
         'root-headless', 'agent-headless', 'branch-headless', 'segment-headless',
         'prompt-headless', 'staging', 'artifact/headless-staging.md',
         'artifact/headless-staging-evidence.json', 50, 'checksum-headless', '{}',
         'evidence-headless', 1, '2026-01-05T00:00:00.000Z', CURRENT_TIMESTAMP)
    `)
    await client.$executeRawUnsafe(`
      INSERT INTO "ManagedFile"
        ("source", "sourceFileId", "sourceVersionId", "checksum", "projectId", "sessionId",
         "displayName", "storageKey", "sizeBytes", "sortAtMs", "createdAt", "updatedAt")
      VALUES
        ('artifact', 'artifact-headless', 'artifact-headless-staging', 'checksum-headless',
         'project-versioning', 'session-versioning', 'headless.md', 'artifact/headless-staging.md',
         50, 5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `)

    await migrateApplicationDatabase(client)

    await expect(
      client.$queryRaw<
        Array<{
          source: string
          sourceFileId: string
          sourceVersionId: string | null
          checksum: string | null
          displayName: string
          storageKey: string
          mimeType: string | null
          sizeBytes: bigint
          mtimeMs: bigint | null
          sortAtMs: bigint
          messageId: string | null
          deletedAt: Date | null
          deleteOperationId: string | null
        }>
      >`
        SELECT "source", "sourceFileId", "sourceVersionId", "checksum", "displayName",
               "storageKey", "mimeType", "sizeBytes", "mtimeMs", "sortAtMs", "messageId",
               "deletedAt", "deleteOperationId"
        FROM "ManagedFile" ORDER BY "source", "sourceFileId"
      `
    ).resolves.toEqual([
      {
        source: 'artifact',
        sourceFileId: 'artifact-file',
        sourceVersionId: 'artifact-v2',
        checksum: 'checksum-a2',
        displayName: 'report.md',
        storageKey: 'artifact/v2.md',
        mimeType: 'text/markdown',
        sizeBytes: 20n,
        mtimeMs: 1767312000000n,
        sortAtMs: 1767312000000n,
        messageId: 'message-v2',
        deletedAt: new Date('2026-02-01T00:00:00.000Z'),
        deleteOperationId: 'delete-1'
      },
      {
        source: 'upload',
        sourceFileId: 'upload-file',
        sourceVersionId: 'upload-v2',
        checksum: 'checksum-u2',
        displayName: 'Original notes.txt',
        storageKey: 'upload/v2.txt',
        mimeType: 'text/plain',
        sizeBytes: 20n,
        mtimeMs: 1767312000000n,
        sortAtMs: 987654321n,
        messageId: 'message-preserved',
        deletedAt: null,
        deleteOperationId: null
      },
      {
        source: 'upload',
        sourceFileId: 'upload-missing',
        sourceVersionId: 'upload-missing-v1',
        checksum: 'checksum-missing',
        displayName: 'stored-data.csv',
        storageKey: 'upload/missing-v1.csv',
        mimeType: 'text/csv',
        sizeBytes: 30n,
        mtimeMs: 1767398400000n,
        sortAtMs: 1767398400000n,
        messageId: null,
        deletedAt: null,
        deleteOperationId: null
      }
    ])

    await expect(
      client.managedFileSessionSync.findUniqueOrThrow({
        where: {
          projectId_sessionId: {
            projectId: 'project-versioning',
            sessionId: 'session-versioning'
          }
        },
        select: { filesRevision: true }
      })
    ).resolves.toEqual({ filesRevision: -1 })

    const session: PersistedChatSession = {
      id: 'session-versioning',
      projectId: 'project-versioning',
      title: 'Versioning',
      cwd: '/workspace',
      status: 'idle',
      filesRevision: 7,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_500,
      messages: [
        {
          id: 'message-authoritative',
          role: 'user',
          content: 'Use both inputs',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: 'upload-file',
              versionId: 'upload-v2',
              versionNumber: 2,
              sessionId: 'session-versioning',
              name: 'stored-notes-v2.txt',
              originalName: 'Original notes.txt',
              mimeType: 'text/plain',
              size: 20
            },
            {
              id: 'upload-missing',
              versionId: 'upload-missing-v1',
              versionNumber: 1,
              sessionId: 'session-versioning',
              name: 'stored-data.csv',
              originalName: '',
              mimeType: 'text/csv',
              size: 30
            }
          ],
          createdAt: 1_700_000_000_100,
          updatedAt: 1_700_000_000_200
        }
      ]
    }
    const index = new ManagedFileIndexRepository(() => Promise.resolve(client!), storageRoot)
    await expect(index.syncSession(session)).resolves.toContain('upload')
    await expect(
      client.managedFile.findMany({
        where: { source: 'upload' },
        orderBy: { sourceFileId: 'asc' },
        select: { sourceFileId: true, messageId: true, sortAtMs: true }
      })
    ).resolves.toEqual([
      {
        sourceFileId: 'upload-file',
        messageId: 'message-authoritative',
        sortAtMs: 1_700_000_000_200n
      },
      {
        sourceFileId: 'upload-missing',
        messageId: 'message-authoritative',
        sortAtMs: 1_700_000_000_200n
      }
    ])
  })

  it('invalidates a current Session ledger before removing a legacy path-only Upload projection', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-versioning-legacy-upload-'))
    client = createProjectDbClient(storageRoot)
    await materializeVersioningBaseline(client)
    await client.$executeRawUnsafe(`DELETE FROM "ManagedFile" WHERE "source" = 'upload'`)
    await client.$executeRawUnsafe(`DELETE FROM "UploadVersion"`)
    await client.$executeRawUnsafe(`DELETE FROM "UploadFile"`)
    const legacyStorageKey = 'uploads/default-project/session-versioning/legacy-input.csv'
    const legacyPath = join(storageRoot, ...legacyStorageKey.split('/'))
    await mkdir(dirname(legacyPath), { recursive: true })
    await writeFile(legacyPath, 'legacy upload')
    await client.$executeRawUnsafe(`
      INSERT INTO "ManagedFile"
        ("source", "sourceFileId", "projectId", "sessionId", "messageId", "displayName",
         "storageKey", "mimeType", "sizeBytes", "mtimeMs", "sortAtMs", "createdAt", "updatedAt")
      VALUES
        ('upload', 'legacy-upload', 'project-versioning', 'session-versioning', 'message-stale',
         'Legacy input.csv', '${legacyStorageKey}', 'text/csv', 13, 111, 222,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `)
    await client.managedFileSessionSync.create({
      data: {
        projectId: 'project-versioning',
        sessionId: 'session-versioning',
        filesRevision: 7,
        groupSortAtMs: 222,
        artifactCount: 1,
        uploadCount: 1
      }
    })

    await migrateApplicationDatabase(client)
    await expect(
      client.managedFileSessionSync.findUniqueOrThrow({
        where: {
          projectId_sessionId: {
            projectId: 'project-versioning',
            sessionId: 'session-versioning'
          }
        },
        select: { filesRevision: true }
      })
    ).resolves.toEqual({ filesRevision: -1 })
    await expect(
      client.managedFile.count({ where: { sourceFileId: 'legacy-upload' } })
    ).resolves.toBe(0)

    const session: PersistedChatSession = {
      id: 'session-versioning',
      projectId: 'project-versioning',
      title: 'Legacy upload',
      cwd: '/workspace',
      status: 'idle',
      filesRevision: 7,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_500,
      messages: [
        {
          id: 'message-authoritative',
          role: 'user',
          content: 'Use legacy input',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: 'legacy-upload',
              sessionId: 'session-versioning',
              name: 'legacy-input.csv',
              originalName: 'Legacy input.csv',
              path: legacyPath,
              mimeType: 'text/csv',
              size: 13
            }
          ],
          createdAt: 1_700_000_000_100,
          updatedAt: 1_700_000_000_300
        }
      ]
    }
    const index = new ManagedFileIndexRepository(() => Promise.resolve(client!), storageRoot)
    await expect(index.syncSession(session)).resolves.toContain('upload')
    await expect(
      client.managedFile.findFirstOrThrow({
        where: { sourceFileId: 'legacy-upload' },
        select: { messageId: true, sortAtMs: true }
      })
    ).resolves.toEqual({
      messageId: 'message-authoritative',
      sortAtMs: 1_700_000_000_300n
    })
  })

  it('does not create active head projections for a tombstoned Session ledger', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-versioning-tombstone-projection-'))
    client = createProjectDbClient(storageRoot)
    await materializeVersioningBaseline(client)
    await client.managedFile.deleteMany({ where: { projectId: 'project-versioning' } })
    await client.managedFileSessionSync.create({
      data: {
        projectId: 'project-versioning',
        sessionId: 'session-versioning',
        filesRevision: 7,
        groupSortAtMs: 777,
        artifactCount: 1,
        uploadCount: 1,
        deletedAt: new Date('2026-02-01T00:00:00.000Z'),
        deleteOperationId: 'delete-session-1'
      }
    })

    await migrateApplicationDatabase(client)

    const index = new ManagedFileIndexRepository(() => Promise.resolve(client!), storageRoot)
    await expect(index.getOverview('project-versioning')).resolves.toMatchObject({
      totalCount: 0,
      artifactCount: 0,
      uploadCount: 0
    })
    await expect(
      client.managedFile.count({
        where: { projectId: 'project-versioning', deletedAt: null }
      })
    ).resolves.toBe(0)
  })

  it('keeps missing head projections absent during current-schema adoption for a deleting Project', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-versioning-deleting-project-'))
    client = createProjectDbClient(storageRoot)
    await materializeVersioningBaseline(client)
    await migrateApplicationDatabase(client)
    await client.managedFile.deleteMany({ where: { projectId: 'project-versioning' } })
    await client.projectDeletionIntent.create({ data: { projectId: 'project-versioning' } })
    await client.$executeRawUnsafe('DROP TABLE "_open_science_migrations"')

    await migrateApplicationDatabase(client)

    const index = new ManagedFileIndexRepository(() => Promise.resolve(client!), storageRoot)
    await expect(index.getOverview('project-versioning')).resolves.toMatchObject({
      totalCount: 0,
      artifactCount: 0,
      uploadCount: 0
    })
    await expect(
      client.managedFile.count({
        where: { projectId: 'project-versioning', deletedAt: null }
      })
    ).resolves.toBe(0)
  })

  it('allows user-edited artifacts without fabricated Agent provenance', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-versioning-provenance-'))
    client = createProjectDbClient(storageRoot)
    await materializeVersioningBaseline(client)
    await migrateApplicationDatabase(client)

    await expect(
      client.$executeRaw`
        INSERT INTO "ArtifactVersion"
          ("id", "artifactId", "versionNumber", "filename", "originKind", "basedOnVersionId",
           "state", "contentStorageKey", "storageTag", "storedFilename", "sizeBytes", "checksum",
           "createdAt", "updatedAt")
        VALUES
          ('artifact-user-edit', 'artifact-file', 4, 'report.md', 'user_edit', 'artifact-v1',
           'finalized', 'artifact/vk3m8q2az_report.md', 'vk3m8q2az', 'vk3m8q2az_report.md', 11,
           'checksum-edit', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `
    ).resolves.toBe(1)

    await expect(
      client.$executeRaw`
        INSERT INTO "ArtifactVersion"
          ("id", "artifactId", "versionNumber", "filename", "originKind", "basedOnVersionId",
           "artifactRunId", "rootFrameId", "agentFrameId", "messageBranchId", "runtimeSegmentId",
           "promptMessageId", "evidenceStorageKey", "evidenceJson", "evidenceChecksum",
           "evidenceSchemaVersion", "state", "contentStorageKey", "sizeBytes", "checksum",
           "createdAt", "updatedAt")
        VALUES
          ('artifact-user-edit-fake', 'artifact-file', 5, 'report.md', 'user_edit', 'artifact-v1',
           'fake-run', 'fake-root', 'fake-agent', 'fake-branch', 'fake-segment', 'fake-prompt',
           'fake-evidence', '{}', 'fake-checksum', 1, 'finalized', 'artifact/fake.md', 12,
           'checksum-fake', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `
    ).rejects.toThrow()
  })

  it.each([
    ['artifactRunId', "'forged'"],
    ['writeRequestChecksum', "'forged'"],
    ['rootFrameId', "'forged'"],
    ['agentFrameId', "'forged'"],
    ['messageBranchId', "'forged'"],
    ['runtimeSegmentId', "'forged'"],
    ['promptMessageId', "'forged'"],
    ['notebookSessionId', "'forged'"],
    ['producerRunId', "'forged'"],
    ['producerRunIndex', '1'],
    ['messageId', "'forged'"],
    ['messageSnapshotId', "'snapshot-forged'"],
    ['evidenceStorageKey', "'forged'"],
    ['evidenceJson', "'{}'"],
    ['evidenceChecksum', "'forged'"],
    ['evidenceSchemaVersion', '1'],
    ['executionSnapshotJson', "'{}'"],
    ['executionSnapshotChecksum', "'forged'"],
    ['executionSnapshotStorageKey', "'forged'"],
    ['executionSnapshotSchemaVersion', '1']
  ])('rejects user-edited Artifact Agent field %s', async (column, sqlValue) => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-versioning-user-edit-check-'))
    client = createProjectDbClient(storageRoot)
    await materializeVersioningBaseline(client)
    await migrateApplicationDatabase(client)
    await client.artifactMessageSnapshot.create({
      data: {
        id: 'snapshot-forged',
        projectId: 'project-versioning',
        sessionId: 'session-versioning',
        rootFrameId: 'root-forged',
        agentFrameId: 'agent-forged',
        messageBranchId: 'branch-forged',
        terminalMessageId: 'message-forged',
        state: 'ready',
        storageKey: 'snapshot/forged.json',
        checksum: 'checksum-forged',
        messageCount: 1
      }
    })

    await expect(
      client.$executeRawUnsafe(`
        INSERT INTO "ArtifactVersion"
          ("id", "artifactId", "versionNumber", "filename", "originKind", "basedOnVersionId",
           "storageTag", "storedFilename", "state", "contentStorageKey", "sizeBytes", "checksum",
           "${column}", "createdAt", "updatedAt")
        VALUES
          ('artifact-user-edit-forged', 'artifact-file', 4, 'report.md', 'user_edit', 'artifact-v1',
           'vk3m8q2az', 'vk3m8q2az_report.md', 'finalized', 'artifact/forged-report.md', 12,
           'checksum-forged', ${sqlValue}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `)
    ).rejects.toThrow()
  })

  it('records staging writes without allocating a visible content version', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-versioning-write-log-'))
    client = createProjectDbClient(storageRoot)
    await materializeVersioningBaseline(client)
    await migrateApplicationDatabase(client)

    await client.$executeRaw`
      INSERT INTO "ManagedFileVersionWriteOperation"
        ("operationId", "source", "projectId", "sourceFileId", "basedOnVersionId",
         "expectedHeadVersionId", "state", "storageTag", "storedFilename", "contentStorageKey",
         "checksum", "sizeBytes", "textFormatJson", "createdAt", "updatedAt")
      VALUES
        ('operation-1', 'artifact', 'project-versioning', 'artifact-file', 'artifact-v1',
         'artifact-v2', 'staging', 'vk3m8q2az', 'vk3m8q2az_report.md',
         'artifact/vk3m8q2az_report.md', 'checksum-staged', 12, '{}', CURRENT_TIMESTAMP,
         CURRENT_TIMESTAMP)
    `

    await expect(
      client.$queryRaw<Array<{ maximumVersion: bigint }>>`
        SELECT MAX("versionNumber") AS "maximumVersion" FROM "ArtifactVersion"
        WHERE "state" = 'finalized'
      `
    ).resolves.toEqual([{ maximumVersion: 2n }])
  })

  it('rolls back schema and ledger when rebuilt rows fail foreign-key integrity', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-versioning-broken-foreign-key-'))
    client = createProjectDbClient(storageRoot)
    await materializeVersioningBaseline(client)
    await client.$executeRawUnsafe('PRAGMA foreign_keys = OFF')
    await client.$executeRawUnsafe(`
      INSERT INTO "ArtifactVersion"
        ("id", "artifactId", "versionNumber", "filename", "artifactRunId", "rootFrameId",
         "agentFrameId", "messageBranchId", "runtimeSegmentId", "promptMessageId", "state",
         "contentStorageKey", "evidenceStorageKey", "sizeBytes", "checksum", "evidenceJson",
         "evidenceChecksum", "evidenceSchemaVersion", "createdAt", "updatedAt")
      VALUES
        ('artifact-orphan', 'missing-lineage', 1, 'orphan.md', 'run-orphan', 'root-orphan',
         'agent-orphan', 'branch-orphan', 'segment-orphan', 'prompt-orphan', 'finalized',
         'artifact/orphan.md', 'artifact/orphan-evidence.json', 10, 'checksum-orphan', '{}',
         'evidence-orphan', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `)
    await client.$executeRawUnsafe('PRAGMA foreign_keys = ON')

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed',
      migrationId: '0004_managed_file_version_foundation'
    })
    await expect(
      client.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "_open_science_migrations" ORDER BY "id"
      `
    ).resolves.toEqual([
      { id: '0001_runtime_schema_baseline' },
      { id: '0002_project_agent_context' },
      { id: '0003_granted_local_roots' }
    ])
    await expect(
      client.$queryRaw<Array<{ name: string }>>`
        SELECT "name" FROM pragma_table_info('ArtifactVersion') WHERE "name" = 'originKind'
      `
    ).resolves.toEqual([])
    await expect(
      client.$queryRaw<Array<{ foreign_keys: bigint }>>`PRAGMA foreign_keys`
    ).resolves.toEqual([{ foreign_keys: 1n }])
  })

  it('rejects a non-completed head during the always-on version-domain audit', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-versioning-invalid-head-'))
    client = createProjectDbClient(storageRoot)
    await materializeVersioningBaseline(client)
    await migrateApplicationDatabase(client)
    await client.artifactLineage.update({
      where: { id: 'artifact-file' },
      data: { currentVersionId: 'artifact-v3-staging' }
    })

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed'
    })
  })

  it('rejects a derivation from a non-completed or newer version during domain audit', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-versioning-invalid-derivation-'))
    client = createProjectDbClient(storageRoot)
    await materializeVersioningBaseline(client)
    await migrateApplicationDatabase(client)
    await client.artifactVersion.update({
      where: { id: 'artifact-v2' },
      data: { basedOnVersionId: 'artifact-v3-staging' }
    })

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed'
    })
  })

  it('rejects orphaned relations during the always-on integrity audit', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-versioning-orphan-audit-'))
    client = createProjectDbClient(storageRoot)
    await materializeVersioningBaseline(client)
    await migrateApplicationDatabase(client)
    await client.$executeRawUnsafe('PRAGMA foreign_keys = OFF')
    await client.$executeRawUnsafe(`DELETE FROM "ArtifactVersion" WHERE "id" = 'artifact-v2'`)
    await client.$executeRawUnsafe('PRAGMA foreign_keys = ON')

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed'
    })
  })

  it('enforces Artifact head and derivation ownership in SQLite', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-versioning-artifact-ownership-'))
    client = createProjectDbClient(storageRoot)
    await materializeVersioningBaseline(client)
    await migrateApplicationDatabase(client)
    await client.artifactLineage.create({
      data: {
        id: 'artifact-other',
        projectId: 'project-versioning',
        sessionId: 'session-versioning',
        normalizedFilename: 'other.md',
        filename: 'other.md'
      }
    })
    await client.artifactVersion.create({
      data: {
        id: 'artifact-other-v1',
        artifactId: 'artifact-other',
        versionNumber: 1,
        filename: 'other.md',
        artifactRunId: 'run-other',
        rootFrameId: 'root-other',
        agentFrameId: 'agent-other',
        messageBranchId: 'branch-other',
        runtimeSegmentId: 'segment-other',
        promptMessageId: 'prompt-other',
        state: 'finalized',
        contentStorageKey: 'artifact/other-v1.md',
        evidenceStorageKey: 'artifact/other-v1-evidence.json',
        sizeBytes: 10,
        checksum: 'checksum-other',
        evidenceJson: '{}',
        evidenceChecksum: 'evidence-other',
        evidenceSchemaVersion: 1
      }
    })

    await expect(
      client.artifactLineage.update({
        where: { id: 'artifact-file' },
        data: { currentVersionId: 'artifact-other-v1' }
      })
    ).rejects.toThrow()
    await expect(
      client.$executeRawUnsafe(`
        INSERT INTO "ArtifactVersion"
          ("id", "artifactId", "versionNumber", "filename", "originKind", "basedOnVersionId",
           "state", "contentStorageKey", "sizeBytes", "checksum", "createdAt", "updatedAt")
        VALUES
          ('artifact-cross-derived', 'artifact-file', 4, 'report.md', 'legacy',
           'artifact-other-v1', 'finalized', 'artifact/cross-derived.md', 11, 'checksum-cross',
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `)
    ).rejects.toThrow()
  })

  it('enforces Upload head and derivation ownership in SQLite', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-versioning-upload-ownership-'))
    client = createProjectDbClient(storageRoot)
    await materializeVersioningBaseline(client)
    await migrateApplicationDatabase(client)
    await client.uploadFile.create({
      data: {
        id: 'upload-other',
        projectId: 'project-versioning',
        sessionId: 'session-versioning',
        filename: 'other.txt',
        originalFilename: 'other.txt'
      }
    })
    await client.uploadVersion.create({
      data: {
        id: 'upload-other-v1',
        uploadFileId: 'upload-other',
        versionNumber: 1,
        state: 'ready',
        contentStorageKey: 'upload/other-v1.txt',
        filename: 'other.txt',
        originalFilename: 'other.txt',
        sizeBytes: 10,
        checksum: 'checksum-other'
      }
    })

    await expect(
      client.uploadFile.update({
        where: { id: 'upload-file' },
        data: { currentVersionId: 'upload-other-v1' }
      })
    ).rejects.toThrow()
    await expect(
      client.uploadVersion.create({
        data: {
          id: 'upload-cross-derived',
          uploadFileId: 'upload-file',
          versionNumber: 3,
          state: 'ready',
          originKind: 'user_edit',
          basedOnVersionId: 'upload-other-v1',
          storageTag: 'vk3m8q2az',
          storedFilename: 'vk3m8q2az_notes.txt',
          contentStorageKey: 'upload/cross-derived.txt',
          filename: 'notes.txt',
          originalFilename: 'notes.txt',
          sizeBytes: 11,
          checksum: 'checksum-cross'
        }
      })
    ).rejects.toThrow()
  })

  it('rejects schema objects outside the generated current target', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-current-drift-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.$executeRawUnsafe('CREATE TABLE "UnversionedDrift" ("id" TEXT PRIMARY KEY)')

    await expect(verifyCurrentRuntimeSchema(client)).rejects.toThrow(/unexpected tables/)
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
      migrationId: '0004_managed_file_version_foundation'
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
      applied: ['0005_test_suffix'],
      from: '0004_managed_file_version_foundation',
      to: '0005_test_suffix'
    })
    await expect(
      client.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "_open_science_migrations" ORDER BY "id"
      `
    ).resolves.toEqual([
      { id: '0001_runtime_schema_baseline' },
      { id: '0002_project_agent_context' },
      { id: '0003_granted_local_roots' },
      { id: '0004_managed_file_version_foundation' },
      { id: '0005_test_suffix' }
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

  it('retains a recovery snapshot before adding Agent Context to a ledger database', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-agent-context-backup-'))
    const databasePath = join(storageRoot, 'open-science.db')
    const backupPath = `${databasePath}.before-0002_project_agent_context.backup`
    const versioningBackupPath = `${databasePath}.before-0004_managed_file_version_foundation.backup`
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
        '0004_managed_file_version_foundation'
      ],
      from: '0001_runtime_schema_baseline',
      to: '0004_managed_file_version_foundation'
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
        migrationId: '0004_managed_file_version_foundation',
        path: versioningBackupPath,
        reused: false
      }
    ])
    await expect(access(backupPath)).resolves.toBeUndefined()
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
      migrationId: '0005_test_suffix'
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
      { id: '0004_managed_file_version_foundation' }
    ])
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
      migrationId: '0005_test_suffix'
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
        '0004_managed_file_version_foundation',
        '0005_test_suffix'
      ],
      to: '0005_test_suffix'
    })
    await expect(
      client.project.findUniqueOrThrow({ where: { id: 'legacy-project' } })
    ).resolves.toMatchObject({ name: 'Preserved' })
  })

  it('blocks a database containing a migration from a newer application', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-newer-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Preserved' } })
    await client.$executeRaw`
      INSERT INTO "_open_science_migrations" ("id", "checksum")
      VALUES (${'0005_future_schema'}, ${'f'.repeat(64)})
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
        '0004_managed_file_version_foundation'
      ]
    })
    await expect(
      client.project.findUniqueOrThrow({ where: { id: 'legacy-project' } })
    ).resolves.toMatchObject({ name: 'Preserved', archivedAt: null })
  })

  it('keeps explicitly retired Review and Finding columns after final verification', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-retired-columns-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'legacy-project', name: 'Preserved' } })
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
        '0004_managed_file_version_foundation'
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
        '0004_managed_file_version_foundation'
      ]
    })
    await expect(
      client.permissionGrant.findUniqueOrThrow({ where: { id: 'legacy-grant' } })
    ).resolves.toMatchObject({
      capabilityKind: 'execution',
      capabilityKey: 'exec:agent/shell',
      projectId: 'legacy-project'
    })
    await expect(verifyCurrentRuntimeSchema(client)).resolves.toBeUndefined()
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

  it('adopts the legacy artifact input identity check with equivalent conjunct order', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-legacy-input-check-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(LEGACY_ARTIFACT_VERSION_INPUT_TABLE_DDL)

    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
      adoptedLegacy: true,
      applied: [
        '0001_runtime_schema_baseline',
        '0002_project_agent_context',
        '0003_granted_local_roots',
        '0004_managed_file_version_foundation'
      ]
    })
    await expect(verifyCurrentRuntimeSchema(client)).resolves.toBeUndefined()
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
        '0004_managed_file_version_foundation'
      ]
    })
    await expect(
      client.permissionGrantSeed.findUniqueOrThrow({ where: { id: 'global-customize-v1' } })
    ).resolves.toEqual({ id: 'global-customize-v1', appliedAt })
    await expect(verifyCurrentRuntimeSchema(client)).resolves.toBeUndefined()
  })

  it('creates a restorable snapshot before adopting a legacy database', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-backup-'))
    const databasePath = join(storageRoot, 'open-science.db')
    const backupPath = `${databasePath}.before-0001_runtime_schema_baseline.backup`
    const agentContextBackupPath = `${databasePath}.before-0002_project_agent_context.backup`
    const grantedRootsBackupPath = `${databasePath}.before-0003_granted_local_roots.backup`
    const versioningBackupPath = `${databasePath}.before-0004_managed_file_version_foundation.backup`
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
        '0004_managed_file_version_foundation'
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
        path: grantedRootsBackupPath,
        reused: false
      },
      {
        migrationId: '0004_managed_file_version_foundation',
        path: versioningBackupPath,
        reused: false
      }
    ])
    await expect(access(agentContextBackupPath)).resolves.toBeUndefined()
    await expect(access(grantedRootsBackupPath)).resolves.toBeUndefined()
    await expect(access(versioningBackupPath)).resolves.toBeUndefined()
    await expect(client.project.count()).resolves.toBe(1)

    const backupClient = new PrismaClient({
      datasources: { db: { url: `file:${backupPath.replaceAll('\\', '/')}` } }
    })
    try {
      await expect(
        backupClient.$queryRaw<Array<{ id: string; name: string }>>`
          SELECT "id", "name" FROM "Project" WHERE "id" = 'legacy-project'
        `
      ).resolves.toEqual([{ id: 'legacy-project', name: 'Preserved' }])
      await expect(
        backupClient.$queryRaw<Array<{ name: string }>>`
          SELECT "name" FROM "sqlite_schema"
          WHERE "type" = 'table' AND "name" = '_open_science_migrations'
        `
      ).resolves.toEqual([])
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
    const grantedRootsBackupPath = `${databasePath}.before-0003_granted_local_roots.backup`
    const versioningBackupPath = `${databasePath}.before-0004_managed_file_version_foundation.backup`
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
        path: grantedRootsBackupPath,
        reused: false
      }),
      expect.objectContaining({
        migrationId: '0004_managed_file_version_foundation',
        path: versioningBackupPath,
        reused: false
      })
    ])
    expect(retired).toEqual([
      { migrationId: '0001_runtime_schema_baseline', path: backupPath },
      { migrationId: '0002_project_agent_context', path: agentContextBackupPath },
      {
        migrationId: '0003_granted_local_roots',
        path: grantedRootsBackupPath
      },
      {
        migrationId: '0004_managed_file_version_foundation',
        path: versioningBackupPath
      }
    ])
    await expect(access(backupPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(agentContextBackupPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(grantedRootsBackupPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(versioningBackupPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      client.$queryRaw<Array<{ id: string; name: string }>>`SELECT "id", "name" FROM "Project"`
    ).resolves.toEqual([{ id: 'legacy-project', name: 'Preserved' }])
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

  it('reports backup retirement failure without blocking a valid database', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-retirement-failure-'))
    const databasePath = join(storageRoot, 'open-science.db')
    const backupPath = `${databasePath}.before-0001_runtime_schema_baseline.backup`
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client, { databasePath })
    await mkdir(backupPath)
    await writeFile(join(backupPath, 'keep'), 'occupied', 'utf8')
    const retiredManifest = MIGRATION_MANIFEST.map((migration) => ({
      ...migration,
      backupOnApply: 'none' as const,
      backupRetention: 'delete-after-success' as const
    }))
    const failures: unknown[] = []

    await expect(
      migrateApplicationDatabaseWithManifest(client, retiredManifest, {
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
