import type { NotebookRunRecord } from '../../../../shared/notebook'
import type {
  ArtifactVersionExecutionProvenance,
  GetArtifactVersionProvenanceRequest,
  ProvenanceNotebookRun,
  ProvenanceExecutionInputFile
} from '../../../../shared/artifact-provenance'
import type { ProjectFileItem } from '../../../../shared/project-files'
import type { SessionReproducibilityBatch } from '../../../../shared/session-reproducibility'

export type StepReproductionTarget = {
  artifactId: string
  versionId: string
  name: string
  workflow: NonNullable<SessionReproducibilityBatch['targets'][number]['workflow']>
  run: ProvenanceNotebookRun
  inputFiles: ProvenanceExecutionInputFile[]
}

// Run IDs alone are not evidence that an Artifact snapshot captured these exact bytes and state.
const matchesRun = (run: NotebookRunRecord, captured: ProvenanceNotebookRun): boolean => {
  const original = run.stageCheckpoint
  const frozen = captured.stageCheckpoint
  return (
    run.status === 'completed' &&
    run.kernelKind === 'r' &&
    captured.status === 'completed' &&
    captured.kernelKind === 'r' &&
    run.runId === captured.runId &&
    run.script === captured.script &&
    !captured.scriptTruncated &&
    Boolean(run.kernelEpochId) &&
    run.kernelEpochId === captured.kernelEpochId &&
    original?.state === 'available' &&
    frozen?.state === 'available' &&
    original.runId === run.runId &&
    frozen.runId === run.runId &&
    original.kernelEpochId === run.kernelEpochId &&
    frozen.kernelEpochId === run.kernelEpochId &&
    original.sourceChecksum === frozen.sourceChecksum &&
    original.environmentLockChecksum === frozen.environmentLockChecksum &&
    original.input.checksum === frozen.input.checksum &&
    original.output.checksum === frozen.output.checksum
  )
}

export const findStepReproductionTarget = async ({
  run,
  scope,
  files,
  readExecution
}: {
  run: NotebookRunRecord
  scope: { projectId: string; appSessionId: string }
  files: ProjectFileItem[]
  readExecution: (
    request: GetArtifactVersionProvenanceRequest
  ) => Promise<ArtifactVersionExecutionProvenance>
}): Promise<StepReproductionTarget | undefined> => {
  if (run.status !== 'completed' || run.kernelKind !== 'r') return undefined
  for (const file of files) {
    if (file.source !== 'artifact' || !file.sourceFileId || !file.sourceVersionId) continue
    // Pin the enumerated Version. Never retry with latest, source similarity or an earlier run.
    const { execution } = await readExecution({
      ...scope,
      artifactId: file.sourceFileId,
      versionId: file.sourceVersionId
    })
    if (execution?.workflow?.state !== 'available') continue
    const captured = execution.runs.find((candidate) => matchesRun(run, candidate))
    if (
      !captured ||
      !execution.workflow.stages.some(
        (stage) => stage.runId === run.runId && stage.kernelKind === 'r'
      )
    )
      continue
    return {
      artifactId: file.sourceFileId,
      versionId: file.sourceVersionId,
      name: file.name,
      workflow: {
        captureId: execution.workflow.captureId,
        independent: true,
        targetRunIds: [run.runId],
        boundaryEntityIds: []
      },
      run: captured,
      inputFiles: (execution.inputFiles ?? []).filter((file) =>
        (captured.inputFileVersionKeys ?? []).some(
          (key) =>
            key.sourceKind === file.sourceKind && key.inputFileVersionId === file.inputFileVersionId
        )
      )
    }
  }
  return undefined
}

export const isStepReproductionBatch = (
  batch: SessionReproducibilityBatch | undefined,
  scope: { projectId: string; appSessionId: string },
  target: StepReproductionTarget | undefined
): boolean =>
  Boolean(
    batch &&
    target &&
    batch.projectId === scope.projectId &&
    batch.appSessionId === scope.appSessionId &&
    batch.targets.length === 1 &&
    batch.targets[0].artifactId === target.artifactId &&
    batch.targets[0].versionId === target.versionId &&
    batch.targets[0].workflow?.captureId === target.workflow.captureId &&
    batch.targets[0].workflow?.independent === true &&
    batch.targets[0].workflow.targetRunIds.length === 1 &&
    batch.targets[0].workflow.targetRunIds[0] === target.run.runId &&
    !batch.targets[0].workflow.boundaryEntityIds?.length
  )
