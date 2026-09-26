import type { TFunction } from 'i18next'
import {
  createLiteratureIdentifierUrl,
  normalizeLiteratureIdentifierValue,
  type LiteratureCreatorInput,
  type LiteratureItemInput
} from '../../../../shared/literature'
import { joinPdfTextItems, type PdfTextItem } from '../../../../shared/pdf-text'

const MAX_LOCAL_PDF_METADATA_BYTES = 50 * 1024 * 1024
const DOI_PATTERN = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/giu
const PMID_PATTERN = /\b(?:PMID|PubMed\s+ID)\s*:?\s*(\d{1,9})\b/iu

type PdfMetadataNotice = Readonly<{ textUnavailable?: boolean; lookupFailed?: boolean }>
type Notice = (notice: PdfMetadataNotice) => void
const draftTitles = new WeakMap<LiteratureItemInput, string>()

// A terminal publication block is stronger evidence than a DOI somewhere in References.
const PUBLICATION_DOI_PATTERN =
  /(?:^|\n)Accepted[^\n]*\b\d{4}\s*\nPublished[^\n]*\b\d{4}\s*\n(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)\s*$/iu

const comparableTitle = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')

const prominentPdfTitle = (items: readonly PdfTextItem[]): string => {
  const height = (item: PdfTextItem): number =>
    item.height ?? (item.transform ? Math.hypot(item.transform[2], item.transform[3]) : 0)
  const textItems = items.filter((item) => item.str?.trim())
  const heights = [...new Set(textItems.map(height))].sort((a, b) => b - a)
  for (const size of heights) {
    if (!size) continue
    const title = joinPdfTextItems(textItems.filter((item) => Math.abs(height(item) - size) < 0.1))
      .replace(/\s+/gu, ' ')
      .trim()
    if (
      title.length >= 20 &&
      title.length <= 500 &&
      !/^(?:abstract|keywords|references)\b/iu.test(title)
    )
      return title
  }
  return ''
}

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
  if (cached && cached.expires > Date.now()) {
    cache.delete(doi)
    cache.set(doi, cached)
    return cached.result
  }
  const result = lookup(doi)
  // The TTL covers reusable results, not time spent waiting for the network.
  const entry = { expires: Number.POSITIVE_INFINITY, result }
  cache.delete(doi)
  cache.set(doi, entry)
  while (cache.size > DOI_CACHE_SIZE) cache.delete(cache.keys().next().value!)
  const entries = cache
  void result.then(
    () => {
      entry.expires = Date.now() + DOI_CACHE_MS
    },
    () => {
      if (entries.get(doi) === entry) entries.delete(doi)
    }
  )
  return result
}

const hasMetadataValue = (value: unknown): boolean =>
  typeof value === 'string'
    ? value.trim().length > 0
    : value !== undefined &&
      value !== null &&
      (typeof value !== 'object' || Object.keys(value).length > 0)

const completeLiteraturePdfDraft = async (
  draft: LiteratureItemInput,
  onNotice?: Notice
): Promise<LiteratureItemInput> => {
  const identifiers = draft.identifiers.filter(
    ({ scheme }) => scheme === 'doi' || scheme === 'pmid'
  )
  if (!identifiers.length) {
    onNotice?.({ lookupFailed: true })
    return draft
  }
  let completed = draft
  const rejected = new Set<(typeof identifiers)[number]>()
  for (const identifier of identifiers) {
    try {
      const resolved = await lookupPdfDoi(
        identifier.scheme === 'pmid' ? `pmid:${identifier.value}` : identifier.value
      )
      const title = draftTitles.get(draft)
      if (title && comparableTitle(resolved.title) !== comparableTitle(title)) {
        rejected.add(identifier)
        continue
      }
      const conflictingIdentifier = completed.identifiers
        .filter((entry) => !rejected.has(entry))
        .some(
          (local) =>
            (local.scheme === 'doi' || local.scheme === 'pmid') &&
            resolved.identifiers.some(
              (remote) =>
                remote.scheme === local.scheme &&
                normalizeLiteratureIdentifierValue(remote.scheme, remote.value).toLowerCase() !==
                  normalizeLiteratureIdentifierValue(local.scheme, local.value).toLowerCase()
            )
        )
      if (conflictingIdentifier) continue
      // The first verified source completes the local draft; later sources only fill gaps.
      const supplemental = completed !== draft
      const populated = Object.fromEntries(
        Object.entries(resolved).filter(
          ([key, value]) =>
            hasMetadataValue(value) &&
            (!supplemental || !hasMetadataValue(completed[key as keyof LiteratureItemInput]))
        )
      )
      const typeFields = Object.fromEntries(
        Object.entries(resolved.typeFields).filter(
          ([key, value]) =>
            hasMetadataValue(value) &&
            (!supplemental || !hasMetadataValue(completed.typeFields[key]))
        )
      )
      const mergedIdentifiers = completed.identifiers.filter((entry) => !rejected.has(entry))
      for (const remote of resolved.identifiers) {
        if (
          !mergedIdentifiers.some(
            (local) =>
              local.scheme === remote.scheme &&
              normalizeLiteratureIdentifierValue(local.scheme, local.value).toLowerCase() ===
                normalizeLiteratureIdentifierValue(remote.scheme, remote.value).toLowerCase()
          )
        )
          mergedIdentifiers.push({ ...remote, isPrimary: false })
      }
      completed = {
        ...completed,
        ...populated,
        typeFields: { ...completed.typeFields, ...typeFields },
        identifiers: mergedIdentifiers
      }
      if (completed.abstract) return completed
    } catch {
      /* Try another identifier; retain the local draft on network failure. */
    }
  }
  onNotice?.({ lookupFailed: true })
  if (!rejected.size) return completed
  return {
    ...completed,
    identifiers: completed.identifiers.filter((entry) => !rejected.has(entry)),
    url: [...rejected].some(
      (entry) => createLiteratureIdentifierUrl(entry.scheme, entry.value) === completed.url
    )
      ? ''
      : completed.url
  }
}

// Keep paragraph gaps from first-page geometry, needed for unheaded structured abstracts.
const pageText = (items: readonly PdfTextItem[]): string => {
  const spaced: PdfTextItem[] = []
  let previous: PdfTextItem | undefined
  for (const item of items) {
    if (
      previous?.transform &&
      item.transform &&
      previous.transform[5] - item.transform[5] >
        Math.max(previous.height ?? 0, item.height ?? 0, 1) * 1.6
    )
      spaced.push({ str: '\n\n' })
    spaced.push(item)
    if (item.str?.trim()) previous = item
  }
  return joinPdfTextItems(spaced)
}

const pdfAbstract = (text: string): string => {
  const heading = /(?:^|\n)\s*(?:abstract|summary)\s*[:.—-]?\s*\n/iu.exec(text)
  const structured = /(?:^|\n)\s*(?:background|objective|objectives|purpose)\s*:/iu.exec(text)
  const start = heading ? heading.index + heading[0].length : structured?.index
  if (start === undefined) return ''
  const tail = text.slice(start)
  const boundary =
    /\n\s*(?:(?:\d+\.?|I)\s+)?(?:introduction|keywords?|key words|abbreviations|©|copyright)\b/iu.exec(
      tail
    )
  let end = boundary?.index
  if (!heading) {
    const conclusion = /(?:^|\n)\s*(?:conclusions?|interpretation)\s*:/iu.exec(tail)
    if (
      !conclusion ||
      !/(?:^|\n)\s*(?:methods?|results?)\s*:/iu.test(tail.slice(0, conclusion.index))
    )
      return ''
    const gap = /\n\s*\n/u.exec(tail.slice(conclusion.index + conclusion[0].length))
    if (gap) end = Math.min(end ?? Infinity, conclusion.index + conclusion[0].length + gap.index)
  }
  if (end === undefined) return ''
  const abstract = tail.slice(0, end).trim()
  return abstract.length >= 80 && abstract.length <= 10000
    ? abstract
        .replace(/([^\n])\n(?!\s*\n)/gu, '$1 ')
        .replace(/[^\S\n]+/gu, ' ')
        .replace(/\n{3,}/gu, '\n\n')
        .trim()
    : ''
}

const meaningfulTitle = (value: string): boolean =>
  value.trim().length >= 8 &&
  !/^(?:untitled|microsoft (?:word|powerpoint)|acrobat|document\d*)\b|\.(?:pdf|docx?|tex)$/iu.test(
    value.trim()
  )

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
    .join('\n')}\n${text.split(/(?:^|\n)\s*(?:references|bibliography)\s*(?:\n|$)/iu)[0]}`
  const doi = searchableText
    .match(DOI_PATTERN)
    ?.map((value) => normalizeLiteratureIdentifierValue('doi', value))
    .find(Boolean)
  const pmid = PMID_PATTERN.exec(searchableText)?.[1]
  const embeddedTitle = pdfInfoValue(info, 'Title')
  const title = meaningfulTitle(embeddedTitle) ? embeddedTitle : ''
  const abstract = pdfInfoValue(info, 'Abstract') || pdfAbstract(text)
  const author = pdfInfoValue(info, 'Author')
  const journal = pdfInfoValue(info, 'Journal')
  const date = pdfInfoValue(info, 'PublicationDate')
  const year = /(?:D:)?((?:19|20)\d{2})/u.exec(date)?.[1]
  const identifiers = [
    ...(doi ? [{ scheme: 'doi' as const, value: doi, isPrimary: true }] : []),
    ...(pmid ? [{ scheme: 'pmid' as const, value: pmid, isPrimary: !doi }] : [])
  ]

  return {
    ...(title ? { title } : {}),
    ...(abstract ? { abstract } : {}),
    ...(author ? { creators: creatorsFromAuthor(author) } : {}),
    ...(journal ? { containerTitle: journal } : {}),
    ...(year ? { issuedYear: Number(year), issuedText: year } : {}),
    ...(doi ? { url: createLiteratureIdentifierUrl('doi', doi) ?? '' } : {}),
    ...(identifiers.length > 0 ? { identifiers } : {})
  }
}

const extractLiteraturePdfDraft = async (
  file: File,
  fallback: LiteratureItemInput,
  onNotice?: Notice
): Promise<LiteratureItemInput> => {
  if (file.size > MAX_LOCAL_PDF_METADATA_BYTES) {
    onNotice?.({ textUnavailable: true })
    return fallback
  }

  const { pdfjsLib } = await import('../workspace/previews/pdfjs')
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  let document: Awaited<typeof loadingTask.promise>
  try {
    document = await loadingTask.promise
  } catch (error) {
    await loadingTask.destroy()
    onNotice?.({ textUnavailable: true })
    throw error
  }
  try {
    let info: Record<string, unknown> = {}
    try {
      const metadata = await document.getMetadata()
      info = { ...(metadata.info as Record<string, unknown>) }
      const xmp = metadata.metadata
      const xmpText = (key: string): string => {
        const value = xmp?.get(key)
        return Array.isArray(value)
          ? value.filter((entry) => typeof entry === 'string').join('; ')
          : typeof value === 'string'
            ? value
            : ''
      }
      if (!meaningfulTitle(pdfInfoValue(info, 'Title'))) info.Title = xmpText('dc:title')
      if (!pdfInfoValue(info, 'Author')) info.Author = xmpText('dc:creator')
      info.Abstract = pdfInfoValue(info, 'Abstract') || xmpText('prism:abstract')
      info.PublicationDate =
        pdfInfoValue(info, 'PublicationDate') || xmpText('prism:publicationdate')
      info.Journal = pdfInfoValue(info, 'Journal') || xmpText('prism:publicationname')
      info.DOI = pdfInfoValue(info, 'DOI') || xmpText('prism:doi')
    } catch {
      onNotice?.({ textUnavailable: true })
    }
    const pageTexts: string[] = []
    let firstPageTitle = ''
    for (let pageNumber = 1; pageNumber <= Math.min(2, document.numPages); pageNumber += 1) {
      try {
        const page = await document.getPage(pageNumber)
        try {
          const content = await page.getTextContent()
          const items = content.items.map((item) => ('str' in item ? item : {}))
          if (pageNumber === 1) firstPageTitle = prominentPdfTitle(items)
          pageTexts.push(pageText(items))
        } finally {
          page.cleanup()
        }
      } catch {
        onNotice?.({ textUnavailable: true })
      }
    }
    if (!pageTexts.some((text) => text.trim())) onNotice?.({ textUnavailable: true })
    const extracted = parseLiteraturePdfMetadata(
      info as Record<string, unknown>,
      pageTexts.join('\n').slice(0, 30_000)
    )
    const draft = { ...fallback, ...extracted }
    if (!extracted.title && firstPageTitle) draft.title = firstPageTitle
    if (firstPageTitle) draftTitles.set(draft, firstPageTitle)
    if (!draft.identifiers.some(({ scheme }) => scheme === 'doi') && document.numPages > 2) {
      try {
        const page = await document.getPage(document.numPages)
        let text: string
        try {
          const content = await page.getTextContent()
          text = joinPdfTextItems(content.items.map((item) => ('str' in item ? item : {}))).slice(
            -4_000
          )
        } finally {
          page.cleanup()
        }
        const doi = PUBLICATION_DOI_PATTERN.exec(text)?.[1]
        if (doi && firstPageTitle.length >= 20) {
          const normalized = normalizeLiteratureIdentifierValue('doi', doi)
          const resolved = await lookupPdfDoi(normalized)
          // A valid DOI may belong to a cited paper. Require the complete prominent title,
          // not the embedded Title, a substring in the abstract, or a fuzzy title match.
          if (comparableTitle(resolved.title) === comparableTitle(firstPageTitle)) {
            return {
              ...draft,
              url: createLiteratureIdentifierUrl('doi', normalized) ?? '',
              identifiers: [
                { scheme: 'doi', value: normalized, isPrimary: true },
                ...draft.identifiers.map((identifier) => ({ ...identifier, isPrimary: false }))
              ]
            }
          }
        }
      } catch {
        // Optional tail parsing or lookup must not discard the local metadata already read.
      }
    }
    return draft
  } finally {
    await document.destroy()
  }
}

export { completeLiteraturePdfDraft, extractLiteraturePdfDraft, parseLiteraturePdfMetadata }

export const pdfMetadataNoticeLabel = (notice: PdfMetadataNotice, t: TFunction): string =>
  notice.textUnavailable
    ? t(
        'PDF text could not be read. For scanned pages, use a searchable PDF. Review the metadata before importing.'
      )
    : t('Some metadata could not be retrieved. Review the available details before importing.')
