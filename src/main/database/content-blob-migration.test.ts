import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient } from '../projects/prisma-client'
import { MIGRATION_MANIFEST, migrateApplicationDatabase } from './migration-service'

const createDatabaseBeforeLiteratureFoundation = async (client: PrismaClient): Promise<void> => {
  await migrateApplicationDatabase(client)
  await client.$executeRawUnsafe('ALTER TABLE "SessionRun" DROP COLUMN "reportedAtMs"')
  for (const table of [
    'ArtifactLiteratureManifest',
    'ProjectLiterature',
    'LiteratureCollectionItem',
    'LiteratureCollection',
    'LiteratureSourceRecord',
    'LiteratureInboxPdf',
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
     WHERE "id" >= '0030_literature_foundation'`
  )
}

describe('Content blob migration', () => {
  let storageRoot: string | undefined
  let client: PrismaClient | undefined

  afterEach(async () => {
    await client?.$disconnect()
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  })

  it('adopts the current literature suffix without restoring global identifier uniqueness', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-literature-suffix-adoption-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    for (const id of ['first', 'second']) {
      await client.$executeRawUnsafe(
        `INSERT INTO "LiteratureItem" ("id", "itemType", "title", "updatedAt")
         VALUES (?, 'journalArticle', 'Preserved reference', CURRENT_TIMESTAMP)`,
        id
      )
      await client.$executeRawUnsafe(
        `INSERT INTO "LiteratureIdentifier" ("id", "itemId", "scheme", "rawValue", "normalizedValue")
         VALUES (?, ?, 'doi', '10.1234/shared', '10.1234/shared')`,
        id,
        id
      )
    }
    await client.$executeRawUnsafe(
      `DELETE FROM "_open_science_migrations" WHERE "id" >= '0030_literature_foundation'`
    )

    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
      applied: ['0030_literature_foundation', '0031_session_run_coverage']
    })
    await expect(
      client.literatureIdentifier.findMany({ orderBy: { id: 'asc' }, select: { itemId: true } })
    ).resolves.toEqual([{ itemId: 'first' }, { itemId: 'second' }])
    await expect(client.$queryRawUnsafe('PRAGMA foreign_key_check')).resolves.toEqual([])
  })

  it.each(['released', 'current suffix', 'pre-ledger'] as const)(
    'adopts historical upload and artifact bytes from %s without moving their storage keys',
    async (schema) => {
      storageRoot = await mkdtemp(join(tmpdir(), 'open-science-content-blob-0023-'))
      const databasePath = join(storageRoot, 'open-science.db')
      client = createProjectDbClient(storageRoot)
      if (schema === 'released') {
        await createDatabaseBeforeLiteratureFoundation(client)
      } else {
        await migrateApplicationDatabase(client)
        await client.$executeRawUnsafe(
          schema === 'pre-ledger'
            ? 'DELETE FROM "_open_science_migrations"'
            : `DELETE FROM "_open_science_migrations" WHERE "id" >= '0030_literature_foundation'`
        )
      }

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
        applied:
          schema === 'pre-ledger'
            ? MIGRATION_MANIFEST.map(({ id }) => id)
            : ['0030_literature_foundation', '0031_session_run_coverage'],
        from: schema === 'pre-ledger' ? null : '0029_compute_host_execution_mode',
        to: '0031_session_run_coverage'
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

      // Existing app-owned bindings can use IDs other than the migration's deterministic IDs.
      for (const [table, versionId, blobId] of [
        ['UploadVersion', 'upload-version-1', 'upload-version:upload-version-1'],
        ['ArtifactVersion', 'artifact-version-1', 'artifact-version:artifact-version-1']
      ]) {
        await client.$executeRawUnsafe(
          `UPDATE "ContentBlob" SET "id" = 'custom:' || "id" WHERE "id" = ?`,
          blobId
        )
        await client.$executeRawUnsafe(
          `UPDATE "${table}" SET "contentBlobId" = ? WHERE "id" = ?`,
          `custom:${blobId}`,
          versionId
        )
      }
      const readContent = async (): Promise<Record<string, unknown>> => ({
        blobs: await client!.$queryRawUnsafe('SELECT * FROM "ContentBlob" ORDER BY "id"'),
        uploads: await client!.$queryRawUnsafe('SELECT * FROM "UploadVersion" ORDER BY "id"'),
        artifacts: await client!.$queryRawUnsafe('SELECT * FROM "ArtifactVersion" ORDER BY "id"')
      })
      const before = await readContent()
      // The fixture rewinds the ledger after changing data; discard its earlier recovery snapshot.
      await rm(`${databasePath}.before-0030_literature_foundation.backup`, { force: true })
      await client.$executeRawUnsafe(
        `DELETE FROM "_open_science_migrations" WHERE "id" >= '0030_literature_foundation'`
      )
      await migrateApplicationDatabase(client)
      expect(await readContent()).toEqual(before)
      await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
      expect(await readContent()).toEqual(before)
    }
  )
})
