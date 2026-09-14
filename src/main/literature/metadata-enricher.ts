import { LiteratureProviderError } from './provider-error'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'

import {
  literatureItemInputSchema,
  type LiteratureItemInput,
  type LiteratureMetadataCompletionRequest,
  type LiteratureMetadataCompletionResult,
  type LiteratureMetadataConflict,
  type LiteratureMetadataField,
  type LiteratureMetadataValue,
  type LiteratureSourceInput
} from '../../shared/literature'
import { normalizeIdentifier, type LiteratureCatalog } from './catalog'

type MetadataCatalog = Pick<LiteratureCatalog, 'applyMetadata' | 'get' | 'getMetadataCommitReceipt'>
type FetchFn = typeof fetch

const CROSSREF_BASE = 'https://api.crossref.org/works/'
const CROSSREF_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const PUBMED_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi'
const PUBMED_MAX_RESPONSE_BYTES = 2 * 1024 * 1024

const dateSchema = z
  .object({ 'date-parts': z.array(z.array(z.number().int())).min(1) })
  .passthrough()

const crossrefMessageSchema = z
  .object({
    DOI: z.string().optional(),
    URL: z.string().optional(),
    type: z.string().optional(),
    title: z.array(z.string()).optional(),
    'short-title': z.array(z.string()).optional(),
    'container-title': z.array(z.string()).optional(),
    publisher: z.string().optional(),
    volume: z.string().optional(),
    issue: z.string().optional(),
    page: z.string().optional(),
    'article-number': z.string().optional(),
    ISSN: z.array(z.string()).optional(),
    language: z.string().optional(),
    author: z
      .array(
        z
          .object({
            given: z.string().optional(),
            family: z.string().optional(),
            name: z.string().optional()
          })
          .passthrough()
      )
      .optional(),
    issued: dateSchema.optional(),
    published: dateSchema.optional(),
    'published-print': dateSchema.optional(),
    'published-online': dateSchema.optional()
  })
  .passthrough()

const crossrefResponseSchema = z.object({ message: crossrefMessageSchema }).passthrough()

const parseCrossrefResponse = (body: string): z.infer<typeof crossrefMessageSchema> =>
  crossrefResponseSchema.parse(JSON.parse(body)).message

const pubmedSummarySchema = z
  .object({
    uid: z.string(),
    title: z.string().optional(),
    pubdate: z.string().optional(),
    source: z.string().optional(),
    fulljournalname: z.string().optional(),
    volume: z.string().optional(),
    issue: z.string().optional(),
    pages: z.string().optional(),
    lang: z.array(z.string()).optional(),
    issn: z.string().optional(),
    publishername: z.string().optional(),
    authors: z
      .array(z.object({ name: z.string(), authtype: z.string().optional() }).passthrough())
      .optional(),
    articleids: z
      .array(z.object({ idtype: z.string(), value: z.string() }).passthrough())
      .optional()
  })
  .passthrough()

const pubmedResponseSchema = z.object({ result: z.record(z.string(), z.unknown()) }).passthrough()

const firstText = (values: readonly string[] | undefined): string => values?.[0]?.trim() ?? ''
const comparable = (value: string): string => value.normalize('NFKC').trim().toLowerCase()

const dateParts = (message: z.infer<typeof crossrefMessageSchema>): readonly number[] | undefined =>
  (message['published-print'] ??
    message.published ??
    message.issued ??
    message['published-online'])?.['date-parts'][0]

const formatDate = (parts: readonly number[] | undefined): string =>
  parts
    ?.slice(0, 3)
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, '0')))
    .join('-') ?? ''

const pubmedDateParts = (value: string | undefined): readonly number[] | undefined => {
  const match = value?.trim().match(/^(\d{4})(?:\s+([A-Za-z]{3}))?(?:\s+(\d{1,2}))?/u)
  if (!match) return undefined
  const month = match[2]
    ? ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(
        match[2].toLowerCase()
      ) + 1
    : 0
  return [Number(match[1]), ...(month > 0 ? [month] : []), ...(match[3] ? [Number(match[3])] : [])]
}

const publicationYear = (text: string): number | undefined => {
  const match = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/u.exec(text.trim())
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2] ?? 1)
  const day = Number(match[3] ?? 1)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!
    ? year
    : undefined
}

const identifierText = (item: LiteratureItemInput): string =>
  item.identifiers
    .map(
      ({ scheme, value, isPrimary }) => `${scheme.toUpperCase()}: ${value}${isPrimary ? ' ★' : ''}`
    )
    .join('; ')

const reviewIdentifiers = (
  current: LiteratureItemInput,
  merged: ReturnType<typeof mergeCrossrefMetadata>
): void => {
  const key = ({ scheme, value, isPrimary }: LiteratureItemInput['identifiers'][number]): string =>
    JSON.stringify([scheme, normalizeIdentifier(scheme, value), Boolean(isPrimary)])
  const existingKeys = new Set(current.identifiers.map(key))
  const incomingKeys = new Set(merged.item.identifiers.map(key))
  const onlyAdded = [...existingKeys].every((value) => incomingKeys.has(value))
  if (onlyAdded && existingKeys.size === incomingKeys.size) {
    merged.item.identifiers = structuredClone(current.identifiers)
    return
  }
  const existing = identifierText(current)
  const value = identifierText(merged.item)
  if (onlyAdded) merged.filled.push({ field: 'identifiers', value })
  else merged.conflicts.push({ field: 'identifiers', currentValue: existing, value })
}

const creatorText = (item: LiteratureItemInput): string =>
  item.creators
    .filter(({ creatorType }) => creatorType === 'author')
    .map((creator) =>
      creator.nameMode === 'organization'
        ? creator.literalName
        : [creator.givenName, creator.familyName].filter(Boolean).join(' ')
    )
    .join(', ')

const mergeCrossrefMetadata = (
  current: LiteratureItemInput,
  message: z.infer<typeof crossrefMessageSchema>,
  overwriteFields: ReadonlySet<LiteratureMetadataField> = new Set(),
  originalDate?: string
): {
  item: LiteratureItemInput
  filled: LiteratureMetadataValue[]
  conflicts: LiteratureMetadataConflict[]
} => {
  const item = literatureItemInputSchema.parse(structuredClone(current))
  const filled: LiteratureMetadataValue[] = []
  const conflicts: LiteratureMetadataConflict[] = []

  const mergeString = (
    key: 'containerTitle' | 'issuedText' | 'language' | 'shortTitle' | 'title' | 'url',
    field: LiteratureMetadataField,
    incoming: string
  ): void => {
    const value = incoming.trim()
    if (!value) return
    const existing = item[key].trim()
    if (!existing) {
      item[key] = value
      filled.push({ field, value })
    } else if (comparable(existing) !== comparable(value)) {
      if (overwriteFields.has(field)) {
        item[key] = value
        filled.push({ field, value })
      } else conflicts.push({ field, currentValue: existing, value })
    }
  }

  const mergeTypeField = (
    key: 'issue' | 'pages' | 'publisher' | 'volume',
    field: LiteratureMetadataField,
    incoming: string
  ): void => {
    const value = incoming.trim()
    if (!value) return
    const existing = typeof item.typeFields[key] === 'string' ? item.typeFields[key].trim() : ''
    if (!existing) {
      item.typeFields[key] = value
      filled.push({ field, value })
    } else if (comparable(existing) !== comparable(value)) {
      if (overwriteFields.has(field)) {
        item.typeFields[key] = value
        filled.push({ field, value })
      } else conflicts.push({ field, currentValue: existing, value })
    }
  }

  const parts = dateParts(message)
  const incomingYear = parts?.[0]
  mergeString('title', 'title', firstText(message.title))
  mergeString('containerTitle', 'journal', firstText(message['container-title']))
  mergeString('shortTitle', 'shortTitle', firstText(message['short-title']))
  mergeString('language', 'language', message.language ?? '')
  mergeString('url', 'url', message.URL ?? '')
  mergeTypeField('volume', 'volume', message.volume ?? '')
  mergeTypeField('issue', 'issue', message.issue ?? '')
  mergeTypeField('pages', 'pages', message.page ?? message['article-number'] ?? '')
  mergeTypeField('publisher', 'publisher', message.publisher ?? '')

  // Only unambiguous numeric dates participate in automatic year inference.
  const existingDateYear = publicationYear(item.issuedText)
  if (item.issuedYear === undefined && existingDateYear !== undefined) {
    item.issuedYear = existingDateYear
    filled.push({ field: 'publicationDate', value: item.issuedText })
  }
  const incomingDate = originalDate ?? formatDate(parts)
  if (
    incomingYear !== undefined &&
    (originalDate !== undefined || publicationYear(incomingDate) !== undefined)
  ) {
    const existing = item.issuedText || String(item.issuedYear ?? '')
    const differs =
      (item.issuedYear !== undefined && item.issuedYear !== incomingYear) ||
      (Boolean(item.issuedText) && item.issuedText !== incomingDate)
    if (differs && !overwriteFields.has('publicationDate')) {
      conflicts.push({
        field: 'publicationDate',
        currentValue:
          item.issuedText && item.issuedYear !== undefined && existingDateYear !== item.issuedYear
            ? `${existing} [${item.issuedYear}]`
            : existing,
        value: incomingDate
      })
    } else if (item.issuedText !== incomingDate || item.issuedYear !== incomingYear) {
      item.issuedText = incomingDate
      item.issuedYear = incomingYear
      filled.push({ field: 'publicationDate', value: incomingDate })
    }
  }

  const incomingCreators =
    message.author?.flatMap<LiteratureItemInput['creators'][number]>(({ family, given, name }) =>
      name?.trim()
        ? [
            {
              nameMode: 'organization',
              literalName: name.trim(),
              creatorType: 'author',
              givenName: '',
              familyName: ''
            }
          ]
        : family?.trim() || given?.trim()
          ? [
              {
                nameMode: 'person' as const,
                givenName: given?.trim() ?? '',
                familyName: family?.trim() ?? '',
                creatorType: 'author'
              }
            ]
          : []
    ) ?? []
  if (incomingCreators.length > 0) {
    const incomingText = creatorText({ ...item, creators: incomingCreators })
    const otherCreators = item.creators.filter(({ creatorType }) => creatorType !== 'author')
    if (!item.creators.some(({ creatorType }) => creatorType === 'author')) {
      item.creators = [...incomingCreators, ...otherCreators]
      filled.push({ field: 'authors', value: incomingText })
    } else if (comparable(creatorText(item)) !== comparable(incomingText)) {
      if (overwriteFields.has('authors')) {
        item.creators = [...incomingCreators, ...otherCreators]
        filled.push({ field: 'authors', value: incomingText })
      } else {
        conflicts.push({ field: 'authors', currentValue: creatorText(item), value: incomingText })
      }
    }
  }

  const identifiers = (message.ISSN ?? []).map((value) => ({
    scheme: 'issn' as const,
    value,
    isPrimary: false
  }))
  for (const identifier of identifiers) {
    const normalized = normalizeIdentifier(identifier.scheme, identifier.value)
    if (
      item.identifiers.some(
        (existing) =>
          existing.scheme === identifier.scheme &&
          normalizeIdentifier(existing.scheme, existing.value) === normalized
      )
    )
      continue
    item.identifiers.push(identifier)
  }

  return { item, filled, conflicts }
}

const setLookupIdentifier = (
  current: LiteratureItemInput,
  scheme: 'doi' | 'pmid',
  rawValue: string
): LiteratureItemInput => {
  const item = literatureItemInputSchema.parse(structuredClone(current))
  const value = normalizeIdentifier(scheme, rawValue)
  item.identifiers = [
    ...item.identifiers
      .filter((identifier) => identifier.scheme !== scheme)
      .map((identifier) => ({ ...identifier, isPrimary: false })),
    { scheme, value, isPrimary: true }
  ]
  return item
}

const addIdentifier = (
  item: LiteratureItemInput,
  scheme: 'doi' | 'pmcid' | 'pmid',
  rawValue: string
): void => {
  const value = normalizeIdentifier(scheme, rawValue)
  if (
    !value ||
    item.identifiers.some(
      (identifier) =>
        identifier.scheme === scheme &&
        normalizeIdentifier(identifier.scheme, identifier.value) === value
    )
  )
    return
  item.identifiers.push({ scheme, value, isPrimary: false })
}

const mergePubmedMetadata = (
  current: LiteratureItemInput,
  summary: z.infer<typeof pubmedSummarySchema>,
  overwriteFields: ReadonlySet<LiteratureMetadataField> = new Set()
): ReturnType<typeof mergeCrossrefMetadata> => {
  const parts = pubmedDateParts(summary.pubdate)
  const merged = mergeCrossrefMetadata(
    current,
    {
      URL: `https://pubmed.ncbi.nlm.nih.gov/${summary.uid}/`,
      title: summary.title ? [summary.title] : undefined,
      'container-title': summary.fulljournalname
        ? [summary.fulljournalname]
        : summary.source
          ? [summary.source]
          : undefined,
      publisher: summary.publishername,
      volume: summary.volume,
      issue: summary.issue,
      page: summary.pages,
      ISSN: summary.issn ? [summary.issn] : undefined,
      language: summary.lang?.[0],
      author: summary.authors?.map(({ name, authtype }) =>
        authtype === 'CollectiveAuthor' ? { name } : { family: name }
      ),
      issued: parts ? { 'date-parts': [[...parts]] } : undefined
    },
    overwriteFields,
    summary.pubdate &&
      !/^\d{4}(?:\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:\s+\d{1,2})?)?$/iu.test(
        summary.pubdate.trim()
      )
      ? summary.pubdate.trim()
      : undefined
  )
  addIdentifier(merged.item, 'pmid', summary.uid)
  for (const identifier of summary.articleids ?? []) {
    if (identifier.idtype === 'doi') addIdentifier(merged.item, 'doi', identifier.value)
    if (identifier.idtype === 'pmc') addIdentifier(merged.item, 'pmcid', identifier.value)
  }
  return merged
}

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
    const lookupItem = request.identifier
      ? setLookupIdentifier(current.item, identifier.scheme, value)
      : current.item
    const sourceUrl =
      identifier.scheme === 'doi'
        ? `${CROSSREF_BASE}${encodeURIComponent(value)}`
        : `${PUBMED_BASE}?db=pubmed&id=${encodeURIComponent(value)}&retmode=json&version=2.0`
    const response = await this.fetchFn(sourceUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'OpenScience/1.0 (+https://github.com/aipoch/open-science)'
      },
      signal: AbortSignal.timeout(15_000)
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new LiteratureProviderError(response.status)
    }
    const maxBytes =
      identifier.scheme === 'doi' ? CROSSREF_MAX_RESPONSE_BYTES : PUBMED_MAX_RESPONSE_BYTES
    if (!response.body) throw new Error('Metadata response is empty.')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const { done, value: chunk } = await reader.read()
        if (done) break
        length += chunk.byteLength
        if (length > maxBytes) throw new Error('Metadata response is too large.')
        chunks.push(chunk)
      }
    } finally {
      await reader.cancel()
    }
    const body = Buffer.concat(chunks).toString('utf8')
    const overwriteFields = new Set<LiteratureMetadataField>()
    let provider: 'crossref' | 'pubmed'
    let rawMetadata: Record<string, unknown>
    let merged: ReturnType<typeof mergeCrossrefMetadata>
    if (identifier.scheme === 'doi') {
      const message = parseCrossrefResponse(body)
      const responseDoi = message.DOI ? normalizeIdentifier('doi', message.DOI) : value
      if (responseDoi !== value) throw new Error('Crossref returned metadata for a different DOI.')
      provider = 'crossref'
      rawMetadata = message
      merged = mergeCrossrefMetadata(lookupItem, message, overwriteFields)
    } else {
      const parsed = pubmedResponseSchema.parse(JSON.parse(body))
      const summary = pubmedSummarySchema.parse(parsed.result[value])
      if (summary.uid !== value) throw new Error('PubMed returned metadata for a different PMID.')
      provider = 'pubmed'
      rawMetadata = summary
      merged = mergePubmedMetadata(lookupItem, summary, overwriteFields)
    }
    reviewIdentifiers(current.item, merged)
    const source: LiteratureSourceInput = {
      provider,
      externalId: value,
      sourceUrl,
      rawMetadata
    }

    const result: LiteratureMetadataCompletionResult = {
      mode: 'preview',
      reviewVersion: 1,
      provider,
      sourceUrl,
      item: { ...current, item: merged.item },
      filled: merged.filled,
      conflicts: merged.conflicts,
      source,
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
    if (!review.source || review.reviewVersion !== 1)
      throw new Error('Search again to refresh this older metadata review.')
    const merged =
      review.provider === 'crossref'
        ? mergeCrossrefMetadata(
            review.item.item,
            crossrefMessageSchema.parse(review.source.rawMetadata),
            new Set(overwriteFields)
          )
        : mergePubmedMetadata(
            review.item.item,
            pubmedSummarySchema.parse(review.source.rawMetadata),
            new Set(overwriteFields)
          )
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
      source: review.source
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

export {
  LiteratureMetadataEnricher,
  mergeCrossrefMetadata,
  mergePubmedMetadata,
  parseCrossrefResponse
}
