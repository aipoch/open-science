import { SourceError } from './related-source-error.js'
import { z } from 'zod'
import {
  bibliographicRecordSchema,
  createLiteratureIdentifierUrl,
  normalizeLiteratureIdentifierKey,
  normalizeLiteratureIdentifierValue,
  type BibliographicRecord
} from '@aipoch/literature-citations/contracts'
import type { DiscoveryReference } from './contracts.js'
import type { LiteratureRelatedRecord } from './related-contracts.js'

const text = z.string().max(100_000)
const maxReferenceIds = 2000

// A complete snapshot must fit before any relationship can be published.
export function boundedSnapshotRows(raw: unknown): unknown {
  if (Array.isArray(raw) && raw.length > maxReferenceIds) throw new SourceError('source-limit')
  return raw
}
const nativePaperId = /^opencitations:br\/(\d{1,30})$/
const productUrl = /^https:\/\/w3id\.org\/oc\/meta\/br\/(\d{1,30})$/
export type OpenCitationsReferenceSnapshot = readonly string[]
const paperSchema = z.object({
  local_identifier: text.optional(),
  related_products: z.unknown().optional(),
  titles: z.record(z.string(), z.array(text).max(100)).nullish(),
  identifiers: z
    .array(z.object({ scheme: text, value: text }))
    .max(2000)
    .default([]),
  contributions: z
    .array(
      z.object({
        role: text,
        rank: z.number().nullish(),
        by: z.object({
          name: text.optional(),
          entity_type: text.optional(),
          given_name: text.optional(),
          family_name: text.optional()
        })
      })
    )
    .max(2000)
    .default([]),
  manifestations: z
    .array(
      z.object({
        type: z.object({ class: text.optional() }).nullish(),
        dates: z.object({ publication: z.array(text).max(100).optional() }).nullish(),
        biblio: z
          .object({
            volume: text.optional(),
            issue: text.optional(),
            pages: z.object({ first: text.optional(), last: text.optional() }).nullish(),
            in: z.object({ name: text.optional() }).nullish()
          })
          .nullish()
      })
    )
    .max(100)
    .default([])
})
const pageSchema = z.object({
  meta: z.object({
    local_identifier: text,
    next_page: z.object({ local_identifier: text }).nullish(),
    part_of: z.object({ total_items: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
  }),
  '@graph': z.array(paperSchema).max(20)
})
type Read = (path: string, query: Record<string, string>) => Promise<unknown>
type Paper = z.infer<typeof paperSchema>

function doiValues(identifiers: readonly { scheme: string; value: string }[]): string[] {
  return [
    ...new Set(
      identifiers
        .filter(({ scheme }) => scheme === 'doi')
        .map(({ value }) => normalizeLiteratureIdentifierKey('doi', value))
        .filter((value) => createLiteratureIdentifierUrl('doi', value))
    )
  ]
}

function record(paper: Paper): LiteratureRelatedRecord | undefined {
  const match = /^https:\/\/w3id\.org\/oc\/meta\/br\/(\d{1,30})$/.exec(paper.local_identifier ?? '')
  const title = [
    ...(paper.titles?.none ?? []),
    ...(paper.titles?.en ?? []),
    ...Object.values(paper.titles ?? {}).flat()
  ].find((value) => value.trim())
  if (!match || !title) return undefined
  const identifiers = paper.identifiers.flatMap<{
    scheme: BibliographicRecord['identifiers'][number]['scheme']
    value: string
  }>(({ scheme, value: raw }) => {
    if (!['doi', 'pmid', 'pmcid', 'arxiv', 'isbn', 'issn'].includes(scheme)) return []
    const known = scheme as 'doi' | 'pmid' | 'pmcid' | 'arxiv' | 'isbn' | 'issn'
    const value = normalizeLiteratureIdentifierValue(known, raw)
    // ISBN and ISSN are bibliographic identifiers, without a resolver URL in the shared helper.
    return known === 'isbn' || known === 'issn'
      ? value.trim()
        ? [{ scheme: known, value }]
        : []
      : createLiteratureIdentifierUrl(known, value)
        ? [{ scheme: known, value }]
        : []
  })
  const manifestation = paper.manifestations[0]
  const kind = manifestation?.type?.class?.split('/').at(-1)
  const itemType =
    kind === 'JournalArticle'
      ? 'journalArticle'
      : kind === 'ReviewArticle' || kind === 'Review'
        ? 'review'
        : kind === 'ConferencePaper' || kind === 'ProceedingsPaper'
          ? 'conferencePaper'
          : kind === 'Book'
            ? 'book'
            : kind === 'BookChapter'
              ? 'bookSection'
              : kind === 'Preprint'
                ? 'preprint'
                : kind === 'Thesis'
                  ? 'thesis'
                  : kind === 'Report'
                    ? 'report'
                    : 'document'
  const publication = manifestation?.dates?.publication?.[0] ?? ''
  // SKG-IF encodes publication dates with a midnight time. Preserve the source's
  // calendar date without timezone conversion, and retain year/month precision.
  const date =
    /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/.exec(
      publication
    )?.[1] ?? publication
  const year = /^([0-9]{4})(?:-|$)/.exec(date)
  const creators = [...paper.contributions]
    .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER))
    .filter(({ role }) => role === 'author')
    .flatMap<BibliographicRecord['creators'][number]>(({ by }) => {
      if (by.entity_type === 'person' && (by.given_name?.trim() || by.family_name?.trim()))
        return [
          {
            nameMode: 'person' as const,
            givenName: by.given_name ?? '',
            familyName: by.family_name ?? '',
            creatorType: 'author'
          }
        ]
      return by.name?.trim()
        ? [
            {
              nameMode: 'organization' as const,
              literalName: by.name,
              creatorType: 'author'
            }
          ]
        : []
    })
  const biblio = manifestation?.biblio
  return {
    paperId: `opencitations:br/${match[1]}`,
    item: bibliographicRecordSchema.parse({
      itemType,
      title: title.trim(),
      issuedText: date,
      issuedYear: year && Number(year[1]) > 0 ? Number(year[1]) : undefined,
      containerTitle: biblio?.in?.name ?? '',
      url: `https://w3id.org/oc/meta/br/${match[1]}`,
      creators,
      identifiers,
      typeFields: {
        ...(biblio?.volume ? { volume: biblio.volume } : {}),
        ...(biblio?.issue ? { issue: biblio.issue } : {}),
        ...(biblio?.pages?.first
          ? {
              pages:
                biblio.pages.last && biblio.pages.last !== biblio.pages.first
                  ? `${biblio.pages.first}-${biblio.pages.last}`
                  : biblio.pages.first
            }
          : {})
      }
    })
  }
}

function validatePageUrl(value: string, filter: string, page: number): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new z.ZodError([])
  }
  if (
    url.origin !== 'https://api.opencitations.net' ||
    url.pathname !== '/skg-if/v1/products' ||
    url.username ||
    url.password ||
    url.hash ||
    [...url.searchParams.keys()].length !== 3 ||
    url.searchParams.get('filter') !== filter ||
    url.searchParams.get('page') !== String(page) ||
    url.searchParams.get('page_size') !== '20'
  )
    throw new z.ZodError([])
}

async function readPage(
  filter: string,
  offset: number,
  read: Read
): Promise<{ rows: Paper[]; hasNext: boolean; total: number }> {
  if (offset % 20 !== 0) throw new z.ZodError([])
  const pageNumber = offset / 20 + 1
  const page = pageSchema.parse(
    await read('skg-if/v1/products', { filter, page: String(pageNumber), page_size: '20' })
  )
  validatePageUrl(page.meta.local_identifier, filter, pageNumber)
  const total = page.meta.part_of.total_items
  const hasNext = offset + 20 < total
  if (
    (!page['@graph'].length && offset < total) ||
    page['@graph'].length > Math.max(0, total - offset) ||
    (hasNext && !page.meta.next_page) ||
    (!hasNext && page.meta.next_page)
  )
    throw new z.ZodError([])
  if (page.meta.next_page)
    validatePageUrl(page.meta.next_page.local_identifier, filter, pageNumber + 1)
  // JSON-LD contexts and pagination links are data only. Every request is reconstructed.
  return { rows: page['@graph'], hasNext, total }
}

export async function resolveOpenCitations(
  item: DiscoveryReference,
  read: Read,
  savedSourceIds: () => Promise<string[]>
): Promise<
  { seed: LiteratureRelatedRecord; references: OpenCitationsReferenceSnapshot } | undefined
> {
  const dois = doiValues(item.item.identifiers)
  let matches: Paper[]
  if (dois.length === 1) {
    const doi = dois[0]
    const page = await readPage(`identifiers.scheme:doi,identifiers.id:${doi}`, 0, read)
    if (page.hasNext) throw new SourceError('source-limit')
    if (page.rows.length !== page.total) throw new z.ZodError([])
    matches = page.rows.filter((paper) => {
      const values = doiValues(paper.identifiers)
      return values.length === 1 && values[0] === doi
    })
    if (matches.length && matches.length !== page.rows.length) throw new z.ZodError([])
  } else {
    if (dois.length) return undefined
    const ids = [...new Set((await savedSourceIds()).filter((id) => nativePaperId.test(id)))]
    if (ids.length !== 1) return undefined
    matches = [await readNativePaper(ids[0], read)]
  }
  for (const paper of matches) {
    for (const scheme of ['pmid', 'pmcid', 'arxiv'] as const) {
      const saved = item.item.identifiers.filter((entry) => entry.scheme === scheme)
      const supplied = paper.identifiers.filter((entry) => entry.scheme === scheme)
      if (
        saved.length === 1 &&
        supplied.some(
          (entry) =>
            normalizeLiteratureIdentifierKey(scheme, entry.value) !==
            normalizeLiteratureIdentifierKey(scheme, saved[0].value)
        )
      )
        return undefined
    }
  }
  if (!matches.length) return undefined
  const seed = matches
    .flatMap((paper) => {
      const entry = record(paper)
      return entry ? [entry] : []
    })
    .sort((a, b) => a.paperId.localeCompare(b.paperId, 'en'))[0]
  if (!seed) return undefined
  // A saved OMID may have gained a DOI. Include its DOI aliases just as for a discovered center.
  const references =
    !dois.length && doiValues(seed.item.identifiers).length === 1
      ? await readReferenceSnapshot(seed, read)
      : referenceSnapshot(matches)
  return { seed, references }
}

function referenceSnapshot(papers: Paper[]): OpenCitationsReferenceSnapshot {
  const ids = new Set<string>()
  for (const paper of papers) {
    if (!productUrl.test(paper.local_identifier ?? '')) throw new z.ZodError([])
    const related = z
      .object({
        cites: z.preprocess(boundedSnapshotRows, z.array(text.regex(productUrl))).optional()
      })
      .optional()
      .parse(paper.related_products)
    for (const id of related?.cites ?? []) {
      ids.add(id)
      if (ids.size > maxReferenceIds) throw new SourceError('source-limit')
    }
  }
  return [...ids].sort()
}

async function readReferenceSnapshot(
  seed: LiteratureRelatedRecord,
  read: Read
): Promise<OpenCitationsReferenceSnapshot> {
  const dois = doiValues(seed.item.identifiers)
  if (dois.length === 1) {
    const page = await readPage(`identifiers.scheme:doi,identifiers.id:${dois[0]}`, 0, read)
    // Every DOI alias must be present and independently verified before publishing
    // a stable adjacency snapshot. Never silently take only its first page.
    if (page.hasNext) throw new SourceError('source-limit')
    if (
      page.rows.length !== page.total ||
      !page.rows.length ||
      page.rows.some((paper) => {
        const values = doiValues(paper.identifiers)
        return values.length !== 1 || values[0] !== dois[0]
      })
    )
      throw new z.ZodError([])
    return referenceSnapshot(page.rows)
  }
  return referenceSnapshot([await readNativePaper(seed.paperId, read)])
}

async function readNativePaper(id: string, read: Read): Promise<Paper> {
  const match = nativePaperId.exec(id)
  if (!match) throw new z.ZodError([])
  const identity = `https://w3id.org/oc/meta/br/${match[1]}`
  const path = `skg-if/v1/products/${identity}`
  const response = z
    .object({
      meta: z.object({ local_identifier: text }),
      '@graph': z.array(paperSchema).length(1)
    })
    .parse(await read(path, {}))
  if (
    response.meta.local_identifier !== `https://api.opencitations.net/${path}` ||
    response['@graph'][0].local_identifier !== identity
  )
    throw new z.ZodError([])
  return response['@graph'][0]
}

const metaPaperSchema = z.object({
  id: text,
  title: text.nullish(),
  author: text.nullish(),
  pub_date: text.nullish(),
  venue: text.nullish(),
  volume: text.nullish(),
  issue: text.nullish(),
  page: text.nullish(),
  type: text.nullish()
})

function stripMetaIdentifiers(value: string): string {
  // Meta documents the bracketed identifier suffix. Preserve names literally;
  // neither commas nor spaces establish personal name boundaries.
  return value.replace(/\s+\[(?:[a-z]+:[^\]\s]+\s*)+\]$/, '').trim()
}

function metaIdentifiers(value: string): { scheme: string; value: string }[] {
  return value.split(/\s+/).flatMap((identifier) => {
    const match = /^(doi|pmid|pmcid|arxiv|isbn|issn):(.+)$/.exec(identifier)
    return match ? [{ scheme: match[1], value: match[2] }] : []
  })
}

export function openCitationsMetaRecord(
  id: string,
  paper: z.infer<typeof metaPaperSchema>
): LiteratureRelatedRecord | undefined {
  if (!paper.title?.trim()) return undefined
  const identifiers = metaIdentifiers(paper.id)
  const type = {
    'journal article': 'JournalArticle',
    'review article': 'ReviewArticle',
    review: 'Review',
    'proceedings article': 'ProceedingsPaper',
    'conference paper': 'ConferencePaper',
    book: 'Book',
    'book chapter': 'BookChapter',
    preprint: 'Preprint',
    thesis: 'Thesis',
    report: 'Report'
  }[paper.type?.toLowerCase() ?? '']
  return record({
    local_identifier: id,
    titles: { none: [paper.title] },
    identifiers,
    contributions: (paper.author ?? '')
      .split(';')
      .map(stripMetaIdentifiers)
      .filter(Boolean)
      .map((name, rank) => ({ role: 'author', by: { name }, rank })),
    manifestations: [
      {
        type: type ? { class: `http://purl.org/spar/fabio/${type}` } : undefined,
        dates: { publication: paper.pub_date ? [paper.pub_date] : [] },
        biblio: {
          in: { name: stripMetaIdentifiers(paper.venue ?? '') },
          volume: paper.volume ?? undefined,
          issue: paper.issue ?? undefined,
          pages: paper.page ? { first: paper.page } : undefined
        }
      }
    ]
  })
}

export function parseOpenCitationsMetadata(raw: unknown): z.infer<typeof metaPaperSchema>[] {
  return z.array(metaPaperSchema).parse(boundedSnapshotRows(raw))
}

export async function readOpenCitationsRecords(
  ids: readonly string[],
  read: Read,
  expectedDois?: ReadonlyMap<string, readonly string[]>
): Promise<{ records: LiteratureRelatedRecord[]; omitted?: number }> {
  if (ids.length > 20 || ids.some((id) => !productUrl.test(id))) throw new z.ZodError([])
  if (!ids.length) return { records: [] }
  const requested = ids.map((id) => `omid:br/${productUrl.exec(id)![1]}`)
  // One requested OMID can produce multiple Meta rows, including DOI aliases.
  // Only an exact complete identifier token authorizes a returned graph record.
  const papers = parseOpenCitationsMetadata(
    await read(`meta/v1/metadata/${requested.join('__')}`, {})
  )
  const records: LiteratureRelatedRecord[] = []
  let omitted = 0
  for (let index = 0; index < ids.length; index++) {
    const matchingPapers = papers.filter((paper) =>
      paper.id.split(/\s+/).includes(requested[index])
    )
    const expected = expectedDois?.get(ids[index])
    // Identity evidence remains relevant even when a row has no display title.
    // A DOI-less display row must not hide an explicit Index/Meta mismatch.
    const suppliedDois = matchingPapers.flatMap((paper) => doiValues(metaIdentifiers(paper.id)))
    if (
      expected?.length &&
      suppliedDois.length &&
      !suppliedDois.some((doi) => expected.includes(doi))
    )
      throw new z.ZodError([])
    const candidates = matchingPapers
      .map((paper) => openCitationsMetaRecord(ids[index], paper))
      .filter((entry): entry is LiteratureRelatedRecord => entry !== undefined)
      // Pick a deterministic display row without manufacturing a new identity.
      .sort((a, b) => JSON.stringify(a.item).localeCompare(JSON.stringify(b.item), 'en'))
    // Index DOI evidence must select the display row before downstream validation.
    // Keep explicit conflicts visible when no row matches; a DOI-less alias must
    // not hide them. SKG-IF and Index neighbors without DOI evidence keep their order.
    const selected = expected?.length
      ? (candidates.find((entry) =>
          entry.item.identifiers.some(
            ({ scheme, value }) =>
              scheme === 'doi' && expected.includes(normalizeLiteratureIdentifierKey('doi', value))
          )
        ) ??
        candidates.find((entry) => entry.item.identifiers.some(({ scheme }) => scheme === 'doi')) ??
        candidates[0])
      : candidates[0]
    if (selected) records.push(selected)
    else omitted++
  }
  return { records, ...(omitted ? { omitted } : {}) }
}

export async function readOpenCitationsReferences(
  seed: LiteratureRelatedRecord,
  offset: number,
  read: Read,
  snapshot?: OpenCitationsReferenceSnapshot
): Promise<{
  records: LiteratureRelatedRecord[]
  nextOffset?: number
  omitted?: number
  snapshot: OpenCitationsReferenceSnapshot
}> {
  if (offset % 20 !== 0) throw new z.ZodError([])
  const references = snapshot ?? (await readReferenceSnapshot(seed, read))
  const ids = references.slice(offset, offset + 20)
  if (!ids.length) return { records: [], snapshot: references }
  const page = await readOpenCitationsRecords(ids, read)
  return {
    ...page,
    snapshot: references,
    ...(offset + ids.length < references.length ? { nextOffset: offset + 20 } : {})
  }
}

export async function readOpenCitationsPage(
  seed: LiteratureRelatedRecord,
  direction: 'references' | 'citations',
  offset: number,
  read: Read
): Promise<{ records: LiteratureRelatedRecord[]; nextOffset?: number; omitted?: number }> {
  if (direction === 'references') {
    const page = await readOpenCitationsReferences(seed, offset, read)
    return { records: page.records, nextOffset: page.nextOffset, omitted: page.omitted }
  }
  const match = /^opencitations:br\/(\d{1,30})$/.exec(seed.paperId)
  if (!match) throw new z.ZodError([])
  const dois = doiValues(seed.item.identifiers)
  const relation = 'cites'
  const filter =
    dois.length === 1
      ? `cf.${relation}_doi:${dois[0]}`
      : `cf.${relation}:https://w3id.org/oc/meta/br/${match[1]}`
  const page = await readPage(filter, offset, read)
  const records = new Map<string, LiteratureRelatedRecord>()
  let omitted = 0
  for (const paper of page.rows) {
    const entry = record(paper)
    if (!entry) omitted++
    else records.set(entry.paperId, entry)
  }
  return {
    records: [...records.values()],
    ...(page.hasNext ? { nextOffset: offset + 20 } : {}),
    ...(omitted ? { omitted } : {})
  }
}
