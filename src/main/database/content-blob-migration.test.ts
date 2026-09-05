import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase } from './migration-service'

const createDatabaseBeforeLiteratureFoundation = async (client: PrismaClient): Promise<void> => {
  await migrateApplicationDatabase(client)
  for (const table of [
    'ArtifactLiteratureManifest',
    'ProjectLiterature',
    'LiteratureCollectionItem',
    'LiteratureCollection',
    'LiteratureSourceRecord',
    'LiteratureInboxCandidate',
    'LiteratureIdentifier',
    'LiteratureItemCreator',
    'LiteratureCreator',
    'LiteratureAttachmentVersion',
    'LiteratureAttachment',
    'LiteratureItem'
  ]) {
    await client.$executeRawUnsafe(`DROP TABLE "${table}"`)
  }
  await client.$executeRawUnsafe('DROP INDEX "UploadVersion_contentBlobId_idx"')
  await client.$executeRawUnsafe('DROP INDEX "ArtifactVersion_contentBlobId_idx"')
  await client.$executeRawUnsafe('ALTER TABLE "UploadVersion" DROP COLUMN "contentBlobId"')
  await client.$executeRawUnsafe('ALTER TABLE "ArtifactVersion" DROP COLUMN "contentBlobId"')
  await client.$executeRawUnsafe('DROP TABLE "ContentBlob"')
  await client.$executeRawUnsafe(
    `DELETE FROM "_open_science_migrations"
     WHERE "id" IN ('0029_literature_foundation', '0030_literature_explicit_duplicates')`
  )
}

describe('Content blob migration', () => {
  let storageRoot: string | undefined
  let client: PrismaClient | undefined

  afterEach(async () => {
    await client?.$disconnect()
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  })

  it('adopts historical upload and artifact bytes without moving their storage keys', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-content-blob-0023-'))
    const databasePath = join(storageRoot, 'open-science.db')
    client = createProjectDbClient(storageRoot)
    await createDatabaseBeforeLiteratureFoundation(client)

    await client.$executeRawUnsafe(
      `INSERT INTO "FileOriginSession" ("projectId", "sessionId", "createdAt", "updatedAt")
       VALUES ('project-1', 'session-1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "UploadFile" (
         "id", "projectId", "sessionId", "filename", "originalFilename", "createdAt", "updatedAt"
       ) VALUES (
         'upload-1', 'project-1', 'session-1', 'paper.pdf', 'paper.pdf',
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       )`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "UploadVersion" (
         "id", "uploadFileId", "versionNumber", "state", "contentStorageKey", "filename",
         "originalFilename", "contentType", "sizeBytes", "checksum", "registeredAt", "updatedAt"
       ) VALUES (
         'upload-version-1', 'upload-1', 1, 'ready', 'uploads/paper/content', 'paper.pdf',
         'paper.pdf', 'application/pdf', 42, 'upload-checksum', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       )`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ArtifactLineage" (
         "id", "projectId", "sessionId", "normalizedFilename", "filename", "createdAt", "updatedAt"
       ) VALUES (
         'artifact-1', 'project-1', 'session-1', 'report.md', 'report.md',
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       )`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ArtifactVersion" (
         "id", "artifactId", "versionNumber", "filename", "artifactRunId", "rootFrameId",
         "agentFrameId", "messageBranchId", "runtimeSegmentId", "promptMessageId", "state",
         "contentStorageKey", "evidenceStorageKey", "contentType", "sizeBytes", "checksum",
         "evidenceJson", "evidenceChecksum", "evidenceSchemaVersion", "createdAt", "updatedAt"
       ) VALUES (
         'artifact-version-1', 'artifact-1', 1, 'report.md', 'run-1', 'root-1', 'agent-1',
         'branch-1', 'segment-1', 'prompt-1', 'pending', 'artifacts/report/content',
         'artifacts/report/evidence.json', 'text/markdown', 84, 'artifact-checksum', '{}',
         'evidence-checksum', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       )`
    )

    await expect(migrateApplicationDatabase(client, { databasePath })).resolves.toMatchObject({
      applied: ['0029_literature_foundation', '0030_literature_explicit_duplicates'],
      from: '0028_database_numeric_and_null_constraints',
      to: '0030_literature_explicit_duplicates'
    })

    await expect(
      client.$queryRaw<
        Array<{
          id: string
          storageKey: string
          checksum: string
          sizeBytes: bigint
          contentType: string | null
          state: string
          verifiedAt: Date | null
        }>
      >`SELECT "id", "storageKey", "checksum", "sizeBytes", "contentType", "state", "verifiedAt"
        FROM "ContentBlob" ORDER BY "id"`
    ).resolves.toEqual([
      {
        id: 'artifact-version:artifact-version-1',
        storageKey: 'artifacts/report/content',
        checksum: 'artifact-checksum',
        sizeBytes: 84n,
        contentType: 'text/markdown',
        state: 'available',
        verifiedAt: expect.any(Date)
      },
      {
        id: 'upload-version:upload-version-1',
        storageKey: 'uploads/paper/content',
        checksum: 'upload-checksum',
        sizeBytes: 42n,
        contentType: 'application/pdf',
        state: 'available',
        verifiedAt: expect.any(Date)
      }
    ])
    await expect(
      client.$queryRaw<Array<{ id: string; contentBlobId: string }>>`
        SELECT "id", "contentBlobId" FROM "UploadVersion" WHERE "id" = 'upload-version-1'`
    ).resolves.toEqual([
      { id: 'upload-version-1', contentBlobId: 'upload-version:upload-version-1' }
    ])
    await expect(
      client.$queryRaw<Array<{ id: string; contentBlobId: string }>>`
        SELECT "id", "contentBlobId" FROM "ArtifactVersion" WHERE "id" = 'artifact-version-1'`
    ).resolves.toEqual([
      { id: 'artifact-version-1', contentBlobId: 'artifact-version:artifact-version-1' }
    ])
  })
})
