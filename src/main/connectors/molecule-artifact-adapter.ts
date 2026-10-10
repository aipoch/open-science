import { MOLECULE_TOOLS } from '@aipoch/connector-builtins/molecule'
import type { ToolDescriptor } from '@aipoch/connector-core'
import { renderMoleculeStructure } from '@aipoch/connector-builtins/molecule-render'
import { randomUUID } from 'node:crypto'

import type { ArtifactFile } from '../../shared/artifacts'
import type { AppGeneratedArtifactProducer } from '../../shared/artifact-provenance'

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

// Application-owned capability; ConnectorService dispatches it through the session-bound handler.
export const MOLECULE_PREVIEW_TOOL: ToolDescriptor = {
  id: 'preview_molecule',
  connector: 'molecule',
  credentialKeys: [],
  description:
    'Validate a 2D chemical structure and open it in the preview panel in one call. Pass a `smiles` or a `molfile`; the structure is saved as a canonical .mol artifact this turn and rendered read-only with OpenChemLib. Returns the saved artifact id. Call it during an assistant turn (the file is attached to the current turn).',
  input: MOLECULE_TOOLS[0].input,
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
