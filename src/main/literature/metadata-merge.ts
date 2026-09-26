import { z } from 'zod'
import { SaxesParser } from 'saxes'
import {
  literatureItemInputSchema,
  type LiteratureItemInput,
  type LiteratureMetadataConflict,
  type LiteratureMetadataField,
  type LiteratureMetadataValue
} from '../../shared/literature'
import { normalizeIdentifier } from './catalog'

// Provider records may omit a title; persisted catalog items may not.
const metadataProposalSchema = literatureItemInputSchema.extend({ title: z.string().default('') })

const dateSchema = z
  .object({ 'date-parts': z.array(z.array(z.number().int())).min(1) })
  .passthrough()

const crossrefMessageSchema = z
  .object({
    DOI: z.string().optional(),
    URL: z.string().optional(),
    type: z.string().optional(),
    title: z.array(z.string()).optional(),
    abstract: z.string().optional(),
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

type PubmedSummary = {
  uid: string
  title?: string
  pubdate?: string
  source?: string
  fulljournalname?: string
  volume?: string
  issue?: string
  pages?: string
  lang?: string[]
  issn?: string
  publishername?: string
  authors?: { name: string; authtype?: string }[]
  articleids?: { idtype: string; value: string }[]
}

const firstText = (values: readonly string[] | undefined): string => values?.[0]?.trim() ?? ''
const comparable = (value: string): string => value.normalize('NFKC').trim().toLowerCase()

const crossrefAbstract = (raw: string | undefined): string => {
  const value = raw?.trim()
  if (!value) return ''
  // Crossref returns either plain text or a JATS XML fragment in this JSON field.
  if (!/^<(?:[\w.-]+:)?(?:abstract|p|sec|title|div|h[1-6])\b/iu.test(value))
    return value.replace(/\s+/gu, ' ')

  const parser = new SaxesParser({ fragment: true })
  let text = ''
  let title: string | undefined
  let invalid = false
  const boundary = (): void => {
    text += '\n\n'
  }
  parser.on('error', () => {
    invalid = true
  })
  parser.on('doctype', () => {
    invalid = true
  })
  parser.on('opentag', ({ name }) => {
    const tag = name.split(':').pop()
    if (tag === 'title' || /^h[1-6]$/u.test(tag ?? '')) title = ''
    if (tag === 'p' || tag === 'sec' || tag === 'list-item') boundary()
  })
  const appendText = (part: string): void => {
    if (title !== undefined) title += part.replace(/\s+/gu, ' ')
    else text += part.replace(/\s+/gu, ' ')
  }
  parser.on('text', appendText)
  parser.on('cdata', appendText)
  parser.on('closetag', ({ name }) => {
    const tag = name.split(':').pop()
    if (tag === 'title' || /^h[1-6]$/u.test(tag ?? '')) {
      if (title?.trim().toLowerCase() !== 'abstract' && title?.trim()) {
        boundary()
        text += title.trim()
        boundary()
      }
      title = undefined
    }
    if (tag === 'p' || tag === 'sec' || tag === 'list-item') boundary()
  })
  try {
    parser.write(value).close()
  } catch {
    return ''
  }
  return invalid
    ? ''
    : text
        .replace(/[^\S\n]+/gu, ' ')
        .replace(/ *\n\s*\n */gu, '\n\n')
        .trim()
}

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
  originalDate?: string,
  normalizedAbstract?: string
): {
  item: LiteratureItemInput
  filled: LiteratureMetadataValue[]
  conflicts: LiteratureMetadataConflict[]
} => {
  const item = metadataProposalSchema.parse(structuredClone(current))
  const filled: LiteratureMetadataValue[] = []
  const conflicts: LiteratureMetadataConflict[] = []

  const mergeString = (
    key: 'abstract' | 'containerTitle' | 'issuedText' | 'language' | 'shortTitle' | 'title' | 'url',
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
  mergeString('abstract', 'abstract', normalizedAbstract ?? crossrefAbstract(message.abstract))
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
              creatorType: 'author'
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
  const item = metadataProposalSchema.parse(structuredClone(current))
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
  summary: PubmedSummary,
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
      author: summary.authors?.map(({ name, authtype }) => {
        if (authtype === 'CollectiveAuthor') return { name }
        // Without a dedicated suffix field, splitting these names would turn Jr/III
        // into given-name initials in citations. Retain the original representation.
        if (/\s+(?:Jr|Sr|II|III|IV)\.?$/iu.test(name.trim())) return { family: name }
        // ESummary personal names use "surname initials", not Crossref's separate
        // family/given fields. Keep compound surnames and surname particles intact.
        const match = /^(.*?)\s+([A-Z]+)$/u.exec(name.trim())
        if (!match) return { family: name }
        return {
          family: match[1],
          given: [...match[2]].map((initial) => `${initial}.`).join(' ')
        }
      }),
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

const mergeMetadata = (
  current: LiteratureItemInput,
  incoming: LiteratureItemInput,
  overwriteFields: ReadonlySet<LiteratureMetadataField> = new Set()
): ReturnType<typeof mergeCrossrefMetadata> => {
  const merged = mergeCrossrefMetadata(
    current,
    {
      title: incoming.title ? [incoming.title] : undefined,
      abstract: incoming.abstract,
      'container-title': [incoming.containerTitle],
      'short-title': [incoming.shortTitle],
      language: incoming.language,
      URL: incoming.url,
      volume:
        typeof incoming.typeFields.volume === 'string' ? incoming.typeFields.volume : undefined,
      issue: typeof incoming.typeFields.issue === 'string' ? incoming.typeFields.issue : undefined,
      page: typeof incoming.typeFields.pages === 'string' ? incoming.typeFields.pages : undefined,
      publisher:
        typeof incoming.typeFields.publisher === 'string'
          ? incoming.typeFields.publisher
          : undefined,
      issued:
        incoming.issuedYear === undefined ? undefined : { 'date-parts': [[incoming.issuedYear]] },
      author: incoming.creators
        .filter(({ creatorType }) => creatorType === 'author')
        .map((creator) =>
          creator.nameMode === 'organization'
            ? { name: creator.literalName }
            : { given: creator.givenName, family: creator.familyName }
        )
    },
    overwriteFields,
    (/^\d{4}(?:\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:\s+\d{1,2})?)$/iu.test(
      incoming.issuedText
    )
      ? formatDate(pubmedDateParts(incoming.issuedText))
      : incoming.issuedText) || undefined,
    incoming.abstract
  )
  for (const identifier of incoming.identifiers) {
    if (
      !merged.item.identifiers.some(
        (existing) =>
          existing.scheme === identifier.scheme &&
          normalizeIdentifier(existing.scheme, existing.value) ===
            normalizeIdentifier(identifier.scheme, identifier.value)
      )
    ) {
      merged.item.identifiers.push({ ...identifier, isPrimary: false })
    }
  }
  return merged
}

export {
  metadataProposalSchema,
  mergeMetadata,
  mergeCrossrefMetadata,
  mergePubmedMetadata,
  parseCrossrefResponse,
  reviewIdentifiers,
  setLookupIdentifier,
  crossrefAbstract
}
