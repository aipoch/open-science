import { z } from 'zod'
import {
  createLiteratureIdentifierUrl,
  normalizeLiteratureIdentifierKey
} from '@aipoch/literature-citations/contracts'
import type { DiscoveryReference } from './contracts.js'
import type { LiteratureRelatedRecord } from './related-contracts.js'
import {
  boundedSnapshotRows,
  openCitationsMetaRecord,
  parseOpenCitationsMetadata,
  readOpenCitationsRecords
} from './related-opencitations.js'

type Read = (path: string, query: Record<string, string>) => Promise<unknown>
export type OpenCitationsIndexSnapshot = readonly {
  id: string
  dois: readonly string[]
}[]
const omid = /^omid:br\/(\d{1,30})$/
const paperId = /^opencitations:br\/(\d{1,30})$/
const edgeSchema = z.object({
  oci: z.string().regex(/^\d{1,30}-\d{1,30}$/),
  citing: z.string().max(100_000),
  cited: z.string().max(100_000)
})

function doiValues(identifiers: readonly { scheme: string; value: string }[]): string[] {
  return [
    ...new Set(
      identifiers
        .filter((entry) => entry.scheme === 'doi')
        .map((entry) => normalizeLiteratureIdentifierKey('doi', entry.value))
    )
  ]
}

function identifierTokens(value: string): { scheme: string; value: string }[] {
  return value.split(/\s+/).flatMap((token) => {
    const match = /^([a-z]+):(.+)$/.exec(token)
    return match ? [{ scheme: match[1], value: match[2] }] : []
  })
}

export async function resolveOpenCitationsIndex(
  item: DiscoveryReference,
  read: Read,
  knownPaperIds: readonly string[] = []
): Promise<LiteratureRelatedRecord | undefined> {
  const dois = doiValues(item.item.identifiers)
  const known = [...new Set(knownPaperIds.filter((id) => paperId.test(id)))].sort()
  let target: string
  if (dois.length === 1 && createLiteratureIdentifierUrl('doi', dois[0]))
    target = `doi:${encodeURIComponent(dois[0])}`
  else if (known.length === 1) target = `omid:br/${paperId.exec(known[0])![1]}`
  else return undefined
  const papers = parseOpenCitationsMetadata(await read(`meta/v1/metadata/${target}`, {}))
  const records: LiteratureRelatedRecord[] = []
  for (const paper of papers) {
    const tokens = identifierTokens(paper.id)
    const suppliedDois = doiValues(tokens)
    const matching = target.startsWith('doi:')
      ? suppliedDois.includes(dois[0])
      : paper.id.split(/\s+/).includes(target) && dois.every((doi) => suppliedDois.includes(doi))
    if (!matching) continue
    for (const scheme of ['pmid', 'pmcid', 'arxiv'] as const) {
      const saved = item.item.identifiers.filter((entry) => entry.scheme === scheme)
      if (
        saved.length === 1 &&
        tokens.some(
          (entry) =>
            entry.scheme === scheme &&
            normalizeLiteratureIdentifierKey(scheme, entry.value) !==
              normalizeLiteratureIdentifierKey(scheme, saved[0].value)
        )
      )
        return undefined
    }
    const ids = paper.id.split(/\s+/).filter((id) => omid.test(id))
    for (const id of ids) {
      if (target.startsWith('omid:') && id !== target) continue
      const entry = openCitationsMetaRecord(
        `https://w3id.org/oc/meta/br/${omid.exec(id)![1]}`,
        paper
      )
      if (entry) records.push(entry)
    }
  }
  return records.sort(
    (a, b) =>
      a.paperId.localeCompare(b.paperId, 'en') ||
      JSON.stringify(a.item).localeCompare(JSON.stringify(b.item), 'en')
  )[0]
}

async function readSnapshot(
  seed: LiteratureRelatedRecord,
  direction: 'references' | 'citations',
  read: Read
): Promise<OpenCitationsIndexSnapshot> {
  const match = paperId.exec(seed.paperId)
  if (!match) throw new z.ZodError([])
  const dois = doiValues(seed.item.identifiers)
  const doi =
    dois.length === 1 && createLiteratureIdentifierUrl('doi', dois[0]) ? dois[0] : undefined
  const target = doi ? `doi:${encodeURIComponent(doi)}` : `omid:br/${match[1]}`
  // Index has no assumed server pagination here. A complete bounded response is
  // required before creating either direction's immutable list of native IDs.
  const raw = await read(`index/v2/${direction}/${target}`, {})
  const rows = z.array(edgeSchema).parse(boundedSnapshotRows(raw))
  const ids = new Map<string, string[]>()
  const claims = new Map<string, string[][]>()
  for (const row of rows) {
    const [citing, cited] = row.oci.split('-')
    const citingTokens = row.citing.split(/\s+/)
    const citedTokens = row.cited.split(/\s+/)
    if (
      [citingTokens, citedTokens].some((tokens) =>
        tokens.some((token) => token.startsWith('omid:') && !omid.test(token))
      ) ||
      citingTokens.filter((token) => omid.test(token)).length !== 1 ||
      citedTokens.filter((token) => omid.test(token)).length !== 1 ||
      !citingTokens.includes(`omid:br/${citing}`) ||
      !citedTokens.includes(`omid:br/${cited}`)
    )
      throw new z.ZodError([])
    const targetTokens = direction === 'citations' ? citedTokens : citingTokens
    const targetId = direction === 'citations' ? cited : citing
    if (doi) {
      const values = doiValues(identifierTokens(targetTokens.join(' ')))
      if (!values.includes(doi)) throw new z.ZodError([])
    } else if (targetId !== match[1] || !targetTokens.includes(`omid:br/${match[1]}`))
      throw new z.ZodError([])
    const id = direction === 'citations' ? citing : cited
    const identity = `https://w3id.org/oc/meta/br/${id}`
    const neighborTokens = direction === 'citations' ? citingTokens : citedTokens
    const values = doiValues(identifierTokens(neighborTokens.join(' ')))
    const previous = ids.get(identity)
    // Several DOIs may legitimately alias one OMID. Explicitly disjoint DOI
    // claims for that same endpoint cannot authorize a trustworthy edge.
    const previousClaims = claims.get(identity) ?? []
    if (values.length) {
      // Compare individual claims: an earlier alias union must not conceal two
      // disjoint rows merely because a bridging row happened to arrive first.
      if (previousClaims.some((claim) => !values.some((value) => claim.includes(value))))
        throw new z.ZodError([])
      previousClaims.push(values)
      claims.set(identity, previousClaims)
    }
    ids.set(identity, [...new Set([...(previous ?? []), ...values])].sort())
  }
  return [...ids].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([id, dois]) => ({ id, dois }))
}

export async function readOpenCitationsIndexPage(
  seed: LiteratureRelatedRecord,
  direction: 'references' | 'citations',
  offset: number,
  read: Read,
  snapshot?: OpenCitationsIndexSnapshot
): Promise<{
  records: LiteratureRelatedRecord[]
  nextOffset?: number
  omitted?: number
  snapshot: OpenCitationsIndexSnapshot
}> {
  if (offset % 20 !== 0) throw new z.ZodError([])
  const ids = snapshot ?? (await readSnapshot(seed, direction, read))
  const entries = ids.slice(offset, offset + 20)
  const page = await readOpenCitationsRecords(
    entries.map(({ id }) => id),
    read,
    new Map(entries.map(({ id, dois }) => [id, dois]))
  )
  for (const record of page.records) {
    const expected = entries.find(({ id }) => id === record.item.url)!.dois
    const actual = doiValues(record.item.identifiers)
    if (expected.length && actual.length && !actual.some((value) => expected.includes(value)))
      throw new z.ZodError([])
  }
  return {
    ...page,
    snapshot: ids,
    ...(offset + 20 < ids.length ? { nextOffset: offset + 20 } : {})
  }
}
