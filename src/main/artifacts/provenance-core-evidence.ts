import { ProvenanceIntegrityError } from '../../shared/provenance-read-result'
import type { Prisma } from '@prisma/client'

import type { ArtifactVersionEvidence } from '../../shared/artifact-provenance'
import {
  connectorEvidenceIsValid,
  isConnectorProducerEvidence
} from './provenance-producer-capture'

type CoreEvidenceVersion = Prisma.ArtifactVersionGetPayload<{
  include: { artifact: true; inputs: true }
}>

const ENVIRONMENT_UNAVAILABLE_REASONS = new Set([
  'environment-not-supported',
  'environment-capture-failed',
  'environment-manifest-publication-failed',
  'legacy-environment-reference-unavailable'
])

const inputMatches = (
  evidence: ArtifactVersionEvidence['inputs'][number],
  row: CoreEvidenceVersion['inputs'][number],
  ordinal: number
): boolean =>
  evidence.ordinal === ordinal &&
  row.ordinal === ordinal &&
  evidence.input_file_version_id === row.inputFileVersionId &&
  evidence.source_kind === row.sourceKind &&
  evidence.source_file_id === row.sourceFileId &&
  evidence.source_version_number === (row.sourceVersionNumber ?? undefined) &&
  evidence.source_created_at === row.sourceCreatedAt?.toISOString() &&
  evidence.source_project_id === row.sourceProjectId &&
  evidence.source_session_id === row.sourceSessionId &&
  evidence.filename === row.filename &&
  evidence.content_type === (row.contentType ?? undefined) &&
  Number.isSafeInteger(evidence.size_bytes) &&
  evidence.size_bytes === Number(row.sizeBytes) &&
  evidence.checksum === row.checksum &&
  evidence.storage_key === row.storageKey &&
  evidence.strongest_association === row.strongestAssociation

const validateArtifactCoreEvidence = (
  evidence: ArtifactVersionEvidence,
  version: CoreEvidenceVersion
): void => {
  const producer = evidence.producer
  const connectorProducer = isConnectorProducerEvidence(producer)
  const producerValid =
    version.producerRunId === null
      ? connectorProducer
        ? version.notebookSessionId === null &&
          version.producerRunIndex === null &&
          version.executionSnapshotChecksum === null &&
          evidence.execution_snapshot_checksum === undefined &&
          evidence.reproduction_code === undefined &&
          evidence.execution_status.state === 'partial' &&
          connectorEvidenceIsValid(evidence)
        : version.notebookSessionId === null &&
          version.producerRunIndex === null &&
          version.executionSnapshotChecksum === null &&
          evidence.execution_snapshot_checksum === undefined &&
          evidence.connector_execution === undefined &&
          evidence.reproduction_code === undefined &&
          producer.state === 'unavailable' &&
          evidence.execution_status.state === 'unavailable' &&
          evidence.execution_status.reason === producer.reason &&
          evidence.inputs.length === 0
      : producer.state === 'available' &&
        !connectorProducer &&
        producer.notebook_session_id === version.notebookSessionId &&
        producer.producer_run_id === version.producerRunId &&
        producer.run_index === version.producerRunIndex &&
        evidence.execution_status.state === 'available' &&
        evidence.execution_snapshot_checksum === version.executionSnapshotChecksum &&
        typeof evidence.reproduction_code === 'string'
  const environmentValid = evidence.environment
    ? producer.state === 'available' &&
      !connectorProducer &&
      producer.environment_manifest_checksum === evidence.environment.source_manifest_checksum &&
      evidence.environment_status.state ===
        (evidence.environment.capture_status === 'complete' ? 'available' : 'partial') &&
      evidence.environment.complete === (evidence.environment.capture_status === 'complete')
    : evidence.environment_status.state === 'unavailable' &&
      (connectorProducer
        ? evidence.environment_status.reason === 'environment-not-supported'
        : producer.state === 'unavailable'
          ? evidence.environment_status.reason === producer.reason
          : producer.environment_manifest_checksum === undefined &&
            ENVIRONMENT_UNAVAILABLE_REASONS.has(evidence.environment_status.reason))
  const inputsValid =
    evidence.inputs.length === version.inputs.length &&
    evidence.inputs.every((input, ordinal) => {
      const row = version.inputs[ordinal]
      return row !== undefined && inputMatches(input, row, ordinal)
    })
  const sizeBytes = Number(version.sizeBytes)

  if (
    evidence.schema_version !== 1 ||
    evidence.project_id !== version.artifact.projectId ||
    evidence.app_session_id !== version.artifact.sessionId ||
    evidence.artifact_id !== version.artifactId ||
    evidence.version_id !== version.id ||
    evidence.version_number !== version.versionNumber ||
    evidence.filename !== version.filename ||
    evidence.content_type !== (version.contentType ?? undefined) ||
    !Number.isSafeInteger(sizeBytes) ||
    evidence.size_bytes !== sizeBytes ||
    evidence.checksum !== version.checksum ||
    evidence.created_at !== version.createdAt.toISOString() ||
    evidence.conversation.root_frame_id !== version.rootFrameId ||
    evidence.conversation.agent_frame_id !== version.agentFrameId ||
    evidence.conversation.message_branch_id !== version.messageBranchId ||
    evidence.conversation.runtime_segment_id !== version.runtimeSegmentId ||
    evidence.conversation.prompt_message_id !== version.promptMessageId ||
    evidence.is_user_upload !== false ||
    (evidence.agent_name !== undefined && typeof evidence.agent_name !== 'string') ||
    !producerValid ||
    !environmentValid ||
    !inputsValid
  ) {
    throw new ProvenanceIntegrityError(
      `Artifact Version core evidence metadata mismatch: ${version.id}`
    )
  }
}

export { validateArtifactCoreEvidence }
export type { CoreEvidenceVersion }
