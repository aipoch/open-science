import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  LITERATURE_CITATION_LOCALES,
  LITERATURE_CITATION_STYLES,
  literatureItemInputSchema,
  literatureSourceInputSchema,
  type LiteratureCitationLocale,
  type LiteratureCitationStyle,
  type LiteratureCatalogReceipt,
  type LiteratureItemView
} from '../../shared/literature'
import { literatureReadPresentation } from './mcp-server'
import type { AgentPdfAcquisitionResult } from './agent-pdf-acquisition'

const LITERATURE_LIBRARY_MCP_SERVER_NAME = 'open-science-library'
const LITERATURE_LIBRARY_SEARCH_TOOL_NAME = 'search_library'
const LITERATURE_LIBRARY_READ_ABSTRACT_TOOL_NAME = 'read_library_abstract'
const LITERATURE_LIBRARY_READ_PDF_TOOL_NAME = 'read_library_pdf'
const LITERATURE_LIBRARY_FORMAT_REFERENCES_TOOL_NAME = 'format_references'
const LITERATURE_LIBRARY_FORMAT_DOCUMENT_TOOL_NAME = 'format_citation_document'
const LITERATURE_LIBRARY_PREPARE_LATEX_TOOL_NAME = 'prepare_latex_bundle'
const LITERATURE_LIBRARY_SAVE_TOOL_NAME = 'save_to_inbox'
const LITERATURE_LIBRARY_SEARCH_DEFAULT_LIMIT = 20
const LITERATURE_LIBRARY_SEARCH_OUTPUT_MAX_CHARACTERS = 38_000
const LITERATURE_LIBRARY_SEARCH_ABSTRACT_MAX_CHARACTERS = 1_200
const LITERATURE_LIBRARY_SEARCH_ABSTRACT_MIN_CHARACTERS = 200
const LITERATURE_LIBRARY_BATCH_ABSTRACT_LIMIT = 5
const LITERATURE_LIBRARY_BATCH_ABSTRACT_MAX_CHARACTERS = 5_000
const LITERATURE_LIBRARY_SCOPES = ['library', 'project', 'collection', 'items'] as const

type LiteratureLibraryScope = (typeof LITERATURE_LIBRARY_SCOPES)[number]

const literatureDiscoverySchema = z
  .object({
    item: literatureItemInputSchema,
    source: literatureSourceInputSchema
  })
  .strict()

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

type LiteratureLibraryDiscovery = z.infer<typeof literatureDiscoverySchema>

type LiteratureLibrarySaveRequest = Readonly<{
  candidates: readonly LiteratureLibraryDiscovery[]
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

type LiteratureLibrarySaveResult = Readonly<{
  results: readonly LiteratureCatalogReceipt[]
}>

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
  }) => Promise<AgentPdfAcquisitionResult>
  searchLibrary: (request: LiteratureLibrarySearchRequest) => Promise<LiteratureLibrarySearchResult>
  readAbstract: (
    request: LiteratureLibraryReadAbstractRequest
  ) => Promise<LiteratureLibraryReadAbstractResult | undefined>
  readPdf: (
    request: LiteratureLibraryReadPdfRequest
  ) => Promise<LiteratureLibraryReadPdfResult | undefined>
  resolveSaveReferences?: (
    references: readonly string[]
  ) => Promise<readonly LiteratureLibraryDiscovery[]>
  readCandidateFile?: (filename: string) => Promise<string>
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

const itemTitles = (items: readonly LiteratureItemView[]): string[] =>
  items
    .map(({ item }) => item.title.trim())
    .filter(Boolean)
    .slice(0, 3)

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
    .map(({ scheme, value }) => ({ scheme, value: compactText(value, 200) }))

  return {
    id: view.id,
    metadataRevision: view.metadataRevision,
    itemType: view.item.itemType,
    title: compactText(view.item.title, 400),
    authors: compactText(view.item.creators.map(creatorName).filter(Boolean).join(', '), 400),
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
  result: LiteratureLibrarySearchResult
): LiteratureLibrarySearchOutputResult => {
  let abstractLimit = LITERATURE_LIBRARY_SEARCH_ABSTRACT_MAX_CHARACTERS
  let searchResult = { ...result, items: result.items.map((item) => compactSearchItem(item)) }
  while (
    JSON.stringify(searchResult).length > LITERATURE_LIBRARY_SEARCH_OUTPUT_MAX_CHARACTERS &&
    abstractLimit > LITERATURE_LIBRARY_SEARCH_ABSTRACT_MIN_CHARACTERS
  ) {
    const overflow =
      JSON.stringify(searchResult).length - LITERATURE_LIBRARY_SEARCH_OUTPUT_MAX_CHARACTERS
    abstractLimit = Math.max(
      LITERATURE_LIBRARY_SEARCH_ABSTRACT_MIN_CHARACTERS,
      abstractLimit - Math.ceil(overflow / Math.max(1, result.items.length)) - 16
    )
    searchResult = {
      ...result,
      items: result.items.map((item) => compactSearchItem(item, abstractLimit))
    }
  }
  return searchResult
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
  handler: LiteratureLibraryMcpHandler
): Promise<readonly LiteratureLibraryDiscovery[]> => {
  const inputCount = [request.refs, request.candidates, request.filename].filter(
    (value) => value !== undefined
  ).length
  if (inputCount !== 1) {
    throw new Error('SAVE_INPUT_REQUIRED: Pass exactly one of refs, candidates, or filename.')
  }
  if (request.refs) {
    if (!handler.resolveSaveReferences) {
      throw new Error('REFERENCE_RESOLUTION_UNAVAILABLE: Identifier lookup is not configured.')
    }
    return handler.resolveSaveReferences(request.refs)
  }
  if (request.candidates) return request.candidates
  if (!handler.readCandidateFile) {
    throw new Error('CANDIDATE_FILE_UNAVAILABLE: Candidate file loading is not configured.')
  }

  try {
    return literatureDiscoveryBatchSchema.parse(
      JSON.parse(await handler.readCandidateFile(request.filename!))
    ).candidates
  } catch (error) {
    throw new Error('INVALID_CANDIDATE_FILE: The candidate file is not valid Literature JSON.', {
      cause: error
    })
  }
}

const createLiteratureLibraryMcpServer = (
  handler: LiteratureLibraryMcpHandler
): ModelContextProtocolServer => {
  const server = new ModelContextProtocolServer({
    name: LITERATURE_LIBRARY_MCP_SERVER_NAME,
    version: '1.0.0'
  })

  server.registerTool(
    LITERATURE_LIBRARY_SEARCH_TOOL_NAME,
    {
      title: 'Search literature library',
      description:
        "Browse or search the user's Open Science literature metadata library. Results use a compact projection with abstractPreview, abstractLength, and abstractTruncated so a 20-record page stays within the Agent response budget. This does not search external providers or read PDF full text. Omit query to browse records. Scope defaults to project and only returns records linked to the trusted current Project. Use library only when the user explicitly requests their global Library, collection with collectionId for an explicitly selected Collection, or items with the exact itemIds explicitly selected by the user. Each page defaults to 20 records, which is also the maximum. When nextOffset is returned, pass it as offset to continue.",
      inputSchema: {
        query: z.string().trim().min(1).max(2_000).optional(),
        scope: z.enum(LITERATURE_LIBRARY_SCOPES).optional(),
        collectionId: z.string().trim().min(1).max(512).optional(),
        itemIds: z.array(z.string().trim().min(1).max(512)).min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(LITERATURE_LIBRARY_SEARCH_DEFAULT_LIMIT).optional()
      }
    },
    async (request) => {
      const scope = request.scope ?? 'project'
      const limit = request.limit ?? LITERATURE_LIBRARY_SEARCH_DEFAULT_LIMIT
      if (scope === 'collection' && !request.collectionId) {
        throw new Error('COLLECTION_ID_REQUIRED: Collection scope requires collectionId.')
      }
      if (scope !== 'collection' && request.collectionId) {
        throw new Error('COLLECTION_SCOPE_REQUIRED: collectionId requires Collection scope.')
      }
      if (scope === 'items' && !request.itemIds) {
        throw new Error('ITEM_IDS_REQUIRED: Items scope requires itemIds.')
      }
      if (scope !== 'items' && request.itemIds) {
        throw new Error('ITEMS_SCOPE_REQUIRED: itemIds requires Items scope.')
      }
      if (request.itemIds && new Set(request.itemIds).size !== request.itemIds.length) {
        throw new Error('DUPLICATE_ITEM_IDS: Items scope does not accept duplicate itemIds.')
      }
      const result = await handler.searchLibrary({ ...request, scope, limit })
      const searchResult = compactSearchResult(result)
      const titles = itemTitles(result.items)
      return {
        structuredContent: searchResult,
        content: [
          presentationContent({
            libraryAction: 'search',
            libraryScope: scope,
            ...(titles.length > 0 ? { itemTitles: titles } : {}),
            resultCount: searchResult.items.length,
            totalCount: result.totalCount,
            offset: request.offset ?? 0,
            limit,
            ...(result.nextOffset !== undefined ? { nextOffset: result.nextOffset } : {}),
            hasMore: result.hasMore
          }),
          { type: 'text' as const, text: JSON.stringify(searchResult) }
        ]
      }
    }
  )

  if (handler.formatReferences) {
    server.registerTool(
      LITERATURE_LIBRARY_FORMAT_REFERENCES_TOOL_NAME,
      {
        title: 'Format literature references',
        description:
          'Format trusted Literature Library records for Markdown, plain text, or chat output. Pass only exact itemIds plus the requested CSL style and locale. Use the returned inText and reference strings verbatim; do not hand-format or invent citation metadata. For DOCX use format_citation_document instead.',
        inputSchema: {
          itemIds: z.array(z.string().trim().min(1).max(512)).min(1).max(20),
          styleId: z.enum(LITERATURE_CITATION_STYLES).default('apa'),
          locale: z.enum(LITERATURE_CITATION_LOCALES).default('en-US')
        }
      },
      async (request) => {
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
      }
    )
  }

  if (handler.formatCitationDocument) {
    server.registerTool(
      LITERATURE_LIBRARY_FORMAT_DOCUMENT_TOOL_NAME,
      {
        title: 'Format citation document',
        description:
          'Format and attach an already-saved DOCX that contains semantic {{cite:itemId}} markers and an optional {{bibliography}} marker. Open Science resolves the Literature items, formats the visible citations and bibliography, embeds Zotero-compatible Word Fields, and attaches the resulting DOCX with trusted citation provenance. The returned file is already attached; do not call write_artifact_file. Do not construct Zotero fields or repeat Literature metadata yourself.',
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
      async (request) => {
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
      }
    )
  }

  if (handler.prepareLatexBundle) {
    server.registerTool(
      LITERATURE_LIBRARY_PREPARE_LATEX_TOOL_NAME,
      {
        title: 'Prepare LaTeX bundle',
        description:
          'Prepare and attach an already-saved UTF-8 .tex file that contains semantic {{cite:itemId}} markers and an optional {{bibliography}} marker. Open Science resolves the Literature items, replaces markers with stable \\cite{key} commands, generates references.bib and a revision manifest, and attaches an Overleaf-compatible ZIP with trusted citation provenance. The source should use BibLaTeX with \\addbibresource{references.bib}; {{bibliography}} becomes \\printbibliography. The returned file is already attached; do not call write_artifact_file.',
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
      async (request) => {
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
      }
    )
  }

  server.registerTool(
    LITERATURE_LIBRARY_READ_ABSTRACT_TOOL_NAME,
    {
      title: 'Read literature abstracts',
      description:
        'Read the complete abstract for one Literature Library record, or bounded abstracts for up to five records in one call. Prefer itemIds for a small group of records whose search previews are insufficient; batch abstracts over 5,000 characters are compacted and marked abstractTruncated. Do not batch-read every search result. This reads metadata only, not PDF full text. Use the same scope as the originating search; scope defaults to the trusted current Project.',
      inputSchema: {
        itemId: z.string().trim().min(1).max(512).optional(),
        itemIds: z
          .array(z.string().trim().min(1).max(512))
          .min(1)
          .max(LITERATURE_LIBRARY_BATCH_ABSTRACT_LIMIT)
          .optional(),
        scope: z.enum(LITERATURE_LIBRARY_SCOPES).optional(),
        collectionId: z.string().trim().min(1).max(512).optional()
      }
    },
    async (request) => {
      const scope = request.scope ?? 'project'
      if ((request.itemId ? 1 : 0) + (request.itemIds ? 1 : 0) !== 1) {
        throw new Error('ABSTRACT_INPUT_REQUIRED: Pass exactly one of itemId or itemIds.')
      }
      if (request.itemIds && new Set(request.itemIds).size !== request.itemIds.length) {
        throw new Error('DUPLICATE_ITEM_IDS: Abstract reading does not accept duplicate itemIds.')
      }
      if (scope === 'collection' && !request.collectionId) {
        throw new Error('COLLECTION_ID_REQUIRED: Collection scope requires collectionId.')
      }
      if (scope !== 'collection' && request.collectionId) {
        throw new Error('COLLECTION_SCOPE_REQUIRED: collectionId requires Collection scope.')
      }
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
      if (!result) {
        throw new Error('LITERATURE_ITEM_NOT_FOUND: Literature Item is unavailable in this scope.')
      }
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
    }
  )

  server.registerTool(
    LITERATURE_LIBRARY_READ_PDF_TOOL_NAME,
    {
      title: 'Read literature PDF evidence',
      description:
        'Retrieve relevant passages with page numbers from one PDF attached to a Literature Library record. Use this only when the PDF could materially affect the answer, after finding the item with search_library. Each call reads one item on demand and reuses extraction and search data for the same immutable file version; it does not index the whole Library. Scope defaults to the trusted current Project.',
      inputSchema: {
        itemId: z.string().trim().min(1).max(512),
        attachmentId: z.string().trim().min(1).max(512).optional(),
        query: z.string().trim().min(1).max(2_000),
        scope: z.enum(LITERATURE_LIBRARY_SCOPES).optional(),
        collectionId: z.string().trim().min(1).max(512).optional()
      }
    },
    async (request) => {
      const scope = request.scope ?? 'project'
      if (scope === 'collection' && !request.collectionId) {
        throw new Error('COLLECTION_ID_REQUIRED: Collection scope requires collectionId.')
      }
      if (scope !== 'collection' && request.collectionId) {
        throw new Error('COLLECTION_SCOPE_REQUIRED: collectionId requires Collection scope.')
      }
      const result = await handler.readPdf({ ...request, scope })
      if (!result) {
        throw new Error('LITERATURE_ITEM_NOT_FOUND: Literature Item is unavailable in this scope.')
      }
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
    }
  )

  server.registerTool(
    LITERATURE_LIBRARY_SAVE_TOOL_NAME,
    {
      title: 'Save literature discoveries',
      description:
        'Save one to ten literature records discovered by the Agent to the user-level Literature Inbox for review. Open Science supplies the trusted current Project and Session origin; do not include origin fields. Prefer refs with pmid:<id> or doi:<id> so Open Science can retrieve the metadata. Use candidates only for records without a supported identifier. filename remains available for a prepared Notebook batch.',
      inputSchema: {
        refs: z
          .array(z.string().trim().min(1).max(512))
          .min(1)
          .max(10)
          .optional()
          .describe(
            'Preferred compact input, for example ["pmid:35486828", "doi:10.1016/j.cell.2011.03.019"].'
          ),
        candidates: z.array(literatureDiscoverySchema).min(1).max(10).optional(),
        filename: z
          .string()
          .trim()
          .min(1)
          .max(2_000)
          .optional()
          .describe(
            'Filename of a Notebook-owned JSON file containing {"candidates":[...]}. Use this for batches to avoid regenerating a large tool payload; do not construct a workspace prefix.'
          )
      }
    },
    async (request) => {
      const candidates = await resolveSaveCandidates(request, handler)
      const result = await handler.saveToInbox({ candidates })
      const titles = candidateTitles(candidates)
      return {
        structuredContent: result,
        content: [
          presentationContent({
            libraryAction: 'save',
            ...(titles.length > 0 ? { itemTitles: titles } : {}),
            candidateCount: candidates.length,
            savedCount: result.results.length
          }),
          { type: 'text' as const, text: JSON.stringify(result) }
        ]
      }
    }
  )

  if (handler.acquirePdf)
    server.registerTool(
      'acquire_pdf',
      {
        title: 'Acquire literature PDF',
        description:
          'Find and download one publicly accessible full-text PDF into Literature Inbox for user review. Supply either ref (DOI or PMID) or candidate metadata and its source. Omit pdfUrl to search the configured open full-text providers; supply pdfUrl only for a discovered public HTTPS PDF link. The PDF and metadata are kept in Inbox until the user accepts them. Existing library references are reused on acceptance. Downloads are limited to 50 MB; private network addresses, sign-in sessions and local file paths are not supported. Do not describe pending-review results as already added to the Library.',
        inputSchema: {
          ref: z.string().trim().min(1).max(512).optional(),
          candidate: literatureDiscoverySchema.optional(),
          pdfUrl: z.string().url().max(4096).optional()
        }
      },
      async ({ ref, candidate, pdfUrl }) => {
        const candidates = await resolveSaveCandidates(
          { refs: ref ? [ref] : undefined, candidates: candidate ? [candidate] : undefined },
          handler
        )
        if (candidates.length !== 1) throw new Error('Exactly one reference must be resolved.')
        const result = await handler.acquirePdf!({ candidate: candidates[0]!, pdfUrl })
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
      }
    )
  return server
}

export {
  LITERATURE_LIBRARY_MCP_SERVER_NAME,
  LITERATURE_LIBRARY_READ_ABSTRACT_TOOL_NAME,
  LITERATURE_LIBRARY_READ_PDF_TOOL_NAME,
  LITERATURE_LIBRARY_FORMAT_REFERENCES_TOOL_NAME,
  LITERATURE_LIBRARY_FORMAT_DOCUMENT_TOOL_NAME,
  LITERATURE_LIBRARY_PREPARE_LATEX_TOOL_NAME,
  LITERATURE_LIBRARY_SEARCH_DEFAULT_LIMIT,
  LITERATURE_LIBRARY_SAVE_TOOL_NAME,
  LITERATURE_LIBRARY_SEARCH_TOOL_NAME,
  createLiteratureLibraryMcpServer
}
export type {
  LiteratureLibraryDiscovery,
  LiteratureLibraryFormatDocumentRequest,
  LiteratureLibraryFormatDocumentResult,
  LiteratureLibraryFormatReferencesRequest,
  LiteratureLibraryFormatReferencesResult,
  LiteratureLibraryPrepareLatexRequest,
  LiteratureLibraryPrepareLatexResult,
  LiteratureLibraryMcpHandler,
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
