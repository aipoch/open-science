import { createHash } from 'node:crypto'
import type {
  LiteratureFullTextIndex,
  LiteratureIndex,
  LiteratureIndexChunk
} from './full-text-index.js'
import type { DocumentReference, TextExtraction } from './ports.js'
export type ReadingOptions<Reference extends DocumentReference> = {
  index?: LiteratureIndex
  /** Resolve current authority first, then return a loader for verified bounded text. */
  authorize(reference: Reference): Promise<() => Promise<TextExtraction>>
  /** Stable identity for every extraction-affecting option owned by the caller. */
  extractionFingerprint?(reference: Reference): string
  log?(message: string, fields: Record<string, unknown>): void
  onIndexError?(error: unknown): void
}
export type ReadDocumentResult = {
  scope: 'full-document'
  document: {
    id: string
    name: string
    checksum: string
    pageCount: number
    extractionTruncated: boolean
  }
  passage: { pageStart: number; pageEnd: number; text: string }
  nextCursor: string | null
}
type RetrievedPassage = {
  documentId: string
  documentName: string
  pageStart: number
  pageEnd: number
  textStart: number
  textEnd: number
  sectionTitle?: string
  content: string
}
export type SearchDocumentsResult = {
  scope: 'relevant-passages'
  documents: { id: string; name: string; checksum: string; pageCount: number }[]
} & (
  | {
      retrievalMode: 'bm25'
      passages: (RetrievedPassage & { relevance: { bm25Rank: number; relativeScore: number } })[]
    }
  | {
      retrievalMode: 'fallback'
      passages: (RetrievedPassage & { relevance: { lexicalRank: number; lexicalScore: number } })[]
    }
)
const EXTRACTOR_FINGERPRINT = createHash('sha256')
  .update('literature-reading-provided-text-v1')
  .digest('hex')
const DOCUMENT_BATCH_CHARS = 16_000
const INDEX_CHUNK_CHARS = 5_000
const INDEX_CHUNK_OVERLAP_CHARS = 250
const SEARCH_RESULT_LIMIT = 8
const MAX_EXTRACTED_DOCUMENTS = 6
const MAX_EXTRACTED_CACHE_CHARS = 24 * 1024 * 1024
const PAGE_MARKER = /^--- Page (\d+) ---$/gm
const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

type ExtractedDocument = Readonly<{
  context: DocumentReference
  extractionId: string
  extractorFingerprint: string
  text: string
  pageCount: number
  truncated: boolean
}>
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

const encodeCursor = (documentId: string, extractionId: string, offset: number): string =>
  Buffer.from(JSON.stringify({ documentId, extractionId, offset })).toString('base64url')

const cursorOffset = (
  cursor: string | undefined,
  documentId: string,
  extractionId: string
): number => {
  if (!cursor) return 0
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new Error(
      'Literature read cursor is invalid. Restart read_document for the intended documentId without cursor; continue with the returned nextCursor.'
    )
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      'Literature read cursor is invalid. Restart read_document for the intended documentId without cursor; continue with the returned nextCursor.'
    )
  }
  const {
    documentId: cursorDocumentId,
    extractionId: cursorExtractionId,
    offset
  } = value as Record<string, unknown>
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(
      'Literature read cursor is invalid. Restart read_document for the intended documentId without cursor; continue with the returned nextCursor.'
    )
  }
  if (cursorDocumentId !== documentId || cursorExtractionId !== extractionId)
    throw new Error(
      'Literature read cursor is invalid. Restart read_document for the intended documentId without cursor; continue with the returned nextCursor.'
    )
  return offset
}

export class LiteratureReader<Reference extends DocumentReference = DocumentReference> {
  private readonly extracted = new Map<string, Promise<TextExtraction>>()
  private readonly extractedChars = new Map<string, number>()
  private readonly indexBuilds = new Map<string, Promise<void>>()

  constructor(private readonly options: ReadingOptions<Reference>) {}
  async readDocument(reference: Reference, cursor?: string): Promise<ReadDocumentResult> {
    return this.readBatch(await this.resolveDocument(reference), cursor)
  }
  async searchDocuments(
    references: readonly Reference[],
    query: string
  ): Promise<SearchDocumentsResult> {
    return this.search(
      await Promise.all(references.map((reference) => this.resolveDocument(reference))),
      query
    )
  }
  async classificationEvidence(
    reference: Reference,
    query: string
  ): Promise<{
    coverage: 'full-text' | 'passages'
    passages: { pageStart: number; pageEnd: number; content: string }[]
  }> {
    const document = await this.resolveDocument(reference)
    const chunks = indexChunks(document.text)
    const complete =
      Buffer.byteLength(JSON.stringify(chunks), 'utf8') <= 32000 && chunks.length <= 8
    const candidates = complete ? chunks : (await this.search([document], query)).passages
    const passages: { pageStart: number; pageEnd: number; content: string }[] = []
    let bytes = 0
    for (const { pageStart, pageEnd, content } of candidates) {
      const next = Buffer.byteLength(content, 'utf8')
      if (bytes + next > 32000 || passages.length >= 8) continue
      passages.push({ pageStart, pageEnd, content })
      bytes += next
    }
    return { coverage: complete ? 'full-text' : 'passages', passages }
  }

  private async resolveDocument(context: Reference): Promise<ExtractedDocument> {
    // Authority is rechecked even on a cache hit; a checksum is not an access grant.
    const extract = await this.options.authorize(context)
    const extractorFingerprint =
      this.options.extractionFingerprint?.(context) ?? EXTRACTOR_FINGERPRINT
    const extractionId = createHash('sha256')
      .update(`${context.checksum}:${extractorFingerprint}`)
      .digest('hex')
    const cached = this.extracted.get(extractionId)
    const extraction = cached ?? extract()
    if (cached) this.extracted.delete(extractionId)
    this.extracted.set(extractionId, extraction)
    this.trimExtractedCache()
    try {
      const resolved = await extraction
      if (this.extracted.get(extractionId) === extraction) {
        this.extractedChars.set(extractionId, resolved.text.length)
        this.trimExtractedCache()
      }
      return { context, extractionId, extractorFingerprint, ...resolved }
    } catch (error) {
      if (this.extracted.get(extractionId) === extraction) {
        this.extracted.delete(extractionId)
        this.extractedChars.delete(extractionId)
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

  private readBatch(document: ExtractedDocument, cursor: string | undefined): ReadDocumentResult {
    const offset = cursorOffset(cursor, document.context.bindingId, document.extractionId)
    if (offset > document.text.length)
      throw new Error(
        'Literature read cursor is out of range. Restart read_document for the intended documentId without cursor; continue with the returned nextCursor.'
      )
    const end = Math.min(document.text.length, offset + DOCUMENT_BATCH_CHARS)
    const content = document.text.slice(offset, end)
    const pages = pageRangeForOffsets(document.text, offset, end)
    const nextCursor =
      end < document.text.length
        ? encodeCursor(document.context.bindingId, document.extractionId, end)
        : null
    this.options.log?.('Literature document batch read', {
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

  private async search(
    documents: readonly ExtractedDocument[],
    query: string
  ): Promise<SearchDocumentsResult> {
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
      const extractionId = document.extractionId
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
    const fallbackResponse = (
      reason: 'empty-bm25' | 'bm25-error' | 'cjk-query' | 'no-index'
    ): SearchDocumentsResult => {
      const passages = fallbackSearch(descriptors, query)
      this.options.log?.('Literature retrieval completed', {
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
    // unicode61 cannot match concepts embedded in unsegmented CJK sentences. Route the
    // entire query through lexical retrieval even when an English term would match FTS.
    if (CJK_CHARACTER.test(query)) return fallbackResponse('cjk-query')
    if (!this.options.index) return fallbackResponse('no-index')
    let index: LiteratureFullTextIndex | undefined
    try {
      index = await this.options.index.open()
      for (const descriptor of descriptors) await this.ensureIndexed(index, descriptor)
      const passages = await index.search({
        extractionIds: descriptors.map(({ extractionId }) => extractionId),
        query,
        limit: SEARCH_RESULT_LIMIT
      })
      if (passages.length === 0) return fallbackResponse('empty-bm25')
      this.options.log?.('Literature retrieval completed', {
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
      this.options.onIndexError?.(error)
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
        extractorFingerprint: descriptor.document.extractorFingerprint,
        chunks: descriptor.chunks
      })
      this.options.log?.('Literature index prepared', {
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
