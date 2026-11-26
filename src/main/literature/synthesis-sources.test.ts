import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase } from '../database/migration-service'
import { PdfAnnotationRepository } from '../pdf-annotations/repository'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import { LiteratureCatalog } from './catalog'
import { LiteratureSynthesisSources } from './synthesis-sources'
import { LiteratureSynthesisService } from './synthesis'
import { LiteratureSynthesisStore } from './synthesis-store'

describe('literature synthesis source membership', () => {
  let root: string,
    client: PrismaClient,
    sources: LiteratureSynthesisSources,
    annotations: PdfAnnotationRepository
  let itemId: string, versionId: string, otherItemId: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'synthesis-sources-'))
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    const catalog = new LiteratureCatalog(async () => client)
    itemId = (
      await catalog.transact({
        kind: 'create-item',
        item: literatureItemInputSchema.parse({
          itemType: 'journalArticle',
          title: 'One paper',
          creators: [
            { nameMode: 'organization', literalName: 'Research Group', creatorType: 'author' }
          ],
          identifiers: [{ scheme: 'doi', value: '10.1234/evidence', isPrimary: true }]
        })
      })
    ).id!
    otherItemId = (
      await catalog.transact({
        kind: 'create-item',
        item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title: 'Other paper' })
      })
    ).id!
    await client.contentBlob.create({
      data: {
        id: 'blob',
        checksum: 'a'.repeat(64),
        storageKey: 'content/blob',
        sizeBytes: 128n,
        state: 'available'
      }
    })
    const attachment = await catalog.attachContent({
      itemId,
      contentBlobId: 'blob',
      filename: 'paper.pdf',
      contentType: 'application/pdf',
      sizeBytes: 128,
      checksum: 'a'.repeat(64)
    })
    versionId = attachment.versionId
    annotations = new PdfAnnotationRepository(async () => client)
    await client.tag.create({
      data: {
        id: 'tag',
        name: 'Evidence',
        nameKey: 'evidence',
        iconKey: 'tag',
        colorKey: 'blue',
        sortOrder: 1
      }
    })
    for (let index = 0; index < 3; index++)
      await annotations.create({
        id: `annotation-${index}`,
        createdAt: '2025-01-01T00:00:00.000Z',
        literatureVersionId: versionId,
        kind: 'document-note',
        note: `Note ${index}`,
        tagIds: index === 1 ? ['tag'] : [],
        target: {
          source: {
            kind: 'literature-attachment-version',
            sourceFileId: attachment.attachmentId,
            versionId,
            checksum: 'a'.repeat(64),
            name: 'paper.pdf',
            path: `literature-attachment-version:${versionId}`
          },
          selector: { kind: 'document-note', coordinateVersion: 1 }
        }
      })
    sources = new LiteratureSynthesisSources(async () => client, annotations, catalog)
  })
  afterAll(async () => {
    await client?.$disconnect()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('paginates existing annotations and reads bibliography plus existing tags', async () => {
    const first = await sources.candidates([itemId], undefined, undefined, 2)
    expect(first.candidates.map((candidate) => candidate.annotationId)).toEqual([
      'annotation-0',
      'annotation-1'
    ])
    expect(first.nextCursor).toEqual({
      createdAt: '2025-01-01T00:00:00.000Z',
      id: 'annotation-1'
    })
    const second = await sources.candidates([itemId], undefined, first.nextCursor, 2)
    expect(second.candidates.map((candidate) => candidate.annotationId)).toEqual(['annotation-2'])
    expect(second.nextCursor).toBeUndefined()
    const tagged = await sources.candidates([itemId], 'tag')
    expect(tagged.candidates).toHaveLength(1)
    expect(tagged.candidates[0]).toMatchObject({
      annotationId: 'annotation-1',
      bibliography: { title: 'One paper', authors: 'Research Group', doi: '10.1234/evidence' },
      tags: [{ id: 'tag', name: 'Evidence' }]
    })
  })

  it('continues tied timestamps after earlier rows and the cursor annotation are deleted', async () => {
    const original = (await sources.resolve({ itemId, versionId, annotationId: 'annotation-0' }))!
    await client.tag.create({
      data: {
        id: 'cursor-tag',
        name: 'Cursor pagination',
        nameKey: 'cursor-pagination',
        iconKey: 'tag',
        colorKey: 'blue',
        sortOrder: 2
      }
    })
    for (const id of ['cursor-a', 'cursor-b', 'cursor-c', 'cursor-d'])
      await annotations.create({
        id,
        createdAt: '2025-02-01T00:00:00.000Z',
        literatureVersionId: versionId,
        kind: 'document-note' as const,
        note: id,
        tagIds: ['cursor-tag'],
        target: original.annotation.target
      })
    const service = new LiteratureSynthesisService(
      new LiteratureSynthesisStore(() => join(root, 'cursor-synthesis.json')),
      sources
    )
    const first = await service.run({
      action: 'candidates',
      itemIds: [itemId],
      tagId: 'cursor-tag',
      limit: 2
    })
    if (first.action !== 'candidates') throw new Error('Unexpected result')
    expect(first.candidates.map((candidate) => candidate.annotationId)).toEqual([
      'cursor-a',
      'cursor-b'
    ])
    expect(first.nextCursor).toEqual({
      createdAt: '2025-02-01T00:00:00.000Z',
      id: 'cursor-b'
    })
    await annotations.delete({ id: 'cursor-a', literatureVersionId: versionId })
    await annotations.delete({ id: 'cursor-b', literatureVersionId: versionId })
    const second = await service.run({
      action: 'candidates',
      itemIds: [itemId],
      tagId: 'cursor-tag',
      cursor: first.nextCursor,
      limit: 2
    })
    if (second.action !== 'candidates') throw new Error('Unexpected result')
    expect(second.candidates.map((candidate) => candidate.annotationId)).toEqual([
      'cursor-c',
      'cursor-d'
    ])
    expect(second.nextCursor).toBeUndefined()
    await annotations.delete({ id: 'cursor-c', literatureVersionId: versionId })
    await annotations.delete({ id: 'cursor-d', literatureVersionId: versionId })
  })

  it('rejects mismatched item/version identity and unselected sources', async () => {
    expect(
      await sources.resolve({ itemId: otherItemId, versionId, annotationId: 'annotation-0' })
    ).toBeUndefined()
    expect(await sources.candidates([otherItemId])).toEqual({ candidates: [] })
    expect(
      await sources.resolve({ itemId, versionId: 'missing', annotationId: 'annotation-0' })
    ).toBeUndefined()
  })

  it('preserves a large collaboration author list within the existing byte budgets', async () => {
    const catalog = new LiteratureCatalog(async () => client)
    const creators = Array.from({ length: 1000 }, (_, index) => ({
      nameMode: 'organization' as const,
      literalName: `Collaboration Author ${index}`,
      creatorType: 'author' as const
    }))
    const paper = await catalog.transact({
      kind: 'create-item',
      item: literatureItemInputSchema.parse({
        itemType: 'journalArticle',
        title: 'Collaboration',
        creators
      })
    })
    await client.contentBlob.create({
      data: {
        id: 'collaboration-blob',
        checksum: 'b'.repeat(64),
        storageKey: 'collaboration.pdf',
        sizeBytes: 128n,
        state: 'available'
      }
    })
    const attachment = await catalog.attachContent({
      itemId: paper.id!,
      contentBlobId: 'collaboration-blob',
      filename: 'collaboration.pdf',
      contentType: 'application/pdf',
      sizeBytes: 128,
      checksum: 'b'.repeat(64)
    })
    const annotation = await annotations.create({
      id: 'collaboration-annotation',
      literatureVersionId: attachment.versionId,
      kind: 'document-note',
      note: 'Collaboration evidence',
      tagIds: [],
      target: {
        source: {
          kind: 'literature-attachment-version',
          sourceFileId: attachment.attachmentId,
          versionId: attachment.versionId,
          checksum: 'b'.repeat(64),
          name: 'collaboration.pdf',
          path: `literature-attachment-version:${attachment.versionId}`
        },
        selector: { kind: 'document-note', coordinateVersion: 1 }
      }
    })
    const page = await sources.candidates([paper.id!])
    expect(page.candidates).toHaveLength(1)
    const authors = creators.map((creator) => creator.literalName).join(', ')
    expect(authors.length).toBeGreaterThan(20000)
    expect(page.candidates[0].bibliography.authors).toBe(authors)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1024 * 1024)
    const service = new LiteratureSynthesisService(
      new LiteratureSynthesisStore(() => join(root, 'collaboration-synthesis.json')),
      sources
    )
    const created = await service.run({
      action: 'create',
      title: 'Collaboration synthesis',
      itemIds: [paper.id!],
      excerpts: [
        {
          itemId: paper.id!,
          versionId: attachment.versionId,
          annotationId: annotation.id,
          expectedUpdatedAt: annotation.updatedAt
        }
      ]
    })
    if (created.action !== 'create') throw new Error('Unexpected result')
    const exported = await service.run({
      action: 'export',
      noteId: created.note.id,
      expectedRevision: created.note.revision
    })
    expect(exported.action === 'export' && exported.markdown).toContain(authors)
  })

  it('checks candidate revision preconditions without storing them in the source snapshot', async () => {
    const original = (await sources.resolve({ itemId, versionId, annotationId: 'annotation-0' }))!
    const selected = {
      itemId,
      versionId,
      annotationId: 'annotation-0',
      expectedUpdatedAt: original.annotation.updatedAt
    }
    const snapshot = await sources.resolve(selected)
    expect(snapshot).not.toHaveProperty('expectedUpdatedAt')
    await annotations.update({
      id: 'annotation-0',
      literatureVersionId: versionId,
      note: 'A later source edit',
      expectedUpdatedAt: original.annotation.updatedAt
    })
    expect(await sources.resolve(selected)).toBeUndefined()
    expect(
      await sources.resolve({ itemId, versionId, annotationId: 'annotation-0' })
    ).toMatchObject({ annotation: { note: 'A later source edit' } })
  })

  it('rejects an oversized first candidate instead of returning a nonadvancing cursor', async () => {
    const original = (await sources.resolve({ itemId, versionId, annotationId: 'annotation-0' }))!
    const oversized = structuredClone(original)
    oversized.annotation.note = 'x'.repeat(1024 * 1024)
    const resolve = vi.spyOn(sources, 'resolve').mockResolvedValueOnce(oversized)
    try {
      await expect(sources.candidates([itemId], undefined, undefined, 1)).rejects.toThrow(
        'size limit'
      )
    } finally {
      resolve.mockRestore()
    }
  })

  it('accepts a near-limit candidate with a short cursor without lowering the single-candidate cap', async () => {
    const original = (await sources.resolve({ itemId, versionId, annotationId: 'annotation-0' }))!
    const large = structuredClone(original)
    large.bibliography.authors = ''
    large.bibliography.authors = 'x'.repeat(
      1024 * 1024 - 2048 - Buffer.byteLength(JSON.stringify(large))
    )
    const resolve = vi.spyOn(sources, 'resolve').mockResolvedValueOnce(large)
    try {
      const page = await sources.candidates([itemId], undefined, undefined, 1)
      expect(page.candidates).toEqual([large])
      expect(page.nextCursor).toEqual({
        createdAt: '2025-01-01T00:00:00.000Z',
        id: 'annotation-0'
      })
      expect(Buffer.byteLength(JSON.stringify({ action: 'candidates', ...page }))).toBeLessThan(
        1024 * 1024
      )
    } finally {
      resolve.mockRestore()
    }
  })

  it('budgets an escaped stale-row cursor before advancing past it', async () => {
    const original = (await sources.resolve({ itemId, versionId, annotationId: 'annotation-0' }))!
    const row = await client.pdfAnnotation.findUniqueOrThrow({ where: { id: 'annotation-0' } })
    const large = structuredClone(original)
    large.bibliography.authors = ''
    large.bibliography.authors = 'x'.repeat(
      1024 * 1024 - 2048 - Buffer.byteLength(JSON.stringify(large))
    )
    const resolve = vi.spyOn(sources, 'resolve').mockResolvedValueOnce(large)
    const query = vi.spyOn(client, '$queryRaw').mockResolvedValue([
      { id: row.id, documentId: row.documentId, createdAt: row.createdAt },
      {
        id: '\u0000'.repeat(1024),
        documentId: 'stale',
        createdAt: new Date('2025-01-02T00:00:00.000Z')
      },
      { id: 'later', documentId: 'stale', createdAt: new Date('2025-01-03T00:00:00.000Z') }
    ] as never)
    try {
      const page = await sources.candidates([itemId])
      expect(page.candidates).toEqual([large])
      expect(page.nextCursor).toEqual({ createdAt: row.createdAt.toISOString(), id: row.id })
      expect(Buffer.byteLength(JSON.stringify({ action: 'candidates', ...page }))).toBeLessThan(
        1024 * 1024
      )
    } finally {
      resolve.mockRestore()
      query.mockRestore()
    }
  })

  it('bounds candidate response bytes without dropping the continuation', async () => {
    const original = (await sources.resolve({ itemId, versionId, annotationId: 'annotation-0' }))!
    await annotations.createMany(
      Array.from({ length: 60 }, (_, index) => ({
        id: `budget-${index}`,
        createdAt: '2025-03-01T00:00:00.000Z',
        literatureVersionId: versionId,
        kind: 'document-note' as const,
        note: 'x'.repeat(20000),
        tagIds: [],
        target: original.annotation.target
      }))
    )
    const first = await sources.candidates([itemId], undefined, undefined, 100)
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(1024 * 1024)
    expect(first.candidates.length).toBeGreaterThan(3)
    expect(first.candidates.length).toBeLessThan(63)
    const boundary = first.candidates.at(-1)!
    expect(first.nextCursor).toEqual({
      createdAt: boundary.annotation.createdAt,
      id: boundary.annotationId
    })
    const earlier = first.candidates.find((candidate) =>
      candidate.annotationId.startsWith('budget-')
    )!
    await annotations.delete({ id: earlier.annotationId, literatureVersionId: versionId })
    await annotations.delete({ id: boundary.annotationId, literatureVersionId: versionId })
    const second = await sources.candidates([itemId], undefined, first.nextCursor, 100)
    expect(second.nextCursor).toBeUndefined()
    expect(
      new Set(
        [...first.candidates, ...second.candidates].map((candidate) => candidate.annotationId)
      ).size
    ).toBe(63)
    expect(
      second.candidates.some((candidate) => candidate.annotationId === boundary.annotationId)
    ).toBe(false)
  })

  it('skips a candidate whose binding disappeared during pagination', async () => {
    const query = vi.spyOn(client, '$queryRaw').mockResolvedValue([
      {
        id: 'stale-annotation',
        documentId: 'deleted-document',
        createdAt: new Date('2025-01-01T00:00:00.000Z')
      },
      {
        id: 'later-annotation',
        documentId: 'deleted-document',
        createdAt: new Date('2025-01-02T00:00:00.000Z')
      }
    ] as never)
    try {
      await expect(sources.candidates([itemId], undefined, undefined, 1)).resolves.toEqual({
        candidates: [],
        nextCursor: { createdAt: '2025-01-01T00:00:00.000Z', id: 'stale-annotation' }
      })
    } finally {
      query.mockRestore()
    }
  })

  it('reports deleted source annotations and deleted papers as unavailable', async () => {
    await annotations.delete({ id: 'annotation-2', literatureVersionId: versionId })
    expect(
      await sources.resolve({ itemId, versionId, annotationId: 'annotation-2' })
    ).toBeUndefined()
    await client.literatureItem.update({ where: { id: itemId }, data: { deletedAt: new Date() } })
    expect(
      await sources.resolve({ itemId, versionId, annotationId: 'annotation-0' })
    ).toBeUndefined()
    expect(await sources.candidates([itemId])).toEqual({ candidates: [] })
  })
})
