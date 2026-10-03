import { randomUUID } from 'node:crypto'
import type { Prisma, PdfAnnotation, PdfAnnotationSourceBinding } from '@prisma/client'
import type { PdfAnnotationSource, ListPdfAnnotationsRequest } from '../../shared/pdf-annotations'

export type DocumentTransaction = Pick<
  Prisma.TransactionClient,
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
  source: PdfAnnotationSource
): Promise<PdfAnnotationSourceBinding> => {
  const id = bindingId(source)
  const existing = await tx.pdfAnnotationSourceBinding.findUnique({ where: { id } })
  if (existing) {
    if (existing.checksum !== source.checksum) throw new Error('PDF source content changed.')
    // Legacy receipt-only bindings have no display metadata. Resolve it from authority on use.
    return tx.pdfAnnotationSourceBinding.update({
      where: { id },
      data: { name: source.name, path: source.path, sourceSessionId: source.sessionId }
    })
  }
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
      document: { create: { id: randomUUID(), checksum: source.checksum } }
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
  const sources = await tx.pdfAnnotationSourceBinding.findMany({ where })
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
    const rows = await tx.pdfAnnotation.findMany({ where: { documentId }, select: { id: true } })
    await tx.tagAssignment.deleteMany({
      where: { resourceType: 'pdf.annotation', resourceId: { in: rows.map(({ id }) => id) } }
    })
    await tx.pdfAnnotationDocument.delete({ where: { id: documentId } })
    removed += rows.length
  }
  return removed
}
