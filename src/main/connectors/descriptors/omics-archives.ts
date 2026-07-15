import { ncbiEtiquette } from '../engine'
import type { ToolContext, ToolDescriptor } from '../types'

// Public read-only endpoints for the five omics data archives grouped under this connector.
// Ported faithfully from the upstream openscience-mcp `mcp_omics_archives` fleet packages
// (arrayexpress-experiments, geo-meta, metabolights-meta, mgnify-studies, pride-projects):
// same request flow, pagination / count-verification, field names and output shapes.
const BIOSTUDIES = 'https://www.ebi.ac.uk/biostudies/api/v1'
const BIOSTUDIES_FILES = 'https://www.ebi.ac.uk/biostudies/files'
const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
const ACC_CGI = 'https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi'
const METABOLIGHTS = 'https://www.ebi.ac.uk/metabolights/ws'
const MGNIFY = 'https://www.ebi.ac.uk/metagenomics/api/v1'
const PRIDE = 'https://www.ebi.ac.uk/pride/ws/archive/v2'

// ---------------------------------------------------------------------------
// small generic helpers
// ---------------------------------------------------------------------------
type Obj = Record<string, unknown>
const asObj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const cleanStr = (v: unknown): string | undefined => {
  const s = v == null ? '' : String(v).trim()
  return s || undefined
}

// Parse to an integer, mirroring Python int(): non-numeric or empty strings become null (not 0).
const toIntOrNull = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? Math.trunc(n) : null
  }
  return null
}

// URL query string from a param map, dropping undefined/empty values.
const qs = (params: Record<string, string | number | undefined>): string =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')

const byStr =
  (key: (x: Obj) => string) =>
  (a: Obj, b: Obj): number =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0

// The engine surfaces upstream errors as `HTTP <status> for <url>`; 401/403/404 mean the record is
// private/deprecated/absent (upstream treats these as "not found" rather than a hard failure).
const isNotFound = (err: unknown): boolean =>
  err instanceof Error && /HTTP (401|403|404)\b/.test(err.message)

// Slice an already-complete record list for output; returns [rows, truncated].
const cap = <T>(records: T[], maxReturned: number): [T[], boolean] =>
  maxReturned >= 0 && records.length > maxReturned
    ? [records.slice(0, maxReturned), true]
    : [records, false]

// Minimal fnmatch (glob) → RegExp, case-sensitive like POSIX fnmatch.
const globToRegExp = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`
  )

// ---------------------------------------------------------------------------
// ArrayExpress / BioStudies (arrayexpress-experiments)
// ---------------------------------------------------------------------------
const AE_PAGE_SIZE = 100 // server-side cap

// Section-tree traversal (BioStudies submission JSON): subsection entries may be dicts or lists.
function* iterSections(node: unknown): Generator<Obj> {
  if (Array.isArray(node)) {
    for (const item of node) yield* iterSections(item)
  } else if (node && typeof node === 'object') {
    const o = node as Obj
    yield o
    for (const sub of asArr(o.subsections)) yield* iterSections(sub)
  }
}

function* iterFiles(node: unknown): Generator<Obj> {
  for (const sec of iterSections(node)) {
    for (const entry of asArr(sec.files)) {
      const items = Array.isArray(entry) ? entry : [entry]
      for (const f of items) if (f && typeof f === 'object') yield f as Obj
    }
  }
}

function* iterLinks(node: unknown): Generator<Obj> {
  for (const sec of iterSections(node)) {
    for (const entry of asArr(sec.links)) {
      const items = Array.isArray(entry) ? entry : [entry]
      for (const l of items) if (l && typeof l === 'object') yield l as Obj
    }
  }
}

const attrMap = (node: Obj): Record<string, Obj[]> => {
  const out: Record<string, Obj[]> = {}
  for (const a of asArr(node.attributes)) {
    const at = asObj(a)
    const name = str(at.name)
    if (name) (out[name] ??= []).push(at)
  }
  return out
}
const attrValues = (node: Obj, name: string): string[] =>
  (attrMap(node)[name] ?? []).map((a) => a.value).filter((v): v is string => typeof v === 'string')
const attrValue = (node: Obj, name: string): string | undefined => attrValues(node, name)[0]
const sectionsOfType = (root: Obj, type: string): Obj[] =>
  [...iterSections(root)].filter((s) => s.type === type)

// Canonical JSON key ordering for a deterministic sort key (mirrors Python json.dumps(sort_keys=True)).
const stableStringify = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Obj
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

// Flatten a BioStudies study JSON (ArrayExpress experiment) into a single flat analyst record.
function flattenStudy(study: Obj): Obj {
  const topAttrs: Record<string, unknown> = {}
  for (const a of asArr(study.attributes)) {
    const at = asObj(a)
    const name = str(at.name)
    if (name) topAttrs[name] = at.value
  }
  const section = asObj(study.section)

  // Samples: sample count, experimental designs/factors.
  let sampleCount: number | null = null
  let designs: string[] = []
  let factors: string[] = []
  for (const samples of sectionsOfType(section, 'Samples')) {
    const sc = attrValue(samples, 'Sample count')
    if (sc != null && sampleCount === null) sampleCount = toIntOrNull(sc)
    designs = designs.concat(attrValues(samples, 'Experimental Designs'))
    factors = factors.concat(attrValues(samples, 'Experimental Factors'))
  }
  designs = [...new Set(designs)].sort()
  factors = [...new Set(factors)].sort()

  // Assays and Data: assay count, technology, assay-by-molecule.
  let assayCount: number | null = null
  let technology: string | undefined
  let assayByMolecule: string | undefined
  for (const aad of sectionsOfType(section, 'Assays and Data')) {
    const ac = attrValue(aad, 'Assay count')
    if (ac != null && assayCount === null) assayCount = toIntOrNull(ac)
    technology = technology ?? attrValue(aad, 'Technology')
    assayByMolecule = assayByMolecule ?? attrValue(aad, 'Assay by Molecule')
  }

  // Authors (document order) and submitter organizations.
  const orgNames: Record<string, string> = {}
  for (const org of [
    ...sectionsOfType(section, 'Organization'),
    ...sectionsOfType(section, 'Organisation')
  ]) {
    const accno = str(org.accno) ?? ''
    const name = attrValue(org, 'Name')
    if (name) orgNames[accno] = name
  }
  const authors = sectionsOfType(section, 'Author').map((author) => {
    const amap = attrMap(author)
    const affilRefs = (amap.affiliation ?? [])
      .map((a) => str(a.value))
      .filter((v): v is string => Boolean(v))
    return {
      name: attrValue(author, 'Name'),
      email: attrValue(author, 'Email'),
      role: attrValue(author, 'Role'),
      affiliations: affilRefs.map((ref) => orgNames[ref] ?? ref)
    }
  })
  const submitterOrganizations = [...new Set(Object.values(orgNames))].sort()

  // Publications (sorted by canonical JSON for determinism).
  const publications = sectionsOfType(section, 'Publication').map((pub) => ({
    accno: str(pub.accno) ?? null,
    title: attrValue(pub, 'Title'),
    authors: attrValue(pub, 'Authors'),
    doi: attrValue(pub, 'DOI'),
    status: attrValue(pub, 'Status')
  }))
  publications.sort((a, b) => (stableStringify(a) < stableStringify(b) ? -1 : 1))

  // Protocols and array designs.
  const protocolSections = sectionsOfType(section, 'Protocols')
  const protocolTypes = [
    ...new Set(protocolSections.flatMap((p) => attrValues(p, 'Type')).filter(Boolean))
  ].sort()
  const arrayDesigns = [
    ...new Set(
      [...iterLinks(section)]
        .filter((l) =>
          asArr(l.attributes).some((a) => {
            const at = asObj(a)
            return at.name === 'Type' && at.value === 'Array Design'
          })
        )
        .map((l) => str(l.url))
        .filter((u): u is string => Boolean(u))
    )
  ].sort()

  // Files: count, per-type summary, total bytes.
  const files = [...iterFiles(section)]
  const filesByType: Record<string, number> = {}
  let totalBytes = 0
  for (const f of files) {
    let ftype: string | undefined
    for (const a of asArr(f.attributes)) {
      const at = asObj(a)
      if ((at.name === 'Type' || at.name === 'Description') && at.value) {
        ftype = str(at.value)
        break
      }
    }
    ftype = ftype ?? 'unspecified'
    filesByType[ftype] = (filesByType[ftype] ?? 0) + 1
    if (typeof f.size === 'number') totalBytes += Math.trunc(f.size)
  }
  const filesByTypeSorted: Record<string, number> = {}
  for (const k of Object.keys(filesByType).sort()) filesByTypeSorted[k] = filesByType[k]

  // Link targets (url + declared Type), sorted and de-duplicated.
  const linkPairs = new Set<string>()
  const links: Array<{ target: string; type: string }> = []
  for (const l of iterLinks(section)) {
    const url = str(l.url) ?? ''
    const type =
      str(
        asArr(l.attributes)
          .map(asObj)
          .find((a) => a.name === 'Type')?.value
      ) ?? ''
    const key = `${url} ${type}`
    if (url && !linkPairs.has(key)) {
      linkPairs.add(key)
      links.push({ target: url, type })
    }
  }
  links.sort((a, b) =>
    a.target === b.target ? a.type.localeCompare(b.type) : a.target.localeCompare(b.target)
  )

  return {
    accession: study.accno,
    title: attrValue(section, 'Title') ?? topAttrs.Title,
    release_date: topAttrs.ReleaseDate,
    study_type: attrValue(section, 'Study type'),
    organisms: [...new Set(attrValues(section, 'Organism'))].sort(),
    description: attrValue(section, 'Description'),
    assay_count: assayCount,
    sample_count: sampleCount,
    technology,
    assay_by_molecule: assayByMolecule,
    experimental_designs: designs,
    experimental_factors: factors,
    authors,
    submitter_organizations: submitterOrganizations,
    publications,
    protocol_count: protocolSections.length,
    protocol_types: protocolTypes,
    array_designs: arrayDesigns,
    file_count: files.length,
    files_by_type: filesByTypeSorted,
    total_file_bytes: totalBytes,
    links
  }
}

const fileRecord = (f: Obj): Obj => {
  const attrs: Record<string, unknown> = {}
  for (const a of asArr(f.attributes)) {
    const at = asObj(a)
    if (str(at.name)) attrs[str(at.name) as string] = at.value
  }
  return {
    path: f.path,
    size_bytes: f.size,
    type: attrs.Type,
    format: attrs.Format,
    description: attrs.Description
  }
}

// Build ArrayExpress search query params (facets + free text + release-date range) from tool args.
function aeSearchParams(a: Obj): Record<string, string> {
  const params: Record<string, string> = {}
  const clauses: string[] = []
  const query = cleanStr(a.query)
  const after = cleanStr(a.released_after)
  const before = cleanStr(a.released_before)
  if (query) clauses.push(query)
  if (after || before) clauses.push(`release_date:[${after ?? '*'} TO ${before ?? '*'}]`)
  if (clauses.length)
    params.query = clauses
      .map((c) => (c.includes(' AND ') || c.includes(' OR ') ? `(${c})` : c))
      .join(' AND ')
  const organism = cleanStr(a.organism)
  const studyType = cleanStr(a.study_type)
  const technology = cleanStr(a.technology)
  if (organism) params['facet.organism'] = organism.toLowerCase()
  if (studyType) params['facet.study_type'] = studyType.toLowerCase()
  if (technology) params['facet.technology'] = technology.toLowerCase()
  const extra = asObj(a.extra_facets)
  for (const k of Object.keys(extra).sort()) {
    const v = cleanStr(extra[k])
    if (v) params[k.startsWith('facet.') ? k : `facet.${k}`] = v.toLowerCase()
  }
  params.sortBy = 'release_date'
  params.sortOrder = 'descending'
  return params
}

// Walk every result page, verifying the unique-record count against the API's totalHits. The server's
// release_date tie order can differ between page fetches of one sweep, yielding a spurious count
// mismatch; each retry uses a different page size to move every page boundary (upstream behaviour).
async function aeSearch(
  ctx: ToolContext,
  params: Record<string, string>,
  maxRecords: number
): Promise<Obj> {
  const schedule = [AE_PAGE_SIZE, Math.max(2, AE_PAGE_SIZE - 3), Math.max(2, AE_PAGE_SIZE - 11)]
  let lastError: Error | null = null
  let out: Obj | null = null
  for (const pageSize of schedule) {
    const records: Obj[] = []
    const seen = new Set<string>()
    let page = 1
    let totalHits: number | null = null
    let isExact = false
    let truncated = false
    for (;;) {
      const data = asObj(
        await ctx.fetchJson(
          `${BIOSTUDIES}/arrayexpress/search?${qs({ ...params, pageSize, page })}`
        )
      )
      if (totalHits === null) {
        totalHits = toIntOrNull(data.totalHits) ?? 0
        isExact = Boolean(data.isTotalHitsExact)
      }
      const hits = asArr(data.hits)
      for (const h of hits) {
        const ho = asObj(h)
        const acc = str(ho.accession)
        if (acc && !seen.has(acc)) {
          seen.add(acc)
          records.push({
            accession: ho.accession,
            title: ho.title,
            release_date: ho.release_date,
            files: ho.files,
            links: ho.links,
            is_public: ho.isPublic
          })
          if (maxRecords >= 0 && records.length >= maxRecords) {
            truncated = true
            break
          }
        }
      }
      if (truncated || hits.length === 0 || records.length >= (totalHits ?? 0)) break
      page += 1
    }
    if (truncated || totalHits === null || records.length === totalHits) {
      // Deterministic order: release_date descending, accession ascending as the tie-break.
      records.sort(byStr((r) => String(r.accession ?? '')))
      records.sort(
        (x, y) => -String(x.release_date ?? '').localeCompare(String(y.release_date ?? ''))
      )
      out = { total_hits: totalHits ?? 0, is_total_exact: isExact, records, params, truncated }
      lastError = null
      break
    }
    lastError = new Error(
      `Pagination mismatch: retrieved ${records.length} unique accessions but the API reported totalHits=${totalHits}`
    )
  }
  if (lastError) throw lastError
  return out as Obj
}

// ---------------------------------------------------------------------------
// GEO (geo-meta; NCBI E-utilities db=gds + targeted SOFT headers)
// ---------------------------------------------------------------------------
const GSE_RE = /^GSE\d+$/
const GEO_ESUMMARY_FIELDS = [
  'uid',
  'accession',
  'title',
  'summary',
  'gdstype',
  'taxon',
  'n_samples',
  'pdat',
  'suppfile',
  'ftplink',
  'bioproject',
  'gpl',
  'gse',
  'pubmedids',
  'platformtitle',
  'platformtaxa',
  'samplestaxa',
  'entrytype'
]

const trimEsummary = (doc: Obj): Obj => {
  const trimmed: Obj = {}
  for (const k of GEO_ESUMMARY_FIELDS) if (k in doc) trimmed[k] = doc[k]
  if ('n_samples' in trimmed) trimmed.n_samples = toIntOrNull(trimmed.n_samples)
  const samples = asArr(doc.samples)
    .map((s) => ({ accession: asObj(s).accession, title: asObj(s).title }))
    .sort((a, b) => String(a.accession ?? '').localeCompare(String(b.accession ?? '')))
  trimmed.samples = samples
  return trimmed
}

const eutil = (
  path: string,
  params: Record<string, string | number | undefined>,
  etiquette: string
): string => `${EUTILS}/${path}?${qs(params)}${etiquette}`

// esearch db=gds -> {count, ids}.
async function esearchGds(
  ctx: ToolContext,
  term: string,
  retmax: number,
  etiquette: string
): Promise<{ count: number; ids: string[] }> {
  const res = asObj(
    await ctx.fetchJson(
      eutil('esearch.fcgi', { db: 'gds', term, retmode: 'json', retmax }, etiquette)
    )
  )
  const result = asObj(res.esearchresult)
  if ('ERROR' in result)
    throw new Error(`esearch error for term ${JSON.stringify(term)}: ${String(result.ERROR)}`)
  return {
    count: toIntOrNull(result.count) ?? 0,
    ids: asArr(result.idlist).map(String)
  }
}

// esummary db=gds (version 2.0, JSON) -> accession -> docsum.
async function esummaryGds(
  ctx: ToolContext,
  uids: string[],
  etiquette: string
): Promise<Record<string, Obj>> {
  if (!uids.length) return {}
  const res = asObj(
    await ctx.fetchJson(
      eutil(
        'esummary.fcgi',
        { db: 'gds', id: uids.join(','), retmode: 'json', version: '2.0' },
        etiquette
      )
    )
  )
  const result = asObj(res.result)
  const out: Record<string, Obj> = {}
  for (const uid of asArr(result.uids).map(String)) {
    const doc = asObj(result[uid])
    const acc = str(doc.accession)
    if (acc) out[acc] = doc
  }
  return out
}

// Resolve GSE accessions -> trimmed esummary docs with one esearch + one esummary.
async function resolveGeoAccessions(
  ctx: ToolContext,
  accessions: string[],
  etiquette: string
): Promise<Record<string, Obj>> {
  for (const acc of accessions)
    if (!GSE_RE.test(acc)) throw new Error(`not a GSE accession: ${JSON.stringify(acc)}`)
  const term = `(${accessions.map((a) => `${a}[ACCN]`).join(' OR ')}) AND gse[ETYP]`
  const found = await esearchGds(ctx, term, Math.max(accessions.length * 2, 20), etiquette)
  const docs = await esummaryGds(ctx, found.ids, etiquette)
  const missing = accessions.filter((a) => !(a in docs))
  if (missing.length)
    throw new Error(`accessions not found in GEO DataSets (db=gds): ${missing.join(', ')}`)
  return docs
}

// SOFT brief text parsing (header lines only; targ=self / targ=gsm — never data tables).
const ENTITY_RE = /^\^([A-Z]+) = (\S+)\s*$/
const ATTR_RE = /^!([^=]+?)\s*=\s*(.*?)\s*$/

type SoftEntity = { kind: string; acc: string; attrs: Record<string, string[]> }

const splitEntities = (text: string): SoftEntity[] => {
  const entities: SoftEntity[] = []
  let current: Record<string, string[]> | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[\r\n]+$/, '')
    if (!line) continue
    const em = ENTITY_RE.exec(line)
    if (em) {
      current = {}
      entities.push({ kind: em[1], acc: em[2], attrs: current })
      continue
    }
    if (current === null) continue
    const am = ATTR_RE.exec(line)
    if (am) (current[am[1]] ??= []).push(am[2])
  }
  return entities
}

const softFirst = (attrs: Record<string, string[]>, key: string): string | undefined =>
  attrs[key]?.[0]
const softAll = (attrs: Record<string, string[]>, key: string): string[] => attrs[key] ?? []

const parseCharacteristics = (values: string[]): Array<{ tag: string; value: string }> =>
  values.map((v) => {
    if (v.includes(': ')) {
      const idx = v.indexOf(': ')
      return { tag: v.slice(0, idx).trim(), value: v.slice(idx + 2).trim() }
    }
    if (v.endsWith(':') && (v.match(/:/g) ?? []).length === 1)
      return { tag: v.slice(0, -1).trim(), value: '' }
    return { tag: '', value: v.trim() }
  })

const parseSeriesHeader = (text: string): Obj => {
  const series = splitEntities(text).filter((e) => e.kind === 'SERIES')
  if (!series.length) throw new Error('no ^SERIES block found in SOFT text')
  const { acc, attrs } = series[0]
  return {
    accession: softFirst(attrs, 'Series_geo_accession') ?? acc,
    title: softFirst(attrs, 'Series_title'),
    status: softFirst(attrs, 'Series_status'),
    submission_date: softFirst(attrs, 'Series_submission_date'),
    last_update_date: softFirst(attrs, 'Series_last_update_date'),
    summary: softAll(attrs, 'Series_summary').join(' '),
    overall_design: softAll(attrs, 'Series_overall_design').join(' '),
    type: softAll(attrs, 'Series_type'),
    pubmed_ids: softAll(attrs, 'Series_pubmed_id'),
    platform_ids: [...softAll(attrs, 'Series_platform_id')].sort(),
    supplementary_files: [...softAll(attrs, 'Series_supplementary_file')].sort()
  }
}

const parseSampleHeaders = (text: string): Obj[] => {
  const samples: Obj[] = []
  for (const { kind, acc, attrs } of splitEntities(text)) {
    if (kind !== 'SAMPLE') continue
    const organisms = [
      ...new Set([
        ...softAll(attrs, 'Sample_organism_ch1'),
        ...softAll(attrs, 'Sample_organism_ch2')
      ])
    ].sort()
    const characteristics = parseCharacteristics([
      ...softAll(attrs, 'Sample_characteristics_ch1'),
      ...softAll(attrs, 'Sample_characteristics_ch2')
    ])
    const supplementary = [
      ...new Set(
        Object.entries(attrs)
          .filter(([k]) => k.startsWith('Sample_supplementary_file'))
          .flatMap(([, vals]) => vals)
          .filter((v) => v && v.toUpperCase() !== 'NONE')
      )
    ].sort()
    samples.push({
      accession: softFirst(attrs, 'Sample_geo_accession') ?? acc,
      title: softFirst(attrs, 'Sample_title'),
      type: softFirst(attrs, 'Sample_type'),
      source_name: softFirst(attrs, 'Sample_source_name_ch1'),
      organism: organisms,
      characteristics,
      molecule: softFirst(attrs, 'Sample_molecule_ch1'),
      library_strategy: softFirst(attrs, 'Sample_library_strategy'),
      library_source: softFirst(attrs, 'Sample_library_source'),
      library_selection: softFirst(attrs, 'Sample_library_selection'),
      instrument_model: softFirst(attrs, 'Sample_instrument_model'),
      platform_id: softFirst(attrs, 'Sample_platform_id'),
      supplementary_files: supplementary
    })
  }
  samples.sort((a, b) => String(a.accession).localeCompare(String(b.accession)))
  return samples
}

// Fetch acc.cgi brief SOFT text for one accession (targ='self' or 'gsm').
async function fetchSoftBrief(ctx: ToolContext, accession: string, targ: string): Promise<string> {
  const text = await ctx.fetchText(
    `${ACC_CGI}?${qs({ acc: accession, targ, form: 'text', view: 'brief' })}`
  )
  if (!text.includes('^SERIES') && !text.includes('^SAMPLE'))
    throw new Error(`acc.cgi returned no SOFT entities for ${accession} (targ=${targ})`)
  return text
}

// Assemble one GSE series record from its esummary doc + parsed SOFT headers.
async function fetchGeoSeries(ctx: ToolContext, accession: string, esummaryDoc: Obj): Promise<Obj> {
  const header = parseSeriesHeader(await fetchSoftBrief(ctx, accession, 'self'))
  const samples = parseSampleHeaders(await fetchSoftBrief(ctx, accession, 'gsm'))
  let organisms = [...new Set(samples.flatMap((s) => asArr(s.organism).map(String)))].sort()
  if (!organisms.length && esummaryDoc.taxon)
    organisms = String(esummaryDoc.taxon)
      .split(';')
      .map((t) => t.trim())
      .filter(Boolean)
      .sort()
  const sampleFiles: Record<string, unknown> = {}
  for (const s of samples)
    if (asArr(s.supplementary_files).length)
      sampleFiles[String(s.accession)] = s.supplementary_files
  return {
    accession,
    title: header.title,
    organism: organisms,
    series_type: header.type,
    status: header.status,
    submission_date: header.submission_date,
    last_update_date: header.last_update_date,
    summary: header.summary,
    overall_design: header.overall_design,
    pubmed_ids: header.pubmed_ids,
    platforms: header.platform_ids,
    n_samples: samples.length,
    samples,
    supplementary_files: {
      series: header.supplementary_files,
      samples: sampleFiles,
      ftp_root: esummaryDoc.ftplink
    },
    esummary: trimEsummary(esummaryDoc)
  }
}

// ---------------------------------------------------------------------------
// MetaboLights (metabolights-meta)
// ---------------------------------------------------------------------------
const MTBLS_RE = /^MTBLS\d+$/
const mtblsSortKey = (acc: string): number => {
  const m = /(\d+)/.exec(acc)
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER
}
const sortMtbls = (accs: string[]): string[] =>
  [...new Set(accs.map((a) => a.trim().toUpperCase()).filter(Boolean))].sort(
    (a, b) => mtblsSortKey(a) - mtblsSortKey(b) || a.localeCompare(b)
  )

// Extract the flat metadata record from a raw /studies/public/study/{acc} payload.
function extractStudyMetadata(payload: Obj): Obj {
  const content = asObj(payload.content)
  const organisms = asArr(content.organism)
    .map((o) => ({
      organism: cleanStr(asObj(o).organismName),
      organism_part: cleanStr(asObj(o).organismPart)
    }))
    .filter((o) => o.organism || o.organism_part)
    .sort(
      (a, b) =>
        (a.organism ?? '').localeCompare(b.organism ?? '') ||
        (a.organism_part ?? '').localeCompare(b.organism_part ?? '')
    )
  const assays = asArr(content.assays)
    .map((a) => {
      const ao = asObj(a)
      return {
        assay_number: ao.assayNumber ?? null,
        measurement: cleanStr(ao.measurement),
        technology: cleanStr(ao.technology),
        platform: cleanStr(ao.platform),
        filename: cleanStr(ao.fileName)
      }
    })
    .sort(
      (a, b) =>
        (Number(a.assay_number ?? 0) || 0) - (Number(b.assay_number ?? 0) || 0) ||
        (a.filename ?? '').localeCompare(b.filename ?? '')
    )
  const technologies = [...new Set(assays.map((a) => a.technology).filter(Boolean))].sort()
  const factors = [
    ...new Set(
      asArr(content.factors)
        .map((f) => cleanStr(asObj(f).name))
        .filter(Boolean)
    )
  ].sort() as string[]
  const descriptors = [
    ...new Set(
      asArr(content.descriptors)
        .map((d) => cleanStr(asObj(d).description))
        .filter(Boolean)
    )
  ].sort() as string[]
  const derived = asObj(content.derivedData)
  return {
    accession: cleanStr(content.studyIdentifier),
    title: cleanStr(content.title),
    description: cleanStr(content.studyDescription),
    study_status: cleanStr(content.studyStatus),
    release_year: derived.releaseYear ?? null,
    submission_year: derived.submissionYear ?? null,
    organisms,
    organism_names: [
      ...new Set(organisms.map((o) => o.organism).filter(Boolean))
    ].sort() as string[],
    assays,
    assay_count: assays.length,
    technologies,
    factors,
    descriptors,
    sample_count: asArr(asObj(content.sampleTable).data).length
  }
}

const metabolightsProtocols = (
  content: Obj
): Array<{ name: string | null; description: string | null }> => {
  const out: Array<{ name: string | null; description: string | null }> = []
  for (const p of asArr(content.protocols)) {
    const po = asObj(p)
    const name = cleanStr(po.name) ?? null
    const description = cleanStr(po.description) ?? null
    if (name || description) out.push({ name, description })
  }
  return out
}

// Reshape the raw ISA sampleTable block (fields keyed '<index>~<name>', positional data rows).
function metabolightsSampleTable(sampleTable: Obj, maxRows: number): Obj {
  const fields = asObj(sampleTable.fields)
  const ordered = Object.values(fields)
    .map(asObj)
    .filter((f) => 'index' in f)
    .sort((a, b) => Number(a.index) - Number(b.index))
  const headers = ordered.map((f) => str(f.header) || `column_${String(f.index)}`)
  const data = asArr(sampleTable.data)
  const nTotal = data.length
  const truncated = maxRows >= 0 && nTotal > maxRows
  const rows = (truncated ? data.slice(0, maxRows) : data).map((raw) => {
    const cells = asArr(raw)
    const row: Record<string, unknown> = {}
    headers.forEach((h, i) => {
      row[h] = i < cells.length ? cells[i] : ''
    })
    return row
  })
  return { headers, rows, n_rows_total: nTotal, rows_truncated: truncated }
}

// ---------------------------------------------------------------------------
// MGnify (mgnify-studies; JSON:API v1)
// ---------------------------------------------------------------------------
const MGNIFY_PAGE_SIZE = 250

const relIds = (obj: Obj, name: string): string[] => {
  const data = asObj(asObj(obj.relationships)[name]).data
  if (data == null) return []
  if (Array.isArray(data))
    return data
      .map((d) => str(asObj(d).id))
      .filter((v): v is string => Boolean(v))
      .sort()
  const id = str(asObj(data).id)
  return id ? [id] : []
}
const relId = (obj: Obj, name: string): string | null => relIds(obj, name)[0] ?? null

const flattenMgnifyStudy = (obj: Obj): Obj => {
  const a = asObj(obj.attributes)
  return {
    accession: str(obj.id) ?? a.accession,
    secondary_accession: a['secondary-accession'],
    bioproject: a.bioproject,
    study_name: a['study-name'],
    biome_lineages: relIds(obj, 'biomes'),
    samples_count: a['samples-count'],
    centre_name: a['centre-name'],
    data_origination: a['data-origination'],
    is_private: a['is-private'],
    last_update: a['last-update']
  }
}

const flattenMgnifyAnalysis = (obj: Obj, studyAccession: string | null): Obj => {
  const a = asObj(obj.attributes)
  const pv = a['pipeline-version']
  return {
    analysis_accession: str(obj.id) ?? a.accession,
    study_accession: studyAccession ?? relId(obj, 'study'),
    pipeline_version: pv != null ? String(pv) : null,
    experiment_type: a['experiment-type'],
    analysis_status: a['analysis-status'],
    run_accession: relId(obj, 'run'),
    assembly_accession: relId(obj, 'assembly'),
    sample_accession: relId(obj, 'sample'),
    instrument_platform: a['instrument-platform']
  }
}

const countBreakdowns = (analyses: Obj[]): Obj => {
  const byPipeline: Record<string, number> = {}
  const byExperiment: Record<string, number> = {}
  for (const r of analyses) {
    const pv = str(r.pipeline_version) || 'unknown'
    const et = str(r.experiment_type) || 'unknown'
    byPipeline[pv] = (byPipeline[pv] ?? 0) + 1
    byExperiment[et] = (byExperiment[et] ?? 0) + 1
  }
  const sortObj = (o: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const k of Object.keys(o).sort()) out[k] = o[k]
    return out
  }
  return { by_pipeline_version: sortObj(byPipeline), by_experiment_type: sortObj(byExperiment) }
}

// Retrieve every record of a paginated JSON:API collection, verifying against meta.pagination.count.
async function mgnifyGetAll(
  ctx: ToolContext,
  path: string,
  params: Record<string, string | number | undefined>
): Promise<{ records: Obj[]; count: number; pages_fetched: number }> {
  const first = asObj(
    await ctx.fetchJson(`${MGNIFY}/${path}?${qs({ ...params, page_size: MGNIFY_PAGE_SIZE })}`)
  )
  const count = toIntOrNull(asObj(asObj(first.meta).pagination).count) ?? 0
  const records: Obj[] = asArr(first.data).map(asObj)
  let pagesFetched = 1
  let next = str(asObj(first.links).next)
  while (next) {
    const page = asObj(await ctx.fetchJson(next))
    pagesFetched += 1
    records.push(...asArr(page.data).map(asObj))
    next = str(asObj(page.links).next)
  }
  const uniqueIds = new Set(records.map((r) => str(r.id)))
  if (records.length !== count || uniqueIds.size !== count)
    throw new Error(
      `pagination mismatch on ${path}: meta.pagination.count=${count}, retrieved=${records.length}, unique=${uniqueIds.size}`
    )
  return { records, count, pages_fetched: pagesFetched }
}

async function fetchStudyAnalyses(ctx: ToolContext, accession: string): Promise<Obj> {
  const res = await mgnifyGetAll(ctx, `studies/${encodeURIComponent(accession)}/analyses`, {})
  const analyses = res.records
    .map((o) => flattenMgnifyAnalysis(o, accession))
    .sort((a, b) => String(a.analysis_accession).localeCompare(String(b.analysis_accession)))
  return { study_accession: accession, analyses_count: res.count, analyses }
}

// ---------------------------------------------------------------------------
// PRIDE (pride-projects; Archive REST API v2)
// ---------------------------------------------------------------------------
const PRIDE_PAGE_SIZE = 100
const PRIDE_FILTER_FIELDS: Record<string, string> = {
  organism: 'organisms',
  instrument: 'instruments',
  disease: 'diseases'
}

// Sorted, de-duplicated display names from a list of plain strings or CvParam-like dicts.
const names = (values: unknown): string[] =>
  [
    ...new Set(
      asArr(values)
        .map((v) =>
          v && typeof v === 'object' ? (str(asObj(v).name) ?? '') : v == null ? '' : String(v)
        )
        .map((n) => n.trim())
        .filter(Boolean)
    )
  ].sort()

// Submitter / lab-head names: search gives strings, detail gives contact dicts.
const personNames = (values: unknown): string[] =>
  [
    ...new Set(
      asArr(values)
        .map((v) => {
          if (v && typeof v === 'object') {
            const o = asObj(v)
            const name = (str(o.name) ?? '').trim()
            if (name) return name
            return [str(o.firstName), str(o.lastName)]
              .map((x) => (x ?? '').trim())
              .filter(Boolean)
              .join(' ')
          }
          return String(v).trim()
        })
        .filter(Boolean)
    )
  ].sort()

const prideDate = (value: unknown): string | null => (value ? String(value).slice(0, 10) : null)
const normDoi = (doi: unknown): string | null => {
  if (doi == null) return null
  let d = String(doi).trim()
  if (!d || ['null', 'none'].includes(d.toLowerCase())) return null
  d = d.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '')
  return d.toLowerCase() || null
}
const normPubmed = (pm: unknown): number | null => {
  if (pm == null) return null
  const s = String(pm).trim()
  if (!s || ['null', 'none', '0'].includes(s.toLowerCase())) return null
  const n = Number(s)
  return Number.isInteger(n) ? n : null
}
const REF_SEARCH_RE = /^([\s\S]*?)--pubMed:([^-]*)--doi:\s*([\s\S]*)$/
const references = (values: unknown): Obj[] => {
  const refs: Obj[] = []
  for (const v of asArr(values)) {
    if (v && typeof v === 'object') {
      const o = asObj(v)
      refs.push({
        pubmed_id: normPubmed(o.pubmedID),
        doi: normDoi(o.doi),
        reference_line: (str(o.referenceLine) ?? '').trim()
      })
    } else {
      const text = String(v)
      const m = REF_SEARCH_RE.exec(text)
      if (m)
        refs.push({ pubmed_id: normPubmed(m[2]), doi: normDoi(m[3]), reference_line: m[1].trim() })
      else refs.push({ pubmed_id: null, doi: null, reference_line: text.trim() })
    }
  }
  refs.sort(
    (a, b) =>
      (Number(a.pubmed_id ?? 0) || 0) - (Number(b.pubmed_id ?? 0) || 0) ||
      String(a.doi ?? '').localeCompare(String(b.doi ?? '')) ||
      String(a.reference_line).localeCompare(String(b.reference_line))
  )
  return refs
}

const normalizePrideSearch = (raw: Obj): Obj => ({
  accession: raw.accession,
  title: (str(raw.title) ?? '').trim(),
  organisms: names(raw.organisms),
  organism_parts: names(raw.organismsPart),
  diseases: names(raw.diseases),
  instruments: names(raw.instruments),
  experiment_types: names(raw.experimentTypes),
  softwares: names(raw.softwares),
  quantification_methods: names(raw.quantificationMethods),
  keywords: names(raw.keywords),
  project_tags: names(raw.projectTags),
  submission_date: prideDate(raw.submissionDate),
  publication_date: prideDate(raw.publicationDate),
  submitters: personNames(raw.submitters),
  lab_pis: personNames(raw.labPIs),
  affiliations: names(raw.affiliations),
  references: references(raw.references),
  source: 'search'
})

const normalizePrideDetail = (raw: Obj): Obj => ({
  accession: raw.accession,
  title: (str(raw.title) ?? '').trim(),
  organisms: names(raw.organisms),
  organism_parts: names(raw.organismParts),
  diseases: names(raw.diseases),
  instruments: names(raw.instruments),
  experiment_types: names(raw.experimentTypes),
  softwares: names(raw.softwares),
  quantification_methods: names(raw.quantificationMethods),
  keywords: names(raw.keywords),
  project_tags: names(raw.projectTags),
  submission_date: prideDate(raw.submissionDate),
  publication_date: prideDate(raw.publicationDate),
  submitters: personNames(raw.submitters),
  lab_pis: personNames(raw.labPIs),
  affiliations: names(raw.affiliations),
  references: references(raw.references),
  source: 'detail'
})

const buildPrideFilter = (spec: Obj): string | undefined => {
  const parts: string[] = []
  for (const [key, field] of Object.entries(PRIDE_FILTER_FIELDS)) {
    const value = cleanStr(spec[key])
    if (value) parts.push(`${field}==${value}`)
  }
  for (const [field, value] of Object.entries(asObj(spec.extra_filters))) {
    const v = cleanStr(value)
    if (v) parts.push(`${field}==${v}`)
  }
  return parts.length ? parts.join(',') : undefined
}

// Walk PRIDE search pages (sorted by accession ASC, a stable prefix) up to maxPages, count-verifying
// a complete walk against the API's own total (the `total_records` response header).
async function prideSearch(ctx: ToolContext, spec: Obj, maxPages: number): Promise<Obj> {
  const base: Record<string, string | number | undefined> = {
    pageSize: PRIDE_PAGE_SIZE,
    sortFields: 'accession',
    sortDirection: 'ASC',
    keyword: cleanStr(spec.keyword),
    filter: buildPrideFilter(spec)
  }
  const records: Record<string, Obj> = {}
  let apiTotal: number | null = null
  let page = 0
  let pagesFetched = 0
  let complete = false
  while (page < maxPages) {
    const { body, headers } = await ctx.fetchJsonWithHeaders(
      `${PRIDE}/search/projects?${qs({ ...base, page })}`
    )
    pagesFetched += 1
    const headerTotal = headers.get('total_records')
    if (apiTotal === null && headerTotal != null) apiTotal = toIntOrNull(headerTotal)
    const items = asArr(body)
    if (!items.length) {
      complete = true
      break
    }
    for (const raw of items) {
      const rec = normalizePrideSearch(asObj(raw))
      records[String(rec.accession)] = rec
    }
    if (items.length < PRIDE_PAGE_SIZE) {
      complete = true
      break
    }
    page += 1
  }
  const nRecords = Object.keys(records).length
  if (!complete && apiTotal !== null && nRecords === apiTotal) complete = true
  const ordered = Object.keys(records)
    .sort()
    .map((acc) => records[acc])
  if (complete && apiTotal !== null && ordered.length !== apiTotal)
    throw new Error(
      `retrieved ${ordered.length} unique projects but API reported total_records=${apiTotal} (spec=${JSON.stringify(spec)})`
    )
  return {
    spec,
    filter: buildPrideFilter(spec) ?? null,
    api_total: apiTotal,
    records: ordered,
    complete,
    pages_fetched: pagesFetched
  }
}

// ===========================================================================
// Descriptors (17 tools; connector = 'omics_archives')
// ===========================================================================
export const OMICS_ARCHIVES_TOOLS: ToolDescriptor[] = [
  // ---- ArrayExpress (BioStudies) ----
  {
    id: 'arrayexpress_search_experiments',
    connector: 'omics_archives',
    description:
      'Search ArrayExpress functional-genomics experiments (BioStudies) with complete, totalHits-verified retrieval; filters (query, organism, study_type, technology, release-date range, extra facets) combine with AND.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text (BioStudies/Lucene syntax)' },
        organism: { type: 'string', description: "e.g. 'Homo sapiens'" },
        study_type: { type: 'string', description: "e.g. 'ChIP-seq'" },
        technology: { type: 'string', description: "e.g. 'sequencing assay', 'array assay'" },
        released_after: { type: 'string', description: 'Inclusive ISO date YYYY-MM-DD' },
        released_before: { type: 'string', description: 'Inclusive ISO date YYYY-MM-DD' },
        extra_facets: { type: 'object', additionalProperties: { type: 'string' } },
        max_records: { type: 'integer', default: 50 }
      }
    },
    returns:
      '`{ "total_hits": int, "is_total_exact": bool, "truncated": bool, "params": {...}, "records": [ { "accession": str, "title": str, "release_date": str, "files": int, "links": int, "is_public": bool } ] }` — every match is walked and the unique count verified against `total_hits`; `records` is capped at `max_records` (default 50) with `truncated=true`, `total_hits` still the full count. Sorted release_date desc, accession asc.',
    example:
      'result = host.mcp("omics_archives", "arrayexpress_search_experiments", {"organism": "Homo sapiens", "study_type": "ChIP-seq", "max_records": 50})',
    run: (ctx, a) => aeSearch(ctx, aeSearchParams(a), Number(a.max_records ?? 50))
  },
  {
    id: 'arrayexpress_get_experiment',
    connector: 'omics_archives',
    description:
      'Fetch one ArrayExpress experiment (BioStudies) as a flattened analyst record — study type, organisms, assay/sample counts, designs/factors, authors, publications, protocols, array designs, and file summary.',
    input: {
      type: 'object',
      properties: { accession: { type: 'string', description: "e.g. 'E-MTAB-5061'" } },
      required: ['accession']
    },
    required: ['accession'],
    returns:
      '`{ "accession", "title", "release_date", "study_type", "organisms": [str], "description", "assay_count", "sample_count", "technology", "assay_by_molecule", "experimental_designs": [str], "experimental_factors": [str], "authors": [{name,email,role,affiliations}], "submitter_organizations": [str], "publications": [{accno,title,authors,doi,status}], "protocol_count", "protocol_types": [str], "array_designs": [str], "file_count", "files_by_type": {type:count}, "total_file_bytes", "links": [{target,type}] }` — absent attributes are undefined.',
    example:
      'result = host.mcp("omics_archives", "arrayexpress_get_experiment", {"accession": "E-MTAB-5061"})',
    url: (a) => `${BIOSTUDIES}/studies/${encodeURIComponent(String(a.accession))}`,
    parse: (raw) => flattenStudy(asObj(raw))
  },
  {
    id: 'arrayexpress_get_experiment_files',
    connector: 'omics_archives',
    description:
      'List every file of an ArrayExpress experiment (name, size, type, format, description) with download URLs, plus the /info endpoint file count carried alongside for comparison.',
    input: {
      type: 'object',
      properties: { accession: { type: 'string', description: "e.g. 'E-MTAB-5061'" } },
      required: ['accession']
    },
    required: ['accession'],
    returns:
      '`{ "accession", "n_files": int, "files": [ { "path", "size_bytes", "type", "format", "description", "download_url" } ], "info_reported_file_count": int, "http_link", "ftp_link", "rel_path" }` — files sorted by path.',
    example:
      'result = host.mcp("omics_archives", "arrayexpress_get_experiment_files", {"accession": "E-MTAB-5061"})',
    run: async (ctx, a) => {
      const acc = encodeURIComponent(String(a.accession))
      const raw = asObj(await ctx.fetchJson(`${BIOSTUDIES}/studies/${acc}`))
      const info = asObj(await ctx.fetchJson(`${BIOSTUDIES}/studies/${acc}/info`))
      const files = [...iterFiles(asObj(raw.section))]
        .map(fileRecord)
        .sort((x, y) => String(x.path ?? '').localeCompare(String(y.path ?? '')))
      for (const rec of files)
        rec.download_url = rec.path
          ? `${BIOSTUDIES_FILES}/${acc}/${encodeURIComponent(String(rec.path)).replace(/%2F/g, '/')}`
          : null
      return {
        accession: raw.accno,
        n_files: files.length,
        files,
        info_reported_file_count: info.files,
        http_link: info.httpLink,
        ftp_link: info.ftpLink,
        rel_path: info.relPath
      }
    }
  },
  {
    id: 'arrayexpress_get_experiment_samples',
    connector: 'omics_archives',
    description:
      'Fetch per-sample SDRF annotation rows for an ArrayExpress experiment (MAGE-TAB headers verbatim, repeats suffixed #2/#3). Experiments with no SDRF return {"error":"no_sdrf"}.',
    input: {
      type: 'object',
      properties: {
        accession: { type: 'string', description: "e.g. 'E-MTAB-5061'" },
        max_rows_returned: { type: 'integer', default: 200 }
      },
      required: ['accession']
    },
    required: ['accession'],
    returns:
      '`{ "accession", "sdrf_file", "sdrf_size_bytes", "headers": [str], "n_samples": int, "samples": [ {header: value} ], "n_samples_returned": int, "rows_truncated": bool }` — `n_samples` is the true total; `samples` capped at `max_rows_returned` (default 200). No SDRF yields `{ "accession", "error": "no_sdrf", "n_samples": 0, "samples": [], ... }`.',
    example:
      'result = host.mcp("omics_archives", "arrayexpress_get_experiment_samples", {"accession": "E-MTAB-5061", "max_rows_returned": 200})',
    run: async (ctx, a) => {
      const accEnc = encodeURIComponent(String(a.accession))
      const maxRows = Number(a.max_rows_returned ?? 200)
      const raw = asObj(await ctx.fetchJson(`${BIOSTUDIES}/studies/${accEnc}`))
      const sdrfFiles = [...iterFiles(asObj(raw.section))]
        .filter((f) =>
          asArr(f.attributes).some((at) => {
            const ao = asObj(at)
            return ao.name === 'Type' && ao.value === 'SDRF File'
          })
        )
        .map(fileRecord)
      const base: Obj = {
        accession: raw.accno,
        n_samples: 0,
        samples: [] as Obj[],
        n_samples_returned: 0,
        rows_truncated: false
      }
      if (!sdrfFiles.length) return { ...base, error: 'no_sdrf' }
      const sdrf = sdrfFiles.sort((x, y) =>
        String(x.path ?? '').localeCompare(String(y.path ?? ''))
      )[0]
      const url = `${BIOSTUDIES_FILES}/${accEnc}/${encodeURIComponent(String(sdrf.path)).replace(/%2F/g, '/')}`
      const text = await ctx.fetchText(url)
      // Parse tab-delimited SDRF; disambiguate repeated headers with #2/#3 in document order.
      const lines = text.split(/\r?\n/).map((l) => l.split('\t'))
      const nonEmpty = lines.filter((r) => r.some((c) => c.trim() !== ''))
      if (!nonEmpty.length)
        return { ...base, sdrf_file: sdrf.path, sdrf_size_bytes: sdrf.size_bytes, headers: [] }
      const seen: Record<string, number> = {}
      const headers = nonEmpty[0].map((h) => {
        const t = h.trim()
        seen[t] = (seen[t] ?? 0) + 1
        return seen[t] === 1 ? t : `${t}#${seen[t]}`
      })
      const samples = nonEmpty.slice(1).map((row) => {
        if (row.length > headers.length)
          throw new Error(
            `SDRF row has ${row.length} fields but header has ${headers.length} — refusing to truncate`
          )
        const rec: Record<string, string> = {}
        headers.forEach((h, i) => {
          rec[h] = i < row.length ? row[i] : ''
        })
        return rec
      })
      const [rows, truncated] = cap(samples, maxRows)
      return {
        accession: raw.accno,
        sdrf_file: sdrf.path,
        sdrf_size_bytes: sdrf.size_bytes,
        headers,
        n_samples: samples.length,
        samples: rows,
        n_samples_returned: rows.length,
        rows_truncated: truncated
      }
    }
  },
  // ---- GEO (NCBI E-utilities) ----
  {
    id: 'geo_search_series',
    connector: 'omics_archives',
    description:
      'Search NCBI GEO DataSets (db=gds) and return series-level records (trimmed esummary docs). `term` is full E-utilities syntax; add gse[ETYP] to restrict to series.',
    input: {
      type: 'object',
      properties: {
        term: { type: 'string', description: "E-utilities query, e.g. 'asthma AND gse[ETYP]'" },
        retmax: { type: 'integer', default: 500 }
      },
      required: ['term']
    },
    required: ['term'],
    returns:
      '`{ "term": str, "count": int, "retrieved": int, "complete": bool, "records": [ { "accession", "title", "summary", "gdstype", "taxon", "n_samples", "pdat", "ftplink", "bioproject", "pubmedids", "samples": [{accession,title}], ... } ] }` — `count` is esearch\'s own total (may exceed `retrieved` when > retmax); records sorted by accession.',
    example:
      'result = host.mcp("omics_archives", "geo_search_series", {"term": "asthma AND gse[ETYP]", "retmax": 20})',
    run: async (ctx, a) => {
      const etiquette = ncbiEtiquette(ctx.credentials)
      const found = await esearchGds(ctx, String(a.term), Number(a.retmax ?? 500), etiquette)
      const docs = await esummaryGds(ctx, found.ids, etiquette)
      const records = Object.keys(docs)
        .sort()
        .map((acc) => trimEsummary(docs[acc]))
      return {
        term: a.term,
        count: found.count,
        retrieved: records.length,
        complete: found.count === records.length,
        records
      }
    }
  },
  {
    id: 'geo_get_series',
    connector: 'omics_archives',
    description:
      'Fetch structured metadata for GEO series (GSE accessions) with samples included — series title/summary/design, platforms, samples with characteristics and library info, and supplementary-file URLs. Data tables are never downloaded.',
    input: {
      type: 'object',
      properties: {
        accessions: {
          type: 'array',
          items: { type: 'string' },
          description: "GSE accessions, e.g. ['GSE131907']"
        }
      },
      required: ['accessions']
    },
    required: ['accessions'],
    returns:
      '`{ "n_requested": int, "records": [ { "accession", "title", "organism": [str], "series_type": [str], "status", "submission_date", "last_update_date", "summary", "overall_design", "pubmed_ids": [str], "platforms": [str], "n_samples": int, "samples": [ {accession,title,organism,characteristics:[{tag,value}],library_strategy,instrument_model,...} ], "supplementary_files": {series:[str],samples:{acc:[str]},ftp_root}, "esummary": {...} } ] }` — records ordered by accession.',
    example: 'result = host.mcp("omics_archives", "geo_get_series", {"accessions": ["GSE131907"]})',
    run: async (ctx, a) => {
      const etiquette = ncbiEtiquette(ctx.credentials)
      const accessions = asArr(a.accessions).map(String)
      const docs = await resolveGeoAccessions(ctx, accessions, etiquette)
      const records: Obj[] = []
      for (const acc of [...new Set(accessions)].sort())
        records.push(await fetchGeoSeries(ctx, acc, docs[acc]))
      return { n_requested: accessions.length, records }
    }
  },
  // ---- MetaboLights ----
  {
    id: 'metabolights_list_studies',
    connector: 'omics_archives',
    description:
      "List every public MetaboLights study accession (numerically sorted) with the API's own reported count. There is no server-side study search — filter fetched candidates by title/descriptor instead.",
    input: { type: 'object', properties: {} },
    returns:
      '`{ "accessions": [str], "count": int, "reported_count": int }` — full accession list (MTBLS1, MTBLS2, ...); `count` and `reported_count` should agree.',
    example: 'result = host.mcp("omics_archives", "metabolights_list_studies")',
    url: () => `${METABOLIGHTS}/studies`,
    parse: (raw) => {
      const payload = asObj(raw)
      const accessions = sortMtbls(
        asArr(payload.content)
          .map((v) => String(v))
          .filter((v) => v.trim())
      )
      return { accessions, count: accessions.length, reported_count: payload.studies }
    }
  },
  {
    id: 'metabolights_get_studies',
    connector: 'omics_archives',
    description:
      'Fetch structured metadata for MetaboLights studies (MTBLSxxx) from the parsed ISA payload — title, status, years, organisms, assays, factors, descriptors, sample count, protocols; optional per-sample table. Unknown/private accessions go in not_found.',
    input: {
      type: 'object',
      properties: {
        accessions: { type: 'array', items: { type: 'string' }, description: "e.g. ['MTBLS1']" },
        include_samples: { type: 'boolean', default: false },
        max_sample_rows_returned: { type: 'integer', default: 200 }
      },
      required: ['accessions']
    },
    required: ['accessions'],
    returns:
      '`{ "n_requested": int, "records": [ { "accession", "title", "description", "study_status", "release_year", "submission_year", "organisms": [{organism,organism_part}], "organism_names": [str], "assays": [{assay_number,measurement,technology,platform,filename}], "assay_count", "technologies": [str], "factors": [str], "descriptors": [str], "sample_count", "protocols": [{name,description}], "sample_table"? } ], "not_found": [str] }` — records sorted by numeric accession.',
    example:
      'result = host.mcp("omics_archives", "metabolights_get_studies", {"accessions": ["MTBLS1"], "include_samples": false})',
    run: async (ctx, a) => {
      const unique = sortMtbls(asArr(a.accessions).map(String))
      const includeSamples = Boolean(a.include_samples)
      const maxRows = Number(a.max_sample_rows_returned ?? 200)
      const records: Obj[] = []
      const notFound: string[] = []
      for (const acc of unique) {
        let payload: Obj
        try {
          payload = asObj(
            await ctx.fetchJson(`${METABOLIGHTS}/studies/public/study/${encodeURIComponent(acc)}`)
          )
        } catch (err) {
          if (isNotFound(err)) {
            notFound.push(acc)
            continue
          }
          throw err
        }
        const content = asObj(payload.content)
        const record = extractStudyMetadata(payload)
        record.protocols = metabolightsProtocols(content)
        if (includeSamples)
          record.sample_table = metabolightsSampleTable(asObj(content.sampleTable), maxRows)
        records.push(record)
      }
      return { n_requested: unique.length, records, not_found: notFound }
    }
  },
  {
    id: 'metabolights_get_study_files',
    connector: 'omics_archives',
    description:
      'Complete file inventory for a public MetaboLights study — the top-level study folder (ISA-Tab, MAF, folder entries) and, by default, the recursive FILES data folder.',
    input: {
      type: 'object',
      properties: {
        accession: { type: 'string', description: "e.g. 'MTBLS1'" },
        include_data_files: { type: 'boolean', default: true }
      },
      required: ['accession']
    },
    required: ['accession'],
    returns:
      '`{ "accession", "latest_version", "study_folder": [ {file,type,status,directory} ], "n_study_folder_entries": int, "metadata_files": [str], "data_files"?: [str], "n_data_files"?: int }` — sorted deterministically; volatile timestamps dropped.',
    example:
      'result = host.mcp("omics_archives", "metabolights_get_study_files", {"accession": "MTBLS1"})',
    run: async (ctx, a) => {
      const acc = String(a.accession).trim().toUpperCase()
      if (!MTBLS_RE.test(acc))
        throw new Error(`not a MetaboLights accession: ${JSON.stringify(acc)}`)
      const includeData = a.include_data_files !== false
      const payload = asObj(
        await ctx.fetchJson(
          `${METABOLIGHTS}/studies/${acc}/files?${qs({ include_raw_data: 'true' })}`
        )
      )
      const entries = asArr(payload.study)
        .map((e) => {
          const eo = asObj(e)
          return {
            file: eo.file,
            type: eo.type,
            status: eo.status,
            directory: Boolean(eo.directory)
          }
        })
        .sort(
          (x, y) =>
            Number(!x.directory) - Number(!y.directory) ||
            String(x.file ?? '').localeCompare(String(y.file ?? ''))
        )
      const record: Obj = {
        accession: acc,
        latest_version: payload.latest,
        study_folder: entries,
        n_study_folder_entries: entries.length,
        metadata_files: entries
          .filter((e) => String(e.type ?? '').startsWith('metadata'))
          .map((e) => e.file)
          .sort((x, y) => String(x ?? '').localeCompare(String(y ?? '')))
      }
      if (includeData) {
        const data = await searchMetabolightsDataFiles(ctx, acc, undefined)
        record.data_files = data.files
        record.n_data_files = data.n_files
      }
      return record
    }
  },
  {
    id: 'metabolights_search_data_files',
    connector: 'omics_archives',
    description:
      "Glob search over a MetaboLights study's raw-data folder (FILES tree). `pattern` is a filename glob (e.g. '*.mzML', '*.raw'); omit it to list every data file.",
    input: {
      type: 'object',
      properties: {
        accession: { type: 'string', description: "e.g. 'MTBLS1'" },
        pattern: { type: 'string', description: "filename glob, e.g. '*.mzML'" }
      },
      required: ['accession']
    },
    required: ['accession'],
    returns:
      '`{ "accession", "pattern": str|null, "file_match": true, "folder_match": false, "files": [str], "n_files": int }` — relative paths under the study folder (FILES/...), sorted.',
    example:
      'result = host.mcp("omics_archives", "metabolights_search_data_files", {"accession": "MTBLS1", "pattern": "*.zip"})',
    run: (ctx, a) => searchMetabolightsDataFiles(ctx, String(a.accession), cleanStr(a.pattern))
  },
  // ---- MGnify ----
  {
    id: 'mgnify_search_studies',
    connector: 'omics_archives',
    description:
      'Find MGnify metagenomics studies by free text OR biome lineage (provide exactly one). Full listing is paginated to completion and count-verified against the API.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "free text, e.g. 'coral'" },
        biome_lineage: {
          type: 'string',
          description:
            "GOLD-style lineage, e.g. 'root:Engineered:Wastewater' (includes sub-lineages)"
        }
      }
    },
    returns:
      '`{ "spec": {...}, "count": int, "pages_fetched": int, "records": [ { "accession", "secondary_accession", "bioproject", "study_name", "biome_lineages": [str], "samples_count", "centre_name", "data_origination", "is_private", "last_update" } ] }` — `count == records.length` (verified); records sorted by MGYS accession.',
    example: 'result = host.mcp("omics_archives", "mgnify_search_studies", {"query": "coral"})',
    run: async (ctx, a) => {
      const query = cleanStr(a.query)
      const biome = cleanStr(a.biome_lineage)
      if ((query === undefined) === (biome === undefined))
        throw new Error("provide exactly one of 'query' or 'biome_lineage'")
      const spec: Obj =
        query !== undefined ? { type: 'search', query } : { type: 'biome', lineage: biome }
      const res =
        query !== undefined
          ? await mgnifyGetAll(ctx, 'studies', { search: query })
          : await mgnifyGetAll(
              ctx,
              `biomes/${encodeURIComponent(String(biome)).replace(/%3A/g, ':')}/studies`,
              {}
            )
      const records = res.records
        .map(flattenMgnifyStudy)
        .sort((x, y) => String(x.accession).localeCompare(String(y.accession)))
      return { spec, count: res.count, pages_fetched: res.pages_fetched, records }
    }
  },
  {
    id: 'mgnify_get_studies',
    connector: 'omics_archives',
    description:
      'Fetch structured records for MGnify studies (MGYS accessions). With include_analyses, each study also carries its complete analyses listing plus by-pipeline/by-experiment breakdowns. Unknown accessions go in missing.',
    input: {
      type: 'object',
      properties: {
        accessions: {
          type: 'array',
          items: { type: 'string' },
          description: "e.g. ['MGYS00000410']"
        },
        include_analyses: { type: 'boolean', default: false }
      },
      required: ['accessions']
    },
    required: ['accessions'],
    returns:
      '`{ "studies": [ { "accession", "secondary_accession", "bioproject", "study_name", "biome_lineages": [str], "samples_count", "centre_name", "data_origination", "is_private", "last_update", "analyses_total"?, "analyses_by_pipeline_version"?, "analyses_by_experiment_type"? } ], "missing": [str], "analyses"?: {acc: [record]} }` — studies sorted by accession.',
    example:
      'result = host.mcp("omics_archives", "mgnify_get_studies", {"accessions": ["MGYS00000410"], "include_analyses": false})',
    run: async (ctx, a) => {
      const includeAnalyses = Boolean(a.include_analyses)
      const unique = [...new Set(asArr(a.accessions).map(String))].sort()
      const studies: Obj[] = []
      const analyses: Record<string, Obj[]> = {}
      const missing: string[] = []
      for (const acc of unique) {
        let doc: Obj
        try {
          doc = asObj(await ctx.fetchJson(`${MGNIFY}/studies/${encodeURIComponent(acc)}`))
        } catch (err) {
          if (isNotFound(err)) {
            missing.push(acc)
            continue
          }
          throw err
        }
        const rec = flattenMgnifyStudy(asObj(doc.data))
        if (includeAnalyses) {
          const ana = await fetchStudyAnalyses(ctx, acc)
          rec.analyses_total = ana.analyses_count
          const breakdown = countBreakdowns(ana.analyses as Obj[])
          rec.analyses_by_pipeline_version = breakdown.by_pipeline_version
          rec.analyses_by_experiment_type = breakdown.by_experiment_type
          analyses[acc] = ana.analyses as Obj[]
        }
        studies.push(rec)
      }
      const out: Obj = { studies, missing: missing.sort() }
      if (includeAnalyses) out.analyses = analyses
      return out
    }
  },
  {
    id: 'mgnify_get_study_analyses',
    connector: 'omics_archives',
    description:
      'List ALL analyses of one MGnify study (complete, count-verified pagination) — one record per MGYA analysis with pipeline version, experiment type, status, and run/assembly/sample accessions.',
    input: {
      type: 'object',
      properties: {
        accession: { type: 'string', description: "MGYS accession, e.g. 'MGYS00000410'" }
      },
      required: ['accession']
    },
    required: ['accession'],
    returns:
      '`{ "study_accession", "analyses_count": int, "analyses": [ { "analysis_accession", "study_accession", "pipeline_version", "experiment_type", "analysis_status", "run_accession", "assembly_accession", "sample_accession", "instrument_platform" } ] }` — `analyses_count` is the API total (retrieval verified against it); sorted by MGYA accession.',
    example:
      'result = host.mcp("omics_archives", "mgnify_get_study_analyses", {"accession": "MGYS00000410"})',
    run: (ctx, a) => fetchStudyAnalyses(ctx, String(a.accession))
  },
  // ---- PRIDE ----
  {
    id: 'pride_search_projects',
    connector: 'omics_archives',
    description:
      'Search PRIDE Archive proteomics projects (complete, api_total-verified retrieval); filters (keyword, organism, instrument, disease, extra_filters) combine with AND. Sorted by accession ASC — a bounded walk is a stable prefix.',
    input: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: "free text, e.g. 'phosphoproteome'" },
        organism: { type: 'string', description: "exact PRIDE facet, e.g. 'Homo sapiens (human)'" },
        instrument: {
          type: 'string',
          description: "exact PRIDE facet, e.g. 'Orbitrap Fusion Lumos'"
        },
        disease: { type: 'string', description: "exact PRIDE facet, e.g. 'Covid-19'" },
        extra_filters: { type: 'object', additionalProperties: { type: 'string' } },
        max_records_returned: { type: 'integer', default: 50 }
      }
    },
    returns:
      '`{ "spec": {...}, "filter": str|null, "api_total": int, "complete": bool, "pages_fetched": int, "n_records_returned": int, "records_truncated": bool, "records": [ { "accession", "title", "organisms": [str], "diseases": [str], "instruments": [str], "experiment_types": [str], "quantification_methods": [str], "submission_date", "publication_date", "submitters": [str], "lab_pis": [str], "references": [{pubmed_id,doi,reference_line}], ... } ] }` — `api_total` is the true count; `records` capped at `max_records_returned` (default 50) with `records_truncated`.',
    example:
      'result = host.mcp("omics_archives", "pride_search_projects", {"keyword": "phosphoproteome", "organism": "Homo sapiens (human)", "max_records_returned": 50})',
    run: async (ctx, a) => {
      const spec: Obj = {}
      for (const k of ['keyword', 'organism', 'instrument', 'disease'] as const) {
        const v = cleanStr(a[k])
        if (v) spec[k] = v
      }
      const extra = asObj(a.extra_filters)
      if (Object.keys(extra).length) spec.extra_filters = extra
      const maxRecords = Number(a.max_records_returned ?? 50)
      const maxPages = Math.max(1, Math.ceil(maxRecords / PRIDE_PAGE_SIZE))
      const result = await prideSearch(ctx, spec, maxPages)
      const [records, capped] = cap(result.records as Obj[], maxRecords)
      result.records = records
      result.n_records_returned = records.length
      result.records_truncated = capped || !result.complete
      return result
    }
  },
  {
    id: 'pride_get_projects',
    connector: 'omics_archives',
    description:
      'Fetch full metadata for PRIDE projects by accession (e.g. PXD010154) — the same normalized record shape as pride_search_projects, so the two are directly comparable. Unknown accessions go in not_found.',
    input: {
      type: 'object',
      properties: {
        accessions: { type: 'array', items: { type: 'string' }, description: "e.g. ['PXD010154']" }
      },
      required: ['accessions']
    },
    required: ['accessions'],
    returns:
      '`{ "n_requested": int, "records": [ { "accession", "title", "organisms": [str], "organism_parts": [str], "diseases": [str], "instruments": [str], "experiment_types": [str], "quantification_methods": [str], "keywords": [str], "submission_date", "publication_date", "submitters": [str], "lab_pis": [str], "references": [{pubmed_id,doi,reference_line}], "source": "detail" } ], "not_found": [str] }` — records sorted by accession.',
    example:
      'result = host.mcp("omics_archives", "pride_get_projects", {"accessions": ["PXD010154"]})',
    run: async (ctx, a) => {
      const unique = [
        ...new Set(
          asArr(a.accessions)
            .map(String)
            .map((s) => s.trim())
            .filter(Boolean)
        )
      ].sort()
      const records: Obj[] = []
      const notFound: string[] = []
      for (const acc of unique) {
        try {
          records.push(
            normalizePrideDetail(
              asObj(await ctx.fetchJson(`${PRIDE}/projects/${encodeURIComponent(acc)}`))
            )
          )
        } catch (err) {
          if (isNotFound(err)) {
            notFound.push(acc)
            continue
          }
          throw err
        }
      }
      return { n_requested: records.length + notFound.length, records, not_found: notFound }
    }
  },
  {
    id: 'pride_search_project_proteins',
    connector: 'omics_archives',
    description:
      'List protein evidence rows for one PRIDE affinity-proteomics project (paged to exhaustion). NOTE: only affinity-proteomics projects are served here; for classic MS (PXD) projects use pride_find_projects_for_protein instead.',
    input: {
      type: 'object',
      properties: {
        project_accession: { type: 'string', description: 'PRIDE project accession' },
        keyword: {
          type: 'string',
          description: 'server-side filter (accession, gene, or protein name)'
        }
      },
      required: ['project_accession']
    },
    required: ['project_accession'],
    returns:
      '`{ "project_accession", "keyword": str|null, "n_proteins": int, "proteins": [ { "protein_accession", "protein_name", "gene", "project_count" } ] }` — sorted by protein accession; empty for MS-only projects.',
    example:
      'result = host.mcp("omics_archives", "pride_search_project_proteins", {"project_accession": "PXD010154"})',
    run: async (ctx, a) => {
      const projectAccession = String(a.project_accession)
      const keyword = cleanStr(a.keyword)
      const proteins: Obj[] = []
      let page = 0
      for (;;) {
        const rows = asArr(
          await ctx.fetchJson(
            `${PRIDE}/pride-ap/search/proteins?${qs({ projectAccession, pageSize: PRIDE_PAGE_SIZE, page, keyword })}`
          )
        )
        if (!rows.length) break
        for (const row of rows) {
          const ro = asObj(row)
          proteins.push({
            protein_accession: ro.proteinAccession,
            protein_name: ro.proteinName,
            gene: ro.gene,
            project_count: ro.projectCount
          })
        }
        if (rows.length < PRIDE_PAGE_SIZE) break
        page += 1
      }
      proteins.sort((x, y) =>
        String(x.protein_accession ?? '').localeCompare(String(y.protein_accession ?? ''))
      )
      return {
        project_accession: projectAccession,
        keyword: keyword ?? null,
        n_proteins: proteins.length,
        proteins
      }
    }
  },
  {
    id: 'pride_find_projects_for_protein',
    connector: 'omics_archives',
    description:
      'Find PRIDE projects containing a protein (MS-archive direction). `protein_accession` is a UniProt accession (e.g. P04637). Feed the returned project accessions to pride_get_projects for full metadata.',
    input: {
      type: 'object',
      properties: {
        protein_accession: { type: 'string', description: "UniProt accession, e.g. 'P04637'" }
      },
      required: ['protein_accession']
    },
    required: ['protein_accession'],
    returns:
      '`{ "query_accession", "n_records": int, "records": [ { "protein_accession", "n_projects": int, "projects": [str] } ] }` — project lists sorted.',
    example:
      'result = host.mcp("omics_archives", "pride_find_projects_for_protein", {"protein_accession": "P04637"})',
    run: async (ctx, a) => {
      const proteinAccession = String(a.protein_accession)
      const rows = asArr(
        await ctx.fetchJson(`${PRIDE}/proteins/search?${qs({ accession: proteinAccession })}`)
      )
      const records = rows
        .map((r) => {
          const ro = asObj(r)
          const projects = asArr(ro.projects).map(String).sort()
          return { protein_accession: ro.proteinAccession, n_projects: projects.length, projects }
        })
        .sort((x, y) =>
          String(x.protein_accession ?? '').localeCompare(String(y.protein_accession ?? ''))
        )
      return { query_accession: proteinAccession, n_records: records.length, records }
    }
  }
]

// Shared MetaboLights data-file glob search (used by both the standalone tool and get_study_files).
async function searchMetabolightsDataFiles(
  ctx: ToolContext,
  accession: string,
  pattern: string | undefined
): Promise<{
  accession: string
  pattern: string | null
  file_match: boolean
  folder_match: boolean
  files: string[]
  n_files: number
}> {
  const acc = accession.trim().toUpperCase()
  if (!MTBLS_RE.test(acc)) throw new Error(`not a MetaboLights accession: ${JSON.stringify(acc)}`)
  const payload = asObj(
    await ctx.fetchJson(
      `${METABOLIGHTS}/studies/${acc}/public-data-files?${qs({
        file_match: 'true',
        folder_match: 'false',
        search_pattern: pattern
      })}`
    )
  )
  const files = asArr(payload.files)
    .map((e) => str(asObj(e).name))
    .filter((n): n is string => Boolean(n))
    .sort()
  // Re-verify the server-side glob client-side so a semantics change surfaces loudly.
  if (pattern !== undefined) {
    const re = globToRegExp(pattern)
    const mismatched = files.filter((n) => !re.test(n.split('/').pop() as string))
    if (mismatched.length)
      throw new Error(
        `server returned ${mismatched.length} entries not matching pattern ${JSON.stringify(pattern)} (first: ${JSON.stringify(mismatched[0])})`
      )
  }
  return {
    accession: acc,
    pattern: pattern ?? null,
    file_match: true,
    folder_match: false,
    files,
    n_files: files.length
  }
}
