/** A bounded display snapshot, never an authorization to read an item or attachment. */
export type LiteratureSourceCitation = {
  itemId: string
  citationId?: string
  context?: string
  title: string
  kind: 'metadata' | 'abstract' | 'pdf'
  quote: string
  source?: { attachmentId: string; versionId: string; checksum: string; name: string }
  pageStart?: number
  pageEnd?: number
}

const PREFIX = '#library-source='
const REFERENCE_PREFIX = '#library-cite='
const MAX_HREF_LENGTH = 100_000
export const LITERATURE_SOURCE_CITATION_HREFS_MAX_CHARACTERS = 8_000
const MAX_RECEIPT_HREFS = 20
const knownKeys = new Set([
  'itemId',
  'citationId',
  'context',
  'title',
  'kind',
  'quote',
  'source',
  'pageStart',
  'pageEnd'
])
const sourceKeys = new Set(['attachmentId', 'versionId', 'checksum', 'name'])
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, maximum: number, allowEmpty = false): value is string =>
  typeof value === 'string' && value.length <= maximum && (allowEmpty || value.trim().length > 0)
const identifier = (value: unknown): value is string =>
  text(value, 512) &&
  value === value.trim() &&
  !/[/\\]/u.test(value) &&
  [...value].every((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint > 0x1f && codePoint !== 0x7f
  })
const page = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const validCitation = (value: unknown): value is LiteratureSourceCitation => {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !knownKeys.has(key)) ||
    !identifier(value.itemId) ||
    !text(value.title, 1_000, true) ||
    !['metadata', 'abstract', 'pdf'].includes(value.kind as string) ||
    !text(value.quote, 1_600, value.kind === 'metadata') ||
    (value.citationId !== undefined &&
      (typeof value.citationId !== 'string' || !/^[a-f0-9]{16}$/u.test(value.citationId))) ||
    (value.context !== undefined &&
      (!text(value.context, 1_600) || !value.context.includes(value.quote)))
  ) {
    return false
  }
  if (value.kind !== 'pdf') {
    return (
      value.source === undefined && value.pageStart === undefined && value.pageEnd === undefined
    )
  }
  const source = value.source
  return (
    record(source) &&
    Object.keys(source).every((key) => sourceKeys.has(key)) &&
    identifier(source.attachmentId) &&
    identifier(source.versionId) &&
    typeof source.checksum === 'string' &&
    /^[a-f0-9]{64}$/u.test(source.checksum) &&
    text(source.name, 1_000) &&
    page(value.pageStart) &&
    page(value.pageEnd) &&
    value.pageEnd >= value.pageStart
  )
}

export const createLiteratureSourceCitationHref = (citation: LiteratureSourceCitation): string => {
  if (!validCitation(citation)) throw new Error('Invalid Literature source citation')
  const href =
    PREFIX +
    encodeURIComponent(JSON.stringify(citation)).replace(
      /[!'()*]/gu,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    )
  if (href.length > MAX_HREF_LENGTH)
    throw new Error('Literature source citation exceeds link limit')
  return href
}

export const parseLiteratureSourceCitationHref = (
  href: string | undefined
): LiteratureSourceCitation | undefined => {
  if (!href?.startsWith(PREFIX) || href.length > MAX_HREF_LENGTH) return undefined
  try {
    const value: unknown = JSON.parse(decodeURIComponent(href.slice(PREFIX.length)))
    return validCitation(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Sanitize the bounded citation allowlist retained in an application-owned tool receipt. */
export const collectLiteratureSourceCitationHrefs = (hrefs: unknown): string[] => {
  if (!Array.isArray(hrefs)) return []
  const result: string[] = []
  let characters = 0
  for (const href of hrefs.slice(0, MAX_RECEIPT_HREFS * 4)) {
    if (result.length === MAX_RECEIPT_HREFS) break
    if (
      typeof href !== 'string' ||
      href.length > LITERATURE_SOURCE_CITATION_HREFS_MAX_CHARACTERS ||
      result.includes(href)
    )
      continue
    const citation = parseLiteratureSourceCitationHref(href)
    if (!citation || createLiteratureSourceCitationHref(citation) !== href) continue
    if (characters + href.length > LITERATURE_SOURCE_CITATION_HREFS_MAX_CHARACTERS) continue
    result.push(href)
    characters += href.length
  }
  return result
}

/** Resolve only snapshots authorized by this message's application-owned tool receipts. */
export const resolveLiteratureSourceCitationHref = (
  href: string | undefined,
  receipts: readonly string[]
): LiteratureSourceCitation | undefined => {
  if (!href) return undefined
  if (href.startsWith(PREFIX)) {
    const citation = parseLiteratureSourceCitationHref(href)
    return receipts.includes(href) &&
      citation &&
      createLiteratureSourceCitationHref(citation) === href
      ? citation
      : undefined
  }
  if (!href.startsWith(REFERENCE_PREFIX)) return undefined
  const citationId = href.slice(REFERENCE_PREFIX.length)
  if (!/^[a-f0-9]{16}$/u.test(citationId)) return undefined
  let resolved: LiteratureSourceCitation | undefined
  let snapshot: string | undefined
  for (const receipt of receipts) {
    const citation = parseLiteratureSourceCitationHref(receipt)
    if (
      !citation ||
      citation.citationId !== citationId ||
      createLiteratureSourceCitationHref(citation) !== receipt
    )
      continue
    if (snapshot !== undefined && snapshot !== receipt) return undefined
    snapshot = receipt
    resolved = citation
  }
  return resolved
}
