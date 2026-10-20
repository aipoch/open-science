import { randomUUID } from 'node:crypto'
import type { Prisma, PdfDocument } from '@prisma/client'

type IdentityTransaction = Pick<Prisma.TransactionClient, 'pdfDocument' | 'contentBlob'>
export type VerifiedPdfContent = Readonly<{ checksum: string; sizeBytes: bigint }>

// Main-process boundary: call only after hashing an immutable lease or successfully publishing
// managed bytes. A renderer-supplied digest is neither proof of content nor permission to read it.
export const registerVerifiedPdfContent = async (
  tx: IdentityTransaction,
  content: VerifiedPdfContent
): Promise<PdfDocument> => {
  if (!/^[a-f0-9]{64}$/.test(content.checksum) || content.sizeBytes < 0n)
    throw new Error('Invalid verified PDF content identity.')
  const document = await tx.pdfDocument.upsert({
    where: { checksum_sizeBytes: content },
    create: { id: randomUUID(), ...content },
    update: {}
  })
  // These records already passed managed publication. Include duplicate physical blob records:
  // upload/artifact blob ids are version-based, whereas Literature blob ids are content-based.
  await tx.contentBlob.updateMany({
    where: { ...content, state: 'available', verifiedAt: { not: null } },
    data: { pdfDocumentId: document.id }
  })
  return document
}

export const registerPublishedPdfContent = async (
  tx: IdentityTransaction,
  content: VerifiedPdfContent & { contentType?: string | null }
): Promise<void> => {
  if (content.contentType?.split(';', 1)[0].trim().toLowerCase() !== 'application/pdf') return
  await registerVerifiedPdfContent(tx, { checksum: content.checksum, sizeBytes: content.sizeBytes })
}

export const findVerifiedPdfDocument = async (
  tx: Pick<
    Prisma.TransactionClient,
    'contentBlob' | 'uploadVersion' | 'artifactVersion' | 'literatureAttachmentVersion'
  >,
  source: { kind: string; versionId: string; checksum: string }
): Promise<PdfDocument | null> => {
  if (
    !['upload-version', 'artifact-version', 'literature-attachment-version'].includes(source.kind)
  )
    return null
  const where = { id: source.versionId }
  const select = { contentBlobId: true, checksum: true, sizeBytes: true }
  const version =
    source.kind === 'upload-version'
      ? await tx.uploadVersion.findUnique({ where, select })
      : source.kind === 'artifact-version'
        ? await tx.artifactVersion.findUnique({ where, select })
        : await tx.literatureAttachmentVersion.findUnique({ where, select })
  if (!version?.contentBlobId || version.checksum !== source.checksum) return null
  const blob = await tx.contentBlob.findFirst({
    where: {
      id: version.contentBlobId,
      checksum: version.checksum,
      sizeBytes: version.sizeBytes,
      state: 'available',
      verifiedAt: { not: null }
    },
    include: { pdfDocument: true }
  })
  return blob?.pdfDocument ?? null
}

// Only the managed-content sweeper calls this after permanent source removal and byte cleanup.
// Missing/quarantined bytes and project/catalog soft deletion never invoke document cleanup.
export const removeUnreferencedPdfDocument = async (
  tx: Pick<
    Prisma.TransactionClient,
    'pdfDocument' | 'contentBlob' | 'pdfAnnotation' | 'pdfAnnotationSourceBinding' | 'tagAssignment'
  >,
  documentId: string
): Promise<void> => {
  const document = await tx.pdfDocument.findUnique({ where: { id: documentId } })
  if (!document) return
  if (
    await tx.contentBlob.findFirst({
      where: {
        checksum: document.checksum,
        sizeBytes: document.sizeBytes
      },
      select: { id: true }
    })
  )
    return
  if (
    await tx.pdfAnnotationSourceBinding.findFirst({
      where: { document: { pdfDocumentId: documentId } },
      select: { id: true }
    })
  )
    return
  const notes = await tx.pdfAnnotation.findMany({
    where: { document: { pdfDocumentId: documentId } },
    select: { id: true }
  })
  await tx.tagAssignment.deleteMany({
    where: {
      resourceType: 'pdf.annotation',
      resourceId: { in: notes.map(({ id }) => id) }
    }
  })
  await tx.pdfDocument.delete({ where: { id: documentId } })
}
