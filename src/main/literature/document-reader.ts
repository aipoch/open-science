import { createHash } from 'node:crypto'

import { resolveActiveConversationMessages } from '../../shared/conversation-graph'
import type {
  MessagePdfContextSnapshot,
  PersistedChatSession,
  SessionPdfBinding
} from '../../shared/session-persistence'
import type { NotebookRunInputFile } from '../../shared/notebook'
import type { ImmutableInputAuthority } from '../immutable-input-authority'
import { createLogger, errorLogFields } from '../logger'
import type { SessionCatalog } from '../session-persistence/coordinator'
import { extractPdfText } from '../uploads/attachment-media'
import { LiteratureFullTextIndex, type LiteratureIndexChunk } from './full-text-index'
import type { LiteratureReadDocumentRequest } from './mcp-server'

const log = createLogger('literature-reading-context')
const EXTRACTOR_FINGERPRINT = createHash('sha256')
  .update('open-science-pdfjs-selectable-text-v1')
  .digest('hex')
const DOCUMENT_BATCH_CHARS = 16_000
const INDEX_CHUNK_CHARS = 5_000
const INDEX_CHUNK_OVERLAP_CHARS = 250
const SEARCH_RESULT_LIMIT = 8
const MAX_EXTRACTED_DOCUMENTS = 6
const MAX_EXTRACTED_CACHE_CHARS = 24 * 1024 * 1024
const PAGE_MARKER = /^--- Page (\d+) ---$/gm
const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

type LiteratureDocumentReaderOptions = Readonly<{
  storageRoot: string
  inputs: Pick<ImmutableInputAuthority, 'resolveVersion'> & {
    openContent?: ImmutableInputAuthority['openContent']
    // Test-only compatibility for fixtures that predate immutable read leases.
    resolveContent?: (input: NotebookRunInputFile) => Promise<string>
  }
  sessions: Pick<SessionCatalog, 'loadSessionForContinuation'>
}>

type ReadCurrentLiteratureRequest = Readonly<{
  projectId: string
  sessionId: string
  promptMessageId: string
  input: LiteratureReadDocumentRequest
}>

type ExtractedDocument = Readonly<{
  context: SessionPdfBinding
  text: string
  pageCount: number
  truncated: boolean
}>

const activeMessages = (session: PersistedChatSession): PersistedChatSession['messages'] =>
  session.conversationGraph
    ? resolveActiveConversationMessages(session.conversationGraph)
    : session.messages

const pageSections = (text: string): Array<{ page: number; text: string; start: number }> => {
  const markers = [...text.matchAll(PAGE_MARKER)]
  if (markers.length === 0) return [{ page: 1, text, start: 0 }]
  return markers.map((marker, index) => {
    const start = marker.index
    const end = markers[index + 1]?.index ?? text.length
    return { page: Number(marker[1]), text: text.slice(start, end).trim(), start }
  })
}

const pageRangeForOffsets = (
  text: string,
  start: number,
  end: number
): Readonly<{ pageStart: number; pageEnd: number }> => {
  const sections = pageSections(text)
  const pageAt = (offset: number): number => {
    for (let index = sections.length - 1; index >= 0; index -= 1) {
      const section = sections[index]
      if (section && section.start <= offset) return section.page
    }
    return sections[0]?.page ?? 1
  }
  return {
    pageStart: pageAt(start),
    pageEnd: pageAt(Math.max(start, end - 1))
  }
}

const indexChunks = (text: string): LiteratureIndexChunk[] =>
  pageSections(text).flatMap(({ page, text: pageText, start }) => {
    const chunks: LiteratureIndexChunk[] = []
    for (
      let offset = 0;
      offset < pageText.length;
      offset += INDEX_CHUNK_CHARS - INDEX_CHUNK_OVERLAP_CHARS
    ) {
      const rawContent = pageText.slice(offset, offset + INDEX_CHUNK_CHARS)
      const content = rawContent.trim()
      if (!content) continue
      const leadingWhitespace = rawContent.length - rawContent.trimStart().length
      const textStart = start + offset + leadingWhitespace
      chunks.push({
        pageStart: page,
        pageEnd: page,
        textStart,
        textEnd: textStart + content.length,
        content
      })
    }
    return chunks
  })

const fallbackSearch = (
  descriptors: ReadonlyArray<Readonly<{ extractionId: string; chunks: LiteratureIndexChunk[] }>>,
  query: string
): Array<
  LiteratureIndexChunk &
    Readonly<{ extractionId: string; lexicalScore: number; lexicalRank: number }>
> => {
  const terms = (query.match(/[\p{L}\p{N}_]+/gu) ?? [])
    .flatMap((term) => {
      const normalized = term.toLocaleLowerCase()
      if (!CJK_CHARACTER.test(normalized)) return [normalized]
      const characters = [...normalized]
      if (characters.length < 2) return characters
      return characters
        .slice(0, -1)
        .map((character, index) => `${character}${characters[index + 1]}`)
    })
    .slice(0, 16)
  if (terms.length === 0) return []
  return descriptors
    .flatMap(({ extractionId, chunks }) =>
      chunks.map((chunk) => {
        const content = chunk.content.toLocaleLowerCase()
        return {
          ...chunk,
          extractionId,
          lexicalScore: terms.reduce((score, term) => score + (content.includes(term) ? 1 : 0), 0)
        }
      })
    )
    .filter(({ lexicalScore }) => lexicalScore > 0)
    .sort(
      (left, right) => right.lexicalScore - left.lexicalScore || left.textStart - right.textStart
    )
    .slice(0, SEARCH_RESULT_LIMIT)
    .map((passage, index) => ({ ...passage, lexicalRank: index + 1 }))
}

const encodeCursor = (documentId: string, offset: number): string =>
  Buffer.from(JSON.stringify({ documentId, offset })).toString('base64url')

const cursorOffset = (cursor: string | undefined, documentId: string): number => {
  if (!cursor) return 0
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new Error('Literature read cursor is invalid.')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Literature read cursor is invalid.')
  }
  const { documentId: cursorDocumentId, offset } = value as Record<string, unknown>
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Literature read cursor is invalid.')
  }
  if (cursorDocumentId !== documentId) throw new Error('Literature read cursor is invalid.')
  return offset
}

class LiteratureDocumentReader {
  private readonly extracted = new Map<string, Promise<Omit<ExtractedDocument, 'context'>>>()
  private readonly extractedChars = new Map<string, number>()
  private readonly indexBuilds = new Map<string, Promise<void>>()

  constructor(private readonly options: LiteratureDocumentReaderOptions) {}

  async readCurrent(request: ReadCurrentLiteratureRequest): Promise<unknown> {
    const context = await this.resolveCurrentContext(request)
    if (request.input.query) {
      const bindings = this.selectSearchBindings(context, request.input.documentIds)
      return this.search(
        await Promise.all(
          bindings.map((binding) => this.resolveDocument(request.projectId, binding))
        ),
        request.input.query
      )
    }
    const binding = this.selectSequentialBinding(context, request.input.documentId)
    return this.readBatch(
      await this.resolveDocument(request.projectId, binding),
      request.input.cursor
    )
  }

  private async resolveCurrentContext(
    request: ReadCurrentLiteratureRequest
  ): Promise<MessagePdfContextSnapshot> {
    const session = await this.options.sessions.loadSessionForContinuation(
      request.projectId,
      request.sessionId
    )
    const message = activeMessages(session).find(({ id }) => id === request.promptMessageId)
    const context = message?.role === 'user' ? message.pdfContext : undefined
    if (!context) {
      throw new Error(
        'NO_LINKED_PDF_CONTEXT: The current message has no linked PDF context snapshot.'
      )
    }
    return context
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

  private async resolveDocument(
    projectId: string,
    context: SessionPdfBinding
  ): Promise<ExtractedDocument> {
    const input = await this.options.inputs.resolveVersion({
      projectId,
      sourceKind: context.sourceKind,
      inputFileVersionId: context.sourceVersionId,
      expectedSourceFileId: context.sourceFileId
    })
    if (!input || input.checksum !== context.checksum) {
      throw new Error('LINKED_PDF_UNAVAILABLE: The immutable linked PDF Version is unavailable.')
    }
    const cached = this.extracted.get(context.checksum)
    const extraction = cached ?? this.extract(input)
    if (cached) this.extracted.delete(context.checksum)
    this.extracted.set(context.checksum, extraction)
    this.trimExtractedCache()
    try {
      const resolved = await extraction
      if (this.extracted.get(context.checksum) === extraction) {
        this.extractedChars.set(context.checksum, resolved.text.length)
        this.trimExtractedCache()
      }
      return { context, ...resolved }
    } catch (error) {
      if (this.extracted.get(context.checksum) === extraction) {
        this.extracted.delete(context.checksum)
        this.extractedChars.delete(context.checksum)
      }
      throw error
    }
  }

  private trimExtractedCache(): void {
    let cachedChars = [...this.extractedChars.values()].reduce((total, chars) => total + chars, 0)
    while (
      this.extracted.size > 1 &&
      (this.extracted.size > MAX_EXTRACTED_DOCUMENTS || cachedChars > MAX_EXTRACTED_CACHE_CHARS)
    ) {
      const oldest = this.extracted.keys().next().value
      if (oldest === undefined) break
      this.extracted.delete(oldest)
      cachedChars -= this.extractedChars.get(oldest) ?? 0
      this.extractedChars.delete(oldest)
    }
  }

  private async extract(input: NotebookRunInputFile): Promise<Omit<ExtractedDocument, 'context'>> {
    let extraction
    if (this.options.inputs.openContent) {
      const lease = await this.options.inputs.openContent(input)
      try {
        extraction = await extractPdfText(lease.path, undefined, {
          maxChars: MAX_EXTRACTED_CACHE_CHARS
        })
        await lease.verifyUnchanged()
      } finally {
        await lease.close()
      }
    } else {
      const path = await this.options.inputs.resolveContent?.(input)
      if (!path) throw new Error('Immutable input content reader is unavailable.')
      // Literature serves bounded batches and builds a local index, so it needs the complete
      // extracted text. The generic attachment route keeps its 1 MiB prompt-safety cap.
      extraction = await extractPdfText(path, undefined, {
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

  private readBatch(document: ExtractedDocument, cursor: string | undefined): unknown {
    const offset = cursorOffset(cursor, document.context.bindingId)
    if (offset > document.text.length) throw new Error('Literature read cursor is out of range.')
    const end = Math.min(document.text.length, offset + DOCUMENT_BATCH_CHARS)
    const content = document.text.slice(offset, end)
    const pages = pageRangeForOffsets(document.text, offset, end)
    const nextCursor =
      end < document.text.length ? encodeCursor(document.context.bindingId, end) : null
    log.info('Literature document batch read', {
      scope: 'full-document',
      pageCount: document.pageCount,
      returnedChars: content.length,
      nextCursorPresent: nextCursor !== null,
      fullDocumentReturned: nextCursor === null && offset === 0
    })
    return {
      scope: 'full-document',
      document: {
        id: document.context.bindingId,
        name: document.context.name,
        checksum: document.context.checksum,
        pageCount: document.pageCount,
        extractionTruncated: document.truncated
      },
      passage: {
        pageStart: pages.pageStart,
        pageEnd: pages.pageEnd,
        text: content
      },
      nextCursor
    }
  }

  private async search(documents: readonly ExtractedDocument[], query: string): Promise<unknown> {
    const byExtractionId = new Map<string, ExtractedDocument[]>()
    const descriptorByExtractionId = new Map<
      string,
      Readonly<{
        document: ExtractedDocument
        extractionId: string
        chunks: LiteratureIndexChunk[]
      }>
    >()
    for (const document of documents) {
      const extractionId = createHash('sha256')
        .update(`${document.context.checksum}:${EXTRACTOR_FINGERPRINT}`)
        .digest('hex')
      const associations = byExtractionId.get(extractionId) ?? []
      associations.push(document)
      byExtractionId.set(extractionId, associations)
      if (!descriptorByExtractionId.has(extractionId)) {
        descriptorByExtractionId.set(extractionId, {
          document,
          extractionId,
          chunks: indexChunks(document.text)
        })
      }
    }
    const descriptors = [...descriptorByExtractionId.values()]
    const fallbackResponse = (reason: 'empty-bm25' | 'bm25-error'): unknown => {
      const passages = fallbackSearch(descriptors, query)
      log.info('Literature retrieval completed', {
        retrievalMode: 'fallback',
        routingReason: reason,
        documentCount: documents.length,
        bm25Used: reason === 'empty-bm25',
        bm25ResultCount: reason === 'empty-bm25' ? 0 : null,
        fallbackResultCount: passages.length
      })
      return {
        scope: 'relevant-passages',
        retrievalMode: 'fallback',
        documents: documents.map((document) => ({
          id: document.context.bindingId,
          name: document.context.name,
          checksum: document.context.checksum,
          pageCount: document.pageCount
        })),
        passages: passages.flatMap((passage) => {
          const associatedDocuments = byExtractionId.get(passage.extractionId)
          if (!associatedDocuments) {
            throw new Error('Literature fallback returned an unknown document.')
          }
          return associatedDocuments.map((document) => ({
            documentId: document.context.bindingId,
            documentName: document.context.name,
            pageStart: passage.pageStart,
            pageEnd: passage.pageEnd,
            textStart: passage.textStart,
            textEnd: passage.textEnd,
            relevance: {
              lexicalRank: passage.lexicalRank,
              lexicalScore: passage.lexicalScore
            },
            ...(passage.sectionTitle ? { sectionTitle: passage.sectionTitle } : {}),
            content: passage.content
          }))
        })
      }
    }
    let index: LiteratureFullTextIndex | undefined
    try {
      index = await LiteratureFullTextIndex.open(this.options.storageRoot)
      for (const descriptor of descriptors) await this.ensureIndexed(index, descriptor)
      const passages = await index.search({
        extractionIds: descriptors.map(({ extractionId }) => extractionId),
        query,
        limit: SEARCH_RESULT_LIMIT
      })
      if (passages.length === 0) return fallbackResponse('empty-bm25')
      log.info('Literature retrieval completed', {
        retrievalMode: 'bm25',
        documentCount: documents.length,
        bm25Used: true,
        bm25ResultCount: passages.length
      })
      return {
        scope: 'relevant-passages',
        retrievalMode: 'bm25',
        documents: documents.map((document) => ({
          id: document.context.bindingId,
          name: document.context.name,
          checksum: document.context.checksum,
          pageCount: document.pageCount
        })),
        passages: passages.flatMap((passage) => {
          const associatedDocuments = byExtractionId.get(passage.extractionId)
          if (!associatedDocuments)
            throw new Error('Literature search returned an unknown document.')
          return associatedDocuments.map((document) => ({
            documentId: document.context.bindingId,
            documentName: document.context.name,
            pageStart: passage.pageStart,
            pageEnd: passage.pageEnd,
            textStart: passage.textStart,
            textEnd: passage.textEnd,
            relevance: {
              bm25Rank: passage.rank,
              relativeScore: passage.relativeScore
            },
            ...(passage.sectionTitle ? { sectionTitle: passage.sectionTitle } : {}),
            content: passage.content
          }))
        })
      }
    } catch (error) {
      log.warn('Literature BM25 search failed', errorLogFields(error))
      return fallbackResponse('bm25-error')
    } finally {
      await index?.close()
    }
  }

  private async ensureIndexed(
    index: LiteratureFullTextIndex,
    descriptor: Readonly<{
      document: ExtractedDocument
      extractionId: string
      chunks: LiteratureIndexChunk[]
    }>
  ): Promise<void> {
    const existing = this.indexBuilds.get(descriptor.extractionId)
    if (existing) return existing
    const build = (async () => {
      if (await index.hasExtraction(descriptor.extractionId)) return
      await index.replace({
        extractionId: descriptor.extractionId,
        documentChecksum: descriptor.document.context.checksum,
        extractorFingerprint: EXTRACTOR_FINGERPRINT,
        chunks: descriptor.chunks
      })
      log.info('Literature index prepared', {
        pageCount: descriptor.document.pageCount,
        indexedChunkCount: descriptor.chunks.length,
        chunkChars: INDEX_CHUNK_CHARS,
        chunkOverlapChars: INDEX_CHUNK_OVERLAP_CHARS
      })
    })()
    this.indexBuilds.set(descriptor.extractionId, build)
    try {
      await build
    } finally {
      if (this.indexBuilds.get(descriptor.extractionId) === build) {
        this.indexBuilds.delete(descriptor.extractionId)
      }
    }
  }
}

export { LiteratureDocumentReader }
export type { LiteratureDocumentReaderOptions, ReadCurrentLiteratureRequest }
