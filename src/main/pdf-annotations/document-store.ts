import { createArtifactVersionLocator } from '../../shared/artifact-provenance'
import { createUploadVersionReference } from '../../shared/uploads'
import { randomUUID } from 'node:crypto'
import { findVerifiedPdfDocument } from '../pdf-documents/identity'
import type { Prisma, PdfAnnotation, PdfAnnotationSourceBinding, PdfDocument } from '@prisma/client'
import type { PdfAnnotationSource, ListPdfAnnotationsRequest } from '../../shared/pdf-annotations'

export type DocumentTransaction = Pick<
  Prisma.TransactionClient,
  | 'pdfDocument'
  | 'contentBlob'
  | 'uploadVersion'
  | 'artifactVersion'
  | 'literatureAttachmentVersion'
  | 'pdfAnnotationDocument'
  | 'pdfAnnotationSourceBinding'
  | 'pdfAnnotationAlias'
  | 'pdfAnnotation'
  | 'pdfAnnotationImport'
  | 'tagAssignment'
>
export const bindingId = (source: PdfAnnotationSource): string =>
  JSON.stringify([source.projectId ?? null, source.kind, source.sourceFileId, source.versionId])
export const bindingSource = (row: PdfAnnotationSourceBinding): PdfAnnotationSource => ({
  kind: row.sourceKind as PdfAnnotationSource['kind'],
  projectId: row.projectId ?? undefined,
  sessionId: row.sourceSessionId ?? undefined,
  sourceFileId: row.sourceFileId,
  versionId: row.versionId,
  checksum: row.checksum,
  name: row.name,
  path: row.path
})
export const bindingWhere = (
  scope: ListPdfAnnotationsRequest
): Prisma.PdfAnnotationSourceBindingWhereInput => {
  if (scope.literatureVersionId && !scope.projectId && !scope.sessionId)
    return {
      projectId: null,
      sourceKind: 'literature-attachment-version',
      versionId: scope.literatureVersionId
    }
  if (!scope.literatureVersionId && scope.projectId)
    return {
      projectId: scope.projectId,
      ...(scope.sourceFileId ? { sourceFileId: scope.sourceFileId } : {}),
      ...(scope.versionId ? { versionId: scope.versionId } : {})
    }
  throw new Error('PDF annotation scope is not available.')
}
export const ensureBinding = async (
  tx: DocumentTransaction,
  source: PdfAnnotationSource,
  verified?: PdfDocument
): Promise<PdfAnnotationSourceBinding> => {
  const id = bindingId(source)
  let existing = await tx.pdfAnnotationSourceBinding.findUnique({ where: { id } })
  const pdfDocument = verified ?? (await findVerifiedPdfDocument(tx, source))
  if (pdfDocument && existing) {
    const canonical = await tx.pdfAnnotationDocument.findUnique({ where: { id: pdfDocument.id } })
    const documentId = canonical ? existing.documentId : pdfDocument.id
    await tx.pdfAnnotationDocument.update({
      where: { id: existing.documentId },
      data: { id: documentId, pdfDocumentId: pdfDocument.id, sizeBytes: pdfDocument.sizeBytes }
    })
    existing = { ...existing, documentId }
  }
  if (existing) {
    if (existing.checksum !== source.checksum) throw new Error('PDF source content changed.')
    // Legacy receipt-only bindings have no display metadata. Resolve it from authority on use.
    return tx.pdfAnnotationSourceBinding.update({
      where: { id },
      data: { name: source.name, path: source.path, sourceSessionId: source.sessionId }
    })
  }
  const document = pdfDocument
    ? await tx.pdfAnnotationDocument.upsert({
        where: { id: pdfDocument.id },
        create: {
          id: pdfDocument.id,
          pdfDocumentId: pdfDocument.id,
          checksum: pdfDocument.checksum,
          sizeBytes: pdfDocument.sizeBytes
        },
        update: {}
      })
    : await tx.pdfAnnotationDocument.create({
        data: { id: randomUUID(), checksum: source.checksum }
      })
  return tx.pdfAnnotationSourceBinding.create({
    data: {
      id,
      projectId: source.projectId,
      sourceSessionId: source.sessionId,
      sourceKind: source.kind,
      sourceFileId: source.sourceFileId,
      versionId: source.versionId,
      checksum: source.checksum,
      name: source.name,
      path: source.path,
      documentId: document.id
    }
  })
}
export const projectAnnotation = (
  row: PdfAnnotation,
  source: PdfAnnotationSourceBinding
): PdfAnnotation => ({
  ...row,
  projectId: source.projectId,
  sessionId: source.projectId === row.projectId ? row.sessionId : null,
  sourceSessionId: source.sourceSessionId,
  sourceKind: source.sourceKind,
  sourceFileId: source.sourceFileId,
  versionId: source.versionId,
  checksum: source.checksum,
  name: source.name,
  path: source.path
})
export const touchDocument = async (tx: DocumentTransaction, documentId: string): Promise<void> => {
  await tx.pdfAnnotationDocument.update({
    where: { id: documentId },
    data: { revision: { increment: 1 } }
  })
}
export const resolveAnnotationId = async (
  tx: DocumentTransaction,
  id: string
): Promise<string | null> => {
  const alias = await tx.pdfAnnotationAlias.findUnique({ where: { id } })
  return alias ? alias.annotationId : id
}
// Called only for permanent domain-source deletion, never projection rebuild or missing bytes.
export const removeDocumentSources = async (
  tx: DocumentTransaction,
  where: Prisma.PdfAnnotationSourceBindingWhereInput
): Promise<number> => {
  let sources = await tx.pdfAnnotationSourceBinding.findMany({ where })
  // A legacy notebook may never have been reopened after another source published these bytes.
  // Adopt only an already verified managed identity before unlinking its last navigation source.
  for (const source of sources) {
    const verified = await findVerifiedPdfDocument(tx, {
      kind: source.sourceKind,
      versionId: source.versionId,
      checksum: source.checksum
    })
    if (verified) await ensureBinding(tx, bindingSource(source), verified)
  }
  sources = await tx.pdfAnnotationSourceBinding.findMany({ where })
  await tx.pdfAnnotationSourceBinding.deleteMany({ where })
  let removed = 0
  for (const documentId of new Set(sources.map((source) => source.documentId))) {
    const remaining = await tx.pdfAnnotationSourceBinding.findFirst({
      where: { documentId },
      orderBy: { id: 'asc' }
    })
    if (remaining) {
      await touchDocument(tx, documentId)
      continue
    }
    const document = await tx.pdfAnnotationDocument.findUnique({ where: { id: documentId } })
    // Notes bindings are a navigation/reconciliation projection, not source ownership. A PDF
    // uploaded elsewhere may not have been opened yet. Its durable blob reference still protects it.
    if (
      document?.pdfDocumentId &&
      (await tx.contentBlob.findFirst({
        where: { pdfDocumentId: document.pdfDocumentId },
        select: { id: true }
      }))
    )
      continue
    const rows = await tx.pdfAnnotation.findMany({ where: { documentId }, select: { id: true } })
    await tx.tagAssignment.deleteMany({
      where: { resourceType: 'pdf.annotation', resourceId: { in: rows.map(({ id }) => id) } }
    })
    await tx.pdfAnnotationDocument.delete({ where: { id: documentId } })
    removed += rows.length
  }
  return removed
}

// Publication/recovery owners call this after their version becomes durable. Notes remain
// accessible from another project's Files/search before somebody first opens that PDF.
export const bindManagedPdfVersion = async (
  tx: DocumentTransaction,
  kind: 'upload-version' | 'artifact-version',
  versionId: string
): Promise<void> => {
  const upload =
    kind === 'upload-version'
      ? await tx.uploadVersion.findUnique({
          where: { id: versionId },
          include: { uploadFile: true }
        })
      : null
  const artifact =
    kind === 'artifact-version'
      ? await tx.artifactVersion.findUnique({
          where: { id: versionId },
          include: { artifact: true }
        })
      : null
  const version = upload ?? artifact
  const owner = upload?.uploadFile ?? artifact?.artifact
  if (!version || !owner) return
  const source: PdfAnnotationSource = {
    kind,
    projectId: owner.projectId,
    sessionId: owner.sessionId,
    sourceFileId: owner.id,
    versionId,
    checksum: version.checksum,
    name: version.filename,
    path:
      kind === 'upload-version'
        ? createUploadVersionReference(versionId, {
            projectId: owner.projectId,
            sessionId: owner.sessionId,
            fileId: owner.id
          })
        : createArtifactVersionLocator({
            projectId: owner.projectId,
            appSessionId: owner.sessionId,
            artifactId: owner.id,
            versionId
          })
  }
  const document = await findVerifiedPdfDocument(tx, source)
  if (document) await ensureBinding(tx, source, document)
}
