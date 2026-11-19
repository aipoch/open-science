import { literatureItemInputSchema } from '@aipoch/literature-library/contracts'
import type {
  LiteratureRelatedRequest,
  LiteratureRelatedRecord,
  LiteratureRelatedResult
} from '@aipoch/literature-discovery/contracts'

// Only the transport is deterministic: the Library, detail dialog and graph are production UI.
export function citationGraphResult(
  request: LiteratureRelatedRequest,
  emptyReferences = false,
  mutualPaper = false
): LiteratureRelatedResult {
  const paper = (id: number): LiteratureRelatedRecord => ({
    paperId: `europe-pmc:MED:${id}`,
    item: literatureItemInputSchema.parse({
      itemType: 'journalArticle',
      title: `Graph paper ${id}: a study with a deliberately long descriptive title`,
      creators: [
        { creatorType: 'author', nameMode: 'person', familyName: `Author ${id}`, givenName: 'Ada' }
      ],
      issuedYear: 2024,
      abstract: id === 1101 ? '' : 'An inspectable abstract. '.repeat(80),
      containerTitle: 'Graph interaction journal',
      identifiers: [{ scheme: 'pmid', value: String(id) }],
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`
    })
  })
  const center = Number(request.seedPaperId?.split(':').at(-1) ?? 1000)
  const base = request.direction === 'references' ? 1100 : 1200
  const offset = request.offset ?? 0
  return {
    itemId: request.itemId,
    metadataRevision: request.expectedMetadataRevision,
    direction: request.direction,
    state: 'ready',
    provider: 'europe-pmc',
    seed: paper(center),
    resolutionToken: `00000000-0000-4000-8000-${String(center).padStart(12, '0')}`,
    records:
      emptyReferences && request.direction === 'references'
        ? []
        : Array.from({ length: 20 }, (_, index) =>
            paper(
              mutualPaper && request.direction === 'citations' && offset === 0 && index === 0
                ? 1100
                : base + offset + index
            )
          ),
    ...(offset === 0 && !(emptyReferences && request.direction === 'references')
      ? { nextOffset: 20 }
      : {})
  }
}
