import type { ToolDescriptor } from '../types'

const PUBCHEM = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug'
const PROPS = 'MolecularFormula,MolecularWeight,CanonicalSMILES,IUPACName'

// ChEBI's 2024+ website backend: keyless JSON REST (the legacy SOAP service is being retired).
const CHEBI_API = 'https://www.ebi.ac.uk/chebi/backend/api/public'

// Rhea has no plain REST lookup; the DB is served via SPARQL. GET with an `Accept: application/
// json` header returns `application/sparql-results+json` bindings, so a single SELECT works
// through the same fetchJson path as every other tool here.
const RHEA_SPARQL = 'https://sparql.rhea-db.org/sparql'
const RHEA_PREFIXES =
  'PREFIX rh: <http://rdf.rhea-db.org/>\nPREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\n'

const BINDINGDB_API = 'https://bindingdb.org/rest'
const UNIPROT_RE = /^[OPQ][0-9][A-Z0-9]{3}[0-9]$|^[A-NR-Z][0-9]([A-Z][A-Z0-9]{2}[0-9]){1,2}$/i
const CHEBI_ID_RE = /^(?:CHEBI:)?(\d+)$/i
const RHEA_ID_RE = /^(?:RHEA:)?(\d+)$/i

type Props = { PropertyTable: { Properties: unknown[] } }

type ChebiCompound = {
  chebi_accession?: string
  name?: string
  definition?: string
  chemical_data?: { formula?: string; charge?: string; mass?: string }
  default_structure?: { smiles?: string; standard_inchi?: string; standard_inchi_key?: string }
}

type SparqlBinding = Record<string, { value?: string }>
type SparqlResponse = { results?: { bindings?: SparqlBinding[] } }

type BindingDbAffinity = {
  query?: string
  monomerid?: string | number
  smile?: string
  affinity_type?: string
  affinity?: string | number
  pmid?: string | number
  doi?: string
}

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

// PubChem PUG REST: read-only compound lookups.
export const CHEMISTRY_TOOLS: ToolDescriptor[] = [
  {
    id: 'pubchem_get_properties',
    connector: 'chemistry',
    description: 'Get molecular properties for one or more PubChem CIDs.',
    input: {
      type: 'object',
      properties: { cids: { type: 'array', items: { type: 'integer' } } },
      required: ['cids']
    },
    required: ['cids'],
    url: (a) =>
      `${PUBCHEM}/compound/cid/${([] as unknown[]).concat(a.cids as never).join(',')}/property/${PROPS}/JSON`,
    parse: (raw) => (raw as Props).PropertyTable.Properties
  },
  {
    id: 'pubchem_search_compounds',
    connector: 'chemistry',
    description: 'Search PubChem compounds by name; returns matched CIDs with properties.',
    input: {
      type: 'object',
      properties: { query: { type: 'string' }, max_cids: { type: 'integer', default: 5 } },
      required: ['query']
    },
    required: ['query'],
    run: async (ctx, a) => {
      const cidRes = (await ctx.fetchJson(
        `${PUBCHEM}/compound/name/${encodeURIComponent(String(a.query))}/cids/JSON`
      )) as {
        IdentifierList?: { CID?: number[] }
      }
      const cids = (cidRes.IdentifierList?.CID ?? []).slice(0, Number(a.max_cids ?? 5))
      if (!cids.length) return { query: a.query, compounds: [] }
      const propRes = (await ctx.fetchJson(
        `${PUBCHEM}/compound/cid/${cids.join(',')}/property/${PROPS}/JSON`
      )) as Props
      return { query: a.query, compounds: propRes.PropertyTable.Properties }
    }
  },
  {
    id: 'chebi_get_entity',
    connector: 'chemistry',
    description: 'Look up a ChEBI ontology entity by ID: name, formula, structure, definition.',
    input: {
      type: 'object',
      properties: { chebi_id: { type: 'string' } },
      required: ['chebi_id']
    },
    required: ['chebi_id'],
    url: (a) => `${CHEBI_API}/compound/${normalizeChebiId(a.chebi_id)}/`,
    parse: (raw) => {
      const c = raw as ChebiCompound
      return {
        chebi_accession: c.chebi_accession,
        name: c.name,
        definition: c.definition,
        formula: c.chemical_data?.formula,
        charge: c.chemical_data?.charge,
        mass: c.chemical_data?.mass,
        smiles: c.default_structure?.smiles,
        inchi: c.default_structure?.standard_inchi,
        inchikey: c.default_structure?.standard_inchi_key
      }
    }
  },
  {
    id: 'rhea_get_reaction',
    connector: 'chemistry',
    description: 'Look up a Rhea reaction by ID: chemical equation and left/right participants.',
    input: {
      type: 'object',
      properties: { rhea_id: { type: 'string' } },
      required: ['rhea_id']
    },
    required: ['rhea_id'],
    run: async (ctx, a) => {
      const acc = normalizeRheaId(a.rhea_id)
      const query = `${RHEA_PREFIXES}SELECT ?equation ?status ?side ?cacc ?cname WHERE {
  ?r rh:accession "${acc}" ; rh:equation ?equation ; rh:status ?status ; rh:side ?side .
  ?side ?coefProp ?part . ?coefProp rdfs:subPropertyOf rh:contains .
  ?part rh:compound ?c . ?c rh:accession ?cacc .
  OPTIONAL { ?c rh:name ?cname }
}`
      const res = (await ctx.fetchJson(
        `${RHEA_SPARQL}?query=${encodeURIComponent(query)}`
      )) as SparqlResponse
      const rows = res.results?.bindings ?? []
      if (!rows.length) throw new Error(`no Rhea reaction ${acc}`)

      const left: Array<{ compound_accession?: string; name?: string }> = []
      const right: Array<{ compound_accession?: string; name?: string }> = []
      for (const row of rows) {
        const entry = { compound_accession: row.cacc?.value, name: row.cname?.value }
        if (row.side?.value?.endsWith('_L')) left.push(entry)
        else if (row.side?.value?.endsWith('_R')) right.push(entry)
      }
      return {
        rhea_id: acc,
        equation: rows[0].equation?.value,
        status: localName(rows[0].status?.value),
        left_side: left,
        right_side: right
      }
    }
  },
  {
    id: 'bindingdb_affinities',
    connector: 'chemistry',
    description:
      'Get BindingDB ligand binding affinities for a UniProt target, filtered to a max affinity (nM).',
    input: {
      type: 'object',
      properties: {
        uniprot: { type: 'string' },
        cutoff_nm: { type: 'integer', default: 1000 }
      },
      required: ['uniprot']
    },
    required: ['uniprot'],
    run: async (ctx, a) => {
      const uniprot = String(a.uniprot).trim().toUpperCase()
      if (!UNIPROT_RE.test(uniprot)) throw new Error(`not a UniProt accession: ${uniprot}`)
      const cutoff = Number(a.cutoff_nm ?? 1000)
      const raw = (await ctx.fetchJson(
        `${BINDINGDB_API}/getLigandsByUniprots?uniprot=${encodeURIComponent(uniprot)}&cutoff=${cutoff}&code=0&response=application/json`
      )) as Record<string, { affinities?: BindingDbAffinity[] }>
      // Response root key is misspelled upstream (getLindsByUniprotsResponse) and varies by
      // route; unwrap by taking the single value rather than depending on the exact spelling.
      const root = Object.values(raw)[0] ?? {}
      const rows = (root.affinities ?? []).map((r) => ({
        target_name: r.query,
        monomer_id: r.monomerid != null ? String(r.monomerid) : undefined,
        smiles: r.smile,
        affinity_type: r.affinity_type,
        affinity: r.affinity != null ? String(r.affinity) : undefined,
        pmid: r.pmid != null ? String(r.pmid) : undefined,
        doi: r.doi
      }))
      return { uniprot, cutoff_nm: cutoff, n_rows: rows.length, affinities: rows }
    }
  }
]
