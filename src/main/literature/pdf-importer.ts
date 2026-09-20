import { nativeImportReceipt } from '../pdf-annotations/native-import'
import { inspectPdfPageCount, MAX_AUTO_EXTRACT_PDF_BYTES } from '../uploads/attachment-media'
import {
  parseNativePdfAnnotations,
  type NativePdfAnnotationImportResult
} from '../pdf-annotations/native-import'
import { open, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { createHash } from 'node:crypto'

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
import type { PdfNativeAnnotationImportProgress } from '../../shared/pdf-annotations'
import type { LiteratureCatalog } from './catalog'
import type { ContentRepository } from '../storage/content-repository'
import type { UploadRepository } from '../uploads/repository'
import type { PdfAnnotationRepository } from '../pdf-annotations/repository'
import { createLiteratureAttachmentVersionReference } from '../../shared/literature'
import type { CreatePdfAnnotationRequest } from '../../shared/pdf-annotations'

type LiteraturePdfImporterOptions = Readonly<{
  uploads: Pick<UploadRepository, 'deleteUpload' | 'resolveManagedUploadPath'>
  content: Pick<ContentRepository, 'withPublishedContent' | 'verify' | 'sweep'>
  catalog: Pick<LiteratureCatalog, 'attachContent' | 'get'>
  annotations?: Pick<PdfAnnotationRepository, 'createMany'>
  onNativeImportProgress?: (progress: PdfNativeAnnotationImportProgress) => void
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

const pdfImportParseError = (error: unknown): Error => {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined
  if (name === 'PasswordException')
    return new Error('[pdf-password] PDF requires a password.', { cause: error })
  if (name === 'InvalidPDFException')
    return new Error('[pdf-invalid] PDF is damaged or invalid.', { cause: error })
  return new Error('[pdf-unreadable] PDF could not be parsed by this application.', {
    cause: error
  })
}

class LiteraturePdfImporter {
  private readonly activeImports = new Map<string, AbortController>()

  constructor(private readonly options: LiteraturePdfImporterOptions) {}

  cancelImport(operationId: string): { cancelled: boolean } {
    const controller = this.activeImports.get(operationId)
    if (!controller) return { cancelled: false }
    controller.abort(new Error('PDF annotation import cancelled.'))
    return { cancelled: true }
  }

  async import(
    request: LiteraturePdfImportRequest,
    signal?: AbortSignal
  ): Promise<LiteraturePdfImportReceipt> {
    const attachment: UploadedAttachment = request.attachment
    if (attachment.sessionId !== PENDING_UPLOAD_SESSION_ID) {
      throw new Error('Literature imports require a pending managed upload.')
    }

    const filename = basename(getUploadedAttachmentName(attachment))
    if (!filename || extname(filename).toLowerCase() !== '.pdf') {
      throw new Error('Selected file must use the .pdf extension.')
    }
    const operationId = request.operationId ?? crypto.randomUUID()
    if (this.activeImports.has(operationId))
      throw new Error('PDF import operation is already active.')
    const controller = new AbortController()
    const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    this.activeImports.set(operationId, controller)
    const publish = (progress: Omit<PdfNativeAnnotationImportProgress, 'operationId'>): void =>
      this.options.onNativeImportProgress?.({ operationId, ...progress })

    let publishedId: string | undefined
    let attached = false
    try {
      combinedSignal.throwIfAborted()
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
          let nativeAnnotations: NativePdfAnnotationImportResult | undefined
          let importedCount: number | undefined = 0
          if (this.options.annotations) {
            try {
              publish({
                phase: 'parsing',
                pagesProcessed: 0,
                pageCount: 0,
                importedCount: 0,
                unsupportedCount: 0
              })
              nativeAnnotations = await parseNativePdfAnnotations(content.path, {
                signal: combinedSignal,
                onProgress: (progress) =>
                  publish({
                    phase: 'parsing',
                    pagesProcessed: progress.pagesProcessed,
                    pageCount: progress.pageCount,
                    importedCount: progress.annotationsFound,
                    unsupportedCount: progress.unsupportedCount
                  })
              })
              pageCount = nativeAnnotations.pageCount
            } catch (error) {
              if (combinedSignal.aborted) throw error
              // Annotation extraction is enrichment. If a malformed native annotation makes the
              // richer pass fail, retain the existing page-count validation and attach the PDF.
              nativeAnnotations = undefined
              if (content.sizeBytes <= BigInt(MAX_AUTO_EXTRACT_PDF_BYTES)) {
                try {
                  pageCount = await inspectPdfPageCount(content.path)
                } catch (fallbackError) {
                  throw pdfImportParseError(fallbackError)
                }
              }
            }
          } else if (content.sizeBytes <= BigInt(MAX_AUTO_EXTRACT_PDF_BYTES)) {
            try {
              pageCount = await inspectPdfPageCount(content.path)
            } catch (error) {
              throw pdfImportParseError(error)
            }
          }
          combinedSignal.throwIfAborted()
          // Validate the published identity again after parsing, not only the mutable staging path.
          if ((await this.options.content.verify(content.id)).state !== 'available') {
            throw new Error('[pdf-invalid] PDF content changed during import.')
          }
          combinedSignal.throwIfAborted()
          publish({
            phase: 'saving',
            pagesProcessed: pageCount ?? 0,
            pageCount: pageCount ?? 0,
            importedCount: 0,
            unsupportedCount: nativeAnnotations?.unsupportedCount ?? 0
          })
          const attachedContent = await this.options.catalog.attachContent({
            itemId: request.itemId,
            contentBlobId: content.id,
            filename,
            contentType: 'application/pdf',
            sizeBytes: Number(content.sizeBytes),
            checksum: content.checksum,
            pageCount
          })
          attached = true
          if (nativeAnnotations) {
            importedCount = await this.importNativeAnnotations(
              {
                attachmentId: attachedContent.attachmentId,
                versionId: attachedContent.versionId,
                filename,
                checksum: content.checksum
              },
              nativeAnnotations
            )
            publish({
              phase: importedCount === undefined ? 'failed' : 'completed',
              pagesProcessed: nativeAnnotations.pageCount,
              pageCount: nativeAnnotations.pageCount,
              importedCount: importedCount ?? 0,
              unsupportedCount: nativeAnnotations.unsupportedCount,
              truncated: nativeAnnotations.truncated
            })
          } else if (this.options.annotations) {
            publish({
              phase: 'failed',
              pagesProcessed: pageCount ?? 0,
              pageCount: pageCount ?? 0,
              importedCount: 0,
              unsupportedCount: 0
            })
          }
          const item: LiteratureItemView | undefined = await this.options.catalog.get(
            request.itemId
          )
          if (!item) throw new Error('Literature Item is unavailable after importing its PDF.')
          return {
            item,
            ...(nativeAnnotations && importedCount !== undefined
              ? {
                  nativeAnnotations: {
                    importedCount: importedCount ?? 0,
                    unsupportedCount: nativeAnnotations.unsupportedCount,
                    truncated: nativeAnnotations.truncated
                  }
                }
              : {})
          }
        }
      )
    } catch (error) {
      if (combinedSignal.aborted) {
        publish({
          phase: 'cancelled',
          pagesProcessed: 0,
          pageCount: 0,
          importedCount: 0,
          unsupportedCount: 0
        })
      }
      throw error
    } finally {
      if (publishedId && !attached) {
        await this.options.content
          .sweep({ contentIds: [publishedId], createdBefore: new Date(Date.now() + 1) })
          .catch(() => undefined)
      }
      await this.options.uploads.deleteUpload({ path: attachment.path }).catch(() => undefined)
      this.activeImports.delete(operationId)
    }
  }

  private async importNativeAnnotations(
    input: {
      attachmentId: string
      versionId: string
      filename: string
      checksum: string
    },
    parsed: NativePdfAnnotationImportResult
  ): Promise<number | undefined> {
    if (!this.options.annotations) return 0
    try {
      const source = {
        kind: 'literature-attachment-version' as const,
        sourceFileId: input.attachmentId,
        versionId: input.versionId,
        checksum: input.checksum,
        name: input.filename,
        path: createLiteratureAttachmentVersionReference(input.versionId)
      }
      const requests: CreatePdfAnnotationRequest[] = parsed.annotations.map((annotation) => ({
        id: `native:${createHash('sha256').update(input.versionId).digest('hex').slice(0, 32)}:${annotation.stableKey}`,
        literatureVersionId: input.versionId,
        kind: annotation.kind,
        color: annotation.color,
        origin: 'imported',
        externalSubtype: annotation.subtype,
        tagIds: [],
        note: annotation.note,
        target: { source, selector: annotation.selector }
      }))
      return await this.options.annotations.createMany(requests, {
        scope: { literatureVersionId: input.versionId },
        source,
        result: nativeImportReceipt(parsed)
      })
    } catch {
      // Native note extraction is enrichment. A malformed or unsupported native annotation
      // must never make the PDF itself unavailable after its immutable version was attached.
      return undefined
    }
  }
}

export { LiteraturePdfImporter }
export type { LiteraturePdfImporterOptions }
