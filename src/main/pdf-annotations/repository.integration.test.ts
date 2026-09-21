import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateApplicationDatabase } from '../database/migration-service'
import { createProjectDbClient } from '../projects/prisma-client'
import { literatureItemInputSchema } from '../../shared/literature'
import { ProjectRepository } from '../projects/repository'
import { TagRepository } from '../tags/repository'
import { LiteratureCatalog } from '../literature/catalog'
import type { ContentRepository } from '../storage/content-repository'
import { PdfAnnotationRepository } from './repository'
import type { CreatePdfAnnotationRequest } from '../../shared/pdf-annotations'

const scope = { projectId: 'project-1', sessionId: 'session-1' }
const request: CreatePdfAnnotationRequest = {
  ...scope,
  id: 'annotation-1',
  kind: 'highlight',
  color: 'yellow',
  tagIds: ['review'],
  note: 'A private comment',
  target: {
    source: {
      kind: 'upload-version',
      projectId: scope.projectId,
      sessionId: 'source-session',
      sourceFileId: 'file-1',
      versionId: 'version-1',
      checksum: 'a'.repeat(64),
      name: 'paper.pdf',
      path: 'upload-version:version-1'
    },
    selector: {
      kind: 'text',
      pageNumber: 1,
      pageRotation: 0,
      coordinateVersion: 1,
      extractorVersion: 'pdfjs-test',
      exact: 'A passage',
      position: { start: 0, end: 9 },
      quads: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.02 }]
    }
  }
}

describe('PdfAnnotation persistence', () => {
  let root: string
  let client: PrismaClient
  let repository: PdfAnnotationRepository
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pdf-annotations-'))
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: scope.projectId, name: 'Research' } })
    await client.tag.createMany({
      data: ['review', 'method'].map((id, index) => ({
        id,
        name: id,
        nameKey: id,
        iconKey: 'tag',
        colorKey: 'blue',
        sortOrder: index + 1
      }))
    })
    repository = new PdfAnnotationRepository(async () => client)
  })
  afterEach(async () => {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  })

  it('preserves creation provenance when a different Session restores or retries a shared note', async () => {
    const original = await repository.create(request)
    await repository.delete({ ...scope, sessionId: 'session-2', id: original.id })
    const restore = {
      ...request,
      sessionId: 'session-2',
      createdInSessionId: 'session-1',
      createdAt: original.createdAt
    }
    expect((await repository.create(restore)).sessionId).toBe('session-1')
    expect((await repository.recoverCreate(restore))?.sessionId).toBe('session-1')
    await repository.delete({ projectId: scope.projectId, id: original.id })
    expect(
      (await repository.create({ ...restore, createdInSessionId: null })).sessionId
    ).toBeUndefined()
  })

  it('atomically retains native import receipts after deletion and across restart without resurrecting marks', async () => {
    const native = {
      ...request,
      tagIds: [],
      origin: 'imported' as const,
      externalSubtype: 'Highlight'
    }
    const receipt = {
      scope,
      source: request.target.source,
      result: {
        nativeRefs: [{ pageNumber: 1, id: '12R' }],
        pageCount: 1,
        unsupportedCount: 2,
        truncated: false
      }
    }
    expect(await repository.createMany([native], receipt)).toBe(1)
    await repository.delete({ ...scope, id: native.id })
    await client.$disconnect()
    client = createProjectDbClient(root)
    repository = new PdfAnnotationRepository(async () => client)
    expect(await repository.nativeImportReceipt(scope, request.target.source)).toEqual(
      receipt.result
    )
    expect(await repository.createMany([native], receipt)).toBe(0)
    const page = await repository.list({ ...scope, sourceFileId: 'file-1', versionId: 'version-1' })
    expect(page).toEqual({ items: [], total: 0, nativeImport: receipt.result })
    await client.session.deleteMany()
    expect(
      await repository.nativeImportReceipt(
        { projectId: scope.projectId, sessionId: 'another-session' },
        request.target.source
      )
    ).toEqual(receipt.result)
    expect(
      await repository.createMany([{ ...native, sessionId: 'another-session' }], {
        ...receipt,
        scope: { ...scope, sessionId: 'another-session' }
      })
    ).toBe(0)
    expect(await client.pdfAnnotationImport.count()).toBe(1)
  })

  it('round-trips exact source identity independently of Bookmarks and Session projections', async () => {
    const created = await repository.create(request)
    await client.session.deleteMany()
    await client.$disconnect()
    client = createProjectDbClient(root)
    repository = new PdfAnnotationRepository(async () => client)
    expect(await repository.list(scope)).toEqual({ total: 1, items: [created] })
    expect(created.target.source.sessionId).toBe('source-session')
    expect(await client.bookmark.count()).toBe(0)
    expect(await repository.list({ ...scope, sessionId: 'other' })).toEqual({
      total: 1,
      items: [created]
    })
  })
  it('shares a tagged annotation across sessions but keeps project and PDF version boundaries', async () => {
    const created = await repository.create(request)
    await repository.create({ ...request, id: 'annotation-2' })
    expect(await repository.list({ ...scope, id: created.id, limit: 1 })).toEqual({
      total: 1,
      items: [created]
    })
    expect((await repository.list({ ...scope, sessionId: 'other', id: created.id })).items).toEqual(
      [created]
    )
    expect((await repository.list({ projectId: scope.projectId, id: created.id })).items).toEqual([
      created
    ])
    expect((await repository.list({ ...scope, versionId: 'other', id: created.id })).items).toEqual(
      []
    )
    expect((await repository.list({ ...scope, id: 'missing' })).items).toEqual([])
  })
  it('recovers identical retries and rejects ID collisions without leaking another scope', async () => {
    const created = await repository.create(request)
    expect(await repository.create(request)).toEqual(created)
    await expect(repository.create({ ...request, note: 'Different' })).rejects.toThrow(
      'different content'
    )
    await expect(repository.create({ ...request, sessionId: 'other' })).rejects.toThrow(
      'different content'
    )
  })
  it('paginates, edits metadata, and removes only the requested scope', async () => {
    await repository.create(request)
    await repository.create({ ...request, id: 'annotation-2' })
    const page = await repository.list({ ...scope, limit: 1 })
    expect(page.total).toBe(2)
    expect(page.nextCursor).toBeDefined()
    expect((await repository.list({ ...scope, cursor: page.nextCursor })).items).toHaveLength(1)
    const changed = await repository.update({
      ...scope,
      id: request.id,
      note: 'Revised',
      color: 'pink',
      tagIds: ['method']
    })
    expect(changed).toMatchObject({
      note: 'Revised',
      color: 'pink',
      tagIds: ['method'],
      target: request.target
    })
    await expect(
      repository.update({ ...scope, sessionId: 'other', id: request.id, note: 'Shared' })
    ).resolves.toMatchObject({ note: 'Shared', sessionId: scope.sessionId })
    expect(await repository.delete({ ...scope, sessionId: 'other', id: request.id })).toBe(true)
    await client.session.deleteMany()
    expect((await repository.list(scope)).total).toBe(1)
  })
  it('imports a batch in one idempotent write path', async () => {
    const batch = [
      { ...request, id: 'native-1', tagIds: [] },
      { ...request, id: 'native-2', tagIds: [], note: 'Second native note' }
    ]
    await expect(repository.createMany(batch)).resolves.toBe(2)
    await expect(repository.createMany(batch)).resolves.toBe(0)
    expect((await repository.list(scope)).items.map(({ id }) => id)).toEqual([
      'native-1',
      'native-2'
    ])
  })
  it('deduplicates identical batch IDs and rejects mixed sources', async () => {
    const duplicate = { ...request, id: 'native-duplicate', tagIds: [] }
    await expect(repository.createMany([duplicate, duplicate])).resolves.toBe(1)
    await expect(
      repository.createMany([
        { ...request, id: 'native-a', tagIds: [] },
        {
          ...request,
          id: 'native-b',
          tagIds: [],
          target: {
            ...request.target,
            source: { ...request.target.source, versionId: 'another-version' }
          }
        }
      ])
    ).rejects.toThrow('share one source and scope')
  })
  it('fails closed for unsupported persisted envelope versions', async () => {
    await repository.create(request)
    await client.pdfAnnotation.update({
      where: { id: request.id },
      data: { selectorJson: JSON.stringify({ version: 2, selector: request.target.selector }) }
    })
    await expect(repository.list(scope)).rejects.toThrow()
  })
  it('rejects stale write tokens and preserves original creation time when restoring a deletion', async () => {
    const original = await repository.create({ ...request, createdAt: '2020-01-01T00:00:00.000Z' })
    const changed = await repository.update({
      ...scope,
      id: original.id,
      note: 'New',
      color: null,
      expectedUpdatedAt: original.updatedAt
    })
    expect(changed.updatedAt > original.updatedAt).toBe(true)
    expect(changed.color).toBeUndefined()
    await expect(
      repository.update({
        ...scope,
        id: original.id,
        note: 'Stale',
        expectedUpdatedAt: original.updatedAt
      })
    ).rejects.toThrow('changed')
    await expect(
      repository.delete({ ...scope, id: original.id, expectedUpdatedAt: original.updatedAt })
    ).rejects.toThrow('changed')
    expect((await repository.list(scope)).items[0].note).toBe('New')
    await repository.delete({ ...scope, id: original.id, expectedUpdatedAt: changed.updatedAt })
    const restored = await repository.create({ ...request, createdAt: original.createdAt })
    expect(restored.createdAt).toBe(original.createdAt)
    expect(restored.target).toEqual(original.target)
  })

  it('commits tags with annotations, rejects stale tag IDs atomically, and preserves notes on global deletion', async () => {
    await expect(repository.create({ ...request, tagIds: ['missing'] })).rejects.toThrow(
      'Tag no longer exists'
    )
    expect(await client.pdfAnnotation.count()).toBe(0)
    const original = await repository.create(request)
    await expect(
      new TagRepository(async () => client).pruneStaleAssignments({
        'catalog.skill': new Set(),
        'catalog.connector': new Set(),
        'catalog.specialist': new Set(),
        'literature.item': new Set(),
        'pdf.annotation': new Set()
      })
    ).resolves.toBe(0)
    await expect(
      repository.update({ ...scope, id: original.id, note: 'Must roll back', tagIds: ['missing'] })
    ).rejects.toThrow()
    expect(await repository.get(original.id)).toEqual(original)
    await new TagRepository(async () => client).delete('review')
    expect(await repository.get(original.id)).toMatchObject({
      note: original.note,
      target: original.target,
      tagIds: []
    })
    expect(await client.tagAssignment.count()).toBe(0)
  })

  it('retains document notes after Session deletion and cleans their Project associations', async () => {
    await repository.create(request)
    await repository.create({ ...request, id: 'other-session', sessionId: 's2' })
    await client.project.create({ data: { id: 'other-project', name: 'Other' } })
    await repository.create({
      ...request,
      id: 'other-project',
      projectId: 'other-project',
      target: {
        ...request.target,
        source: { ...request.target.source, projectId: 'other-project' }
      }
    })
    await repository.delete({ ...scope, id: request.id })
    expect(await client.tagAssignment.count()).toBe(2)
    await client.session.deleteMany({ where: { id: 's2' } })
    expect(await client.tagAssignment.count()).toBe(2)
    await new ProjectRepository(async () => client).delete('other-project')
    expect(await client.tagAssignment.count()).toBe(1)
    await new ProjectRepository(async () => client).delete(scope.projectId)
    expect(await client.tagAssignment.count()).toBe(0)
    expect(await client.tag.count({ where: { id: { in: ['review', 'method'] } } })).toBe(2)
    expect(await client.pdfAnnotation.count()).toBe(0)
  })

  it.each(['attachment', 'item'] as const)(
    'cleans %s deletion by managed source identity and preserves Trash, other sources and global Tags',
    async (mode) => {
      const publish = vi.fn()
      const content = {
        sweep: vi.fn().mockResolvedValue({ failedIds: [] })
      } as unknown as ContentRepository
      let blocked = false
      const catalog = new LiteratureCatalog(
        async () => client,
        publish,
        content,
        async (remove) =>
          remove(() => {
            if (blocked) throw new Error('in use')
          })
      )
      const item = await catalog.transact({
        kind: 'create-item',
        item: literatureItemInputSchema.parse({
          itemType: 'journalArticle',
          title: 'Paper',
          creators: [],
          identifiers: [],
          typeFields: {}
        })
      })
      await client.literatureAttachment.create({ data: { id: 'attachment-1', itemId: item.id } })
      await client.contentBlob.create({
        data: {
          id: 'blob-1',
          checksum: 'a'.repeat(64),
          storageKey: 'content/one',
          sizeBytes: 100n,
          contentType: 'application/pdf',
          state: 'available'
        }
      })
      await client.literatureAttachmentVersion.create({
        data: {
          id: 'version-1',
          attachmentId: 'attachment-1',
          contentBlobId: 'blob-1',
          versionNumber: 1,
          filename: 'paper.pdf',
          contentType: 'application/pdf',
          sizeBytes: 100n,
          checksum: 'a'.repeat(64)
        }
      })
      const input = {
        ...request,
        projectId: undefined,
        sessionId: undefined,
        literatureVersionId: 'version-1',
        target: {
          ...request.target,
          source: {
            ...request.target.source,
            kind: 'literature-attachment-version' as const,
            projectId: undefined,
            sessionId: undefined,
            sourceFileId: 'attachment-1'
          }
        }
      }
      const global = await repository.create(input)
      expect((await repository.list({ literatureVersionId: 'version-1' })).items).toEqual([global])
      expect(
        (await repository.list({ literatureVersionId: 'another-version', id: global.id })).items
      ).toEqual([])
      expect(
        (await repository.list({ literatureVersionId: 'version-1', id: global.id })).items
      ).toEqual([global])
      await expect(
        repository.update({
          id: request.id,
          literatureVersionId: 'another-version',
          note: 'Wrong version'
        })
      ).rejects.toThrow('not found')
      await expect(
        repository.update({ id: request.id, ...scope, note: 'Wrong scope' })
      ).rejects.toThrow('not found')
      await client.session.deleteMany()
      await new ProjectRepository(async () => client).delete(scope.projectId)
      expect(await repository.get(request.id)).toEqual(global)
      const snapshot = await new TagRepository(async () => client).snapshot(1)
      expect(snapshot.pdfAnnotations).toContainEqual(
        expect.objectContaining({
          id: request.id,
          literatureItemId: item.id,
          versionId: 'version-1'
        })
      )
      await client.project.update({ where: { id: scope.projectId }, data: { deletedAt: null } })
      await repository.create({ ...request, id: 'other-source' })
      await catalog.transact({ kind: 'set-item-lifecycle', itemIds: [item.id], state: 'deleted' })
      expect(await repository.get(request.id)).toBeDefined()
      await expect(
        repository.update({ id: request.id, literatureVersionId: 'version-1', note: 'In Trash' })
      ).rejects.toThrow('not available')
      await expect(repository.create({ ...input, id: 'new-trashed-mark' })).rejects.toThrow(
        'not available'
      )
      if (mode === 'attachment')
        await catalog.transact({ kind: 'set-item-lifecycle', itemIds: [item.id], state: 'active' })
      const command =
        mode === 'attachment'
          ? { kind: 'delete-attachment' as const, itemId: item.id, attachmentId: 'attachment-1' }
          : { kind: 'delete-items-permanently' as const, itemIds: [item.id] }
      blocked = true
      await expect(catalog.transact(command)).rejects.toThrow('in use')
      expect(await client.tagAssignment.count()).toBe(2)
      blocked = false
      await catalog.transact(command)
      expect(await repository.get(request.id)).toBeUndefined()
      expect(await repository.get('other-source')).toBeDefined()
      expect(await client.tagAssignment.count()).toBe(1)
      expect(await client.tag.count({ where: { id: { in: ['review', 'method'] } } })).toBe(2)
      expect(publish).toHaveBeenCalled()
    }
  )
})
