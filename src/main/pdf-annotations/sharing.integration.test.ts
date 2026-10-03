import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase } from '../database/migration-service'
import { ProjectRepository } from '../projects/repository'
import { PdfAnnotationRepository, deletePdfAnnotations } from './repository'
import type {
  PdfAnnotationSource,
  CreatePdfAnnotationRequest,
  PdfSharingDecision
} from '../../shared/pdf-annotations'
import type { PdfNativeAnnotationDraft } from './native-import'
let root: string, client: PrismaClient, repository: PdfAnnotationRepository
const checksum = 'a'.repeat(64)
const source: PdfAnnotationSource = {
  kind: 'upload-version',
  projectId: 'p',
  sessionId: 's',
  sourceFileId: 'file',
  versionId: 'v',
  checksum,
  name: 'paper.pdf',
  path: 'upload-version:v'
}
const target: PdfAnnotationSource = {
  kind: 'literature-attachment-version',
  sourceFileId: 'attachment',
  versionId: 'library-v',
  checksum,
  name: 'paper.pdf',
  path: 'literature-attachment-version:library-v'
}
const note = (id: string, input = source, text = 'My note'): CreatePdfAnnotationRequest => ({
  id,
  ...(input.projectId
    ? { projectId: input.projectId, sessionId: input.sessionId }
    : { literatureVersionId: input.versionId }),
  target: { source: input, selector: { kind: 'document-note', coordinateVersion: 1 } },
  kind: 'document-note',
  note: text,
  tagIds: []
})
const draft: PdfNativeAnnotationDraft = {
  stableKey: 'b'.repeat(64),
  nativeId: '12R',
  pageNumber: 1,
  kind: 'area',
  subtype: 'Square',
  note: 'Original',
  color: 'yellow',
  selector: {
    kind: 'region',
    pageNumber: 1,
    rect: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
    pageRotation: 0,
    coordinateVersion: 1
  }
}
const imported = async (input: PdfAnnotationSource, prefix: string): Promise<string> => {
  const id = `native:${prefix.repeat(32)}:${draft.stableKey}`
  const request = {
    ...note(id, input, draft.note),
    kind: draft.kind,
    color: draft.color,
    origin: 'imported' as const,
    externalSubtype: draft.subtype,
    target: { source: input, selector: draft.selector }
  }
  await repository.createMany([request], {
    scope: request,
    source: input,
    result: {
      nativeRefs: [{ id: draft.nativeId!, pageNumber: 1 }],
      pageCount: 1,
      unsupportedCount: 0,
      truncated: false
    }
  })
  return id
}
const merge = async (
  drafts: PdfNativeAnnotationDraft[] = [],
  decisions: PdfSharingDecision[] = []
): Promise<void> => {
  const preview = await repository.previewSharing(source, target, drafts, 'item')
  await client.$transaction((tx) =>
    repository.commitSharing(tx, source, target, 100, drafts, 'item', preview.token, decisions)
  )
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pdf-sharing-'))
  client = createProjectDbClient(root)
  await migrateApplicationDatabase(client)
  await client.project.createMany({
    data: [
      { id: 'p', name: 'P' },
      { id: 'other', name: 'Other' }
    ]
  })
  await client.contentBlob.create({
    data: { id: 'blob', checksum, storageKey: 'blob.pdf', sizeBytes: 100n, state: 'available' }
  })
  await client.literatureItem.create({
    data: {
      id: 'item',
      itemType: 'journalArticle',
      title: 'Paper',
      attachments: {
        create: {
          id: 'attachment',
          versions: {
            create: {
              id: 'library-v',
              contentBlobId: 'blob',
              versionNumber: 1,
              filename: 'paper.pdf',
              contentType: 'application/pdf',
              sizeBytes: 100n,
              checksum
            }
          }
        }
      }
    }
  })
  repository = new PdfAnnotationRepository(async () => client)
})
afterEach(async () => {
  await client.$disconnect()
  await rm(root, { recursive: true, force: true })
})
it('shares only explicitly linked sources and preserves notes through either source deletion and restart', async () => {
  const original = await repository.create(note('original'))
  await repository.create(note('private', { ...source, projectId: 'other' }))
  await repository.create(
    note('new-version', { ...source, versionId: 'v2', checksum: 'c'.repeat(64) })
  )
  await merge()
  const shared = (await repository.list({ literatureVersionId: target.versionId })).items
  expect(shared.map((row) => row.id)).toEqual(['original'])
  expect(shared[0].target.source).toEqual(target)
  await repository.update({
    literatureVersionId: target.versionId,
    id: original.id,
    expectedUpdatedAt: shared[0].updatedAt,
    note: 'Edited in Literature'
  })
  expect((await repository.list({ projectId: 'p', versionId: 'v' })).items[0].note).toBe(
    'Edited in Literature'
  )
  await new ProjectRepository(async () => client).delete('p')
  await client.$disconnect()
  client = createProjectDbClient(root)
  expect((await repository.list({ literatureVersionId: target.versionId })).items[0].note).toBe(
    'Edited in Literature'
  )
  expect((await repository.list({ projectId: 'other' })).items.map((row) => row.id)).toEqual([
    'private'
  ])
  await client.$transaction((tx) =>
    deletePdfAnnotations(tx, { sourceKind: target.kind, versionId: target.versionId })
  )
  expect(await repository.get('original')).toBeUndefined()
  expect(await repository.get('private')).toBeDefined()
})
it('rejects mismatched contents, stale merge previews and stale concurrent edits', async () => {
  const created = await repository.create(note('original'))
  await expect(
    repository.previewSharing(source, { ...target, checksum: 'c'.repeat(64) }, [], 'item')
  ).rejects.toThrow('contents')
  const preview = await repository.previewSharing(source, target, [], 'item')
  await repository.create(note('arrived-later'))
  await expect(
    client.$transaction((tx) =>
      repository.commitSharing(tx, source, target, 100, [], 'item', preview.token, [])
    )
  ).rejects.toThrow('expired')
  expect((await repository.list({ literatureVersionId: target.versionId })).items).toEqual([])
  await merge()
  const current = (await repository.list({ projectId: 'p', id: created.id })).items[0]
  const results = await Promise.allSettled([
    repository.update({
      projectId: 'p',
      id: created.id,
      expectedUpdatedAt: current.updatedAt,
      note: 'left'
    }),
    repository.update({
      literatureVersionId: target.versionId,
      id: created.id,
      expectedUpdatedAt: current.updatedAt,
      note: 'right'
    })
  ])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
})
it('deduplicates native imports, retains edits and old links, and never resurrects deleted originals', async () => {
  const left = await imported(source, 'a'),
    right = await imported(target, 'c')
  await repository.update({ projectId: 'p', id: left, note: 'Edited' })
  await merge([draft])
  const rows = (await repository.list({ literatureVersionId: target.versionId })).items
  expect(rows).toHaveLength(1)
  expect(rows[0].note).toBe('Edited')
  expect((await repository.get(right))?.id).toBe(left)
  await expect(
    repository.update({ literatureVersionId: target.versionId, id: right, note: 'stale' })
  ).rejects.toThrow('reconciled')
  await repository.delete({ projectId: 'p', id: left, expectedUpdatedAt: rows[0].updatedAt })
  await imported(target, 'c')
  expect((await repository.list({ literatureVersionId: target.versionId })).items).toEqual([])
  expect(await repository.get(right)).toBeUndefined()
})
it('requires explicit decisions for conflicting edits and can preserve both without losing user notes', async () => {
  const left = await imported(source, 'a'),
    right = await imported(target, 'c')
  await repository.update({ projectId: 'p', id: left, note: 'Left edit' })
  await repository.update({ literatureVersionId: target.versionId, id: right, note: 'Right edit' })
  await repository.create(note('user-left', source, 'Same text'))
  await repository.create(note('user-right', target, 'Same text'))
  const preview = await repository.previewSharing(source, target, [draft], 'item')
  expect(preview.conflicts).toHaveLength(1)
  await expect(merge([draft])).rejects.toThrow('Resolve every')
  await merge([draft], [{ key: draft.stableKey, choice: 'both' }])
  const rows = (await repository.list({ literatureVersionId: target.versionId })).items
  expect(rows).toHaveLength(4)
  expect(rows.every((row) => row.origin === 'user')).toBe(true)
})
it('survives Literature unlink while Workspace remains and treats deletion versus edit as a conflict', async () => {
  const left = await imported(source, 'a'),
    right = await imported(target, 'c')
  await repository.delete({ projectId: 'p', id: left })
  await repository.update({ literatureVersionId: target.versionId, id: right, note: 'Keep edited' })
  expect((await repository.previewSharing(source, target, [draft], 'item')).conflicts).toHaveLength(
    1
  )
  await merge([draft], [{ key: draft.stableKey, choice: 'right' }])
  await client.$transaction((tx) =>
    deletePdfAnnotations(tx, { sourceKind: target.kind, versionId: target.versionId })
  )
  expect((await repository.list({ projectId: 'p' })).items[0].note).toBe('Keep edited')
})

it('can preview and reopen a previously shared document with persisted byte size', async () => {
  await repository.create(note('repeat'))
  await merge()
  const preview = await repository.previewSharing(source, target, [], 'item')
  expect(preview).toMatchObject({ shared: true, sourceCount: 2, annotationCount: 1, conflicts: [] })
  await merge()
  expect(await client.pdfAnnotation.count()).toBe(1)
  expect(await client.pdfAnnotationDocument.count()).toBe(1)
})

it('navigates via a live source when the creating Literature reference is trashed', async () => {
  await repository.create(note('library-created', target))
  await merge()
  await client.literatureItem.update({ where: { id: 'item' }, data: { deletedAt: new Date() } })
  expect((await repository.get('library-created'))?.target.source.projectId).toBe('p')
  expect((await repository.list({ projectId: 'p' })).items).toHaveLength(1)
})

it('rejects an old ID reconciled between the recovery read and create transaction', async () => {
  await repository.create(note('anchor'))
  const binding = await client.pdfAnnotationSourceBinding.findFirstOrThrow()
  vi.spyOn(repository, 'recoverCreate').mockImplementationOnce(async () => {
    await client.pdfAnnotationAlias.create({
      data: { id: 'stale-undo', documentId: binding.documentId, annotationId: null }
    })
    return undefined
  })
  await expect(repository.create(note('stale-undo'))).rejects.toThrow('reconciled')
  expect(await client.pdfAnnotation.count()).toBe(1)
})
