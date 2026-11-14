import { createHash } from 'node:crypto'
import type {
  LiteratureFullTextIndex,
  LiteratureIndex,
  LiteratureIndexChunk
} from './full-text-index.js'
import type { DocumentReference, TextExtraction, PdfTextCoverage, PageTextLayout } from './ports.js'

type LayoutEvidence = {
  /** Full-page source units; top-left coordinates, bounds=[left,top,right,bottom]. */
  pageLayouts?: readonly PageTextLayout[]
  /** Relevant pages whose complete geometry did not fit or could not be established. */
  layoutOmittedPages?: readonly number[]
}
export type ReadingOptions<Reference extends DocumentReference> = {
  index?: LiteratureIndex
  /** Resolve current authority first, then return a loader for verified bounded text. */
  authorize(reference: Reference): Promise<() => Promise<TextExtraction>>
  /** Cache admission must only read authoritative metadata, without opening source bytes. */
  authorizeCached?(reference: Reference, signal?: AbortSignal): Promise<void>
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
    coverage?: PdfTextCoverage
    extractionWarnings?: readonly string[]
  }
  passage: { pageStart: number; pageEnd: number; text: string } & LayoutEvidence
  nextCursor: string | null
}
/** Trusted physical page ranges, clipped to a returned text window; UTF-16 offsets are absolute. */
export type PassagePageSpan = Readonly<{ page: number; textStart: number; textEnd: number }>
type RetrievedPassage = {
  documentId: string
  documentName: string
  pageStart: number
  pageEnd: number
  textStart: number
  textEnd: number
  sectionTitle?: string
  pageSpans?: readonly PassagePageSpan[]
  /** Adjacent original bytes, with page locations from physical extraction boundaries. */
  precedingText?: {
    content: string
    pageStart: number
    pageEnd: number
    textStart: number
    textEnd: number
    pageSpans?: readonly PassagePageSpan[]
  }
  content: string
}
export type SearchDocumentsResult = {
  scope: 'relevant-passages'
  documents: ({
    id: string
    name: string
    checksum: string
    pageCount: number
    coverage?: PdfTextCoverage
    extractionWarnings?: readonly string[]
  } & LayoutEvidence)[]
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
export type CachedTextSearchResult = {
  status: 'available' | 'unavailable'
  retrievalMode: 'bm25'
  coverage: {
    requestedDocuments: number
    cachedDocuments: number
    notCachedDocuments: number
    unavailableDocuments: number
  }
  passages: RetrievedPassage[]
  truncated: boolean
}
const EXTRACTOR_FINGERPRINT = createHash('sha256')
  .update('literature-reading-provided-text-v2')
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
  coverage?: PdfTextCoverage
  pageStarts?: TextExtraction['pageStarts']
  warnings?: readonly string[]
  pageLayouts?: readonly PageTextLayout[]
  layoutOmittedPages?: readonly number[]
}>

// Keep the native text/index offsets intact. Geometry is additional evidence, not a new order.
// Whole pages fit or are explicitly omitted; never imply that a partial page is complete.
const layoutEvidence = (
  document: ExtractedDocument,
  ranges: readonly Readonly<{ pageStart: number; pageEnd: number }>[]
): LayoutEvidence => {
  const relevant = (page: number): boolean =>
    ranges.some((range) => page >= range.pageStart && page <= range.pageEnd)
  const pageLayouts: PageTextLayout[] = []
  const omitted = new Set(document.layoutOmittedPages?.filter(relevant))
  let chars = 2
  const prioritized = (document.pageLayouts ?? [])
    .map((page) => ({
      page,
      priority: ranges.findIndex(
        (range) => page.page >= range.pageStart && page.page <= range.pageEnd
      )
    }))
    .filter(({ priority }) => priority >= 0)
    .sort((a, b) => a.priority - b.priority || a.page.page - b.page.page)
  for (const { page } of prioritized) {
    const size = JSON.stringify(page).length + Number(pageLayouts.length > 0)
    if (chars + size > DOCUMENT_BATCH_CHARS) omitted.add(page.page)
    else {
      pageLayouts.push(page)
      chars += size
    }
  }
  return {
    ...(pageLayouts.length ? { pageLayouts } : {}),
    ...(omitted.size ? { layoutOmittedPages: [...omitted].sort((a, b) => a - b) } : {})
  }
}
const pageSections = (
  text: string,
  pageStarts?: TextExtraction['pageStarts']
): Array<{ page: number; text: string; start: number }> => {
  if (pageStarts?.length)
    return pageStarts.map(({ page, offset }, index) => ({
      page,
      start: offset,
      text: text.slice(offset, pageStarts[index + 1]?.offset ?? text.length).trim()
    }))
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
  end: number,
  pageStarts?: TextExtraction['pageStarts']
): Readonly<{ pageStart: number; pageEnd: number }> => {
  const sections = pageSections(text, pageStarts)
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

// Only extractor-owned boundaries can certify per-page spans. A legacy marker-derived range
// remains useful to existing display consumers but cannot certify multi-page citation attribution.
const physicalPageSpans = (
  document: ExtractedDocument,
  start: number,
  end: number
): readonly PassagePageSpan[] | undefined => {
  if (!document.pageStarts?.length || end <= start) return undefined
  const spans = document.pageStarts.flatMap(({ page, offset }, index) => {
    const textStart = Math.max(start, offset)
    const textEnd = Math.min(end, document.pageStarts![index + 1]?.offset ?? document.text.length)
    return textEnd > textStart ? [{ page, textStart, textEnd }] : []
  })
  // Keep provenance bounded along with the 800-character adjoining source window.
  return spans.length > 0 && spans.length <= 64 ? spans : undefined
}

const precedingText = (
  document: ExtractedDocument,
  end: number
): RetrievedPassage['precedingText'] => {
  if (end <= 0) return undefined
  let start = Math.max(0, end - 800)
  while (start > 0 && start < end && !/\s/u.test(document.text[start - 1]!)) start += 1
  if (start === end) return undefined
  const pageSpans = physicalPageSpans(document, start, end)
  return {
    content: document.text.slice(start, end),
    ...pageRangeForOffsets(document.text, start, end, document.pageStarts),
    textStart: start,
    textEnd: end,
    ...(pageSpans ? { pageSpans } : {})
  }
}

const indexChunks = (
  text: string,
  pageStarts?: TextExtraction['pageStarts']
): LiteratureIndexChunk[] =>
  pageSections(text, pageStarts).flatMap(({ page, text: pageText, start }) => {
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
  private readonly extracted = new Map<
    string,
    { result: Promise<TextExtraction>; incomplete: boolean }
  >()
  private readonly extractedChars = new Map<string, number>()
  private readonly indexBuilds = new Map<string, Promise<void>>()

  constructor(private readonly options: ReadingOptions<Reference>) {}
  async readDocument(reference: Reference, cursor?: string): Promise<ReadDocumentResult> {
    return this.readBatch(await this.resolveDocument(reference, cursor === undefined), cursor)
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

  /** Discover only already indexed evidence; authority never implies extraction permission. */
  async searchCachedDocuments(
    references: readonly Reference[],
    query: string,
    limit = SEARCH_RESULT_LIMIT,
    signal?: AbortSignal
  ): Promise<CachedTextSearchResult> {
    signal?.throwIfAborted()
    const coverage = {
      requestedDocuments: references.length,
      cachedDocuments: 0,
      notCachedDocuments: 0,
      unavailableDocuments: 0
    }
    const response: CachedTextSearchResult = {
      status: 'unavailable',
      retrievalMode: 'bm25',
      coverage,
      passages: [],
      truncated: references.length > 100
    }
    const authorized: { reference: Reference; fingerprint: string; baseId: string }[] = []
    for (const reference of references.slice(0, 100)) {
      signal?.throwIfAborted()
      try {
        // Do not invoke the returned loader, even when no index is present.
        if (this.options.authorizeCached) await this.options.authorizeCached(reference, signal)
        else await this.options.authorize(reference)
        signal?.throwIfAborted()
        const fingerprint = this.options.extractionFingerprint?.(reference) ?? EXTRACTOR_FINGERPRINT
        const baseId = createHash('sha256')
          .update(`${reference.checksum}:${fingerprint}`)
          .digest('hex')
        authorized.push({ reference, fingerprint, baseId })
      } catch (error) {
        signal?.throwIfAborted()
        if (error instanceof Error && error.name === 'AbortError') throw error
        coverage.unavailableDocuments += 1
      }
    }
    coverage.unavailableDocuments += Math.max(0, references.length - 100)
    let index: LiteratureFullTextIndex | undefined
    try {
      index = await this.options.index?.openExisting()
      signal?.throwIfAborted()
      if (!index) {
        coverage.unavailableDocuments += authorized.length
        return response
      }
      response.status = 'available'
      const byExtractionId = new Map<string, Reference[]>()
      for (const { reference, fingerprint, baseId } of authorized) {
        signal?.throwIfAborted()
        const extractionId =
          (await index.findExtraction(reference.checksum, fingerprint)) ??
          ((await index.hasExtraction(baseId)) ? baseId : undefined)
        signal?.throwIfAborted()
        if (!extractionId) {
          coverage.notCachedDocuments += 1
          continue
        }
        coverage.cachedDocuments += 1
        const associated = byExtractionId.get(extractionId) ?? []
        associated.push(reference)
        byExtractionId.set(extractionId, associated)
      }
      const resultLimit = Number.isFinite(limit)
        ? Math.min(Math.max(Math.floor(limit), 1), 20)
        : SEARCH_RESULT_LIMIT
      const passages = await index.search({
        extractionIds: [...byExtractionId.keys()],
        query,
        limit: Math.min(resultLimit + 1, 20),
        signal
      })
      signal?.throwIfAborted()
      const associatedPassages = passages.flatMap((passage) =>
        (byExtractionId.get(passage.extractionId) ?? []).map((reference) => ({
          documentId: reference.bindingId,
          documentName: reference.name,
          pageStart: passage.pageStart,
          pageEnd: passage.pageEnd,
          textStart: passage.textStart,
          textEnd: passage.textEnd,
          ...(passage.sectionTitle ? { sectionTitle: passage.sectionTitle } : {}),
          content: passage.content
        }))
      )
      response.passages = associatedPassages.slice(0, resultLimit)
      response.truncated ||= associatedPassages.length > resultLimit
      return response
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof Error && error.name === 'AbortError') throw error
      this.options.onIndexError?.(error)
      coverage.cachedDocuments = 0
      coverage.notCachedDocuments = 0
      coverage.unavailableDocuments = references.length
      return { ...response, status: 'unavailable', passages: [] }
    } finally {
      await index?.close()
    }
  }
  async classificationEvidence(
    reference: Reference,
    query: string
  ): Promise<{
    coverage: 'full-text' | 'passages' | 'unavailable'
    passages: { pageStart: number; pageEnd: number; content: string }[]
  }> {
    const document = await this.resolveDocument(reference, true)
    if (!document.text.trim()) return { coverage: 'unavailable', passages: [] }
    const chunks = indexChunks(document.text, document.pageStarts)
    const complete =
      !document.truncated &&
      (!document.coverage ||
        (new Set([...document.coverage.textPages, ...document.coverage.ocrPages]).size ===
          document.pageCount &&
          [...document.coverage.textPages, ...document.coverage.ocrPages].every(
            (page) => Number.isSafeInteger(page) && page >= 1 && page <= document.pageCount
          ))) &&
      (document.coverage?.unavailablePages.length ?? 0) === 0 &&
      (document.coverage?.uncheckedPages.length ?? 0) === 0 &&
      (document.coverage?.unverifiedPages?.length ?? 0) === 0 &&
      Buffer.byteLength(JSON.stringify(chunks), 'utf8') <= 32000 &&
      chunks.length <= 8
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

  private async resolveDocument(
    context: Reference,
    retryIncomplete = false
  ): Promise<ExtractedDocument> {
    // Authority is rechecked even on a cache hit; a checksum is not an access grant.
    const extract = await this.options.authorize(context)
    const extractorFingerprint =
      this.options.extractionFingerprint?.(context) ?? EXTRACTOR_FINGERPRINT
    const extractionId = createHash('sha256')
      .update(`${context.checksum}:${extractorFingerprint}`)
      .digest('hex')
    const cached = this.extracted.get(extractionId)
    const entry =
      cached && !(retryIncomplete && cached.incomplete)
        ? cached
        : { result: extract(), incomplete: false }
    const extraction = entry.result
    if (cached) this.extracted.delete(extractionId)
    this.extracted.set(extractionId, entry)
    this.trimExtractedCache()
    try {
      const resolved = await extraction
      // These offsets come from the extractor, never from page-like strings in document data.
      if (
        resolved.pageStarts &&
        ((resolved.text.length > 0 && resolved.pageStarts.length === 0) ||
          resolved.pageStarts.some(
            ({ page, offset }, index, starts) =>
              !Number.isSafeInteger(page) ||
              page <= 0 ||
              page > resolved.pageCount ||
              !Number.isSafeInteger(offset) ||
              offset < 0 ||
              offset >= resolved.text.length ||
              (index === 0
                ? offset !== 0
                : offset <= starts[index - 1].offset || page <= starts[index - 1].page)
          ))
      )
        throw new Error('Literature extraction contains invalid physical page boundaries.')
      if (this.extracted.get(extractionId) === entry) {
        this.extractedChars.set(
          extractionId,
          resolved.text.length +
            JSON.stringify(resolved.pageLayouts ?? []).length +
            JSON.stringify(resolved.pageStarts ?? []).length
        )
        this.trimExtractedCache()
      }
      entry.incomplete =
        !!resolved.coverage &&
        (resolved.coverage.unavailablePages.length > 0 ||
          resolved.coverage.uncheckedPages.length > 0)
      // OCR retries can recover pages. Bind cursors and index rows to the actual extracted bytes
      // so an earlier partial index can never stand in for recovered text.
      const resultId = resolved.coverage
        ? createHash('sha256').update(extractionId).update(resolved.text).digest('hex')
        : extractionId
      return { context, extractionId: resultId, extractorFingerprint, ...resolved }
    } catch (error) {
      if (this.extracted.get(extractionId) === entry) {
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
    let end = Math.min(document.text.length, offset + DOCUMENT_BATCH_CHARS)
    // When complete geometry fits on its own, continue at that page instead of
    // silently losing it to the preceding batch's budget. Text offsets stay native.
    if (document.pageLayouts?.length) {
      const layouts = new Map(document.pageLayouts.map((page) => [page.page, page]))
      let chars = 2
      const sections = pageSections(document.text, document.pageStarts)
      for (const [index, section] of sections.entries()) {
        if (section.start >= end) break
        const layout = layouts.get(section.page)
        const sectionEnd = sections[index + 1]?.start ?? document.text.length
        if (!layout || sectionEnd <= offset) continue
        const size = JSON.stringify(layout).length + 1
        if (size > DOCUMENT_BATCH_CHARS) continue
        if (chars + size > DOCUMENT_BATCH_CHARS && section.start > offset) {
          end = section.start
          break
        }
        chars += size
      }
    }
    const content = document.text.slice(offset, end)
    const pages = pageRangeForOffsets(document.text, offset, end, document.pageStarts)
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
        extractionTruncated: document.truncated,
        ...(document.coverage ? { coverage: document.coverage } : {}),
        ...(document.warnings?.length ? { extractionWarnings: document.warnings } : {})
      },
      passage: {
        pageStart: pages.pageStart,
        pageEnd: pages.pageEnd,
        text: content,
        ...layoutEvidence(document, [pages])
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
          chunks: indexChunks(document.text, document.pageStarts)
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
          pageCount: document.pageCount,
          ...(document.coverage ? { coverage: document.coverage } : {}),
          ...(document.warnings?.length ? { extractionWarnings: document.warnings } : {}),
          ...layoutEvidence(
            document,
            passages.filter((passage) => passage.extractionId === document.extractionId)
          )
        })),
        passages: passages.flatMap((passage) => {
          const associatedDocuments = byExtractionId.get(passage.extractionId)
          if (!associatedDocuments) {
            throw new Error('Literature fallback returned an unknown document.')
          }
          return associatedDocuments.map((document) => {
            const pageSpans =
              document.text.slice(passage.textStart, passage.textEnd) === passage.content
                ? physicalPageSpans(document, passage.textStart, passage.textEnd)
                : undefined
            return {
              documentId: document.context.bindingId,
              documentName: document.context.name,
              pageStart: passage.pageStart,
              pageEnd: passage.pageEnd,
              textStart: passage.textStart,
              textEnd: passage.textEnd,
              ...(pageSpans ? { pageSpans } : {}),
              precedingText: precedingText(document, passage.textStart),
              relevance: {
                lexicalRank: passage.lexicalRank,
                lexicalScore: passage.lexicalScore
              },
              ...(passage.sectionTitle ? { sectionTitle: passage.sectionTitle } : {}),
              content: passage.content
            }
          })
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
          pageCount: document.pageCount,
          ...(document.coverage ? { coverage: document.coverage } : {}),
          ...(document.warnings?.length ? { extractionWarnings: document.warnings } : {}),
          ...layoutEvidence(
            document,
            passages.filter((passage) => passage.extractionId === document.extractionId)
          )
        })),
        passages: passages.flatMap((passage) => {
          const associatedDocuments = byExtractionId.get(passage.extractionId)
          if (!associatedDocuments)
            throw new Error('Literature search returned an unknown document.')
          return associatedDocuments.map((document) => {
            const pageSpans =
              document.text.slice(passage.textStart, passage.textEnd) === passage.content
                ? physicalPageSpans(document, passage.textStart, passage.textEnd)
                : undefined
            return {
              documentId: document.context.bindingId,
              documentName: document.context.name,
              pageStart: passage.pageStart,
              pageEnd: passage.pageEnd,
              textStart: passage.textStart,
              textEnd: passage.textEnd,
              ...(pageSpans ? { pageSpans } : {}),
              precedingText: precedingText(document, passage.textStart),
              relevance: {
                bm25Rank: passage.rank,
                relativeScore: passage.relativeScore
              },
              ...(passage.sectionTitle ? { sectionTitle: passage.sectionTitle } : {}),
              content: passage.content
            }
          })
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
