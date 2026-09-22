import type { ToolContext, ToolDescriptor } from '../types'
import { renderMoleculeStructure } from '../molecule'

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
    description:
      'Validate and normalize a 2D chemical structure with OpenChemLib. Pass a `smiles` string or a `molfile` (MDL molblock); returns a canonical molfile plus formula, molecular weight and heavy-atom count. Save the returned `molfile` as a .mol artifact (write_artifact_file) to preview it, or use `preview_molecule` to do both in one call.',
    input: STRUCTURE_INPUT_SCHEMA,
    returns:
      '`{ "valid": bool, "molfile": str, "smiles": str, "formula": str, "molecular_weight": float, "heavy_atom_count": int, "filename_suggestion": str }` on success. On an unparseable structure: `{ "valid": false, "error": str }`. `molfile` is the canonical MDL molblock; `smiles` is the canonical SMILES; `molecular_weight` is the average (relative) weight; `heavy_atom_count` excludes implicit and explicit hydrogens, including hydrogen isotopes.',
    example:
      'const result = await host.mcp("molecule", "render_molecule", {"smiles": "CC(=O)Oc1ccccc1C(=O)O", "filename": "aspirin"})',
    run: async (_ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> =>
      renderMoleculeStructure(args)
  },
  {
    id: 'preview_molecule',
    connector: 'molecule',
    description:
      'Validate a 2D chemical structure and open it in the preview panel in one call. Pass a `smiles` or a `molfile`; the structure is saved as a canonical .mol artifact this turn and rendered read-only with OpenChemLib. Returns the saved artifact id. Call it during an assistant turn (the file is attached to the current turn).',
    input: STRUCTURE_INPUT_SCHEMA,
    returns:
      '`{ "valid": bool, "artifact_id": str, "version_id": str, "version_number": int, "filename": str, "smiles": str, "formula": str, "molecular_weight": float, "heavy_atom_count": int }` on success. `artifact_id` identifies the stable Artifact lineage; `version_id` identifies the immutable saved Version. `heavy_atom_count` excludes implicit and explicit hydrogens, including hydrogen isotopes. On an unparseable structure: `{ "valid": false, "error": str }`. The saved .mol artifact opens automatically in the preview panel.',
    example:
      'const result = await host.mcp("molecule", "preview_molecule", {"smiles": "CC(=O)Oc1ccccc1C(=O)O", "filename": "aspirin"})',
    // The real write + preview is performed by the app runtime via ConnectorService.localToolHandlers;
    // this run() only fires if the tool is reached outside the app (e.g. an isolated engine test).
    run: async (): Promise<unknown> => {
      throw new Error(
        'preview_molecule is handled by the app runtime and cannot run in this context.'
      )
    }
  }
]
