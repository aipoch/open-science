import {
  literatureItemInputSchema,
  type LiteratureItemInput,
  type LiteratureSourceInput
} from '../../shared/literature'
import { normalizeIdentifier } from './catalog'
import { LiteratureCitationFormatter } from './citation-formatter'
import { mergeCrossrefMetadata, parseCrossrefResponse } from './metadata-enricher'

const CROSSREF_BASE = 'https://api.crossref.org/works/'
const PUBMED_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi'
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000

type FetchFn = typeof fetch
type LiteratureReferenceDiscovery = Readonly<{
  item: LiteratureItemInput
  source: LiteratureSourceInput
}>

type ReferenceKey = Readonly<{
  key: string
  scheme: 'doi' | 'pmid'
  value: string
}>

const parseReference = (input: string): ReferenceKey => {
  const separator = input.indexOf(':')
  const scheme = separator >= 0 ? input.slice(0, separator).trim().toLowerCase() : ''
  const rawValue = separator >= 0 ? input.slice(separator + 1) : ''
  if (scheme !== 'doi' && scheme !== 'pmid') {
    throw new Error(`UNSUPPORTED_REFERENCE: Use pmid:<id> or doi:<id>; received "${input}".`)
  }
  const value = normalizeIdentifier(scheme, rawValue)
  if (scheme === 'pmid' && !/^\d+$/u.test(value)) {
    throw new Error(`INVALID_PMID: "${input}" does not contain a valid PMID.`)
  }
  if (scheme === 'doi' && !/^10\.\d{4,9}\/\S+$/u.test(value)) {
    throw new Error(`INVALID_DOI: "${input}" does not contain a valid DOI.`)
  }
  return { key: `${scheme}:${value}`, scheme, value }
}

const crossrefItemType = (type: string | undefined): LiteratureItemInput['itemType'] => {
  switch (type) {
    case 'book':
    case 'edited-book':
    case 'monograph':
    case 'reference-book':
      return 'book'
    case 'book-chapter':
    case 'book-part':
    case 'book-section':
    case 'reference-entry':
      return 'bookSection'
    case 'dataset':
      return 'dataset'
    case 'dissertation':
      return 'thesis'
    case 'posted-content':
      return 'preprint'
    case 'proceedings-article':
      return 'conferencePaper'
    case 'report':
    case 'report-series':
      return 'report'
    case 'standard':
    case 'standard-series':
      return 'standard'
    default:
      return 'journalArticle'
  }
}

const readResponse = async (response: Response, provider: string): Promise<string> => {
  if (!response.ok) {
    throw new Error(`${provider} metadata request failed with HTTP ${response.status}.`)
  }
  const body = await response.text()
  if (body.length > MAX_RESPONSE_BYTES) {
    throw new Error(`${provider} metadata response is too large.`)
  }
  return body
}

class LiteratureReferenceResolver {
  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly formatter: Pick<
      LiteratureCitationFormatter,
      'parseReferences'
    > = new LiteratureCitationFormatter()
  ) {}

  async resolve(inputs: readonly string[]): Promise<readonly LiteratureReferenceDiscovery[]> {
    const references = [
      ...new Map(inputs.map(parseReference).map((ref) => [ref.key, ref])).values()
    ]
    const pmids = references.filter(({ scheme }) => scheme === 'pmid').map(({ value }) => value)
    const discoveries = new Map<string, LiteratureReferenceDiscovery>()

    await Promise.all([
      this.resolvePubmed(pmids, discoveries),
      ...references
        .filter(({ scheme }) => scheme === 'doi')
        .map(({ value }) => this.resolveCrossref(value, discoveries))
    ])

    return references.map(({ key }) => {
      const discovery = discoveries.get(key)
      if (!discovery) throw new Error(`REFERENCE_NOT_FOUND: No metadata was found for ${key}.`)
      return discovery
    })
  }

  private async resolvePubmed(
    pmids: readonly string[],
    discoveries: Map<string, LiteratureReferenceDiscovery>
  ): Promise<void> {
    if (pmids.length === 0) return
    const params = new URLSearchParams({
      db: 'pubmed',
      id: pmids.join(','),
      rettype: 'medline',
      retmode: 'text',
      tool: 'Open-Science'
    })
    const response = await this.fetchFn(`${PUBMED_BASE}?${params.toString()}`, {
      headers: {
        Accept: 'text/plain',
        'User-Agent': 'Open-Science/1.0 (+https://github.com/aipoch/open-science)'
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    const parsed = await this.formatter.parseReferences(await readResponse(response, 'PubMed'))
    for (const item of parsed.items) {
      const pmid = item.identifiers.find(({ scheme }) => scheme === 'pmid')?.value
      if (!pmid) continue
      const value = normalizeIdentifier('pmid', pmid)
      if (!pmids.includes(value)) continue
      discoveries.set(`pmid:${value}`, {
        item,
        source: {
          provider: 'pubmed',
          externalId: value,
          sourceUrl: `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(value)}/`,
          rawMetadata: { format: 'pubmed-medline', normalizedRecord: item }
        }
      })
    }
  }

  private async resolveCrossref(
    doi: string,
    discoveries: Map<string, LiteratureReferenceDiscovery>
  ): Promise<void> {
    const sourceUrl = `${CROSSREF_BASE}${encodeURIComponent(doi)}`
    const response = await this.fetchFn(sourceUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Open-Science/1.0 (+https://github.com/aipoch/open-science)'
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    const message = parseCrossrefResponse(await readResponse(response, 'Crossref'))
    const responseDoi = normalizeIdentifier('doi', message.DOI ?? doi)
    if (responseDoi !== doi) throw new Error('Crossref returned metadata for a different DOI.')
    const title = message.title?.[0]?.trim()
    if (!title) throw new Error(`REFERENCE_NOT_FOUND: Crossref returned no title for doi:${doi}.`)
    const seed = literatureItemInputSchema.parse({
      itemType: crossrefItemType(message.type),
      title,
      identifiers: [{ scheme: 'doi', value: doi, isPrimary: true }]
    })
    const item = mergeCrossrefMetadata(seed, message).item
    discoveries.set(`doi:${doi}`, {
      item,
      source: {
        provider: 'crossref',
        externalId: doi,
        sourceUrl,
        rawMetadata: message
      }
    })
  }
}

export { LiteratureReferenceResolver }
export type { LiteratureReferenceDiscovery }
