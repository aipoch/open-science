import { z } from 'zod'
const nonEmptyTextSchema = z.string().trim().min(1)
const optionalTextSchema = z.string().trim().optional()
const LITERATURE_ITEM_TYPES = [
  'journalArticle',
  'review',
  'preprint',
  'conferencePaper',
  'book',
  'bookSection',
  'thesis',
  'report',
  'dataset',
  'standard',
  'patent',
  'webpage',
  'document'
] as const

const LITERATURE_IDENTITY_SCHEMES = ['doi', 'pmid', 'pmcid', 'arxiv'] as const

const LITERATURE_IDENTIFIER_SCHEMES = [
  ...LITERATURE_IDENTITY_SCHEMES,
  'isbn',
  'issn',
  'other'
] as const

const LITERATURE_CITATION_STYLES = [
  'apa',
  'mla',
  'chicago-author-date',
  'vancouver',
  'ieee',
  'nature',
  'american-medical-association',
  'harvard-cite-them-right'
] as const

const LITERATURE_CITATION_LOCALES = ['en-US', 'zh-CN'] as const

const LITERATURE_CSL_MAX_BYTES = 1024 * 1024

const LITERATURE_RECORD_IMPORT_FORMATS = ['bibtex', 'ris', 'nbib'] as const

const LITERATURE_RECORD_IMPORT_MAX_BYTES = 32 * 1024 * 1024

const LITERATURE_RECORD_IMPORT_MAX_RECORDS = 1_000

const LITERATURE_IMPORT_WARNINGS = [
  'missing-authors',
  'missing-year',
  'missing-container-title',
  'uncertain-author-name'
] as const

type LiteratureIdentifierScheme = (typeof LITERATURE_IDENTIFIER_SCHEMES)[number]

// Suffix matching must not retry an unbounded tail at every possible starting point.
// Dot-based suffixes historically stopped at line terminators; keep that behavior.
const lastLineBreak = (value: string): number =>
  Math.max(
    value.lastIndexOf('\n'),
    value.lastIndexOf('\r'),
    value.lastIndexOf('\u2028'),
    value.lastIndexOf('\u2029')
  )

const stripDoiCopyright = (value: string): string => {
  // The separator after Copyright may itself be the final line break.
  const start = Math.max(0, lastLineBreak(value) - 'Copyright'.length)
  const suffix = /Copyright(?:\s|$)/iu.exec(value.slice(start))
  return suffix ? value.slice(0, start + suffix.index) : value
}

const normalizeLiteratureIdentifierValue = (
  scheme: LiteratureIdentifierScheme,
  value: string
): string => {
  const trimmed = value.trim()
  if (scheme === 'doi') {
    const candidate = stripDoiCopyright(
      trimmed.replace(/^doi:\s*/iu, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '')
    )
    let end = candidate.length
    while (end > 0 && '.,;:)}]'.includes(candidate[end - 1])) end--
    return candidate.slice(0, end).trim()
  }
  if (scheme === 'pmid') {
    const candidate = trimmed.replace(/^PMID\s*:\s*/iu, '')
    return (
      /^https?:\/\/(?:www\.)?pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)\/?(?:[?#].*)?$/iu.exec(
        candidate
      )?.[1] ?? candidate
    )
  }
  if (scheme === 'pmcid') {
    const candidate = trimmed.replace(/^PMCID\s*:\s*/iu, '')
    const fromUrl =
      /^https?:\/\/(?:pmc\.ncbi\.nlm\.nih\.gov\/articles\/(PMC\d+)|(?:www\.)?ncbi\.nlm\.nih\.gov\/pmc\/articles\/(PMC\d+))\/?(?:[?#].*)?$/iu.exec(
        candidate
      )
    const valueWithoutUrl = fromUrl?.[1] ?? fromUrl?.[2] ?? candidate
    const digits = /^(?:PMC)?(\d+)$/iu.exec(valueWithoutUrl)?.[1]
    return digits ? `PMC${digits}` : valueWithoutUrl.toUpperCase()
  }
  if (scheme === 'arxiv') {
    const candidate = trimmed
      .replace(/^arxiv:\s*/iu, '')
      .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//iu, '')
    const start = lastLineBreak(candidate) + 1
    const suffix = /[?#]/u.exec(candidate.slice(start))
    const withoutQuery = suffix ? candidate.slice(0, start + suffix.index) : candidate
    return withoutQuery
      .replace(/\.pdf$/iu, '')
      .replace(/v\d+$/iu, '')
      .trim()
  }
  return trimmed
}

const createLiteratureIdentifierUrl = (
  scheme: LiteratureIdentifierScheme,
  value: string
): string | undefined => {
  const normalized = normalizeLiteratureIdentifierValue(scheme, value)
  if (scheme === 'doi' && /^10\.\d{4,9}\/\S+$/u.test(normalized)) {
    const encoded = normalized.split('/').map(encodeURIComponent).join('/')
    return `https://doi.org/${encoded}`
  }
  if (scheme === 'pmid' && /^\d+$/u.test(normalized)) {
    return `https://pubmed.ncbi.nlm.nih.gov/${normalized}/`
  }
  if (scheme === 'pmcid' && /^PMC\d+$/u.test(normalized)) {
    return `https://pmc.ncbi.nlm.nih.gov/articles/${normalized}/`
  }
  if (scheme === 'arxiv' && /^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7})$/iu.test(normalized)) {
    const encoded = normalized.split('/').map(encodeURIComponent).join('/')
    return `https://arxiv.org/abs/${encoded}`
  }
  return undefined
}

const literaturePersonCreatorSchema = z
  .object({
    nameMode: z.literal('person'),
    givenName: z.string().trim().default(''),
    familyName: z.string().trim().default(''),
    creatorType: nonEmptyTextSchema
  })
  .refine(({ familyName, givenName }) => familyName.length > 0 || givenName.length > 0, {
    message: 'A person creator requires a given or family name.'
  })

const literatureOrganizationCreatorSchema = z
  .object({
    nameMode: z.literal('organization'),
    literalName: nonEmptyTextSchema,
    creatorType: nonEmptyTextSchema
  })
  .strict()

const literatureCreatorInputSchema = z.discriminatedUnion('nameMode', [
  literaturePersonCreatorSchema,
  literatureOrganizationCreatorSchema
])

const literatureIdentifierInputSchema = z
  .object({
    scheme: z.enum(LITERATURE_IDENTIFIER_SCHEMES),
    value: nonEmptyTextSchema,
    isPrimary: z.boolean().default(false)
  })
  .strict()
  .transform((identifier) => ({
    ...identifier,
    value: normalizeLiteratureIdentifierValue(identifier.scheme, identifier.value)
  }))
  .refine(({ value }) => value.length > 0, { message: 'Literature identifier is empty.' })

const literatureCitationStylePreviewSchema = z
  .object({ inText: nonEmptyTextSchema, reference: nonEmptyTextSchema })
  .strict()

const literatureCitationStyleViewSchema = z
  .object({
    id: nonEmptyTextSchema,
    title: nonEmptyTextSchema,
    source: z.enum(['built-in', 'custom']),
    summary: optionalTextSchema,
    rights: optionalTextSchema,
    preview: literatureCitationStylePreviewSchema.optional()
  })
  .strict()

const literatureCitationStylesRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list') }).strict(),
  z
    .object({ kind: z.literal('import'), content: z.string().min(1).max(LITERATURE_CSL_MAX_BYTES) })
    .strict(),
  z.object({ kind: z.literal('delete'), styleId: nonEmptyTextSchema }).strict(),
  z.object({ kind: z.literal('preview'), styleId: nonEmptyTextSchema }).strict()
])

const literatureCitationStylesResultSchema = z
  .object({
    styles: z.array(literatureCitationStyleViewSchema),
    changedStyleId: nonEmptyTextSchema.optional(),
    preview: literatureCitationStylePreviewSchema
      .extend({ styleId: nonEmptyTextSchema })
      .strict()
      .optional()
  })
  .strict()

type LiteratureItemType = z.infer<typeof bibliographicRecordSchema>['itemType']

type LiteratureIdentityScheme = (typeof LITERATURE_IDENTITY_SCHEMES)[number]

type LiteratureCreatorInput = z.infer<typeof literatureCreatorInputSchema>

type LiteratureIdentifierInput = z.infer<typeof literatureIdentifierInputSchema>

function preferredLiteratureIdentifier(
  identifiers: readonly LiteratureIdentifierInput[],
  scheme: LiteratureIdentifierScheme
): LiteratureIdentifierInput | undefined {
  return identifiers
    .filter((identifier) => identifier.scheme === scheme)
    .sort((a, b) => {
      const priority = Number(b.isPrimary) - Number(a.isPrimary)
      const left = normalizeLiteratureIdentifierValue(scheme, a.value).toLowerCase()
      const right = normalizeLiteratureIdentifierValue(scheme, b.value).toLowerCase()
      return (
        priority ||
        (left < right ? -1 : left > right ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0)
      )
    })[0]
}

function normalizeLiteratureIdentifierPreferences<T extends LiteratureIdentifierInput>(
  identifiers: readonly T[]
): T[] {
  const preferred = new Map(
    [...new Set(identifiers.map(({ scheme }) => scheme))].map((scheme) => [
      scheme,
      preferredLiteratureIdentifier(identifiers, scheme)
    ])
  )
  return identifiers.map((identifier) => ({
    ...identifier,
    isPrimary: identifier.isPrimary && preferred.get(identifier.scheme) === identifier
  }))
}

type LiteratureCitationStylesRequest = z.infer<typeof literatureCitationStylesRequestSchema>
type LiteratureCitationStylesResult = z.infer<typeof literatureCitationStylesResultSchema>

type LiteratureCitationStyle = string

type LiteratureCitationLocale = (typeof LITERATURE_CITATION_LOCALES)[number]

type LiteratureCitationStyleView = z.infer<typeof literatureCitationStyleViewSchema>

type LiteratureRecordImportFormat = (typeof LITERATURE_RECORD_IMPORT_FORMATS)[number]
const bibliographicRecordSchema = z
  .object({
    itemType: z.enum(LITERATURE_ITEM_TYPES),
    title: nonEmptyTextSchema,
    abstract: z.string().trim().default(''),
    issuedText: z.string().trim().default(''),
    issuedYear: z.number().int().min(0).max(9999).optional(),
    containerTitle: z.string().trim().default(''),
    shortTitle: z.string().trim().default(''),
    language: z.string().trim().default(''),
    rights: z.string().trim().default(''),
    url: z.string().trim().default(''),
    accessedAt: z.number().int().nonnegative().optional(),
    citationKey: optionalTextSchema,
    extra: z.string().default(''),
    typeFields: z.record(z.string(), z.unknown()).default({}),
    creators: z.array(literatureCreatorInputSchema).default([]),
    identifiers: z.array(literatureIdentifierInputSchema).default([])
  })
  .strict()
export type BibliographicRecord = z.infer<typeof bibliographicRecordSchema>
export type CitationImportWarning = (typeof LITERATURE_IMPORT_WARNINGS)[number]
export {
  LITERATURE_ITEM_TYPES,
  LITERATURE_IDENTITY_SCHEMES,
  LITERATURE_IDENTIFIER_SCHEMES,
  LITERATURE_CITATION_STYLES,
  LITERATURE_CITATION_LOCALES,
  LITERATURE_CSL_MAX_BYTES,
  LITERATURE_RECORD_IMPORT_FORMATS,
  LITERATURE_RECORD_IMPORT_MAX_BYTES,
  LITERATURE_RECORD_IMPORT_MAX_RECORDS,
  LITERATURE_IMPORT_WARNINGS,
  normalizeLiteratureIdentifierValue,
  createLiteratureIdentifierUrl,
  literaturePersonCreatorSchema,
  literatureOrganizationCreatorSchema,
  literatureCreatorInputSchema,
  literatureIdentifierInputSchema,
  literatureCitationStylesRequestSchema,
  literatureCitationStylesResultSchema,
  literatureCitationStylePreviewSchema,
  literatureCitationStyleViewSchema,
  preferredLiteratureIdentifier,
  normalizeLiteratureIdentifierPreferences,
  bibliographicRecordSchema
}
export type {
  LiteratureIdentifierScheme,
  LiteratureItemType,
  LiteratureIdentityScheme,
  LiteratureCreatorInput,
  LiteratureIdentifierInput,
  LiteratureCitationStylesRequest,
  LiteratureCitationStylesResult,
  LiteratureCitationStyle,
  LiteratureCitationLocale,
  LiteratureCitationStyleView,
  LiteratureRecordImportFormat
}
