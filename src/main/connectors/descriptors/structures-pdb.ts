import type { ToolDescriptor } from '../types'

// RCSB PDB search + data REST APIs. The search API (search.rcsb.org) is a POST-only attribute
// query returning identifiers + relevance scores; the data API (data.rcsb.org) serves entry /
// polymer-entity / nonpolymer-entity / chem-comp metadata by id. Metadata only — coordinate files
// (mmCIF/PDB) are never downloaded. Shapes confirmed live against 1TUP.
const SEARCH_URL = 'https://search.rcsb.org/rcsbsearch/v2/query'
const DATA_BASE = 'https://data.rcsb.org/rest/v1/core'
const PAGE_ROWS = 100 // search API page size
const MAX_ROWS_LIMIT = 1000 // hard cap per search call
const PDB_MAX_IDS = 25 // batch ceiling for id lists (entries / polymer entities / ligands)

// exptl.method controlled vocabulary (matched upper-cased); unknown values error with the full list.
const EXPERIMENTAL_METHODS = new Set([
  'X-RAY DIFFRACTION',
  'ELECTRON MICROSCOPY',
  'SOLUTION NMR',
  'SOLID-STATE NMR',
  'NEUTRON DIFFRACTION',
  'ELECTRON CRYSTALLOGRAPHY',
  'FIBER DIFFRACTION',
  'POWDER DIFFRACTION',
  'SOLUTION SCATTERING',
  'EPR',
  'INFRARED SPECTROSCOPY',
  'FLUORESCENCE TRANSFER',
  'THEORETICAL MODEL'
])

// ---- Minimal shapes of the RCSB JSON we read (confirmed live) -------------------------------

type SearchHit = { identifier?: string; score?: number }
type SearchResponse = { total_count?: number; result_set?: SearchHit[] }

type EntryRaw = {
  rcsb_id?: string
  struct?: { title?: string }
  exptl?: Array<{ method?: string }>
  rcsb_entry_info?: {
    resolution_combined?: number[]
    structure_determination_methodology?: string
    molecular_weight?: number
    assembly_count?: number
    polymer_entity_count?: number
    polymer_entity_count_protein?: number
    polymer_entity_count_DNA?: number
    polymer_entity_count_RNA?: number
    nonpolymer_entity_count?: number
    polymer_composition?: string
    nonpolymer_bound_components?: string[]
  }
  rcsb_accession_info?: {
    deposit_date?: string
    initial_release_date?: string
    revision_date?: string
    status_code?: string
  }
  rcsb_entry_container_identifiers?: {
    polymer_entity_ids?: string[]
    non_polymer_entity_ids?: string[]
  }
  rcsb_primary_citation?: {
    title?: string
    rcsb_journal_abbrev?: string
    journal_abbrev?: string
    year?: number
    rcsb_authors?: string[]
    pdbx_database_id_PubMed?: number
    pdbx_database_id_DOI?: string
  }
}

type PolymerEntityRaw = {
  rcsb_id?: string
  rcsb_polymer_entity?: {
    pdbx_description?: string
    pdbx_number_of_molecules?: number
    formula_weight?: number
  }
  rcsb_polymer_entity_container_identifiers?: {
    entry_id?: string
    entity_id?: string
    asym_ids?: string[]
    auth_asym_ids?: string[]
    uniprot_ids?: string[]
    reference_sequence_identifiers?: Array<{
      database_name?: string
      database_accession?: string
      entity_sequence_coverage?: number
      reference_sequence_coverage?: number
    }>
  }
  entity_poly?: {
    rcsb_entity_polymer_type?: string
    type?: string
    rcsb_sample_sequence_length?: number
    rcsb_mutation_count?: number
    pdbx_seq_one_letter_code_can?: string
  }
  rcsb_entity_source_organism?: Array<{ scientific_name?: string; ncbi_taxonomy_id?: number }>
  rcsb_polymer_entity_align?: Array<{
    reference_database_name?: string
    reference_database_accession?: string
    aligned_regions?: unknown[]
  }>
}

type NonpolymerEntityRaw = {
  rcsb_nonpolymer_entity_container_identifiers?: {
    entity_id?: string
    nonpolymer_comp_id?: string
    auth_asym_ids?: string[]
  }
  rcsb_nonpolymer_entity?: { pdbx_description?: string; pdbx_number_of_molecules?: number }
}

type ChemCompRaw = {
  chem_comp?: {
    id?: string
    name?: string
    formula?: string
    formula_weight?: number
    pdbx_formal_charge?: number
    type?: string
  }
  rcsb_chem_comp_descriptor?: { InChIKey?: string; SMILES_stereo?: string; SMILES?: string }
}

// ---- small helpers --------------------------------------------------------------------------

// Reads an integer arg, applying a default when unset and clamping into [lo, hi].
function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  const base = Number.isFinite(n) && v != null && v !== '' ? Math.trunc(n) : def
  return Math.min(hi, Math.max(lo, base))
}

// Trims an arg to a string, or '' when null/undefined.
function asStr(v: unknown): string {
  return v == null ? '' : String(v).trim()
}

// The engine throws `HTTP 404 for <url>` on a data-API 404; treat that (and only that) as not_found.
function isNotFound(err: unknown): boolean {
  return err instanceof Error && /HTTP 404\b/.test(err.message)
}

// Path segment for the data API — percent-encoded so a model-controlled id cannot reshape the path.
function seg(s: string): string {
  return encodeURIComponent(s)
}

// ---- record mappers -------------------------------------------------------------------------

// Entry-level summary. `resolution_angstrom` is the minimum of resolution_combined (null for
// methods like NMR that carry none); citation is null when the entry has no primary citation.
function parseEntry(raw: EntryRaw): Record<string, unknown> {
  const info = raw.rcsb_entry_info ?? {}
  const acc = raw.rcsb_accession_info ?? {}
  const ids = raw.rcsb_entry_container_identifiers ?? {}
  const cit = raw.rcsb_primary_citation
  const resolutions = info.resolution_combined ?? []
  const hasCitation = cit != null && Object.keys(cit).length > 0
  return {
    pdb_id: raw.rcsb_id,
    title: raw.struct?.title,
    experimental_methods: (raw.exptl ?? []).map((e) => e.method),
    resolution_angstrom: resolutions.length ? Math.min(...resolutions) : null,
    resolutions_combined: resolutions,
    structure_determination_methodology: info.structure_determination_methodology,
    deposit_date: acc.deposit_date,
    initial_release_date: acc.initial_release_date,
    revision_date: acc.revision_date,
    status_code: acc.status_code,
    molecular_weight_kda: info.molecular_weight,
    assembly_count: info.assembly_count,
    polymer_entity_count: info.polymer_entity_count,
    polymer_entity_count_protein: info.polymer_entity_count_protein,
    polymer_entity_count_dna: info.polymer_entity_count_DNA,
    polymer_entity_count_rna: info.polymer_entity_count_RNA,
    nonpolymer_entity_count: info.nonpolymer_entity_count,
    polymer_composition: info.polymer_composition,
    ligand_comp_ids: info.nonpolymer_bound_components ?? [],
    polymer_entity_ids: ids.polymer_entity_ids ?? [],
    nonpolymer_entity_ids: ids.non_polymer_entity_ids ?? [],
    citation: hasCitation
      ? {
          title: cit.title,
          journal: cit.rcsb_journal_abbrev ?? cit.journal_abbrev,
          year: cit.year,
          authors: cit.rcsb_authors ?? [],
          pubmed_id: cit.pdbx_database_id_PubMed,
          doi: cit.pdbx_database_id_DOI
        }
      : null
  }
}

// One polymer entity: identity, polymer type, chains, source organisms, and UniProt mappings
// (SIFTS coverage + aligned regions). The one-letter sequence is added only on request.
function parsePolymerEntity(
  raw: PolymerEntityRaw,
  includeSequence: boolean
): Record<string, unknown> {
  const ent = raw.rcsb_polymer_entity ?? {}
  const ids = raw.rcsb_polymer_entity_container_identifiers ?? {}
  const poly = raw.entity_poly ?? {}
  const organisms = raw.rcsb_entity_source_organism ?? []
  const aligns = raw.rcsb_polymer_entity_align ?? []
  const record: Record<string, unknown> = {
    rcsb_id: raw.rcsb_id,
    entry_id: ids.entry_id,
    entity_id: ids.entity_id,
    description: ent.pdbx_description,
    polymer_type: poly.rcsb_entity_polymer_type,
    polymer_type_detail: poly.type,
    sequence_length: poly.rcsb_sample_sequence_length,
    mutation_count: poly.rcsb_mutation_count,
    n_copies_deposited: ent.pdbx_number_of_molecules,
    molecular_weight_kda: ent.formula_weight,
    asym_ids: ids.asym_ids ?? [],
    auth_asym_ids: ids.auth_asym_ids ?? [],
    source_organisms: organisms.map((o) => ({
      scientific_name: o.scientific_name,
      ncbi_taxonomy_id: o.ncbi_taxonomy_id
    })),
    uniprot_ids: ids.uniprot_ids ?? [],
    reference_sequence_identifiers: (ids.reference_sequence_identifiers ?? []).map((r) => ({
      database_name: r.database_name,
      database_accession: r.database_accession,
      entity_sequence_coverage: r.entity_sequence_coverage,
      reference_sequence_coverage: r.reference_sequence_coverage
    })),
    uniprot_aligned_regions: aligns
      .filter((a) => a.reference_database_name === 'UniProt')
      .map((a) => ({ accession: a.reference_database_accession, regions: a.aligned_regions ?? [] }))
  }
  if (includeSequence) record.sequence = poly.pdbx_seq_one_letter_code_can ?? null
  return record
}

// Chemical component detail for a ligand comp id.
function parseChemComp(raw: ChemCompRaw): Record<string, unknown> {
  const comp = raw.chem_comp ?? {}
  const desc = raw.rcsb_chem_comp_descriptor ?? {}
  return {
    comp_id: comp.id,
    name: comp.name,
    formula: comp.formula,
    formula_weight: comp.formula_weight,
    formal_charge: comp.pdbx_formal_charge,
    type: comp.type,
    inchikey: desc.InChIKey,
    smiles: desc.SMILES_stereo ?? desc.SMILES
  }
}

// ---- search query builder -------------------------------------------------------------------

// Builds the search-API query node from the supported filters (all AND together). Throws when no
// criterion is given or when experimental_method is outside the controlled vocabulary.
function buildSearchQuery(a: Record<string, unknown>): Record<string, unknown> {
  const nodes: Record<string, unknown>[] = []
  const textNode = (
    attribute: string,
    operator: string,
    value: unknown
  ): Record<string, unknown> => ({
    type: 'terminal',
    service: 'text',
    parameters: { attribute, operator, value }
  })

  const text = asStr(a.text)
  if (text) nodes.push({ type: 'terminal', service: 'full_text', parameters: { value: text } })

  const organism = asStr(a.organism)
  if (organism)
    nodes.push(
      textNode('rcsb_entity_source_organism.taxonomy_lineage.name', 'exact_match', organism)
    )

  if (a.taxonomy_id != null && asStr(a.taxonomy_id) !== '')
    nodes.push(
      textNode(
        'rcsb_entity_source_organism.ncbi_taxonomy_id',
        'equals',
        clampInt(a.taxonomy_id, 0, 0, 999_999_999)
      )
    )

  const uniprot = asStr(a.uniprot_accession)
  if (uniprot) {
    nodes.push(
      textNode(
        'rcsb_polymer_entity_container_identifiers.reference_sequence_identifiers.database_accession',
        'exact_match',
        uniprot
      )
    )
    nodes.push(
      textNode(
        'rcsb_polymer_entity_container_identifiers.reference_sequence_identifiers.database_name',
        'exact_match',
        'UniProt'
      )
    )
  }

  const method = asStr(a.experimental_method)
  if (method) {
    const up = method.toUpperCase()
    if (!EXPERIMENTAL_METHODS.has(up)) {
      throw new Error(
        `unknown experimental_method '${method}'; one of: ${[...EXPERIMENTAL_METHODS]
          .sort()
          .join(', ')}`
      )
    }
    nodes.push(textNode('exptl.method', 'exact_match', up))
  }

  if (a.max_resolution_angstrom != null && asStr(a.max_resolution_angstrom) !== '') {
    const res = Number(a.max_resolution_angstrom)
    if (Number.isFinite(res))
      nodes.push(textNode('rcsb_entry_info.resolution_combined', 'less_or_equal', res))
  }

  const ligand = asStr(a.ligand_comp_id)
  if (ligand)
    nodes.push(
      textNode(
        'rcsb_nonpolymer_entity_container_identifiers.nonpolymer_comp_id',
        'exact_match',
        ligand.toUpperCase()
      )
    )

  if (nodes.length === 0) {
    throw new Error(
      'at least one search criterion is required (text / organism / taxonomy_id / ' +
        'uniprot_accession / experimental_method / max_resolution_angstrom / ligand_comp_id)'
    )
  }
  if (nodes.length === 1) return nodes[0]
  return { type: 'group', logical_operator: 'and', nodes }
}

// ---- the 4 tools ----------------------------------------------------------------------------

export const STRUCTURES_PDB_TOOLS: ToolDescriptor[] = [
  {
    id: 'pdb_search_structures',
    connector: 'structures',
    description:
      "Search RCSB PDB entries by attribute filters; paged, capped + flagged. All filters AND together; at least one is required. `text` is a full-text relevance query ('p53 DNA binding domain'); `organism` is an exact source-organism lineage name ('Homo sapiens' — matches at any lineage level, so 'Eukaryota' works too); `taxonomy_id` an NCBI taxid (9606); `uniprot_accession` finds entries whose polymer entities map to that UniProt ('P04637' -> every p53 structure); `experimental_method` is the PDB vocabulary ('X-RAY DIFFRACTION', 'ELECTRON MICROSCOPY', 'SOLUTION NMR', ... — case-insensitive, unknown values error with the full list); `max_resolution_angstrom` keeps entries at or below that resolution; `ligand_comp_id` requires a bound nonpolymer component by chem-comp id ('ZN', 'ATP', 'HEM'). include_computed_models=true adds computed structure models (e.g. AlphaFold) to the default experimental-only results. Returns total_count (the API's own match total — ground truth), n_retrieved, truncated (true iff total_count > n_retrieved; max_rows, 1..1000, caps retrieval), and records [{pdb_id, score}] in relevance order. Identifiers only — chain to pdb_get_structures for metadata.",
    input: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        organism: { type: 'string' },
        taxonomy_id: { type: 'integer' },
        uniprot_accession: { type: 'string' },
        experimental_method: { type: 'string' },
        max_resolution_angstrom: { type: 'number' },
        ligand_comp_id: { type: 'string' },
        include_computed_models: { type: 'boolean', default: false },
        max_rows: { type: 'integer', default: 100 }
      }
    },
    returns:
      '{total_count (API match total), n_retrieved, truncated (total_count > n_retrieved), max_rows, records:[{pdb_id, score}]} in relevance order; records is [] when nothing matches.',
    example:
      'result = host.mcp("structures", "pdb_search_structures", {"uniprot_accession": "P04637", "experimental_method": "X-RAY DIFFRACTION", "max_rows": 50})',
    run: async (ctx, a) => {
      const maxRows = clampInt(a.max_rows, 100, 1, MAX_ROWS_LIMIT)
      const query = buildSearchQuery(a)
      const contentTypes =
        a.include_computed_models === true ? ['experimental', 'computational'] : ['experimental']

      const records: Array<{ pdb_id: string | undefined; score: number | null }> = []
      let totalCount = 0
      let start = 0
      // Page the result set, count-verified against the API's own total; stop at the cap or the end.
      for (let guard = 0; guard < MAX_ROWS_LIMIT; guard++) {
        const rows = Math.min(PAGE_ROWS, maxRows - records.length)
        const payload = {
          query,
          return_type: 'entry',
          request_options: {
            paginate: { start, rows },
            results_content_type: contentTypes
          }
        }
        let body: SearchResponse | null
        try {
          body = (await ctx.postJson(SEARCH_URL, payload)) as SearchResponse
        } catch (err) {
          // Zero hits arrive as HTTP 204 (empty body); postJson's .json() then throws a JSON parse
          // error. Treat only that as zero hits — re-throw genuine HTTP/transport failures.
          if (err instanceof SyntaxError) body = null
          else throw err
        }
        if (body == null) {
          totalCount = 0
          break
        }
        totalCount = body.total_count ?? 0
        const page = body.result_set ?? []
        for (const r of page) records.push({ pdb_id: r.identifier, score: r.score ?? null })
        start += page.length
        if (records.length >= Math.min(totalCount, maxRows)) break
        // A short page before the total is reached would loop forever; stop rather than spin.
        if (page.length === 0) break
      }

      return {
        total_count: totalCount,
        n_retrieved: records.length,
        truncated: totalCount > records.length,
        max_rows: maxRows,
        records
      }
    }
  },
  {
    id: 'pdb_get_structures',
    connector: 'structures',
    description:
      'Fetch entry-level summaries for PDB entries (batch, max 25 ids). Accepts 4-character PDB ids in any case (\'1tup\' == \'1TUP\'; duplicates are de-duplicated). Each record: title, experimental methods, resolution in Angstrom (null for methods without one, e.g. NMR), determination methodology (experimental vs computational), deposit/release/revision dates and status, molecular weight (kDa), assembly and entity counts (protein/DNA/RNA polymer + nonpolymer), bound ligand chem-comp ids, polymer/nonpolymer entity id lists (inputs for pdb_get_entities / pdb_get_ligands), and the primary citation (title, journal, year, authors, PubMed id, DOI). Unknown ids come back as {"pdb_id", "error": "not_found"} — never silently dropped. Metadata only; coordinate files are never downloaded.',
    input: {
      type: 'object',
      properties: { pdb_ids: { type: 'array', items: { type: 'string' } } },
      required: ['pdb_ids']
    },
    required: ['pdb_ids'],
    returns:
      '{n_requested, n_unique, n_blank_skipped, n_duplicate_skipped, records:[{pdb_id, title, experimental_methods, resolution_angstrom, ..., polymer_entity_ids, nonpolymer_entity_ids, citation} | {pdb_id, error:"not_found"}]}.',
    example:
      'result = host.mcp("structures", "pdb_get_structures", {"pdb_ids": ["1TUP", "1tup", "6XYZ"]})',
    run: async (ctx, a) => {
      const rawIds = Array.isArray(a.pdb_ids) ? (a.pdb_ids as unknown[]) : []
      // Blank-strip + case-insensitive dedupe BEFORE the cap: a batch whose raw count exceeds the
      // cap but whose unique count is within it (overlapping id lists) must not be rejected.
      const cleaned: string[] = []
      const seen = new Set<string>()
      let nBlank = 0
      let nDuplicate = 0
      for (const raw of rawIds) {
        const pid = asStr(raw)
        if (!pid) nBlank++
        else if (seen.has(pid.toUpperCase())) nDuplicate++
        else {
          seen.add(pid.toUpperCase())
          cleaned.push(pid)
        }
      }
      if (cleaned.length > PDB_MAX_IDS) {
        throw new Error(
          `${cleaned.length} unique ids requested; max ${PDB_MAX_IDS} per call — split the batch`
        )
      }

      const records: Record<string, unknown>[] = []
      for (const id of cleaned) {
        const upper = id.toUpperCase()
        try {
          const raw = (await ctx.fetchJson(`${DATA_BASE}/entry/${seg(upper)}`)) as EntryRaw
          records.push(parseEntry(raw))
        } catch (err) {
          if (isNotFound(err)) records.push({ pdb_id: upper, error: 'not_found' })
          else throw err
        }
      }

      return {
        n_requested: rawIds.length,
        n_unique: cleaned.length,
        n_blank_skipped: nBlank,
        n_duplicate_skipped: nDuplicate,
        records
      }
    }
  },
  {
    id: 'pdb_get_entities',
    connector: 'structures',
    description:
      'Polymer entity details for one PDB entry, incl. UniProt mappings. With entity_ids=null every polymer entity of the entry is fetched, capped at 25 with truncated=true and n_polymer_entities reporting the entry\'s true count (large assemblies like ribosomes carry 50+ — get the full id list from pdb_get_structures\' polymer_entity_ids and page with explicit subsets like ["26", "27"]); with an explicit entity_ids subset the entry total is not fetched, so n_polymer_entities is null; an explicit entity_ids list larger than 25 errors. Each record: description, polymer type (Protein / DNA / RNA), sequence length, mutation count, deposited copies, chain ids (asym + author), source organisms with taxids, UniProt accessions with per-entity sequence coverage (SIFTS), and UniProt-aligned regions (entity-seq vs reference-seq coordinates). Unknown entity ids are listed in not_found; an unknown entry id errors. include_sequences=true adds the canonical one-letter sequence per entity; if the combined sequences exceed max_bytes (default 400000) they are omitted and sequences_omitted explains why — metadata always survives.',
    input: {
      type: 'object',
      properties: {
        pdb_id: { type: 'string' },
        entity_ids: { type: 'array', items: { type: 'string' } },
        include_sequences: { type: 'boolean', default: false },
        max_bytes: { type: 'integer', default: 400000 }
      },
      required: ['pdb_id']
    },
    required: ['pdb_id'],
    returns:
      '{pdb_id, n_polymer_entities (entry total when entity_ids=null, else null), polymer_entity_ids, truncated, records:[{rcsb_id, entity_id, description, polymer_type, sequence_length, source_organisms, uniprot_ids, reference_sequence_identifiers, uniprot_aligned_regions, sequence?}], not_found:[...], sequences_omitted?}.',
    example:
      'result = host.mcp("structures", "pdb_get_entities", {"pdb_id": "1TUP", "include_sequences": True})',
    run: async (ctx, a) => {
      const pdbId = asStr(a.pdb_id).toUpperCase()
      const includeSequences = a.include_sequences === true
      const maxBytes = clampInt(a.max_bytes, 400_000, 1, 100_000_000)

      let allIds: string[]
      let nPolymerEntities: number | null
      if (a.entity_ids == null) {
        // No subset: resolve the entry's full polymer-entity id list (unknown entry -> 404 throw).
        const entry = (await ctx.fetchJson(`${DATA_BASE}/entry/${seg(pdbId)}`)) as EntryRaw
        const ids = entry.rcsb_entry_container_identifiers?.polymer_entity_ids ?? []
        allIds = ids
        nPolymerEntities = ids.length
      } else {
        allIds = (a.entity_ids as unknown[]).map((e) => asStr(e)).filter(Boolean)
        if (allIds.length > PDB_MAX_IDS) {
          throw new Error(
            `${allIds.length} polymer entities requested; max ${PDB_MAX_IDS} per call — pass an explicit entity_ids subset`
          )
        }
        // An explicit subset says nothing about the entry's total, so n_polymer_entities is null.
        nPolymerEntities = null
      }
      const useIds = allIds.slice(0, PDB_MAX_IDS)

      const records: Record<string, unknown>[] = []
      const notFound: string[] = []
      for (const eid of useIds) {
        try {
          const raw = (await ctx.fetchJson(
            `${DATA_BASE}/polymer_entity/${seg(pdbId)}/${seg(eid)}`
          )) as PolymerEntityRaw
          records.push(parsePolymerEntity(raw, includeSequences))
        } catch (err) {
          if (isNotFound(err)) notFound.push(eid)
          else throw err
        }
      }

      const out: Record<string, unknown> = {
        pdb_id: pdbId,
        n_polymer_entities: nPolymerEntities,
        polymer_entity_ids: useIds,
        truncated: allIds.length > useIds.length,
        records,
        not_found: notFound
      }
      if (includeSequences) {
        // Drop sequences wholesale if the combined byte size would blow the budget; metadata stays.
        const encoder = new TextEncoder()
        const total = records.reduce(
          (sum, r) => sum + encoder.encode(typeof r.sequence === 'string' ? r.sequence : '').length,
          0
        )
        if (total > maxBytes) {
          for (const r of records) delete r.sequence
          out.sequences_omitted = `combined sequences are ${total} bytes > max_bytes=${maxBytes}; re-call with fewer entity_ids or a larger max_bytes`
        }
      }
      return out
    }
  },
  {
    id: 'pdb_get_ligands',
    connector: 'structures',
    description:
      "Bound ligands (nonpolymer components) of one PDB entry, with chemistry. Walks the entry's nonpolymer entities and resolves each chemical component: per ligand — entity id, chem-comp id ('ZN', 'ATP'), description, deposited copy count, author chain ids, and a chem_comp block (name, formula, formula weight, formal charge, component type, InChIKey, stereo SMILES). Waters are not nonpolymer entities in the PDB data model and never appear. Entries with no ligands return ligands: []. n_nonpolymer_entities is the entry's true count; truncated=true when it exceeds max_ligands (clamped to 1..25, which bounds the request budget) — never silently dropped. Entities/components the data API no longer serves are reported inline with \"error\": \"not_found\" (partial results, not an aborted call). An unknown entry id errors.",
    input: {
      type: 'object',
      properties: {
        pdb_id: { type: 'string' },
        max_ligands: { type: 'integer', default: 25 }
      },
      required: ['pdb_id']
    },
    required: ['pdb_id'],
    returns:
      '{pdb_id, n_nonpolymer_entities (entry total), n_returned, truncated, ligands:[{entity_id, comp_id, description, n_copies_deposited, auth_asym_ids, chem_comp:{name, formula, formula_weight, inchikey, smiles, ...} | {comp_id, error:"not_found"} | null} | {entity_id, comp_id:null, error:"not_found", chem_comp:null}]}.',
    example: 'result = host.mcp("structures", "pdb_get_ligands", {"pdb_id": "1TUP"})',
    run: async (ctx, a) => {
      const pdbId = asStr(a.pdb_id).toUpperCase()
      const maxLigands = clampInt(a.max_ligands, PDB_MAX_IDS, 1, PDB_MAX_IDS)

      // Unknown entry -> 404 throw; a valid entry with no ligands yields an empty id list.
      const entry = (await ctx.fetchJson(`${DATA_BASE}/entry/${seg(pdbId)}`)) as EntryRaw
      const npIds = entry.rcsb_entry_container_identifiers?.non_polymer_entity_ids ?? []
      const useIds = npIds.slice(0, maxLigands)

      const entities: Array<Record<string, unknown> & { comp_id: string | null }> = []
      for (const eid of useIds) {
        try {
          const raw = (await ctx.fetchJson(
            `${DATA_BASE}/nonpolymer_entity/${seg(pdbId)}/${seg(eid)}`
          )) as NonpolymerEntityRaw
          const ids = raw.rcsb_nonpolymer_entity_container_identifiers ?? {}
          const ent = raw.rcsb_nonpolymer_entity ?? {}
          entities.push({
            entity_id: ids.entity_id,
            comp_id: ids.nonpolymer_comp_id ?? null,
            description: ent.pdbx_description,
            n_copies_deposited: ent.pdbx_number_of_molecules,
            auth_asym_ids: ids.auth_asym_ids ?? []
          })
        } catch (err) {
          if (isNotFound(err)) entities.push({ entity_id: eid, comp_id: null, error: 'not_found' })
          else throw err
        }
      }

      // Resolve each distinct comp id once; unavailable components are tagged not_found inline.
      const compIds = [
        ...new Set(entities.map((e) => e.comp_id).filter((c): c is string => !!c))
      ].sort()
      const comps = new Map<string, Record<string, unknown>>()
      for (const compId of compIds) {
        try {
          const raw = (await ctx.fetchJson(`${DATA_BASE}/chemcomp/${seg(compId)}`)) as ChemCompRaw
          comps.set(compId, parseChemComp(raw))
        } catch (err) {
          if (isNotFound(err)) comps.set(compId, { comp_id: compId, error: 'not_found' })
          else throw err
        }
      }

      const ligands = entities.map((e) => ({
        ...e,
        chem_comp: e.comp_id ? (comps.get(e.comp_id) ?? null) : null
      }))

      return {
        pdb_id: pdbId,
        n_nonpolymer_entities: npIds.length,
        n_returned: ligands.length,
        truncated: npIds.length > useIds.length,
        ligands
      }
    }
  }
]
