import { z } from 'zod'
import { SaxesParser } from 'saxes'
import {
  bibliographicRecordSchema,
  normalizeLiteratureIdentifierValue,
  normalizeLiteratureIdentifierKey,
  createLiteratureIdentifierUrl
} from '@aipoch/literature-citations/contracts'
import type { DiscoveryReference } from './contracts.js'
import {
  literatureRelatedPaperIdSchema,
  type LiteratureRelatedRecord
} from './related-contracts.js'

const text = z.string().max(100_000).nullish()
const paperSchema = z.object({
  source: z.string().max(12).optional(),
  id: z.string().max(128).optional(),
  title: text,
  doi: text,
  pmid: text,
  pmcid: text,
  authorString: text,
  authorList: z.object({ author: z.array(z.object({ fullName: text })).max(2000) }).nullish(),
  abstractText: text,
  pubYear: z.union([z.string().max(4), z.number().int()]).nullish(),
  firstPublicationDate: text,
  journalAbbreviation: text,
  journalTitle: text,
  journalInfo: z.object({ journal: z.object({ title: text }).nullish() }).nullish(),
  volume: text,
  issue: text,
  pageInfo: text,
  citationType: text,
  pubTypeList: z.object({ pubType: z.array(z.string().max(1000)).max(200) }).nullish()
})
type Paper = z.infer<typeof paperSchema>
type Read = (path: string, query: Record<string, string>) => Promise<unknown>

function plainTitle(raw: string): string {
  let value = raw.trim()
  // Europe PMC supplies both XML formatting and entity-escaped XML in JSON titles.
  for (let pass = 0; pass < 2 && /[<&]/u.test(value); pass++) {
    const parser = new SaxesParser({ fragment: true })
    let result = ''
    let invalid = false
    parser.on('error', () => {
      invalid = true
    })
    parser.on('doctype', () => {
      invalid = true
    })
    parser.on('opentag', ({ name }) => {
      if (!/^(?:i|b|em|strong|italic|bold|sup|sub|sc)$/iu.test(name)) invalid = true
    })
    parser.on('text', (text) => {
      result += text
    })
    try {
      parser.write(value).close()
    } catch {
      invalid = true
    }
    if (invalid || !result.trim()) break
    value = result.trim()
  }
  return value
}

const identitySchemes = ['doi', 'pmid', 'pmcid'] as const

const nativePaperId = (paper: Paper): string => `europe-pmc:${paper.source ?? ''}:${paper.id ?? ''}`

function paperIdentifier(
  paper: Paper,
  scheme: (typeof identitySchemes)[number]
): string | undefined {
  const explicit = paper[scheme]
  if (explicit != null) return explicit
  if (
    (scheme === 'pmid' && paper.source === 'MED') ||
    (scheme === 'pmcid' && paper.source === 'PMC')
  )
    return paper.id
  return undefined
}

function conflictingPageIdentities(papers: Paper[]): boolean {
  return identitySchemes.some((scheme) => {
    const claims = new Set<string>()
    for (const paper of papers) {
      const value = paperIdentifier(paper, scheme)
      if (value && createLiteratureIdentifierUrl(scheme, value))
        claims.add(normalizeLiteratureIdentifierKey(scheme, value))
    }
    return claims.size > 1
  })
}

function record(paper: Paper): LiteratureRelatedRecord | undefined {
  const identity = literatureRelatedPaperIdSchema.safeParse(nativePaperId(paper))
  if (!identity.success || !paper.title?.trim()) return undefined
  // MED's native ID is its PMID; PMC's native ID is its PMCID. Cross-library
  // aliases are independent, but an explicit identifier in this namespace must agree.
  const nativeScheme =
    paper.source === 'MED' ? 'pmid' : paper.source === 'PMC' ? 'pmcid' : undefined
  const suppliedNativeId = nativeScheme ? paper[nativeScheme] : undefined
  if (
    nativeScheme &&
    suppliedNativeId?.trim() &&
    normalizeLiteratureIdentifierKey(nativeScheme, suppliedNativeId) !==
      normalizeLiteratureIdentifierKey(nativeScheme, paper.id!)
  )
    return undefined
  const identifiers = identitySchemes.flatMap((scheme) => {
    const raw = paperIdentifier(paper, scheme)
    if (!raw) return []
    const value = normalizeLiteratureIdentifierValue(scheme, raw)
    return createLiteratureIdentifierUrl(scheme, value) ? [{ scheme, value }] : []
  })
  const names = paper.authorList?.author.flatMap((author) =>
    author.fullName ? [author.fullName] : []
  )
  // Relationship responses only provide an authorString. Retain it literally;
  // commas and spaces cannot safely identify individual or family names.
  const authors = names?.length ? names : paper.authorString ? [paper.authorString] : []
  const year = paper.pubYear == null ? undefined : Number(paper.pubYear)
  const publicationType = [paper.citationType, ...(paper.pubTypeList?.pubType ?? [])].join(';')
  return {
    paperId: identity.data,
    item: bibliographicRecordSchema.parse({
      itemType:
        paper.source === 'PPR' || /preprint/i.test(publicationType)
          ? 'preprint'
          : /review/i.test(publicationType)
            ? 'review'
            : /conference/i.test(publicationType)
              ? 'conferencePaper'
              : /journal/i.test(publicationType) ||
                  paper.journalInfo?.journal?.title ||
                  paper.journalTitle ||
                  paper.journalAbbreviation
                ? 'journalArticle'
                : 'document',
      title: plainTitle(paper.title),
      abstract: paper.abstractText ?? '',
      issuedYear:
        year !== undefined && Number.isInteger(year) && year > 0 && year <= 9999 ? year : undefined,
      issuedText:
        paper.firstPublicationDate ?? (paper.pubYear == null ? '' : String(paper.pubYear)),
      containerTitle:
        paper.journalInfo?.journal?.title ?? paper.journalTitle ?? paper.journalAbbreviation ?? '',
      url: `https://europepmc.org/article/${encodeURIComponent(paper.source!)}/${encodeURIComponent(paper.id!)}`,
      creators: authors.map((name) => ({
        nameMode: 'organization',
        literalName: name,
        creatorType: 'author'
      })),
      identifiers,
      typeFields: {
        ...(paper.volume ? { volume: paper.volume } : {}),
        ...(paper.issue ? { issue: paper.issue } : {}),
        ...(paper.pageInfo ? { pages: paper.pageInfo } : {})
      }
    })
  }
}

export async function resolveEuropePmc(
  item: DiscoveryReference,
  read: Read,
  savedSourceIds: () => Promise<string[]>
): Promise<LiteratureRelatedRecord | undefined> {
  for (const scheme of ['doi', 'pmid', 'pmcid', 'native'] as const) {
    const values = [
      ...new Set(
        scheme === 'native'
          ? (await savedSourceIds()).filter(
              (id) =>
                id.startsWith('europe-pmc:') && literatureRelatedPaperIdSchema.safeParse(id).success
            )
          : item.item.identifiers
              .filter((entry) => entry.scheme === scheme)
              .map((entry) => normalizeLiteratureIdentifierKey(scheme, entry.value))
      )
    ]
    if (
      values.length !== 1 ||
      (scheme !== 'native' && !createLiteratureIdentifierUrl(scheme, values[0]))
    )
      continue
    const value = values[0]
    // The response is independently checked: search syntax is never proof of identity.
    const query =
      scheme === 'native'
        ? `EXT_ID:"${value.split(':')[2]}" AND SRC:${value.split(':')[1]}`
        : scheme === 'doi'
          ? `DOI:"${value.replace(/["\\]/g, '\\$&')}"`
          : scheme === 'pmid'
            ? `EXT_ID:${value} AND SRC:MED`
            : `PMCID:${value}`
    const response = z
      .object({
        hitCount: z.number().int().nonnegative(),
        resultList: z.object({ result: z.array(paperSchema).max(20) })
      })
      .parse(await read('search', { query, format: 'json', resultType: 'core', pageSize: '20' }))
    // More than one page cannot establish an unambiguous exact match.
    if (response.hitCount > 20) return undefined
    const matches = response.resultList.result.filter((paper) => {
      if (scheme === 'native') return `europe-pmc:${paper.source}:${paper.id}` === value
      const candidate =
        paper[scheme] ??
        (scheme === 'pmid' && paper.source === 'MED'
          ? paper.id
          : scheme === 'pmcid' && paper.source === 'PMC'
            ? paper.id
            : undefined)
      return candidate != null && normalizeLiteratureIdentifierKey(scheme, candidate) === value
    })
    // A matching DOI must not override a contradictory saved PMID/PMCID (or
    // vice versa). Only compare identifiers actually supplied by the provider.
    for (const match of matches) {
      for (const other of ['doi', 'pmid', 'pmcid'] as const) {
        const saved = [
          ...new Set(
            item.item.identifiers
              .filter((entry) => entry.scheme === other)
              .map((entry) => normalizeLiteratureIdentifierKey(other, entry.value))
          )
        ]
        const candidate =
          match[other] ??
          (other === 'pmid' && match.source === 'MED'
            ? match.id
            : other === 'pmcid' && match.source === 'PMC'
              ? match.id
              : undefined)
        if (
          saved.length === 1 &&
          candidate &&
          createLiteratureIdentifierUrl(other, saved[0]) &&
          normalizeLiteratureIdentifierKey(other, candidate) !== saved[0]
        )
          return undefined
      }
    }
    // MED and PMC can index the same DOI; prefer MED's citation identity. Distinct
    // identities within the preferred source remain ambiguous and are not guessed.
    const preferred = matches.some((paper) => paper.source === 'MED')
      ? matches.filter((paper) => paper.source === 'MED')
      : matches
    const unique = new Map(
      preferred.flatMap((paper) => {
        const entry = record(paper)
        return entry ? [[entry.paperId, entry] as const] : []
      })
    )
    if (unique.size === 1) return unique.values().next().value
    if (unique.size > 1) return undefined
  }
  return undefined
}

export async function readEuropePmcPage(
  seed: LiteratureRelatedRecord,
  direction: 'references' | 'citations',
  offset: number,
  read: Read
): Promise<{
  records: LiteratureRelatedRecord[]
  nextOffset?: number
  omitted?: number
}> {
  if (offset % 20 !== 0) throw new z.ZodError([])
  const [, source, id] = seed.paperId.split(':')
  const pageNumber = offset / 20 + 1
  const page = z
    .object({
      hitCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      request: z.object({
        id: z.string(),
        source: z.string(),
        offSet: z.number().int(),
        pageSize: z.number().int()
      }),
      referenceList: z.object({ reference: z.array(paperSchema).max(20).default([]) }).optional(),
      citationList: z.object({ citation: z.array(paperSchema).max(20).default([]) }).optional()
    })
    .parse(
      await read(`${encodeURIComponent(source)}/${encodeURIComponent(id)}/${direction}`, {
        format: 'json',
        page: String(pageNumber),
        pageSize: '20'
      })
    )
  // Europe's references response reports one-based pages; citations reports
  // zero-based pages. The actual request parameter is one-based for both.
  if (
    page.request.id !== id ||
    page.request.source !== source ||
    page.request.pageSize !== 20 ||
    page.request.offSet !== (direction === 'references' ? pageNumber : pageNumber - 1)
  )
    throw new z.ZodError([])
  const rows =
    direction === 'references' ? page.referenceList?.reference : page.citationList?.citation
  if (!rows && page.hitCount !== 0) throw new z.ZodError([])
  if (!rows?.length && offset < page.hitCount) throw new z.ZodError([])
  if (rows?.length && rows.length > page.hitCount - offset) throw new z.ZodError([])
  const records: LiteratureRelatedRecord[] = []
  let omitted = 0
  for (const group of Map.groupBy(rows ?? [], nativePaperId).values()) {
    if (group.length > 1 && conflictingPageIdentities(group)) {
      omitted += group.length
      continue
    }
    let selected: LiteratureRelatedRecord | undefined
    for (const paper of group) {
      const entry = record(paper)
      if (entry) selected = entry
      else omitted++
    }
    if (selected) records.push(selected)
  }
  return {
    records,
    ...(offset + 20 < page.hitCount ? { nextOffset: offset + 20 } : {}),
    ...(omitted ? { omitted } : {})
  }
}
