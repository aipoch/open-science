import type {
  GetArtifactVersionProvenanceRequest,
  PersistedArtifactExecutionSnapshot
} from '../../shared/artifact-provenance'

type ReproducibilityExecutionEvidenceReader = (
  request: GetArtifactVersionProvenanceRequest
) => Promise<PersistedArtifactExecutionSnapshot>

const readers = new WeakMap<object, ReproducibilityExecutionEvidenceReader>()

export const bindArtifactReproducibilityExecutionEvidence = (
  owner: object,
  reader: ReproducibilityExecutionEvidenceReader
): void => {
  readers.set(owner, reader)
}

export const readArtifactReproducibilityExecutionEvidence = (
  owner: object,
  request: GetArtifactVersionProvenanceRequest
): Promise<PersistedArtifactExecutionSnapshot> => {
  const reader = readers.get(owner)
  if (!reader) throw new Error('Artifact reproducibility execution evidence is unavailable.')
  return reader(request)
}
