import type { ToolContext, ToolDescriptor } from '../types'

// Public, version-pinned endpoints (ported from the upstream mcp_protein_annotation fleet libs).
const INTERPRO_BASE = 'https://www.ebi.ac.uk/interpro/api'
const HPA_BASE = 'https://v25.proteinatlas.org' // Human Protein Atlas release 25.x (pinned host)
const STRING_BASE = 'https://version-12-0.string-db.org/api' // STRING v12.0 (pinned)
const STRING_CALLER = 'bio-tools-string-network'
const DEFAULT_SPECIES = 9606 // human
const PAGE_SIZE = 200 // InterPro honours >=200 per page

// ---------------------------------------------------------------------------
// shared HTTP helpers
// ---------------------------------------------------------------------------

// Byte size of a response body (UTF-8), used to mirror the fleet's request accounting.
const byteLen = (text: string): number => Buffer.byteLength(text, 'utf8')

// Build a query string from ordered [key, value] pairs, skipping null/undefined values.
function qs(pairs: Array<[string, unknown]>): string {
  const parts = pairs
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

// GET JSON via fetchText so an empty body (HTTP 204) is a legitimate null, not a JSON parse error.
async function getJsonMaybe(
  ctx: ToolContext,
  url: string
): Promise<{ data: unknown; bytes: number }> {
  const text = await ctx.fetchText(url)
  const trimmed = text.trim()
  return { data: trimmed ? JSON.parse(trimmed) : null, bytes: byteLen(text) }
}

// Follow InterPro cursor pagination to completion and verify the accumulated rows match the API count.
async function walkEntries(
  ctx: ToolContext,
  startUrl: string,
  stats?: { requests: number; bytes: number }
): Promise<{ count: number; results: unknown[] }> {
  let url: string | null = startUrl
  const results: unknown[] = []
  let count = 0
  let pages = 0
  while (url) {
    const { data, bytes } = await getJsonMaybe(ctx, url)
    pages += 1
    if (stats) {
      stats.requests += 1
      stats.bytes += bytes
    }
    if (data === null) {
      if (pages === 1) return { count: 0, results: [] } // 204 on first page — legitimately empty
      // 204 mid-pagination is an upstream defect (e.g. the proteome route): never return a partial set.
      throw new Error(
        `InterPro returned HTTP 204 mid-pagination (page ${pages}) — incomplete result set (${results.length} of ${count} rows)`
      )
    }
    const payload = data as { count?: number; results?: unknown[]; next?: string | null }
    count = payload.count ?? 0
    results.push(...(payload.results ?? []))
    url = payload.next ?? null
  }
  if (results.length !== count) {
    throw new Error(
      `pagination incomplete: accumulated ${results.length} results but API count is ${count}`
    )
  }
  return { count, results }
}

// ---------------------------------------------------------------------------
// InterPro summary shaping (ports of interpro_domains.summary / interpro_entry_search.summary)
// ---------------------------------------------------------------------------

type Metadata = Record<string, unknown>
const meta = (row: Record<string, unknown>): Metadata =>
  ((row.metadata as Metadata) ?? row) as Metadata

// Flatten {db: {acc: name}} into a list of signature dicts sorted by (database, accession).
function memberSignatures(memberDatabases: unknown): Array<Record<string, unknown>> | null {
  if (!memberDatabases || typeof memberDatabases !== 'object') return null
  const flat: Array<{ database: string; accession: string; name: unknown }> = []
  for (const [db, sigs] of Object.entries(memberDatabases as Record<string, unknown>)) {
    for (const [acc, name] of Object.entries((sigs as Record<string, unknown>) ?? {})) {
      flat.push({ database: db, accession: acc, name })
    }
  }
  if (!flat.length) return null
  flat.sort(
    (a, b) => a.database.localeCompare(b.database) || a.accession.localeCompare(b.accession)
  )
  return flat
}

// GO terms sorted by identifier; null when absent/empty.
function sortedGo(goTerms: unknown): unknown[] | null {
  if (!Array.isArray(goTerms) || !goTerms.length) return null
  return [...goTerms].sort((a, b) =>
    String((a as Record<string, unknown>).identifier ?? '').localeCompare(
      String((b as Record<string, unknown>).identifier ?? '')
    )
  )
}

function summarizeEntryRow(row: Record<string, unknown>): Record<string, unknown> {
  const md = meta(row)
  const out: Record<string, unknown> = {
    accession: md.accession,
    name: md.name,
    type: md.type,
    source_database: md.source_database,
    integrated: md.integrated
  }
  const sigs = memberSignatures(md.member_databases)
  if (sigs !== null) out.member_db_signatures = sigs
  const go = sortedGo(md.go_terms)
  if (go !== null) out.go_terms = go
  return out
}

function summarizeSearch(fetched: { count: number; results: unknown[] }): Record<string, unknown> {
  const rows = (fetched.results ?? []).map((r) => summarizeEntryRow(r as Record<string, unknown>))
  rows.sort((a, b) => String(a.accession ?? '').localeCompare(String(b.accession ?? '')))
  return { count: fetched.count ?? 0, results: rows }
}

function summarizeEntryDetail(payload: Record<string, unknown>): Record<string, unknown> {
  const md = meta(payload)
  const rawName = md.name
  const name =
    rawName && typeof rawName === 'object'
      ? {
          name: (rawName as Record<string, unknown>).name,
          short: (rawName as Record<string, unknown>).short
        }
      : { name: rawName, short: null }
  const out: Record<string, unknown> = {
    accession: md.accession,
    name,
    type: md.type,
    source_database: md.source_database,
    integrated: md.integrated,
    hierarchy: md.hierarchy,
    set_info: md.set_info
  }
  const sigs = memberSignatures(md.member_databases)
  if (sigs !== null) out.member_db_signatures = sigs
  const go = sortedGo(md.go_terms)
  if (go !== null) out.go_terms = go
  if (Array.isArray(md.literature) && md.literature.length)
    out.n_literature_refs = md.literature.length
  return out
}

function summarizeClanDetail(payload: Record<string, unknown>): Record<string, unknown> {
  const md = meta(payload)
  const rawName = md.name
  const name =
    rawName && typeof rawName === 'object' ? (rawName as Record<string, unknown>).name : rawName
  const nodes =
    ((md.relationships as Record<string, unknown>)?.nodes as Array<Record<string, unknown>>) ?? []
  const members = nodes
    .map((n) => ({
      accession: n.accession,
      name: n.name,
      short_name: n.short_name,
      type: n.type
    }))
    .sort((a, b) => String(a.accession ?? '').localeCompare(String(b.accession ?? '')))
  return {
    accession: md.accession,
    name,
    source_database: md.source_database,
    member_count: members.length,
    members
  }
}

function summarizeClanSearch(fetched: {
  count: number
  results: unknown[]
}): Record<string, unknown> {
  const rows = (fetched.results ?? []).map((r) => {
    const md = meta(r as Record<string, unknown>)
    const rawName = md.name
    return {
      accession: md.accession,
      name:
        rawName && typeof rawName === 'object'
          ? (rawName as Record<string, unknown>).name
          : rawName,
      source_database: md.source_database
    }
  })
  rows.sort((a, b) => String(a.accession ?? '').localeCompare(String(b.accession ?? '')))
  return { count: fetched.count ?? 0, results: rows }
}

function summarizeProteins(fetched: {
  count: number
  results: unknown[] | null
}): Record<string, unknown> {
  if (fetched.results === null) return { count: fetched.count ?? 0, results: null }
  const rows = fetched.results.map((r) => {
    const md = meta(r as Record<string, unknown>)
    const org = (md.source_organism as Record<string, unknown>) ?? {}
    return {
      accession: md.accession,
      name: md.name,
      source_database: md.source_database,
      length: md.length,
      tax_id: org.taxId,
      organism: org.scientificName
    }
  })
  rows.sort((a, b) => String(a.accession ?? '').localeCompare(String(b.accession ?? '')))
  return { count: fetched.count ?? 0, results: rows }
}

function summarizeProteomes(fetched: {
  count: number
  results: unknown[] | null
}): Record<string, unknown> {
  if (fetched.results === null) return { count: fetched.count ?? 0, results: null }
  const rows = fetched.results.map((r) => {
    const md = meta(r as Record<string, unknown>)
    return {
      accession: md.accession,
      name: md.name,
      is_reference: md.is_reference,
      taxonomy: md.taxonomy
    }
  })
  rows.sort((a, b) => String(a.accession ?? '').localeCompare(String(b.accession ?? '')))
  return { count: fetched.count ?? 0, results: rows }
}

// ---------------------------------------------------------------------------
// Domain architecture shaping (port of interpro_domains.summary.build_summary)
// ---------------------------------------------------------------------------

const TYPE_ORDER = [
  'family',
  'domain',
  'repeat',
  'homologous_superfamily',
  'conserved_site',
  'active_site',
  'binding_site',
  'ptm'
]
const typeRank = (t: unknown): number => {
  const i = TYPE_ORDER.indexOf(String(t))
  return i === -1 ? TYPE_ORDER.length : i
}

function fragmentDict(frag: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { start: frag.start, end: frag.end }
  const dc = frag['dc-status']
  if (dc !== null && dc !== undefined && dc !== 'CONTINUOUS') out.dc_status = dc
  return out
}

function sortedLocations(locs: unknown): Array<Record<string, unknown>> {
  const locations = (Array.isArray(locs) ? locs : []).map((loc) => {
    const l = loc as Record<string, unknown>
    const fragments = ((l.fragments as Array<Record<string, unknown>>) ?? [])
      .map(fragmentDict)
      .sort(
        (a, b) =>
          Number(a.start ?? -1) - Number(b.start ?? -1) || Number(a.end ?? -1) - Number(b.end ?? -1)
      )
    const out: Record<string, unknown> = { fragments }
    if (l.representative) out.representative = true
    if (l.model !== null && l.model !== undefined) out.model = l.model
    if (l.score !== null && l.score !== undefined) out.score = l.score
    return out
  })
  locations.sort((a, b) => {
    const fa = a.fragments as Array<Record<string, unknown>>
    const fb = b.fragments as Array<Record<string, unknown>>
    const sa = fa.length ? Number(fa[0].start ?? -1) : -1
    const sb = fb.length ? Number(fb[0].start ?? -1) : -1
    if (sa !== sb) return sa - sb
    const ea = fa.length ? Number(fa[fa.length - 1].end ?? -1) : -1
    const eb = fb.length ? Number(fb[fb.length - 1].end ?? -1) : -1
    return ea - eb
  })
  return locations
}

function buildDomainSummary(
  accession: string,
  count: number,
  results: Array<Record<string, unknown>>
): Record<string, unknown> {
  let proteinLength: unknown = null
  const entries = results.map((item) => {
    const md = (item.metadata as Metadata) ?? {}
    const proteins = (item.proteins as Array<Record<string, unknown>>) ?? []
    let match = proteins.find(
      (p) => String(p.accession ?? '').toUpperCase() === accession.toUpperCase()
    )
    if (!match && proteins.length) match = proteins[0]
    if (match && proteinLength === null) proteinLength = match.protein_length
    return {
      accession: md.accession,
      name: md.name,
      type: md.type,
      member_db_signatures: memberSignatures(md.member_databases) ?? [],
      locations: sortedLocations((match ?? {}).entry_protein_locations)
    }
  })
  entries.sort(
    (a, b) =>
      typeRank(a.type) - typeRank(b.type) ||
      String(a.accession ?? '').localeCompare(String(b.accession ?? ''))
  )
  return {
    protein: accession.toUpperCase(),
    protein_length: proteinLength,
    entry_count: count,
    entries
  }
}

// Domain-architecture walk mirrors interpro_domains.client.get_protein_entries:
// 204 means the protein has no InterPro entries (count 0), not a mid-page defect.
async function walkProteinEntries(
  ctx: ToolContext,
  accession: string,
  stats: { requests: number; bytes: number }
): Promise<{ count: number; results: Array<Record<string, unknown>> }> {
  const acc = encodeURIComponent(accession)
  let url: string | null =
    `${INTERPRO_BASE}/entry/interpro/protein/uniprot/${acc}/?page_size=${PAGE_SIZE}`
  const results: Array<Record<string, unknown>> = []
  let count = 0
  while (url) {
    const { data, bytes } = await getJsonMaybe(ctx, url)
    stats.requests += 1
    stats.bytes += bytes
    if (data === null) {
      count = 0
      break
    }
    const payload = data as { count?: number; results?: unknown[]; next?: string | null }
    count = payload.count ?? 0
    results.push(...((payload.results as Array<Record<string, unknown>>) ?? []))
    url = payload.next ?? null
  }
  if (results.length !== count) {
    throw new Error(
      `${accession}: pagination incomplete — accumulated ${results.length} results but API count is ${count}`
    )
  }
  return { count, results }
}

// ---------------------------------------------------------------------------
// STRING helpers (ports of string_network.core / .homology)
// ---------------------------------------------------------------------------

type StringMapped = {
  query: string
  string_id: string
  preferred_name: string
  ncbi_taxon_id: number
}
type StringIdRow = {
  queryIndex?: number | string
  stringId?: string
  preferredName?: string
  ncbiTaxonId?: number | string
}
type RequestLogEntry = { endpoint: string; bytes: number }

const round3 = (x: number): number => Math.round(x * 1000) / 1000
const round1 = (x: number): number => Math.round(x * 10) / 10

async function stringGetJson(
  ctx: ToolContext,
  outputFormat: string,
  endpoint: string,
  params: Array<[string, unknown]>
): Promise<{ data: unknown; bytes: number; endpoint: string }> {
  const withCaller: Array<[string, unknown]> = [...params, ['caller_identity', STRING_CALLER]]
  const url = `${STRING_BASE}/${outputFormat}/${endpoint}${qs(withCaller)}`
  const text = await ctx.fetchText(url)
  const trimmed = text.trim()
  return {
    data: outputFormat === 'json' ? (trimmed ? JSON.parse(trimmed) : []) : text,
    bytes: byteLen(text),
    endpoint: `${outputFormat}/${endpoint}`
  }
}

// STRING version dict {string_version, stable_address} (first element of the version array).
async function stringVersion(
  ctx: ToolContext
): Promise<{ version: Record<string, unknown>; log: RequestLogEntry }> {
  const { data, bytes, endpoint } = await stringGetJson(ctx, 'json', 'version', [])
  const v = (data as Array<Record<string, unknown>>)[0] ?? {}
  return {
    version: { string_version: v.string_version, stable_address: v.stable_address },
    log: { endpoint, bytes }
  }
}

// Map symbols to STRING IDs (get_string_ids, limit=1, echo_query=1); mapped/unmapped partition input.
async function mapStringIds(
  ctx: ToolContext,
  symbols: string[],
  species: number
): Promise<{ mapped: StringMapped[]; unmapped: string[]; log: RequestLogEntry }> {
  const { data, bytes, endpoint } = await stringGetJson(ctx, 'json', 'get_string_ids', [
    ['identifiers', symbols.join('\r')],
    ['species', species],
    ['limit', 1],
    ['echo_query', 1]
  ])
  const rows = (data as StringIdRow[]) ?? []
  const byIndex = new Map<number, StringIdRow>()
  for (const row of rows) {
    const idx = Number(row.queryIndex)
    if (!byIndex.has(idx)) byIndex.set(idx, row)
  }
  const mapped: StringMapped[] = []
  const unmapped: string[] = []
  symbols.forEach((symbol, i) => {
    const row = byIndex.get(i)
    if (!row) unmapped.push(symbol)
    else
      mapped.push({
        query: symbol,
        string_id: String(row.stringId),
        preferred_name: String(row.preferredName),
        ncbi_taxon_id: Number(row.ncbiTaxonId)
      })
  })
  return { mapped, unmapped, log: { endpoint, bytes } }
}

const NETWORK_COLUMNS = [
  'stringId_A',
  'stringId_B',
  'preferredName_A',
  'preferredName_B',
  'ncbiTaxonId',
  'score'
]
const EVIDENCE_CHANNELS = ['nscore', 'fscore', 'pscore', 'ascore', 'escore', 'dscore', 'tscore']

function parseNetworkTsv(text: string): Array<Record<string, string>> {
  const lines = text
    .trim()
    .split('\n')
    .filter((l) => l.trim())
  if (!lines.length) return []
  const header = lines[0].split('\t')
  const missing = [...NETWORK_COLUMNS, ...EVIDENCE_CHANNELS].filter((c) => !header.includes(c))
  if (missing.length)
    throw new Error(`network TSV is missing expected columns: ${missing.join(', ')}`)
  return lines.slice(1).map((line) => {
    const values = line.split('\t')
    const row: Record<string, string> = {}
    header.forEach((h, i) => (row[h] = values[i]))
    return row
  })
}

// Deterministically oriented, de-duplicated, trimmed edges (port of core.canonical_edges).
function canonicalEdges(rows: Array<Record<string, string>>): Array<Record<string, unknown>> {
  const tupleLt = (a: [string, string], b: [string, string]): boolean =>
    a[0] !== b[0] ? a[0] < b[0] : a[1] < b[1]
  const dedup = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    let a: [string, string] = [row.preferredName_A, row.stringId_A]
    let b: [string, string] = [row.preferredName_B, row.stringId_B]
    if (tupleLt(b, a)) [a, b] = [b, a]
    const evidence: Record<string, number> = {}
    for (const channel of EVIDENCE_CHANNELS) {
      const value = round3(Number(row[channel]))
      if (value > 0) evidence[channel] = value
    }
    const edge = {
      _sort: [a[0], b[0], a[1], b[1]] as [string, string, string, string],
      a: a[0],
      b: b[0],
      score: round3(Number(row.score)),
      evidence
    }
    const key = [a[1], b[1]].sort().join(' ')
    const existing = dedup.get(key)
    if (!existing || edge.score > (existing.score as number)) dedup.set(key, edge)
  }
  const ordered = [...dedup.values()].sort((x, y) => {
    const sx = x._sort as [string, string, string, string]
    const sy = y._sort as [string, string, string, string]
    for (let i = 0; i < 4; i++) if (sx[i] !== sy[i]) return sx[i] < sy[i] ? -1 : 1
    return 0
  })
  return ordered.map((e) => {
    const { _sort, ...rest } = e
    void _sort
    return rest
  })
}

function degreesByName(
  mapped: StringMapped[],
  edges: Array<Record<string, unknown>>
): Map<string, number> {
  const degree = new Map<string, number>()
  for (const m of mapped) degree.set(m.preferred_name, 0)
  for (const edge of edges)
    for (const name of [edge.a as string, edge.b as string])
      degree.set(name, (degree.get(name) ?? 0) + 1)
  return degree
}

function nodeTable(
  mapped: StringMapped[],
  edges: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const degree = degreesByName(mapped, edges)
  return mapped
    .map((m) => ({
      query: m.query,
      name: m.preferred_name,
      string_id: m.string_id,
      degree: degree.get(m.preferred_name) ?? 0
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.string_id.localeCompare(b.string_id))
}

function summarizeNetwork(
  mapped: StringMapped[],
  unmapped: string[],
  edges: Array<Record<string, unknown>>
): Record<string, unknown> {
  const degree = degreesByName(mapped, edges)
  const scores = edges.map((e) => e.score as number)
  const nConnected = [...degree.values()].filter((d) => d > 0).length
  return {
    n_input_symbols: mapped.length + unmapped.length,
    n_mapped: mapped.length,
    n_unmapped: unmapped.length,
    n_nodes: mapped.length,
    n_connected_nodes: nConnected,
    n_isolated_nodes: mapped.length - nConnected,
    n_edges: edges.length,
    mean_score: scores.length
      ? Math.round((scores.reduce((s, v) => s + v, 0) / scores.length) * 10000) / 10000
      : null,
    min_score: scores.length ? Math.min(...scores) : null,
    max_score: scores.length ? Math.max(...scores) : null
  }
}

// Canonicalize /homology rows: one record per unordered pair (id_a <= id_b), verify symmetric bitscore.
function parseHomologyRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Map<string, Record<string, unknown>>()
  const idTaxLt = (idA: string, taxA: number, idB: string, taxB: number): boolean =>
    idA !== idB ? idA < idB : taxA < taxB
  for (const row of rows) {
    let idA = String(row.stringId_A)
    let idB = String(row.stringId_B)
    let taxA = Number(row.ncbiTaxonId_A)
    let taxB = Number(row.ncbiTaxonId_B)
    const score = round1(Number(row.bitscore))
    if (idTaxLt(idB, taxB, idA, taxA)) {
      ;[idA, idB] = [idB, idA]
      ;[taxA, taxB] = [taxB, taxA]
    }
    const key = `${idA} ${idB}`
    const rec = {
      id_a: idA,
      id_b: idB,
      taxon_a: taxA,
      taxon_b: taxB,
      bitscore: score,
      self: idA === idB
    }
    const prev = seen.get(key)
    if (prev && prev.bitscore !== score)
      throw new Error(`asymmetric homology bitscore for ${key}: ${prev.bitscore} vs ${score}`)
    seen.set(key, rec)
  }
  return [...seen.values()].sort(
    (a, b) =>
      String(a.id_a).localeCompare(String(b.id_a)) || String(a.id_b).localeCompare(String(b.id_b))
  )
}

// ---------------------------------------------------------------------------
// Human Protein Atlas helpers (ports of protein_atlas.api / .records)
// ---------------------------------------------------------------------------

const ENSG_RE = /^ENSG\d{11}$/

const HPA_SUMMARY_FIELDS: Record<string, string[]> = {
  identity: [
    'Gene',
    'Gene synonym',
    'Ensembl',
    'Gene description',
    'Uniprot',
    'Chromosome',
    'Position',
    'Protein class',
    'Biological process',
    'Molecular function',
    'Disease involvement',
    'Evidence',
    'HPA evidence',
    'UniProt evidence',
    'NeXtProt evidence'
  ],
  tissue_expression: [
    'RNA tissue specificity',
    'RNA tissue distribution',
    'RNA tissue specificity score',
    'RNA tissue specific nTPM',
    'RNA tissue cell type enrichment',
    'Tissue expression cluster',
    'Protein tissue specificity',
    'Protein tissue distribution',
    'Protein tissue specificity score',
    'Protein tissue specific Intensity'
  ],
  single_cell_expression: [
    'RNA single cell type specificity',
    'RNA single cell type distribution',
    'RNA single cell type specificity score',
    'RNA single cell type specific nCPM',
    'Single cell expression cluster'
  ],
  blood_expression: [
    'RNA blood cell specificity',
    'RNA blood cell distribution',
    'RNA blood cell specificity score',
    'RNA blood cell specific nTPM',
    'RNA blood lineage specificity',
    'RNA blood lineage distribution',
    'RNA blood lineage specific nTPM',
    'Blood expression cluster',
    'Blood concentration - Conc. blood IM [pg/L]',
    'Blood concentration - Conc. blood MS [pg/L]'
  ],
  brain_expression: [
    'RNA brain regional specificity',
    'RNA brain regional distribution',
    'RNA brain regional specificity score',
    'RNA brain regional specific nTPM',
    'Brain expression cluster'
  ],
  cancer_expression: [
    'RNA cancer specificity',
    'RNA cancer distribution',
    'RNA cancer specificity score',
    'RNA cancer specific pTPM'
  ],
  subcellular: [
    'Subcellular location',
    'Subcellular main location',
    'Subcellular additional location',
    'Reliability (IF)',
    'Secretome location',
    'Secretome function',
    'CCD Protein',
    'CCD Transcript'
  ],
  antibody: [
    'Antibody',
    'Antibody RRID',
    'Reliability (IH)',
    'Reliability (Mouse Brain)',
    'Reliability (IF)'
  ]
}
const PROGNOSTICS_PREFIX = 'Cancer prognostics - '

// Group the stable subset of a per-gene record into sections; fold per-cancer prognostics keys.
function summarizeHpa(record: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {}
  for (const [section, names] of Object.entries(HPA_SUMMARY_FIELDS)) {
    const block: Record<string, unknown> = {}
    for (const k of names) if (k in record) block[k] = record[k]
    summary[section] = block
  }
  const prognostics: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(record))
    if (k.startsWith(PROGNOSTICS_PREFIX)) prognostics[k.slice(PROGNOSTICS_PREFIX.length)] = v
  summary.pathology = { prognostics }
  return summary
}

// Resolve a gene symbol (or synonym) to its Ensembl gene ID via search_download (columns g,gs,eg).
async function resolveHpaSymbol(ctx: ToolContext, symbol: string): Promise<string> {
  const rows = (await ctx.fetchJson(
    `${HPA_BASE}/api/search_download.php${qs([
      ['search', symbol],
      ['format', 'json'],
      ['columns', 'g,gs,eg'],
      ['compress', 'no']
    ])}`
  )) as Array<Record<string, unknown>>
  const want = symbol.toUpperCase()
  let exact = rows.filter((r) => String(r.Gene ?? '').toUpperCase() === want && r.Ensembl)
  if (!exact.length) {
    exact = rows.filter(
      (r) =>
        r.Ensembl &&
        (Array.isArray(r['Gene synonym']) ? (r['Gene synonym'] as unknown[]) : []).some(
          (s) => String(s).toUpperCase() === want
        )
    )
  }
  const ensgs = [...new Set(exact.map((r) => String(r.Ensembl)))].sort()
  if (!ensgs.length) throw new Error(`no HPA gene with symbol or synonym '${symbol}'`)
  if (ensgs.length > 1)
    throw new Error(`symbol '${symbol}' matches multiple genes: ${ensgs.join(', ')}`)
  return ensgs[0]
}

// ---------------------------------------------------------------------------
// Descriptors — connector 'protein_annotation' (InterPro/Pfam, Human Protein Atlas, STRING v12.0)
// ---------------------------------------------------------------------------
export const PROTEIN_ANNOTATION_TOOLS: ToolDescriptor[] = [
  {
    id: 'get_domain_architecture',
    connector: 'protein_annotation',
    description:
      'Complete InterPro domain architecture for one or more UniProt proteins (all matching entries, member-DB signatures, fragment coordinates), with pagination verified against the API count.',
    input: {
      type: 'object',
      properties: {
        accessions: {
          type: 'array',
          items: { type: 'string' },
          description: 'UniProt accessions, e.g. ["P04637"].'
        }
      },
      required: ['accessions']
    },
    required: ['accessions'],
    returns:
      '`{ "summaries": { <accession>: { "protein": str, "protein_length": int, "entry_count": int, "entries": [ { "accession": str, "name": str, "type": str, "member_db_signatures": [ { "database": str, "accession": str, "name": str } ], "locations": [ { "fragments": [ { "start": int, "end": int } ], ... } ] } ] } }, "stats": { "http_requests": int, "bytes_downloaded": int } }` — entries sorted by (type, accession); default location fields (model/score/representative, fragment dc_status "CONTINUOUS") are omitted.',
    example:
      'result = host.mcp("protein_annotation", "get_domain_architecture", {"accessions": ["P04637"]})',
    run: async (ctx, a) => {
      const accessions = (a.accessions as string[]).map(String)
      const stats = { requests: 0, bytes: 0 }
      const summaries: Record<string, unknown> = {}
      for (const acc of accessions) {
        const fetched = await walkProteinEntries(ctx, acc, stats)
        summaries[acc] = buildDomainSummary(acc, fetched.count, fetched.results)
      }
      return { summaries, stats: { http_requests: stats.requests, bytes_downloaded: stats.bytes } }
    }
  },
  {
    id: 'search_interpro_entries',
    connector: 'protein_annotation',
    description:
      'Keyword search over InterPro or member-database entries (Pfam, SMART, PROSITE, PANTHER, CDD), complete cursor walk verified against the API count.',
    input: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Free-text keyword, e.g. "kinase". Optional if go_term is given.'
        },
        entry_type: {
          type: 'string',
          description:
            'family | domain | repeat | homologous_superfamily | conserved_site | active_site | binding_site | ptm'
        },
        source_db: {
          type: 'string',
          default: 'interpro',
          description: 'interpro (default) or a member DB: pfam, smart, prosite, panther, cdd.'
        },
        go_term: { type: 'string', description: 'GO identifier filter, e.g. "GO:0004672".' }
      }
    },
    returns:
      '`{ "count": int, "results": [ { "accession": str, "name": str, "type": str, "source_database": str, "integrated": str|null, "member_db_signatures"?: [...], "go_terms"?: [...] } ] }` — rows sorted by accession; `count` is the API total.',
    example:
      'result = host.mcp("protein_annotation", "search_interpro_entries", {"query": "kinase", "source_db": "pfam"})',
    run: async (ctx, a) => {
      const sourceDb = String(a.source_db ?? 'interpro')
      const url = `${INTERPRO_BASE}/entry/${encodeURIComponent(sourceDb)}/${qs([
        ['search', a.query ?? null],
        ['type', a.entry_type ?? null],
        ['go_term', a.go_term ?? null],
        ['page_size', PAGE_SIZE]
      ])}`
      return summarizeSearch(await walkEntries(ctx, url))
    }
  },
  {
    id: 'get_interpro_entry',
    connector: 'protein_annotation',
    description:
      'Detail record for an InterPro entry (IPRxxxxxx) or Pfam family (PFxxxxx) — route chosen by accession prefix.',
    input: {
      type: 'object',
      properties: {
        accession: {
          type: 'string',
          description: 'InterPro (IPRxxxxxx) or Pfam (PFxxxxx) accession.'
        }
      },
      required: ['accession']
    },
    required: ['accession'],
    returns:
      '`{ "accession": str, "name": { "name": str, "short": str|null }, "type": str, "source_database": str, "integrated": str|null, "hierarchy": ..., "set_info": ..., "member_db_signatures"?: [...], "go_terms"?: [...], "n_literature_refs"?: int }` — a Pfam family\'s clan appears under `set_info`.',
    example:
      'result = host.mcp("protein_annotation", "get_interpro_entry", {"accession": "IPR000719"})',
    run: async (ctx, a) => {
      const acc = String(a.accession).trim().toUpperCase()
      const db = acc.startsWith('IPR') ? 'interpro' : acc.startsWith('PF') ? 'pfam' : null
      if (!db)
        throw new Error(`unrecognized entry accession (want IPR... or PF...): ${a.accession}`)
      const { data } = await getJsonMaybe(
        ctx,
        `${INTERPRO_BASE}/entry/${db}/${encodeURIComponent(acc)}/`
      )
      if (data === null) throw new Error(`empty response for entry ${acc}`)
      return summarizeEntryDetail(data as Record<string, unknown>)
    }
  },
  {
    id: 'search_pfam_clans',
    connector: 'protein_annotation',
    description: 'Keyword search over Pfam clans (InterPro sets, accessions CLxxxx).',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text keyword; omit to list all clans.' }
      }
    },
    returns:
      '`{ "count": int, "results": [ { "accession": str, "name": str, "source_database": str } ] }` — rows sorted by accession; an empty upstream result yields count 0.',
    example: 'result = host.mcp("protein_annotation", "search_pfam_clans", {"query": "kinase"})',
    run: async (ctx, a) => {
      const url = `${INTERPRO_BASE}/set/pfam/${qs([
        ['search', a.query ?? null],
        ['page_size', PAGE_SIZE]
      ])}`
      return summarizeClanSearch(await walkEntries(ctx, url))
    }
  },
  {
    id: 'get_pfam_clan',
    connector: 'protein_annotation',
    description: 'Pfam clan detail including the complete sorted member-family list.',
    input: {
      type: 'object',
      properties: {
        clan_accession: { type: 'string', description: 'Clan accession, e.g. "CL0016".' }
      },
      required: ['clan_accession']
    },
    required: ['clan_accession'],
    returns:
      '`{ "accession": str, "name": str, "source_database": str, "member_count": int, "members": [ { "accession": str, "name": str, "short_name": str, "type": str } ] }` — members sorted by accession.',
    example:
      'result = host.mcp("protein_annotation", "get_pfam_clan", {"clan_accession": "CL0016"})',
    run: async (ctx, a) => {
      const acc = String(a.clan_accession).trim().toUpperCase()
      const { data } = await getJsonMaybe(
        ctx,
        `${INTERPRO_BASE}/set/pfam/${encodeURIComponent(acc)}/`
      )
      if (data === null) throw new Error(`empty response for clan ${acc}`)
      return summarizeClanDetail(data as Record<string, unknown>)
    }
  },
  {
    id: 'get_pfam_family_proteins',
    connector: 'protein_annotation',
    description:
      'Member proteins of a Pfam family (complete count-verified walk or count only). Use count_only for very large families.',
    input: {
      type: 'object',
      properties: {
        pfam_accession: { type: 'string', description: 'Pfam family accession, e.g. "PF00069".' },
        reviewed_only: {
          type: 'boolean',
          default: false,
          description: 'Restrict to reviewed (Swiss-Prot) proteins.'
        },
        tax_id: { type: 'integer', description: 'Restrict to an NCBI taxon, e.g. 9606 for human.' },
        count_only: {
          type: 'boolean',
          default: false,
          description:
            'Return only the match count — REQUIRED for very large families (e.g. unfiltered PF00069).'
        }
      },
      required: ['pfam_accession']
    },
    required: ['pfam_accession'],
    returns:
      '`{ "count": int, "results": [ { "accession": str, "name": str, "source_database": str, "length": int, "tax_id": int, "organism": str } ] | null }` — `results` is null in count_only mode; otherwise sorted by accession.',
    example:
      'result = host.mcp("protein_annotation", "get_pfam_family_proteins", {"pfam_accession": "PF00069", "count_only": True})',
    run: async (ctx, a) => {
      const acc = String(a.pfam_accession).trim().toUpperCase()
      const db = a.reviewed_only ? 'reviewed' : 'uniprot'
      const base = `${INTERPRO_BASE}/protein/${db}/entry/pfam/${encodeURIComponent(acc)}/`
      const taxId = a.tax_id ?? null
      if (a.count_only) {
        const { data } = await getJsonMaybe(
          ctx,
          base +
            qs([
              ['tax_id', taxId],
              ['page_size', 1]
            ])
        )
        return summarizeProteins({ count: (data as { count?: number })?.count ?? 0, results: null })
      }
      const fetched = await walkEntries(
        ctx,
        base +
          qs([
            ['tax_id', taxId],
            ['page_size', PAGE_SIZE]
          ])
      )
      return summarizeProteins(fetched)
    }
  },
  {
    id: 'get_pfam_family_proteomes',
    connector: 'protein_annotation',
    description:
      'Proteomes containing members of a Pfam family. count_only defaults true — the upstream proteome cursor pagination is defective for deep walks.',
    input: {
      type: 'object',
      properties: {
        pfam_accession: { type: 'string', description: 'Pfam family accession, e.g. "PF00069".' },
        count_only: {
          type: 'boolean',
          default: true,
          description: 'Default true (reliable count). Set false only for small families.'
        }
      },
      required: ['pfam_accession']
    },
    required: ['pfam_accession'],
    returns:
      '`{ "count": int, "results": [ { "accession": str, "name": str, "is_reference": bool, "taxonomy": ... } ] | null }` — `results` is null in count_only mode; a full walk raises if upstream pagination is defective.',
    example:
      'result = host.mcp("protein_annotation", "get_pfam_family_proteomes", {"pfam_accession": "PF00069"})',
    run: async (ctx, a) => {
      const acc = String(a.pfam_accession).trim().toUpperCase()
      const base = `${INTERPRO_BASE}/proteome/uniprot/entry/pfam/${encodeURIComponent(acc)}/`
      const countOnly = a.count_only ?? true
      if (countOnly) {
        const { data } = await getJsonMaybe(ctx, base + qs([['page_size', 1]]))
        return summarizeProteomes({
          count: (data as { count?: number })?.count ?? 0,
          results: null
        })
      }
      return summarizeProteomes(await walkEntries(ctx, base + qs([['page_size', PAGE_SIZE]])))
    }
  },
  {
    id: 'get_protein_atlas_gene',
    connector: 'protein_annotation',
    description:
      'Human Protein Atlas per-gene record (release 25.x): tissue/subcellular/pathology/blood/brain expression and antibody info. Accepts an Ensembl gene ID or a gene symbol.',
    input: {
      type: 'object',
      properties: {
        gene: {
          type: 'string',
          description: 'Ensembl gene ID ("ENSG00000141510") or gene symbol ("TP53").'
        },
        full: {
          type: 'boolean',
          default: false,
          description:
            "False (default) returns a grouped summary; true returns HPA's complete raw record."
        }
      },
      required: ['gene']
    },
    required: ['gene'],
    returns:
      '`full=false`: `{ "identity": {...}, "tissue_expression": {...}, "single_cell_expression": {...}, "blood_expression": {...}, "brain_expression": {...}, "cancer_expression": {...}, "subcellular": {...}, "antibody": {...}, "pathology": { "prognostics": { <cancer>: ... } } }`. `full=true`: HPA\'s complete raw ~119-key per-gene record.',
    example: 'result = host.mcp("protein_annotation", "get_protein_atlas_gene", {"gene": "TP53"})',
    run: async (ctx, a) => {
      const gene = String(a.gene).trim()
      const ensg = ENSG_RE.test(gene) ? gene : await resolveHpaSymbol(ctx, gene)
      const record = (await ctx.fetchJson(
        `${HPA_BASE}/${encodeURIComponent(ensg)}.json`
      )) as Record<string, unknown>
      return a.full ? record : summarizeHpa(record)
    }
  },
  {
    id: 'search_protein_atlas',
    connector: 'protein_annotation',
    description: 'Column-selected bulk search over the Human Protein Atlas (search_download).',
    input: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Free-text search (gene symbol, description keyword, ...).'
        },
        columns: {
          type: 'string',
          default: 'g,gs,eg,gd,up,chr,chrp,scl',
          description:
            'Comma-separated HPA column codes: g=Gene, gs=synonym, eg=Ensembl, gd=description, up=Uniprot, chr=Chromosome, chrp=Position, scl=Subcellular location, ab=Antibody, pc=Protein class, di=Disease.'
        }
      },
      required: ['query']
    },
    required: ['query'],
    returns:
      '`[ { <HPA field name>: value } ]` — a list of row dicts keyed by the human-readable field names selected via `columns`; `[]` when nothing matches.',
    example: 'result = host.mcp("protein_annotation", "search_protein_atlas", {"query": "kinase"})',
    run: async (ctx, a) => {
      const columns = String(a.columns ?? 'g,gs,eg,gd,up,chr,chrp,scl')
      return ctx.fetchJson(
        `${HPA_BASE}/api/search_download.php${qs([
          ['search', a.query],
          ['format', 'json'],
          ['columns', columns],
          ['compress', 'no']
        ])}`
      )
    }
  },
  {
    id: 'map_string_ids',
    connector: 'protein_annotation',
    description:
      'Map gene symbols/aliases to STRING protein identifiers (v12.0). Every input symbol is either mapped or listed in unmapped — the two partition the input.',
    input: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Gene symbols or aliases, e.g. ["TP53", "PD-1"].'
        },
        species: {
          type: 'integer',
          default: DEFAULT_SPECIES,
          description: 'NCBI taxonomy ID (9606 = human).'
        }
      },
      required: ['symbols']
    },
    required: ['symbols'],
    returns:
      '`{ "string_version": { "string_version": str, "stable_address": str }, "species": int, "mapped": [ { "query": str, "string_id": str, "preferred_name": str, "ncbi_taxon_id": int } ], "unmapped": [ str ] }`.',
    example:
      'result = host.mcp("protein_annotation", "map_string_ids", {"symbols": ["TP53", "BRCA1", "EGFR"]})',
    run: async (ctx, a) => {
      const species = Number(a.species ?? DEFAULT_SPECIES)
      const { version } = await stringVersion(ctx)
      const { mapped, unmapped } = await mapStringIds(
        ctx,
        (a.symbols as string[]).map(String),
        species
      )
      return { string_version: version, species, mapped, unmapped }
    }
  },
  {
    id: 'get_string_network',
    connector: 'protein_annotation',
    description:
      'STRING protein-protein interaction network for a gene list (v12.0) at a confidence threshold. Maps symbols first (unmapped reported), then retrieves nodes, edges, summary and provenance.',
    input: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Gene symbols, e.g. ["TP53", "BRCA1", "EGFR"].'
        },
        species: {
          type: 'integer',
          default: DEFAULT_SPECIES,
          description: 'NCBI taxonomy ID (9606 = human).'
        },
        required_score: {
          type: 'integer',
          default: 700,
          description: 'Minimum combined score 0-1000 (400 medium, 700 high, 900 highest).'
        }
      },
      required: ['symbols']
    },
    required: ['symbols'],
    returns:
      '`{ "tool", "tool_version", "query", "string_version", "nodes": [ { "query", "name", "string_id", "degree" } ], "unmapped": [ str ], "edges": [ { "a": str, "b": str, "score": float, "evidence": { <channel>: float } } ], "summary": { node/edge counts, score stats }, "provenance": {...} }` — edges deterministically ordered; isolated nodes visible (degree 0).',
    example:
      'result = host.mcp("protein_annotation", "get_string_network", {"symbols": ["TP53", "BRCA1", "EGFR"], "required_score": 700})',
    run: async (ctx, a) => {
      const species = Number(a.species ?? DEFAULT_SPECIES)
      const requiredScore = Number(a.required_score ?? 700)
      const symbols = [
        ...new Set((a.symbols as string[]).map((s) => String(s).trim()).filter(Boolean))
      ]
      if (!symbols.length) throw new Error('no input symbols provided')
      const requests: RequestLogEntry[] = []
      const ver = await stringVersion(ctx)
      requests.push(ver.log)
      const m = await mapStringIds(ctx, symbols, species)
      requests.push(m.log)
      let edges: Array<Record<string, unknown>> = []
      const stringIds = m.mapped.map((x) => x.string_id)
      if (stringIds.length) {
        const url = `${STRING_BASE}/tsv/network${qs([
          ['identifiers', stringIds.join('\r')],
          ['species', species],
          ['required_score', requiredScore],
          ['caller_identity', STRING_CALLER]
        ])}`
        const text = await ctx.fetchText(url)
        edges = canonicalEdges(parseNetworkTsv(text))
        requests.push({ endpoint: 'tsv/network', bytes: byteLen(text) })
      }
      return {
        tool: 'string-network',
        tool_version: '0.3.0',
        query: { symbols, species, required_score: requiredScore },
        string_version: ver.version,
        nodes: nodeTable(m.mapped, edges),
        unmapped: m.unmapped,
        edges,
        summary: summarizeNetwork(m.mapped, m.unmapped, edges),
        provenance: {
          api_base_url: STRING_BASE,
          caller_identity: STRING_CALLER,
          endpoints_used: ['json/version', 'json/get_string_ids', 'tsv/network'],
          parameters: {
            species,
            required_score: requiredScore,
            network_type: 'functional',
            'get_string_ids.limit': 1,
            'get_string_ids.echo_query': 1,
            'network.add_nodes': 0
          },
          retrieved_at: new Date().toISOString(),
          n_http_requests: requests.length,
          bytes_downloaded: requests.reduce((s, r) => s + r.bytes, 0),
          requests
        }
      }
    }
  },
  {
    id: 'get_string_similarity_scores',
    connector: 'protein_annotation',
    description:
      "Smith-Waterman protein similarity bitscores among a gene set (STRING /homology). Sparse: pairs absent from STRING's data are not listed (absence means no recorded similarity, not zero).",
    input: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Gene symbols in the source species.'
        },
        species: {
          type: 'integer',
          default: DEFAULT_SPECIES,
          description: 'NCBI taxonomy ID (9606 = human).'
        }
      },
      required: ['symbols']
    },
    required: ['symbols'],
    returns:
      '`{ "species": int, "mapped": [...], "unmapped": [ str ], "n_pairs": int, "n_self": int, "pairs": [ { "id_a": str, "id_b": str, "taxon_a": int, "taxon_b": int, "bitscore": float, "self": bool, "name_a": str, "name_b": str } ] }` — one record per reported unordered pair (incl. self-scores), id_a <= id_b.',
    example:
      'result = host.mcp("protein_annotation", "get_string_similarity_scores", {"symbols": ["TP53", "MDM2", "MDM4"]})',
    run: async (ctx, a) => {
      const species = Number(a.species ?? DEFAULT_SPECIES)
      const { mapped, unmapped } = await mapStringIds(
        ctx,
        (a.symbols as string[]).map(String),
        species
      )
      let pairs: Array<Record<string, unknown>> = []
      if (mapped.length) {
        const { data } = await stringGetJson(ctx, 'json', 'homology', [
          ['identifiers', mapped.map((m) => m.string_id).join('\r')],
          ['species', species]
        ])
        pairs = parseHomologyRows((data as Array<Record<string, unknown>>) ?? [])
      }
      const nameById = new Map(mapped.map((m) => [m.string_id, m.preferred_name]))
      for (const rec of pairs) {
        rec.name_a = nameById.get(String(rec.id_a))
        rec.name_b = nameById.get(String(rec.id_b))
      }
      return {
        species,
        mapped,
        unmapped,
        n_pairs: pairs.length,
        n_self: pairs.filter((p) => p.self).length,
        pairs
      }
    }
  },
  {
    id: 'get_string_best_similarity_hits',
    connector: 'protein_annotation',
    description:
      'Best homology hit per input protein in a target species (STRING /homology_best). target_species=null asks for the best hit across all species.',
    input: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Gene symbols in the source species.'
        },
        species: {
          type: 'integer',
          default: DEFAULT_SPECIES,
          description: 'Source NCBI taxonomy ID (9606 = human).'
        },
        target_species: {
          type: 'integer',
          description: 'Target NCBI taxonomy ID; omit for best hit across all species.'
        }
      },
      required: ['symbols']
    },
    required: ['symbols'],
    returns:
      '`{ "species": int, "species_b": int|null, "mapped": [...], "unmapped": [ str ], "n_hits": int, "hits": [ { "query_id": str, "query_name": str, "query_taxon": int, "hit_id": str, "hit_taxon": int, "bitscore": float } ] }` — one best-hit record per query protein, sorted by query STRING ID.',
    example:
      'result = host.mcp("protein_annotation", "get_string_best_similarity_hits", {"symbols": ["TP53"], "target_species": 10090})',
    run: async (ctx, a) => {
      const species = Number(a.species ?? DEFAULT_SPECIES)
      const targetSpecies = a.target_species != null ? Number(a.target_species) : null
      const { mapped, unmapped } = await mapStringIds(
        ctx,
        (a.symbols as string[]).map(String),
        species
      )
      let hits: Array<Record<string, unknown>> = []
      if (mapped.length) {
        const nameById = new Map(mapped.map((m) => [m.string_id, m.preferred_name]))
        const params: Array<[string, unknown]> = [
          ['identifiers', mapped.map((m) => m.string_id).join('\r')],
          ['species', species]
        ]
        if (targetSpecies !== null) params.push(['species_b', targetSpecies])
        const { data } = await stringGetJson(ctx, 'json', 'homology_best', params)
        hits = ((data as Array<Record<string, unknown>>) ?? []).map((row) => ({
          query_id: String(row.stringId_A),
          query_name: nameById.get(String(row.stringId_A)),
          query_taxon: Number(row.ncbiTaxonId_A),
          hit_id: String(row.stringId_B),
          hit_taxon: Number(row.ncbiTaxonId_B),
          bitscore: round1(Number(row.bitscore))
        }))
        hits.sort(
          (x, y) =>
            String(x.query_id).localeCompare(String(y.query_id)) ||
            String(x.hit_id).localeCompare(String(y.hit_id))
        )
      }
      return { species, species_b: targetSpecies, mapped, unmapped, n_hits: hits.length, hits }
    }
  }
]
