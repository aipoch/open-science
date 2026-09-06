import {
  literatureItemInputSchema,
  normalizeLiteratureIdentifierValue,
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
  'title-short'?: string
  abstract?: string
  language?: string
  URL?: string
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

const accessedDate = (accessedAt: number | undefined): CslDate | undefined => {
  if (accessedAt === undefined) return undefined
  const date = new Date(accessedAt)
  return Number.isNaN(date.getTime())
    ? undefined
    : { 'date-parts': [[date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]] }
}

const identifierFor = (
  item: LiteratureItemInput,
  scheme: 'doi' | 'isbn' | 'issn'
): string | undefined => {
  const identifiers = item.identifiers.filter((identifier) => identifier.scheme === scheme)
  const identifier = identifiers.find(({ isPrimary }) => isPrimary) ?? identifiers[0]
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
  const DOI = identifierFor(item, 'doi')
  const ISBN = identifierFor(item, 'isbn')
  const ISSN = identifierFor(item, 'issn')
  const volume = typeField(item, 'volume')
  const issue = typeField(item, 'issue')
  const page = typeField(item, 'pages')
  const publisher = typeField(item, 'publisher')
  const publisherPlace = typeField(item, 'publisherPlace')
  const edition = typeField(item, 'edition')

  return {
    id,
    type: CSL_ITEM_TYPES[item.itemType],
    title: item.title,
    ...(author ? { author } : {}),
    ...(editor ? { editor } : {}),
    ...(translator ? { translator } : {}),
    ...(item.issuedYear !== undefined ? { issued: { 'date-parts': [[item.issuedYear]] } } : {}),
    ...(accessed ? { accessed } : {}),
    ...(item.containerTitle ? { 'container-title': item.containerTitle } : {}),
    ...(item.shortTitle ? { 'title-short': item.shortTitle } : {}),
    ...(item.abstract ? { abstract: item.abstract } : {}),
    ...(item.language ? { language: item.language } : {}),
    ...(item.url ? { URL: item.url } : {}),
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
  const normalized = parts[0].filter(
    (part): part is number => typeof part === 'number' && Number.isInteger(part) && part >= 0
  )
  return normalized.length > 0 ? normalized : undefined
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
        const familyName = stringField(name, 'family')
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
      ['edition', stringField(value, 'edition')]
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
