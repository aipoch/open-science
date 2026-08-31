import type { GetArtifactVersionProvenanceRequest } from '../../shared/artifact-provenance'
import type { ArtifactVersionReconstructionProvenance } from './provenance-read-model'

type ReconstructionEvidenceReader = (
  request: GetArtifactVersionProvenanceRequest
) => Promise<ArtifactVersionReconstructionProvenance>

const readers = new WeakMap<object, ReconstructionEvidenceReader>()

export const bindArtifactReconstructionEvidence = (
  owner: object,
  reader: ReconstructionEvidenceReader
): void => {
  readers.set(owner, reader)
}

export const readArtifactReconstructionEvidence = (
  owner: object,
  request: GetArtifactVersionProvenanceRequest
): Promise<ArtifactVersionReconstructionProvenance> => {
  const reader = readers.get(owner)
  if (!reader) throw new Error('Artifact reconstruction evidence capability is unavailable.')
  return reader(request)
}
