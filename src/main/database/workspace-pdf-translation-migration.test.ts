import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, expect, it } from 'vitest'
import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase } from './migration-service'
import { removeUnreferencedPdfDocument } from '../pdf-documents/identity'

let root: string
let client: PrismaClient
afterEach(async () => {
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})
async function setup(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'workspace-translation-migration-'))
  client = createProjectDbClient(root)
  await migrateApplicationDatabase(client)
  await client.pdfDocument.create({
    data: { id: 'document', checksum: 'a'.repeat(64), sizeBytes: 10n }
  })
}
it('upgrades the prior translation schema without changing its saved records and is idempotent', async () => {
  await setup()
  const before = await client.$queryRawUnsafe(
    'SELECT id, checksum FROM "_open_science_migrations" WHERE id < ? ORDER BY id',
    '0050_literature_translation'
  )
  await client.$executeRawUnsafe('DROP TABLE "PdfTranslationBlock"')
  await client.$executeRawUnsafe(
    'DELETE FROM "_open_science_migrations" WHERE id >= ?',
    '0050_literature_translation'
  )
  expect(await migrateApplicationDatabase(client)).toMatchObject({
    from: '0049_pascalcase_table_names',
    to: '0051_session_research_membership',
    applied: ['0050_literature_translation', '0051_session_research_membership']
  })
  expect(
    await client.$queryRawUnsafe(
      'SELECT id, checksum FROM "_open_science_migrations" WHERE id < ? ORDER BY id',
      '0050_literature_translation'
    )
  ).toEqual(before)
  expect(await client.pdfTranslationBlock.count()).toBe(0)
  expect(await migrateApplicationDatabase(client)).toMatchObject({ applied: [] })
})
it('rejects altered workspace migration checksums without recreating a missing table', async () => {
  await setup()
  await client.$executeRawUnsafe('DROP TABLE "PdfTranslationBlock"')
  await client.$executeRawUnsafe(
    'UPDATE "_open_science_migrations" SET checksum = ? WHERE id = ?',
    'a'.repeat(64),
    '0050_literature_translation'
  )
  await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
    code: 'database_history_invalid'
  })
  expect(
    await client.$queryRawUnsafe(
      'SELECT name FROM sqlite_master WHERE name = ?',
      'PdfTranslationBlock'
    )
  ).toEqual([])
})
it('enforces block values and retains editions until the shared document is removed', async () => {
  await setup()
  await client.project.create({ data: { id: 'project', name: 'Test' } })
  await client.fileOriginSession.create({ data: { projectId: 'project', sessionId: 'session' } })
  await client.uploadFile.create({
    data: {
      id: 'file',
      projectId: 'project',
      sessionId: 'session',
      filename: 'p.pdf',
      originalFilename: 'p.pdf',
      versions: {
        create: {
          id: 'version',
          versionNumber: 1,
          state: 'ready',
          filename: 'p.pdf',
          originalFilename: 'p.pdf',
          contentStorageKey: 'content/pdf',
          checksum: 'a'.repeat(64),
          sizeBytes: 10n
        }
      }
    }
  })
  await client.pdfTranslation.create({
    data: {
      id: 'translation',
      pdfDocumentId: 'document',
      checksum: 'a'.repeat(64),
      sizeBytes: 10n,
      revision: 1,
      payloadJson: '{}'
    }
  })
  for (const invalid of [
    { sourceIndex: -2, revision: 1 },
    { sourceIndex: 0, revision: 0 },
    { sourceIndex: -1, revision: 1, translation: 'unexpected' },
    { sourceIndex: 0, revision: 1, translation: '' }
  ])
    await expect(
      client.pdfTranslationBlock.create({ data: { translationId: 'translation', ...invalid } })
    ).rejects.toThrow()
  await client.pdfTranslationBlock.create({
    data: { translationId: 'translation', sourceIndex: -1, revision: 1 }
  })
  await client.uploadVersion.delete({ where: { id: 'version' } })
  expect(await client.pdfTranslationBlock.count()).toBe(1)
  await removeUnreferencedPdfDocument(client, 'document')
  expect(await client.pdfTranslationBlock.count()).toBe(0)
  expect(await client.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([])
})

it('retains every edition until common document cleanup removes the final managed content reference', async () => {
  await setup()
  await client.project.create({ data: { id: 'project', name: 'Test' } })
  await client.fileOriginSession.create({ data: { projectId: 'project', sessionId: 'session' } })
  await client.uploadFile.create({
    data: {
      id: 'file',
      projectId: 'project',
      sessionId: 'session',
      filename: 'p.pdf',
      originalFilename: 'p.pdf',
      versions: {
        create: {
          id: 'version',
          versionNumber: 1,
          state: 'ready',
          filename: 'p.pdf',
          originalFilename: 'p.pdf',
          contentStorageKey: 'content/pdf',
          checksum: 'a'.repeat(64),
          sizeBytes: 10n
        }
      }
    }
  })
  await client.contentBlob.create({
    data: {
      id: 'blob',
      checksum: 'a'.repeat(64),
      sizeBytes: 10n,
      storageKey: 'content/pdf',
      state: 'available'
    }
  })
  await client.literatureItem.create({
    data: {
      itemType: 'journalArticle',
      title: 'Paper',
      attachments: {
        create: {
          id: 'attachment',
          versions: {
            create: {
              id: 'lit-version',
              contentBlobId: 'blob',
              versionNumber: 1,
              filename: 'p.pdf',
              contentType: 'application/pdf',
              sizeBytes: 10n,
              checksum: 'a'.repeat(64)
            }
          }
        }
      }
    }
  })
  await client.pdfTranslation.create({
    data: {
      id: 'shared',
      pdfDocumentId: 'document',
      checksum: 'a'.repeat(64),
      sizeBytes: 10n,
      revision: 1,
      payloadJson: '{}',
      blocks: { create: { sourceIndex: 0, revision: 1, translation: '保留' } }
    }
  })
  await client.project.delete({ where: { id: 'project' } })
  expect(await client.pdfTranslationBlock.count()).toBe(1)
  expect(await client.pdfTranslation.count()).toBe(1)
  await client.pdfTranslation.create({
    data: {
      id: 'replacement',
      pdfDocumentId: 'document',
      checksum: 'a'.repeat(64),
      sizeBytes: 10n,
      revision: 1,
      payloadJson: '{}'
    }
  })
  expect(await client.pdfTranslation.findUnique({ where: { id: 'shared' } })).not.toBeNull()
  expect(await client.pdfTranslationBlock.count()).toBe(1)
  await client.literatureAttachmentVersion.delete({ where: { id: 'lit-version' } })
  expect(await client.pdfTranslation.count()).toBe(2)
  await removeUnreferencedPdfDocument(client, 'document')
  expect(await client.pdfTranslation.count()).toBe(2)
  await client.contentBlob.delete({ where: { id: 'blob' } })
  await removeUnreferencedPdfDocument(client, 'document')
  expect(await client.pdfTranslation.count()).toBe(0)
  expect(await client.pdfTranslationBlock.count()).toBe(0)
  expect(await client.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([])
})
