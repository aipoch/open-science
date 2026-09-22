import { randomUUID } from 'node:crypto'

import type { ArtifactFile } from '../../../shared/artifacts'
import type { AppGeneratedArtifactProducer } from '../../../shared/artifact-provenance'

// Minimal view of the app runtime's artifact writer, so the handler stays testable with a fake. The
// session id routes the write to the run of the session that invoked the tool.
export type MoleculeArtifactWriter = {
  writeArtifactForCurrentRun(
    sessionId: string,
    input: {
      filename: string
      content: string
      mimeType?: string
      producer?: AppGeneratedArtifactProducer
    }
  ): Promise<ArtifactFile>
}

const MOLFILE_MIME = 'chemical/x-mdl-molfile'

// Handles the `molecule/preview_molecule` tool: validate/normalize the structure with OpenChemLib,
// then save it as a canonical .mol artifact on the current turn. The saved molecule-format artifact is
// auto-opened in the preview panel by the renderer (workspace-events), so no extra IPC is needed.
export const createMoleculePreviewHandler =
  (writer: MoleculeArtifactWriter, options: { createInvocationId?: () => string } = {}) =>
  async (
    args: Record<string, unknown>,
    context: { sessionId?: string } = {},
    signal?: AbortSignal
  ): Promise<unknown> => {
    signal?.throwIfAborted()
    const result = await renderMoleculeStructure(args)
    signal?.throwIfAborted()
    if (!result.valid) return result

    // The artifact must attach to the calling session's run; without a session id it would fall back to
    // a global "current" run and could land on a parallel session, so fail closed instead.
    if (!context.sessionId) {
      throw new Error('molecule preview requires an active session to attach the structure to.')
    }

    signal?.throwIfAborted()
    const artifact = await writer.writeArtifactForCurrentRun(context.sessionId, {
      filename: result.filename_suggestion,
      content: result.molfile,
      mimeType: MOLFILE_MIME,
      producer: {
        kind: 'connector',
        connectorId: 'molecule',
        toolId: 'preview_molecule',
        invocationId: (options.createInvocationId ?? randomUUID)(),
        implementationVersion: '1',
        normalizedArguments: {
          inputKind: typeof args.smiles === 'string' ? 'smiles' : 'molfile',
          filename: result.filename_suggestion,
          smiles: result.smiles
        }
      }
    })

    return {
      valid: true,
      artifact_id: artifact.artifactId ?? artifact.id,
      ...(artifact.versionId ? { version_id: artifact.versionId } : {}),
      ...(artifact.versionNumber ? { version_number: artifact.versionNumber } : {}),
      filename: artifact.name,
      smiles: result.smiles,
      formula: result.formula,
      molecular_weight: result.molecular_weight,
      heavy_atom_count: result.heavy_atom_count
    }
  }

type OclModule = typeof import('openchemlib')

// Loaded lazily so the ~1MB OpenChemLib bundle is only paid for when a molecule tool actually runs,
// not at connector-registry import time.
let oclPromise: Promise<OclModule> | undefined
const loadOcl = (): Promise<OclModule> => {
  oclPromise ??= import('openchemlib')
  return oclPromise
}

// Heavy atoms are all atoms with an atomic number greater than hydrogen's 1. Counting by atomic
// number excludes explicit hydrogen atoms and hydrogen isotopes while retaining isotopes of heavier
// elements.
const countHeavyAtoms = (molecule: InstanceType<OclModule['Molecule']>): number => {
  let count = 0
  for (let atom = 0; atom < molecule.getAllAtoms(); atom++) {
    if (molecule.getAtomicNo(atom) > 1) count++
  }
  return count
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
  // Molfile headers are positional: an empty title line must not be trimmed away.
  const molfileInput = typeof args.molfile === 'string' ? args.molfile : ''
  const hasMolfile = molfileInput.trim().length > 0

  if (!smiles && !hasMolfile) {
    throw new Error('render_molecule requires either smiles or molfile.')
  }
  if (smiles && hasMolfile) {
    throw new Error('render_molecule takes only one of smiles or molfile, not both.')
  }

  const ocl = await loadOcl()

  let molecule: InstanceType<OclModule['Molecule']>
  try {
    molecule = smiles ? ocl.Molecule.fromSmiles(smiles) : ocl.Molecule.fromMolfile(molfileInput)
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : 'Invalid structure' }
  }
  if (molecule.getAllAtoms() === 0) {
    return { valid: false, error: 'Invalid structure: no atoms found.' }
  }

  // Compute the string/atom outputs BEFORE reading descriptors: on a molfile-parsed molecule,
  // calling getMolecularFormula() first can leave OpenChemLib in a state where a later toSmiles()
  // returns empty. A SMILES-parsed molecule computes descriptors reliably, so if the direct
  // formula comes back empty, recompute it from the canonical SMILES.
  const canonicalSmiles = molecule.toSmiles()
  const canonicalMolfile = molecule.toMolfile()
  const heavyAtomCount = countHeavyAtoms(molecule)

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
