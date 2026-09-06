import {
  createLiteratureAttachmentVersionReference,
  type LiteratureItemView
} from '../../../../shared/literature'
import type { PdfReadingDocument } from '@/stores/navigation-store'
import { LITERATURE_PREVIEW_SESSION_ID } from '../workspace/preview-file-item'

export const literatureReadingDocument = (
  entry: LiteratureItemView
): PdfReadingDocument | undefined => {
  const attachments = [
    ...entry.attachments.filter(({ kind }) => kind === 'fullText'),
    ...entry.attachments.filter(({ kind }) => kind !== 'fullText')
  ]
  for (const attachment of attachments) {
    const version = attachment.versions[0]
    if (
      !version ||
      version.pageCount === 1 ||
      !(
        version.contentType.split(';')[0].trim().toLowerCase() === 'application/pdf' ||
        version.filename.toLowerCase().endsWith('.pdf')
      )
    )
      continue
    return {
      item: {
        id: `literature:${version.id}`,
        sessionId: LITERATURE_PREVIEW_SESSION_ID,
        title: version.filename,
        type: 'file',
        source: 'literature',
        path: createLiteratureAttachmentVersionReference(version.id),
        format: 'pdf',
        name: version.filename,
        mimeType: version.contentType,
        size: version.sizeBytes,
        versionNumber: version.versionNumber
      },
      source: { sourceKind: 'literature-attachment-version', sourceVersionId: version.id }
    }
  }
  return undefined
}
