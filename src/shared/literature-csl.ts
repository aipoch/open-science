import {
  literatureItemInputSchema,
  normalizeLiteratureIdentifierValue,
  preferredLiteratureIdentifier,
  type LiteratureCreatorInput,
  type LiteratureIdentifierInput,
  type LiteratureItemInput,
  type LiteratureItemType
} from './literature'

const CSL_ITEM_TYPES: Record<LiteratureItemType, string> = {
  journalArticle: 'article-journal',
  review: 'article-journal',
  preprint: 'article',
  conferencePaper: 'paper-conference',
  book: 'book',
  bookSection: 'chapter',
  thesis: 'thesis',
  report: 'report',
  dataset: 'dataset',
  standard: 'standard',
  patent: 'patent',
  webpage: 'webpage',
  document: 'document'
}

const LITERATURE_ITEM_TYPES_BY_CSL: Readonly<Record<string, LiteratureItemType>> = {
  article: 'preprint',
  'article-journal': 'journalArticle',
  book: 'book',
  chapter: 'bookSection',
  dataset: 'dataset',
  document: 'document',
  legal_case: 'document',
  legislation: 'standard',
  manuscript: 'preprint',
  map: 'document',
  motion_picture: 'document',
  musical_score: 'document',
  pamphlet: 'document',
  'paper-conference': 'conferencePaper',
  patent: 'patent',
  personal_communication: 'document',
  post: 'webpage',
  'post-weblog': 'webpage',
  report: 'report',
  song: 'document',
  speech: 'document',
  standard: 'standard',
  thesis: 'thesis',
  webpage: 'webpage'
}

type CslName = Readonly<{
  family?: string
  given?: string
  literal?: string
}>

type CslDate = Readonly<{ 'date-parts': readonly [readonly number[]] }>

type CslItem = Readonly<{
  id: string
  type: string
  title: string
  author?: readonly CslName[]
  editor?: readonly CslName[]
  translator?: readonly CslName[]
  issued?: CslDate
  accessed?: CslDate
  'container-title'?: string
  'container-title-short'?: string
  'title-short'?: string
  abstract?: string
  language?: string
  URL?: string
  PMID?: string
  PMCID?: string
  arXiv?: string
  DOI?: string
  ISBN?: string
  ISSN?: string
  volume?: string
  issue?: string
  page?: string
  publisher?: string
  'publisher-place'?: string
  edition?: string
}>

const creatorName = (creator: LiteratureCreatorInput): CslName =>
  creator.nameMode === 'organization'
    ? { literal: creator.literalName }
    : {
        ...(creator.familyName ? { family: creator.familyName } : {}),
        ...(creator.givenName ? { given: creator.givenName } : {})
      }

const creatorsFor = (
  creators: readonly LiteratureCreatorInput[],
  role: 'author' | 'editor' | 'translator'
): readonly CslName[] | undefined => {
  const names = creators
    .filter(({ creatorType }) => creatorType.toLowerCase() === role)
    .map(creatorName)
  return names.length > 0 ? names : undefined
}

const issuedDate = (item: LiteratureItemInput): CslDate | undefined => {
  // PubMed DP uses English month abbreviations. Normalize only unambiguous dates;
  // seasons and ranges retain the existing year fallback, and the original text is untouched.
  const months = [
    'jan',
    'feb',
    'mar',
    'apr',
    'may',
    'jun',
    'jul',
    'aug',
    'sep',
    'oct',
    'nov',
    'dec'
  ]
  const dateText = item.issuedText
    .trim()
    .replace(
      /^(\d{4})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:\s+(\d{1,2}))?$/iu,
      (_match, year: string, month: string, day: string | undefined) =>
        `${year}-${months.indexOf(month.toLowerCase()) + 1}${day === undefined ? '' : `-${day}`}`
    )
  const match = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/u.exec(dateText)
  if (match) {
    const year = Number(match[1])
    const month = match[2] ? Number(match[2]) : undefined
    const day = match[3] ? Number(match[3]) : undefined
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    if (
      year > 0 &&
      (month === undefined || (month >= 1 && month <= 12)) &&
      (day === undefined || (day >= 1 && day <= days[month! - 1]!))
    ) {
      return {
        'date-parts': [
          [year, ...(month === undefined ? [] : [month]), ...(day === undefined ? [] : [day])]
        ]
      }
    }
  }
  return item.issuedYear === undefined ? undefined : { 'date-parts': [[item.issuedYear]] }
}

const accessedDate = (accessedAt: number | undefined): CslDate | undefined => {
  if (accessedAt === undefined) return undefined
  const date = new Date(accessedAt)
  return Number.isNaN(date.getTime())
    ? undefined
    : { 'date-parts': [[date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]] }
}

const identifierFor = (
  item: LiteratureItemInput,
  scheme: 'doi' | 'isbn' | 'issn' | 'pmid' | 'pmcid' | 'arxiv'
): string | undefined => {
  const identifier = preferredLiteratureIdentifier(item.identifiers, scheme)
  return identifier
    ? normalizeLiteratureIdentifierValue(identifier.scheme, identifier.value)
    : undefined
}

const typeField = (item: LiteratureItemInput, key: string): string | undefined => {
  const value = item.typeFields[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

const toCslItem = (id: string, item: LiteratureItemInput): CslItem => {
  const author = creatorsFor(item.creators, 'author')
  const editor = creatorsFor(item.creators, 'editor')
  const translator = creatorsFor(item.creators, 'translator')
  const accessed = accessedDate(item.accessedAt)
  const issued = issuedDate(item)
  const PMID = identifierFor(item, 'pmid')
  const PMCID = identifierFor(item, 'pmcid')
  const arXiv = identifierFor(item, 'arxiv')
  const DOI = identifierFor(item, 'doi')
  const ISBN = identifierFor(item, 'isbn')
  const ISSN = identifierFor(item, 'issn')
  const volume = typeField(item, 'volume')
  const issue = typeField(item, 'issue')
  const page = typeField(item, 'pages')
  const publisher = typeField(item, 'publisher')
  const publisherPlace = typeField(item, 'publisherPlace')
  const edition = typeField(item, 'edition')
  const journalAbbreviation = typeField(item, 'journalAbbreviation')

  return {
    id,
    type: CSL_ITEM_TYPES[item.itemType],
    title: item.title,
    ...(author ? { author } : {}),
    ...(editor ? { editor } : {}),
    ...(translator ? { translator } : {}),
    ...(issued ? { issued } : {}),
    ...(accessed ? { accessed } : {}),
    ...(item.containerTitle ? { 'container-title': item.containerTitle } : {}),
    ...(journalAbbreviation ? { 'container-title-short': journalAbbreviation } : {}),
    ...(item.shortTitle ? { 'title-short': item.shortTitle } : {}),
    ...(item.abstract ? { abstract: item.abstract } : {}),
    ...(item.language ? { language: item.language } : {}),
    ...(item.url ? { URL: item.url } : {}),
    ...(PMID ? { PMID } : {}),
    ...(PMCID ? { PMCID } : {}),
    ...(arXiv ? { arXiv } : {}),
    ...(DOI ? { DOI } : {}),
    ...(ISBN ? { ISBN } : {}),
    ...(ISSN ? { ISSN } : {}),
    ...(volume ? { volume } : {}),
    ...(issue ? { issue } : {}),
    ...(page ? { page } : {}),
    ...(publisher ? { publisher } : {}),
    ...(publisherPlace ? { 'publisher-place': publisherPlace } : {}),
    ...(edition ? { edition } : {})
  }
}

const stringField = (item: Record<string, unknown>, ...keys: string[]): string => {
  for (const key of keys) {
    const value = item[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

const dateParts = (value: unknown): readonly number[] | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const parts = (value as { 'date-parts'?: unknown })['date-parts']
  if (!Array.isArray(parts) || !Array.isArray(parts[0])) return undefined
  const date = parts[0]
  const [year, month, day] = date
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (
    date.length < 1 ||
    date.length > 3 ||
    !date.every((part) => typeof part === 'number' && Number.isInteger(part)) ||
    year < 0 ||
    (month !== undefined && (month < 1 || month > 12)) ||
    (day !== undefined && (day < 1 || day > days[month - 1]!))
  )
    throw new Error('Invalid bibliographic date.')
  return date
}

const creatorsFromCsl = (
  value: unknown,
  creatorType: 'author' | 'editor' | 'translator'
): LiteratureCreatorInput[] =>
  Array.isArray(value)
    ? value.flatMap<LiteratureCreatorInput>((entry) => {
        if (!entry || typeof entry !== 'object') return []
        const name = entry as Record<string, unknown>
        const literalName = stringField(name, 'literal')
        if (literalName) {
          return [{ nameMode: 'organization' as const, literalName, creatorType }]
        }
        const givenName = stringField(name, 'given')
        // Library names have no separate particle fields. Keep both CSL particle
        // categories in the surname so display and subsequent exports retain them.
        const familyName = [
          stringField(name, 'dropping-particle'),
          stringField(name, 'non-dropping-particle'),
          stringField(name, 'family')
        ]
          .filter(Boolean)
          .reduce(
            (surname, part) => `${surname}${surname && !/[-'’]$/u.test(surname) ? ' ' : ''}${part}`,
            ''
          )
        return givenName || familyName
          ? [{ nameMode: 'person' as const, givenName, familyName, creatorType }]
          : []
      })
    : []

const identifiersFromCsl = (item: Record<string, unknown>): LiteratureIdentifierInput[] => {
  const fields = [
    ['doi', ['DOI', 'doi']],
    ['pmid', ['PMID', 'pmid']],
    ['pmcid', ['PMCID', 'pmcid']],
    ['arxiv', ['arXiv', 'arxiv']],
    ['isbn', ['ISBN', 'isbn']],
    ['issn', ['ISSN', 'issn']]
  ] as const
  return fields.flatMap(([scheme, keys]) => {
    const value = stringField(item, ...keys)
    return value ? [{ scheme, value, isPrimary: scheme === 'doi' }] : []
  })
}

const fromCslItem = (value: Record<string, unknown>): LiteratureItemInput => {
  const issued = dateParts(value.issued)
  const accessed = dateParts(value.accessed)
  const accessedAt = accessed
    ? Date.UTC(accessed[0]!, (accessed[1] ?? 1) - 1, accessed[2] ?? 1)
    : undefined
  const typeFields = Object.fromEntries(
    [
      ['volume', stringField(value, 'volume')],
      ['issue', stringField(value, 'issue')],
      ['pages', stringField(value, 'page')],
      ['publisher', stringField(value, 'publisher')],
      ['publisherPlace', stringField(value, 'publisher-place')],
      ['edition', stringField(value, 'edition')],
      ['journalAbbreviation', stringField(value, 'container-title-short')]
    ].filter((entry): entry is [string, string] => Boolean(entry[1]))
  )

  return literatureItemInputSchema.parse({
    itemType: LITERATURE_ITEM_TYPES_BY_CSL[stringField(value, 'type')] ?? 'document',
    title: stringField(value, 'title'),
    abstract: stringField(value, 'abstract'),
    issuedText: issued?.join('-') ?? '',
    issuedYear: issued?.[0],
    containerTitle: stringField(value, 'container-title'),
    shortTitle: stringField(value, 'title-short'),
    language: stringField(value, 'language'),
    rights: stringField(value, 'rights'),
    url: stringField(value, 'URL', 'url'),
    accessedAt,
    citationKey: stringField(value, 'id') || undefined,
    extra: '',
    typeFields,
    creators: [
      ...creatorsFromCsl(value.author, 'author'),
      ...creatorsFromCsl(value.editor, 'editor'),
      ...creatorsFromCsl(value.translator, 'translator')
    ],
    identifiers: identifiersFromCsl(value)
  })
}

export { CSL_ITEM_TYPES, fromCslItem, toCslItem }
export type { CslDate, CslItem, CslName }
