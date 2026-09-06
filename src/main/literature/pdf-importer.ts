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
  content: Pick<ContentRepository, 'publish'>
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

      const content = await this.options.content.publish({
        sourcePath,
        contentType: 'application/pdf'
      })
      await this.options.catalog.attachContent({
        itemId: request.itemId,
        contentBlobId: content.id,
        filename,
        contentType: 'application/pdf',
        sizeBytes: Number(content.sizeBytes),
        checksum: content.checksum
      })
      const item: LiteratureItemView | undefined = await this.options.catalog.get(request.itemId)
      if (!item) throw new Error('Literature Item is unavailable after importing its PDF.')
      return { item }
    } finally {
      await this.options.uploads.deleteUpload({ path: attachment.path }).catch(() => undefined)
    }
  }
}

export { LiteraturePdfImporter }
export type { LiteraturePdfImporterOptions }
