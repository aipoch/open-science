import { renderMoleculeStructure } from './descriptors/molecule'

// Minimal view of the app runtime's artifact writer, so the handler stays testable with a fake. The
// session id routes the write to the run of the session that invoked the tool.
export type MoleculeArtifactWriter = {
  writeArtifactForCurrentRun(
    sessionId: string,
    input: {
      filename: string
      content: string
      mimeType?: string
    }
  ): Promise<{ id: string; name: string; path: string }>
}

const MOLFILE_MIME = 'chemical/x-mdl-molfile'

// Handles the `molecule/preview_molecule` tool: validate/normalize the structure with OpenChemLib,
// then save it as a canonical .mol artifact on the current turn. The saved molecule-format artifact is
// auto-opened in the preview panel by the renderer (workspace-events), so no extra IPC is needed.
export const createMoleculePreviewHandler =
  (writer: MoleculeArtifactWriter) =>
  async (args: Record<string, unknown>, context: { sessionId?: string } = {}): Promise<unknown> => {
    const result = await renderMoleculeStructure(args)
    if (!result.valid) return result

    // The artifact must attach to the calling session's run; without a session id it would fall back to
    // a global "current" run and could land on a parallel session, so fail closed instead.
    if (!context.sessionId) {
      throw new Error('molecule preview requires an active session to attach the structure to.')
    }

    const artifact = await writer.writeArtifactForCurrentRun(context.sessionId, {
      filename: result.filename_suggestion,
      content: result.molfile,
      mimeType: MOLFILE_MIME
    })

    return {
      valid: true,
      artifact_id: artifact.id,
      filename: artifact.name,
      smiles: result.smiles,
      formula: result.formula,
      molecular_weight: result.molecular_weight,
      heavy_atom_count: result.heavy_atom_count
    }
  }
