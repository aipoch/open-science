import { createHash } from 'node:crypto'
import type { ToolDescriptor } from '../types'

// Ensembl REST — keyless GETs; the engine already sends Accept: application/json for fetchJson, so
// plain paths return JSON without the ?content-type suffix.
const ENSEMBL = 'https://rest.ensembl.org'
const DEFAULT_SPECIES = 'homo_sapiens'

// A TRUE Ensembl stable id: ENS + optional 3-4 letter species code + a feature letter [EGTP] + a
// >=6-digit block (optionally .version), OR an LRG_N id. Symbols merely STARTING with "ENS" (ENSA,
// ENSAP1) fail the digit block and route to the symbol endpoint instead.
const STABLE_ID_RE = /^(ENS([A-Z]{3,4})?[EGTP]\d{6,}(\.\d+)?|LRG_\d+)$/

const isStableId = (query: string): boolean => STABLE_ID_RE.test(query.trim())

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

// hex sha256 of a string (used to fingerprint sequences even when the text is omitted).
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

// A non-empty string arg, or null when unset/blank.
const strArg = (v: unknown): string | null =>
  v != null && String(v).trim() !== '' ? String(v).trim() : null

// VEP impact severity ranking (HIGH > MODERATE > LOW > MODIFIER).
const IMPACT_RANK: Record<string, number> = { HIGH: 4, MODERATE: 3, LOW: 2, MODIFIER: 1 }
const impactRank = (impact: unknown): number => IMPACT_RANK[String(impact ?? '').toUpperCase()] ?? 0

type Dict = Record<string, unknown>

// One VEP transcript-consequence row, keeping only the fields the summary surfaces.
function leanTranscriptConsequence(tc: Dict): Dict {
  return {
    transcript_id: tc.transcript_id,
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

  // Per-gene worst impact + transcript count across the complete (un-truncated) list.
  const geneMap = new Map<
    string,
    { gene_id: unknown; gene_symbol: unknown; worstRank: number; worst_impact: unknown; n: number }
  >()
  for (const tc of tcs) {
    const gid = String(tc.gene_id ?? '')
    const rank = impactRank(tc.impact)
    const existing = geneMap.get(gid)
    if (!existing) {
      geneMap.set(gid, {
        gene_id: tc.gene_id,
        gene_symbol: tc.gene_symbol,
        worstRank: rank,
        worst_impact: tc.impact,
        n: 1
      })
    } else {
      existing.n += 1
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
      n_transcripts: g.n
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
    id: 'ensembl_lookup',
    connector: 'genomes',
    description:
      'Look up an Ensembl gene/transcript/protein by stable ID or a gene by symbol; returns the core annotation record (location, biotype, canonical transcript, description). Args: query (Ensembl stable ID ENSG.../ENST.../ENSP..., versioned accepted; or a gene symbol/alias like BRAF — true stable IDs [ENS + optional species code + feature letter + >=6-digit block, or LRG_N] route to the ID endpoint; everything else, incl. symbols starting with "ENS" like ENSA, to the symbol endpoint); species (Ensembl species name for symbol lookups, default homo_sapiens; ignored for stable IDs); expand (include the child feature tree — a gene\'s transcripts/exons/translation; default off). Returns {found, query, species, record}; record is null when nothing matches, else the upstream lookup dict — for a gene {id, display_name, description, biotype, object_type, seq_region_name, start, end, strand, assembly_name, canonical_transcript, version, ...} with 1-based inclusive coordinates.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        species: { type: 'string', default: DEFAULT_SPECIES },
        expand: { type: 'boolean', default: false }
      },
      required: ['query']
    },
    required: ['query'],
    returns:
      '{found, query, species, record} — record is the upstream lookup dict (1-based inclusive coords) or null when nothing matches.',
    example: 'const result = await host.mcp("genomes", "ensembl_lookup", {"query": "BRAF"})',
    run: async (ctx, a) => {
      const query = String(a.query).trim()
      const species = String(a.species ?? DEFAULT_SPECIES)
      const expand = a.expand === true ? 1 : 0
      const url = isStableId(query)
        ? `${ENSEMBL}/lookup/id/${encodeURIComponent(query)}?expand=${expand}`
        : `${ENSEMBL}/lookup/symbol/${encodeURIComponent(species)}/${encodeURIComponent(query)}?expand=${expand}`
      try {
        const record = await ctx.fetchJson(url)
        return { found: true, query, species, record }
      } catch (err) {
        if (isNotFound(err)) return { found: false, query, species, record: null }
        throw err
      }
    }
  },
  {
    id: 'ensembl_xrefs',
    connector: 'genomes',
    description:
      'External cross-references of an Ensembl stable ID — the bridge from Ensembl gene/transcript IDs to HGNC, NCBI (EntrezGene), UniProt, OMIM, RefSeq, Expression Atlas and others. Args: stable_id (ENSG.../ENST...); external_db (optional exact upstream database-name filter, e.g. HGNC, EntrezGene, Uniprot_gn, MIM_GENE, RefSeq_mRNA; omit for all). Returns {stable_id, external_db, n_xrefs, xrefs} — the COMPLETE list (never truncated), sorted by (dbname, primary_id); each row {dbname, db_display_name, primary_id, display_id, description, synonyms, info_type}. Unknown IDs return n_xrefs:0.',
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
      const url = `${ENSEMBL}/xrefs/id/${encodeURIComponent(stableId)}?external_db=${encodeURIComponent(externalDb)}`
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
      'Predict variant consequences with Ensembl VEP — most-severe-first summary of the (often huge) per-transcript consequence list. Pass EITHER variant_id OR region+allele. Args: variant_id (dbSNP rsID rs7412, COSMIC COSV..., or HGMD ID); region (GRCh38 1-based inclusive chrom:start-end, e.g. 7:140753336-140753336; SNV start==end; insertion start=end+1; explicit strand suffix :1/:-1 accepted); allele (variant allele on forward strand for the region route, e.g. T or - for deletion); species (default homo_sapiens); max_consequences (cap on returned per-transcript rows, default 25; full count in n_transcript_consequences, rows kept are most severe HIGH>MODERATE>LOW>MODIFIER; transcript_consequences_truncated flags the cap). Returns {query, n_results, results:[{input, assembly_name, seq_region_name, start, end, strand, allele_string, most_severe_consequence, genes:[{gene_id, gene_symbol, worst_impact, n_transcripts}], n_transcript_consequences, transcript_consequences_truncated, transcript_consequences:[...], n_regulatory_feature_consequences, n_motif_feature_consequences, colocated_variants:[...]}]}. Unknown rsIDs raise with the upstream message.',
    input: {
      type: 'object',
      properties: {
        variant_id: { type: 'string' },
        region: { type: 'string' },
        allele: { type: 'string' },
        species: { type: 'string', default: DEFAULT_SPECIES },
        max_consequences: { type: 'integer', default: 25 }
      }
    },
    returns:
      '{query, n_results, results[]} — each result the most-severe-first VEP summary (per-transcript rows sorted HIGH>MODERATE>LOW>MODIFIER and capped, plus per-gene worst impact and colocated variants).',
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
      if (variantId) {
        url = `${ENSEMBL}/vep/${species}/id/${encodeURIComponent(variantId)}`
        query = variantId
      } else if (region && allele) {
        url = `${ENSEMBL}/vep/${species}/region/${region}/${encodeURIComponent(allele)}`
        query = `${region} ${allele}`
      } else {
        throw new Error('ensembl_vep_variant requires either variant_id or both region and allele')
      }
      const raw = ((await ctx.fetchJson(url)) as Dict[] | undefined) ?? []
      const results = raw.map((r) => summarizeVepResult(r, maxConsequences))
      return { query, n_results: results.length, results }
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
      'Fetch sequence from Ensembl — by stable ID (gene/transcript/protein) or by genomic region. Pass EITHER stable_id OR region. Args: stable_id (ENSG.../ENST.../ENSP...); region (1-based inclusive chrom:start..end or chrom:start-end, GRCh38 for human, max 10Mb); species (for region route, default homo_sapiens; ignored for stable IDs); seq_type (ID route: genomic default/cdna/cds/protein — protein only for ENST/ENSP; ignored for regions which always return genomic); max_bytes (payload guard default 400000 — larger sequences have `seq` omitted; length/sha256/metadata always returned; re-call with larger max_bytes for full text). Returns {found, query, seq_type, id, description, molecule, length, sha256, seq} — length in the unit implied by molecule (bases for dna, residues for protein); seq replaced by seq_omitted when capped; found:false with null fields for unknown stable IDs; malformed/oversized regions raise with the upstream message.',
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
      '{found, query, seq_type, id, description, molecule, length, sha256, seq} — seq replaced by seq_omitted:true when byte length exceeds max_bytes; found:false with null fields for unknown stable IDs.',
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
        try {
          resp = (await ctx.fetchJson(
            `${ENSEMBL}/sequence/id/${encodeURIComponent(stableId)}?type=${encodeURIComponent(seqType)}`
          )) as Dict
        } catch (err) {
          if (isNotFound(err)) {
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
          throw err
        }
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
