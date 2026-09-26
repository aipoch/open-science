import { z } from 'zod'
import {
  literatureItemInputSchema,
  type LiteratureItemInput,
  type LiteratureSourceInput
} from '../../shared/literature'
import type { LiteratureFailure } from '../../shared/literature-failure'
import { normalizeIdentifier } from './catalog'
import { LiteratureCitationFormatter } from './citation-formatter'
import {
  metadataProposalSchema,
  mergeMetadata,
  mergeCrossrefMetadata,
  parseCrossrefResponse,
  crossrefAbstract
} from './metadata-merge'
import { LiteratureProviderError, literatureFailure } from './provider-error'

const CROSSREF_BASE = 'https://api.crossref.org/works/'
const PUBMED_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000

type FetchFn = typeof fetch
type LiteratureReferenceDiscovery = Readonly<{
  item: LiteratureItemInput
  source: LiteratureSourceInput
}>
type MetadataLookup = LiteratureReferenceDiscovery & {
  sources: LiteratureSourceInput[]
  failures: LiteratureFailure[]
}

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

const europeRecordSchema = z
  .object({
    id: z.string(),
    source: z.string(),
    doi: z.string().optional(),
    pmcid: z.string().optional(),
    title: z.string(),
    abstractText: z.string().optional(),
    firstPublicationDate: z.string().optional(),
    pubYear: z.string().optional(),
    language: z.string().optional(),
    authorList: z
      .object({
        author: z.array(
          z.object({
            firstName: z.string().optional(),
            lastName: z.string().optional(),
            fullName: z.string().optional(),
            collectiveName: z.string().optional()
          })
        )
      })
      .optional(),
    journalInfo: z
      .object({
        volume: z.string().optional(),
        issue: z.string().optional(),
        journal: z.object({ title: z.string().optional(), issn: z.string().optional() }).optional()
      })
      .optional(),
    pageInfo: z.string().optional()
  })
  .passthrough()
const europeSchema = z.object({ resultList: z.object({ result: z.array(europeRecordSchema) }) })
const dataciteSchema = z.object({
  data: z.object({
    attributes: z
      .object({
        doi: z.string(),
        titles: z.array(z.object({ title: z.string() })),
        descriptions: z
          .array(z.object({ description: z.string(), descriptionType: z.string() }))
          .optional(),
        creators: z
          .array(
            z.object({
              name: z.string(),
              nameType: z.string().optional(),
              givenName: z.string().optional(),
              familyName: z.string().optional()
            })
          )
          .optional(),
        publicationYear: z.number().int().optional(),
        publisher: z.union([z.string(), z.object({ name: z.string() })]).optional(),
        url: z.string().nullable().optional(),
        language: z.string().nullable().optional(),
        types: z.object({ resourceTypeGeneral: z.string().optional() }).optional()
      })
      .passthrough()
  })
})

// Require a shared identity and reject contradictory identifiers before merging sources.
const identitiesAgree = (left: LiteratureItemInput, right: LiteratureItemInput): boolean =>
  left.identifiers.some(
    (identifier) =>
      (identifier.scheme === 'doi' || identifier.scheme === 'pmid') &&
      right.identifiers.some(
        (candidate) =>
          candidate.scheme === identifier.scheme &&
          normalizeIdentifier(candidate.scheme, candidate.value) ===
            normalizeIdentifier(identifier.scheme, identifier.value)
      )
  ) &&
  left.identifiers
    .filter(({ scheme }) => scheme === 'doi' || scheme === 'pmid')
    .every((identifier) => {
      const candidates = right.identifiers.filter(({ scheme }) => scheme === identifier.scheme)
      return (
        !candidates.length ||
        candidates.every(
          (candidate) =>
            normalizeIdentifier(candidate.scheme, candidate.value) ===
            normalizeIdentifier(identifier.scheme, identifier.value)
        )
      )
    })

class LiteratureReferenceResolver {
  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly formatter: Pick<
      LiteratureCitationFormatter,
      'parseReferences'
    > = new LiteratureCitationFormatter()
  ) {}

  private async read(url: string, accept: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const response = await this.fetchFn(url, {
      headers: {
        Accept: accept,
        'User-Agent': 'Open-Science/1.0 (+https://github.com/aipoch/open-science)'
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new LiteratureProviderError(response.status)
    }
    if (!response.body) throw new Error('Metadata response is empty.')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > MAX_RESPONSE_BYTES) throw new Error('Metadata response is too large.')
        chunks.push(value)
      }
    } finally {
      await reader.cancel()
    }
    signal?.throwIfAborted()
    return Buffer.concat(chunks).toString('utf8')
  }

  private async pubmed(
    pmids: readonly string[],
    signal?: AbortSignal
  ): Promise<LiteratureReferenceDiscovery[]> {
    if (!pmids.length) return []
    const params = new URLSearchParams({
      db: 'pubmed',
      id: pmids.join(','),
      rettype: 'medline',
      retmode: 'text',
      tool: 'OpenScience'
    })
    const parsed = await this.formatter.parseReferences(
      await this.read(`${PUBMED_BASE}?${params}`, 'text/plain', signal)
    )
    return parsed.items.flatMap((item) => {
      const pmid = item.identifiers.find(({ scheme }) => scheme === 'pmid')?.value
      if (!pmid || !pmids.includes(pmid)) return []
      return [
        {
          item,
          source: {
            provider: 'pubmed',
            externalId: pmid,
            sourceUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
            rawMetadata: { format: 'pubmed-medline', normalizedRecord: item }
          }
        }
      ]
    })
  }

  private async crossref(doi: string, signal?: AbortSignal): Promise<LiteratureReferenceDiscovery> {
    const sourceUrl = `${CROSSREF_BASE}${encodeURIComponent(doi)}`
    const message = parseCrossrefResponse(await this.read(sourceUrl, 'application/json', signal))
    if (normalizeIdentifier('doi', message.DOI ?? doi) !== doi)
      throw new Error('Crossref returned metadata for a different DOI.')
    const seed = metadataProposalSchema.parse({
      itemType: crossrefItemType(message.type),
      identifiers: [{ scheme: 'doi', value: doi, isPrimary: true }]
    })
    return {
      item: mergeCrossrefMetadata(seed, message).item,
      source: { provider: 'crossref', externalId: doi, sourceUrl, rawMetadata: message }
    }
  }

  private async europe(
    reference: ReferenceKey,
    signal?: AbortSignal
  ): Promise<LiteratureReferenceDiscovery> {
    // Quoting and escaping keep a DOI suffix from changing the provider's query semantics.
    const escaped = reference.value.replace(/[\\"]/gu, '\\$&')
    const query =
      reference.scheme === 'doi' ? `DOI:"${escaped}"` : `EXT_ID:${reference.value} AND SRC:MED`
    const sourceUrl = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?${new URLSearchParams({ query, resultType: 'core', format: 'json', pageSize: '5' })}`
    const records = europeSchema.parse(
      JSON.parse(await this.read(sourceUrl, 'application/json', signal))
    ).resultList.result
    const matches = records.filter((record) =>
      reference.scheme === 'doi'
        ? normalizeIdentifier('doi', record.doi ?? '') === reference.value
        : record.source === 'MED' && record.id === reference.value
    )
    if (matches.length !== 1) throw new LiteratureProviderError(404)
    const record = matches[0]
    const identifiers: LiteratureItemInput['identifiers'] = [
      { scheme: reference.scheme, value: reference.value, isPrimary: true }
    ]
    if (record.doi && reference.scheme !== 'doi')
      identifiers.push({ scheme: 'doi', value: record.doi, isPrimary: false })
    if (record.source === 'MED' && reference.scheme !== 'pmid')
      identifiers.push({ scheme: 'pmid', value: record.id, isPrimary: false })
    if (record.pmcid) identifiers.push({ scheme: 'pmcid', value: record.pmcid, isPrimary: false })
    const year = Number(record.pubYear ?? record.firstPublicationDate?.slice(0, 4))
    const item = metadataProposalSchema.parse({
      itemType: 'journalArticle',
      title: record.title,
      abstract: crossrefAbstract(record.abstractText),
      identifiers,
      containerTitle: record.journalInfo?.journal?.title ?? '',
      language: record.language ?? '',
      issuedText: record.firstPublicationDate ?? record.pubYear ?? '',
      issuedYear: Number.isInteger(year) && year > 0 && year <= 9999 ? year : undefined,
      url:
        reference.scheme === 'doi'
          ? `https://doi.org/${reference.value}`
          : `https://pubmed.ncbi.nlm.nih.gov/${reference.value}/`,
      typeFields: Object.fromEntries(
        Object.entries({
          volume: record.journalInfo?.volume,
          issue: record.journalInfo?.issue,
          pages: record.pageInfo
        }).filter(([, value]) => value)
      ),
      creators:
        record.authorList?.author.flatMap<LiteratureItemInput['creators'][number]>((author) =>
          author.collectiveName
            ? [
                {
                  nameMode: 'organization',
                  literalName: author.collectiveName,
                  creatorType: 'author'
                }
              ]
            : author.lastName || author.firstName || author.fullName
              ? [
                  {
                    nameMode: 'person',
                    familyName: author.lastName ?? author.fullName ?? '',
                    givenName: author.firstName ?? '',
                    creatorType: 'author'
                  }
                ]
              : []
        ) ?? []
    })
    return {
      item,
      source: { provider: 'europe-pmc', externalId: record.id, sourceUrl, rawMetadata: record }
    }
  }

  private async datacite(doi: string, signal?: AbortSignal): Promise<LiteratureReferenceDiscovery> {
    const sourceUrl = `https://api.datacite.org/dois/${encodeURIComponent(doi)}`
    const record = dataciteSchema.parse(
      JSON.parse(await this.read(sourceUrl, 'application/json', signal))
    ).data.attributes
    if (normalizeIdentifier('doi', record.doi) !== doi)
      throw new Error('DataCite returned metadata for a different DOI.')
    const type = record.types?.resourceTypeGeneral
    const item = metadataProposalSchema.parse({
      itemType:
        type === 'Dataset'
          ? 'dataset'
          : type === 'Preprint'
            ? 'preprint'
            : type === 'Book'
              ? 'book'
              : type === 'Dissertation'
                ? 'thesis'
                : 'journalArticle',
      title: record.titles[0]?.title ?? '',
      abstract: crossrefAbstract(
        record.descriptions?.find(({ descriptionType }) => descriptionType === 'Abstract')
          ?.description
      ),
      issuedYear: record.publicationYear,
      issuedText: record.publicationYear ? String(record.publicationYear) : '',
      url: record.url ?? `https://doi.org/${doi}`,
      language: record.language ?? '',
      identifiers: [{ scheme: 'doi', value: doi, isPrimary: true }],
      typeFields: record.publisher
        ? {
            publisher:
              typeof record.publisher === 'string' ? record.publisher : record.publisher.name
          }
        : {},
      creators:
        record.creators?.map((creator) =>
          creator.nameType === 'Organizational'
            ? { nameMode: 'organization', literalName: creator.name, creatorType: 'author' }
            : {
                nameMode: 'person',
                familyName: creator.familyName ?? creator.name,
                givenName: creator.givenName ?? '',
                creatorType: 'author'
              }
        ) ?? []
    })
    return {
      item,
      source: { provider: 'datacite', externalId: doi, sourceUrl, rawMetadata: record }
    }
  }

  async lookup(input: string, signal?: AbortSignal): Promise<MetadataLookup> {
    const reference = parseReference(input)
    signal?.throwIfAborted()
    let primary: LiteratureReferenceDiscovery | undefined
    let primaryError: unknown
    const failures: LiteratureFailure[] = []
    const sources: LiteratureSourceInput[] = []
    const accept = (result: LiteratureReferenceDiscovery): void => {
      if (primary && !identitiesAgree(primary.item, result.item))
        throw new Error('Metadata sources returned conflicting identifiers.')
      primary = primary
        ? { ...primary, item: mergeMetadata(primary.item, result.item).item }
        : result
      sources.push(result.source)
    }
    try {
      const result =
        reference.scheme === 'doi'
          ? await this.crossref(reference.value, signal)
          : (await this.pubmed([reference.value], signal))[0]
      if (!result) throw new LiteratureProviderError(404)
      accept(result)
    } catch (error) {
      signal?.throwIfAborted()
      primaryError = error
      failures.push(
        literatureFailure(error, 'search', reference.scheme === 'doi' ? 'crossref' : 'pubmed')
      )
    }
    // DataCite is a different registration agency, not a mirror for transient Crossref failures.
    if (
      !primary &&
      reference.scheme === 'doi' &&
      primaryError instanceof LiteratureProviderError &&
      primaryError.status === 404
    ) {
      try {
        accept(await this.datacite(reference.value, signal))
      } catch (error) {
        signal?.throwIfAborted()
        failures.push(literatureFailure(error, 'search', 'datacite'))
        if (['network', 'timeout', 'rate-limit'].includes(literatureFailure(error, 'search').code))
          primaryError = error
      }
    }
    if (!primary?.item.abstract || !primary.item.title.trim()) {
      try {
        accept(await this.europe(reference, signal))
      } catch (error) {
        signal?.throwIfAborted()
        failures.push(literatureFailure(error, 'search', 'europe-pmc'))
        if (
          primaryError instanceof LiteratureProviderError &&
          primaryError.status === 404 &&
          ['network', 'timeout', 'rate-limit'].includes(literatureFailure(error, 'search').code)
        )
          primaryError = error
      }
    }
    signal?.throwIfAborted()
    if (!primary) throw primaryError ?? new LiteratureProviderError(404)
    return { ...primary, sources, failures: failures.filter(({ code }) => code !== 'no-result') }
  }

  async resolve(
    inputs: readonly string[],
    signal?: AbortSignal
  ): Promise<readonly LiteratureReferenceDiscovery[]> {
    signal?.throwIfAborted()
    const requested = inputs.map(parseReference)
    const references = [...new Map(requested.map((ref) => [ref.key, ref])).values()]
    const discoveries = new Map<string, LiteratureReferenceDiscovery>()
    const pmids = references.filter(({ scheme }) => scheme === 'pmid').map(({ value }) => value)
    // Retain the existing compact EFetch batch and ordered receipt contract for Agent imports.
    if (pmids.length) {
      try {
        for (const result of await this.pubmed(pmids, signal)) {
          const pmid = result.item.identifiers.find(({ scheme }) => scheme === 'pmid')!.value
          discoveries.set(`pmid:${pmid}`, result)
        }
      } catch {
        signal?.throwIfAborted()
      }
    }
    for (const ref of references) {
      if (discoveries.get(ref.key)?.item.abstract) continue
      try {
        const result = await this.lookup(ref.key, signal)
        if (!result.item.title.trim())
          throw new Error(`REFERENCE_NOT_FOUND: No title was found for ${ref.key}.`)
        literatureItemInputSchema.parse(result.item)
        // The Agent discovery contract has one source; retain explicit supplemental provenance
        // inside that receipt instead of attributing another provider's abstract to Crossref.
        discoveries.set(ref.key, {
          item: result.item,
          source:
            result.sources.length === 1
              ? result.source
              : {
                  ...result.source,
                  rawMetadata: {
                    ...result.source.rawMetadata,
                    supplementalSources: result.sources.slice(1)
                  }
                }
        })
      } catch (error) {
        signal?.throwIfAborted()
        if (!discoveries.has(ref.key)) {
          if (error instanceof LiteratureProviderError && error.status === 404)
            throw new Error(`REFERENCE_NOT_FOUND: No metadata was found for ${ref.key}.`)
          throw error
        }
      }
    }
    return requested.map(({ key }) => {
      const result = discoveries.get(key)
      if (!result) throw new Error(`REFERENCE_NOT_FOUND: No metadata was found for ${key}.`)
      return result
    })
  }
}
export { LiteratureReferenceResolver, identitiesAgree }
export type { LiteratureReferenceDiscovery }
