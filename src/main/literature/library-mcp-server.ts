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

const LITERATURE_LIBRARY_MCP_SERVER_NAME = 'open-science-library'
const LITERATURE_LIBRARY_SEARCH_TOOL_NAME = 'search_library'
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
export const LITERATURE_LIBRARY_SCOPES = ['library', 'project', 'collection', 'items'] as const
// Reads name their record directly, so `items` has no selection to apply there.
export const LITERATURE_LIBRARY_READ_SCOPES = ['library', 'project', 'collection'] as const

type LiteratureLibraryScope = (typeof LITERATURE_LIBRARY_SCOPES)[number]

const argumentError = (code: string, message: string): Error =>
  new Error(`${code}: ${message} ${TOOL_ARGUMENT_RECOVERY}`)

const scopeDescription =
  'project (default): records linked to the current Project. library: the whole Library, only when the user asks for it. collection: requires collectionId.'

const itemNotFound = (): Error =>
  new Error(
    'LITERATURE_ITEM_NOT_FOUND: No record with this itemId exists in this scope. Use an itemId returned by search_library with the same scope and collectionId as that search (use library after an items search); do not guess itemIds.'
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
    Readonly<{ abstractLength: number; abstractTruncated?: true }>)[]
  missingItemIds: readonly string[]
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

const presentationContent = (
  presentation: LiteratureLibraryPresentation
): { type: 'text'; text: string } => ({
  type: 'text',
  text: JSON.stringify({ openScienceLiteraturePresentation: presentation })
})

const compactText = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`

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
    const content = [
      presentationContent({
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
      }),
      { type: 'text' as const, text: JSON.stringify(searchResult) }
    ]
    // Include JSON escaping and the presentation block in the emitted text budget.
    if (JSON.stringify(content).length <= LITERATURE_LIBRARY_SEARCH_OUTPUT_MAX_CHARACTERS) {
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
  result: LiteratureLibraryReadAbstractResult
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
    ...(abstract.truncated ? { abstractTruncated: true } : {})
  }
}

const candidateTitles = (candidates: readonly LiteratureLibraryDiscovery[]): string[] =>
  candidates
    .map(({ item }) => item.title.trim())
    .filter(Boolean)
    .slice(0, 3)

const resolveSaveCandidates = async (
  request: {
    refs?: readonly string[]
    candidates?: readonly LiteratureLibraryDiscovery[]
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
  if (request.candidates) return request.candidates
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
        "Browse or search metadata records in the user's Open-Science Literature Library. Does not search external providers or read PDF full text. Omit query to browse. scope: project (default) returns records linked to the current Project; library searches the whole Library, only when the user asks for it; collection requires collectionId for a Collection the user selected; items requires itemIds the user selected. collectionId and itemIds are rejected with any other scope. Pages hold at most 20 records (also the default), and fewer when the response would exceed about 38,000 characters, so abstractPreview may be shortened (abstractTruncated). Continue while hasMore is true by passing nextOffset as offset. authors lists only authors; creatorCount counts all contributors.",
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

  if (handler.formatReferences) {
    server.registerTool(
      LITERATURE_LIBRARY_FORMAT_REFERENCES_TOOL_NAME,
      {
        title: 'Format literature references',
        description:
          'Format trusted Literature Library records for Markdown, plain text, or chat output. Pass the exact itemIds; styleId and locale default to apa and en-US, so set them when the user names a style or language. Use the returned inText and reference strings verbatim; do not hand-format or invent citation metadata. For DOCX use format_citation_document instead.',
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
          'Format and attach an already-saved DOCX that contains semantic {{cite:itemId}} markers and an optional {{bibliography}} marker. Open-Science resolves the Literature items, formats the visible citations and bibliography, embeds Zotero-compatible Word Fields, and attaches the resulting DOCX with trusted citation provenance. The returned file is already attached; do not call write_artifact_file. Do not construct Zotero fields or repeat Literature metadata yourself.',
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
          'Prepare and attach an already-saved UTF-8 .tex file that contains semantic {{cite:itemId}} markers and an optional {{bibliography}} marker. Open-Science resolves the Literature items, replaces markers with stable \\cite{key} commands, generates references.bib and a revision manifest, and attaches an Overleaf-compatible ZIP with trusted citation provenance. The source should use BibLaTeX with \\addbibresource{references.bib}; {{bibliography}} becomes \\printbibliography. The returned file is already attached; do not call write_artifact_file.',
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
        'Read the complete abstract of one Literature Library record (itemId), or bounded abstracts of up to five records (itemIds); pass exactly one of the two. Use it when search previews are insufficient, not for every search result. Batch abstracts over 5,000 characters are compacted and marked abstractTruncated. Reads metadata only, not PDF full text. Pass the same scope and collectionId as the search that returned the records; after an items search, use library.',
      inputSchema: {
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
          const result: LiteratureLibraryBatchReadAbstractResult = {
            items: resolved.filter((item) => item !== undefined).map(compactBatchAbstract),
            missingItemIds: request.itemIds.filter((_, index) => resolved[index] === undefined)
          }
          return {
            structuredContent: result,
            content: [
              presentationContent({
                libraryAction: 'read',
                libraryScope: scope,
                itemTitles: result.items.map(({ title }) => title).slice(0, 3),
                resultCount: result.items.length
              }),
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
        return {
          structuredContent: result,
          content: [
            presentationContent({
              libraryAction: 'read',
              libraryScope: scope,
              itemTitles: [result.title],
              resultCount: 1
            }),
            { type: 'text' as const, text: JSON.stringify(result) }
          ]
        }
      })
  )

  server.registerTool(
    LITERATURE_LIBRARY_READ_PDF_TOOL_NAME,
    {
      title: 'Read literature PDF evidence',
      description:
        'Retrieve relevant passages with page numbers from the PDF attached to one Literature Library record. Use it only when full text could materially affect the answer, after finding the record with search_library (hasPdf: true). Each call reads one record on demand and reuses extraction for the same file version; it does not index the whole Library. Returns prose, not verified table cells or images; do not infer visual evidence from these passages. Pass the same scope and collectionId as the search that returned the record; after an items search, use library. itemId is a Library record identifier, not a linked-PDF documentId for list_pdf_elements.',
      inputSchema: {
        itemId: z.string().trim().min(1).max(512).describe('Library itemId from search_library.'),
        attachmentId: z
          .string()
          .trim()
          .min(1)
          .max(512)
          .optional()
          .describe(
            'Omit to read the first PDF attachment. No tool returns attachment ids; pass one only if the user supplied it.'
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
        const evidencePresentation = literatureReadPresentation(result.evidence)
        return {
          structuredContent: result.evidence,
          content: [
            presentationContent({
              ...(evidencePresentation ?? {}),
              libraryAction: 'read',
              libraryScope: scope,
              itemTitles: [result.itemTitle]
            }),
            { type: 'text' as const, text: JSON.stringify(result.evidence) }
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
          .array(literatureDiscoverySchema)
          .min(1)
          .max(10)
          .optional()
          .describe(
            'An array of 1–10 records, each with item (bibliographic metadata, including itemType and title) and source (provider and rawMetadata). Reuse retrieved metadata; do not invent missing fields.'
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
          candidate: literatureDiscoverySchema
            .optional()
            .describe('One record with item and source, for a work without a DOI or PMID.'),
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
  LiteratureLibrarySearchResult
}
