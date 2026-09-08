import { inspectPdfPageCount, MAX_AUTO_EXTRACT_PDF_BYTES } from '../uploads/attachment-media'
import { open, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'

import {
  DEFAULT_UPLOAD_PROJECT_ID,
  getUploadedAttachmentName,
  PENDING_UPLOAD_SESSION_ID,
  type UploadedAttachment
} from '../../shared/uploads'
import type {
  LiteratureItemView,
  LiteraturePdfImportReceipt,
  LiteraturePdfImportRequest
} from '../../shared/literature'
import type { LiteratureCatalog } from './catalog'
import type { ContentRepository } from '../storage/content-repository'
import type { UploadRepository } from '../uploads/repository'

type LiteraturePdfImporterOptions = Readonly<{
  uploads: Pick<UploadRepository, 'deleteUpload' | 'resolveManagedUploadPath'>
  content: Pick<ContentRepository, 'withPublishedContent' | 'verify' | 'sweep'>
  catalog: Pick<LiteratureCatalog, 'attachContent' | 'get'>
}>

const assertPdfHeader = async (path: string): Promise<void> => {
  const handle = await open(path, 'r')
  try {
    const header = Buffer.alloc(5)
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0)
    if (bytesRead !== header.byteLength || header.toString('ascii') !== '%PDF-') {
      throw new Error('Selected file is not a PDF.')
    }
  } finally {
    await handle.close()
  }
}

class LiteraturePdfImporter {
  constructor(private readonly options: LiteraturePdfImporterOptions) {}

  async import(request: LiteraturePdfImportRequest): Promise<LiteraturePdfImportReceipt> {
    const attachment: UploadedAttachment = request.attachment
    if (attachment.sessionId !== PENDING_UPLOAD_SESSION_ID) {
      throw new Error('Literature imports require a pending managed upload.')
    }

    const filename = basename(getUploadedAttachmentName(attachment))
    if (!filename || extname(filename).toLowerCase() !== '.pdf') {
      throw new Error('Selected file must use the .pdf extension.')
    }

    let publishedId: string | undefined
    let attached = false
    try {
      const sourcePath = await this.options.uploads.resolveManagedUploadPath(
        { path: attachment.path },
        { projectId: DEFAULT_UPLOAD_PROJECT_ID, sessionId: PENDING_UPLOAD_SESSION_ID }
      )
      await assertPdfHeader(sourcePath)
      const source = await stat(sourcePath)
      if (!source.isFile() || !Number.isSafeInteger(source.size)) {
        throw new Error('Selected PDF size is invalid.')
      }

      return await this.options.content.withPublishedContent(
        {
          sourcePath,
          contentType: 'application/pdf'
        },
        async (content) => {
          publishedId = content.id
          let pageCount: number | undefined
          if (content.sizeBytes <= BigInt(MAX_AUTO_EXTRACT_PDF_BYTES)) {
            try {
              pageCount = await inspectPdfPageCount(content.path)
            } catch (error) {
              const name =
                error && typeof error === 'object' && 'name' in error ? error.name : undefined
              if (name === 'PasswordException')
                throw new Error('[pdf-password] PDF requires a password.', { cause: error })
              if (name === 'InvalidPDFException')
                throw new Error('[pdf-invalid] PDF is damaged or invalid.', { cause: error })
              throw new Error('[pdf-unreadable] PDF could not be parsed by this application.', {
                cause: error
              })
            }
          }
          // Validate the published identity again after parsing, not only the mutable staging path.
          if ((await this.options.content.verify(content.id)).state !== 'available') {
            throw new Error('[pdf-invalid] PDF content changed during import.')
          }
          await this.options.catalog.attachContent({
            itemId: request.itemId,
            contentBlobId: content.id,
            filename,
            contentType: 'application/pdf',
            sizeBytes: Number(content.sizeBytes),
            checksum: content.checksum,
            pageCount
          })
          attached = true
          const item: LiteratureItemView | undefined = await this.options.catalog.get(
            request.itemId
          )
          if (!item) throw new Error('Literature Item is unavailable after importing its PDF.')
          return { item }
        }
      )
    } finally {
      if (publishedId && !attached) {
        await this.options.content
          .sweep({ contentIds: [publishedId], createdBefore: new Date(Date.now() + 1) })
          .catch(() => undefined)
      }
      await this.options.uploads.deleteUpload({ path: attachment.path }).catch(() => undefined)
    }
  }
}

export { LiteraturePdfImporter }
export type { LiteraturePdfImporterOptions }
