import { mkdtemp, rm, writeFile, truncate, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  literatureCatalogCommandSchema,
  literatureItemInputSchema,
  type LiteraturePdfImportRequest
} from '../../shared/literature'
import { createTestPdf as pdf } from '../../../test/fixtures/literature-pdf'
import { PENDING_UPLOAD_SESSION_ID } from '../../shared/uploads'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ContentRepository } from '../storage/content-repository'
import { inspectPdfPageCount } from '../uploads/attachment-media'
import { LiteratureAttachmentAuthority } from './attachment-authority'
import { LiteratureCatalog } from './catalog'
import { LiteraturePdfImporter } from './pdf-importer'

describe('Literature PDF attachment reliability', () => {
  let root: string
  let client: PrismaClient | undefined
  afterEach(async () => {
    await client?.$disconnect()
    if (root) await rm(root, { recursive: true, force: true })
  })
  const setup = async (
    bytes = pdf()
  ): Promise<{
    catalog: LiteratureCatalog
    content: ContentRepository
    importer: LiteraturePdfImporter
    request: LiteraturePdfImportRequest
    path: string
    authority: LiteratureAttachmentAuthority
  }> => {
    root = await mkdtemp(join(tmpdir(), 'literature-pdf-reliability-'))
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    const content = new ContentRepository({ storageRoot: root, getClient: async () => client! })
    const catalog = new LiteratureCatalog(async () => client!, undefined, content)
    const item = await catalog.transact({
      kind: 'create-item',
      item: literatureItemInputSchema.parse({ title: 'Paper', itemType: 'journalArticle' })
    })
    const path = join(root, 'selected.pdf')
    await writeFile(path, bytes)
    const importer = new LiteraturePdfImporter({
      catalog,
      content,
      uploads: { resolveManagedUploadPath: async () => path, deleteUpload: async () => undefined }
    })
    const request = {
      itemId: item.id,
      attachment: {
        id: 'upload',
        sessionId: PENDING_UPLOAD_SESSION_ID,
        name: 'paper.pdf',
        originalName: 'paper.pdf',
        path,
        mimeType: 'application/pdf',
        size: bytes.length
      }
    }
    return {
      catalog,
      content,
      importer,
      request,
      path,
      authority: new LiteratureAttachmentAuthority({ getClient: async () => client!, content })
    }
  }

  it('rejects a header-only corrupt PDF before creating an attachment', async () => {
    const { importer, request, path } = await setup(Buffer.from('%PDF-1.7\nnot a document'))
    await expect(inspectPdfPageCount(path)).rejects.toThrow()
    await expect(importer.import(request)).rejects.toThrow()
    expect(await client!.literatureAttachment.count()).toBe(0)
  })

  it('records the page count of a successfully parsed local PDF', async () => {
    const { importer, request, path } = await setup()
    expect(await inspectPdfPageCount(path)).toBe(1)
    const result = await importer.import(request)
    expect(result.item.attachments[0].versions[0].pageCount).toBe(1)
  })

  it.each(['missing', 'corrupt'] as const)(
    'makes a confirmed %s file observable in the attachment view',
    async (failure) => {
      const { importer, request, path, content, catalog, authority } = await setup()
      expect(await inspectPdfPageCount(path)).toBe(1)
      const imported = await importer.import(request)
      const version = imported.item.attachments[0].versions[0]
      const resolved = await authority.resolveVersion(version.id)
      expect(resolved).toBeDefined()
      if (failure === 'missing') await rm(resolved!.path)
      else await writeFile(resolved!.path, 'broken')
      const row = await client!.literatureAttachmentVersion.findUniqueOrThrow({
        where: { id: version.id }
      })
      expect(await content.verify(row.contentBlobId)).toMatchObject({ state: 'unavailable' })
      await expect(authority.resolveVersion(version.id)).rejects.toThrow('unavailable')
      const after = await catalog.get(request.itemId)
      expect(after!.attachments[0].versions[0]).toMatchObject({
        availability: 'unavailable',
        verificationFailure: failure === 'missing' ? 'missing' : 'size-mismatch',
        verificationAttemptAt: expect.any(Number)
      })
      await client!.$disconnect()
      client = createProjectDbClient(root)
      expect((await catalog.get(request.itemId))!.attachments[0].versions[0]).toMatchObject({
        availability: 'unavailable'
      })
      const withPdf = await catalog.search({ scope: 'library', filter: { hasFullText: true } })
      expect(withPdf.entries.flatMap((entry) => ('id' in entry ? [entry.id] : []))).toContain(
        request.itemId
      )
      expect(
        (await catalog.search({ scope: 'library', filter: { hasFullText: false } })).entries
      ).toHaveLength(0)
      const verify = vi.spyOn(content, 'verify')
      await catalog.get(request.itemId)
      await catalog.search({ scope: 'library' })
      expect(verify).not.toHaveBeenCalled()
      await writeFile(resolved!.path, pdf())
      await catalog.transact({
        kind: 'verify-attachment',
        itemId: request.itemId,
        versionId: version.id
      })
      expect((await catalog.get(request.itemId))!.attachments[0].versions[0]).toMatchObject({
        availability: 'available',
        verificationFailure: undefined
      })
      await expect(authority.resolveVersion(version.id)).resolves.toBeDefined()
    }
  )

  it('keeps different same-named PDFs as independent attachments without an explicit version target', async () => {
    const { importer, request, path } = await setup()
    expect(await inspectPdfPageCount(path)).toBe(1)
    await importer.import(request)
    await writeFile(path, pdf('second'))
    expect(await inspectPdfPageCount(path)).toBe(1)
    const result = await importer.import(request)
    expect(
      result.item.attachments.map((entry) => entry.versions.map((version) => version.versionNumber))
    ).toEqual([[1], [1]])
  })

  it('retains a PDF above the automatic processing limit without claiming a page count', async () => {
    const { importer, request, path } = await setup()
    await truncate(path, 50 * 1024 * 1024 + 1)
    const imported = await importer.import(request)
    expect(imported.item.attachments[0].versions[0]).toMatchObject({
      sizeBytes: 50 * 1024 * 1024 + 1,
      pageCount: undefined
    })
  })

  it('rejects an attachment removal with the wrong item owner', async () => {
    const { importer, request, catalog } = await setup()
    const imported = await importer.import(request)
    await expect(
      catalog.transact({
        kind: 'delete-attachment',
        itemId: 'different-item',
        attachmentId: imported.item.attachments[0].id
      })
    ).rejects.toThrow('unavailable')
    expect((await catalog.get(request.itemId))!.attachments).toHaveLength(1)
  })

  it('retains shared bytes when another reference still owns the same PDF', async () => {
    const { importer, request, catalog, authority } = await setup()
    const first = await importer.import(request)
    const other = await catalog.transact({
      kind: 'create-item',
      item: literatureItemInputSchema.parse({ title: 'Other', itemType: 'journalArticle' })
    })
    const second = await importer.import({ ...request, itemId: other.id })
    await catalog.transact({
      kind: 'delete-attachment',
      itemId: request.itemId,
      attachmentId: first.item.attachments[0].id
    })
    await expect(
      authority.resolveVersion(second.item.attachments[0].versions[0].id)
    ).resolves.toBeDefined()
    expect(await client!.contentBlob.count()).toBe(1)
  })

  it('reports incomplete cleanup without undoing the committed attachment removal', async () => {
    const { importer, request, catalog, content } = await setup()
    const first = await importer.import(request)
    vi.spyOn(content, 'sweep').mockRejectedValueOnce(new Error('disk failure'))
    await expect(
      catalog.transact({
        kind: 'delete-attachment',
        itemId: request.itemId,
        attachmentId: first.item.attachments[0].id
      })
    ).resolves.toMatchObject({ cleanupPending: true, state: 'unlinked' })
    expect((await catalog.get(request.itemId))!.attachments).toHaveLength(0)
    expect(await client!.contentBlob.count()).toBe(1)
  })

  it('removes only the selected attachment through the public catalog command', async () => {
    const { importer, request, path, catalog, authority } = await setup()
    await client!.project.create({ data: { id: 'project', name: 'Research' } })
    await catalog.transact({
      kind: 'set-project-item',
      projectId: 'project',
      itemId: request.itemId,
      included: true,
      source: 'user'
    })
    const collection = await catalog.transact({
      kind: 'create-collection',
      name: 'Reading',
      description: ''
    })
    await catalog.transact({
      kind: 'set-collection-item',
      collectionId: collection.id,
      itemId: request.itemId,
      included: true
    })
    const first = await importer.import(request)
    const attachmentId = first.item.attachments[0].id
    const original = await authority.resolveVersion(first.item.attachments[0].versions[0].id)
    await writeFile(path, pdf('second'))
    const before = (await importer.import(request)).item
    const command = literatureCatalogCommandSchema.parse({
      kind: 'delete-attachment',
      itemId: request.itemId,
      attachmentId
    })
    await catalog.transact(command)
    const after = await catalog.get(request.itemId)
    expect(after!.item).toEqual(before.item)
    expect(after!.projectIds).toEqual(before.projectIds)
    expect(after!.collectionIds).toEqual(before.collectionIds)
    expect(after!.attachments.map((entry) => entry.id)).toEqual(
      before.attachments.filter((entry) => entry.id !== attachmentId).map((entry) => entry.id)
    )
    expect(await client!.literatureAttachmentVersion.count({ where: { attachmentId } })).toBe(0)
    await expect(access(original!.path)).rejects.toThrow()
  })
})
