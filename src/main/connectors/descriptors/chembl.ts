import type { ToolDescriptor } from '../types'

const CHEMBL = 'https://www.ebi.ac.uk/chembl/api/data'

type ChemblMolecule = {
  molecule_chembl_id?: string
  pref_name?: string | null
  max_phase?: string | number | null
  molecule_type?: string | null
}

type ChemblSearchResponse = { molecules?: ChemblMolecule[] }

const summarize = (m: ChemblMolecule): unknown => ({
  chembl_id: m.molecule_chembl_id,
  pref_name: m.pref_name,
  max_phase: m.max_phase,
  molecule_type: m.molecule_type
})

// ChEMBL REST (EBI): read-only compound/drug lookups.
export const CHEMBL_TOOLS: ToolDescriptor[] = [
  {
    id: 'chembl_search_molecule',
    connector: 'chembl',
    description:
      'Full-text search for ChEMBL molecules by name; returns compact molecule summaries.',
    input: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    },
    required: ['query'],
    returns:
      '`[ { "chembl_id": str, "pref_name": str|null, "max_phase": str|int|null, "molecule_type": str|null } ]` — array of compact molecule summaries (all matches ChEMBL returns, unbounded); `[]` when nothing matches.',
    url: (a) => `${CHEMBL}/molecule/search?q=${encodeURIComponent(String(a.query))}&format=json`,
    parse: (raw) => ((raw as ChemblSearchResponse).molecules ?? []).map(summarize)
  },
  {
    id: 'chembl_get_molecule',
    connector: 'chembl',
    description: 'Get a ChEMBL molecule record (name, phase, type) by ChEMBL ID.',
    input: {
      type: 'object',
      properties: { chembl_id: { type: 'string' } },
      required: ['chembl_id']
    },
    required: ['chembl_id'],
    returns:
      '`{ "chembl_id": str, "pref_name": str|null, "max_phase": str|int|null, "molecule_type": str|null }` — a single molecule summary; fields are null/undefined when absent on the record.',
    url: (a) => `${CHEMBL}/molecule/${encodeURIComponent(String(a.chembl_id))}?format=json`,
    parse: (raw) => summarize(raw as ChemblMolecule)
  }
]
