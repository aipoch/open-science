import { getArtifactReproducibilitySource } from './artifact-reproducibility-receipts'
import { readReproducibilityOutputFile } from '@aipoch/reproducibility'
import { resolveStorageKey } from './provenance-storage'
import { sha256 } from './provenance-canonical'
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

export const readArtifactReproducibilityOriginalOutput = async (
  owner: object,
  storageRoot: string,
  request: GetArtifactVersionProvenanceRequest,
  entityId: string
): Promise<Buffer> => {
  const execution = await readArtifactReproducibilityExecutionEvidence(owner, request)
  const source = await getArtifactReproducibilitySource(owner, request)
  const localEntityId = source?.entityIds[entityId] ?? entityId
  const entities = [
    ...(execution.provenanceGraph?.entities ?? []),
    ...(execution.workflowCapture?.state === 'available'
      ? execution.workflowCapture.capture.graph.entities
      : [])
  ]
  const entity = entities.find((item) => item.entityId === localEntityId)
  if (entity?.kind !== 'file-generation') throw new Error('Original output is unavailable.')
  const bytes = await readReproducibilityOutputFile(
    resolveStorageKey(storageRoot, entity.contentStorageKey)
  )
  if (bytes.length !== entity.sizeBytes || sha256(bytes) !== entity.checksum)
    throw new Error('Original output checksum mismatch.')
  return bytes
}
