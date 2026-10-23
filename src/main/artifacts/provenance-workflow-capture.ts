import {
  sealWorkflowCapture,
  validWorkflowCapture,
  validRStageCheckpointForRun,
  type WorkflowCapture
} from '@aipoch/reproducibility'
import type {
  PersistedArtifactExecutionSnapshot,
  ProvenanceNotebookRun
} from '../../shared/artifact-provenance'
import { canonicalJson, type CanonicalJson } from './provenance-canonical'
import {
  artifactProvenanceGraphMatchesTarget,
  artifactProvenanceGraphValue
} from './artifact-provenance-graph'

// Workflow evidence has its own budget. It must never consume the legacy Artifact's 4 MiB.
export const MAX_WORKFLOW_CAPTURE_BYTES = 4 * 1024 * 1024
export const MAX_EXTENDED_EXECUTION_SNAPSHOT_BYTES = 8 * 1024 * 1024 + 1024

type WorkflowCaptureState = NonNullable<PersistedArtifactExecutionSnapshot['workflowCapture']>
type WorkflowCaptureDraft = Omit<WorkflowCapture, 'captureId'>

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const captureBytes = (value: unknown): number =>
  Buffer.byteLength(canonicalJson(value as CanonicalJson), 'utf8')

const missingWorkflowHistory = (capture: WorkflowCaptureDraft): boolean =>
  capture.graph.reasonCodes.some((reason) =>
    ['history-truncated', 'graph-budget-exceeded', 'dependency-cycle'].includes(reason)
  ) ||
  capture.truncation !== undefined ||
  capture.runs.some((run) => run.scriptTruncated || run.hasOmittedInputs)

export const validRunStageCheckpoint = (
  run: Pick<
    ProvenanceNotebookRun,
    | 'stageCheckpoint'
    | 'runId'
    | 'kernelEpochId'
    | 'script'
    | 'kernelKind'
    | 'status'
    | 'environmentLock'
  >
): boolean => {
  if (run.stageCheckpoint === undefined) return true
  const checkpoint = recordValue(run.stageCheckpoint)
  if (checkpoint?.state === 'unavailable') {
    return (
      Object.keys(checkpoint).length === 2 &&
      typeof checkpoint.reason === 'string' &&
      checkpoint.reason.length > 0 &&
      checkpoint.reason.length <= 1024
    )
  }
  return validRStageCheckpointForRun(run)
}

export const sealBoundedWorkflowCapture = (draft: WorkflowCaptureDraft): WorkflowCaptureState => {
  // Reserve the hash field before sealing; oversize capture is an explicit unavailable result.
  if (captureBytes({ ...draft, captureId: '0'.repeat(64) }) > MAX_WORKFLOW_CAPTURE_BYTES) {
    return { state: 'unavailable', reason: 'payload-limit' }
  }
  if (
    !artifactProvenanceGraphValue(draft.graph) ||
    missingWorkflowHistory(draft) ||
    draft.runs.some((run) => !validRunStageCheckpoint(run))
  ) {
    return { state: 'unavailable', reason: 'incomplete-evidence' }
  }
  try {
    const capture = sealWorkflowCapture(draft)
    return { state: 'available', capture }
  } catch {
    return { state: 'unavailable', reason: 'incomplete-evidence' }
  }
}

/** Validate the immutable workflow against the enclosing, independently sealed source anchor. */
export const decodeWorkflowCaptureState = (
  value: unknown,
  source: Pick<
    PersistedArtifactExecutionSnapshot,
    'producerRunId' | 'producerRunIndex' | 'provenanceGraph'
  >,
  validRun: (value: unknown) => boolean,
  validInput: (value: unknown) => boolean
): WorkflowCaptureState | undefined => {
  const wrapper = recordValue(value)
  if (!wrapper) return undefined
  if (wrapper.state === 'unavailable') {
    return Object.keys(wrapper).length === 2 &&
      (wrapper.reason === 'payload-limit' || wrapper.reason === 'incomplete-evidence')
      ? { state: 'unavailable', reason: wrapper.reason }
      : undefined
  }
  // Future nested capture formats do not make legacy Artifact evidence unreadable.
  const candidate = recordValue(wrapper.capture)
  if (
    wrapper.state !== 'available' ||
    (Number.isSafeInteger(candidate?.schemaVersion) && Number(candidate?.schemaVersion) > 1)
  ) {
    return { state: 'unavailable', reason: 'incomplete-evidence' }
  }
  if (
    Object.keys(wrapper).length !== 2 ||
    !validWorkflowCapture(wrapper.capture) ||
    !artifactProvenanceGraphValue(wrapper.capture.graph) ||
    captureBytes(wrapper.capture) > MAX_WORKFLOW_CAPTURE_BYTES ||
    missingWorkflowHistory(wrapper.capture) ||
    wrapper.capture.runs.some((run) => !validRun(run)) ||
    wrapper.capture.inputFiles.some((input) => !validInput(input))
  ) {
    return undefined
  }
  const capture = wrapper.capture
  const anchor = source.provenanceGraph?.entities.find(
    (entity) => entity.entityId === source.provenanceGraph?.targetEntityId
  )
  const terminal = capture.runs.at(-1)
  if (
    anchor?.kind !== 'artifact-version' ||
    !artifactProvenanceGraphMatchesTarget(capture.graph, {
      versionId: anchor.versionId,
      filename: anchor.filename,
      checksum: anchor.checksum,
      sizeBytes: anchor.sizeBytes,
      producerRunId: source.producerRunId
    }) ||
    terminal?.runId !== source.producerRunId ||
    terminal.runIndex !== source.producerRunIndex ||
    capture.runs.some(
      (run, index) =>
        run.runIndex > source.producerRunIndex ||
        (index > 0 && run.runIndex <= capture.runs[index - 1]!.runIndex)
    )
  ) {
    return undefined
  }
  return { state: 'available', capture }
}
