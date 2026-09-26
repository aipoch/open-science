import { randomUUID } from 'node:crypto'
import {
  type LiteratureMetadataCompletionRequest,
  type LiteratureMetadataCompletionResult,
  type LiteratureMetadataField
} from '../../shared/literature'
import { normalizeIdentifier, type LiteratureCatalog } from './catalog'
import { mergeMetadata, reviewIdentifiers, setLookupIdentifier } from './metadata-merge'
import { LiteratureReferenceResolver, identitiesAgree } from './reference-resolver'

type MetadataCatalog = Pick<LiteratureCatalog, 'applyMetadata' | 'get' | 'getMetadataCommitReceipt'>
type FetchFn = typeof fetch

class LiteratureMetadataEnricher {
  private readonly reviews = new Map<string, LiteratureMetadataCompletionResult>()
  constructor(
    private readonly catalog: MetadataCatalog,
    private readonly fetchFn: FetchFn = fetch
  ) {}

  async complete(
    request: LiteratureMetadataCompletionRequest
  ): Promise<LiteratureMetadataCompletionResult> {
    if (request.mode === 'commit') {
      const review = request.reviewToken ? this.reviews.get(request.reviewToken) : undefined
      if (
        !review ||
        review.item.id !== request.itemId ||
        review.item.metadataRevision !== request.expectedMetadataRevision
      )
        throw new Error('Search again and review the metadata before applying.')
      const result = await this.applyReviewed(review, request.overwriteFields)
      this.reviews.delete(request.reviewToken!)
      return result
    }
    const current = await this.catalog.get(request.itemId)
    if (!current) throw new Error('Literature Item is unavailable.')
    const identifier =
      request.identifier ??
      current.item.identifiers.find(({ scheme }) => scheme === 'doi' || scheme === 'pmid')
    if (!identifier || (identifier.scheme !== 'doi' && identifier.scheme !== 'pmid')) {
      throw new Error('A DOI or PMID is required to complete metadata.')
    }
    const value = normalizeIdentifier(identifier.scheme, identifier.value)
    if (identifier.scheme === 'pmid' && !/^\d+$/u.test(value)) {
      throw new Error('The PMID must contain digits only.')
    }
    let lookupItem = request.identifier
      ? setLookupIdentifier(current.item, identifier.scheme, value)
      : current.item
    const resolver = new LiteratureReferenceResolver(this.fetchFn)
    const isReplacement =
      request.identifier &&
      !current.item.identifiers.some(
        (entry) =>
          entry.scheme === identifier.scheme &&
          normalizeIdentifier(entry.scheme, entry.value) === value
      )
    if (isReplacement) {
      lookupItem = {
        ...lookupItem,
        identifiers: lookupItem.identifiers.filter(
          (entry) =>
            !['doi', 'pmid', 'pmcid'].includes(entry.scheme) || entry.scheme === identifier.scheme
        )
      }
    }
    const alternative = !isReplacement
      ? current.item.identifiers.find(
          (entry) =>
            (entry.scheme === 'doi' || entry.scheme === 'pmid') &&
            entry.scheme !== identifier.scheme
        )
      : undefined
    let discovery: Awaited<ReturnType<LiteratureReferenceResolver['lookup']>>
    try {
      discovery = await resolver.lookup(`${identifier.scheme}:${value}`)
    } catch (error) {
      if (!alternative) throw error
      discovery = await resolver.lookup(`${alternative.scheme}:${alternative.value}`)
      if (!identitiesAgree(lookupItem, discovery.item)) throw error
    }
    if (!identitiesAgree(lookupItem, discovery.item))
      throw new Error(
        'Reference identifiers disagree. Review the DOI and PMID before searching again.'
      )
    if (
      !discovery.item.abstract &&
      alternative &&
      !discovery.sources.some((source) => source.provider === 'pubmed')
    ) {
      try {
        const supplemental = await resolver.lookup(`${alternative.scheme}:${alternative.value}`)
        if (
          identitiesAgree(lookupItem, supplemental.item) &&
          identitiesAgree(discovery.item, supplemental.item)
        ) {
          discovery = {
            ...discovery,
            item: mergeMetadata(discovery.item, supplemental.item).item,
            sources: [...discovery.sources, ...supplemental.sources],
            failures: [...discovery.failures, ...supplemental.failures].slice(0, 10)
          }
        }
      } catch {
        /* An optional identifier must not discard the successful lookup. */
      }
    }
    const merged = mergeMetadata(lookupItem, discovery.item)
    reviewIdentifiers(current.item, merged)
    const source = discovery.source
    const provider = source.provider as LiteratureMetadataCompletionResult['provider']
    const result: LiteratureMetadataCompletionResult = {
      mode: 'preview',
      reviewVersion: 2,
      provider,
      sourceUrl: source.sourceUrl!,
      item: { ...current, item: merged.item },
      filled: merged.filled,
      conflicts: merged.conflicts,
      source,
      sources: discovery.sources,
      proposal: discovery.item,
      failures: discovery.failures,
      reviewToken: randomUUID()
    }
    this.reviews.set(result.reviewToken!, structuredClone(result))
    while (this.reviews.size > 100) this.reviews.delete(this.reviews.keys().next().value!)
    return result
  }

  // Only trusted main-process snapshots enter here; renderer commits use an opaque review token.
  async applyReviewed(
    review: LiteratureMetadataCompletionResult,
    overwriteFields: readonly LiteratureMetadataField[] = []
  ): Promise<LiteratureMetadataCompletionResult> {
    const current = await this.catalog.get(review.item.id)
    const operationId = review.reviewToken
      ? `${review.reviewToken}:${JSON.stringify([...new Set(overwriteFields)].sort())}`
      : undefined
    const receipt = operationId ? await this.catalog.getMetadataCommitReceipt(operationId) : null
    if (
      receipt &&
      current &&
      current.id === review.item.id &&
      !current.deletedAt &&
      receipt.itemId === review.item.id &&
      receipt.expectedMetadataRevision === review.item.metadataRevision &&
      current.metadataRevision >= receipt.committedMetadataRevision
    ) {
      return {
        mode: 'commit',
        provider: review.provider,
        sourceUrl: review.sourceUrl,
        item: current,
        filled: review.filled,
        conflicts: review.conflicts
      }
    }
    if (
      !current ||
      current.id !== review.item.id ||
      current.deletedAt ||
      current.metadataRevision !== review.item.metadataRevision
    )
      throw new Error('Reference changed. Search again and review the metadata.')
    if (review.reviewVersion !== 2 || !review.proposal || !review.sources?.length)
      throw new Error('Search again to refresh this older metadata review.')
    const merged = mergeMetadata(review.item.item, review.proposal, new Set(overwriteFields))
    // Identifier proposals are atomic: an unselected replacement must not ride along with fills.
    const identifierConflict = review.conflicts.find(({ field }) => field === 'identifiers')
    if (identifierConflict) {
      if (overwriteFields.includes('identifiers'))
        merged.filled.push({ field: 'identifiers', value: identifierConflict.value })
      else {
        merged.item.identifiers = structuredClone(current.item.identifiers)
        merged.conflicts.push(identifierConflict)
      }
    }
    const persistedItem = await this.catalog.applyMetadata({
      operationId,
      itemId: current.id,
      expectedMetadataRevision: review.item.metadataRevision,
      item: merged.item,
      source: review.sources[0],
      sources: review.sources
    })
    return {
      mode: 'commit',
      provider: review.provider,
      sourceUrl: review.sourceUrl,
      item: persistedItem,
      filled: [...review.filled, ...merged.filled],
      conflicts: merged.conflicts
    }
  }
}

export { LiteratureMetadataEnricher }
export { mergeCrossrefMetadata, mergePubmedMetadata, parseCrossrefResponse } from './metadata-merge'
