import { createArtifactVersionLocator } from '../../shared/artifact-version-locator'
import { createUploadVersionReference } from '../../shared/uploads'
import { createLiteratureAttachmentVersionReference } from '../../shared/literature-attachment-reference'
import type { PdfAnnotationSource } from '../../shared/pdf-annotations'
import { findVerifiedPdfDocument } from '../pdf-documents/identity'
import { ensureBinding, type DocumentTransaction } from './document-store'

// Source owners supply their active transaction so publication and annotation binding commit together.
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

export const bindLiteraturePdfVersion = async (
  transaction: DocumentTransaction,
  versionId: string
): Promise<void> => {
  const version = await transaction.literatureAttachmentVersion.findUniqueOrThrow({
    where: { id: versionId }
  })
  if (version.contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/pdf') return
  await ensureBinding(transaction, {
    kind: 'literature-attachment-version',
    sourceFileId: version.attachmentId,
    versionId,
    checksum: version.checksum,
    name: version.filename,
    path: createLiteratureAttachmentVersionReference(versionId)
  })
}
