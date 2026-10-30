import { createHash } from 'node:crypto'

import { createLogger, errorLogFields } from '@aipoch/diagnostics/node'
import { LiteratureReader, type TextExtraction } from '@aipoch/literature-reading'
import {
  sanitizeMessagePdfContextSnapshot,
  type MessagePdfContextSnapshot,
  type SessionPdfBinding
} from '../../shared/session-persistence'
import { createPdfOcrSession } from '../uploads/pdf-ocr'
import type { LocalModelOwner } from '../local-models/owner'
import type { SessionCatalog } from '../session-persistence/coordinator'
import { MAX_AUTO_EXTRACT_PDF_BYTES } from '../uploads/attachment-media'
import { extractPdfText } from '../uploads/pdf-text-extraction'
import { literatureIndex } from './full-text-index'
import type { LiteratureReadDocumentRequest } from './mcp-server'
import { resolveCurrentPdfContext } from './pdf-context'
import type {
  ResolvedSessionPdfVersion,
  SessionPdfSourceResolver
} from './session-pdf-source-resolver'

const log = createLogger('literature-reading-context')
const MAX_EXTRACTED_CACHE_CHARS = 24 * 1024 * 1024
type LiteratureDocumentReaderOptions = Readonly<{
  storageRoot: string
  ocrModels?: Pick<LocalModelOwner, 'acquireUse' | 'getSnapshot'>
  sources: Pick<SessionPdfSourceResolver, 'resolveVersion'>
  sessions: Pick<SessionCatalog, 'loadSessionForContinuation'>
}>

type ReadCurrentLiteratureRequest = Readonly<{
  projectId: string
  sessionId: string
  promptMessageId: string
  input: LiteratureReadDocumentRequest
}>

type SearchLiteratureAttachmentRequest = Readonly<{
  projectId: string
  attachmentId: string
  attachmentVersionId: string
  filename: string
  sizeBytes: number
  checksum: string
  query: string
}>

type ReadingReference = SessionPdfBinding & {
  ocrRevision?: string
  projectId: string
}

class LiteratureDocumentReader {
  private readonly ocrSessions = new Set<ReturnType<typeof createPdfOcrSession>>()
  private closed = false
  private readonly core: LiteratureReader<ReadingReference>
  constructor(private readonly options: LiteratureDocumentReaderOptions) {
    this.core = new LiteratureReader({
      index: literatureIndex(options.storageRoot),
      extractionFingerprint: (context) =>
        createHash('sha256')
          .update('open-science-pdfjs-automatic-reading-order-ocr-v1')
          .update(options.ocrModels ? `:optional-ocr-v1:${context.ocrRevision ?? 'none'}` : '')
          .digest('hex'),
      authorize: async (context) => {
        const source = await options.sources.resolveVersion({
          projectId: context.projectId,
          sourceKind: context.sourceKind,
          sourceVersionId: context.sourceVersionId,
          expectedSourceFileId: context.sourceFileId
        })
        if (!source || source.checksum !== context.checksum)
          throw new Error(
            'LINKED_PDF_UNAVAILABLE: The immutable linked PDF Version is unavailable.'
          )
        return () => this.extract(source, context.ocrRevision)
      },
      log: (message, fields) => log.info(message, fields),
      onIndexError: (error) => log.warn('Literature BM25 search failed', errorLogFields(error))
    })
  }
  async close(): Promise<void> {
    this.closed = true
    await Promise.all([...this.ocrSessions].map((session) => session.close()))
  }
  private async reference(
    binding: SessionPdfBinding,
    projectId: string
  ): Promise<ReadingReference> {
    const snapshot = await this.options.ocrModels?.getSnapshot()
    return {
      ...binding,
      projectId,
      ocrRevision: snapshot?.availability === 'ready' ? snapshot.installedRevision : undefined
    }
  }
  private reader(
    projectId: string
  ): Pick<
    LiteratureReader<SessionPdfBinding>,
    'readDocument' | 'searchDocuments' | 'classificationEvidence'
  > {
    return {
      readDocument: async (binding, cursor) => ({
        ...(await this.core.readDocument(await this.reference(binding, projectId), cursor)),
        reading: { order: 'automatic' }
      }),
      searchDocuments: async (bindings, query) => ({
        ...(await this.core.searchDocuments(
          await Promise.all(bindings.map((binding) => this.reference(binding, projectId))),
          query
        )),
        reading: { order: 'automatic' }
      }),
      classificationEvidence: async (binding, query) =>
        this.core.classificationEvidence(await this.reference(binding, projectId), query)
    }
  }
  async readCurrent(request: ReadCurrentLiteratureRequest): Promise<unknown> {
    const context = sanitizeMessagePdfContextSnapshot({
      ...(await resolveCurrentPdfContext(this.options.sessions, request)),
      proseRegionsByBindingId: undefined
    })
    if (!context) {
      throw new Error('PDF_READING_REGION_INVALID: The linked PDF snapshot is invalid.')
    }
    if (request.input.query) {
      const bindings = this.selectSearchBindings(context, request.input.documentIds)
      return this.reader(request.projectId).searchDocuments(bindings, request.input.query)
    }
    const binding = this.selectSequentialBinding(context, request.input.documentId)
    return this.reader(request.projectId).readDocument(binding, request.input.cursor)
  }

  async searchAttachment(request: SearchLiteratureAttachmentRequest): Promise<unknown> {
    if (request.sizeBytes > MAX_AUTO_EXTRACT_PDF_BYTES) {
      throw new Error(
        `PDF_SIZE_LIMIT_EXCEEDED: PDF source is ${request.sizeBytes} bytes, exceeding the automatic extraction limit.`
      )
    }
    const binding: SessionPdfBinding = {
      version: 1,
      bindingId: request.attachmentVersionId,
      sourceKind: 'literature-attachment-version',
      sourceFileId: request.attachmentId,
      sourceVersionId: request.attachmentVersionId,
      name: request.filename,
      mimeType: 'application/pdf',
      sizeBytes: request.sizeBytes,
      checksum: request.checksum,
      linkedAt: 0
    }
    return this.reader(request.projectId).searchDocuments([binding], request.query)
  }

  async classificationEvidence(
    request: Omit<SearchLiteratureAttachmentRequest, 'projectId'>
  ): Promise<{
    coverage: 'full-text' | 'passages' | 'unavailable'
    passages: { pageStart: number; pageEnd: number; content: string }[]
  }> {
    if (request.sizeBytes > MAX_AUTO_EXTRACT_PDF_BYTES)
      return { coverage: 'unavailable', passages: [] }
    try {
      return await this.reader('').classificationEvidence(
        {
          version: 1,
          bindingId: request.attachmentVersionId,
          sourceKind: 'literature-attachment-version',
          sourceFileId: request.attachmentId,
          sourceVersionId: request.attachmentVersionId,
          name: request.filename,
          mimeType: 'application/pdf',
          sizeBytes: request.sizeBytes,
          checksum: request.checksum,
          linkedAt: 0
        },
        request.query
      )
    } catch (error) {
      // Screening can persist deterministic evidence gaps; failed reads must remain retryable.
      if (
        error instanceof Error &&
        /^(PDF_TEXT_UNAVAILABLE|PDF_PAGE_COUNT_UNSUPPORTED|PDF_SIZE_LIMIT_EXCEEDED|PDF_TEXT_LIMIT_EXCEEDED)(?::|$)/.test(
          error.message
        )
      ) {
        return { coverage: 'unavailable', passages: [] }
      }
      throw error
    }
  }

  private selectSearchBindings(
    context: MessagePdfContextSnapshot,
    documentIds: readonly string[] | undefined
  ): readonly SessionPdfBinding[] {
    if (!documentIds) return context.bindings
    if (new Set(documentIds).size !== documentIds.length) {
      throw new Error('Literature document selection contains duplicates.')
    }
    return documentIds.map((documentId) => {
      const binding = context.bindings.find(({ bindingId }) => bindingId === documentId)
      if (!binding) throw new Error('Literature document selection is not linked to this message.')
      return binding
    })
  }

  private selectSequentialBinding(
    context: MessagePdfContextSnapshot,
    documentId: string | undefined
  ): SessionPdfBinding {
    const selectedId = documentId ?? context.activeBindingId ?? context.bindings[0]?.bindingId
    const binding = context.bindings.find(({ bindingId }) => bindingId === selectedId)
    if (!binding) throw new Error('Literature document selection is not linked to this message.')
    return binding
  }

  private async extract(
    input: ResolvedSessionPdfVersion,
    ocrRevision?: string
  ): Promise<TextExtraction> {
    if (this.closed) throw new Error('Literature reader is closed.')
    const ocrOptions = this.options.ocrModels
      ? {
          createOcrSession: () => {
            const models = this.options.ocrModels!
            const session = createPdfOcrSession(
              ocrRevision
                ? {
                    acquireUse: async () => {
                      const lease = await models.acquireUse()
                      if (lease.revision !== ocrRevision || this.closed) {
                        lease.release()
                        throw new Error('PDF_MODEL_CHANGED: Retry with the current OCR component.')
                      }
                      return lease
                    }
                  }
                : undefined
            )
            this.ocrSessions.add(session)
            return {
              recognize: session.recognize,
              close: async () => {
                await session.close()
                this.ocrSessions.delete(session)
              }
            }
          }
        }
      : {}
    let extraction
    if (input.openContent) {
      const lease = await input.openContent()
      try {
        extraction = await extractPdfText(
          lease.path,
          {
            size: lease.size,
            readBytes: async () => {
              const bytes = await lease.readRange(0, lease.size)
              // Validate the exact buffer PDF.js will consume, including replace-and-restore races.
              if (
                bytes.byteLength !== input.sizeBytes ||
                createHash('sha256').update(bytes).digest('hex') !== input.checksum
              ) {
                throw new Error(
                  'LINKED_PDF_UNAVAILABLE: PDF bytes do not match the immutable Version.'
                )
              }
              return bytes
            }
          },
          { ocr: true, ...ocrOptions, maxChars: MAX_EXTRACTED_CACHE_CHARS }
        )
        await lease.verifyUnchanged()
      } finally {
        await lease.close()
      }
    } else {
      // Literature serves bounded batches and builds a local index, so it needs the complete
      // extracted text. The generic attachment route keeps its 1 MiB prompt-safety cap.
      extraction = await extractPdfText(input.path, undefined, {
        ocr: true,
        ...ocrOptions,
        maxChars: MAX_EXTRACTED_CACHE_CHARS
      })
    }
    if (extraction.truncated) {
      throw new Error(
        `PDF_TEXT_LIMIT_EXCEEDED: Extracted PDF text exceeds the ${MAX_EXTRACTED_CACHE_CHARS}-character Literature limit.`
      )
    }
    if (!extraction.text && !extraction.coverage) {
      throw new Error('PDF_TEXT_UNAVAILABLE: The linked PDF has no selectable text.')
    }
    if (extraction.pageCount <= 1) {
      throw new Error('PDF_PAGE_COUNT_UNSUPPORTED: Linked literature must have multiple pages.')
    }
    log.info('Literature PDF extraction ready', {
      sourceKind: input.sourceKind,
      pageCount: extraction.pageCount,
      extractedChars: extraction.text.length,
      extractorTruncated: extraction.truncated
    })
    return extraction
  }
}
export { LiteratureDocumentReader }
export type {
  LiteratureDocumentReaderOptions,
  ReadCurrentLiteratureRequest,
  SearchLiteratureAttachmentRequest
}
