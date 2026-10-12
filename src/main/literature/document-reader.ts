import { createHash } from 'node:crypto'

import { createLogger, errorLogFields } from '@aipoch/diagnostics/node'
import { LiteratureReader } from '@aipoch/literature-reading'
import type { MessagePdfContextSnapshot, SessionPdfBinding } from '../../shared/session-persistence'
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

class LiteratureDocumentReader {
  private readonly core: LiteratureReader<SessionPdfBinding & { projectId: string }>
  constructor(private readonly options: LiteratureDocumentReaderOptions) {
    this.core = new LiteratureReader({
      index: literatureIndex(options.storageRoot),
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
        return () => this.extract(source)
      },
      log: (message, fields) => log.info(message, fields),
      onIndexError: (error) => log.warn('Literature BM25 search failed', errorLogFields(error))
    })
  }
  private reader(
    projectId: string
  ): Pick<
    LiteratureReader<SessionPdfBinding>,
    'readDocument' | 'searchDocuments' | 'classificationEvidence'
  > {
    return {
      readDocument: (binding: SessionPdfBinding, cursor?: string) =>
        this.core.readDocument({ ...binding, projectId }, cursor),
      searchDocuments: (bindings: readonly SessionPdfBinding[], query: string) =>
        this.core.searchDocuments(
          bindings.map((binding) => ({ ...binding, projectId })),
          query
        ),
      classificationEvidence: (binding: SessionPdfBinding, query: string) =>
        this.core.classificationEvidence({ ...binding, projectId }, query)
    }
  }
  async readCurrent(request: ReadCurrentLiteratureRequest): Promise<unknown> {
    const context = await resolveCurrentPdfContext(this.options.sessions, request)
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
    coverage: 'full-text' | 'passages'
    passages: { pageStart: number; pageEnd: number; content: string }[]
  }> {
    if (request.sizeBytes > MAX_AUTO_EXTRACT_PDF_BYTES) throw new Error('PDF_SIZE_LIMIT_EXCEEDED')
    return this.reader('').classificationEvidence(
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
    input: ResolvedSessionPdfVersion
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
          { maxChars: MAX_EXTRACTED_CACHE_CHARS }
        )
        await lease.verifyUnchanged()
      } finally {
        await lease.close()
      }
    } else {
      // Literature serves bounded batches and builds a local index, so it needs the complete
      // extracted text. The generic attachment route keeps its 1 MiB prompt-safety cap.
      extraction = await extractPdfText(input.path, undefined, {
        maxChars: MAX_EXTRACTED_CACHE_CHARS
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
