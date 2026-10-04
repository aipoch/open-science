import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import {
  pdfAnnotationSchema,
  pdfNativeImportReceiptSchema,
  type ListPdfAnnotationsRequest,
  type PdfAnnotationSource
} from '../../shared/pdf-annotations'
import { tagViewSchema } from '../../shared/tags'
import { createUploadVersionReference } from '../../shared/uploads'
import { createArtifactVersionLocator } from '../../shared/artifact-provenance'
import { readAnnotations } from '../pdf-annotations/repository'
import type { PackageRecords } from './native-snapshot'

// Optional, inert package data. Import never writes these records to the user's shared notebook.
export const packagePdfNotesSchema = z
  .array(
    z
      .object({
        versionId: z.string().min(1).max(1024),
        annotations: z.array(pdfAnnotationSchema).max(10000),
        tags: z.array(tagViewSchema).max(10000),
        nativeImport: pdfNativeImportReceiptSchema.optional()
      })
      .strict()
  )
  .max(1000)
export type PackagePdfNotes = z.infer<typeof packagePdfNotesSchema>

// Resolve from restored package versions even when every snapshot annotation was deleted.
export const readPackagePdfSource = async (
  client: PrismaClient,
  request: ListPdfAnnotationsRequest
): Promise<PdfAnnotationSource | undefined> => {
  const { projectId, sessionId, sourceFileId, versionId } = request
  if (!projectId || !sessionId || !versionId) return undefined
  const owner = { projectId, sessionId, ...(sourceFileId ? { id: sourceFileId } : {}) }
  const [upload, artifact] = await Promise.all([
    client.uploadVersion.findFirst({
      where: { id: versionId, state: 'ready', uploadFile: owner },
      include: { uploadFile: true }
    }),
    client.artifactVersion.findFirst({
      where: { id: versionId, state: 'finalized', artifact: owner },
      include: { artifact: true }
    })
  ])
  const version = upload ?? artifact
  const fileId = upload?.uploadFile.id ?? artifact?.artifact.id
  if (!version || !fileId) return undefined
  return {
    kind: upload ? 'upload-version' : 'artifact-version',
    projectId,
    sessionId,
    sourceFileId: fileId,
    versionId,
    checksum: version.checksum,
    name: version.filename,
    path: upload
      ? createUploadVersionReference(versionId, { projectId, sessionId, fileId })
      : createArtifactVersionLocator({
          projectId,
          appSessionId: sessionId,
          artifactId: fileId,
          versionId
        })
  }
}

export const capturePackagePdfNotes = async (
  client: PrismaClient,
  records: PackageRecords,
  excluded: ReadonlySet<string>
): Promise<PackagePdfNotes> =>
  client.$transaction(async (tx) => {
    const snapshots: PackagePdfNotes = []
    for (const [table, kind, owners, fileKey] of [
      ['UploadVersion', 'upload-version', records.tables.UploadFile, 'uploadFileId'],
      ['ArtifactVersion', 'artifact-version', records.tables.ArtifactLineage, 'artifactId']
    ] as const)
      for (const version of records.tables[table]) {
        if (excluded.has(String(version.contentStorageKey))) continue
        const owner = owners.find((row) => row.id === version[fileKey])
        if (!owner) continue
        const binding = await tx.pdfAnnotationSourceBinding.findFirst({
          where: { versionId: String(version.id), checksum: String(version.checksum) },
          include: { document: true }
        })
        if (!binding) continue
        if (
          binding.document.pdfDocumentId &&
          (await tx.pdfAnnotationDocument.count({
            where: { pdfDocumentId: binding.document.pdfDocumentId }
          })) > 1
        )
          throw new Error('Resolve historical PDF note conflicts before exporting shared notes.')
        const rows = await tx.pdfAnnotation.findMany({
          where: { documentId: binding.documentId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
        })
        const receipt = await tx.pdfAnnotationImport.findUnique({
          where: { documentId: binding.documentId }
        })
        if (!rows.length && !receipt) continue
        const projectId = String(owner.projectId),
          sessionId = String(owner.sessionId),
          sourceFileId = String(owner.id),
          versionId = String(version.id)
        const source: PdfAnnotationSource = {
          kind,
          projectId,
          sessionId,
          sourceFileId,
          versionId,
          checksum: String(version.checksum),
          name: String(version.filename),
          path:
            kind === 'upload-version'
              ? createUploadVersionReference(versionId, {
                  projectId,
                  sessionId,
                  fileId: sourceFileId
                })
              : createArtifactVersionLocator({
                  projectId,
                  appSessionId: sessionId,
                  artifactId: sourceFileId,
                  versionId
                })
        }
        const annotations = (await readAnnotations(tx, rows)).map((note) => ({
          ...note,
          projectId,
          sessionId,
          literatureVersionId: undefined,
          target: { ...note.target, source }
        }))
        const tagIds = [...new Set(annotations.flatMap((note) => note.tagIds))]
        const tags = (await tx.tag.findMany({ where: { id: { in: tagIds } } })).map((tag) =>
          tagViewSchema.parse({
            id: tag.id,
            createdAt: tag.createdAt.getTime(),
            updatedAt: tag.updatedAt.getTime(),
            ...(tag.systemKey
              ? { systemKey: tag.systemKey }
              : { name: tag.name, colorKey: tag.colorKey, iconKey: tag.iconKey })
          })
        )
        snapshots.push({
          versionId,
          annotations,
          tags,
          ...(receipt
            ? { nativeImport: pdfNativeImportReceiptSchema.parse(JSON.parse(receipt.resultJson)) }
            : {})
        })
      }
    return packagePdfNotesSchema.parse(snapshots)
  })

export const validatePackagePdfNotes = (records: PackageRecords): void => {
  if (!records.pdfNotes) return
  const snapshots = packagePdfNotesSchema.parse(records.pdfNotes)
  if (snapshots.reduce((count, snapshot) => count + snapshot.annotations.length, 0) > 10000)
    throw new Error('Session package contains too many PDF notes.')
  const versions = [...records.tables.UploadVersion, ...records.tables.ArtifactVersion]
  const seen = new Set<string>()
  for (const snapshot of snapshots) {
    const version = versions.find((row) => row.id === snapshot.versionId)
    if (!version || seen.has(snapshot.versionId))
      throw new Error('Invalid package PDF note version.')
    seen.add(snapshot.versionId)
    const kind = 'uploadFileId' in version ? 'upload-version' : 'artifact-version'
    const owner = (
      kind === 'upload-version' ? records.tables.UploadFile : records.tables.ArtifactLineage
    ).find((row) => row.id === (version.uploadFileId ?? version.artifactId))
    if (
      !owner ||
      new Set(snapshot.annotations.map((note) => note.id)).size !== snapshot.annotations.length ||
      new Set(snapshot.tags.map((tag) => tag.id)).size !== snapshot.tags.length
    )
      throw new Error('Invalid package PDF note owner or duplicate records.')
    for (const note of snapshot.annotations) {
      if (
        note.projectId !== owner.projectId ||
        note.sessionId !== owner.sessionId ||
        note.target.source.kind !== kind ||
        note.target.source.sourceFileId !== owner.id ||
        note.target.source.projectId !== owner.projectId ||
        note.target.source.sessionId !== owner.sessionId ||
        note.target.source.versionId !== version.id ||
        note.target.source.checksum !== version.checksum ||
        note.tagIds.some((id) => !snapshot.tags.some((tag) => tag.id === id))
      )
        throw new Error('Package PDF notes do not match their document.')
    }
  }
}

export const filterPackagePdfNotes = (
  records: PackageRecords,
  excluded: ReadonlySet<string>
): void => {
  if (!records.pdfNotes) return
  const included = new Set(
    [...records.tables.UploadVersion, ...records.tables.ArtifactVersion]
      .filter((row) => !excluded.has(String(row.contentStorageKey)))
      .map((row) => row.id)
  )
  records.pdfNotes = records.pdfNotes.filter((snapshot) => included.has(snapshot.versionId))
}

export const namespacePackagePdfNotes = (
  snapshots: PackagePdfNotes,
  sessionId: string
): PackagePdfNotes => {
  const id = (value: string): string =>
    `snapshot:${createHash('sha256')
      .update(JSON.stringify([sessionId, value]))
      .digest('hex')}`
  return snapshots.map((snapshot) => ({
    ...snapshot,
    annotations: snapshot.annotations.map((note) => ({
      ...note,
      id: id(note.id),
      tagIds: note.tagIds.map(id)
    })),
    tags: snapshot.tags.map((tag) => ({ ...tag, id: id(tag.id) }))
  }))
}

export const retainInheritedPdfNotes = (
  records: PackageRecords,
  inherited: PackagePdfNotes,
  excluded: ReadonlySet<string>
): void => {
  const merged = new Map((records.pdfNotes ?? []).map((snapshot) => [snapshot.versionId, snapshot]))
  for (const snapshot of inherited) {
    const live = merged.get(snapshot.versionId)
    merged.set(
      snapshot.versionId,
      live
        ? {
            ...live,
            annotations: [...live.annotations, ...snapshot.annotations],
            tags: [
              ...new Map([...live.tags, ...snapshot.tags].map((tag) => [tag.id, tag])).values()
            ]
          }
        : snapshot
    )
  }
  records.pdfNotes = [...merged.values()]
  filterPackagePdfNotes(records, excluded)
  validatePackagePdfNotes(records)
}
