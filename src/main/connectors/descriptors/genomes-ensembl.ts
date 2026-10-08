import { createHash } from 'node:crypto'
import type { ToolContext, ToolDescriptor } from '../types'

// Ensembl REST — keyless GETs; the engine already sends Accept: application/json for fetchJson, so
// plain paths return JSON without the ?content-type suffix.
const ENSEMBL = 'https://rest.ensembl.org'
const DEFAULT_SPECIES = 'homo_sapiens'

// Recognizes Ensembl/LRG IDs for version normalization and for avoiding symbol fallback on a
// missing canonical ID. This is not an exhaustive list of IDs accepted by Ensembl (e.g. FlyBase).
const STABLE_ID_RE = /^(ENS([A-Z]{3,4})?[EGTP]\d{6,}(\.\d+)?|LRG_\d+)$/

const isStableId = (query: string): boolean => STABLE_ID_RE.test(query.trim())

// Ensembl records expose versioned ids, but its lookup/xref/sequence routes accept only the stable
// base. Keep echoing the caller's exact query while normalizing only the upstream path segment.
const upstreamStableId = (query: string): string =>
  isStableId(query) ? query.replace(/\.\d+$/, '') : query

// Reads an integer arg, applying a default when unset and clamping into [lo, hi].
function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  const base = Number.isFinite(n) && v != null && v !== '' ? Math.trunc(n) : def
  return Math.min(hi, Math.max(lo, base))
}

// True for the engine's wrapped Ensembl "not found" 400 (unknown id/symbol). The engine throws
// `HTTP 400 for <url>` with the body stripped, so we key on the status code.
const isNotFound = (err: unknown): boolean =>
  err instanceof Error && /\bHTTP 400\b/.test(err.message)

// Only an exact upstream absence response permits fallback or found:false. A bad species,
// invalid arguments, malformed JSON, or a server failure must remain an error.
async function lookupRecord(
  ctx: ToolContext,
  url: string,
  missingMessage: string
): Promise<Dict | null> {
  const { body: record, status } = await ctx.fetchJsonWithHeaders(url, { allowHttpStatuses: [400] })
  if (record && typeof record === 'object' && !Array.isArray(record)) {
    const error = (record as Dict).error
    if (typeof error === 'string') {
      if (status === 400 && error === missingMessage) return null
      throw new Error(`Ensembl lookup failed: ${error.slice(0, 1000)}`)
    }
    if (status === 400) throw new Error('Ensembl lookup returned an unrecognized HTTP 400 response')
    if (typeof (record as Dict).species === 'string' && String((record as Dict).species).trim()) {
      return record as Dict
    }
  }
  throw new Error('Ensembl lookup returned a record without a valid species')
}

// hex sha256 of a string (used to fingerprint sequences even when the text is omitted).
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

// A non-empty string arg, or null when unset/blank.
const strArg = (v: unknown): string | null =>
  v != null && String(v).trim() !== '' ? String(v).trim() : null

// VEP impact severity ranking (HIGH > MODERATE > LOW > MODIFIER).
const IMPACT_RANK: Record<string, number> = { HIGH: 4, MODERATE: 3, LOW: 2, MODIFIER: 1 }
const impactRank = (impact: unknown): number => IMPACT_RANK[String(impact ?? '').toUpperCase()] ?? 0

type Dict = Record<string, unknown>

const LD_INTERPRETATION =
  'LD is specific to the selected population and reference panel. High LD does not establish causality or identify a causal variant. An empty result does not establish zero LD.'

function ldString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value.trim()
}

function ldNumber(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`)
  }
  return value
}

function ldInteger(value: unknown, name: string, max: number): number {
  const n = ldNumber(value, name, 1, max)
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`)
  return n
}

// Ensembl serializes these statistics as decimal strings. Never coerce null/blank to zero.
function ldStatistic(value: unknown, name: string): number {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value
  return ldNumber(n, `Ensembl LD ${name}`, 0, 1)
}

function ldRows(raw: unknown, population: string): Dict[] {
  if (!Array.isArray(raw)) throw new Error('Ensembl LD returned a non-array response')
  return raw.map((row: unknown) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('Ensembl LD returned an invalid row')
    }
    const r = row as Dict
    if (r.population_name !== population) {
      throw new Error('Ensembl LD returned a missing or mismatched population_name')
    }
    return {
      ...r,
      r2: ldStatistic(r.r2, 'r2'),
      d_prime: ldStatistic(r.d_prime, 'd_prime')
    }
  })
}

function ldReference(population: string, requestUrl: string): Dict {
  return {
    provider: 'Ensembl REST',
    population_name: population,
    // Only label a known panel; arbitrary population names do not prove a dataset/version.
    reference_panel: population.startsWith('1000GENOMES:phase_3:')
      ? '1000 Genomes Project Phase 3'
      : null,
    assembly_name: null,
    ensembl_release: null,
    request_url: requestUrl,
    retrieved_at: new Date().toISOString(),
    note: 'The LD endpoint does not report assembly or Ensembl release. A null reference_panel means the panel could not be identified from the population name.'
  }
}

// GET VEP reads the reference on the region strand, but submits it as strand=1.
// Always request the forward strand. Existing callers supply forward alleles;
// interpreting an allele on the region strand requires an explicit opt-in.
function normalizeVepRegion(
  region: string,
  allele: string,
  orientation: unknown
): {
  original: { region: string; allele: string; allele_orientation: string }
  forward: { region: string; allele: string }
  reverse_complemented: boolean
} {
  const alleleOrientation = orientation ?? 'forward'
  if (alleleOrientation !== 'forward' && alleleOrientation !== 'region') {
    throw new Error('allele_orientation must be forward or region')
  }
  const match = /^([A-Za-z0-9_.-]+):(\d+)-(\d+)(?::([+-]?1))?$/.exec(region)
  if (!match) {
    throw new Error('region must be chrom:start-end with an optional :1 or :-1 strand')
  }
  const [, chrom, startText, endText, strand] = match
  const start = Number(startText)
  const end = Number(endText)
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 1 ||
    end < 1 ||
    start > end + 1
  ) {
    throw new Error('region requires positive 1-based coordinates; insertions use start=end+1')
  }
  let forwardAllele = allele.toUpperCase()
  if (!/^(?:[ACGT]+|-|INS|DUP|DEL|TDUP)$/.test(forwardAllele)) {
    throw new Error('allele must be an A/C/G/T sequence, -, INS, DUP, DEL, or TDUP')
  }
  const reverseComplemented =
    strand === '-1' && alleleOrientation === 'region' && forwardAllele !== '-'
  if (reverseComplemented) {
    if (!/^[ACGT]+$/.test(forwardAllele)) {
      throw new Error(
        'Negative-strand region-oriented alleles require an A/C/G/T sequence or -; symbolic alleles require allele_orientation=forward'
      )
    }
    const complement: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A' }
    forwardAllele = [...forwardAllele]
      .reverse()
      .map((base) => complement[base])
      .join('')
  }
  return {
    original: { region, allele, allele_orientation: alleleOrientation },
    forward: { region: `${chrom}:${start}-${end}:1`, allele: forwardAllele },
    reverse_complemented: reverseComplemented
  }
}

// One VEP transcript-consequence row, keeping only the fields the summary surfaces.
function leanTranscriptConsequence(tc: Dict): Dict {
  return {
    transcript_id: tc.transcript_id,
    variant_allele: tc.variant_allele,
    gene_id: tc.gene_id,
    gene_symbol: tc.gene_symbol,
    consequence_terms: tc.consequence_terms,
    impact: tc.impact,
    biotype: tc.biotype,
    amino_acids: tc.amino_acids,
    codons: tc.codons,
    protein_start: tc.protein_start,
    protein_end: tc.protein_end,
    sift_score: tc.sift_score,
    sift_prediction: tc.sift_prediction,
    polyphen_score: tc.polyphen_score,
    polyphen_prediction: tc.polyphen_prediction
  }
}

// One colocated-variant row (dbSNP/COSMIC/ClinVar overlap) in a lean shape.
function leanColocated(c: Dict): Dict {
  return {
    id: c.id,
    allele_string: c.allele_string,
    clin_sig: c.clin_sig,
    somatic: c.somatic,
    phenotype_or_disease: c.phenotype_or_disease,
    minor_allele: c.minor_allele,
    minor_allele_freq: c.minor_allele_freq
  }
}

// Collapses one upstream VEP result into a most-severe-first summary: sorted+capped per-transcript
// rows, a per-gene worst-impact roll-up over the FULL list, and colocated-variant/feature counts.
function summarizeVepResult(r: Dict, maxConsequences: number): Dict {
  const tcs = (r.transcript_consequences as Dict[] | undefined) ?? []
  const sorted = [...tcs].sort((a, b) => impactRank(b.impact) - impactRank(a.impact))
  const kept = sorted.slice(0, maxConsequences)

  // Count distinct transcript IDs per gene across all alleles in the complete (un-truncated) list.
  const geneMap = new Map<
    string,
    {
      gene_id: unknown
      gene_symbol: unknown
      worstRank: number
      worst_impact: unknown
      transcriptIds: Set<string>
    }
  >()
  for (const tc of tcs) {
    const gid = String(tc.gene_id ?? '')
    const rank = impactRank(tc.impact)
    const transcriptId = strArg(tc.transcript_id)
    const existing = geneMap.get(gid)
    if (!existing) {
      geneMap.set(gid, {
        gene_id: tc.gene_id,
        gene_symbol: tc.gene_symbol,
        worstRank: rank,
        worst_impact: tc.impact,
        transcriptIds: new Set(transcriptId ? [transcriptId] : [])
      })
    } else {
      if (transcriptId) existing.transcriptIds.add(transcriptId)
      if (rank > existing.worstRank) {
        existing.worstRank = rank
        existing.worst_impact = tc.impact
      }
    }
  }
  const genes = [...geneMap.values()]
    .sort((a, b) => b.worstRank - a.worstRank || String(a.gene_id).localeCompare(String(b.gene_id)))
    .map((g) => ({
      gene_id: g.gene_id,
      gene_symbol: g.gene_symbol,
      worst_impact: g.worst_impact,
      n_transcripts: g.transcriptIds.size
    }))

  const reg = (r.regulatory_feature_consequences as unknown[] | undefined) ?? []
  const motif = (r.motif_feature_consequences as unknown[] | undefined) ?? []
  const coloc = (r.colocated_variants as Dict[] | undefined) ?? []
  return {
    input: r.input,
    assembly_name: r.assembly_name,
    seq_region_name: r.seq_region_name,
    start: r.start,
    end: r.end,
    strand: r.strand,
    allele_string: r.allele_string,
    most_severe_consequence: r.most_severe_consequence,
    genes,
    n_transcript_consequences: tcs.length,
    transcript_consequences_truncated: tcs.length > kept.length,
    transcript_consequences: kept.map(leanTranscriptConsequence),
    n_regulatory_feature_consequences: reg.length,
    n_motif_feature_consequences: motif.length,
    colocated_variants: coloc.map(leanColocated)
  }
}

// One Ensembl xref row in a stable shape.
function leanXref(x: Dict): Dict {
  return {
    dbname: x.dbname,
    db_display_name: x.db_display_name,
    primary_id: x.primary_id,
    display_id: x.display_id,
    description: x.description,
    synonyms: x.synonyms,
    info_type: x.info_type
  }
}

// One condensed homology row.
function leanHomology(h: Dict): Dict {
  return {
    type: h.type,
    species: h.species,
    id: h.id,
    protein_id: h.protein_id,
    taxonomy_level: h.taxonomy_level,
    method_link_type: h.method_link_type
  }
}

// Best-effort id accessor for overlap-feature sorting (field name varies by feature type).
const featureId = (f: Dict): string => String(f.id ?? f.gene_id ?? f.ID ?? '')

export const GENOMES_ENSEMBL_TOOLS: ToolDescriptor[] = [
  {
    id: 'ensembl_ld_pairwise',
    connector: 'genomes',
    description:
      'Query linkage disequilibrium (r² and D′) between two variant IDs, such as GWAS Catalog rsIDs, in an explicitly selected population. The caller must supply the full population name in population_name (e.g. 1000GENOMES:phase_3:KHV); this tool does not discover populations or infer ancestry. species defaults to homo_sapiens. Returns upstream variant identities and numeric r2/d_prime without significance or causality inference. High LD does not establish causality. Empty results mean no LD data returned, not zero LD; invalid IDs/populations and service failures remain errors. Reference metadata includes the population, known panel, query URL and retrieval time; assembly/release are null because the LD endpoint does not report them.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        variant_id1: { type: 'string', minLength: 1, pattern: '\\S' },
        variant_id2: { type: 'string', minLength: 1, pattern: '\\S' },
        population_name: { type: 'string', minLength: 1, pattern: '\\S' },
        species: { type: 'string', minLength: 1, pattern: '\\S', default: DEFAULT_SPECIES }
      },
      required: ['variant_id1', 'variant_id2', 'population_name']
    },
    required: ['variant_id1', 'variant_id2', 'population_name'],
    returns:
      '{variant_id1, variant_id2, species, population_name, reference_data, interpretation, n_pairs, pairs:[{variation1, variation2, population_name, r2, d_prime}]} — r2/d_prime are numbers; n_pairs=0 means unavailable, not zero LD.',
    example:
      'const result = await host.mcp("genomes", "ensembl_ld_pairwise", {"variant_id1": "rs6792369", "variant_id2": "rs1042779", "population_name": "1000GENOMES:phase_3:KHV"})',
    run: async (ctx, a) => {
      const id1 = ldString(a.variant_id1, 'variant_id1')
      const id2 = ldString(a.variant_id2, 'variant_id2')
      const population = ldString(a.population_name, 'population_name')
      const species = ldString(a.species === undefined ? DEFAULT_SPECIES : a.species, 'species')
      const url = `${ENSEMBL}/ld/${encodeURIComponent(species)}/pairwise/${encodeURIComponent(id1)}/${encodeURIComponent(id2)}?population_name=${encodeURIComponent(population)}`
      const pairs = ldRows(await ctx.fetchJson(url), population).map((r) => ({
        variation1: ldString(r.variation1, 'Ensembl LD variation1'),
        variation2: ldString(r.variation2, 'Ensembl LD variation2'),
        population_name: population,
        r2: r.r2,
        d_prime: r.d_prime
      }))
      return {
        variant_id1: id1,
        variant_id2: id2,
        species,
        population_name: population,
        reference_data: ldReference(population, url),
        interpretation: LD_INTERPRETATION,
        n_pairs: pairs.length,
        pairs
      }
    }
  },
  {
    id: 'ensembl_ld_proxies',
    connector: 'genomes',
    description:
      'Find nearby variants in LD with a variant ID (e.g. a GWAS rsID) in a required population_name such as 1000GENOMES:phase_3:KHV. species defaults to homo_sapiens. min_r2 defaults to 0.8; min_d_prime defaults to 0; both are inclusive thresholds in [0,1]. window_size is the total width of the centered Ensembl window in kb (integer 1–500, default 500, approximately 250 kb on each side at the default); max_records caps output (integer 1–1000, default 100) and does not limit upstream computation or download size. Results are sorted by r2 descending, then d_prime descending and variant ID, before capping. Coordinates/annotations are upstream attributes. Report the population and reference_data with results. High LD does not establish causality or functional equivalence. Empty results mean no qualifying data returned, not zero LD. Errors remain errors; assembly/release are not reported by this endpoint and remain null. The caller must supply the full population name; this tool does not discover populations or infer ancestry.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        variant_id: { type: 'string', minLength: 1, pattern: '\\S' },
        population_name: { type: 'string', minLength: 1, pattern: '\\S' },
        species: { type: 'string', minLength: 1, pattern: '\\S', default: DEFAULT_SPECIES },
        min_r2: { type: 'number', minimum: 0, maximum: 1, default: 0.8 },
        min_d_prime: { type: 'number', minimum: 0, maximum: 1, default: 0 },
        window_size: { type: 'integer', minimum: 1, maximum: 500, default: 500 },
        max_records: { type: 'integer', minimum: 1, maximum: 1000, default: 100 }
      },
      required: ['variant_id', 'population_name']
    },
    required: ['variant_id', 'population_name'],
    returns:
      '{variant_id, species, population_name, min_r2, min_d_prime, window_size, reference_data, interpretation, n_proxies, returned, truncated, proxies:[{variation, population_name, r2, d_prime, chr, start, end, strand, consequence_type, clinical_significance}]} — n_proxies counts qualifying non-self rows before the output cap, not all variants in the window; coordinates are 1-based inclusive.',
    example:
      'const result = await host.mcp("genomes", "ensembl_ld_proxies", {"variant_id": "rs1042779", "population_name": "1000GENOMES:phase_3:KHV", "min_r2": 0.8, "window_size": 500, "max_records": 100})',
    run: async (ctx, a) => {
      const id = ldString(a.variant_id, 'variant_id')
      const population = ldString(a.population_name, 'population_name')
      const species = ldString(a.species === undefined ? DEFAULT_SPECIES : a.species, 'species')
      const minR2 = ldNumber(a.min_r2 === undefined ? 0.8 : a.min_r2, 'min_r2', 0, 1)
      const minDPrime = ldNumber(
        a.min_d_prime === undefined ? 0 : a.min_d_prime,
        'min_d_prime',
        0,
        1
      )
      const windowSize = ldInteger(
        a.window_size === undefined ? 500 : a.window_size,
        'window_size',
        500
      )
      const maxRecords = ldInteger(
        a.max_records === undefined ? 100 : a.max_records,
        'max_records',
        1000
      )
      const url = `${ENSEMBL}/ld/${encodeURIComponent(species)}/${encodeURIComponent(id)}/${encodeURIComponent(population)}?r2=${minR2}&d_prime=${minDPrime}&window_size=${windowSize}&attribs=1`
      const rows = ldRows(await ctx.fetchJson(url), population)
        .map((r) => ({
          variation: ldString(r.variation, 'Ensembl LD variation'),
          population_name: population,
          r2: r.r2 as number,
          d_prime: r.d_prime as number,
          chr: r.chr ?? null,
          start: r.start ?? null,
          end: r.end ?? null,
          strand: r.strand ?? null,
          consequence_type: r.consequence_type ?? null,
          clinical_significance: r.clinical_significance ?? null
        }))
        .filter((r) => r.variation !== id && r.r2 >= minR2 && r.d_prime >= minDPrime)
        .sort(
          (a, b) => b.r2 - a.r2 || b.d_prime - a.d_prime || a.variation.localeCompare(b.variation)
        )
      const proxies = rows.slice(0, maxRecords)
      return {
        variant_id: id,
        species,
        population_name: population,
        min_r2: minR2,
        min_d_prime: minDPrime,
        window_size: windowSize,
        reference_data: ldReference(population, url),
        interpretation: LD_INTERPRETATION,
        n_proxies: rows.length,
        returned: proxies.length,
        truncated: rows.length > proxies.length,
        proxies
      }
    }
  },
  {
    id: 'ensembl_lookup',
    connector: 'genomes',
    description:
      'Look up genes, transcripts, or proteins by stable ID, or genes by symbol. query accepts ENS IDs (versioned allowed), FlyBase/WormBase/yeast IDs, or symbols such as BRAF. query_type: auto (default) tries ID first, then symbol only on explicit absence unless the input is a canonical ENS/LRG ID; id uses only ID lookup; symbol uses only symbol lookup without version normalization. species applies only to symbol lookup (default homo_sapiens) and is not inferred. expand includes transcripts, exons and translations (default false). Invalid requests and service failures raise errors.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        query_type: { type: 'string', enum: ['auto', 'id', 'symbol'], default: 'auto' },
        species: { type: 'string', default: DEFAULT_SPECIES },
        expand: { type: 'boolean', default: false }
      },
      required: ['query']
    },
    required: ['query'],
    returns:
      '{found, query, species, record} — species is the upstream record species on success, otherwise the requested/default species; record is the upstream lookup dict (1-based inclusive coords) or null when nothing matches.',
    example:
      'const result = await host.mcp("genomes", "ensembl_lookup", {"query": "BRAF", "query_type": "symbol"})',
    run: async (ctx, a) => {
      const query = String(a.query).trim()
      const queryType = a.query_type === undefined ? 'auto' : a.query_type
      if (queryType !== 'auto' && queryType !== 'id' && queryType !== 'symbol') {
        throw new Error('query_type must be auto, id, or symbol')
      }
      const species = String(a.species ?? DEFAULT_SPECIES)
      const expand = a.expand === true ? 1 : 0
      let record: Dict | null = null
      if (queryType !== 'symbol') {
        const stableId = upstreamStableId(query)
        record = await lookupRecord(
          ctx,
          `${ENSEMBL}/lookup/id/${encodeURIComponent(stableId)}?expand=${expand}`,
          `ID '${stableId}' not found`
        )
      }
      if (queryType === 'symbol' || (queryType === 'auto' && !record && !isStableId(query))) {
        record = await lookupRecord(
          ctx,
          `${ENSEMBL}/lookup/symbol/${encodeURIComponent(species)}/${encodeURIComponent(query)}?expand=${expand}`,
          `No valid lookup found for symbol ${query}`
        )
      }
      if (!record) return { found: false, query, species, record: null }
      // Stable IDs select their own species; the requested/default species only routes symbols.
      return { found: true, query, species: record.species, record }
    }
  },
  {
    id: 'ensembl_xrefs',
    connector: 'genomes',
    description:
      'External cross-references of an Ensembl stable ID — the bridge from Ensembl gene/transcript IDs to HGNC, NCBI (EntrezGene), UniProt, OMIM, RefSeq, Expression Atlas and others. Args: stable_id (ENSG.../ENST..., versioned accepted); external_db (optional exact upstream database-name filter, e.g. HGNC, EntrezGene, Uniprot_gn, MIM_GENE, RefSeq_mRNA; omit for all). Returns {stable_id, external_db, n_xrefs, xrefs} — the COMPLETE list (never truncated), sorted by (dbname, primary_id); each row {dbname, db_display_name, primary_id, display_id, description, synonyms, info_type}. Unknown IDs return n_xrefs:0.',
    input: {
      type: 'object',
      properties: {
        stable_id: { type: 'string' },
        external_db: { type: 'string' }
      },
      required: ['stable_id']
    },
    required: ['stable_id'],
    returns:
      '{stable_id, external_db, n_xrefs, xrefs:[{dbname, db_display_name, primary_id, display_id, description, synonyms, info_type}]} sorted by (dbname, primary_id); unknown id -> n_xrefs:0.',
    example:
      'const result = await host.mcp("genomes", "ensembl_xrefs", {"stable_id": "ENSG00000157764", "external_db": "HGNC"})',
    run: async (ctx, a) => {
      const stableId = String(a.stable_id).trim()
      const externalDb = strArg(a.external_db) ?? ''
      const url = `${ENSEMBL}/xrefs/id/${encodeURIComponent(upstreamStableId(stableId))}?external_db=${encodeURIComponent(externalDb)}`
      let rows: Dict[]
      try {
        rows = ((await ctx.fetchJson(url)) as Dict[] | undefined) ?? []
      } catch (err) {
        if (isNotFound(err)) rows = []
        else throw err
      }
      const xrefs = rows
        .map(leanXref)
        .sort(
          (x, y) =>
            String(x.dbname ?? '').localeCompare(String(y.dbname ?? '')) ||
            String(x.primary_id ?? '').localeCompare(String(y.primary_id ?? ''))
        )
      return { stable_id: stableId, external_db: externalDb || null, n_xrefs: xrefs.length, xrefs }
    }
  },
  {
    id: 'ensembl_vep_variant',
    connector: 'genomes',
    description:
      'Predict variant consequences with Ensembl VEP — most-severe-first summary of the (often huge) per-transcript consequence list. If variant_id is provided, the ID route takes precedence and region/allele/allele_orientation are ignored. Otherwise, both region and allele are required. allele does not filter results from the ID route. Args: variant_id (dbSNP rsID rs7412, COSMIC COSV..., or HGMD ID); region (1-based inclusive chrom:start-end on the current species assembly, GRCh38 for human, e.g. 7:140753336-140753336; SNV start==end; insertion start=end+1; explicit strand suffix :1/:-1 accepted; coordinates always refer to the reference genome, including on the negative strand); allele (A/C/G/T replacement sequence, or - for deletion; upstream symbolic alleles INS/DUP/DEL/TDUP are accepted in forward orientation); allele_orientation (forward by default, preserving existing calls: allele is on the reference forward strand regardless of the region suffix; region opts into interpreting allele on the region strand, so :-1 reverse-complements sequence alleles before querying; symbolic alleles on a negative region require forward orientation). Every region request is sent on the forward strand; returned alleles are forward-oriented. A negative-strand gene does not require negative-strand input; species (default homo_sapiens); max_consequences (cap on returned per-transcript rows, default 25; full count in n_transcript_consequences, rows kept are most severe HIGH>MODERATE>LOW>MODIFIER; transcript_consequences_truncated flags the cap). Returns {query, n_results, results:[{input, assembly_name, seq_region_name, start, end, strand, allele_string, most_severe_consequence, genes:[{gene_id, gene_symbol, worst_impact, n_transcripts}], n_transcript_consequences, transcript_consequences_truncated, transcript_consequences:[...], n_regulatory_feature_consequences, n_motif_feature_consequences, colocated_variants:[...]}]}. Each transcript consequence retains variant_allele. n_transcripts counts distinct non-empty transcript IDs per gene across the full list; worst_impact spans all returned upstream alleles, while n_transcript_consequences counts rows. Unknown rsIDs raise with the upstream message.',
    input: {
      type: 'object',
      properties: {
        variant_id: { type: 'string' },
        region: { type: 'string' },
        allele: { type: 'string' },
        allele_orientation: {
          type: 'string',
          enum: ['forward', 'region'],
          default: 'forward',
          description:
            'Region route only: forward preserves existing allele semantics; region interprets allele on the region strand (:-1 reverse-complements sequence alleles).'
        },
        species: { type: 'string', default: DEFAULT_SPECIES },
        max_consequences: { type: 'integer', default: 25 }
      }
    },
    returns:
      '{query, n_results, results[], normalization?} — each result the most-severe-first VEP summary. Region calls add normalization: {original:{region,allele,allele_orientation}, forward:{region,allele}, reverse_complemented}; coordinates are not lifted or reversed. query retains the original input; results use forward-strand alleles. ID calls omit normalization.',
    example:
      'const result = await host.mcp("genomes", "ensembl_vep_variant", {"variant_id": "rs7412", "max_consequences": 25})',
    run: async (ctx, a) => {
      const species = String(a.species ?? DEFAULT_SPECIES)
      const maxConsequences = clampInt(a.max_consequences, 25, 1, 100000)
      const variantId = strArg(a.variant_id)
      const region = strArg(a.region)
      const allele = strArg(a.allele)
      let url: string
      let query: string
      let normalization: ReturnType<typeof normalizeVepRegion> | undefined
      if (variantId) {
        url = `${ENSEMBL}/vep/${species}/id/${encodeURIComponent(variantId)}`
        query = variantId
      } else if (region && allele) {
        normalization = normalizeVepRegion(region, allele, a.allele_orientation)
        url = `${ENSEMBL}/vep/${species}/region/${normalization.forward.region}/${encodeURIComponent(normalization.forward.allele)}`
        query = `${region} ${allele}`
      } else {
        throw new Error('ensembl_vep_variant requires either variant_id or both region and allele')
      }
      const raw = ((await ctx.fetchJson(url)) as Dict[] | undefined) ?? []
      const results = raw.map((r) => summarizeVepResult(r, maxConsequences))
      return {
        query,
        n_results: results.length,
        results,
        ...(normalization ? { normalization } : {})
      }
    }
  },
  {
    id: 'ensembl_homology',
    connector: 'genomes',
    description:
      'Orthologues or paralogues of a gene from Ensembl Compara (condensed rows — no alignments/sequences). Args: gene_symbol (resolved to a stable ID in `species` first; pass exactly one of gene_symbol/gene_id); gene_id (ENSG...); homology_type (orthologues default/paralogues/projections); target_species (restrict to one species); target_taxon (NCBI taxon subtree, e.g. 9443 Primates; combinable with target_species, OR semantics); species (source species, default homo_sapiens); max_homologies (row cap default 200; n_total carries the complete count, homologies_truncated flags the cap). Returns {gene_id, gene_symbol, species, homology_type, target_species, target_taxon, n_total, homologies_truncated, homologies}; rows sorted by (species,id) {type, species, id, protein_id, taxonomy_level, method_link_type}. Quirk: the /homology/symbol route stalls — this tool always resolves symbols itself and queries by stable ID.',
    input: {
      type: 'object',
      properties: {
        gene_symbol: { type: 'string' },
        gene_id: { type: 'string' },
        homology_type: {
          type: 'string',
          enum: ['orthologues', 'paralogues', 'projections'],
          default: 'orthologues'
        },
        target_species: { type: 'string' },
        target_taxon: { type: 'integer' },
        species: { type: 'string', default: DEFAULT_SPECIES },
        max_homologies: { type: 'integer', default: 200 }
      }
    },
    returns:
      '{gene_id, gene_symbol, species, homology_type, target_species, target_taxon, n_total, homologies_truncated, homologies:[{type, species, id, protein_id, taxonomy_level, method_link_type}]} sorted by (species,id).',
    example:
      'const result = await host.mcp("genomes", "ensembl_homology", {"gene_symbol": "BRAF", "target_species": "mus_musculus"})',
    run: async (ctx, a) => {
      const species = String(a.species ?? DEFAULT_SPECIES)
      const homologyType = String(a.homology_type ?? 'orthologues')
      const maxHomologies = clampInt(a.max_homologies, 200, 1, 100000)
      const symbol = strArg(a.gene_symbol)
      let geneId = strArg(a.gene_id)
      if ((symbol && geneId) || (!symbol && !geneId)) {
        throw new Error('ensembl_homology requires exactly one of gene_symbol or gene_id')
      }
      // The /homology/symbol route stalls upstream — always resolve a symbol to a stable ID first.
      if (symbol) {
        const rec = (await ctx.fetchJson(
          `${ENSEMBL}/lookup/symbol/${encodeURIComponent(species)}/${encodeURIComponent(symbol)}?expand=0`
        )) as Dict
        geneId = String(rec.id ?? '')
      }
      const targetSpecies = strArg(a.target_species)
      const targetTaxon = a.target_taxon != null ? clampInt(a.target_taxon, 0, 0, 1e12) : null
      const params = [`type=${encodeURIComponent(homologyType)}`, 'format=condensed']
      if (targetSpecies) params.push(`target_species=${encodeURIComponent(targetSpecies)}`)
      if (targetTaxon != null) params.push(`target_taxon=${targetTaxon}`)
      const resp = (await ctx.fetchJson(
        `${ENSEMBL}/homology/id/${species}/${encodeURIComponent(String(geneId))}?${params.join('&')}`
      )) as { data?: { homologies?: Dict[] }[] }
      const all = resp.data?.[0]?.homologies ?? []
      const sorted = all
        .map(leanHomology)
        .sort(
          (x, y) =>
            String(x.species ?? '').localeCompare(String(y.species ?? '')) ||
            String(x.id ?? '').localeCompare(String(y.id ?? ''))
        )
      const homologies = sorted.slice(0, maxHomologies)
      return {
        gene_id: geneId,
        gene_symbol: symbol,
        species,
        homology_type: homologyType,
        target_species: targetSpecies,
        target_taxon: targetTaxon,
        n_total: all.length,
        homologies_truncated: all.length > homologies.length,
        homologies
      }
    }
  },
  {
    id: 'ensembl_sequence',
    connector: 'genomes',
    description:
      'Fetch sequence from Ensembl — by stable ID (gene/transcript/protein) or by genomic region. Pass EITHER stable_id OR region. Args: stable_id (ENSG.../ENST.../ENSP..., versioned accepted); region (1-based inclusive chrom:start..end or chrom:start-end, GRCh38 for human, max 10Mb); species (for region route, default homo_sapiens; ignored for stable IDs); seq_type (ID route: genomic default/cdna/cds/protein; ignored for regions which always return genomic). This tool returns one sequence: for gene-level cdna/cds/protein requests that resolve to multiple sequences, specify a transcript/protein stable ID instead; max_bytes (payload guard default 400000 — larger sequences have `seq` omitted; length/sha256/metadata always returned; re-call with larger max_bytes for full text). Returns {found, query, seq_type, id, description, molecule, length, sha256, seq} — length in the unit implied by molecule (bases for dna, residues for protein); seq replaced by seq_omitted when capped; found:false with null fields only when Ensembl explicitly reports the requested stable ID as not found; multiple-sequence requests, incompatible sequence types, and other upstream failures raise errors.',
    input: {
      type: 'object',
      properties: {
        stable_id: { type: 'string' },
        region: { type: 'string' },
        species: { type: 'string', default: DEFAULT_SPECIES },
        seq_type: {
          type: 'string',
          enum: ['genomic', 'cdna', 'cds', 'protein'],
          default: 'genomic'
        },
        max_bytes: { type: 'integer', default: 400000 }
      }
    },
    returns:
      '{found, query, seq_type, id, description, molecule, length, sha256, seq} — seq replaced by seq_omitted:true when byte length exceeds max_bytes; found:false with null fields only for an explicit upstream ID-not-found response; other failures raise errors.',
    example:
      'const result = await host.mcp("genomes", "ensembl_sequence", {"stable_id": "ENSP00000288602", "seq_type": "protein"})',
    run: async (ctx, a) => {
      const species = String(a.species ?? DEFAULT_SPECIES)
      const maxBytes = clampInt(a.max_bytes, 400000, 1, 1e9)
      const stableId = strArg(a.stable_id)
      const region = strArg(a.region)
      if ((stableId && region) || (!stableId && !region)) {
        throw new Error('ensembl_sequence requires either stable_id or region')
      }
      const seqType = stableId ? String(a.seq_type ?? 'genomic') : 'genomic'
      const query = (stableId ?? region) as string

      let resp: Dict
      if (stableId) {
        const id = upstreamStableId(stableId)
        const { body, status } = await ctx.fetchJsonWithHeaders(
          `${ENSEMBL}/sequence/id/${encodeURIComponent(id)}?type=${encodeURIComponent(seqType)}`,
          { allowHttpStatuses: [400] }
        )
        if (status === 400) {
          const record =
            body && typeof body === 'object' && !Array.isArray(body) ? (body as Dict) : null
          const error = record?.error
          // Ensembl also uses 400 for multiple sequences and incompatible sequence types.
          // Only explicit absence of this exact ID is a negative lookup result.
          if (error === `ID '${id}' not found`) {
            return {
              found: false,
              query,
              seq_type: seqType,
              id: null,
              description: null,
              molecule: null,
              length: 0,
              sha256: null
            }
          }
          if (typeof error === 'string') {
            throw new Error(`Ensembl sequence failed: ${error.slice(0, 1000)}`)
          }
          throw new Error('Ensembl sequence returned an unrecognized HTTP 400 response')
        }
        resp = body as Dict
      } else {
        // Region route: malformed/oversized regions raise the upstream 400 (not caught).
        resp = (await ctx.fetchJson(`${ENSEMBL}/sequence/region/${species}/${region}`)) as Dict
      }

      const seq = String(resp.seq ?? '')
      const base = {
        found: true,
        query,
        seq_type: seqType,
        id: resp.id,
        description: resp.desc,
        molecule: resp.molecule,
        length: seq.length,
        sha256: sha256(seq)
      }
      // Omit the (possibly huge) sequence text past the byte guard; the fingerprint still travels.
      return Buffer.byteLength(seq, 'utf8') > maxBytes
        ? { ...base, seq_omitted: true }
        : { ...base, seq }
    }
  },
  {
    id: 'ensembl_overlap_region',
    connector: 'genomes',
    description:
      'List Ensembl features overlapping a genomic region — genes, transcripts, regulatory features (enhancers/promoters), repeats, variants, karyotype bands. Args: region (1-based inclusive chrom:start-end GRCh38, e.g. 7:140719327-140925199; upstream rejects spans >5Mb — split larger); feature (gene default/transcript/exon/cds/regulatory/motif/repeat/variation/structural_variation/band/simple/misc); species (default homo_sapiens); max_features (row cap default 500; n_total carries the complete overlap count, features_truncated flags the cap). Returns {region, species, feature, n_total, features_truncated, features} sorted by (start,id). Row shape varies — genes {id, external_name, biotype, description, start, end, strand, canonical_transcript, ...}; regulatory {id, description, start, end, extended_start/end, ...}. Empty regions return n_total:0.',
    input: {
      type: 'object',
      properties: {
        region: { type: 'string' },
        feature: {
          type: 'string',
          enum: [
            'gene',
            'transcript',
            'exon',
            'cds',
            'regulatory',
            'motif',
            'repeat',
            'variation',
            'structural_variation',
            'band',
            'simple',
            'misc'
          ],
          default: 'gene'
        },
        species: { type: 'string', default: DEFAULT_SPECIES },
        max_features: { type: 'integer', default: 500 }
      },
      required: ['region']
    },
    required: ['region'],
    returns:
      '{region, species, feature, n_total, features_truncated, features[]} sorted by (start,id); row shape varies by feature type. Empty regions return n_total:0.',
    example:
      'const result = await host.mcp("genomes", "ensembl_overlap_region", {"region": "7:140719327-140925199", "feature": "gene"})',
    run: async (ctx, a) => {
      const region = String(a.region).trim()
      const species = String(a.species ?? DEFAULT_SPECIES)
      const feature = String(a.feature ?? 'gene')
      const maxFeatures = clampInt(a.max_features, 500, 1, 100000)
      // Oversized (>5Mb) or malformed regions raise the upstream 400 (not caught).
      const raw =
        ((await ctx.fetchJson(
          `${ENSEMBL}/overlap/region/${species}/${region}?feature=${encodeURIComponent(feature)}`
        )) as Dict[] | undefined) ?? []
      const sorted = [...raw].sort(
        (x, y) =>
          Number(x.start ?? 0) - Number(y.start ?? 0) || featureId(x).localeCompare(featureId(y))
      )
      const features = sorted.slice(0, maxFeatures)
      return {
        region,
        species,
        feature,
        n_total: raw.length,
        features_truncated: raw.length > features.length,
        features
      }
    }
  }
]
