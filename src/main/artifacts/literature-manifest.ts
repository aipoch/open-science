import type { PrismaClient } from '@prisma/client'

import {
  artifactLiteratureManifestSchema,
  artifactLiteratureRequestSchema,
  type ArtifactLiteratureCorpusRequest,
  type ArtifactLiteratureManifest,
  type ArtifactLiteratureRetrievalCriteria
} from '../../shared/artifact-literature'
import type { CreateArtifactVersionRequest } from '../../shared/artifact-provenance'
import type { LiteratureItemView } from '../../shared/literature'
import { LiteratureCatalog } from '../literature/catalog'
import type { LiteratureLibrarySearchResult } from '../literature/library-mcp-server'
import { canonicalJson, sha256, type CanonicalJson } from './provenance-canonical'

type PreparedArtifactLiteratureManifest = {
  schemaVersion: 1
  styleId: string
  locale: string
  manifestJson: string
  checksum: string
}

type ArtifactLiteratureManifestContext = Pick<
  CreateArtifactVersionRequest,
  'projectId' | 'appSessionId' | 'promptMessageId'
>

type RecordArtifactLiteratureSearchRequest = ArtifactLiteratureManifestContext &
  ArtifactLiteratureRetrievalCriteria &
  Readonly<{
    offset?: number
    limit?: number
    result: LiteratureLibrarySearchResult
  }>

type RecordArtifactLiteraturePdfReadRequest = ArtifactLiteratureManifestContext &
  Readonly<{ itemId: string }>

type RecordedSearch = Readonly<{
  criteria: ArtifactLiteratureRetrievalCriteria
  itemIds: readonly string[]
  totalCount: number
  offset: number
}>

const MAX_RECORDED_PROMPTS = 100
const MAX_SEARCHES_PER_PROMPT = 100

const searchKey = ({
  projectId,
  appSessionId,
  promptMessageId
}: ArtifactLiteratureManifestContext): string =>
  `${projectId}\u0000${appSessionId}\u0000${promptMessageId}`

const retrievalKey = (criteria: ArtifactLiteratureRetrievalCriteria): string =>
  JSON.stringify([
    criteria.scope,
    criteria.query ?? '',
    criteria.collectionId ?? '',
    criteria.itemIds ?? []
  ])

class ArtifactLiteratureManifestOwner {
  private readonly catalog: LiteratureCatalog
  private readonly abstractReads = new Map<string, Set<string>>()
  private readonly fullTextReads = new Map<string, Set<string>>()
  private readonly searches = new Map<string, RecordedSearch[]>()

  constructor(getClient: () => Promise<PrismaClient>) {
    this.catalog = new LiteratureCatalog(getClient)
  }

  recordSearch(request: RecordArtifactLiteratureSearchRequest): void {
    const key = searchKey(request)
    let searches = this.searches.get(key)
    if (!searches) {
      if (this.searches.size >= MAX_RECORDED_PROMPTS) {
        const oldestKey = this.searches.keys().next().value
        if (oldestKey) this.searches.delete(oldestKey)
      }
      searches = []
      this.searches.set(key, searches)
    }
    const search: RecordedSearch = {
      criteria: {
        scope: request.scope,
        ...(request.query ? { query: request.query } : {}),
        ...(request.collectionId ? { collectionId: request.collectionId } : {}),
        ...(request.itemIds ? { itemIds: [...request.itemIds] } : {})
      },
      itemIds: [...new Set(request.result.items.map(({ id }) => id))],
      totalCount: request.result.totalCount,
      offset: request.offset ?? 0
    }
    const duplicate = searches.some(
      (recorded) =>
        retrievalKey(recorded.criteria) === retrievalKey(search.criteria) &&
        recorded.offset === search.offset &&
        recorded.totalCount === search.totalCount &&
        JSON.stringify(recorded.itemIds) === JSON.stringify(search.itemIds)
    )
    if (!duplicate) {
      if (searches.length >= MAX_SEARCHES_PER_PROMPT) {
        throw new Error(
          'LITERATURE_EVIDENCE_LIMIT: This turn has reached 100 distinct search results. The new result was not recorded. Save using already retrieved records, or start a new turn to search further.'
        )
      }
      searches.push(search)
    }
    // Search output always includes a nonzero-budget abstract preview when content is present.
    for (const view of request.result.items) {
      if (view.item?.abstract.trim()) this.recordAbstractRead({ ...request, itemId: view.id })
    }
  }

  recordAbstractRead(request: RecordArtifactLiteraturePdfReadRequest): void {
    this.recordRead(this.abstractReads, request)
  }

  private recordRead(
    reads: Map<string, Set<string>>,
    request: RecordArtifactLiteraturePdfReadRequest
  ): void {
    const key = searchKey(request)
    let itemIds = reads.get(key)
    if (!itemIds) {
      if (reads.size >= MAX_RECORDED_PROMPTS) {
        const oldestKey = reads.keys().next().value
        if (oldestKey) reads.delete(oldestKey)
      }
      itemIds = new Set()
      reads.set(key, itemIds)
    }
    itemIds.add(request.itemId)
  }

  recordPdfRead(request: RecordArtifactLiteraturePdfReadRequest): void {
    this.recordRead(this.fullTextReads, request)
  }

  async prepare(
    request: CreateArtifactVersionRequest['literature'],
    context?: ArtifactLiteratureManifestContext
  ): Promise<PreparedArtifactLiteratureManifest | undefined> {
    if (!request) return undefined
    const parsed = artifactLiteratureRequestSchema.parse(request)
    const itemIds = [
      ...new Set([
        ...parsed.citations.map(({ itemId }) => itemId),
        ...(parsed.corpus?.itemIds ?? [])
      ])
    ]
    const items = await this.catalog.getMany(itemIds)
    const itemsById = new Map(items.map((item) => [item.id, item]))
    for (const itemId of itemIds) {
      const view = itemsById.get(itemId)
      if (!view) throw new Error(`Literature Item is unavailable: ${itemId}`)
    }
    const citedItemIds = [...new Set(parsed.citations.map(({ itemId }) => itemId))]
    const references = citedItemIds.map((itemId) => {
      const view = itemsById.get(itemId)!
      return { itemId, metadataRevision: view.metadataRevision, item: view.item }
    })
    const corpus = parsed.corpus ? this.prepareCorpus(parsed.corpus, itemsById, context) : undefined
    const citations = parsed.citations.map((citation) => ({
      ...citation,
      metadataRevision: itemsById.get(citation.itemId)!.metadataRevision
    }))
    const manifest: ArtifactLiteratureManifest = artifactLiteratureManifestSchema.parse({
      schemaVersion: 1,
      styleId: parsed.styleId,
      locale: parsed.locale,
      references,
      ...(corpus ? { corpus } : {}),
      citations
    })
    const manifestJson = canonicalJson(JSON.parse(JSON.stringify(manifest)) as CanonicalJson)
    return {
      schemaVersion: 1,
      styleId: manifest.styleId,
      locale: manifest.locale,
      manifestJson,
      checksum: sha256(manifestJson)
    }
  }

  private prepareCorpus(
    corpus: ArtifactLiteratureCorpusRequest,
    itemsById: ReadonlyMap<string, LiteratureItemView>,
    context: ArtifactLiteratureManifestContext | undefined
  ): NonNullable<ArtifactLiteratureManifest['corpus']> {
    if (!context) throw new Error('Literature review corpus requires trusted Artifact context.')
    const searches = this.searches.get(searchKey(context)) ?? []
    if (searches.length === 0) {
      throw new Error('Literature review corpus requires a search_library retrieval this turn.')
    }

    const searchedItemIds = new Set<string>()
    for (const search of searches) {
      for (const itemId of search.itemIds) searchedItemIds.add(itemId)
    }

    for (const itemId of corpus.itemIds) {
      if (!searchedItemIds.has(itemId)) {
        throw new Error(
          `Frozen corpus item was not returned by search_library this turn: ${itemId}`
        )
      }
    }
    if (corpus.candidateCount > searchedItemIds.size) {
      throw new Error('Candidate count cannot exceed records returned by search_library this turn.')
    }
    const fullTextItemIds = this.fullTextReads.get(searchKey(context)) ?? new Set<string>()
    const fullTextCount = corpus.itemIds.filter((itemId) => fullTextItemIds.has(itemId)).length

    const abstractItemIds = this.abstractReads.get(searchKey(context)) ?? new Set<string>()
    const abstractOnlyCount = corpus.itemIds.filter(
      (itemId) => !fullTextItemIds.has(itemId) && abstractItemIds.has(itemId)
    ).length

    return {
      items: corpus.itemIds.map((itemId) => ({
        itemId,
        metadataRevision: itemsById.get(itemId)!.metadataRevision,
        item: itemsById.get(itemId)!.item
      })),
      retrievals: searches.map(({ criteria, itemIds, totalCount, offset }) => ({
        ...criteria,
        offset,
        resultCount: itemIds.length,
        totalCount,
        complete: itemIds.length >= totalCount
      })),
      coverage: {
        searchedCount: searchedItemIds.size,
        candidateCount: corpus.candidateCount,
        fullTextCount,
        abstractOnlyCount,
        metadataOnlyCount: corpus.itemIds.length - fullTextCount - abstractOnlyCount,
        unprocessedCount: searchedItemIds.size - corpus.candidateCount
      },
      capturedAt: new Date().toISOString()
    }
  }
}

export { ArtifactLiteratureManifestOwner }
export type {
  ArtifactLiteratureManifestContext,
  PreparedArtifactLiteratureManifest,
  RecordArtifactLiteraturePdfReadRequest,
  RecordArtifactLiteratureSearchRequest
}
