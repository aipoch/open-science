import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Prisma, type PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProjectRepository } from './repository'
import {
  createProjectDbClient,
  disconnectProjectDbClient,
  ensureProjectSchema,
  getProjectDbClient
} from './prisma-client'
import { ReviewRepository } from '../reviewer/repository'

// Proves the runtime CREATE TABLE IF NOT EXISTS DDL is byte-compatible with the generated Prisma client
// against a real (temp) SQLite database. Requires the query engine, which is present in dev installs.

let storageRoot: string | undefined
let disconnect: (() => Promise<void>) | undefined

afterEach(async () => {
  await disconnect?.()
  disconnect = undefined

  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('project prisma client (integration)', () => {
  it('covers every Prisma scalar field in the runtime SQLite schema', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-project-schema-parity-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await ensureProjectSchema(client)

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

  it('rejects unsupported File Origin lifecycle states in a fresh database', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-origin-state-constraint-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await ensureProjectSchema(client)
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

    await ensureProjectSchema(client)

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

    await expect(ensureProjectSchema(client)).rejects.toThrow(
      'FileOriginSession.state contains unsupported value "corrupt"'
    )
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

    await expect(ensureProjectSchema(client)).rejects.toThrow(/futureMarker/)
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

    await ensureProjectSchema(client)
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
        evidenceChecksum: 'd'.repeat(64)
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

    await ensureProjectSchema(client)
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

    await ensureProjectSchema(client)
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

    await expect(ensureProjectSchema(client)).rejects.toBe(migrationFailure)
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

  it('round-trips artifact lineage versions and enforces their session-scoped ordering keys', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-provenance-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await ensureProjectSchema(client)

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
        evidenceChecksum: 'c'.repeat(64)
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

    await expect(ensureProjectSchema(client)).resolves.toBeUndefined()
  })

  it('ensures the schema (no seed) and round-trips CRUD', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-projects-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await ensureProjectSchema(client)

    const repository = new ProjectRepository(() => Promise.resolve(client))

    // A fresh install starts with no projects; the user creates the first one.
    expect(await repository.list()).toEqual([])

    // Ensuring again is idempotent (table already exists, still no seed).
    await ensureProjectSchema(client)
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

    const renamed = await repository.update({ id: created.id, name: 'Renamed' })
    expect(renamed.name).toBe('Renamed')

    // Any project is deletable — there is no protected default.
    await repository.delete(created.id)
    expect(await repository.get(created.id)).toBeNull()
    expect(await repository.list()).toEqual([])
  })

  // Verifies the runtime FINDING_TABLE_DDL + migration guard are byte-compatible with the Prisma
  // generated client for the reflagCount column (issue 15).
  it('Finding.reflagCount DDL column is Prisma-compatible and migration guard is idempotent', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-reflag-parity-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    // Fresh install: FINDING_TABLE_DDL already contains reflagCount; client can read/write it.
    await ensureProjectSchema(client)

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

    // Migration guard is idempotent — calling ensureProjectSchema a second time must not throw.
    await expect(ensureProjectSchema(client)).resolves.toBeUndefined()
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

    // Run ensureProjectSchema — the migration guard must add reflagCount without error.
    await expect(ensureProjectSchema(client)).resolves.toBeUndefined()

    // Running it again is idempotent (guard catches duplicate-column error).
    await expect(ensureProjectSchema(client)).resolves.toBeUndefined()

    // The old row reads back with reflagCount = 0 (the column default).
    const reviewRepo = new ReviewRepository(() => Promise.resolve(client))
    const [stored] = await reviewRepo.getReviewsForSession('s1')
    expect(stored.checks[0]!.reflagCount).toBe(0)
  })
})
