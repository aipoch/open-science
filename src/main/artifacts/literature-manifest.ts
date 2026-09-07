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
    if (searches.length >= MAX_SEARCHES_PER_PROMPT) return
    searches.push({
      criteria: {
        scope: request.scope,
        ...(request.query ? { query: request.query } : {}),
        ...(request.collectionId ? { collectionId: request.collectionId } : {}),
        ...(request.itemIds ? { itemIds: [...request.itemIds] } : {})
      },
      itemIds: request.result.items.map(({ id }) => id),
      totalCount: request.result.totalCount
    })
  }

  recordPdfRead(request: RecordArtifactLiteraturePdfReadRequest): void {
    const key = searchKey(request)
    let itemIds = this.fullTextReads.get(key)
    if (!itemIds) {
      if (this.fullTextReads.size >= MAX_RECORDED_PROMPTS) {
        const oldestKey = this.fullTextReads.keys().next().value
        if (oldestKey) this.fullTextReads.delete(oldestKey)
      }
      itemIds = new Set()
      this.fullTextReads.set(key, itemIds)
    }
    itemIds.add(request.itemId)
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
    const grouped = new Map<
      string,
      {
        criteria: ArtifactLiteratureRetrievalCriteria
        itemIds: Set<string>
        totalCount: number
      }
    >()
    for (const search of searches) {
      let retrieval = grouped.get(retrievalKey(search.criteria))
      if (!retrieval) {
        retrieval = {
          criteria: search.criteria,
          itemIds: new Set<string>(),
          totalCount: search.totalCount
        }
        grouped.set(retrievalKey(search.criteria), retrieval)
      }
      retrieval.totalCount = Math.max(retrieval.totalCount, search.totalCount)
      for (const itemId of search.itemIds) {
        retrieval.itemIds.add(itemId)
        searchedItemIds.add(itemId)
      }
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

    return {
      items: corpus.itemIds.map((itemId) => ({
        itemId,
        metadataRevision: itemsById.get(itemId)!.metadataRevision
      })),
      retrievals: [...grouped.values()].map(({ criteria, itemIds, totalCount }) => ({
        ...criteria,
        resultCount: itemIds.size,
        totalCount,
        complete: itemIds.size >= totalCount
      })),
      coverage: {
        searchedCount: searchedItemIds.size,
        candidateCount: corpus.candidateCount,
        fullTextCount,
        abstractOnlyCount: corpus.itemIds.length - fullTextCount,
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
