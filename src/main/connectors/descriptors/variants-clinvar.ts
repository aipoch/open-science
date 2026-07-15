import { ncbiEtiquette } from '../engine'
import type { ToolContext, ToolDescriptor } from '../types'

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'

// These direct-ClinVar tools mandate a contact email (NCBI E-utilities usage policy) — unlike the
// gnomAD/CADD tools, a missing email is a structured result, not a silent keyless call.
const MAX_RETMAX = 200
const MAX_BATCH_ACCESSIONS = 50
// Wall-clock budget for RCV resolution (each RCV costs one esearch). Inputs left unresolved when the
// budget runs out land in not_processed rather than blowing the MCP transport limit.
const RCV_DEADLINE_MS = 40_000

const VCV_RE = /^VCV(\d+)(?:\.\d+)?$/i
const RCV_RE = /^RCV\d+(?:\.\d+)?$/i
const RSID_RE = /^rs\d+$/i

// Structured "contact email required" result (mirrors the upstream _contact_required_result). Run()
// returns this instead of throwing so the message reaches the agent as a clean tool result.
type ContactRequired = { error: 'contact_email_required'; message: string }
function contactRequired(): ContactRequired {
  return {
    error: 'contact_email_required',
    message:
      'This tool talks to NCBI E-utilities, which require a contact email per their usage policy. ' +
      "Enable 'Share contact email with research data services' in Settings → Privacy to " +
      'provide one, then retry (the connector picks up the setting automatically).'
  }
}

// -- esummary db=clinvar document shape (only the fields the canonical record reads) --------------

type XrefRaw = { db_source?: string; db_id?: string }
type TraitRaw = { trait_name?: string; trait_xrefs?: XrefRaw[] }
type ClassificationBlockRaw = {
  description?: string
  review_status?: string
  last_evaluated?: string
  fda_recognized_database?: string
  trait_set?: TraitRaw[]
}
type VariationLocRaw = {
  status?: string
  assembly_name?: string
  chr?: string
  band?: string
  start?: string
  stop?: string
  ref?: string
  alt?: string
}
type VariationSetRaw = {
  variant_type?: string
  canonical_spdi?: string
  cdna_change?: string
  variation_xrefs?: XrefRaw[]
  allele_freq_set?: Array<{ source?: string; minor_allele?: string; value?: string }>
  variation_loc?: VariationLocRaw[]
}
type ClinVarSummaryDoc = {
  uid?: string
  error?: string
  accession?: string
  accession_version?: string
  title?: string
  obj_type?: string
  protein_change?: string
  genes?: Array<{ symbol?: string; geneid?: string; strand?: string }>
  molecular_consequence_list?: string[]
  variation_set?: VariationSetRaw[]
  supporting_submissions?: { scv?: string[]; rcv?: string[] }
  germline_classification?: ClassificationBlockRaw
  clinical_impact_classification?: ClassificationBlockRaw
  oncogenicity_classification?: ClassificationBlockRaw
}

// Official ClinVar review-status -> gold-star mapping
// (https://www.ncbi.nlm.nih.gov/clinvar/docs/review_status/). Both the current "conflicting
// classifications" wording and the pre-2024 "conflicting interpretations" wording are mapped.
const GOLD_STARS: Record<string, number> = {
  'practice guideline': 4,
  'reviewed by expert panel': 3,
  'criteria provided, multiple submitters, no conflicts': 2,
  'criteria provided, multiple submitters': 2,
  'criteria provided, conflicting classifications': 1,
  'criteria provided, conflicting interpretations': 1,
  'criteria provided, single submitter': 1,
  'no assertion criteria provided': 0,
  'no classification provided': 0,
  'no classification for the individual variant': 0,
  'no classifications from unflagged records': 0,
  'no assertion provided': 0
}

// esummary's "absent date" sentinel.
const NO_DATE = '1/01/01 00:00'

function goldStars(reviewStatus: string): number | null {
  const key = (reviewStatus || '').trim().toLowerCase()
  return key in GOLD_STARS ? GOLD_STARS[key] : null
}

// `2022/10/12 00:00` -> `2022-10-12`; the 1/01/01 sentinel (and empty) -> null.
function parseDate(raw: string | undefined): string | null {
  const s = (raw || '').trim()
  if (!s || s === NO_DATE) return null
  return s.split(' ')[0].replace(/\//g, '-')
}

// Normalize one of the three esummary classification blocks; null when absent or empty (no
// description AND no review status).
function classification(block: ClassificationBlockRaw | undefined): Record<string, unknown> | null {
  if (!block) return null
  const description = (block.description || '').trim()
  const reviewStatus = (block.review_status || '').trim()
  if (!description && !reviewStatus) return null
  const conditions: Array<{ name: string; xrefs: Array<{ db?: string; id?: string }> }> = []
  for (const trait of block.trait_set ?? []) {
    const name = (trait.trait_name || '').trim()
    const xrefs = (trait.trait_xrefs ?? []).map((x) => ({ db: x.db_source, id: x.db_id }))
    if (name || xrefs.length) conditions.push({ name, xrefs })
  }
  return {
    description,
    review_status: reviewStatus,
    gold_stars: goldStars(reviewStatus),
    last_evaluated: parseDate(block.last_evaluated),
    fda_recognized_database: (block.fda_recognized_database || '').trim() || null,
    conditions
  }
}

function locations(variationSet: VariationSetRaw[]): Array<Record<string, unknown>> {
  const locs: Array<Record<string, unknown>> = []
  for (const vs of variationSet) {
    for (const loc of vs.variation_loc ?? []) {
      locs.push({
        status: loc.status,
        assembly: loc.assembly_name,
        chrom: loc.chr,
        band: loc.band || null,
        start: loc.start ? Number(loc.start) : null,
        stop: loc.stop ? Number(loc.stop) : null,
        ref: loc.ref || null,
        alt: loc.alt || null
      })
    }
  }
  return locs
}

// One esummary db=clinvar document -> the canonical record. Keeps everything gnomAD's ClinVar mirror
// lacks: the three classification axes (review status / gold stars / last-evaluated / condition
// xrefs), SCV counts, canonical SPDI, and per-assembly locations.
function parseSummaryDoc(doc: ClinVarSummaryDoc): Record<string, unknown> {
  const variationSet = doc.variation_set ?? []
  const vs0 = variationSet[0] ?? {}
  const xrefs = vs0.variation_xrefs ?? []
  const rsids = xrefs.filter((x) => x.db_source === 'dbSNP' && x.db_id).map((x) => `rs${x.db_id}`)
  const otherXrefs = xrefs
    .filter((x) => x.db_source !== 'dbSNP')
    .map((x) => ({ db: x.db_source, id: x.db_id }))
  const scv = doc.supporting_submissions?.scv ?? []
  const rcv = doc.supporting_submissions?.rcv ?? []
  const freqs = (vs0.allele_freq_set ?? []).map((f) => ({
    source: f.source,
    minor_allele: f.minor_allele,
    value: f.value
  }))
  return {
    variation_id: Number(doc.uid),
    accession: doc.accession,
    accession_version: doc.accession_version,
    title: doc.title,
    obj_type: doc.obj_type,
    variant_type: vs0.variant_type,
    canonical_spdi: vs0.canonical_spdi || null,
    cdna_change: vs0.cdna_change || null,
    protein_change: doc.protein_change || null,
    rsids,
    other_xrefs: otherXrefs,
    genes: (doc.genes ?? []).map((g) => ({
      symbol: g.symbol,
      gene_id: g.geneid,
      strand: g.strand
    })),
    molecular_consequences: doc.molecular_consequence_list ?? [],
    locations: locations(variationSet),
    allele_frequencies: freqs,
    germline_classification: classification(doc.germline_classification),
    clinical_impact_classification: classification(doc.clinical_impact_classification),
    oncogenicity_classification: classification(doc.oncogenicity_classification),
    n_submissions: scv.length,
    supporting_submissions: { scv, rcv }
  }
}

// -- E-utilities steps -----------------------------------------------------------------------------

type ESearchResult = { count?: string; idlist?: string[] }

// esearch db=clinvar -> the esearchresult dict (count is the API's own total as a string; idlist the
// page of variation-ID UIDs). Empty/absent -> count 0, no ids (never throws on no match).
async function esearch(
  ctx: ToolContext,
  q: string,
  term: string,
  retmax: number
): Promise<ESearchResult> {
  const body = (await ctx.fetchJson(
    `${EUTILS}/esearch.fcgi?db=clinvar&retmode=json&retmax=${retmax}&term=${encodeURIComponent(term)}${q}`
  )) as { esearchresult?: ESearchResult }
  return body.esearchresult ?? {}
}

// Batch esummary -> parsed records in input UID order (esearch order is ClinVar's relevance/recency
// ranking). UIDs whose summary doc is absent or error-flagged are appended to `missing` (by source
// accession when known via `sources`).
async function summaries(
  ctx: ToolContext,
  q: string,
  uids: string[],
  missing: string[],
  sources?: Record<string, string[]>
): Promise<Array<Record<string, unknown>>> {
  if (!uids.length) return []
  const body = (await ctx.fetchJson(
    `${EUTILS}/esummary.fcgi?db=clinvar&retmode=json&id=${uids.join(',')}${q}`
  )) as { result?: Record<string, ClinVarSummaryDoc> }
  const result = body.result ?? {}
  const records: Array<Record<string, unknown>> = []
  for (const uid of uids) {
    const doc = result[uid]
    if (!doc || typeof doc !== 'object' || doc.error) {
      missing.push(...(sources?.[uid] ?? [uid]))
      continue
    }
    const rec = parseSummaryDoc(doc)
    if (sources) rec.requested_as = sources[uid] ?? []
    records.push(rec)
  }
  return records
}

// Reads an integer arg, applying a default when unset and clamping into [1, MAX_RETMAX].
function clampRetmax(v: unknown, def: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  const base = Number.isFinite(n) && v != null && v !== '' ? Math.trunc(n) : def
  return Math.min(MAX_RETMAX, Math.max(1, base))
}

const uniqueSorted = (xs: string[]): string[] => Array.from(new Set(xs)).sort()

// NCBI E-utilities in JSON mode against db=clinvar (esearch -> esummary). Direct-ClinVar complement to
// the gnomAD ClinVar mirror: adds review status + gold stars per classification axis, last-evaluated
// dates, SCV counts, condition xrefs, and the somatic clinical-impact + oncogenicity classifications.
export const VARIANTS_CLINVAR_TOOLS: ToolDescriptor[] = [
  {
    id: 'clinvar_search',
    connector: 'variants',
    description:
      'Search ClinVar directly (live NCBI, not gnomAD\'s snapshot) and return matching variation records with clinical significance, review status and gold stars. Requires a contact email (Settings → Privacy → \'Share contact email with research data services\') per NCBI E-utilities usage policy. Args: query (a ClinVar Entrez query — free text like "TP53 R175H" or an HGVS string works, and fielded terms compose with AND/OR/NOT, e.g. BRCA1[gene], pathogenic[CLIN_SIG], "Lynch syndrome"[dis], single_nucleotide_variant[Type of variation]; an rsID also works but clinvar_variant_by_rsid returns fuller records), max_records (page cap 1-200, default 50). The match TOTAL is always reported; when total > max_records the list is a capped prefix (ClinVar relevance/recency order) and truncated is true. NCBI E-utilities intermittently return HTTP 500 under load — retry once a few seconds later if that surfaces.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max_records: { type: 'integer', default: 50 }
      },
      required: ['query']
    },
    required: ['query'],
    returns:
      '`{ term, total, n_returned, truncated, missing_uids, records }` — `total` is the true ClinVar match count (may exceed the returned list); `truncated` flags a capped page; `missing_uids` lists matched IDs whose summary doc NCBI dropped (rare, transient — distinct from truncation; retry to recover). Each record: `{ variation_id, accession (VCV), accession_version, title, obj_type, variant_type, canonical_spdi, cdna_change, protein_change, rsids, other_xrefs, genes, molecular_consequences, locations (GRCh38+GRCh37), allele_frequencies, germline_classification, clinical_impact_classification, oncogenicity_classification (each: description, review_status, gold_stars 0-4, last_evaluated, fda_recognized_database, conditions with ontology xrefs; null when ClinVar has no classification on that axis), n_submissions (SCV count), supporting_submissions }`. When no contact email is set, returns `{ error: "contact_email_required", message }` instead.',
    example:
      'result = host.mcp("variants", "clinvar_search", {"query": "BRCA1 pathogenic[CLIN_SIG]", "max_records": 50})',
    run: async (ctx, a): Promise<Record<string, unknown> | ContactRequired> => {
      if (!ctx.credentials.ncbiEmail) return contactRequired()
      const q = ncbiEtiquette(ctx.credentials)
      const retmax = clampRetmax(a.max_records, 50)
      const term = String(a.query)
      const res = await esearch(ctx, q, term, retmax)
      const total = Number(res.count ?? 0)
      const uids = res.idlist ?? []
      const missing: string[] = []
      const records = await summaries(ctx, q, uids, missing)
      return {
        term,
        total,
        n_returned: records.length,
        // Capped page (total > the UID page) vs. a dropped summary doc are different conditions.
        truncated: total > uids.length,
        missing_uids: missing,
        records
      }
    }
  },
  {
    id: 'clinvar_get_records',
    connector: 'variants',
    description:
      "Fetch full ClinVar records for a batch of VCV/RCV accessions or bare variation IDs. Requires a contact email (Settings → Privacy → 'Share contact email with research data services') per NCBI E-utilities usage policy. Args: accessions (up to 50 identifiers, mixed forms accepted — VCV000045122 (versioned VCV000045122.3 ok; resolved locally, free), RCV000019428 (each RCV costs one extra esearch), or a bare ClinVar variation ID (45122). rsIDs are rejected — use clinvar_variant_by_rsid. An RCV (one variant-condition pair) resolves to its parent VCV variation record). Never silently drops an input.",
    input: {
      type: 'object',
      properties: {
        accessions: { type: 'array', items: { type: 'string' } }
      },
      required: ['accessions']
    },
    required: ['accessions'],
    returns:
      '`{ n_requested, n_unique, n_duplicate_skipped, records, not_found, missing_uids, not_processed }`. Records carry the full shape documented in `clinvar_search` plus `requested_as` (which input(s) mapped to the record), sorted by variation_id. `not_found` lists unknown accessions (definitive absence — RCVs that esearch proves unknown); `missing_uids` lists inputs whose summary NCBI dropped or error-flagged (for a just-resolved RCV this is a transient drop — the record EXISTS, retry; for a VCV/numeric input it is a transient drop OR a nonexistent id — retry to disambiguate, never conclude absence from one call); `not_processed` lists RCVs skipped because the per-call time budget ran out (re-request just those — VCV/numeric inputs always resolve, they never land there). When no contact email is set, returns `{ error: "contact_email_required", message }` instead.',
    example:
      'result = host.mcp("variants", "clinvar_get_records", {"accessions": ["VCV000045122", "RCV000019428", "45123"]})',
    run: async (ctx, a): Promise<Record<string, unknown> | ContactRequired> => {
      if (!ctx.credentials.ncbiEmail) return contactRequired()
      const q = ncbiEtiquette(ctx.credentials)
      const raw = (Array.isArray(a.accessions) ? a.accessions : [a.accessions]).map((x) =>
        String(x).trim()
      )
      const cleaned = raw.filter((x) => x !== '')
      // Cap on the UNIQUE set: the esummary/esearch fan-out is keyed to unique accessions, so a batch
      // whose raw count exceeds the cap but whose unique count is within it must not be rejected.
      const pending = Array.from(new Set(cleaned))
      const nDuplicateSkipped = cleaned.length - pending.length
      if (pending.length > MAX_BATCH_ACCESSIONS) {
        throw new Error(
          `too many accessions (${pending.length} unique); max ${MAX_BATCH_ACCESSIONS} per call`
        )
      }
      const uidSources: Record<string, string[]> = {}
      const notFound: string[] = []
      const notProcessed: string[] = []
      const rcvs: string[] = []
      const addSource = (uid: string, acc: string): void => {
        ;(uidSources[uid] ??= []).push(acc)
      }
      // Pass 1 — local-only resolution (VCV/numeric: the UID is the VCV number) + input validation.
      for (const acc of pending) {
        const m = VCV_RE.exec(acc)
        if (m) {
          addSource(String(Number(m[1])), acc)
          continue
        }
        if (/^\d+$/.test(acc)) {
          addSource(String(Number(acc)), acc)
          continue
        }
        if (RCV_RE.test(acc)) {
          rcvs.push(acc)
          continue
        }
        if (RSID_RE.test(acc)) throw new Error(`'${acc}' is an rsID — use clinvar_variant_by_rsid`)
        throw new Error(
          `unrecognized accession '${acc}' (expected VCVnnn, RCVnnn, or a bare ClinVar variation ID)`
        )
      }
      // Pass 2 — RCVs (one esearch each); only these can trip the wall-clock deadline.
      const t0 = Date.now()
      for (let i = 0; i < rcvs.length; i++) {
        if (Date.now() - t0 > RCV_DEADLINE_MS) {
          notProcessed.push(...rcvs.slice(i))
          break
        }
        const acc = rcvs[i]
        const res = await esearch(ctx, q, acc.toUpperCase().split('.')[0], 5)
        const uids = res.idlist ?? []
        if (!uids.length) notFound.push(acc)
        for (const uid of uids) addSource(uid, acc)
      }
      const missingUids: string[] = []
      const uids = Object.keys(uidSources).filter((u) => u !== '')
      const records = await summaries(ctx, q, uids, missingUids, uidSources)
      // Order is undefined for a batch lookup: sort for determinism.
      records.sort((x, y) => (x.variation_id as number) - (y.variation_id as number))
      return {
        n_requested: cleaned.length,
        n_unique: pending.length,
        n_duplicate_skipped: nDuplicateSkipped,
        records,
        not_found: uniqueSorted(notFound),
        missing_uids: uniqueSorted(missingUids),
        not_processed: notProcessed
      }
    }
  },
  {
    id: 'clinvar_variant_by_rsid',
    connector: 'variants',
    description:
      "All ClinVar variation records that reference a dbSNP rsID, with full classifications (an rsID can map to several VCVs — one per alternate allele, e.g. rs121913529 covers KRAS G12D/G12V/G12A). Requires a contact email (Settings → Privacy → 'Share contact email with research data services') per NCBI E-utilities usage policy. Args: rsid (dbSNP reference SNP ID, e.g. rs7412; case-insensitive, must match rs<digits>), max_records (cap 1-200, default 50). total always carries the true match count and truncated flags a capped listing; total == 0 means ClinVar has no record for the rsID.",
    input: {
      type: 'object',
      properties: {
        rsid: { type: 'string', description: 'dbSNP rsID, e.g. rs7412 (case-insensitive).' },
        max_records: { type: 'integer', default: 50 }
      },
      required: ['rsid']
    },
    required: ['rsid'],
    returns:
      '`{ rsid, total, n_returned, truncated, missing_uids, records }` with the full record shape documented in `clinvar_search` (review status, gold stars, last-evaluated dates, SCV counts — the fields gnomAD’s ClinVar mirror lacks). Records come in ClinVar relevance order; `missing_uids` lists matches whose summary NCBI dropped (transient). `total == 0` means ClinVar has no record for the rsID. When no contact email is set, returns `{ error: "contact_email_required", message }` instead.',
    example:
      'result = host.mcp("variants", "clinvar_variant_by_rsid", {"rsid": "rs121913529", "max_records": 50})',
    run: async (ctx, a): Promise<Record<string, unknown> | ContactRequired> => {
      if (!ctx.credentials.ncbiEmail) return contactRequired()
      const rsid = String(a.rsid).trim()
      if (!RSID_RE.test(rsid)) throw new Error(`not an rsID: '${rsid}' (expected e.g. rs7412)`)
      const q = ncbiEtiquette(ctx.credentials)
      const retmax = clampRetmax(a.max_records, 50)
      const term = rsid.toLowerCase()
      const res = await esearch(ctx, q, term, retmax)
      const total = Number(res.count ?? 0)
      const uids = res.idlist ?? []
      const missing: string[] = []
      const records = await summaries(ctx, q, uids, missing)
      return {
        rsid: term,
        total,
        n_returned: records.length,
        truncated: total > uids.length,
        missing_uids: missing,
        records
      }
    }
  }
]
