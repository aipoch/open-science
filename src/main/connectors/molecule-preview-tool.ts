import { createRequire } from 'node:module'

import type { ToolDescriptor } from '@aipoch/connector-core'

const nodeRequire = createRequire(import.meta.url)

const moleculeInputSchema = (): Record<string, unknown> => {
  const molecule = nodeRequire('@aipoch/connector-builtins/molecule') as {
    MOLECULE_TOOLS: readonly ToolDescriptor[]
  }
  return molecule.MOLECULE_TOOLS[0].input
}

// The application-owned preview capability shares the connector package's input contract, but the
// package is loaded only when the registry first resolves the molecule connector.
export const MOLECULE_PREVIEW_TOOL: ToolDescriptor = {
  id: 'preview_molecule',
  connector: 'molecule',
  credentialKeys: [],
  description:
    'Validate a 2D chemical structure and open it in the preview panel in one call. Pass a `smiles` or a `molfile`; the structure is saved as a canonical .mol artifact this turn and rendered read-only with OpenChemLib. Returns the saved artifact id. Call it during an assistant turn (the file is attached to the current turn).',
  get input() {
    return moleculeInputSchema()
  },
  returns:
    '`{ "valid": bool, "artifact_id": str, "version_id": str, "version_number": int, "filename": str, "smiles": str, "formula": str, "molecular_weight": float, "heavy_atom_count": int }` on success. `artifact_id` identifies the stable Artifact lineage; `version_id` identifies the immutable saved Version. `heavy_atom_count` excludes implicit and explicit hydrogens, including hydrogen isotopes. On an unparseable structure: `{ "valid": false, "error": str }`. The saved .mol artifact opens automatically in the preview panel.',
  exampleArgs: { smiles: 'CC(=O)Oc1ccccc1C(=O)O', filename: 'aspirin' },
  // The real write + preview is performed by the app runtime via ConnectorService.localToolHandlers;
  // this run() only fires if the tool is reached outside the app (e.g. an isolated engine test).
  run: async (): Promise<unknown> => {
    throw new Error(
      'preview_molecule is handled by the app runtime and cannot run in this context.'
    )
  }
}
