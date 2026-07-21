import type { ToolContext, ToolDescriptor } from '../types'

// A pure-JS chemistry connector backing the OpenChemLib molecule preview. OpenChemLib runs in-process
// (no network, no WASM worker) to validate a structure and produce a canonical molfile plus basic
// descriptors. `render_molecule` returns that data; `preview_molecule` additionally saves the structure
// as a .mol artifact for the app to auto-render — its write is handled by the app runtime (see
// ConnectorService.localToolHandlers), so its run() here is only a guard for out-of-app contexts.

type OclModule = typeof import('openchemlib')

// Loaded lazily so the ~1MB OpenChemLib bundle is only paid for when a molecule tool actually runs,
// not at connector-registry import time.
let oclPromise: Promise<OclModule> | undefined
const loadOcl = (): Promise<OclModule> => {
  oclPromise ??= import('openchemlib')
  return oclPromise
}

// Keeps a suggested filename safe for the artifact layout and guarantees a .mol extension.
const toMoleculeFilename = (raw: unknown, fallback: string): string => {
  const base =
    typeof raw === 'string' && raw.trim() ? raw.trim().replace(/\.[a-z0-9]+$/i, '') : fallback
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '') || fallback
  return `${safe}.mol`
}

export type MoleculeRenderResult =
  | {
      valid: true
      molfile: string
      smiles: string
      formula: string
      molecular_weight: number
      heavy_atom_count: number
      filename_suggestion: string
    }
  | { valid: false; error: string }

// Shared OpenChemLib core used by both render_molecule and the preview handler: parses a SMILES or
// molfile, then returns a canonical molfile plus descriptors. Throws only for bad arguments; an
// unparseable structure resolves to { valid: false }.
export const renderMoleculeStructure = async (
  args: Record<string, unknown>
): Promise<MoleculeRenderResult> => {
  const smiles = typeof args.smiles === 'string' ? args.smiles.trim() : ''
  const molfileInput = typeof args.molfile === 'string' ? args.molfile.trim() : ''

  if (!smiles && !molfileInput) {
    throw new Error('render_molecule requires either smiles or molfile.')
  }
  if (smiles && molfileInput) {
    throw new Error('render_molecule takes only one of smiles or molfile, not both.')
  }

  const ocl = await loadOcl()

  let molecule: InstanceType<OclModule['Molecule']>
  try {
    molecule = smiles ? ocl.Molecule.fromSmiles(smiles) : ocl.Molecule.fromMolfile(molfileInput)
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : 'Invalid structure' }
  }

  // Compute the string/atom outputs BEFORE reading descriptors: on a molfile-parsed molecule,
  // calling getMolecularFormula() first can leave OpenChemLib in a state where a later toSmiles()
  // returns empty. A SMILES-parsed molecule computes descriptors reliably, so if the direct
  // formula comes back empty, recompute it from the canonical SMILES.
  const canonicalSmiles = molecule.toSmiles()
  const canonicalMolfile = molecule.toMolfile()
  const heavyAtomCount = molecule.getAllAtoms()

  let formula = molecule.getMolecularFormula()
  if (!formula.formula && canonicalSmiles) {
    formula = ocl.Molecule.fromSmiles(canonicalSmiles).getMolecularFormula()
  }

  return {
    valid: true,
    molfile: canonicalMolfile,
    smiles: canonicalSmiles,
    formula: formula.formula,
    molecular_weight: formula.relativeWeight,
    heavy_atom_count: heavyAtomCount,
    filename_suggestion: toMoleculeFilename(args.filename, formula.formula)
  }
}

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
      '`{ "valid": bool, "molfile": str, "smiles": str, "formula": str, "molecular_weight": float, "heavy_atom_count": int, "filename_suggestion": str }` on success. On an unparseable structure: `{ "valid": false, "error": str }`. `molfile` is the canonical MDL molblock; `smiles` is the canonical SMILES; `molecular_weight` is the average (relative) weight; `heavy_atom_count` excludes implicit hydrogens.',
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
      '`{ "valid": bool, "artifact_id": str, "filename": str, "smiles": str, "formula": str, "molecular_weight": float, "heavy_atom_count": int }` on success. On an unparseable structure: `{ "valid": false, "error": str }`. The saved .mol artifact opens automatically in the preview panel.',
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
