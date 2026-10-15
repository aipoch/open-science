import { createHash } from 'node:crypto'

import { createLogger, errorLogFields } from '@aipoch/diagnostics/node'
import { LiteratureReader } from '@aipoch/literature-reading'
import {
  sanitizeMessagePdfContextSnapshot,
  type MessagePdfContextSnapshot,
  type SessionPdfBinding
} from '../../shared/session-persistence'
import type { PdfProseRegion } from '../../shared/pdf-text'
import type { SessionCatalog } from '../session-persistence/coordinator'
import { extractPdfText, MAX_AUTO_EXTRACT_PDF_BYTES } from '../uploads/attachment-media'
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
  projectId: string
  proseRegions?: readonly PdfProseRegion[]
}

const canonicalProseRegions = (regions: readonly PdfProseRegion[]): readonly PdfProseRegion[] =>
  regions
    .map(({ page, left, top, right, bottom, split }) => ({ page, left, top, right, bottom, split }))
    .sort(
      (a, b) =>
        a.page - b.page ||
        a.top - b.top ||
        a.left - b.left ||
        a.bottom - b.bottom ||
        a.right - b.right ||
        a.split - b.split
    )

const readingMetadata = (proseRegions: readonly PdfProseRegion[] | undefined): object =>
  proseRegions ? { order: 'explicit-prose-regions', proseRegions } : { order: 'native' }

const bindingProseRegions = (
  regions: MessagePdfContextSnapshot['proseRegionsByBindingId'],
  bindingId: string
): readonly PdfProseRegion[] | undefined =>
  regions && Object.hasOwn(regions, bindingId) ? regions[bindingId] : undefined

class LiteratureDocumentReader {
  private readonly core: LiteratureReader<ReadingReference>
  constructor(private readonly options: LiteratureDocumentReaderOptions) {
    this.core = new LiteratureReader({
      index: literatureIndex(options.storageRoot),
      extractionFingerprint: (context) =>
        createHash('sha256')
          .update(
            context.proseRegions
              ? `open-science-pdfjs-verified-bytes-explicit-prose-regions-v2:${JSON.stringify(context.proseRegions)}`
              : 'open-science-pdfjs-verified-bytes-native-v4'
          )
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
        return () => this.extract(source, context.proseRegions)
      },
      log: (message, fields) => log.info(message, fields),
      onIndexError: (error) => log.warn('Literature BM25 search failed', errorLogFields(error))
    })
  }
  private reader(
    projectId: string,
    proseRegionsByBindingId?: MessagePdfContextSnapshot['proseRegionsByBindingId']
  ): Pick<
    LiteratureReader<SessionPdfBinding>,
    'readDocument' | 'searchDocuments' | 'classificationEvidence'
  > {
    return {
      readDocument: async (binding: SessionPdfBinding, cursor?: string) => {
        const proseRegions = bindingProseRegions(proseRegionsByBindingId, binding.bindingId)
        return {
          ...(await this.core.readDocument({ ...binding, projectId, proseRegions }, cursor)),
          reading: readingMetadata(proseRegions)
        }
      },
      searchDocuments: async (bindings: readonly SessionPdfBinding[], query: string) => ({
        ...(await this.core.searchDocuments(
          bindings.map((binding) => ({
            ...binding,
            projectId,
            proseRegions: bindingProseRegions(proseRegionsByBindingId, binding.bindingId)
          })),
          query
        )),
        reading:
          bindings.length === 1
            ? readingMetadata(bindingProseRegions(proseRegionsByBindingId, bindings[0]!.bindingId))
            : {
                order: 'per-document',
                documents: bindings.map(({ bindingId }) => ({
                  documentId: bindingId,
                  ...readingMetadata(bindingProseRegions(proseRegionsByBindingId, bindingId))
                }))
              }
      }),
      classificationEvidence: (binding: SessionPdfBinding, query: string) =>
        this.core.classificationEvidence({ ...binding, projectId }, query)
    }
  }
  async readCurrent(request: ReadCurrentLiteratureRequest): Promise<unknown> {
    const context = sanitizeMessagePdfContextSnapshot(
      await resolveCurrentPdfContext(this.options.sessions, request)
    )
    if (!context) {
      throw new Error('PDF_READING_REGION_INVALID: The linked PDF snapshot is invalid.')
    }
    const regionsByBindingId = Object.fromEntries(
      Object.entries(context.proseRegionsByBindingId ?? {}).map(([id, regions]) => [
        id,
        canonicalProseRegions(regions)
      ])
    )
    if (request.input.query) {
      const bindings = this.selectSearchBindings(context, request.input.documentIds)
      return this.reader(request.projectId, regionsByBindingId).searchDocuments(
        bindings,
        request.input.query
      )
    }
    const binding = this.selectSequentialBinding(context, request.input.documentId)
    return this.reader(request.projectId, regionsByBindingId).readDocument(
      binding,
      request.input.cursor
    )
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
    proseRegions?: readonly PdfProseRegion[]
  ): Promise<{ text: string; pageCount: number; truncated: boolean }> {
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
          { maxChars: MAX_EXTRACTED_CACHE_CHARS, ...(proseRegions ? { proseRegions } : {}) }
        )
        await lease.verifyUnchanged()
      } finally {
        await lease.close()
      }
    } else {
      // Literature serves bounded batches and builds a local index, so it needs the complete
      // extracted text. The generic attachment route keeps its 1 MiB prompt-safety cap.
      extraction = await extractPdfText(input.path, undefined, {
        maxChars: MAX_EXTRACTED_CACHE_CHARS,
        ...(proseRegions ? { proseRegions } : {})
      })
    }
    if (extraction.truncated) {
      throw new Error(
        `PDF_TEXT_LIMIT_EXCEEDED: Extracted PDF text exceeds the ${MAX_EXTRACTED_CACHE_CHARS}-character Literature limit.`
      )
    }
    if (!extraction.text) {
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
