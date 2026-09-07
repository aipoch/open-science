import {
  createLiteratureIdentifierUrl,
  normalizeLiteratureIdentifierValue,
  type LiteratureCreatorInput,
  type LiteratureItemInput
} from '../../../../shared/literature'
import { joinPdfTextItems } from '../../../../shared/pdf-text'

const MAX_LOCAL_PDF_METADATA_BYTES = 50 * 1024 * 1024
const DOI_PATTERN = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/giu
const PMID_PATTERN = /\b(?:PMID|PubMed\s+ID)\s*:?\s*(\d{6,9})\b/iu

const DOI_CACHE_SIZE = 32
const DOI_CACHE_MS = 5 * 60_000
const doiCaches = new WeakMap<
  typeof window.api.literature.lookupMetadata,
  Map<string, { expires: number; result: Promise<LiteratureItemInput> }>
>()

const lookupPdfDoi = (doi: string): Promise<LiteratureItemInput> => {
  const lookup = window.api.literature.lookupMetadata
  let cache = doiCaches.get(lookup)
  if (!cache) {
    cache = new Map()
    doiCaches.set(lookup, cache)
  }
  const cached = cache.get(doi)
  if (cached && cached.expires > Date.now()) return cached.result
  const result = lookup(doi)
  const entry = { expires: Date.now() + DOI_CACHE_MS, result }
  cache.delete(doi)
  cache.set(doi, entry)
  while (cache.size > DOI_CACHE_SIZE) cache.delete(cache.keys().next().value!)
  const entries = cache
  void result.catch(() => {
    if (entries.get(doi) === entry) entries.delete(doi)
  })
  return result
}

const completeLiteraturePdfDraft = async (
  draft: LiteratureItemInput
): Promise<LiteratureItemInput> => {
  const doi = draft.identifiers?.find(({ scheme }) => scheme === 'doi')?.value
  if (!doi) return draft
  try {
    const resolved = await lookupPdfDoi(doi)
    // Remote defaults must not erase fields present only in the PDF metadata.
    const populated = Object.fromEntries(
      Object.entries(resolved).filter(([, value]) =>
        typeof value === 'string'
          ? value.trim().length > 0
          : value !== undefined &&
            (typeof value !== 'object' || (value !== null && Object.keys(value).length > 0))
      )
    )
    return { ...draft, ...populated, identifiers: draft.identifiers }
  } catch {
    return draft
  }
}

const textValue = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const pdfInfoValue = (info: Record<string, unknown>, key: string): string => {
  const direct = textValue(info[key])
  if (direct) return direct
  const custom = info.Custom
  return typeof custom === 'object' && custom !== null
    ? textValue((custom as Record<string, unknown>)[key])
    : ''
}

const creatorsFromAuthor = (author: string): LiteratureCreatorInput[] =>
  author
    .split(/\s*;\s*|\s+and\s+/iu)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((familyName) => ({
      nameMode: 'person' as const,
      givenName: '',
      familyName,
      creatorType: 'author'
    }))

const parseLiteraturePdfMetadata = (
  info: Record<string, unknown>,
  text: string
): Partial<LiteratureItemInput> => {
  const custom =
    typeof info.Custom === 'object' && info.Custom !== null
      ? Object.values(info.Custom as Record<string, unknown>)
      : []
  const searchableText = `${[...Object.values(info), ...custom]
    .filter((value) => typeof value === 'string')
    .join('\n')}\n${text}`
  const doi = searchableText
    .match(DOI_PATTERN)
    ?.map((value) => normalizeLiteratureIdentifierValue('doi', value))
    .find(Boolean)
  const pmid = PMID_PATTERN.exec(searchableText)?.[1]
  const title = pdfInfoValue(info, 'Title')
  const author = pdfInfoValue(info, 'Author')
  const journal = pdfInfoValue(info, 'Journal')
  const date = pdfInfoValue(info, 'CreationDate') || pdfInfoValue(info, 'ModDate')
  const year = /(?:D:)?((?:19|20)\d{2})/u.exec(date)?.[1]
  const identifiers = [
    ...(doi ? [{ scheme: 'doi' as const, value: doi, isPrimary: true }] : []),
    ...(pmid ? [{ scheme: 'pmid' as const, value: pmid, isPrimary: !doi }] : [])
  ]

  return {
    ...(title ? { title } : {}),
    ...(author ? { creators: creatorsFromAuthor(author) } : {}),
    ...(journal ? { containerTitle: journal } : {}),
    ...(year ? { issuedYear: Number(year), issuedText: year } : {}),
    ...(doi ? { url: createLiteratureIdentifierUrl('doi', doi) ?? '' } : {}),
    ...(identifiers.length > 0 ? { identifiers } : {})
  }
}

const extractLiteraturePdfDraft = async (
  file: File,
  fallback: LiteratureItemInput
): Promise<LiteratureItemInput> => {
  if (file.size > MAX_LOCAL_PDF_METADATA_BYTES) return fallback

  const { pdfjsLib } = await import('../workspace/previews/pdfjs')
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  const document = await loadingTask.promise
  try {
    const { info } = await document.getMetadata()
    const pageTexts: string[] = []
    for (let pageNumber = 1; pageNumber <= Math.min(2, document.numPages); pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      page.cleanup()
      pageTexts.push(joinPdfTextItems(content.items.map((item) => ('str' in item ? item : {}))))
    }
    const extracted = parseLiteraturePdfMetadata(
      info as Record<string, unknown>,
      pageTexts.join('\n').slice(0, 30_000)
    )
    return { ...fallback, ...extracted }
  } finally {
    await document.destroy()
  }
}

export { completeLiteraturePdfDraft, extractLiteraturePdfDraft, parseLiteraturePdfMetadata }
