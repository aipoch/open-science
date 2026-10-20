import type { ToolContext, ToolDescriptor } from '@aipoch/connector-core'
import { renderMoleculeStructure } from './molecule/render'

const STRUCTURE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    smiles: { type: 'string', description: 'A SMILES string, e.g. "CC(=O)Oc1ccccc1C(=O)O".' },
    molfile: { type: 'string', description: 'An MDL molfile (V2000/V3000 molblock).' },
    filename: {
      type: 'string',
      description: 'Optional base name for the saved artifact filename, e.g. "aspirin".'
    }
  }
}

export const MOLECULE_TOOLS: ToolDescriptor[] = [
  {
    id: 'render_molecule',
    connector: 'molecule',
    credentialKeys: [],
    description:
      'Validate and normalize a 2D chemical structure with OpenChemLib. Pass a `smiles` string or a `molfile` (MDL molblock); returns a canonical molfile plus formula, molecular weight and heavy-atom count.',
    input: STRUCTURE_INPUT_SCHEMA,
    returns:
      '`{ "valid": bool, "molfile": str, "smiles": str, "formula": str, "molecular_weight": float, "heavy_atom_count": int, "filename_suggestion": str }` on success. On an unparseable structure: `{ "valid": false, "error": str }`. `molfile` is the canonical MDL molblock; `smiles` is the canonical SMILES; `molecular_weight` is the average (relative) weight; `heavy_atom_count` excludes implicit and explicit hydrogens, including hydrogen isotopes.',
    exampleArgs: { smiles: 'CC(=O)Oc1ccccc1C(=O)O', filename: 'aspirin' },
    run: async (_ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> =>
      renderMoleculeStructure(args)
  }
]
