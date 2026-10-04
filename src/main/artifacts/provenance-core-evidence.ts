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

const COMPUTE_JOB_STATUSES = new Set([
  'queued',
  'submitted',
  'running',
  'success',
  'failed',
  'timeout',
  'error'
])

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key))

const computeCommandEvidenceValue = (value: unknown): boolean => {
  const evidence = recordValue(value)
  if (!evidence) return false
  if (evidence.state === 'unavailable') {
    return (
      evidence.reason === 'compute-command-unavailable' &&
      hasOnlyKeys(evidence, ['state', 'reason'])
    )
  }
  return (
    evidence.state === 'available' &&
    typeof evidence.command === 'string' &&
    typeof evidence.command_hash === 'string' &&
    (evidence.truncated === undefined || evidence.truncated === true) &&
    hasOnlyKeys(evidence, ['state', 'command', 'command_hash', 'truncated'])
  )
}

const computeInputDeclarationValue = (value: unknown): boolean => {
  const declaration = recordValue(value)
  if (!declaration || typeof declaration.label !== 'string') return false
  if (declaration.kind === 'symlink') {
    return (
      typeof declaration.destination_filename === 'string' &&
      typeof declaration.remote_path === 'string' &&
      hasOnlyKeys(declaration, ['kind', 'label', 'destination_filename', 'remote_path'])
    )
  }
  return (
    declaration.kind === 'upload' &&
    typeof declaration.destination_filename === 'string' &&
    (declaration.generation_id === undefined || typeof declaration.generation_id === 'string') &&
    (declaration.checksum === undefined || typeof declaration.checksum === 'string') &&
    (declaration.size_bytes === undefined ||
      (typeof declaration.size_bytes === 'number' &&
        Number.isSafeInteger(declaration.size_bytes) &&
        declaration.size_bytes >= 0)) &&
    hasOnlyKeys(declaration, [
      'kind',
      'label',
      'destination_filename',
      'generation_id',
      'checksum',
      'size_bytes'
    ])
  )
}

const computeInputsEvidenceValue = (value: unknown): boolean => {
  const evidence = recordValue(value)
  if (!evidence) return false
  if (evidence.state === 'unavailable') {
    return (
      (evidence.reason === 'compute-input-manifest-unavailable' ||
        evidence.reason === 'compute-input-manifest-invalid') &&
      hasOnlyKeys(evidence, ['state', 'reason'])
    )
  }
  return (
    evidence.state === 'available' &&
    Array.isArray(evidence.declarations) &&
    evidence.declarations.length <= 256 &&
    evidence.declarations.every(computeInputDeclarationValue) &&
    hasOnlyKeys(evidence, ['state', 'declarations'])
  )
}

const computeCompletionEvidenceValue = (value: unknown): boolean => {
  const evidence = recordValue(value)
  if (!evidence) return false
  if (evidence.state === 'unavailable') {
    return (
      evidence.reason === 'compute-completion-status-unavailable' &&
      hasOnlyKeys(evidence, ['state', 'reason'])
    )
  }
  return (
    evidence.state === 'available' &&
    typeof evidence.status === 'string' &&
    COMPUTE_JOB_STATUSES.has(evidence.status) &&
    evidence.terminal === true &&
    (evidence.exit_code === undefined ||
      (typeof evidence.exit_code === 'number' && Number.isSafeInteger(evidence.exit_code))) &&
    (evidence.submitted_at === undefined || typeof evidence.submitted_at === 'string') &&
    (evidence.started_at === undefined || typeof evidence.started_at === 'string') &&
    (evidence.finished_at === undefined || typeof evidence.finished_at === 'string') &&
    hasOnlyKeys(evidence, [
      'state',
      'status',
      'terminal',
      'exit_code',
      'submitted_at',
      'started_at',
      'finished_at'
    ])
  )
}

const computeEnvironmentEvidenceValue = (value: unknown): boolean => {
  const evidence = recordValue(value)
  if (!evidence) return false
  if (evidence.state === 'unavailable') {
    return (
      evidence.reason === 'compute-environment-unavailable' &&
      hasOnlyKeys(evidence, ['state', 'reason'])
    )
  }
  const environmentNameAvailable = typeof evidence.environment_name === 'string'
  return (
    evidence.state === 'available' &&
    (evidence.execution_mode === 'direct_ssh' ||
      evidence.execution_mode === 'slurm' ||
      evidence.execution_mode === 'unknown') &&
    (evidence.environment_name_status === 'declared'
      ? environmentNameAvailable
      : evidence.environment_name_status === 'not-declared'
        ? evidence.environment_name === undefined
        : false) &&
    (evidence.remote_workdir === undefined || typeof evidence.remote_workdir === 'string') &&
    (evidence.timeout_seconds === undefined ||
      (typeof evidence.timeout_seconds === 'number' &&
        Number.isSafeInteger(evidence.timeout_seconds) &&
        evidence.timeout_seconds >= 0)) &&
    hasOnlyKeys(evidence, [
      'state',
      'execution_mode',
      'environment_name_status',
      'environment_name',
      'remote_workdir',
      'timeout_seconds'
    ])
  )
}

const computeExecutionEvidenceValue = (value: unknown): boolean => {
  const evidence = recordValue(value)
  const fileEvidence = recordValue(evidence?.file_evidence)
  return (
    evidence !== undefined &&
    typeof evidence.activity_id === 'string' &&
    typeof evidence.provider_id === 'string' &&
    typeof evidence.shape === 'string' &&
    typeof evidence.status === 'string' &&
    COMPUTE_JOB_STATUSES.has(evidence.status) &&
    (evidence.command === undefined || computeCommandEvidenceValue(evidence.command)) &&
    (evidence.inputs === undefined || computeInputsEvidenceValue(evidence.inputs)) &&
    (evidence.completion_status === undefined ||
      computeCompletionEvidenceValue(evidence.completion_status)) &&
    (evidence.environment === undefined || computeEnvironmentEvidenceValue(evidence.environment)) &&
    fileEvidence !== undefined &&
    (fileEvidence.state === 'available' ||
      fileEvidence.state === 'partial' ||
      fileEvidence.state === 'unavailable') &&
    (fileEvidence.evidence_id === undefined || typeof fileEvidence.evidence_id === 'string') &&
    (fileEvidence.checksum === undefined || typeof fileEvidence.checksum === 'string') &&
    (fileEvidence.storage_key === undefined || typeof fileEvidence.storage_key === 'string') &&
    (fileEvidence.generation_count === undefined ||
      (typeof fileEvidence.generation_count === 'number' &&
        Number.isSafeInteger(fileEvidence.generation_count) &&
        fileEvidence.generation_count >= 0)) &&
    Array.isArray(fileEvidence.reason_codes) &&
    fileEvidence.reason_codes.every((reason) => typeof reason === 'string')
  )
}

const computeExecutionsValue = (value: unknown): boolean =>
  value === undefined ||
  (Array.isArray(value) && value.length <= 100 && value.every(computeExecutionEvidenceValue))

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
  evidence.strongest_association === row.strongestAssociation &&
  (evidence.access_evidence === undefined ||
    evidence.access_evidence === 'resolver' ||
    evidence.access_evidence === 'file-evidence')

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
    !computeExecutionsValue(evidence.compute_executions) ||
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
