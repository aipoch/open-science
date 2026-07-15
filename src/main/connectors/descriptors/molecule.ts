import type { ToolContext, ToolDescriptor } from '../types'

// A read-only, pure-compute connector backing the OpenChemLib molecule preview. It never touches the
// network or disk — OpenChemLib runs in-process to validate a structure and return a canonical molfile
// plus basic descriptors. The agent then saves that molfile as a .mol artifact (write_artifact_file),
// which the app auto-previews with the same OpenChemLib renderer.

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

export const MOLECULE_TOOLS: ToolDescriptor[] = [
  {
    id: 'render_molecule',
    connector: 'molecule',
    description:
      'Validate and normalize a 2D chemical structure with OpenChemLib. Pass a `smiles` string or a `molfile` (MDL molblock); returns a canonical molfile plus formula, molecular weight and heavy-atom count. Save the returned `molfile` as a .mol artifact (write_artifact_file) to preview it — the app renders .mol/.sdf/.smi/.smiles files with the same OpenChemLib viewer.',
    input: {
      type: 'object',
      properties: {
        smiles: { type: 'string', description: 'A SMILES string, e.g. "CC(=O)Oc1ccccc1C(=O)O".' },
        molfile: { type: 'string', description: 'An MDL molfile (V2000/V3000 molblock).' },
        filename: {
          type: 'string',
          description: 'Optional base name for the suggested artifact filename, e.g. "aspirin".'
        }
      }
    },
    returns:
      '`{ "valid": bool, "molfile": str, "smiles": str, "formula": str, "molecular_weight": float, "heavy_atom_count": int, "filename_suggestion": str }` on success. On an unparseable structure: `{ "valid": false, "error": str }`. `molfile` is the canonical MDL molblock to hand to write_artifact_file; `smiles` is the canonical SMILES; `molecular_weight` is the average (relative) weight; `heavy_atom_count` excludes implicit hydrogens.',
    example:
      'result = host.mcp("molecule", "render_molecule", {"smiles": "CC(=O)Oc1ccccc1C(=O)O", "filename": "aspirin"})',
    run: async (_ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> => {
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
  }
]
