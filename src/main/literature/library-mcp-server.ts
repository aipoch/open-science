import type { CachedTextSearchResult, PassagePageSpan } from '@aipoch/literature-reading'
import { randomBytes } from 'node:crypto'
import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { installToolErrorRecovery, TOOL_ARGUMENT_RECOVERY } from '../../shared/tool-error-recovery'
import { z } from 'zod'
import { withDataRootWrite } from '../storage/migration-state'
import type { LiteratureLibraryDiscovery } from './discovery-contract'
import { literatureDiscoverySchema } from './discovery-contract'
export { literatureDiscoverySchema } from './discovery-contract'

import {
  LITERATURE_CITATION_LOCALES,
  LITERATURE_CITATION_STYLES,
  type LiteratureCitationLocale,
  type LiteratureCitationStyle
} from '@aipoch/literature-citations/contracts'
import { type LiteratureItemView } from '@aipoch/literature-library/contracts'
import {
  summarizeLiteratureSaveReceipts,
  type LiteratureLibrarySaveResult
} from '../../shared/literature-save'
import type { AgentPdfAcquisitionResult } from './agent-pdf-acquisition'
import { literatureReadPresentation } from './mcp-server'
import {
  collectLiteratureSourceCitationHrefs,
  createLiteratureSourceCitationHref,
  type LiteratureSourceCitation
} from '../../shared/literature-source-citation'

const LITERATURE_LIBRARY_MCP_SERVER_NAME = 'open-science-library'
const LITERATURE_LIBRARY_SEARCH_TOOL_NAME = 'search_library'
const LITERATURE_LIBRARY_SEARCH_FULL_TEXT_TOOL_NAME = 'search_library_full_text'
const LITERATURE_LIBRARY_READ_ABSTRACT_TOOL_NAME = 'read_library_abstract'
const LITERATURE_LIBRARY_READ_PDF_TOOL_NAME = 'read_library_pdf'
const LITERATURE_LIBRARY_FORMAT_REFERENCES_TOOL_NAME = 'format_references'
const LITERATURE_LIBRARY_FORMAT_DOCUMENT_TOOL_NAME = 'format_citation_document'
const LITERATURE_LIBRARY_PREPARE_LATEX_TOOL_NAME = 'prepare_latex_bundle'
const LITERATURE_LIBRARY_SAVE_TOOL_NAME = 'save_to_inbox'
const LITERATURE_SAVE_ARGUMENT_RECOVERY = `${TOOL_ARGUMENT_RECOVERY} Reuse retrieved metadata rather than re-extracting PDFs or troubleshooting runtimes to fix argument formatting.`
const LITERATURE_LIBRARY_SEARCH_DEFAULT_LIMIT = 20
const LITERATURE_LIBRARY_SEARCH_OUTPUT_MAX_CHARACTERS = 38_000
const LITERATURE_LIBRARY_SEARCH_ABSTRACT_MAX_CHARACTERS = 1_200
const LITERATURE_LIBRARY_SEARCH_ABSTRACT_MIN_CHARACTERS = 200
const LITERATURE_LIBRARY_BATCH_ABSTRACT_LIMIT = 5
const LITERATURE_LIBRARY_BATCH_ABSTRACT_MAX_CHARACTERS = 5_000
const LITERATURE_LIBRARY_SOURCE_CITATION_MAX_CHARACTERS = 8_000
export const LITERATURE_LIBRARY_SCOPES = ['library', 'project', 'collection', 'items'] as const
export const LITERATURE_LIBRARY_READ_SCOPES = ['library', 'project', 'collection', 'items'] as const

type LiteratureLibraryScope = (typeof LITERATURE_LIBRARY_SCOPES)[number]

const argumentError = (code: string, message: string): Error =>
  new Error(`${code}: ${message} ${TOOL_ARGUMENT_RECOVERY}`)

const scopeDescription =
  'project (default): records linked to the current Project. library: the whole Library, only when the user asks for it. collection: requires collectionId. items: only records explicitly selected in the active question; reads name their itemId directly.'

const itemNotFound = (): Error =>
  new Error(
    'LITERATURE_ITEM_NOT_FOUND: No record with this itemId exists in this scope. Use an itemId returned by search_library with the same scope and collectionId as that search; do not guess itemIds.'
  )

// Rejects scope combinations that the JSON schema cannot express.
const assertCollectionScope = (scope: LiteratureLibraryScope, collectionId?: string): void => {
  if (scope === 'collection' && !collectionId)
    throw argumentError('COLLECTION_ID_REQUIRED', 'scope "collection" requires collectionId.')
  if (scope !== 'collection' && collectionId)
    throw argumentError('COLLECTION_SCOPE_REQUIRED', 'collectionId requires scope "collection".')
}

const literatureDiscoveryBatchSchema = z
  .object({ candidates: z.array(literatureDiscoverySchema).min(1).max(10) })
  .strict()

type LiteratureLibrarySearchRequest = Readonly<{
  query?: string
  scope?: LiteratureLibraryScope
  collectionId?: string
  itemIds?: readonly string[]
  offset?: number
  limit?: number
}>

type LiteratureLibrarySaveRequest = Readonly<{
  candidates: readonly LiteratureLibraryDiscovery[]
  signal?: AbortSignal
}>

type LiteratureLibrarySearchResult = Readonly<{
  items: readonly LiteratureItemView[]
  totalCount: number
  nextOffset?: number
  hasMore: boolean
}>

type LiteratureLibraryFullTextSearchRequest = Readonly<{
  query: string
  scope?: LiteratureLibraryScope
  collectionId?: string
  itemIds?: readonly string[]
  limit?: number
  offset?: number
  signal?: AbortSignal
}>

type LiteratureLibraryFullTextSearchResult = Readonly<{
  scope: LiteratureLibraryScope
  query: string
  status: CachedTextSearchResult['status']
  retrievalMode: 'bm25'
  coverageKind: 'cached-text-only'
  fullTextCoverage: 'unverified'
  coverage: CachedTextSearchResult['coverage']
  recordCount: number
  totalRecordCount: number
  nextOffset?: number
  sourceSelectionTruncated: boolean
  resultsRevalidated: boolean
  incomplete: boolean
  limitations: readonly (
    | 'cached-pages-unverified'
    | 'more-records'
    | 'source-limit'
    | 'not-cached'
    | 'unavailable-sources'
    | 'unavailable-reader'
    | 'stale-results'
    | 'result-limit'
  )[]
  scannedSources: number
  matches: readonly {
    itemId: string
    title: string
    attachmentId: string
    attachmentVersionId: string
    pageStart: number
    pageEnd: number
    content: string
    contentTruncated: boolean
  }[]
  truncated: boolean
}>

type LiteratureLibraryReadAbstractRequest = Readonly<{
  itemId: string
  scope?: LiteratureLibraryScope
  collectionId?: string
}>

type LiteratureLibraryReadAbstractResult = Readonly<{
  itemId: string
  metadataRevision: number
  title: string
  abstract: string
}>

type LiteratureLibraryBatchReadAbstractResult = Readonly<{
  items: readonly (LiteratureLibraryReadAbstractResult &
    Readonly<{
      abstractLength: number
      abstractTruncated?: true
      sourceCitation?: LiteratureSourceCitation & { href: string }
    }>)[]
  missingItemIds: readonly string[]
  citations?: readonly (LiteratureSourceCitation & { href: string })[]
}>

type LiteratureLibraryReadPdfRequest = Readonly<{
  itemId: string
  attachmentId?: string
  query: string
  scope?: LiteratureLibraryScope
  collectionId?: string
}>

type LiteratureLibraryReadPdfResult = Readonly<{
  itemTitle: string
  evidence: Record<string, unknown>
}>

type LiteratureLibrarySearchOutputItem = Readonly<{
  id: string
  metadataRevision: number
  itemType: LiteratureItemView['item']['itemType']
  title: string
  authors: string
  /** All contributors, including editors and translators. authors contains only authors. */
  creatorCount: number
  issuedText: string
  issuedYear?: number
  containerTitle: string
  abstractPreview: string
  abstractLength: number
  primaryIdentifiers: readonly Readonly<{
    scheme: LiteratureItemView['item']['identifiers'][number]['scheme']
    value: string
  }>[]
  hasPdf: boolean
  attachmentCount: number
  citationHref?: string
  abstractTruncated?: true
}>

type LiteratureLibrarySearchOutputResult = Omit<LiteratureLibrarySearchResult, 'items'> &
  Readonly<{ items: readonly LiteratureLibrarySearchOutputItem[] }>

type LiteratureLibraryFormatDocumentRequest = Readonly<{
  filename: string
  styleId: LiteratureCitationStyle
  locale: LiteratureCitationLocale
}>

type LiteratureLibraryFormatDocumentResult = Readonly<{
  filename: string
  citationCount: number
  referenceCount: number
}>

type LiteratureLibraryFormatReferencesRequest = Readonly<{
  itemIds: readonly string[]
  styleId: LiteratureCitationStyle
  locale: LiteratureCitationLocale
}>

type LiteratureLibraryFormatReferencesResult = Readonly<{
  references: readonly Readonly<{ itemId: string; reference: string; inText: string }>[]
}>

type LiteratureLibraryPrepareLatexRequest = Readonly<{
  filename: string
}>

type LiteratureLibraryPrepareLatexResult = Readonly<{
  filename: string
  citationCount: number
  referenceCount: number
}>

type LiteratureLibraryMcpHandler = Readonly<{
  acquirePdf?: (request: {
    candidate: LiteratureLibraryDiscovery
    pdfUrl?: string
    signal?: AbortSignal
  }) => Promise<AgentPdfAcquisitionResult>
  searchLibrary: (request: LiteratureLibrarySearchRequest) => Promise<LiteratureLibrarySearchResult>
  searchLibraryFullText?: (
    request: LiteratureLibraryFullTextSearchRequest
  ) => Promise<LiteratureLibraryFullTextSearchResult>
  readAbstract: (
    request: LiteratureLibraryReadAbstractRequest
  ) => Promise<LiteratureLibraryReadAbstractResult | undefined>
  readPdf: (
    request: LiteratureLibraryReadPdfRequest
  ) => Promise<LiteratureLibraryReadPdfResult | undefined>
  resolveSaveReferences?: (
    references: readonly string[],
    signal?: AbortSignal
  ) => Promise<readonly LiteratureLibraryDiscovery[]>
  readCandidateFile?: (filename: string, signal?: AbortSignal) => Promise<string>
  formatReferences?: (
    request: LiteratureLibraryFormatReferencesRequest
  ) => Promise<LiteratureLibraryFormatReferencesResult>
  formatCitationDocument?: (
    request: LiteratureLibraryFormatDocumentRequest
  ) => Promise<LiteratureLibraryFormatDocumentResult>
  prepareLatexBundle?: (
    request: LiteratureLibraryPrepareLatexRequest
  ) => Promise<LiteratureLibraryPrepareLatexResult>
  saveToInbox: (request: LiteratureLibrarySaveRequest) => Promise<LiteratureLibrarySaveResult>
}>

type LiteratureLibraryPresentation = Readonly<{
  libraryAction: 'format' | 'read' | 'search' | 'save'
  libraryScope?: LiteratureLibraryScope
  itemTitles?: readonly string[]
  resultCount?: number
  totalCount?: number
  offset?: number
  limit?: number
  nextOffset?: number
  candidateCount?: number
  savedCount?: number
  hasMore?: boolean
  documentNames?: readonly string[]
  passageCount?: number
  pageStart?: number
  pageEnd?: number
  retrievalMode?: 'bm25' | 'fallback'
}>

const presentationText = (
  presentation: LiteratureLibraryPresentation,
  sourceCitationHrefs: readonly string[]
): string =>
  JSON.stringify({
    openScienceLiteraturePresentation: {
      ...presentation,
      ...(sourceCitationHrefs.length > 0 ? { sourceCitationHrefs } : {})
    }
  })

const presentationContent = (
  presentation: LiteratureLibraryPresentation,
  result?: {
    sourceCitation?: LiteratureLibrarySourceCitation
    citations?: readonly LiteratureLibrarySourceCitation[]
    items?: readonly { citationHref?: string; sourceCitation?: LiteratureLibrarySourceCitation }[]
  }
): { type: 'text'; text: string } => {
  const sourceCitationHrefs = collectLiteratureSourceCitationHrefs([
    result?.sourceCitation && sourceCitationReceipt(result.sourceCitation),
    ...(result?.items?.flatMap((item) => [
      item.citationHref,
      item.sourceCitation && sourceCitationReceipt(item.sourceCitation)
    ]) ?? []),
    ...(result?.citations?.map(sourceCitationReceipt) ?? [])
  ])
  const text = (): string => presentationText(presentation, sourceCitationHrefs)
  while (sourceCitationHrefs.length > 0 && text().length > 8_000) sourceCitationHrefs.pop()
  return { type: 'text', text: text() }
}

const compactText = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`

const sentenceEnd = /[.!?。！？]["'”’）)\]]*$/u
const sentenceAbbreviation =
  /(?:\b(?:fig|figs|eq|eqs|ref|refs|dr|mr|mrs|prof|vs|cf|al)|\b[A-Z])\.$/iu
const cjkText = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const quoteStopWords = new Set(
  'a an and are as at be been by can could did do does for from had has have how in into is it of on or that the their these this to was were what when where which who why will with would'.split(
    ' '
  )
)

// Normalize whitespace only: the selected quote must still match the extracted source.
// Segmenting raw PDF lines can detach a claim from its preceding negation.
const sourceQuote = (
  content: string,
  query = '',
  pdf = false,
  adjacentStart = false,
  minimumEnd = 0
):
  | { quote: string; context?: string; score: number; start: number; proximity?: number }
  | undefined => {
  const terms = [
    ...new Set(
      (query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
        (term) => !quoteStopWords.has(term)
      )
    )
  ]
  const sentences: { quote: string; context?: string; start: number }[] = []
  const normalizedSource = content.replace(/\s+/gu, ' ').trim()
  let paragraphOffset = 0
  let knownStart = !pdf || adjacentStart
  for (const paragraph of content.split(/\r?\n[\t ]*\r?\n/u)) {
    const originalParagraph = paragraph.replace(/\s+/gu, ' ').trim()
    const paragraphStart = normalizedSource.indexOf(originalParagraph, paragraphOffset)
    paragraphOffset = paragraphStart + originalParagraph.length
    // Captions/table rows can interrupt an unfinished PDF sentence. Their
    // punctuation must not turn that preceding fragment into quoted prose.
    let prose = paragraph
    if (pdf) {
      for (const marker of paragraph.matchAll(
        /(?:^|\n)[\t ]*(?:Fig(?:ure)?\.?|Table)\s+S?\d+\b/gu
      )) {
        const prefix = paragraph.slice(0, marker.index)
        const closing = paragraph.slice(marker.index + marker[0].length).trimStart()[0]
        const opening = closing === ')' ? '(' : closing === ']' ? '[' : undefined
        // A wrapped "(Supplementary\nTable S2)" remains an inline reference.
        // An unrelated unclosed bracket cannot exempt an actual caption.
        const balance = opening
          ? [...prefix].reduce(
              (depth, character) =>
                depth + (character === opening ? 1 : character === closing ? -1 : 0),
              0
            )
          : 0
        if (balance > 0) continue
        prose = prefix
        break
      }
    }
    const normalized = prose.replace(/\s+/gu, ' ').trim()
    if (!normalized) {
      if (prose !== paragraph) knownStart = false
      continue
    }
    // Attached reference numbers can hide a real boundary from ICU ("methods.22 The").
    // Mask them only for segmentation, preserving offsets into the original text.
    const boundaries = normalized.replace(
      /([\p{L})\]])([.!?])(\d+(?:[,–-]\d+)*)(?=\s+\p{Lu})/gu,
      (_match, before: string, punctuation: string, reference: string) =>
        before + punctuation + ' '.repeat(reference.length)
    )
    let pendingStart: number | undefined
    for (const { segment, index } of new Intl.Segmenter(undefined, {
      granularity: 'sentence'
    }).segment(boundaries)) {
      pendingStart ??= index
      const sentence = normalized.slice(pendingStart, index + segment.trimEnd().length).trim()
      // ICU treats e.g. "Fig. S1)." and "vs. 2.5 mg" as separate sentences.
      // Keep those pieces together, including unmatched parentheses/brackets.
      const unclosed =
        (sentence.match(/\(/gu)?.length ?? 0) > (sentence.match(/\)/gu)?.length ?? 0) ||
        (sentence.match(/\[/gu)?.length ?? 0) > (sentence.match(/\]/gu)?.length ?? 0)
      if (sentenceAbbreviation.test(sentence) || unclosed) continue
      const complete = sentenceEnd.test(sentence)
      const words = sentence.match(/[\p{L}\p{N}]+/gu) ?? []
      const fragment =
        words.length < 3 ||
        /^(?:\[\d+\]|\d+[.,)])\s/u.test(sentence) ||
        // A bibliography author list is not prose; an inline "et al." can be.
        /^(?:[A-Z]\.\s*)?[\p{L}’'-]+,\s*(?:[A-Z]\.\s*)+et al\./u.test(sentence) ||
        /(?:\b[A-Z]\.\s*){2,}/u.test(sentence)
      if (
        knownStart &&
        complete &&
        sentence.length <= 1_600 &&
        // CJK prose need not contain spaces between words.
        (!fragment ||
          /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
            sentence
          ))
      ) {
        const quoteStart = normalized.indexOf(sentence, pendingStart)
        const contextStart = Math.max(
          0,
          Math.min(quoteStart - Math.floor((600 - sentence.length) / 2), normalized.length - 600)
        )
        const context = normalized.slice(contextStart, contextStart + 600).trim()
        sentences.push({
          quote: sentence,
          start: paragraphStart + quoteStart,
          ...(sentence.length <= 600 && context !== sentence ? { context } : {})
        })
      }
      knownStart = complete
      pendingStart = undefined
    }
    // A new paragraph is not proof that the previous sentence ended. Never join
    // paragraphs to manufacture a complete sentence or discard a qualifier.
    if (pendingStart !== undefined || prose !== paragraph) knownStart = false
  }
  const score = (sentence: string): number => {
    const lower = sentence.toLocaleLowerCase()
    const words = new Set(lower.match(/[\p{L}\p{N}]+/gu) ?? [])
    // CJK prose commonly has no spaces, so its query term can be part of one token.
    return terms.reduce(
      (total, term) =>
        total + (words.has(term) || (cjkText.test(term) && lower.includes(term)) ? 1 : 0),
      0
    )
  }
  return sentences
    .filter(({ start, quote }) => start + quote.length > minimumEnd)
    .map((sentence): (typeof sentences)[number] & { score: number; proximity?: number } => ({
      ...sentence,
      ...{ score: score(sentence.quote) }
    }))
    .filter(({ score }) => !query.trim() || (terms.length > 0 && score > 0))
    .sort((left, right) => right.score - left.score || 0)[0]
}

type CitationPassage = {
  content: string
  pageStart?: unknown
  pageEnd?: unknown
  textStart?: unknown
  textEnd?: unknown
  pageSpans?: unknown
}

// These ranges come from extraction metadata, never from marker-like document text. Validate
// the complete window before using any range so malformed provenance cannot certify a quote.
const citationPageSpans = (passage: CitationPassage): PassagePageSpan[] => {
  const { pageStart, pageEnd = pageStart, textStart, textEnd, pageSpans } = passage
  if (
    typeof pageStart !== 'number' ||
    !Number.isSafeInteger(pageStart) ||
    pageStart <= 0 ||
    typeof pageEnd !== 'number' ||
    !Number.isSafeInteger(pageEnd) ||
    pageEnd < pageStart
  )
    return []
  const positioned = textStart !== undefined || textEnd !== undefined
  if (
    positioned &&
    (typeof textStart !== 'number' ||
      !Number.isSafeInteger(textStart) ||
      textStart < 0 ||
      typeof textEnd !== 'number' ||
      !Number.isSafeInteger(textEnd) ||
      textEnd - textStart !== passage.content.length)
  )
    return []
  if (pageSpans === undefined) {
    return pageStart === pageEnd && passage.content.length > 0
      ? [
          {
            page: pageStart,
            textStart: positioned ? (textStart as number) : 0,
            textEnd: positioned ? (textEnd as number) : passage.content.length
          }
        ]
      : []
  }
  if (!positioned || !Array.isArray(pageSpans) || pageSpans.length === 0 || pageSpans.length > 64)
    return []
  const spans: PassagePageSpan[] = []
  let offset = textStart as number
  let previousPage = 0
  for (const span of pageSpans) {
    if (
      typeof span !== 'object' ||
      span === null ||
      !Number.isSafeInteger(span.page) ||
      span.page < pageStart ||
      span.page > pageEnd ||
      span.page <= previousPage ||
      !Number.isSafeInteger(span.textStart) ||
      !Number.isSafeInteger(span.textEnd) ||
      span.textStart !== offset ||
      span.textEnd <= span.textStart ||
      span.textEnd > (textEnd as number)
    )
      return []
    spans.push({ page: span.page, textStart: span.textStart, textEnd: span.textEnd })
    offset = span.textEnd
    previousPage = span.page
  }
  return offset === textEnd && spans[0].page === pageStart && spans.at(-1)!.page === pageEnd
    ? spans
    : []
}

const quotePages = (
  passage: CitationPassage
): { content: string; page: number; start: number }[] => {
  const base = typeof passage.textStart === 'number' ? passage.textStart : 0
  return citationPageSpans(passage).map((span) => {
    let start = span.textStart - base
    const end = span.textEnd - base
    // Strip only a header at an already certified page start; matching text never creates a page.
    const header = `--- Page ${span.page} ---`
    if (passage.content.startsWith(header, start)) {
      const tail = passage.content.slice(start + header.length, end)
      const newline = tail.match(/^[\t ]*\r?\n/u)
      if (newline) start += header.length + newline[0].length
    }
    return { page: span.page, start, content: passage.content.slice(start, end) }
  })
}

type LiteratureLibrarySourceCitation = LiteratureSourceCitation & { href: string }

const sourceCitationReceipt = (citation: LiteratureLibrarySourceCitation): string => {
  const snapshot: LiteratureSourceCitation & { href?: string } = { ...citation }
  delete snapshot.href
  return createLiteratureSourceCitationHref(snapshot)
}

// Include the full persistent snapshot even though the model copies only a short href.
const sourceCitationCharacters = (citation: LiteratureLibrarySourceCitation): number =>
  JSON.stringify(citation).length + JSON.stringify(sourceCitationReceipt(citation)).length

const sourceCitation = (citation: LiteratureSourceCitation): LiteratureLibrarySourceCitation => {
  const receipt = createLiteratureSourceCitationHref(citation)
  if (citation.kind === 'metadata') return { ...citation, href: receipt }
  const citationId = randomBytes(8).toString('hex')
  return { ...citation, citationId, href: `#library-cite=${citationId}` }
}

// Preserve evidence coverage first; surrounding text can use only the remaining budget.
const budgetSourceCitations = (
  candidates: readonly LiteratureLibrarySourceCitation[],
  presentation: LiteratureLibraryPresentation,
  limit = 6
): LiteratureLibrarySourceCitation[] => {
  const fits = (citations: readonly LiteratureLibrarySourceCitation[]): boolean =>
    citations.reduce((total, citation) => total + sourceCitationCharacters(citation), 0) <=
      LITERATURE_LIBRARY_SOURCE_CITATION_MAX_CHARACTERS &&
    presentationText(presentation, citations.map(sourceCitationReceipt)).length <= 8_000
  const selected: LiteratureLibrarySourceCitation[] = []
  for (const candidate of candidates) {
    if (selected.length === limit) break
    if (fits([...selected, candidate])) selected.push(candidate)
  }
  return selected
}

const abstractCitation = (
  result: LiteratureLibraryReadAbstractResult,
  query?: string
): { sourceCitation?: LiteratureLibrarySourceCitation } => {
  // Explicit structured-abstract headings establish a new sentence boundary even
  // when upstream extraction left the preceding section with an unclosed bracket.
  // Require multiple known labels with either period/dash syntax or explicit
  // uppercase line starts followed by a new sentence (capital letter or number).
  // Lowercase continuations and ordinary prose retain the conservative parser.
  const headings = [
    ...result.abstract.matchAll(
      /(?:^|\s)(Background|Objectives?|Design|Setting|Participants|Methods|Data Sources|Study Selection|Data Extraction|Data Synthesis|Main Outcome Measures|Results|Conclusions?)\.[\t ]*[—–][\t ]*/giu
    ),
    ...result.abstract.matchAll(
      /^[\t ]*(BACKGROUND|OBJECTIVES?|DESIGN(?: AND SETTING)?|SETTING|PARTICIPANTS|PATIENTS(?: AND METHODS)?|METHODS|DATA SOURCES|STUDY SELECTION|DATA EXTRACTION|DATA SYNTHESIS|MAIN OUTCOME MEASURES?|RESULTS|CONCLUSIONS?)[\t ]+(?=[\p{Lu}\p{N}])/gmu
    )
  ]
    .filter((heading) => /^[A-Z]/u.test(heading[1]))
    .sort((left, right) => left.index! - right.index!)
  const sections =
    headings.length > 1
      ? [
          result.abstract.slice(0, headings[0].index),
          ...headings.map((heading, index) =>
            result.abstract.slice(heading.index! + heading[0].length, headings[index + 1]?.index)
          )
        ]
      : [result.abstract]
  const candidates = sections
    .flatMap((section) => {
      const candidate = sourceQuote(section, query, false, false, 0)
      return candidate ? [candidate] : []
    })
    .sort((left, right) => right.score - left.score)
  const selected = candidates[0]
  if (!selected) return {}
  const citation = sourceCitation({
    itemId: result.itemId,
    title: compactText(result.title, 1_000),
    kind: 'abstract',
    quote: selected.quote,
    ...(selected.context ? { context: selected.context } : {})
  })
  return { sourceCitation: citation }
}

const pdfCitations = (
  result: LiteratureLibraryReadPdfResult,
  request: LiteratureLibraryReadPdfRequest
): LiteratureLibrarySourceCitation[] => {
  const { source, passages } = result.evidence
  if (typeof source !== 'object' || source === null || !Array.isArray(passages)) return []
  const citations: ReturnType<typeof sourceCitation>[] = []
  for (const passage of passages) {
    if (typeof passage !== 'object' || passage === null || typeof passage.content !== 'string') {
      continue
    }
    if (passage.documentId !== (source as Record<string, unknown>).versionId) continue
    // Reader supplies exact neighboring bytes. Also reuse already returned adjacent
    // passages, so page-split tool fixtures follow the same source-window contract.
    const adjoiningPage = passages.find(
      (other) =>
        other !== passage &&
        other?.documentId === passage.documentId &&
        typeof other.content === 'string' &&
        other.pageEnd === passage.pageStart - 1
    )
    const previous =
      adjoiningPage &&
      Number.isSafeInteger(adjoiningPage.textEnd) &&
      adjoiningPage.textEnd === passage.textStart
        ? adjoiningPage
        : undefined
    const preceding = passage.precedingText ?? previous
    const prefix = typeof preceding?.content === 'string' ? preceding.content : ''
    const window = prefix + passage.content
    let pages: ReturnType<typeof quotePages>
    if (prefix) {
      // A prefix can change the meaning of the quote. Never discard malformed/nonadjacent
      // provenance and then issue its shorter continuation as though that prefix did not exist.
      if (
        !Number.isSafeInteger(preceding.textStart) ||
        !Number.isSafeInteger(preceding.textEnd) ||
        !Number.isSafeInteger(passage.textStart) ||
        !Number.isSafeInteger(passage.textEnd) ||
        preceding.textEnd !== passage.textStart ||
        prefix.length > 800
      )
        continue
      const priorSpans = citationPageSpans(preceding)
      const currentSpans = citationPageSpans(passage)
      if (!priorSpans.length || !currentSpans.length) continue
      const combined = [...priorSpans]
      for (const span of currentSpans) {
        const last = combined.at(-1)!
        if (last.page === span.page && last.textEnd === span.textStart) {
          combined[combined.length - 1] = { ...last, textEnd: span.textEnd }
        } else combined.push(span)
      }
      pages = quotePages({
        content: window,
        pageStart: preceding.pageStart,
        pageEnd: passage.pageEnd,
        textStart: preceding.textStart,
        textEnd: passage.textEnd,
        pageSpans: combined
      })
    } else pages = quotePages(passage)
    const firstWindow = prefix ? preceding : passage
    // Only a certified physical page-one window beginning at the extraction origin can prove
    // there is no omitted prefix. Legacy single-page ranges do not provide that evidence.
    const startsAtDocumentOrigin =
      Array.isArray(firstWindow.pageSpans) &&
      firstWindow.textStart === 0 &&
      firstWindow.pageStart === 1
    const selected = pages
      .flatMap(
        (
          { content, page, start },
          index
        ): {
          quote: string
          context?: string
          score: number
          pageStart: number
          pageEnd: number
        }[] => {
          // Only pages belonging to this retrieved passage are query candidates.
          if (page < passage.pageStart) return []
          const precedingPage = pages[index - 1]
          const prior = precedingPage?.page === page - 1 ? precedingPage : undefined
          // Neighboring text supplies context, never an additional query candidate.
          // Keep sentences that cross into the actual retrieved span, including
          // negations beginning in the prefix, but exclude context-only sentences.
          const prefixInPage = content.slice(0, Math.max(0, prefix.length - start))
          const minimumEnd = prefixInPage.replace(/\s+/gu, ' ').trimStart().length
          const candidate = sourceQuote(
            content,
            request.query,
            true,
            !!prior || (index === 0 && page === 1 && startsAtDocumentOrigin),
            minimumEnd
          )
          if (!candidate) return []
          const normalized = content.replace(/\s+/gu, ' ').trim()
          const offset = candidate.start
          // This is a bounded source excerpt, not a semantic sentence certificate.
          // Near a page boundary retain the whole available adjoining prefix. Neither
          // footer nor header punctuation can promote the continuation on its own.
          if (prior && offset < 800) {
            // Measure the adjoining page's own text, not the following page marker.
            // Layout whitespace before that marker must not shift the retained prefix.
            const priorEnd = prior.start + prior.content.trimEnd().length
            // The retained source window can span several short pages. Bound by
            // source position, not by the immediately preceding page's start.
            const sourceStart = pages[0]?.start ?? 0
            let prefixStart = Math.max(sourceStart, priorEnd - 800)
            while (
              prefixStart < priorEnd &&
              prefixStart > sourceStart &&
              !/\s/u.test(window[prefixStart - 1]!)
            )
              prefixStart += 1
            const prefixText = window.slice(prefixStart, start).replace(/\s+/gu, ' ').trim()
            const quote =
              `${prefixText} ${normalized.slice(0, offset + candidate.quote.length)}`.trim()
            // Never fall back to the shorter, unqualified continuation if the required
            // adjoining span exceeds the receipt's quote limit. Raw passages survive.
            if (quote.length > 1_600) return []
            return [
              {
                quote,
                score: candidate.score,
                context: undefined,
                pageStart:
                  pages.find(({ content, start }) => prefixStart < start + content.length)?.page ??
                  page,
                pageEnd: page
              }
            ]
          }
          return [{ ...candidate, pageStart: page, pageEnd: page }]
        }
      )
      .sort((left, right) => right.score - left.score)[0]
    if (!selected?.quote) continue
    try {
      const citation = sourceCitation({
        itemId: request.itemId,
        title: compactText(result.itemTitle, 1_000),
        kind: 'pdf',
        quote: selected.quote,
        ...(selected.context ? { context: selected.context } : {}),
        source: source as LiteratureSourceCitation['source'],
        pageStart: selected.pageStart,
        pageEnd: selected.pageEnd
      })
      citations.push(citation)
    } catch {
      // A malformed or unavailable immutable source must never become a PDF citation.
    }
  }
  return citations
}

const compactHeadAndTail = (value: string, limit: number): { text: string; truncated?: true } => {
  if (value.length <= limit) return { text: value }
  const marker = '\n[…abstract truncated…]\n'
  const available = Math.max(0, limit - marker.length)
  const headCharacters = Math.ceil(available * 0.65)
  return {
    text: `${value.slice(0, headCharacters)}${marker}${value.slice(-(available - headCharacters))}`,
    truncated: true
  }
}

const creatorName = (creator: LiteratureItemView['item']['creators'][number]): string =>
  creator.nameMode === 'organization'
    ? creator.literalName
    : [creator.givenName, creator.familyName].filter(Boolean).join(' ')

const compactSearchItem = (
  view: LiteratureItemView,
  abstractLimit = LITERATURE_LIBRARY_SEARCH_ABSTRACT_MAX_CHARACTERS
): LiteratureLibrarySearchOutputItem => {
  const abstract = compactHeadAndTail(view.item.abstract, abstractLimit)
  const identifiers = view.item.identifiers
    .filter(
      ({ isPrimary, scheme }) =>
        isPrimary ||
        scheme === 'doi' ||
        scheme === 'pmid' ||
        scheme === 'pmcid' ||
        scheme === 'arxiv'
    )
    .slice(0, 2)
    .map(({ scheme, value }) => ({ scheme, value }))

  return {
    id: view.id,
    metadataRevision: view.metadataRevision,
    itemType: view.item.itemType,
    title: compactText(view.item.title, 400),
    authors: compactText(
      view.item.creators
        .filter(({ creatorType }) => creatorType === 'author')
        .map(creatorName)
        .filter(Boolean)
        .join(', '),
      400
    ),
    creatorCount: view.item.creators.length,
    issuedText: compactText(view.item.issuedText, 100),
    ...(view.item.issuedYear === undefined ? {} : { issuedYear: view.item.issuedYear }),
    containerTitle: compactText(view.item.containerTitle, 250),
    abstractPreview: abstract.text,
    abstractLength: view.item.abstract.length,
    primaryIdentifiers: identifiers,
    hasPdf: view.attachments.some((attachment) =>
      attachment.versions.some(
        ({ contentType, filename }) =>
          contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/pdf' ||
          filename.toLowerCase().endsWith('.pdf')
      )
    ),
    attachmentCount: view.attachments.length,
    ...(abstract.truncated ? { abstractTruncated: true } : {})
  }
}

const compactSearchResult = (
  result: LiteratureLibrarySearchResult,
  request: LiteratureLibrarySearchRequest
): {
  structuredContent: LiteratureLibrarySearchOutputResult
  content: { type: 'text'; text: string }[]
} => {
  let abstractLimit = LITERATURE_LIBRARY_SEARCH_ABSTRACT_MAX_CHARACTERS
  let itemCount = result.items.length
  while (true) {
    const items = result.items
      .slice(0, itemCount)
      .map((item) => compactSearchItem(item, abstractLimit))
    const hasMore = itemCount < result.items.length || result.hasMore
    const nextOffset =
      itemCount < result.items.length ? (request.offset ?? 0) + itemCount : result.nextOffset
    const searchResult: LiteratureLibrarySearchOutputResult = {
      items,
      totalCount: result.totalCount,
      hasMore,
      ...(nextOffset !== undefined ? { nextOffset } : {})
    }
    const presentation: LiteratureLibraryPresentation = {
      libraryAction: 'search',
      libraryScope: request.scope,
      ...(items.length
        ? {
            itemTitles: items
              .map(({ title }) => title)
              .filter(Boolean)
              .slice(0, 3)
          }
        : {}),
      resultCount: items.length,
      totalCount: result.totalCount,
      offset: request.offset ?? 0,
      limit: request.limit,
      ...(nextOffset !== undefined ? { nextOffset } : {}),
      hasMore
    }
    const content = [
      presentationContent(presentation, searchResult),
      { type: 'text' as const, text: JSON.stringify(searchResult) }
    ]
    // Include JSON escaping and the presentation block in the emitted text budget.
    if (JSON.stringify(content).length <= LITERATURE_LIBRARY_SEARCH_OUTPUT_MAX_CHARACTERS) {
      // Preserve the original page and abstract quality before adding optional display links.
      // A link must not displace records or reduce the minimum abstract preview allocation.
      for (let index = 0; index < items.length; index++) {
        const item = items[index]
        const previousText = content[1].text
        const previousPresentation = content[0]
        items[index] = {
          ...item,
          citationHref: createLiteratureSourceCitationHref({
            itemId: item.id,
            title: item.title,
            kind: 'metadata',
            quote: ''
          })
        }
        content[1].text = JSON.stringify(searchResult)
        content[0] = presentationContent(presentation, searchResult)
        if (JSON.stringify(content).length > LITERATURE_LIBRARY_SEARCH_OUTPUT_MAX_CHARACTERS) {
          items[index] = item
          content[1].text = previousText
          content[0] = previousPresentation
        }
      }
      return { structuredContent: searchResult, content }
    }
    if (abstractLimit > LITERATURE_LIBRARY_SEARCH_ABSTRACT_MIN_CHARACTERS) {
      abstractLimit = Math.max(
        LITERATURE_LIBRARY_SEARCH_ABSTRACT_MIN_CHARACTERS,
        Math.floor(abstractLimit / 2)
      )
    } else if (itemCount > 1) {
      itemCount--
    } else {
      throw new Error(
        'SEARCH_RESULT_TOO_LARGE: A single record exceeds the search response budget. Call search_library again with a narrower query; exact identifiers were not truncated.'
      )
    }
  }
}

const compactBatchAbstract = (
  result: LiteratureLibraryReadAbstractResult,
  query?: string
): LiteratureLibraryBatchReadAbstractResult['items'][number] => {
  const abstract = compactHeadAndTail(
    result.abstract,
    LITERATURE_LIBRARY_BATCH_ABSTRACT_MAX_CHARACTERS
  )
  return {
    ...result,
    title: compactText(result.title, 400),
    abstract: abstract.text,
    abstractLength: result.abstract.length,
    ...abstractCitation(result, query),
    ...(abstract.truncated ? { abstractTruncated: true } : {})
  }
}

const candidateTitles = (candidates: readonly LiteratureLibraryDiscovery[]): string[] =>
  candidates
    .map(({ item }) => item.title.trim())
    .filter(Boolean)
    .slice(0, 3)

// The model-facing schema only describes a candidate as an object, so its full bibliographic schema
// is not repeated in every request. Inline candidates are validated here with the file schema.
const parseInlineCandidates = (
  candidates: readonly unknown[]
): readonly LiteratureLibraryDiscovery[] => {
  const parsed = literatureDiscoveryBatchSchema.safeParse({ candidates })
  if (parsed.success) return parsed.data.candidates
  throw new Error(
    'INVALID_CANDIDATES: Candidate fields do not match the candidate record schema:\n' +
      z.prettifyError(parsed.error).slice(0, 2_000) +
      '\nNo records were saved by this call. Fix the indicated fields or pass existing DOI/PMID refs instead. ' +
      LITERATURE_SAVE_ARGUMENT_RECOVERY,
    { cause: parsed.error }
  )
}

const resolveSaveCandidates = async (
  request: {
    refs?: readonly string[]
    candidates?: readonly unknown[]
    filename?: string
  },
  handler: LiteratureLibraryMcpHandler,
  signal?: AbortSignal
): Promise<readonly LiteratureLibraryDiscovery[]> => {
  signal?.throwIfAborted()
  const inputCount = [request.refs, request.candidates, request.filename].filter(
    (value) => value !== undefined
  ).length
  if (inputCount !== 1) {
    throw new Error(
      'SAVE_INPUT_REQUIRED: Pass exactly one of refs, candidates, or filename. ' +
        'Prefer refs for existing DOI/PMID identifiers; otherwise use candidates with item and source. ' +
        'No records were saved by this call. ' +
        LITERATURE_SAVE_ARGUMENT_RECOVERY
    )
  }
  if (request.refs) {
    if (!handler.resolveSaveReferences) {
      throw new Error(
        'REFERENCE_RESOLUTION_UNAVAILABLE: Identifier lookup is not available in this session, so DOI/PMID refs cannot be resolved. Call the same tool again with candidate metadata you already retrieved instead of refs or ref.'
      )
    }
    return handler.resolveSaveReferences(request.refs, signal)
  }
  if (request.candidates) return parseInlineCandidates(request.candidates)
  if (!handler.readCandidateFile) {
    throw new Error(
      'CANDIDATE_FILE_UNAVAILABLE: Candidate files cannot be read in this session, so filename cannot be used. Call the same tool again with refs or candidates.'
    )
  }

  let content: string
  try {
    content = await handler.readCandidateFile(request.filename!, signal)
  } catch (error) {
    signal?.throwIfAborted()
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
    if (code === 'CANDIDATE_FILE_TOO_LARGE') {
      throw new Error('CANDIDATE_FILE_TOO_LARGE: The candidate file exceeds the 2 MB limit.', {
        cause: error
      })
    }
    throw new Error(
      code === 'EACCES' || code === 'EPERM'
        ? 'CANDIDATE_FILE_UNREADABLE: Permission denied. Choose a readable candidate file.'
        : 'CANDIDATE_FILE_UNREADABLE: Could not read the candidate file. Check that it exists and is accessible in this workspace.',
      { cause: error }
    )
  }
  signal?.throwIfAborted()
  let decoded: unknown
  try {
    decoded = JSON.parse(content)
  } catch (error) {
    throw new Error(
      'INVALID_CANDIDATE_FILE: The candidate file must contain valid JSON with the shape {"candidates":[{"item":{...},"source":{...}}]}. ' +
        'No records were saved by this call. Fix the file JSON or pass existing records directly with candidates or refs. ' +
        LITERATURE_SAVE_ARGUMENT_RECOVERY,
      { cause: error }
    )
  }
  const parsed = literatureDiscoveryBatchSchema.safeParse(decoded)
  if (!parsed.success) {
    throw new Error(
      'INVALID_CANDIDATE_FILE: Candidate fields do not match the save_to_inbox candidates schema:\n' +
        z.prettifyError(parsed.error).slice(0, 2_000) +
        '\nNo records were saved by this call. Fix the indicated fields in the file or pass corrected candidates or existing DOI/PMID refs directly. ' +
        LITERATURE_SAVE_ARGUMENT_RECOVERY,
      { cause: parsed.error }
    )
  }
  return parsed.data.candidates
}

const createLiteratureLibraryMcpServer = (
  handler: LiteratureLibraryMcpHandler
): ModelContextProtocolServer => {
  const server = installToolErrorRecovery(
    new ModelContextProtocolServer({ name: LITERATURE_LIBRARY_MCP_SERVER_NAME, version: '1.0.0' })
  )

  server.registerTool(
    LITERATURE_LIBRARY_SEARCH_TOOL_NAME,
    {
      title: 'Search literature library',
      description:
        "Browse or search metadata records in the user's Open-Science Literature Library. Does not search external providers or read PDF full text. Omit query to browse. scope: project (default) returns records linked to the current Project; library searches the whole Library, only when the user asks for it; collection requires collectionId for a Collection the user selected; items requires itemIds the user selected. collectionId and itemIds are rejected with any other scope. Pages hold at most 20 records (also the default), and fewer when the response would exceed about 38,000 characters, so abstractPreview may be shortened (abstractTruncated). Continue while hasMore is true by passing nextOffset as offset. authors lists only authors; creatorCount counts all contributors. Optional citationHref cites metadata only; it does not establish paper contents and may be omitted to preserve the page response budget.",
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(1)
          .max(2_000)
          .optional()
          .describe('Search text. Omit to browse.'),
        scope: z.enum(LITERATURE_LIBRARY_SCOPES).optional(),
        collectionId: z
          .string()
          .trim()
          .min(1)
          .max(512)
          .optional()
          .describe('Required with, and only with, scope "collection".'),
        itemIds: z
          .array(z.string().trim().min(1).max(512))
          .min(1)
          .max(200)
          .optional()
          .describe('Unique Library itemIds. Required with, and only with, scope "items".'),
        offset: z.number().int().min(0).optional().describe('nextOffset from the previous page.'),
        limit: z.number().int().min(1).max(LITERATURE_LIBRARY_SEARCH_DEFAULT_LIMIT).optional()
      }
    },
    async (request) =>
      withDataRootWrite(async () => {
        const scope = request.scope ?? 'project'
        const limit = request.limit ?? LITERATURE_LIBRARY_SEARCH_DEFAULT_LIMIT
        assertCollectionScope(scope, request.collectionId)
        if (scope === 'items' && !request.itemIds) {
          throw argumentError('ITEM_IDS_REQUIRED', 'scope "items" requires itemIds.')
        }
        if (scope !== 'items' && request.itemIds) {
          throw argumentError('ITEMS_SCOPE_REQUIRED', 'itemIds requires scope "items".')
        }
        if (request.itemIds && new Set(request.itemIds).size !== request.itemIds.length) {
          throw argumentError('DUPLICATE_ITEM_IDS', 'itemIds contains duplicates.')
        }
        const result = await handler.searchLibrary({ ...request, scope, limit })
        return compactSearchResult(result, { ...request, scope, limit })
      })
  )

  if (handler.searchLibraryFullText) {
    server.registerTool(
      LITERATURE_LIBRARY_SEARCH_FULL_TEXT_TOOL_NAME,
      {
        title: 'Search Library PDF text',
        description:
          'Search existing cached PDF text only in the current Library scope, without extraction or OCR. Follow nextOffset with offset to continue. Inspect coverage, incomplete and limitations: uncached/unavailable sources and unverified page coverage prevent a complete full-text claim, even with zero matches. This finds cached body-only matches that metadata search cannot see. Results are discovery passages, not citation receipts; call read_library_pdf with the returned itemId and attachmentId before citing.',
        inputSchema: {
          query: z.string().trim().min(1).max(2_000),
          scope: z.enum(LITERATURE_LIBRARY_SCOPES).optional(),
          collectionId: z.string().trim().min(1).max(512).optional(),
          itemIds: z.array(z.string().trim().min(1).max(512)).min(1).max(20).optional(),
          offset: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(8).optional()
        }
      },
      async (request, { signal }) =>
        withDataRootWrite(async () => {
          signal.throwIfAborted()
          const scope = request.scope ?? 'project'
          assertCollectionScope(scope, request.collectionId)
          if (scope === 'items' && !request.itemIds)
            throw argumentError('ITEM_IDS_REQUIRED', 'scope "items" requires itemIds.')
          if (scope !== 'items' && request.itemIds)
            throw argumentError('ITEMS_SCOPE_REQUIRED', 'itemIds requires scope "items".')
          const result = await handler.searchLibraryFullText!({ ...request, scope, signal })
          signal.throwIfAborted()
          return {
            structuredContent: result,
            content: [
              presentationContent({
                libraryAction: 'search',
                libraryScope: scope,
                resultCount: result.matches.length,
                totalCount: result.totalRecordCount,
                ...(result.nextOffset === undefined ? {} : { nextOffset: result.nextOffset })
              }),
              { type: 'text' as const, text: JSON.stringify(result) }
            ]
          }
        })
    )
  }

  if (handler.formatReferences) {
    server.registerTool(
      LITERATURE_LIBRARY_FORMAT_REFERENCES_TOOL_NAME,
      {
        title: 'Format literature references',
        description:
          'Format Library records as citations for Markdown, plain text, or chat. Pass exact itemIds; set styleId/locale (default apa, en-US) when the user names a style or language. Use the returned strings verbatim; never hand-format or invent citation metadata. For DOCX use format_citation_document.',
        inputSchema: {
          itemIds: z
            .array(z.string().trim().min(1).max(512))
            .min(1)
            .max(20)
            .describe('Library itemIds returned by search_library.'),
          styleId: z.enum(LITERATURE_CITATION_STYLES).default('apa'),
          locale: z.enum(LITERATURE_CITATION_LOCALES).default('en-US')
        }
      },
      async (request) =>
        withDataRootWrite(async () => {
          const result = await handler.formatReferences!(request)
          return {
            structuredContent: result,
            content: [
              presentationContent({
                libraryAction: 'format',
                resultCount: result.references.length
              }),
              { type: 'text' as const, text: JSON.stringify(result) }
            ]
          }
        })
    )
  }

  if (handler.formatCitationDocument) {
    server.registerTool(
      LITERATURE_LIBRARY_FORMAT_DOCUMENT_TOOL_NAME,
      {
        title: 'Format citation document',
        description:
          'Format an already-saved DOCX with {{cite:itemId}} markers and an optional {{bibliography}} marker: renders citations and bibliography as Zotero-compatible Word Fields and attaches the result. Do not call write_artifact_file afterward or write Zotero fields yourself.',
        inputSchema: {
          filename: z
            .string()
            .trim()
            .min(1)
            .max(2_000)
            .describe(
              'Filename of an already-saved DOCX in the current Session workspace. A trusted relative or absolute path is also accepted, but do not construct a workspace prefix.'
            ),
          styleId: z.enum(LITERATURE_CITATION_STYLES).default('apa'),
          locale: z.enum(LITERATURE_CITATION_LOCALES).default('en-US')
        }
      },
      async (request) =>
        withDataRootWrite(async () => {
          const result = await handler.formatCitationDocument!(request)
          const output = { ...result, artifactAttached: true }
          return {
            structuredContent: output,
            content: [
              presentationContent({
                libraryAction: 'format',
                documentNames: [result.filename],
                resultCount: result.referenceCount
              }),
              { type: 'text' as const, text: JSON.stringify(output) }
            ]
          }
        })
    )
  }

  if (handler.prepareLatexBundle) {
    server.registerTool(
      LITERATURE_LIBRARY_PREPARE_LATEX_TOOL_NAME,
      {
        title: 'Prepare LaTeX bundle',
        description:
          'Package an already-saved UTF-8 .tex file with {{cite:itemId}} markers and an optional {{bibliography}} marker: markers become \\cite{key} and \\printbibliography, references.bib is generated, and an Overleaf-compatible ZIP is attached. Use BibLaTeX with \\addbibresource{references.bib}. Do not call write_artifact_file afterward.',
        inputSchema: {
          filename: z
            .string()
            .trim()
            .min(1)
            .max(2_000)
            .describe(
              'Filename of an already-saved UTF-8 .tex file in the current Session workspace. A trusted relative or absolute path is also accepted, but do not construct a workspace prefix.'
            )
        }
      },
      async (request) =>
        withDataRootWrite(async () => {
          const result = await handler.prepareLatexBundle!(request)
          const output = { ...result, artifactAttached: true }
          return {
            structuredContent: output,
            content: [
              presentationContent({
                libraryAction: 'format',
                documentNames: [result.filename],
                resultCount: result.referenceCount
              }),
              { type: 'text' as const, text: JSON.stringify(output) }
            ]
          }
        })
    )
  }

  server.registerTool(
    LITERATURE_LIBRARY_READ_ABSTRACT_TOOL_NAME,
    {
      title: 'Read literature abstracts',
      description:
        'Read the complete abstract of one Literature Library record (itemId), or bounded abstracts of up to five records (itemIds); pass exactly one of the two. Use it when search previews are insufficient, not for every search result. Batch abstracts over 5,000 characters are compacted and marked abstractTruncated. Reads metadata only, not PDF full text. Pass the same scope and collectionId as the search that returned the records. An optional query selects sourceCitation and bounded matching excerpts in citations. Copy the specific excerpt href verbatim only for claims supported by its quote or context; these links cite abstract evidence only.',
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(1)
          .max(2_000)
          .optional()
          .describe('Focused query for selecting bounded abstract citation excerpts.'),
        itemId: z.string().trim().min(1).max(512).optional().describe('One Library itemId.'),
        itemIds: z
          .array(z.string().trim().min(1).max(512))
          .min(1)
          .max(LITERATURE_LIBRARY_BATCH_ABSTRACT_LIMIT)
          .optional()
          .describe('Up to five unique Library itemIds.'),
        scope: z.enum(LITERATURE_LIBRARY_READ_SCOPES).optional().describe(scopeDescription),
        collectionId: z
          .string()
          .trim()
          .min(1)
          .max(512)
          .optional()
          .describe('Required with, and only with, scope "collection".')
      }
    },
    async (request) =>
      withDataRootWrite(async () => {
        const scope = request.scope ?? 'project'
        if ((request.itemId ? 1 : 0) + (request.itemIds ? 1 : 0) !== 1) {
          throw argumentError('ABSTRACT_INPUT_REQUIRED', 'Pass exactly one of itemId or itemIds.')
        }
        if (request.itemIds && new Set(request.itemIds).size !== request.itemIds.length) {
          throw argumentError('DUPLICATE_ITEM_IDS', 'itemIds contains duplicates.')
        }
        assertCollectionScope(scope, request.collectionId)
        if (request.itemIds) {
          const resolved = await Promise.all(
            request.itemIds.map((itemId) =>
              handler.readAbstract({ itemId, scope, collectionId: request.collectionId })
            )
          )
          const items = resolved
            .filter((item) => item !== undefined)
            .map((item) => compactBatchAbstract(item, request.query))
          const presentation: LiteratureLibraryPresentation = {
            libraryAction: 'read',
            libraryScope: scope,
            itemTitles: items.map(({ title }) => title).slice(0, 3),
            resultCount: items.length
          }
          const citations = budgetSourceCitations(
            items.flatMap(({ sourceCitation }) => (sourceCitation ? [sourceCitation] : [])),
            presentation
          )
          const allowed = new Map(citations.map((citation) => [citation.href, citation]))
          const primaryResult: LiteratureLibraryBatchReadAbstractResult = {
            items: items.map((item) => ({
              ...item,
              sourceCitation: item.sourceCitation
                ? allowed.get(item.sourceCitation.href)
                : undefined
            })),
            missingItemIds: request.itemIds.filter((_, index) => resolved[index] === undefined)
          }
          const result = primaryResult
          return {
            structuredContent: result,
            content: [
              presentationContent(presentation, result),
              { type: 'text' as const, text: JSON.stringify(result) }
            ]
          }
        }
        const result = await handler.readAbstract({
          itemId: request.itemId!,
          scope,
          collectionId: request.collectionId
        })
        if (!result) throw itemNotFound()
        const presentation: LiteratureLibraryPresentation = {
          libraryAction: 'read',
          libraryScope: scope,
          itemTitles: [result.title],
          resultCount: 1
        }
        const candidate = abstractCitation(result, request.query).sourceCitation
        const citation = candidate ? budgetSourceCitations([candidate], presentation)[0] : undefined
        const output = { ...result, ...(citation ? { sourceCitation: citation } : {}) }
        return {
          structuredContent: output,
          content: [
            presentationContent(presentation, output),
            { type: 'text' as const, text: JSON.stringify(output) }
          ]
        }
      })
  )

  server.registerTool(
    LITERATURE_LIBRARY_READ_PDF_TOOL_NAME,
    {
      title: 'Read literature PDF evidence',
      description:
        'Retrieve relevant passages with page numbers from the PDF attached to one Literature Library record. Use it only when full text could materially affect the answer, after finding the record with search_library (hasPdf: true). Each call reads one record on demand and reuses extraction for the same file version; it does not index the whole Library. Returns prose, not verified table cells or images; do not infer visual evidence from these passages. Pass the same scope and collectionId as the search that returned the record. itemId is a Library record identifier, not a linked-PDF documentId for list_pdf_elements. citations contains up to six bounded source excerpts with immutable source versions and tool-generated hrefs; copy the href verbatim for supported claims. Excerpts retain adjoining text within an 800-character page-boundary window and do not certify complete sentence meaning or full-PDF context. Empty citations means no excerpt fits the bounded source window and receipt budget; raw passages remain available.',
      inputSchema: {
        itemId: z.string().trim().min(1).max(512).describe('Library itemId from search_library.'),
        attachmentId: z
          .string()
          .trim()
          .min(1)
          .max(512)
          .optional()
          .describe(
            'Omit to read the first PDF attachment. Otherwise use an attachmentId returned by search_library_full_text or explicitly supplied by the user.'
          ),
        query: z.string().trim().min(1).max(2_000).describe('What to find in the full text.'),
        scope: z.enum(LITERATURE_LIBRARY_READ_SCOPES).optional().describe(scopeDescription),
        collectionId: z
          .string()
          .trim()
          .min(1)
          .max(512)
          .optional()
          .describe('Required with, and only with, scope "collection".')
      }
    },
    async (request) =>
      withDataRootWrite(async () => {
        const scope = request.scope ?? 'project'
        assertCollectionScope(scope, request.collectionId)
        const result = await handler.readPdf({ ...request, scope })
        if (!result) throw itemNotFound()
        const presentation: LiteratureLibraryPresentation = {
          ...(literatureReadPresentation(result.evidence) ?? {}),
          libraryAction: 'read',
          libraryScope: scope,
          itemTitles: [result.itemTitle]
        }
        const evidence = {
          ...result.evidence,
          citations: budgetSourceCitations(pdfCitations(result, request), presentation)
        }
        return {
          structuredContent: evidence,
          content: [
            presentationContent(presentation, evidence),
            { type: 'text' as const, text: JSON.stringify(evidence) }
          ]
        }
      })
  )

  server.registerTool(
    LITERATURE_LIBRARY_SAVE_TOOL_NAME,
    {
      title: 'Save literature discoveries',
      description:
        'Save one to ten literature records discovered by the Agent to the user-level Literature Inbox for review. Pass exactly one of refs, candidates, or filename. Prefer refs (pmid:<id> or doi:<id>) so Open-Science retrieves the metadata itself; use candidates only for records without a supported identifier; use filename only for a prepared candidate JSON batch. Open-Science supplies the current Project and Session origin; do not include origin fields. Each receipt in results corresponds to the completed input prefix; failure.inputIndex is zero-based and later inputs were not attempted. Reused receipts are not newly created rows.',
      inputSchema: {
        refs: z
          .array(z.string().trim().min(1).max(512))
          .min(1)
          .max(10)
          .optional()
          .describe(
            'An array of 1–10 DOI/PMID references, not a single string. For example ["pmid:35486828", "doi:10.1016/j.cell.2011.03.019"].'
          ),
        candidates: z
          .array(z.record(z.string(), z.unknown()))
          .min(1)
          .max(10)
          .optional()
          .describe(
            'An array of 1–10 records, each { item, source }: item is the bibliographic metadata (itemType, title, creators, identifiers…) and source is { provider, rawMetadata } as returned by literature discovery. Pass retrieved records unchanged; do not invent missing fields. Invalid fields are reported by path.'
          ),
        filename: z
          .string()
          .trim()
          .min(1)
          .max(2_000)
          .optional()
          .describe(
            'Filename of an existing Notebook-owned JSON file containing {"candidates":[...]} with the same record schema as candidates. Not a PDF, ZIP, bare array, or inline JSON string; do not construct a workspace prefix.'
          )
      }
    },
    async (request, { signal }) =>
      withDataRootWrite(async () => {
        const candidates = await resolveSaveCandidates(request, handler, signal)
        signal.throwIfAborted()
        const result = await handler.saveToInbox({ candidates, signal })
        const summary = summarizeLiteratureSaveReceipts(result.results)
        const titles = candidateTitles(candidates)
        return {
          ...(result.failure || result.cancelled ? { isError: true } : {}),
          structuredContent: result,
          content: [
            presentationContent({
              libraryAction: 'save',
              ...(titles.length > 0 ? { itemTitles: titles } : {}),
              candidateCount: candidates.length,
              savedCount: summary.pendingCount
            }),
            { type: 'text' as const, text: JSON.stringify(result) }
          ]
        }
      })
  )

  if (handler.acquirePdf)
    server.registerTool(
      'acquire_pdf',
      {
        title: 'Acquire literature PDF',
        description:
          'Find and download one publicly accessible full-text PDF into Literature Inbox for user review. Pass exactly one of ref (DOI or PMID) or candidate (metadata with its source). Omit pdfUrl to search the configured open full-text providers; pass pdfUrl only for a discovered public HTTPS PDF link. The PDF and metadata stay in Inbox until the user accepts them; existing Library records are reused on acceptance. Downloads are limited to 50 MB; private network addresses, sign-in sessions and local file paths are not supported. Do not describe pending-review results as already added to the Library.',
        inputSchema: {
          ref: z
            .string()
            .trim()
            .min(1)
            .max(512)
            .optional()
            .describe('One DOI or PMID, for example "doi:10.1016/j.cell.2011.03.019".'),
          candidate: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              'One { item, source } record from literature discovery, for a work without a DOI or PMID. Pass it unchanged.'
            ),
          pdfUrl: z
            .string()
            .url()
            .max(4096)
            .optional()
            .describe('Public HTTPS URL of the PDF itself.')
        }
      },
      async ({ ref, candidate, pdfUrl }, { signal }) =>
        withDataRootWrite(async () => {
          signal.throwIfAborted()
          if (Boolean(ref) === Boolean(candidate)) {
            throw argumentError(
              'ACQUIRE_PDF_INPUT_REQUIRED',
              'Pass exactly one of ref or candidate.'
            )
          }
          const candidates = await resolveSaveCandidates(
            { refs: ref ? [ref] : undefined, candidates: candidate ? [candidate] : undefined },
            handler,
            signal
          )
          if (candidates.length !== 1)
            throw new Error(
              'REFERENCE_NOT_RESOLVED: ref did not resolve to exactly one record. Call acquire_pdf again with candidate metadata you already retrieved, or ask the user for a more specific identifier.'
            )
          signal.throwIfAborted()
          const result = await handler.acquirePdf!({ candidate: candidates[0]!, pdfUrl, signal })
          return {
            structuredContent: result,
            content: [
              presentationContent({
                libraryAction: 'save',
                itemTitles: candidateTitles(candidates),
                candidateCount: 1,
                savedCount: result.status === 'pending-review' ? 1 : 0
              }),
              { type: 'text' as const, text: JSON.stringify(result) }
            ]
          }
        })
    )
  return server
}

export {
  createLiteratureLibraryMcpServer,
  LITERATURE_LIBRARY_FORMAT_DOCUMENT_TOOL_NAME,
  LITERATURE_LIBRARY_FORMAT_REFERENCES_TOOL_NAME,
  LITERATURE_LIBRARY_MCP_SERVER_NAME,
  LITERATURE_LIBRARY_PREPARE_LATEX_TOOL_NAME,
  LITERATURE_LIBRARY_READ_ABSTRACT_TOOL_NAME,
  LITERATURE_LIBRARY_READ_PDF_TOOL_NAME,
  LITERATURE_LIBRARY_SAVE_TOOL_NAME,
  LITERATURE_LIBRARY_SEARCH_DEFAULT_LIMIT,
  LITERATURE_LIBRARY_SEARCH_FULL_TEXT_TOOL_NAME,
  LITERATURE_LIBRARY_SEARCH_TOOL_NAME
}
export type {
  LiteratureLibraryDiscovery,
  LiteratureLibraryFormatDocumentRequest,
  LiteratureLibraryFormatDocumentResult,
  LiteratureLibraryFormatReferencesRequest,
  LiteratureLibraryFormatReferencesResult,
  LiteratureLibraryMcpHandler,
  LiteratureLibraryPrepareLatexRequest,
  LiteratureLibraryPrepareLatexResult,
  LiteratureLibraryReadAbstractRequest,
  LiteratureLibraryReadAbstractResult,
  LiteratureLibraryReadPdfRequest,
  LiteratureLibraryReadPdfResult,
  LiteratureLibrarySaveRequest,
  LiteratureLibrarySaveResult,
  LiteratureLibraryScope,
  LiteratureLibrarySearchRequest,
  LiteratureLibrarySearchResult,
  LiteratureLibraryFullTextSearchRequest,
  LiteratureLibraryFullTextSearchResult
}
