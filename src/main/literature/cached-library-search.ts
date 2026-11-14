import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import type { CachedTextSearchResult } from '@aipoch/literature-reading'
import type { LiteratureCatalog } from './catalog'
import type { LiteratureDocumentReader } from './document-reader'
import type { LiteratureLibraryScope } from './library-mcp-server'

export type CachedLibrarySearchRequest = Readonly<{
  projectId: string
  query: string
  scope?: LiteratureLibraryScope
  collectionId?: string
  itemIds?: readonly string[]
  offset?: number
  limit?: number
  signal?: AbortSignal
}>

export type CachedLibrarySearchResult = Omit<CachedTextSearchResult, 'passages'> & {
  scope: 'cached-text-only'
  recordCount: number
  totalRecordCount: number
  nextOffset?: number
  sourceSelectionTruncated: boolean
  resultsRevalidated: boolean
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
}

const MAX_RECORDS = 20
const MAX_SOURCES = 100
type CachedLibrarySource = {
  itemId: string
  title: string
  attachmentId: string
  version: LiteratureItemView['attachments'][number]['versions'][number]
}
const currentPdfSources = (items: readonly LiteratureItemView[]): CachedLibrarySource[] =>
  items.flatMap((item) =>
    item.attachments.flatMap((attachment) => {
      const version = attachment.versions.reduce<(typeof attachment.versions)[number] | undefined>(
        (latest, candidate) =>
          !latest || candidate.versionNumber > latest.versionNumber ? candidate : latest,
        undefined
      )
      if (
        !version ||
        (version.contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/pdf' &&
          !version.filename.toLowerCase().endsWith('.pdf'))
      )
        return []
      return [{ itemId: item.id, title: item.item.title, attachmentId: attachment.id, version }]
    })
  )

/** Catalog owns scope/version authority; Reader owns extraction identity and cache retrieval. */
export const searchCachedLibraryText = async (
  catalog: Pick<LiteratureCatalog, 'searchForAgent'>,
  reader: Partial<Pick<LiteratureDocumentReader, 'searchCachedAttachments'>> | undefined,
  request: CachedLibrarySearchRequest
): Promise<CachedLibrarySearchResult> => {
  request.signal?.throwIfAborted()
  const scope = request.scope ?? 'project'
  const filter = {
    scope: 'library' as const,
    ...(scope === 'project' ? { projectId: request.projectId } : {}),
    ...(scope === 'collection' ? { collectionId: request.collectionId } : {}),
    ...(scope === 'items' ? { itemIds: [...(request.itemIds ?? [])] } : {})
  }
  // No metadata keyword gate: body-only matches must remain eligible.
  const page = await catalog.searchForAgent({
    ...filter,
    offset: request.offset,
    limit: MAX_RECORDS
  })
  request.signal?.throwIfAborted()
  const items = page.entries.filter((entry): entry is LiteratureItemView => 'item' in entry)
  const sources = currentPdfSources(items)
  const unavailableCount = sources.filter(
    ({ version }) => version.availability === 'unavailable'
  ).length
  const availableSources = sources.filter(({ version }) => version.availability !== 'unavailable')
  const selected = availableSources.slice(0, MAX_SOURCES)
  const result = reader?.searchCachedAttachments
    ? await reader.searchCachedAttachments({
        projectId: request.projectId,
        attachments: selected.map(({ attachmentId, version }) => ({
          attachmentId,
          attachmentVersionId: version.id,
          filename: version.filename,
          sizeBytes: version.sizeBytes,
          checksum: version.checksum
        })),
        query: request.query,
        limit: request.limit,
        signal: request.signal
      })
    : {
        status: 'unavailable' as const,
        retrievalMode: 'bm25' as const,
        coverage: {
          requestedDocuments: selected.length,
          cachedDocuments: 0,
          notCachedDocuments: 0,
          unavailableDocuments: selected.length
        },
        passages: [],
        truncated: false
      }
  request.signal?.throwIfAborted()

  // Re-read authoritative current scope after asynchronous index/authorization work.
  // A deleted, moved or superseded source must not be rebound to an old cached hit.
  const current = result.passages.length
    ? await catalog.searchForAgent({
        ...filter,
        itemIds: [...new Set(selected.map(({ itemId }) => itemId))],
        limit: MAX_RECORDS
      })
    : undefined
  request.signal?.throwIfAborted()
  const valid = currentPdfSources(
    current?.entries.filter((entry): entry is LiteratureItemView => 'item' in entry) ?? []
  ).filter(({ version }) => version.availability !== 'unavailable')
  const verifiedMatches = result.passages.flatMap((passage) =>
    selected.flatMap((source) => {
      if (source.version.id !== passage.documentId) return []
      const verified = valid.find(
        (candidate) =>
          candidate.itemId === source.itemId &&
          candidate.attachmentId === source.attachmentId &&
          candidate.version.id === source.version.id &&
          candidate.version.checksum === source.version.checksum
      )
      return verified
        ? [
            {
              itemId: verified.itemId,
              title: verified.title.slice(0, 500),
              attachmentId: verified.attachmentId,
              attachmentVersionId: verified.version.id,
              pageStart: passage.pageStart,
              pageEnd: passage.pageEnd,
              content: passage.content.slice(0, 1_000),
              contentTruncated: passage.content.length > 1_000
            }
          ]
        : []
    })
  )
  const response = {
    status: result.status,
    retrievalMode: result.retrievalMode,
    coverage: {
      ...result.coverage,
      requestedDocuments: result.coverage.requestedDocuments + unavailableCount,
      unavailableDocuments: result.coverage.unavailableDocuments + unavailableCount
    },
    scope: 'cached-text-only' as const,
    recordCount: items.length,
    totalRecordCount: page.totalCount ?? items.length,
    ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
    sourceSelectionTruncated: availableSources.length > MAX_SOURCES,
    resultsRevalidated: verifiedMatches.length === result.passages.length
  }
  const matches: typeof verifiedMatches = []
  for (const match of verifiedMatches) {
    // Include the response envelope and JSON escaping; false is one byte larger than true.
    const size = Buffer.byteLength(
      JSON.stringify({ ...response, truncated: false, matches: [...matches, match] }),
      'utf8'
    )
    if (matches.length < Math.min(Math.max(request.limit ?? 8, 1), 8) && size <= 24_000)
      matches.push(match)
  }
  return {
    ...response,
    truncated: result.truncated || matches.length < verifiedMatches.length,
    matches
  }
}
