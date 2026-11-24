import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { PdfAnnotationSource, CreatePdfAnnotationRequest } from '../../shared/pdf-annotations'
import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase } from '../database/migration-service'
import { PdfAnnotationRepository } from '../pdf-annotations/repository'
import type { PdfNativeAnnotationDraft } from '../pdf-annotations/native-import'
import { LiteratureCatalog } from './catalog'
import { LiteratureSynthesisSources } from './synthesis-sources'
import { LiteratureSynthesisService } from './synthesis'
import { LiteratureSynthesisStore } from './synthesis-store'

let root: string, client: PrismaClient, annotations: PdfAnnotationRepository
const checksum = 'a'.repeat(64)
const source: PdfAnnotationSource = {
  kind: 'upload-version',
  projectId: 'project',
  sessionId: 'session',
  sourceFileId: 'upload',
  versionId: 'upload-version',
  checksum,
  name: 'paper.pdf',
  path: 'upload-version:upload-version'
}
const target: PdfAnnotationSource = {
  kind: 'literature-attachment-version',
  sourceFileId: 'attachment',
  versionId: 'library-version',
  checksum,
  name: 'paper.pdf',
  path: 'literature-attachment-version:library-version'
}
const draft: PdfNativeAnnotationDraft = {
  stableKey: 'b'.repeat(64),
  nativeId: '12R',
  pageNumber: 1,
  kind: 'area',
  subtype: 'Square',
  note: 'Original evidence',
  color: 'yellow',
  selector: {
    kind: 'region',
    pageNumber: 1,
    rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
    pageRotation: 0,
    coordinateVersion: 1
  }
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'synthesis-sharing-'))
  client = createProjectDbClient(root)
  await migrateApplicationDatabase(client)
  await client.project.create({ data: { id: 'project', name: 'Project' } })
  await client.contentBlob.create({
    data: { id: 'blob', checksum, storageKey: 'blob.pdf', sizeBytes: 100n, state: 'available' }
  })
  await client.literatureItem.create({
    data: {
      id: 'paper',
      itemType: 'journalArticle',
      title: 'Paper',
      attachments: {
        create: {
          id: 'attachment',
          versions: {
            create: {
              id: 'library-version',
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
  annotations = new PdfAnnotationRepository(async () => client)
})
afterEach(async () => {
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})
async function importNative(input: PdfAnnotationSource, prefix: string): Promise<string> {
  const id = `native:${prefix.repeat(32)}:${draft.stableKey}`
  const request: CreatePdfAnnotationRequest = {
    id,
    ...(input.projectId
      ? { projectId: input.projectId, sessionId: input.sessionId }
      : { literatureVersionId: input.versionId }),
    kind: draft.kind,
    color: draft.color,
    origin: 'imported',
    externalSubtype: draft.subtype,
    note: draft.note,
    tagIds: [],
    target: { source: input, selector: draft.selector }
  }
  await annotations.createMany([request], {
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
it('keeps shared annotation aliases navigable without changing snapshots or admitting stale selections', async () => {
  const retained = await importNative(source, 'a')
  const retired = await importNative(target, 'c')
  const sources = new LiteratureSynthesisSources(
    async () => client,
    annotations,
    new LiteratureCatalog(async () => client)
  )
  const service = new LiteratureSynthesisService(
    new LiteratureSynthesisStore(() => join(root, 'synthesis.json')),
    sources
  )
  const excerpt = { itemId: 'paper', versionId: target.versionId, annotationId: retired }
  const created = await service.run({
    action: 'create',
    title: 'Before sharing',
    itemIds: ['paper'],
    excerpts: [excerpt]
  })
  if (created.action !== 'create') throw new Error('Unexpected result')
  await annotations.update({ projectId: 'project', id: retained, note: 'Edited source evidence' })
  const preview = await annotations.previewSharing(source, target, [draft], 'paper')
  await client.$transaction((tx) =>
    annotations.commitSharing(tx, source, target, 100, [draft], 'paper', preview.token, [])
  )
  expect(
    (await annotations.list({ literatureVersionId: target.versionId, id: retired })).items[0].id
  ).toBe(retained)
  const read = await service.run({ action: 'read', noteId: created.note.id })
  if (read.action !== 'read') throw new Error('Unexpected result')
  expect(read.note.blocks[0]).toMatchObject({
    sourceStatus: 'changed',
    snapshot: {
      annotationId: retired,
      annotation: {
        id: retired,
        note: draft.note,
        target: { source: target, selector: draft.selector }
      }
    }
  })
  const selectedSource = await service.run({
    action: 'source',
    noteId: created.note.id,
    blockId: read.note.blocks[0].id
  })
  expect(selectedSource.action === 'source' && selectedSource.block).toEqual(read.note.blocks[0])
  const candidate = (await sources.candidates(['paper'])).candidates[0]
  expect(candidate.annotationId).toBe(retained)
  const stale = { ...excerpt, expectedUpdatedAt: candidate.annotation.updatedAt }
  await expect(
    service.run({ action: 'create', title: 'Stale', itemIds: ['paper'], excerpts: [stale] })
  ).rejects.toThrow('unavailable')
  await expect(
    service.run({
      action: 'append',
      noteId: created.note.id,
      expectedRevision: 1,
      itemIds: ['paper'],
      excerpts: [stale]
    })
  ).rejects.toThrow('unavailable')
  const appended = await service.run({
    action: 'append',
    noteId: created.note.id,
    expectedRevision: 1,
    itemIds: ['paper'],
    excerpts: [
      { ...excerpt, annotationId: retained, expectedUpdatedAt: candidate.annotation.updatedAt }
    ]
  })
  if (appended.action !== 'append') throw new Error('Unexpected result')
  expect(appended.note.blocks).toHaveLength(1)
  expect(appended.note.blocks[0]).toEqual(read.note.blocks[0])
  // A tombstoned alias must not resolve to any surviving annotation.
  await annotations.delete({ literatureVersionId: target.versionId, id: retained })
  const unavailable = await service.run({ action: 'read', noteId: created.note.id })
  expect(unavailable.action === 'read' && unavailable.note.blocks[0]).toMatchObject({
    sourceStatus: 'unavailable',
    snapshot: { annotationId: retired }
  })
})
