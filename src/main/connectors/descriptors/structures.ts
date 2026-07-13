import type { ToolDescriptor } from '../types'

const PDB_DATA = 'https://data.rcsb.org/rest/v1/core'
const ALPHAFOLD = 'https://alphafold.ebi.ac.uk/api/prediction'
const INTACT_WS = 'https://www.ebi.ac.uk/intact/ws'
// A gene/protein query can hit thousands of interactions (e.g. TP53 ~4400) — bound the response
// like gnomad's variant listing does, rather than returning every row unbounded.
const INTACT_DEFAULT_LIMIT = 25

// RCSB data API core/entry shape (confirmed live against 1TUP — resolution_combined is an
// array, e.g. [2.2]; exptl is an array of methods, one entry per experiment).
type PdbEntry = {
  rcsb_id?: string
  struct?: { title?: string }
  exptl?: Array<{ method?: string }>
  rcsb_entry_info?: { resolution_combined?: number[] }
}

// AlphaFold DB prediction API response: an array of model records (confirmed live against
// P04637); field names are camelCase, not the "meanPlddt" guess — the confidence score is
// globalMetricValue.
type AlphaFoldModel = {
  uniprotAccession?: string
  pdbUrl?: string
  cifUrl?: string
  globalMetricValue?: number
}

// IntAct search endpoint (interaction/findInteractionWithFacet) response shape — transcribed from
// the upstream intact_interactions client (core.py: SEARCH_PATH + slim_record). The service
// accepts the query params on the URL even though the HTTP method is POST (no request body).
type IntActRawRecord = {
  ac?: string
  binaryInteractionId?: number
  idA?: string
  idB?: string
  moleculeA?: string
  moleculeB?: string
  type?: string
  typeMIIdentifier?: string
  detectionMethod?: string
  detectionMethodMIIdentifier?: string
  intactMiscore?: number
  publicationPubmedIdentifier?: string
}

type IntActSearchResponse = {
  data?: { totalElements?: number; content?: IntActRawRecord[] }
}

// Strips the ' (databasename)' suffix IntAct appends to participant identifiers, e.g.
// 'P04637 (uniprotkb)' -> 'P04637' (mirrors the upstream _strip_db_suffix).
function stripIntactDbSuffix(identifier: string | undefined): string | undefined {
  if (!identifier) return identifier
  const idx = identifier.indexOf(' (')
  return idx === -1 ? identifier : identifier.slice(0, idx)
}

// RCSB PDB data API + AlphaFold DB prediction API + EBI IntAct molecular-interactions API:
// read-only 3D structure and interaction lookups.
export const STRUCTURES_TOOLS: ToolDescriptor[] = [
  {
    id: 'pdb_get_entry',
    connector: 'structures',
    description: 'Get an experimental PDB entry (title, method, resolution) by PDB id.',
    input: {
      type: 'object',
      properties: { pdb_id: { type: 'string' } },
      required: ['pdb_id']
    },
    required: ['pdb_id'],
    url: (a) => `${PDB_DATA}/entry/${encodeURIComponent(String(a.pdb_id).trim().toUpperCase())}`,
    parse: (raw) => {
      const entry = raw as PdbEntry
      return {
        pdb_id: entry.rcsb_id,
        title: entry.struct?.title,
        method: entry.exptl?.[0]?.method,
        resolution: entry.rcsb_entry_info?.resolution_combined?.[0]
      }
    }
  },
  {
    id: 'alphafold_get',
    connector: 'structures',
    description:
      'Get the AlphaFold predicted model (model/CIF URLs, mean pLDDT) for a UniProt accession.',
    input: {
      type: 'object',
      properties: { uniprot_accession: { type: 'string' } },
      required: ['uniprot_accession']
    },
    required: ['uniprot_accession'],
    url: (a) => `${ALPHAFOLD}/${encodeURIComponent(String(a.uniprot_accession).trim())}`,
    parse: (raw) => {
      const model = ((raw as AlphaFoldModel[]) ?? [])[0] ?? {}
      return {
        uniprot: model.uniprotAccession,
        model_url: model.pdbUrl,
        cif_url: model.cifUrl,
        mean_plddt: model.globalMetricValue
      }
    }
  },
  {
    id: 'intact_interactions',
    connector: 'structures',
    description:
      'Molecular interactions for a protein/gene from EBI IntAct (interactor pair, interaction type, detection method, MI score), MI-score filtered.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        min_mi_score: { type: 'number', default: 0 },
        limit: { type: 'integer', default: INTACT_DEFAULT_LIMIT }
      },
      required: ['query']
    },
    required: ['query'],
    run: async (ctx, a) => {
      const query = String(a.query)
      const minMiScore = Number(a.min_mi_score ?? 0)
      const limit = Number(a.limit ?? INTACT_DEFAULT_LIMIT)
      // IntAct's search endpoint takes its params as a URL query string even on POST (matches
      // the upstream client, which passes them via httpx's `params=` on a POST request).
      const params = new URLSearchParams({
        query,
        minMIScore: String(minMiScore),
        maxMIScore: '1',
        pageSize: String(limit),
        page: '0'
      })
      const result = (await ctx.postJson(
        `${INTACT_WS}/interaction/findInteractionWithFacet?${params.toString()}`,
        undefined
      )) as IntActSearchResponse

      const content = result.data?.content ?? []
      const interactions = content.map((r) => ({
        interactor_a: stripIntactDbSuffix(r.idA),
        interactor_b: stripIntactDbSuffix(r.idB),
        molecule_a: r.moleculeA,
        molecule_b: r.moleculeB,
        interaction_type: r.type,
        interaction_type_mi: r.typeMIIdentifier,
        detection_method: r.detectionMethod,
        detection_method_mi: r.detectionMethodMIIdentifier,
        mi_score: r.intactMiscore,
        pubmed_id: r.publicationPubmedIdentifier
      }))

      return {
        query,
        total_elements: result.data?.totalElements ?? interactions.length,
        returned: interactions.length,
        interactions
      }
    }
  }
]
