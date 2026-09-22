import { ncbiEtiquette } from './ncbi'
import type { ToolDescriptor } from '../types'

// Two NCBI hosts (mirrors the upstream dbsnp_records client): Variation Services for the canonical
// RefSNP JSON (no E-utils key needed), and E-utilities esearch db=snp for the positional region index.
const VARIATION_BASE = 'https://api.ncbi.nlm.nih.gov/variation/v0'
const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'

const MAX_BATCH_RSIDS = 20
const MAX_REGION_RSIDS = 1000
const DEFAULT_REGION_RSIDS = 200
const MAX_REGION_SPAN = 1_000_000
const MAX_CITATIONS = 20
// Wall-clock budget for a batch (one Variation Services request per rsID); rsIDs not reached in time
// come back in not_processed rather than blowing the MCP transport budget (upstream deadline_s=40).
const DEADLINE_MS = 40_000

// NCBI E-utilities usage policy makes a contact email mandatory. Absent -> the upstream
// structured contact_email_required result (never thrown), so the message reaches the agent cleanly.
const CONTACT_REQUIRED_MESSAGE =
  'This tool talks to NCBI E-utilities, which require a contact email per their usage policy. ' +
  "Enable 'Share contact email with research data services' in Settings → Privacy to provide one."

type ContactRequired = { error: 'contact_email_required'; message: string }
const contactRequired = (): ContactRequired => ({
  error: 'contact_email_required',
  message: CONTACT_REQUIRED_MESSAGE
})

// RefSeq chromosome accession prefix -> chromosome name (NC_000001..NC_000022, X, Y, MT).
const NC_CHROM: Record<string, string> = (() => {
  const m: Record<string, string> = {}
  for (let n = 1; n <= 22; n++) m[`NC_${String(n).padStart(6, '0')}`] = String(n)
  m['NC_000023'] = 'X'
  m['NC_000024'] = 'Y'
  m['NC_012920'] = 'MT'
  return m
})()

const chromOf = (seqId: string | undefined): string | null =>
  NC_CHROM[(seqId ?? '').split('.')[0]] ?? null

const CHROMS = new Set([...Array.from({ length: 22 }, (_, i) => String(i + 1)), 'X', 'Y', 'MT'])

// ---- minimal shapes of the RefSNP Variation Services JSON we read ---------------------------

type Spdi = {
  seq_id?: string
  position?: number
  deleted_sequence?: string
  inserted_sequence?: string
}
type AlleleEntry = { allele?: { spdi?: Spdi }; hgvs?: string }
type SeqIdTrait = { is_chromosome?: boolean; assembly_name?: string }
type PlacementWithAllele = {
  seq_id?: string
  is_ptlp?: boolean
  placement_annot?: { seq_id_traits_by_assembly?: SeqIdTrait[] }
  alleles?: AlleleEntry[]
}
type FrequencyEntry = {
  study_name?: string
  study_version?: number
  allele_count?: number
  total_count?: number
}
type ClinicalEntry = {
  accession_version?: string
  clinical_significances?: string[]
  review_status?: string
  last_evaluated_date?: string
  disease_names?: string[]
}
type SequenceOntology = { name?: string }
type ProteinInfo = { sequence_ontology?: SequenceOntology[]; variant?: { spdi?: Spdi } }
type RnaInfo = {
  id?: string
  hgvs?: string
  sequence_ontology?: SequenceOntology[]
  protein?: ProteinInfo
}
type GeneInfo = {
  locus?: string
  id?: number | string
  name?: string
  orientation?: string
  rnas?: RnaInfo[]
}
type AlleleAnnotation = {
  frequency?: FrequencyEntry[]
  clinical?: ClinicalEntry[]
  assembly_annotation?: { genes?: GeneInfo[] }[]
}
type PrimarySnapshotData = {
  placements_with_allele?: PlacementWithAllele[]
  allele_annotations?: AlleleAnnotation[]
  variant_type?: string
}
type RefSnpPayload = {
  refsnp_id?: string | number
  create_date?: string
  last_update_date?: string
  last_update_build_id?: number | string
  citations?: (string | number)[]
  merged_snapshot_data?: { merged_into?: (string | number)[] }
  primary_snapshot_data?: PrimarySnapshotData
  mane_select_ids?: string[]
}

// ---- lean record shapes emitted to the notebook ---------------------------------------------

type Placement = {
  assembly: string
  assembly_full: string
  seq_id: string | undefined
  chrom: string | null
  position: number
  ref: string | undefined
  alts: string[]
  is_primary: boolean
}
type FrequencyRow = {
  study: string | undefined
  study_version: number | undefined
  allele_count: number | undefined
  total_count: number | undefined
  af: number | null
}
type ClinvarRow = {
  rcv_accession: string | undefined
  clinical_significances: string[]
  review_status: string | undefined
  last_evaluated_date: string | undefined
  disease_names: string[]
}
type ManeSelect = { transcript_hgvs: string | undefined; protein_spdi: string | null }
type GeneRow = {
  symbol: string | undefined
  gene_id: number | string | undefined
  name: string | undefined
  orientation: string | undefined
  consequences: string[]
  mane_select: ManeSelect[]
}
type AlleleRow = {
  allele: string | undefined
  ref: string | undefined
  spdi: string
  hgvs: string | undefined
  frequencies: FrequencyRow[]
  clinvar: ClinvarRow[]
  genes: GeneRow[]
}
type RefSnpRecord = {
  rsid: string
  create_date: string | undefined
  last_update_date: string | undefined
  last_update_build_id: number | string | undefined
  n_citations: number
  citations_pmids: (string | number)[]
  citations_truncated: boolean
  status: 'live' | 'merged' | 'no_data'
  merged_into?: string[]
  variant_type?: string
  mane_select_ids?: string[]
  placements?: Placement[]
  alleles?: AlleleRow[]
}

// ---- distillation (ported from dbsnp_records/records.py) -------------------------------------

const spdiStr = (s: Spdi): string =>
  `${s.seq_id}:${s.position}:${s.deleted_sequence}:${s.inserted_sequence}`

// Top-level chromosome placements (GRCh38 + GRCh37), 1-based; GRCh38/primary sorted first.
function assemblyPlacements(psd: PrimarySnapshotData): Placement[] {
  const out: Placement[] = []
  for (const p of psd.placements_with_allele ?? []) {
    const traits = p.placement_annot?.seq_id_traits_by_assembly ?? []
    if (!traits.length || !traits[0].is_chromosome) continue
    const assemblyFull = traits[0].assembly_name ?? ''
    const spdis = (p.alleles ?? []).map((a) => a.allele?.spdi).filter((s): s is Spdi => Boolean(s))
    if (!spdis.length) continue
    const ref = spdis[0].deleted_sequence
    const alts = [
      ...new Set(
        spdis
          .filter((s) => s.inserted_sequence !== s.deleted_sequence)
          .map((s) => s.inserted_sequence)
          // Empty inserted sequences represent deletions, not missing alleles.
          .filter((x): x is string => typeof x === 'string')
      )
    ].sort()
    out.push({
      assembly: assemblyFull.split('.')[0] || assemblyFull,
      assembly_full: assemblyFull,
      seq_id: p.seq_id,
      chrom: chromOf(p.seq_id),
      position: (spdis[0].position ?? -1) + 1, // SPDI is 0-based
      ref,
      alts,
      is_primary: Boolean(p.is_ptlp)
    })
  }
  out.sort(
    (a, b) => Number(b.is_primary) - Number(a.is_primary) || a.assembly.localeCompare(b.assembly)
  )
  return out
}

// Per-study allele frequencies for one alt allele, deduped by (study, version); af = ac/tc.
function frequencies(annotation: AlleleAnnotation): FrequencyRow[] {
  const rows: FrequencyRow[] = []
  const seen = new Set<string>()
  for (const f of annotation.frequency ?? []) {
    const key = `${f.study_name}\u0000${f.study_version}`
    if (seen.has(key)) continue
    seen.add(key)
    const ac = f.allele_count
    const tc = f.total_count
    rows.push({
      study: f.study_name,
      study_version: f.study_version,
      allele_count: ac,
      total_count: tc,
      af: ac != null && tc ? Math.round((ac / tc) * 1e6) / 1e6 : null
    })
  }
  rows.sort(
    (a, b) =>
      (a.study ?? '').localeCompare(b.study ?? '') ||
      (a.study_version ?? 0) - (b.study_version ?? 0)
  )
  return rows
}

function clinvarXrefs(annotation: AlleleAnnotation): ClinvarRow[] {
  const rows: ClinvarRow[] = (annotation.clinical ?? []).map((c) => ({
    rcv_accession: c.accession_version,
    clinical_significances: c.clinical_significances ?? [],
    review_status: c.review_status,
    last_evaluated_date: c.last_evaluated_date,
    disease_names: c.disease_names ?? []
  }))
  rows.sort((a, b) => (a.rcv_accession ?? '').localeCompare(b.rcv_accession ?? ''))
  return rows
}

// Gene context from the assembly annotation: symbol, id, orientation, union of SO terms, MANE Select.
function genes(annotation: AlleleAnnotation, maneIds: Set<string>): GeneRow[] {
  const out: GeneRow[] = []
  for (const asm of annotation.assembly_annotation ?? []) {
    for (const g of asm.genes ?? []) {
      const consequences = new Set<string>()
      const mane: ManeSelect[] = []
      for (const rna of g.rnas ?? []) {
        for (const so of rna.sequence_ontology ?? []) if (so.name) consequences.add(so.name)
        const protein = rna.protein ?? {}
        for (const so of protein.sequence_ontology ?? []) if (so.name) consequences.add(so.name)
        if (rna.id && maneIds.has(rna.id)) {
          const pv = protein.variant?.spdi
          mane.push({
            transcript_hgvs: rna.hgvs,
            protein_spdi: pv ? spdiStr(pv) : null
          })
        }
      }
      out.push({
        symbol: g.locus,
        gene_id: g.id,
        name: g.name,
        orientation: g.orientation,
        consequences: [...consequences].sort(),
        mane_select: mane
      })
    }
  }
  out.sort((a, b) => (a.symbol ?? '').localeCompare(b.symbol ?? ''))
  return out
}

// Full RefSNP JSON -> lean record. status: live (primary_snapshot_data), merged (follow merged_into),
// or no_data (withdrawn/unsupported). Alleles emitted per alt with SPDI/HGVS/frequencies/clinvar/genes.
function distillRefsnp(payload: RefSnpPayload): RefSnpRecord {
  const citations = payload.citations ?? []
  const base = {
    rsid: `rs${payload.refsnp_id}`,
    create_date: payload.create_date,
    last_update_date: payload.last_update_date,
    last_update_build_id: payload.last_update_build_id,
    n_citations: citations.length,
    citations_pmids: citations.slice(0, MAX_CITATIONS),
    citations_truncated: citations.length > MAX_CITATIONS
  }
  const mergedInto = payload.merged_snapshot_data?.merged_into
  if (mergedInto && mergedInto.length) {
    return { ...base, status: 'merged', merged_into: mergedInto.map((m) => `rs${m}`) }
  }
  const psd = payload.primary_snapshot_data
  if (!psd) return { ...base, status: 'no_data' }

  const placements = assemblyPlacements(psd)
  const maneIds = new Set(payload.mane_select_ids ?? [])
  const primary = (psd.placements_with_allele ?? []).find((p) => p.is_ptlp)
  const alleles: AlleleRow[] = []
  if (primary) {
    const annotations = psd.allele_annotations ?? []
    ;(primary.alleles ?? []).forEach((entry, i) => {
      const spdi = entry.allele?.spdi
      // Skip the reference-allele row (deleted == inserted, or no SPDI).
      if (!spdi || spdi.deleted_sequence === spdi.inserted_sequence) return
      const annotation = annotations[i] ?? {}
      alleles.push({
        allele: spdi.inserted_sequence,
        ref: spdi.deleted_sequence,
        spdi: spdiStr(spdi),
        hgvs: entry.hgvs,
        frequencies: frequencies(annotation),
        clinvar: clinvarXrefs(annotation),
        genes: genes(annotation, maneIds)
      })
    })
  }
  return {
    ...base,
    status: 'live',
    variant_type: psd.variant_type,
    mane_select_ids: [...maneIds].sort(),
    placements,
    alleles
  }
}

// ---- request helpers ------------------------------------------------------------------------

// True when the ParserEngine surfaced an upstream HTTP 404 (unknown rs number). The engine has no
// status accessor, so the 404 status is read back from its thrown message.
const isNotFound = (err: unknown): boolean =>
  err instanceof Error && /\bHTTP 404\b/.test(err.message)

// rs<digits> (case-insensitive) -> the bare number; null when the token is not a valid rsID.
const rsNumber = (rsid: string): string | null => {
  const m = /^rs(\d+)$/i.exec(rsid.trim())
  return m ? m[1] : null
}

// ---- the 2 tools ----------------------------------------------------------------------------

export const VARIANTS_DBSNP_TOOLS: ToolDescriptor[] = [
  {
    id: 'dbsnp_get_rsids',
    connector: 'variants',
    description:
      "Canonical dbSNP RefSNP records for a batch of rsIDs: GRCh38+GRCh37 placements, alleles, gene context, per-study allele frequencies, and ClinVar cross-references. Requires a contact email (Settings → Privacy → 'Share contact email with research data services') per NCBI E-utilities usage policy; without one the tool returns {error: 'contact_email_required', message}. Args: rsids (up to 20 rs<digits>, case-insensitive) — each costs one paced NCBI Variation Services request, so large batches take ~1 s per rsID. Returns {n_requested, records, not_found (rs numbers dbSNP doesn't know), not_processed (rsIDs skipped when the wall-clock budget ran out — re-request just those)}. Each record: {rsid, status, create_date, last_update_date, last_update_build_id, n_citations, citations_pmids (capped at 20; citations_truncated flags the cap), variant_type, mane_select_ids, placements, alleles}. status is 'live', 'merged' (record instead carries merged_into — re-query those rsIDs) or 'no_data' (withdrawn/unsupported). placements give 1-based chromosome coordinates with ref/alts per assembly (GRCh38 first, is_primary true); an empty string in alts denotes a deletion allele. Each alt-allele entry: {allele, ref, spdi (0-based interbase), hgvs, frequencies: [{study, study_version, allele_count, total_count, af}] (ALFA, 1000Genomes, TOPMED, gnomAD...), clinvar: [{rcv_accession, clinical_significances, review_status, last_evaluated_date, disease_names}], genes: [{symbol, gene_id, name, orientation, consequences (SO terms), mane_select: [{transcript_hgvs, protein_spdi}]}]}.",
    input: {
      type: 'object',
      properties: {
        rsids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to 20 rsIDs (rs<digits>, case-insensitive), e.g. ["rs7412", "rs429358"].'
        }
      },
      required: ['rsids']
    },
    required: ['rsids'],
    returns:
      "`{ n_requested: int, records: [ { rsid, status ('live'|'merged'|'no_data'), create_date, last_update_date, last_update_build_id, n_citations, citations_pmids, citations_truncated, merged_into?, variant_type?, mane_select_ids?, placements?: [{assembly, assembly_full, seq_id, chrom, position, ref, alts, is_primary}], alleles?: [{allele, ref, spdi, hgvs, frequencies, clinvar, genes}] } ], not_found: [str], not_processed: [str] }` — not_found are rs numbers dbSNP doesn't know; not_processed are rsIDs skipped when the time budget ran out. Empty/blank input yields all-empty lists (never an error).",
    example:
      'const result = await host.mcp("variants", "dbsnp_get_rsids", {"rsids": ["rs7412", "rs429358"]})',
    run: async (ctx, a) => {
      if (!ctx.credentials.ncbiEmail) return contactRequired()
      const q = ncbiEtiquette(ctx.credentials)
      // Variation Services host takes no E-utils params; carry the email as a query string all the same.
      const suffix = q ? `?${q.slice(1)}` : ''

      const raw = Array.isArray(a.rsids) ? a.rsids : [a.rsids]
      // De-dupe preserving order, drop blanks.
      const cleaned = [...new Set(raw.map((r) => String(r).trim()).filter(Boolean))]
      if (!cleaned.length) return { n_requested: 0, records: [], not_found: [], not_processed: [] }
      if (cleaned.length > MAX_BATCH_RSIDS) {
        throw new Error(`too many rsIDs (${cleaned.length}); max ${MAX_BATCH_RSIDS} per call`)
      }
      // Validate every token first (upstream contract) so a typo fails fast instead of mid-batch.
      const numbers = cleaned.map((r) => {
        const n = rsNumber(r)
        if (n == null) throw new Error(`not an rsID: '${r}' (expected e.g. rs7412)`)
        return n
      })

      const t0 = Date.now()
      const records: RefSnpRecord[] = []
      const notFound: string[] = []
      const notProcessed: string[] = []
      for (let i = 0; i < numbers.length; i++) {
        if (Date.now() - t0 > DEADLINE_MS) {
          notProcessed.push(...numbers.slice(i).map((n) => `rs${n}`))
          break
        }
        const num = numbers[i]
        try {
          const payload = (await ctx.fetchJson(
            `${VARIATION_BASE}/refsnp/${num}${suffix}`
          )) as RefSnpPayload
          records.push(distillRefsnp(payload))
        } catch (err) {
          if (isNotFound(err)) notFound.push(`rs${num}`)
          else throw err
        }
      }
      return {
        n_requested: cleaned.length,
        records,
        not_found: notFound,
        not_processed: notProcessed
      }
    }
  },
  {
    id: 'dbsnp_search_by_region',
    connector: 'variants',
    description:
      "List dbSNP rsIDs in a genomic window (esearch db=snp positional index — NCBI Variation Services has no region endpoint). Requires a contact email (Settings → Privacy → 'Share contact email with research data services') per NCBI E-utilities usage policy; without one the tool returns {error: 'contact_email_required', message}. Args: chrom (1-22, X, Y or MT; 'chr' prefix tolerated), start (1-based inclusive), stop (inclusive; span capped at 1 Mb — split larger regions into consecutive windows; dense regions hold many thousands of rsIDs per kb, so keep windows small or raise max_rsids), assembly (which positional index — 'GRCh38' default -> [CPOS], or 'GRCh37' -> [CPOS_GRCH37]; coordinates must be on the chosen assembly), max_rsids (listing cap 1-1000, default 200). Returns {chrom, start, stop, assembly, term (the exact Entrez query used), total (the API's own count), n_returned, truncated, rsids}. truncated is true when total > n_returned — the list is then a prefix in Entrez default order (descending rs number), never a silent truncation. Feed rsIDs (<= 20 at a time) to dbsnp_get_rsids for full records.",
    input: {
      type: 'object',
      properties: {
        chrom: {
          type: 'string',
          description: "Chromosome 1-22, X, Y or MT ('chr' prefix tolerated)."
        },
        start: { type: 'integer', description: 'Window start, 1-based inclusive.' },
        stop: { type: 'integer', description: 'Window end, inclusive; span capped at 1 Mb.' },
        assembly: { type: 'string', enum: ['GRCh38', 'GRCh37'], default: 'GRCh38' },
        max_rsids: { type: 'integer', default: 200 }
      },
      required: ['chrom', 'start', 'stop']
    },
    required: ['chrom', 'start', 'stop'],
    returns:
      "`{ chrom: str, start: int, stop: int, assembly: str, term: str, total: int, n_returned: int, truncated: bool, rsids: [str] }` — total is esearch's own match count; truncated is true when total > n_returned (rsids is then a capped prefix in descending-rs-number order).",
    example:
      'const result = await host.mcp("variants", "dbsnp_search_by_region", {"chrom": "19", "start": 44905000, "stop": 44910000, "assembly": "GRCh38"})',
    run: async (ctx, a) => {
      if (!ctx.credentials.ncbiEmail) return contactRequired()

      const chrom = String(a.chrom).trim().toUpperCase().replace(/^CHR/, '')
      if (!CHROMS.has(chrom)) throw new Error(`bad chromosome '${chrom}' (1-22, X, Y, MT)`)
      const start = Number(a.start)
      const stop = Number(a.stop)
      if (!(start > 0 && start <= stop)) throw new Error('need 0 < start <= stop')
      if (stop - start > MAX_REGION_SPAN) {
        throw new Error(
          `region span ${stop - start} bp exceeds ${MAX_REGION_SPAN} bp — split into windows`
        )
      }
      const assembly = String(a.assembly ?? 'GRCh38')
      const field = { GRCH38: 'CPOS', GRCH37: 'CPOS_GRCH37' }[assembly.toUpperCase()]
      if (!field) throw new Error(`assembly must be GRCh38 or GRCh37, got '${assembly}'`)
      const maxRsids = Math.max(
        1,
        Math.min(
          Math.trunc(Number(a.max_rsids ?? DEFAULT_REGION_RSIDS) || DEFAULT_REGION_RSIDS),
          MAX_REGION_RSIDS
        )
      )

      const term = `${chrom}[CHR] AND ${start}:${stop}[${field}] AND homo sapiens[ORGN]`
      const q = ncbiEtiquette(ctx.credentials)
      const es = (await ctx.fetchJson(
        `${EUTILS}/esearch.fcgi?db=snp&retmode=json&retmax=${maxRsids}&term=${encodeURIComponent(term)}${q}`
      )) as { esearchresult?: { count?: string; idlist?: string[]; ERROR?: string } }
      const result = es.esearchresult
      if (result?.ERROR) throw new Error(`esearch error: ${result.ERROR}`)
      const total = Number(result?.count ?? 0)
      const rsids = (result?.idlist ?? []).map((u) => `rs${u}`)
      return {
        chrom,
        start,
        stop,
        assembly: field === 'CPOS_GRCH37' ? 'GRCh37' : 'GRCh38',
        term,
        total,
        n_returned: rsids.length,
        truncated: total > rsids.length,
        rsids
      }
    }
  }
]
