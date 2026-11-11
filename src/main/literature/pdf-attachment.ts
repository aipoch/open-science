import { open, stat } from 'node:fs/promises'
import { inspectPdfPageCount, MAX_AUTO_EXTRACT_PDF_BYTES } from '../uploads/attachment-media'
import type { LiteratureCatalog } from './catalog'
import type { ContentRepository } from '../storage/content-repository'

type PdfAttachmentOptions = Readonly<{
  content: Pick<ContentRepository, 'withPublishedContent' | 'verify' | 'sweep'>
  catalog: Pick<LiteratureCatalog, 'attachContent'>
}>

export const assertPdfHeader = async (path: string): Promise<void> => {
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

export const pdfImportParseError = (error: unknown): Error => {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined
  if (name === 'PasswordException')
    return new Error('[pdf-password] PDF requires a password.', { cause: error })
  if (name === 'InvalidPDFException')
    return new Error('[pdf-invalid] PDF is damaged or invalid.', { cause: error })
  return new Error('[pdf-unreadable] PDF could not be parsed by this application.', {
    cause: error
  })
}

// Callers establish source authority and retain ownership of staging-file cleanup.
export async function attachLiteraturePdf(
  options: PdfAttachmentOptions,
  request: Readonly<{
    sourcePath: string
    itemId: string
    filename: string
    maxBytes?: number
    expectedMetadataRevision?: number
  }>,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const { sourcePath, filename } = request
  const source = await stat(sourcePath)
  if (!source.isFile() || !Number.isSafeInteger(source.size))
    throw new Error('Selected PDF size is invalid.')
  if (request.maxBytes !== undefined && source.size > request.maxBytes)
    throw new Error('Selected PDF exceeds the collection size limit.')
  await assertPdfHeader(sourcePath)
  signal?.throwIfAborted()
  let publishedId: string | undefined
  let attached = false
  try {
    await options.content.withPublishedContent(
      {
        sourcePath,
        contentType: 'application/pdf'
      },
      async (content) => {
        publishedId = content.id
        signal?.throwIfAborted()
        // Preflight limits a mutable source; enforce format and size on the published bytes too.
        if (request.maxBytes !== undefined && content.sizeBytes > BigInt(request.maxBytes))
          throw new Error('Selected PDF exceeds the collection size limit.')
        await assertPdfHeader(content.path)
        let pageCount: number | undefined
        if (content.sizeBytes <= BigInt(MAX_AUTO_EXTRACT_PDF_BYTES)) {
          try {
            pageCount = await inspectPdfPageCount(content.path)
          } catch (error) {
            signal?.throwIfAborted()
            throw pdfImportParseError(error)
          }
        }
        signal?.throwIfAborted()
        // Validate the published identity again after parsing, not only the mutable staging path.
        if ((await options.content.verify(content.id)).state !== 'available') {
          throw new Error('[pdf-invalid] PDF content changed during import.')
        }
        signal?.throwIfAborted()
        const attachment = {
          itemId: request.itemId,
          contentBlobId: content.id,
          filename,
          contentType: 'application/pdf',
          sizeBytes: Number(content.sizeBytes),
          checksum: content.checksum,
          pageCount,
          ...(request.expectedMetadataRevision === undefined
            ? {}
            : { expectedMetadataRevision: request.expectedMetadataRevision })
        }
        if (signal)
          await options.catalog.attachContent(attachment, async () => signal.throwIfAborted())
        else await options.catalog.attachContent(attachment)
        attached = true
      }
    )
  } finally {
    if (publishedId && !attached)
      await options.content
        .sweep({ contentIds: [publishedId], createdBefore: new Date(Date.now() + 1) })
        .catch(() => undefined)
  }
}
