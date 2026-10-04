import {
  registerVerifiedPdfContent,
  removeUnreferencedPdfDocument
} from '../pdf-documents/identity'
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
const imported = async (
  input: PdfAnnotationSource,
  prefix: string,
  truncated = false
): Promise<string> => {
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
      truncated
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
it('keeps unverified historical groups isolated while sharing explicitly linked sources and preserves notes through either source deletion and restart', async () => {
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
it.each([
  [true, false],
  [false, true],
  [false, false]
])('preserves native import truncation when merging receipts (%s, %s)', async (left, right) => {
  await imported(source, 'a', left)
  await imported(target, 'c', right)
  await merge([draft])
  const reopened = new PdfAnnotationRepository(async () => client)
  for (const scope of [
    { projectId: 'p', sourceFileId: source.sourceFileId, versionId: 'v' },
    { literatureVersionId: target.versionId }
  ]) {
    expect((await reopened.list(scope)).nativeImport?.truncated).toBe(left || right)
  }
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

it('automatically shares verified bytes across projects and Literature, while new bytes stay separate', async () => {
  await repository.registerVerifiedSource(source, 100)
  const created = await repository.create(note('one-copy'))
  const other = {
    ...source,
    projectId: 'other',
    sourceFileId: 'independent',
    versionId: 'independent-v'
  }
  await repository.registerVerifiedSource(other, 100)
  await repository.registerVerifiedSource(target, 100)
  expect(await client.pdfDocument.count()).toBe(1)
  expect(await client.pdfAnnotationDocument.count()).toBe(1)
  for (const scope of [
    { projectId: 'p' },
    { projectId: 'other' },
    { literatureVersionId: target.versionId }
  ])
    expect((await repository.list(scope)).items.map((row) => row.id)).toEqual([created.id])
  const competing = await Promise.allSettled([
    repository.update({
      projectId: 'other',
      id: created.id,
      expectedUpdatedAt: created.updatedAt,
      note: 'Other project'
    }),
    repository.update({
      literatureVersionId: target.versionId,
      id: created.id,
      expectedUpdatedAt: created.updatedAt,
      note: 'Literature'
    })
  ])
  expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  const next = { ...source, versionId: 'new-version', checksum: 'd'.repeat(64) }
  await repository.registerVerifiedSource(next, 101)
  expect((await repository.list({ projectId: 'p', versionId: next.versionId })).items).toEqual([])
  await new ProjectRepository(async () => client).delete('p')
  await client.$disconnect()
  client = createProjectDbClient(root)
  expect((await repository.list({ projectId: 'other' })).items.map((row) => row.id)).toEqual([
    created.id
  ])
  const current = (await repository.list({ literatureVersionId: target.versionId })).items[0]
  await repository.delete({
    literatureVersionId: target.versionId,
    id: current.id,
    expectedUpdatedAt: current.updatedAt
  })
  expect((await repository.list({ projectId: 'other' })).items).toEqual([])
})

it('keeps independent native edits pending under one byte identity and rejects stale decisions', async () => {
  const left = await imported(source, 'a')
  const right = await imported(target, 'c')
  await repository.update({ projectId: 'p', id: left, note: 'Workspace edit' })
  await repository.update({
    literatureVersionId: target.versionId,
    id: right,
    note: 'Library edit'
  })
  expect(await repository.registerVerifiedSource(source, 100)).toBe(false)
  expect(await repository.registerVerifiedSource(target, 100)).toBe(true)
  expect(await client.pdfDocument.count()).toBe(1)
  const preview = await repository.reconcileSource(target, 100, [draft])
  expect(preview?.conflicts).toHaveLength(1)
  expect((await repository.list({ projectId: 'p' })).reconciliationSources).toBeDefined()
  await repository.update({ projectId: 'p', id: left, note: 'Later edit' })
  await expect(
    repository.reconcileSource(target, 100, [draft], preview!.token, [
      { key: draft.stableKey, choice: 'both' }
    ])
  ).rejects.toThrow('expired')
  const refreshed = await repository.reconcileSource(target, 100, [draft])
  await repository.reconcileSource(target, 100, [draft], refreshed!.token, [
    { key: draft.stableKey, choice: 'both' }
  ])
  const result = await repository.list({ literatureVersionId: target.versionId })
  expect(result.items.map((row) => row.note).sort()).toEqual(['Later edit', 'Library edit'])
  expect(result.reconciliationSources).toBeUndefined()
  expect(await client.pdfAnnotationDocument.count()).toBe(1)
})

it('does not reimport deleted native notes when an independent project opens the same PDF', async () => {
  await repository.registerVerifiedSource(source, 100)
  const id = await imported(source, 'a')
  await repository.delete({ projectId: 'p', id })
  const other = { ...source, projectId: 'other', versionId: 'other-v' }
  await repository.registerVerifiedSource(other, 100)
  await imported(other, 'c')
  expect((await repository.list({ projectId: 'other' })).items).toEqual([])
  expect(await repository.nativeImportReceipt({ projectId: 'other' }, other)).toMatchObject({
    nativeRefs: [{ id: '12R', pageNumber: 1 }]
  })
})

it('retains the shared document until the final managed content and source are removed', async () => {
  // Legacy note exists before the PDF identity layer has seen either source.
  await repository.create(note('retained', target))
  await client.contentBlob.update({ where: { id: 'blob' }, data: { verifiedAt: new Date() } })
  const document = await client.$transaction((tx) =>
    registerVerifiedPdfContent(tx, { checksum, sizeBytes: 100n })
  )
  await client.contentBlob.create({
    data: {
      id: 'other-physical-copy',
      checksum,
      storageKey: 'other.pdf',
      sizeBytes: 100n,
      state: 'available',
      verifiedAt: new Date(),
      pdfDocumentId: document.id
    }
  })
  await client.$transaction(async (tx) => {
    await deletePdfAnnotations(tx, { sourceKind: target.kind, versionId: target.versionId })
    await tx.literatureItem.delete({ where: { id: 'item' } })
    await tx.contentBlob.delete({ where: { id: 'blob' } })
    await removeUnreferencedPdfDocument(tx, document.id)
  })
  expect(await client.pdfAnnotation.count()).toBe(1)
  await client.$transaction(async (tx) => {
    await tx.contentBlob.delete({ where: { id: 'other-physical-copy' } })
    await removeUnreferencedPdfDocument(tx, document.id)
  })
  expect(await client.pdfDocument.count()).toBe(0)
  expect(await client.pdfAnnotation.count()).toBe(0)
})

it.each(['matching copy', 'deletion receipt'] as const)(
  'requires explicit review for legacy native notes without a baseline against a %s',
  async (scenario) => {
    const legacy = await imported(source, 'a')
    const other = await imported(target, 'b')
    await client.pdfAnnotation.update({
      where: { id: legacy },
      data: { nativeBaselineJson: null, nativeKey: null }
    })
    if (scenario === 'deletion receipt') {
      const current = (await repository.list({ literatureVersionId: target.versionId })).items[0]
      await repository.delete({
        literatureVersionId: target.versionId,
        id: other,
        expectedUpdatedAt: current.updatedAt
      })
    }
    await repository.registerVerifiedSource(source, 100)
    await repository.registerVerifiedSource(target, 100)
    const before = await client.pdfAnnotation.findUniqueOrThrow({ where: { id: legacy } })
    const preview = await repository.reconcileSource(source, 100, [draft])
    expect(preview?.conflicts).toMatchObject([
      { key: draft.stableKey, unknown: true, left: { id: legacy, note: draft.note } }
    ])
    expect(await client.pdfAnnotation.findUnique({ where: { id: legacy } })).toEqual(before)
    expect(await client.pdfAnnotationDocument.count()).toBe(2)
    await repository.reconcileSource(source, 100, [draft], preview!.token, [
      { key: draft.stableKey, choice: 'left' }
    ])
    expect(
      (await repository.list({ literatureVersionId: target.versionId })).items.map((row) => [
        row.id,
        row.note
      ])
    ).toEqual([[legacy, draft.note]])
  }
)
