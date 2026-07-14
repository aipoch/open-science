import type { ToolDescriptor } from '../types'

const UNIPROT = 'https://rest.uniprot.org/uniprotkb'
const MYGENE = 'https://mygene.info/v3/query'
// Explicit fields (mirrors upstream mygene client's "no implicit defaults" convention).
const MYGENE_FIELDS = 'symbol,name,entrezgene,ensembl.gene'
const OLS = 'https://www.ebi.ac.uk/ols4/api'
const REACTOME_CONTENT = 'https://reactome.org/ContentService'

type UniProtEntry = {
  primaryAccession?: string
  proteinDescription?: { recommendedName?: { fullName?: { value?: string } } }
  genes?: Array<{ geneName?: { value?: string } }>
  comments?: Array<{ commentType?: string; texts?: Array<{ value?: string }> }>
}

type MyGeneHit = {
  symbol?: string
  name?: string
  entrezgene?: string
  ensembl?: { gene?: string } | Array<{ gene?: string }>
}

type MyGeneResponse = { hits?: MyGeneHit[] }

// EBI OLS4 v1 term JSON (see `ontologies/{ontology}/terms?obo_id=...`).
type OlsTerm = {
  obo_id?: string
  label?: string
  description?: string[]
  ontology_name?: string
}

type OlsTermsResponse = { _embedded?: { terms?: OlsTerm[] } }

// Reactome ContentService pathway-mapping entry (`data/mapping/{resource}/{id}/pathways`).
type ReactomePathway = {
  stId?: string
  displayName?: string
}

// UniProtKB REST + MyGene.info + EBI OLS4 (GO) + Reactome ContentService: read-only lookups.
export const GENES_TOOLS: ToolDescriptor[] = [
  {
    id: 'uniprot_get_entry',
    connector: 'genes',
    description: 'Get a UniProtKB entry (protein name, gene, function) for an accession.',
    input: {
      type: 'object',
      properties: { accession: { type: 'string' } },
      required: ['accession']
    },
    required: ['accession'],
    returns:
      '`{ "accession": str, "name": str, "gene": str, "function": str }` — any field may be null when the entry lacks it (e.g. no recommended name, gene, or FUNCTION comment).',
    example: 'result = host.mcp("genes", "uniprot_get_entry", {"accession": "P04637"})',
    url: (a) => `${UNIPROT}/${encodeURIComponent(String(a.accession))}.json`,
    parse: (raw) => {
      const entry = raw as UniProtEntry
      const fn = entry.comments?.find((c) => c.commentType === 'FUNCTION')
      return {
        accession: entry.primaryAccession,
        name: entry.proteinDescription?.recommendedName?.fullName?.value,
        gene: entry.genes?.[0]?.geneName?.value,
        function: fn?.texts?.[0]?.value
      }
    }
  },
  {
    id: 'mygene_query',
    connector: 'genes',
    description: 'Resolve a gene symbol to identifiers (Entrez, Ensembl) via MyGene.info.',
    input: {
      type: 'object',
      properties: { symbol: { type: 'string' } },
      required: ['symbol']
    },
    required: ['symbol'],
    returns:
      '`[ { "symbol": str, "name": str, "entrezgene": str, "ensembl": { "gene": str } | [ { "gene": str } ] } ]` — human hits only; `[]` when the symbol resolves to nothing; `ensembl` is an object or array depending on gene count.',
    example: 'result = host.mcp("genes", "mygene_query", {"symbol": "TP53"})',
    url: (a) =>
      `${MYGENE}?q=${encodeURIComponent(String(a.symbol))}&species=human&fields=${MYGENE_FIELDS}`,
    parse: (raw) =>
      ((raw as MyGeneResponse).hits ?? []).map((h) => ({
        symbol: h.symbol,
        name: h.name,
        entrezgene: h.entrezgene,
        ensembl: h.ensembl
      }))
  },
  {
    id: 'go_get_term',
    connector: 'genes',
    description: 'Look up a Gene Ontology term (label, definition) by GO id via EBI OLS4.',
    input: {
      type: 'object',
      properties: { id: { type: 'string', description: 'GO term id, e.g. GO:0006281' } },
      required: ['id']
    },
    required: ['id'],
    returns:
      '`{ "id": str, "label": str, "definition": str, "ontology": str }` — only the first matching OLS4 term is used; all fields are null when the GO id has no term match.',
    example: 'result = host.mcp("genes", "go_get_term", {"id": "GO:0006281"})',
    // OLS4 `obo_id` lookup avoids double-encoding a full term IRI (see upstream ols_terms client).
    url: (a) => `${OLS}/ontologies/go/terms?obo_id=${encodeURIComponent(String(a.id))}`,
    parse: (raw) => {
      const term = (raw as OlsTermsResponse)._embedded?.terms?.[0]
      return {
        id: term?.obo_id,
        label: term?.label,
        definition: term?.description?.[0],
        ontology: term?.ontology_name
      }
    }
  },
  {
    id: 'reactome_pathways_for_gene',
    connector: 'genes',
    description: 'Map a gene symbol or UniProt accession to Reactome pathways via ContentService.',
    input: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'Gene symbol or UniProt accession' },
        resource: {
          type: 'string',
          description: "Reactome identifier resource (default 'UniProt')"
        },
        species: { type: 'string', description: "NCBI taxon id (default '9606', human)" }
      },
      required: ['identifier']
    },
    required: ['identifier'],
    returns:
      '`[ { "pathway_id": str, "name": str } ]` — `[]` when the identifier maps to no Reactome pathways for the given species.',
    example: 'result = host.mcp("genes", "reactome_pathways_for_gene", {"identifier": "P04637"})',
    url: (a) => {
      const resource = a.resource ? String(a.resource) : 'UniProt'
      const species = a.species ? String(a.species) : '9606'
      return `${REACTOME_CONTENT}/data/mapping/${encodeURIComponent(resource)}/${encodeURIComponent(String(a.identifier))}/pathways?species=${encodeURIComponent(species)}`
    },
    parse: (raw) =>
      ((raw as ReactomePathway[]) ?? []).map((p) => ({
        pathway_id: p.stId,
        name: p.displayName
      }))
  }
]
