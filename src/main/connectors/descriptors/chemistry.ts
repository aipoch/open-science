import type { ToolContext, ToolDescriptor } from '../types'

// PubChem PUG REST + PUG-View. Structure/name inputs go via GET query params so slashes and
// other path-reserved characters in SMILES survive intact (the engine only offers GET + JSON POST).
const PUBCHEM = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug'
const PUBCHEM_VIEW = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug_view'
// The 2025 PUG REST property names: `SMILES` is the full (isomeric) SMILES, `ConnectivitySMILES`
// the stereo-stripped one (formerly CanonicalSMILES).
const PUBCHEM_PROPS =
  'MolecularFormula,MolecularWeight,SMILES,ConnectivitySMILES,InChI,InChIKey,IUPACName,XLogP,' +
  'ExactMass,TPSA,Charge,HBondDonorCount,HBondAcceptorCount,RotatableBondCount,HeavyAtomCount'
const PUBCHEM_NAMESPACES = ['name', 'smiles', 'inchikey', 'cid'] as const

// ChEBI's 2024+ website backend: keyless JSON REST (the legacy SOAP service is being retired).
const CHEBI_API = 'https://www.ebi.ac.uk/chebi/backend/api/public'

// Rhea has no plain REST lookup; the DB is served via SPARQL. A GET with `?query=` and an
// `Accept: application/json` header (the engine's fetchJson default) returns
// `application/sparql-results+json` bindings, so every SELECT rides the same fetchJson path.
const RHEA_SPARQL = 'https://sparql.rhea-db.org/sparql'
const RHEA_PREFIXES =
  'PREFIX rh: <http://rdf.rhea-db.org/>\nPREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\n'

const BINDINGDB_API = 'https://bindingdb.org/rest'
const UNIPROT_RE = /^[OPQ][0-9][A-Z0-9]{3}[0-9]$|^[A-NR-Z][0-9]([A-Z][A-Z0-9]{2}[0-9]){1,2}$/i
const CHEBI_ID_RE = /^(?:CHEBI:)?(\d+)$/i
const RHEA_ID_RE = /^(?:RHEA:)?(\d+)$/i
// Query-type detection for rhea_search_reactions: bare/prefixed ChEBI id, then a full EC number.
const EC_FULL_RE = /^\d+\.\d+\.\d+\.n?\d+$/

type CidList = { IdentifierList?: { CID?: number[] } }
type PropRow = Record<string, unknown> & { CID?: number }
type PropTable = { PropertyTable?: { Properties?: PropRow[] } }
type SynonymList = {
  InformationList?: { Information?: Array<{ CID?: number; Synonym?: string[] }> }
}
type AssayTable = {
  Table?: { Columns?: { Column?: string[] }; Row?: Array<{ Cell?: string[] }> }
}

type SparqlBinding = Record<string, { value?: string }>
type SparqlResponse = { results?: { bindings?: SparqlBinding[] } }

// Accept `CHEBI:27732` / `27732` / 27732; return the bare numeric id string.
function normalizeChebiId(id: unknown): string {
  const m = CHEBI_ID_RE.exec(String(id).trim())
  if (!m) throw new Error(`not a ChEBI ID: ${String(id)}`)
  return m[1]
}

// Accept `RHEA:10280` / `10280` / 10280; return `RHEA:10280`.
function normalizeRheaId(id: unknown): string {
  const m = RHEA_ID_RE.exec(String(id).trim())
  if (!m) throw new Error(`not a Rhea ID: ${String(id)}`)
  return `RHEA:${m[1]}`
}

// http://rdf.rhea-db.org/10280_L -> "10280_L"; http://.../Approved -> "Approved".
function localName(uri?: string): string | undefined {
  if (!uri) return undefined
  return uri.replace(/\/$/, '').split(/[/#]/).pop()
}

// The engine surfaces PubChem's "no match" 404 (PUGREST.NotFound) as a generic HTTP 404 error;
// PubChem signals absent records this way, which several tools treat as an empty result, not a throw.
function isNotFound(err: unknown): boolean {
  return err instanceof Error && /\bHTTP 404\b/.test(err.message)
}

// Clamp a listing to `cap`, reporting whether anything was dropped. A non-positive cap means "none".
function capRows<T>(rows: T[], cap: number): { rows: T[]; truncated: boolean } {
  const n = Math.max(0, cap)
  return rows.length > n ? { rows: rows.slice(0, n), truncated: true } : { rows, truncated: false }
}

// Resolve an identifier to PubChem CIDs; a no-match 404 is an empty list, not an error.
async function pubchemSearchCids(
  ctx: ToolContext,
  query: string,
  namespace: string
): Promise<number[]> {
  const q = query.trim()
  const url =
    namespace === 'smiles'
      ? `${PUBCHEM}/compound/smiles/cids/JSON?smiles=${encodeURIComponent(q)}`
      : `${PUBCHEM}/compound/${namespace}/${encodeURIComponent(q)}/cids/JSON`
  try {
    const raw = (await ctx.fetchJson(url)) as CidList
    return raw.IdentifierList?.CID ?? []
  } catch (err) {
    if (isNotFound(err)) return []
    throw err
  }
}

// Computed properties for a batch of CIDs (one request); all-unknown batches 404 -> [].
async function pubchemProperties(ctx: ToolContext, cids: number[]): Promise<PropRow[]> {
  if (!cids.length) return []
  try {
    const raw = (await ctx.fetchJson(
      `${PUBCHEM}/compound/cid/${cids.join(',')}/property/${PUBCHEM_PROPS}/JSON`
    )) as PropTable
    return raw.PropertyTable?.Properties ?? []
  } catch (err) {
    if (isNotFound(err)) return []
    throw err
  }
}

// Run a Rhea SPARQL SELECT and return its raw bindings.
async function rheaSelect(ctx: ToolContext, query: string): Promise<SparqlBinding[]> {
  const raw = (await ctx.fetchJson(
    `${RHEA_SPARQL}?query=${encodeURIComponent(RHEA_PREFIXES + query)}`
  )) as SparqlResponse
  return raw.results?.bindings ?? []
}

// A capped Rhea search plus a companion COUNT query, so `api_total` is the true match count.
async function rheaRunSearch(
  ctx: ToolContext,
  where: string,
  limit: number,
  distinct: boolean
): Promise<{ api_total: number; n_returned: number; truncated: boolean; reactions: unknown[] }> {
  const kw = distinct ? 'DISTINCT ' : ''
  const rows = await rheaSelect(
    ctx,
    `SELECT ${kw}?accession ?equation ?status WHERE {\n${where}\n} ORDER BY ?accession LIMIT ${limit}`
  )
  const countRows = await rheaSelect(
    ctx,
    `SELECT (COUNT(DISTINCT ?accession) AS ?n) WHERE {\n${where}\n}`
  )
  const total = countRows.length ? Number(countRows[0].n?.value ?? 0) : 0
  const reactions = rows.map((r) => ({
    rhea_id: r.accession?.value,
    equation: r.equation?.value,
    status: localName(r.status?.value)
  }))
  return {
    api_total: total,
    n_returned: reactions.length,
    truncated: total > reactions.length,
    reactions
  }
}

// Escape a value for a single-line SPARQL string literal (raw controls are grammar-forbidden).
function sparqlEscape(text: string): string {
  return (
    text
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f]/g, '')
  )
}

// http://rdf.rhea-db.org/contains2 -> "2"; containsN -> "N"; contains2n -> "2n"; contains1 -> "1".
function coefficient(coefPropUri?: string): string {
  return (localName(coefPropUri) ?? '').replace(/^contains/, '') || '1'
}

// Numeric sort key for affinity strings like "10000", ">133000", "<0.5"; missing sorts last.
function affinitySortKey(affinity?: string): number {
  if (!affinity) return Number.POSITIVE_INFINITY
  const m = /[\d.]+(?:[eE][+-]?\d+)?/.exec(affinity)
  const n = m ? Number(m[0]) : NaN
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY
}

const asStr = (v: unknown): string | undefined => {
  if (v == null) return undefined
  const s = String(v).trim()
  return s || undefined
}

// PubChem PUG REST/PUG-View, ChEBI backend API, Rhea SPARQL and BindingDB REST: read-only
// small-molecule chemistry — compounds, similarity, bioassays, safety, ontology, reactions, affinities.
export const CHEMISTRY_TOOLS: ToolDescriptor[] = [
  {
    id: 'pubchem_search_compounds',
    connector: 'chemistry',
    description:
      'Resolve a chemical identifier (name, SMILES, InChIKey, or CID) to PubChem CIDs, optionally with core computed properties for the top hits.',
    input: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Identifier matching `namespace`, e.g. "aspirin", a SMILES, or an InChIKey.'
        },
        namespace: { type: 'string', enum: [...PUBCHEM_NAMESPACES], default: 'name' },
        max_cids: { type: 'integer', default: 25, minimum: 1, maximum: 100 },
        with_properties: { type: 'boolean', default: true }
      },
      required: ['query']
    },
    required: ['query'],
    returns:
      '`{ "query": str, "namespace": str, "n_cids_total": int, "truncated": bool, "cids": [int], "properties": [ {...} ] }` — `n_cids_total` is the full match count, `cids` capped at `max_cids`. `cids` is `[]` when nothing matches (not an error). `properties` rows use PubChem 2025 field names (CID, MolecularFormula, MolecularWeight, `SMILES` = isomeric, `ConnectivitySMILES` = stereo-stripped, InChI, InChIKey, IUPACName, XLogP, ExactMass, TPSA, Charge, H-bond/rotatable-bond/heavy-atom counts).',
    example:
      'result = host.mcp("chemistry", "pubchem_search_compounds", {"query": "aspirin", "max_cids": 25})',
    run: async (ctx, a) => {
      const namespace = String(a.namespace ?? 'name')
      if (!PUBCHEM_NAMESPACES.includes(namespace as (typeof PUBCHEM_NAMESPACES)[number])) {
        throw new Error(`namespace must be one of ${PUBCHEM_NAMESPACES.join(', ')}`)
      }
      const maxCids = Number(a.max_cids ?? 25)
      if (!(maxCids >= 1 && maxCids <= 100)) throw new Error('max_cids must be in [1, 100]')
      const withProperties = a.with_properties !== false

      const allCids = await pubchemSearchCids(ctx, String(a.query), namespace)
      const { rows: cids, truncated } = capRows(allCids, maxCids)
      const properties = withProperties && cids.length ? await pubchemProperties(ctx, cids) : []
      return {
        query: a.query,
        namespace,
        n_cids_total: allCids.length,
        truncated,
        cids,
        properties
      }
    }
  },
  {
    id: 'pubchem_get_compounds',
    connector: 'chemistry',
    description:
      'Full computed-property records for a batch of PubChem CIDs, with optional capped synonym lists.',
    input: {
      type: 'object',
      properties: {
        cids: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 50 },
        include_synonyms: { type: 'boolean', default: false },
        max_synonyms: { type: 'integer', default: 30 }
      },
      required: ['cids']
    },
    required: ['cids'],
    returns:
      '`{ "n_requested": int, "duplicates": [int], "records": [ {...} ], "not_found": [int] }` — one record per distinct CID (repeats disclosed in `duplicates`, first-occurrence order). Each record carries CID, MolecularFormula, MolecularWeight, SMILES (isomeric), ConnectivitySMILES, InChI, InChIKey, IUPACName, XLogP, ExactMass, TPSA, Charge, HBondDonorCount, HBondAcceptorCount, RotatableBondCount, HeavyAtomCount — plus `synonyms`/`n_synonyms_total`/`synonyms_truncated` when `include_synonyms`. CIDs the API does not know appear in `not_found`.',
    example:
      'result = host.mcp("chemistry", "pubchem_get_compounds", {"cids": [2244, 2519], "include_synonyms": False})',
    run: async (ctx, a) => {
      const raw = ([] as unknown[]).concat(a.cids as never).map((c) => Number(c))
      if (!raw.length) throw new Error('cids must be non-empty')
      if (raw.length > 50) throw new Error('at most 50 CIDs per call')

      // One record per distinct CID; repeats are disclosed, not re-emitted.
      const unique = [...new Set(raw)]
      const duplicates = unique.filter((c) => raw.filter((x) => x === c).length > 1)
      const records = await pubchemProperties(ctx, unique)
      const byCid = new Map<number, PropRow>(records.map((r) => [Number(r.CID), { ...r }]))

      if (a.include_synonyms) {
        const maxSyn = Number(a.max_synonyms ?? 30)
        const raw2 = await pubchemSynonyms(ctx, unique)
        for (const [cid, rec] of byCid) {
          const syns = raw2.get(cid) ?? []
          const capped = capRows(syns, maxSyn)
          rec.synonyms = capped.rows
          rec.n_synonyms_total = syns.length
          rec.synonyms_truncated = capped.truncated
        }
      }

      const ordered = unique.filter((c) => byCid.has(c)).map((c) => byCid.get(c)!)
      const notFound = unique.filter((c) => !byCid.has(c))
      return { n_requested: raw.length, duplicates, records: ordered, not_found: notFound }
    }
  },
  {
    id: 'pubchem_similarity_search',
    connector: 'chemistry',
    description:
      '2D Tanimoto similarity search over all of PubChem for a query SMILES (synchronous fastsimilarity_2d route, no job polling).',
    input: {
      type: 'object',
      properties: {
        smiles: { type: 'string' },
        threshold: { type: 'integer', default: 90, minimum: 1, maximum: 100 },
        max_records: { type: 'integer', default: 50, minimum: 1, maximum: 200 },
        with_properties: { type: 'boolean', default: false }
      },
      required: ['smiles']
    },
    required: ['smiles'],
    returns:
      '`{ "smiles": str, "threshold": int, "n_cids": int, "may_be_truncated": bool, "cids": [int], "properties": [ {...} ] }` — CIDs in upstream relevance order (the query compound is usually first). `threshold` is percent Tanimoto. The API does not report an uncapped total, so `may_be_truncated` is true exactly when the cap was filled. `properties` (when `with_properties`) covers the first 10 hits.',
    example:
      'result = host.mcp("chemistry", "pubchem_similarity_search", {"smiles": "CC(=O)OC1=CC=CC=C1C(=O)O", "threshold": 90})',
    run: async (ctx, a) => {
      const smiles = String(a.smiles).trim()
      if (!smiles) throw new Error('smiles must be non-empty')
      const threshold = Number(a.threshold ?? 90)
      if (!(threshold >= 1 && threshold <= 100)) throw new Error('threshold must be in [1, 100]')
      const maxRecords = Number(a.max_records ?? 50)
      if (!(maxRecords >= 1 && maxRecords <= 200))
        throw new Error('max_records must be in [1, 200]')

      let cids: number[]
      try {
        const raw = (await ctx.fetchJson(
          `${PUBCHEM}/compound/fastsimilarity_2d/smiles/cids/JSON?smiles=${encodeURIComponent(smiles)}&Threshold=${threshold}&MaxRecords=${maxRecords}`
        )) as CidList
        cids = raw.IdentifierList?.CID ?? []
      } catch (err) {
        if (isNotFound(err)) cids = []
        else throw err
      }
      const properties =
        a.with_properties && cids.length ? await pubchemProperties(ctx, cids.slice(0, 10)) : []
      return {
        smiles,
        threshold,
        n_cids: cids.length,
        may_be_truncated: cids.length >= maxRecords,
        cids,
        properties
      }
    }
  },
  {
    id: 'pubchem_get_bioassay_summary',
    connector: 'chemistry',
    description:
      'Bioassay activity summary for one PubChem compound — which assays tested it, against which targets, with what outcome and potency.',
    input: {
      type: 'object',
      properties: {
        cid: { type: 'integer' },
        active_only: { type: 'boolean', default: false },
        max_rows: { type: 'integer', default: 100, minimum: 1, maximum: 1000 }
      },
      required: ['cid']
    },
    required: ['cid'],
    returns:
      '`{ "cid": int, "active_only": bool, "n_rows_total": int, "truncated": bool, "rows": [ {...} ] }` — each row maps the upstream columns: AID, SID, CID, "Activity Outcome" (Active/Inactive/Unspecified/Inconclusive), "Target Accession", "Target GeneID", "Activity Value [uM]", "Activity Name", "Assay Name", "Assay Type", "PubMed ID". Filtering by `active_only` happens BEFORE the cap, so `n_rows_total` is the true (filtered) count. `rows` is `[]` for compounds with no assay data (not an error).',
    example:
      'result = host.mcp("chemistry", "pubchem_get_bioassay_summary", {"cid": 2244, "active_only": True})',
    run: async (ctx, a) => {
      const cid = Number(a.cid)
      const maxRows = Number(a.max_rows ?? 100)
      if (!(maxRows >= 1 && maxRows <= 1000)) throw new Error('max_rows must be in [1, 1000]')

      let rows: Array<Record<string, string>>
      try {
        const raw = (await ctx.fetchJson(
          `${PUBCHEM}/compound/cid/${cid}/assaysummary/JSON`
        )) as AssayTable
        const columns = raw.Table?.Columns?.Column ?? []
        rows = (raw.Table?.Row ?? []).map((row) => {
          const cells = row.Cell ?? []
          return Object.fromEntries(columns.map((col, i) => [col, cells[i]]))
        })
      } catch (err) {
        if (isNotFound(err)) rows = []
        else throw err
      }
      const activeOnly = a.active_only === true
      const filtered = activeOnly ? rows.filter((r) => r['Activity Outcome'] === 'Active') : rows
      const { rows: capped, truncated } = capRows(filtered, maxRows)
      return {
        cid,
        active_only: activeOnly,
        n_rows_total: filtered.length,
        truncated,
        rows: capped
      }
    }
  },
  {
    id: 'pubchem_get_safety',
    connector: 'chemistry',
    description:
      "GHS safety classification for one PubChem compound (PUG-View 'GHS Classification' heading), aggregated across reporting sources.",
    input: {
      type: 'object',
      properties: { cid: { type: 'integer' } },
      required: ['cid']
    },
    required: ['cid'],
    returns:
      '`{ "cid": int, "found": bool, "ghs": {...} | null }` — `ghs` is null when PubChem has no GHS section. Otherwise `{ cid, record_title, signals (e.g. ["Danger"]), pictograms (e.g. ["Flammable", "Irritant"]), hazard_statements (H-codes with occurrence percentages), precautionary_statement_codes, notes, n_source_references }`. Percentages in the hazard text show how many indexed sources report each hazard.',
    example: 'result = host.mcp("chemistry", "pubchem_get_safety", {"cid": 702})',
    run: async (ctx, a) => {
      const cid = Number(a.cid)
      let ghs: unknown = null
      try {
        const raw = (await ctx.fetchJson(
          `${PUBCHEM_VIEW}/data/compound/${cid}/JSON?heading=${encodeURIComponent('GHS Classification')}`
        )) as PugViewRecord
        ghs = parseGhs(cid, raw.Record)
      } catch (err) {
        if (!isNotFound(err)) throw err
      }
      return { cid, found: ghs !== null, ghs }
    }
  },
  {
    id: 'chebi_search',
    connector: 'chemistry',
    description: 'Full-text search over ChEBI entities (names, synonyms, formulae, InChIKeys).',
    input: {
      type: 'object',
      properties: {
        term: { type: 'string' },
        max_results: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
        page: { type: 'integer', default: 1, minimum: 1 }
      },
      required: ['term']
    },
    required: ['term'],
    returns:
      '`{ "term": str, "page": int, "size": int, "api_total": int, "number_pages": int, "results": [ {...} ] }` — `api_total` is ChEBI\'s own hit count (further pages exist iff `api_total > page*size`). Each result: chebi_accession, name, definition, stars (3 = manually curated), formula, charge, mass, monoisotopic_mass, smiles, inchikey, relevance.',
    example:
      'result = host.mcp("chemistry", "chebi_search", {"term": "caffeine", "max_results": 20})',
    run: async (ctx, a) => {
      const term = String(a.term).trim()
      if (!term) throw new Error('term must be non-empty')
      const size = Number(a.max_results ?? 20)
      if (!(size >= 1 && size <= 100)) throw new Error('max_results must be in [1, 100]')
      const page = Number(a.page ?? 1)

      const raw = (await ctx.fetchJson(
        `${CHEBI_API}/es_search/?term=${encodeURIComponent(term)}&size=${size}&page=${page}`
      )) as ChebiSearchResponse
      const results = (raw.results ?? []).map((hit) => {
        const s = hit._source ?? {}
        return {
          chebi_accession: s.chebi_accession,
          name: s.name,
          definition: s.definition,
          stars: s.stars,
          formula: s.formula,
          charge: s.charge,
          mass: s.mass,
          monoisotopic_mass: s.monoisotopicmass,
          smiles: s.smiles,
          inchikey: s.inchikey,
          relevance: hit._score
        }
      })
      return {
        term,
        page,
        size,
        api_total: raw.total,
        number_pages: raw.number_pages,
        results
      }
    }
  },
  {
    id: 'chebi_get_entity',
    connector: 'chemistry',
    description:
      'Full ChEBI entity record: names, structure, chemical data, roles and cross-references.',
    input: {
      type: 'object',
      properties: {
        chebi_id: { type: 'string' },
        max_synonyms: { type: 'integer', default: 30 },
        max_xrefs: { type: 'integer', default: 50 }
      },
      required: ['chebi_id']
    },
    required: ['chebi_id'],
    returns:
      '`{ chebi_accession, name, definition, stars, formula, charge, mass, monoisotopic_mass, smiles, inchi, inchikey, iupac_names, synonyms, n_synonyms_total, synonyms_truncated, secondary_ids, xrefs ({type, accession, source, url}), n_xrefs_total, xrefs_truncated, roles ({chebi_accession, name, definition}), modified_on, is_released }` — accepts `CHEBI:27732` or bare `27732`; secondary (merged) ids resolve to the primary record. Ontology parents/children live in `chebi_get_ontology`. Unknown ids throw a not-found error.',
    example: 'result = host.mcp("chemistry", "chebi_get_entity", {"chebi_id": "CHEBI:27732"})',
    run: async (ctx, a) => {
      const num = normalizeChebiId(a.chebi_id)
      const maxSyn = Number(a.max_synonyms ?? 30)
      const maxXrefs = Number(a.max_xrefs ?? 50)

      let raw: ChebiCompound
      try {
        raw = (await ctx.fetchJson(`${CHEBI_API}/compound/${num}/`)) as ChebiCompound
      } catch (err) {
        if (isNotFound(err)) throw new Error(`no ChEBI entity CHEBI:${num}`)
        throw err
      }

      const names = raw.names ?? {}
      const synonyms = (names.SYNONYM ?? []).map((n) => n.name).filter((x): x is string => !!x)
      const iupacNames = (names['IUPAC NAME'] ?? [])
        .map((n) => n.name)
        .filter((x): x is string => !!x)
      const chem = raw.chemical_data ?? {}
      const structure = raw.default_structure ?? {}

      const xrefs: Array<Record<string, unknown>> = []
      for (const type of Object.keys(raw.database_accessions ?? {}).sort()) {
        for (const entry of raw.database_accessions![type]) {
          xrefs.push({
            type,
            accession: entry.accession_number,
            source: entry.source_name,
            url: entry.url
          })
        }
      }
      const roles = (raw.roles_classification ?? []).map((r) => ({
        chebi_accession: r.chebi_accession,
        name: r.name,
        definition: r.definition
      }))

      const synCap = capRows(synonyms, maxSyn)
      const xrefCap = capRows(xrefs, maxXrefs)
      return {
        chebi_accession: raw.chebi_accession,
        name: raw.name,
        definition: raw.definition,
        stars: raw.stars,
        formula: chem.formula,
        charge: chem.charge,
        mass: chem.mass,
        monoisotopic_mass: chem.monoisotopic_mass,
        smiles: structure.smiles,
        inchi: structure.standard_inchi,
        inchikey: structure.standard_inchi_key,
        iupac_names: iupacNames,
        synonyms: synCap.rows,
        n_synonyms_total: synonyms.length,
        synonyms_truncated: synCap.truncated,
        secondary_ids: raw.secondary_ids ?? [],
        xrefs: xrefCap.rows,
        n_xrefs_total: xrefs.length,
        xrefs_truncated: xrefCap.truncated,
        roles,
        modified_on: raw.modified_on,
        is_released: raw.is_released
      }
    }
  },
  {
    id: 'chebi_get_ontology',
    connector: 'chemistry',
    description:
      'Ontology relations of a ChEBI entity — what it IS (outgoing: is a / has role / conjugate acid...) and what points AT it (incoming: children/derivatives).',
    input: {
      type: 'object',
      properties: {
        chebi_id: { type: 'string' },
        relation_type: {
          type: 'string',
          description: 'Optional exact filter, e.g. "is a", "has role", "has part".'
        },
        max_relations: { type: 'integer', default: 100 }
      },
      required: ['chebi_id']
    },
    required: ['chebi_id'],
    returns:
      '`{ chebi_accession, name, relation_type_filter, outgoing_relations, n_outgoing_total, outgoing_truncated, incoming_relations, n_incoming_total, incoming_truncated }` — each relation `{ relation_type, init_chebi_id, init_name, final_chebi_id, final_name }` reads "init --relation--> final" (for outgoing, init is this entity; for incoming, final is this entity). `max_relations` caps per direction.',
    example:
      'result = host.mcp("chemistry", "chebi_get_ontology", {"chebi_id": "CHEBI:27732", "relation_type": "has role"})',
    run: async (ctx, a) => {
      const num = normalizeChebiId(a.chebi_id)
      const maxRel = Number(a.max_relations ?? 100)
      const relFilter = a.relation_type != null ? String(a.relation_type) : null

      let raw: ChebiCompound
      try {
        raw = (await ctx.fetchJson(`${CHEBI_API}/compound/${num}/`)) as ChebiCompound
      } catch (err) {
        if (isNotFound(err)) throw new Error(`no ChEBI entity CHEBI:${num}`)
        throw err
      }

      const rel = raw.ontology_relations ?? {}
      const norm = (r: ChebiRelation): Record<string, unknown> => ({
        relation_type: r.relation_type,
        init_chebi_id: r.init_id,
        init_name: r.init_name,
        final_chebi_id: r.final_id,
        final_name: r.final_name
      })
      let outgoing = (rel.outgoing_relations ?? []).map(norm)
      let incoming = (rel.incoming_relations ?? []).map(norm)
      if (relFilter) {
        outgoing = outgoing.filter((r) => r.relation_type === relFilter)
        incoming = incoming.filter((r) => r.relation_type === relFilter)
      }
      const outCap = capRows(outgoing, maxRel)
      const inCap = capRows(incoming, maxRel)
      return {
        chebi_accession: raw.chebi_accession,
        name: raw.name,
        relation_type_filter: relFilter,
        outgoing_relations: outCap.rows,
        n_outgoing_total: outgoing.length,
        outgoing_truncated: outCap.truncated,
        incoming_relations: inCap.rows,
        n_incoming_total: incoming.length,
        incoming_truncated: inCap.truncated
      }
    }
  },
  {
    id: 'rhea_search_reactions',
    connector: 'chemistry',
    description:
      'Search Rhea master reactions by equation text, participant ChEBI id, or EC number (query type auto-detected).',
    input: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'A ChEBI id (participant), a full EC number (enzyme reactions), or free text matched against the equation.'
        },
        limit: { type: 'integer', default: 50, minimum: 1, maximum: 500 }
      },
      required: ['query']
    },
    required: ['query'],
    returns:
      '`{ "query": str, "query_type": "chebi"|"ec"|"text", "api_total": int, "n_returned": int, "truncated": bool, "reactions": [ { "rhea_id": str, "equation": str, "status": "Approved"|"Preliminary"|"Obsolete" } ] }` — reactions ordered by rhea_id; `api_total` (a companion COUNT query) is the true match count. A ChEBI id matches reactions with that participant; a full EC matches enzyme reactions (partial ECs like "2.1.1.-" are rejected); anything else is a case-insensitive substring match on equation text.',
    example:
      'result = host.mcp("chemistry", "rhea_search_reactions", {"query": "caffeine", "limit": 50})',
    run: async (ctx, a) => {
      const q = String(a.query).trim()
      if (!q) throw new Error('query must be non-empty')
      const limit = Number(a.limit ?? 50)
      if (!(limit >= 1 && limit <= 500)) throw new Error('limit must be in [1, 500]')

      const base = `  ?r rdfs:subClassOf rh:Reaction ; rh:accession ?accession ;\n     rh:equation ?equation ; rh:status ?status`

      const chebiMatch = CHEBI_ID_RE.exec(q)
      if (chebiMatch) {
        const uri = `<http://purl.obolibrary.org/obo/CHEBI_${chebiMatch[1]}>`
        const where =
          `${base} ;\n     rh:side/rh:contains/rh:compound ?c .\n` +
          `  { ?c rh:chebi ${uri} }\n` +
          `  UNION { ?c rh:reactivePart/rh:chebi ${uri} }\n` +
          `  UNION { ?c rh:underlyingChebi ${uri} }`
        const result = await rheaRunSearch(ctx, where, limit, true)
        return { query: q, query_type: 'chebi', ...result }
      }

      if (EC_FULL_RE.test(q)) {
        const where = `${base} ;\n     rh:ec <http://purl.uniprot.org/enzyme/${q}> .`
        const result = await rheaRunSearch(ctx, where, limit, false)
        return { query: q, query_type: 'ec', ...result }
      }

      // Partial/subclass EC notation (e.g. "2.1.1.-") — reject with guidance rather than a
      // confident api_total=0 from a substring search that can never match.
      if (/^\d+\.(?:\d+|-)(?:\.(?:\d+|-)){0,2}$/.test(q)) {
        throw new Error(`not a full EC number: ${q} (partial EC classes are not supported)`)
      }

      const where = `${base} .\n  FILTER(CONTAINS(LCASE(STR(?equation)), "${sparqlEscape(q.toLowerCase())}"))`
      const result = await rheaRunSearch(ctx, where, limit, false)
      return { query: q, query_type: 'text', ...result }
    }
  },
  {
    id: 'rhea_get_reaction',
    connector: 'chemistry',
    description:
      'Full record for one Rhea reaction: equation, participants with ChEBI ids and stoichiometry, EC links, direction family and literature.',
    input: {
      type: 'object',
      properties: { rhea_id: { type: 'string' } },
      required: ['rhea_id']
    },
    required: ['rhea_id'],
    returns:
      '`{ rhea_id, equation, status, is_transport, is_chemically_balanced, ec_numbers, pubmed_ids, directional_reactions, bidirectional_reaction, left_side, right_side }` — each side lists participants `{ compound_accession, name, coefficient }` (coefficient "1", "2", ... or symbolic "N"/"2n"). Accepts `RHEA:10280` or bare `10280`; unknown ids throw a not-found error.',
    example: 'result = host.mcp("chemistry", "rhea_get_reaction", {"rhea_id": "10280"})',
    run: async (ctx, a) => {
      const acc = normalizeRheaId(a.rhea_id)

      const preds = await rheaSelect(
        ctx,
        `SELECT ?p ?o WHERE { ?r rh:accession "${acc}" . ?r ?p ?o . }`
      )
      if (!preds.length) throw new Error(`no Rhea reaction ${acc}`)

      const record: Record<string, unknown> = {
        rhea_id: acc,
        equation: null,
        status: null,
        is_transport: null,
        is_chemically_balanced: null,
        ec_numbers: [] as string[],
        pubmed_ids: [] as string[],
        directional_reactions: [] as string[],
        bidirectional_reaction: null
      }
      for (const row of preds) {
        const p = localName(row.p?.value)
        const o = row.o?.value ?? ''
        if (p === 'equation') record.equation = o
        else if (p === 'status') record.status = localName(o)
        else if (p === 'isTransport') record.is_transport = o === 'true'
        else if (p === 'isChemicallyBalanced') record.is_chemically_balanced = o === 'true'
        else if (p === 'ec') (record.ec_numbers as string[]).push(o.split('/').pop() ?? o)
        else if (p === 'citation') (record.pubmed_ids as string[]).push(o.split('/').pop() ?? o)
        else if (p === 'directionalReaction')
          (record.directional_reactions as string[]).push(`RHEA:${o.split('/').pop()}`)
        else if (p === 'bidirectionalReaction')
          record.bidirectional_reaction = `RHEA:${o.split('/').pop()}`
      }
      ;(record.ec_numbers as string[]).sort()
      ;(record.pubmed_ids as string[]).sort()
      ;(record.directional_reactions as string[]).sort()

      const parts = await rheaSelect(
        ctx,
        `SELECT ?side ?coefProp ?cacc ?cname WHERE {
  ?r rh:accession "${acc}" ; rh:side ?side .
  ?side ?coefProp ?part . ?coefProp rdfs:subPropertyOf rh:contains .
  ?part rh:compound ?c . ?c rh:accession ?cacc .
  OPTIONAL { ?c rh:name ?cname }
}`
      )
      const left: Array<Record<string, unknown>> = []
      const right: Array<Record<string, unknown>> = []
      for (const row of parts) {
        const entry = {
          compound_accession: row.cacc?.value,
          name: row.cname?.value,
          coefficient: coefficient(row.coefProp?.value)
        }
        if (row.side?.value?.endsWith('_L')) left.push(entry)
        else if (row.side?.value?.endsWith('_R')) right.push(entry)
      }
      const byKey = (e: Record<string, unknown>): string =>
        `${(e.compound_accession as string) ?? ''}\u0000${(e.name as string) ?? ''}`
      left.sort((x, y) => byKey(x).localeCompare(byKey(y)))
      right.sort((x, y) => byKey(x).localeCompare(byKey(y)))
      record.left_side = left
      record.right_side = right
      return record
    }
  },
  {
    id: 'bindingdb_ligands_by_target',
    connector: 'chemistry',
    description:
      'Measured binding affinities (Ki/Kd/IC50/EC50) of all BindingDB ligands against one protein target, by UniProt accession.',
    input: {
      type: 'object',
      properties: {
        uniprot: { type: 'string' },
        affinity_cutoff_nm: { type: 'number', default: 10000 },
        max_rows: { type: 'integer', default: 100, minimum: 1, maximum: 1000 }
      },
      required: ['uniprot']
    },
    required: ['uniprot'],
    returns:
      '`{ "uniprot": str, "affinity_cutoff_nm": num, "n_rows_total": int, "truncated": bool, "rows": [ { target_name, monomer_id, smiles, affinity_type, affinity, pmid, doi } ] }` — only measurements with value <= `affinity_cutoff_nm`. The full match set is downloaded and counted, so `n_rows_total` is the true count; rows are capped at `max_rows`, sorted by (affinity_type, numeric affinity ascending). `affinity` is a STRING (may carry `>`/`<`, in nM). No hits returns `n_rows_total=0`.',
    example:
      'result = host.mcp("chemistry", "bindingdb_ligands_by_target", {"uniprot": "P00533", "affinity_cutoff_nm": 100})',
    run: async (ctx, a) => {
      const uniprot = String(a.uniprot).trim().toUpperCase()
      if (!UNIPROT_RE.test(uniprot)) throw new Error(`not a UniProt accession: ${uniprot}`)
      const cutoff = Number(a.affinity_cutoff_nm ?? 10000)
      const maxRows = Number(a.max_rows ?? 100)
      if (!(maxRows >= 1 && maxRows <= 1000)) throw new Error('max_rows must be in [1, 1000]')

      const root = await bindingdbRoot(
        ctx,
        `${BINDINGDB_API}/getLigandsByUniprots?uniprot=${encodeURIComponent(uniprot)}&cutoff=${cutoff}&code=0&response=application/json`
      )
      const rows = ((root.affinities as BindingDbLigandRow[] | undefined) ?? []).map((r) => ({
        target_name: r.query,
        monomer_id: asStr(r.monomerid),
        smiles: r.smile,
        affinity_type: r.affinity_type,
        affinity: asStr(r.affinity),
        pmid: asStr(r.pmid),
        doi: r.doi || undefined
      }))
      rows.sort(
        (x, y) =>
          (x.affinity_type ?? '').localeCompare(y.affinity_type ?? '') ||
          affinitySortKey(x.affinity) - affinitySortKey(y.affinity) ||
          (x.monomer_id ?? '').localeCompare(y.monomer_id ?? '')
      )
      const { rows: capped, truncated } = capRows(rows, maxRows)
      return {
        uniprot,
        affinity_cutoff_nm: cutoff,
        n_rows_total: rows.length,
        truncated,
        rows: capped
      }
    }
  },
  {
    id: 'bindingdb_targets_by_compound',
    connector: 'chemistry',
    description:
      'Protein targets with measured affinities for compounds 2D-similar to a query SMILES — "what does this molecule (or its close analogs) bind?".',
    input: {
      type: 'object',
      properties: {
        smiles: { type: 'string' },
        similarity: { type: 'number', default: 0.85, minimum: 0.5, maximum: 1.0 },
        max_rows: { type: 'integer', default: 100, minimum: 1, maximum: 1000 }
      },
      required: ['smiles']
    },
    required: ['smiles'],
    returns:
      '`{ "smiles": str, "similarity": num, "api_hit_count": int, "n_rows_total": int, "truncated": bool, "rows": [ { monomer_id, smiles, ligand_name, target_name, species, affinity_type, affinity, tanimoto } ] }` — `smiles` per row is the matched analog. `api_hit_count` is the upstream matching-compound count (not row-for-row comparable with `n_rows_total`, which counts per-measurement rows). Rows capped at `max_rows`, sorted by (target_name, affinity_type, numeric affinity). `affinity` is a STRING (may carry `>`/`<`, in nM). No hits returns `n_rows_total=0`.',
    example:
      'result = host.mcp("chemistry", "bindingdb_targets_by_compound", {"smiles": "CC(=O)OC1=CC=CC=C1C(=O)O", "similarity": 0.85})',
    run: async (ctx, a) => {
      const smiles = String(a.smiles).trim()
      if (!smiles) throw new Error('smiles must be non-empty')
      const similarity = Number(a.similarity ?? 0.85)
      if (!(similarity >= 0.5 && similarity <= 1.0))
        throw new Error('similarity must be in [0.5, 1.0]')
      const maxRows = Number(a.max_rows ?? 100)
      if (!(maxRows >= 1 && maxRows <= 1000)) throw new Error('max_rows must be in [1, 1000]')

      const root = await bindingdbRoot(
        ctx,
        `${BINDINGDB_API}/getTargetByCompound?smiles=${encodeURIComponent(smiles)}&cutoff=${similarity}&response=application/json`
      )
      const rows = ((root['bdb.affinities'] as BindingDbTargetRow[] | undefined) ?? []).map(
        (r) => ({
          monomer_id: asStr(r['bdb.monomerid']),
          smiles: r['bdb.smiles'],
          ligand_name: r['bdb.inhibitor'],
          target_name: r['bdb.target'],
          species: r['bdb.species'],
          affinity_type: r['bdb.affinity_type'],
          affinity: asStr(r['bdb.affinity']),
          tanimoto: asStr(r['bdb.tanimoto'])
        })
      )
      rows.sort(
        (x, y) =>
          (x.target_name ?? '').localeCompare(y.target_name ?? '') ||
          (x.affinity_type ?? '').localeCompare(y.affinity_type ?? '') ||
          affinitySortKey(x.affinity) - affinitySortKey(y.affinity) ||
          (x.monomer_id ?? '').localeCompare(y.monomer_id ?? '')
      )
      const hit = asStr(root['bdb.hit'])
      const { rows: capped, truncated } = capRows(rows, maxRows)
      return {
        smiles,
        similarity,
        api_hit_count: hit && /^\d+$/.test(hit) ? Number(hit) : null,
        n_rows_total: rows.length,
        truncated,
        rows: capped
      }
    }
  }
]

// --- PubChem synonyms + GHS (PUG-View) helpers -------------------------------------------------

async function pubchemSynonyms(ctx: ToolContext, cids: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>()
  if (!cids.length) return out
  try {
    const raw = (await ctx.fetchJson(
      `${PUBCHEM}/compound/cid/${cids.join(',')}/synonyms/JSON`
    )) as SynonymList
    for (const info of raw.InformationList?.Information ?? []) {
      if (info.CID != null) out.set(Number(info.CID), info.Synonym ?? [])
    }
  } catch (err) {
    if (!isNotFound(err)) throw err
  }
  return out
}

type PugViewSection = {
  TOCHeading?: string
  Section?: PugViewSection[]
  Information?: Array<{
    Name?: string
    Value?: { StringWithMarkup?: Array<{ String?: string; Markup?: Array<{ Extra?: string }> }> }
  }>
}
type PugViewRecord = {
  Record?: { RecordTitle?: string; Section?: PugViewSection[]; Reference?: unknown[] }
}

function findSection(sections: PugViewSection[], heading: string): PugViewSection | null {
  for (const sec of sections) {
    if (sec.TOCHeading === heading) return sec
    const found = findSection(sec.Section ?? [], heading)
    if (found) return found
  }
  return null
}

function addUnique(acc: string[], item: string): void {
  const trimmed = item.trim()
  if (trimmed && !acc.includes(trimmed)) acc.push(trimmed)
}

// Aggregate the GHS Classification section across every reporting source (None when absent).
function parseGhs(cid: number, record: PugViewRecord['Record']): Record<string, unknown> | null {
  if (!record) return null
  const section = findSection(record.Section ?? [], 'GHS Classification')
  if (!section) return null

  const signals: string[] = []
  const pictograms: string[] = []
  const hazards: string[] = []
  const precautionary: string[] = []
  const notes: string[] = []
  for (const info of section.Information ?? []) {
    const strings = info.Value?.StringWithMarkup ?? []
    if (info.Name === 'Signal') for (const s of strings) addUnique(signals, s.String ?? '')
    else if (info.Name === 'Pictogram(s)')
      for (const s of strings) for (const m of s.Markup ?? []) addUnique(pictograms, m.Extra ?? '')
    else if (info.Name === 'GHS Hazard Statements')
      for (const s of strings) addUnique(hazards, s.String ?? '')
    else if (info.Name === 'Precautionary Statement Codes')
      for (const s of strings) addUnique(precautionary, s.String ?? '')
    else if (info.Name === 'Note') for (const s of strings) addUnique(notes, s.String ?? '')
  }
  return {
    cid,
    record_title: record.RecordTitle,
    signals,
    pictograms,
    hazard_statements: hazards,
    precautionary_statement_codes: precautionary,
    notes,
    n_source_references: (record.Reference ?? []).length
  }
}

// --- ChEBI + BindingDB response types ----------------------------------------------------------

type ChebiName = { name?: string }
type ChebiRelation = {
  relation_type?: string
  init_id?: number
  init_name?: string
  final_id?: number
  final_name?: string
}
type ChebiCompound = {
  chebi_accession?: string
  name?: string
  definition?: string
  stars?: number
  modified_on?: string
  is_released?: boolean
  secondary_ids?: string[]
  names?: Record<string, ChebiName[]>
  chemical_data?: { formula?: string; charge?: number; mass?: string; monoisotopic_mass?: string }
  default_structure?: { smiles?: string; standard_inchi?: string; standard_inchi_key?: string }
  database_accessions?: Record<
    string,
    Array<{ accession_number?: string; source_name?: string; url?: string }>
  >
  ontology_relations?: {
    outgoing_relations?: ChebiRelation[]
    incoming_relations?: ChebiRelation[]
  }
  roles_classification?: Array<{ chebi_accession?: string; name?: string; definition?: string }>
}
type ChebiSearchSource = {
  chebi_accession?: string
  name?: string
  definition?: string
  stars?: number
  formula?: string
  charge?: number
  mass?: number
  monoisotopicmass?: number
  smiles?: string
  inchikey?: string
}
type ChebiSearchResponse = {
  total?: number
  number_pages?: number
  results?: Array<{ _score?: number; _source?: ChebiSearchSource }>
}

type BindingDbLigandRow = {
  query?: string
  monomerid?: string | number
  smile?: string
  affinity_type?: string
  affinity?: string | number
  pmid?: string | number
  doi?: string
}
type BindingDbTargetRow = {
  'bdb.monomerid'?: string | number
  'bdb.smiles'?: string
  'bdb.inhibitor'?: string
  'bdb.target'?: string
  'bdb.species'?: string
  'bdb.affinity_type'?: string
  'bdb.affinity'?: string | number
  'bdb.tanimoto'?: string | number
}

// Unwrap BindingDB's single (often misspelled) route-specific root key without depending on its spelling.
async function bindingdbRoot(ctx: ToolContext, url: string): Promise<Record<string, unknown>> {
  const raw = (await ctx.fetchJson(url)) as Record<string, unknown>
  return (Object.values(raw)[0] as Record<string, unknown>) ?? {}
}
