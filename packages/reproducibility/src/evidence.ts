import type { OutputComparisonReport } from './comparison-contracts'
import type { NotebookExecutionContext } from './execution-context'
import type { NotebookRunEnvironmentLockCapture } from '@aipoch/environment/contracts'
export type ReproductionSnapshot = {
  inputFiles: NotebookRunInputFile[]
  runs: ProvenanceNotebookRun[]
  provenanceGraph?: ArtifactProvenanceGraph
  reproducibilityRecipe?: ArtifactReproducibilityRecipe
  helperModules?: NotebookHelperModuleEvidence[]
  helperEvidenceStatus?: ArtifactHelperEvidenceStatus
  truncation?: {
    reason: 'payload-limit'
    omittedLeadingRunCount: number
    omittedOutputCount: number
    omittedInputCount: number
  }
}

// The graph retains the original publication anchor, but contains the complete captured workflow.
// Slice endpoints are Run identities; they never manufacture an Artifact Version or publication.
export type WorkflowCapture = {
  schemaVersion: 1
  captureId: string
  // New captures retain helper completeness on every run. Historical captures without
  // this field continue to use their conservative capture-wide status.
  runs: Array<ProvenanceNotebookRun & { helperEvidenceStatus?: ArtifactHelperEvidenceStatus }>
  inputFiles: NotebookRunInputFile[]
  graph: ArtifactProvenanceGraph
  activityReasonCodes?: Record<string, ArtifactProvenanceGraphReason[]>
  helperModules?: NotebookHelperModuleEvidence[]
  helperEvidenceStatus?: ArtifactHelperEvidenceStatus
  truncation?: ReproductionSnapshot['truncation']
}

export type WorkflowSelection = {
  captureId: string
  targetRunIds: string[]
  boundaryEntityIds?: string[]
}

export type WorkflowPlan = {
  schemaVersion: 1
  planId: string
  captureId: string
  selection: WorkflowSelection
  selectedStepIds: string[]
  steps: Array<Extract<ArtifactReproducibilityRecipeStep, { kind: 'notebook-run' }>>
  crossingFiles: ArtifactReproducibilityRecipeFile[]
  targetOutputEntityIds: string[]
  executionOnlyTargetRunIds: string[]
  environmentRequirements: ArtifactReproducibilityEnvironmentRequirement[]
  verification: 'file-comparison' | 'execution-only'
  status: 'ready' | 'blocked'
  reasonCodes: string[]
}

export type NotebookRunInputFile = {
  inputFileVersionId: string
  sourceKind: 'upload-version' | 'artifact-version'
  sourceFileId: string
  sourceVersionNumber?: number
  sourceCreatedAt?: string
  sourceProjectId: string
  sourceSessionId: string
  filename: string
  contentType?: string
  sizeBytes: number
  checksum: string
  storageKey: string
  association: NotebookInputAssociation
  accessEvidence?: NotebookInputAccessEvidence
}

export type NotebookInputAssociation = 'turn-attached' | 'resolver-accessed'

export type NotebookInputAccessEvidence = 'resolver' | 'file-evidence'

export type ProvenanceNotebookRun = {
  executionContext?: NotebookExecutionContext
  runId: string
  runIndex: number
  agentFrameId: string
  messageBranchId: string
  runtimeSegmentId: string
  promptMessageId: string
  kernelEpochId?: string
  // Missing in older snapshots; only explicit false proves the script never reached the kernel.
  kernelDispatched?: boolean
  kernelKind: NotebookKernelKind
  environmentName?: string
  environmentLock?: NotebookRunEnvironmentLockCapture
  script: string
  scriptTruncated?: true
  status: NotebookRunStatus
  executionCount?: number
  startedAt: string
  completedAt?: string
  outputs: ProvenanceNotebookOutput[]
  inputFileVersionKeys: Array<{
    sourceKind: NotebookRunInputFile['sourceKind']
    inputFileVersionId: string
  }>
  hasOmittedFiles?: true
  hasOmittedInputs?: true
  omittedOutputCount?: number
  helperModuleKeys?: string[]
}

export type NotebookKernelKind = 'python' | 'r' | 'repl' | 'bash'

export type NotebookRunStatus =
  'queued' | 'running' | 'completed' | 'failed' | 'timeout' | 'interrupted' | 'cancelled'

export type ProvenanceNotebookOutput =
  | { type: 'text'; text: string; truncated?: boolean }
  | { type: 'error'; name?: string; message: string; traceback?: string[] }
  | { type: 'table'; columns: string[]; rowCount: number; previewRows: unknown[][] }
  | { type: 'omitted-media'; mimeType: string; byteLength?: number }

export type ArtifactProvenanceGraph = {
  schemaVersion: 1
  targetEntityId: string
  completeness: 'complete' | 'conservative' | 'incomplete'
  reasonCodes: ArtifactProvenanceGraphReason[]
  activities: ArtifactProvenanceGraphActivity[]
  entities: ArtifactProvenanceGraphEntity[]
  edges: ArtifactProvenanceGraphEdge[]
  outputGroups?: ArtifactProvenanceGraphOutputGroup[]
}

export type ArtifactProvenanceGraphReason =
  | 'activity-evidence-unavailable'
  | 'activity-evidence-corrupt'
  | 'activity-evidence-partial'
  | 'target-generation-unavailable'
  | 'file-reads-unavailable'
  | 'writer-attribution-unavailable'
  | 'absolute-path-unfrozen'
  | 'kernel-epoch-unknown'
  | 'kernel-dependencies-unavailable'
  | 'kernel-epoch-conservative'
  | 'history-truncated'
  | 'graph-budget-exceeded'
  | 'dependency-cycle'

export type ArtifactProvenanceGraphActivity = {
  activityId: string
  kind: 'notebook-run' | 'compute-job' | 'artifact-publication'
  sequence: number
  parentActivityId?: string
  runIndex?: number
  kernelEpochId?: string
  inclusion: 'target-closure' | 'kernel-epoch-conservative' | 'workflow-capture'
  evidenceState: 'available' | 'partial' | 'unavailable'
  evidenceId?: string
  evidenceChecksum?: string
  evidenceReasonCodes?: ExecutionFileEvidenceReason[]
}

export type ExecutionFileEvidenceReason =
  | 'file-reads-not-observed'
  | 'initial-file-generations-not-captured'
  | 'external-paths-not-observed'
  | 'remote-outputs-not-observed'
  | 'transient-files-not-captured'
  | 'delayed-writes-not-observed'
  | 'writer-not-isolated'
  | 'watcher-unavailable'
  | 'observation-not-started'
  | 'observer-conflict'
  | 'observer-limit-exceeded'
  | 'observer-failed'
  | 'generation-budget-exceeded'
  | 'generation-freeze-failed'
  | 'evidence-persistence-failed'
  | 'activity-identity-missing'
  | 'remote-input-generation-not-captured'
  | 'remote-output-not-harvested'
  | 'harvest-incomplete'
  | 'compute-activity-lineage-missing'
  | 'dynamic-path-unresolved'
  | 'absolute-path-not-frozen'
  | 'source-analysis-unsupported-call'
  | 'execution-incomplete'

export type ArtifactProvenanceGraphEntity =
  | {
      entityId: string
      kind: 'registered-input-generation'
      inputFileVersionId: string
      sourceKind: NotebookRunInputFile['sourceKind']
      filename: string
      checksum: string
      sizeBytes: number
    }
  | {
      entityId: string
      kind: 'file-generation'
      generationId: string
      relativePath: string
      pathPortability: 'relative' | 'absolute'
      checksum: string
      sizeBytes: number
      contentStorageKey: string
    }
  | {
      entityId: string
      kind: 'artifact-version'
      versionId: string
      filename: string
      checksum: string
      sizeBytes: number
    }

export type ArtifactProvenanceGraphEdge =
  | ArtifactProvenanceGraphEntityEdge<'used'>
  | ArtifactProvenanceGraphEntityEdge<'generated'>
  | {
      kind: 'depends-on'
      activityId: string
      dependencyActivityId: string
      authority: 'authoritative' | 'advisory'
      evidenceSource: 'dependency-analysis' | 'conservative-fallback'
    }

export type ArtifactProvenanceGraphEntityEdge<Kind extends 'used' | 'generated'> = {
  kind: Kind
  activityId: string
  entityId: string
  authority: 'authoritative' | 'advisory'
  evidenceSource:
    | 'registered-contract'
    | 'runtime-observation'
    | 'explicit-transfer'
    | 'artifact-publication'
    | 'conservative-fallback'
  evidenceId?: string
  observedGenerationId?: string
  relativePath?: string
  pathPortability?: 'relative' | 'absolute'
}

export type ArtifactProvenanceGraphOutputGroup = {
  outputId: string
  activityId: string
  storageShape: Exclude<ScientificOutputStorageShape, 'single-file'>
  formatHint?: string
  memberEntityIds: string[]
  riskCodes: ScientificOutputRisk[]
}

export type ScientificOutputStorageShape = 'single-file' | 'file-set' | 'directory-tree'

export type ScientificOutputRisk =
  | 'format-validity-not-verified'
  | 'multi-file-consistency-not-verified'
  | 'database-state-not-verified'
  | 'runtime-dependent-serialization'

export type ArtifactReproducibilityRecipe = {
  schemaVersion: 1
  recipeId: string
  targetVersionId: string
  targetEntityId: string
  targetChecksum: string
  targetSourceEntityId?: string
  graphChecksum: string
  steps: ArtifactReproducibilityRecipeStep[]
  frontiers: ArtifactReproducibilityFrontierPlan[]
  environmentRequirements: ArtifactReproducibilityEnvironmentRequirement[]
  capture:
    | { state: 'sealed'; reasonCodes: [] }
    | { state: 'blocked'; reasonCodes: ArtifactReproducibilityRecipeBarrier[] }
}

export type ArtifactReproducibilityRecipeStep =
  | {
      kind: 'notebook-run'
      stepId: string
      activityId: string
      sequence: number
      runId: string
      runIndex: number
      kernelKind: 'python' | 'r'
      sourceChecksum: string
      environmentRequirementId?: string
      inputEntityIds: string[]
      outputEntityIds: string[]
    }
  | {
      kind: 'compute-job'
      stepId: string
      activityId: string
      sequence: number
      inputEntityIds: string[]
      outputEntityIds: string[]
    }

export type ArtifactReproducibilityFrontierPlan = {
  frontierId: string
  claimScope: 'end-to-end' | 'downstream-only'
  afterActivityId?: string
  stepIds: string[]
  crossingFiles: ArtifactReproducibilityRecipeFile[]
  reasonCodes: ArtifactReproducibilityRecipeBarrier[]
}

export type ArtifactReproducibilityRecipeFile = {
  entityId: string
  checksum: string
  sizeBytes: number
  contentStorageKey: string
  materializationPath: string
}

export type ArtifactReproducibilityRecipeBarrier =
  | 'target-graph-incomplete'
  | 'target-graph-conservative'
  | 'target-source-missing'
  | 'required-run-missing'
  | 'required-run-not-completed'
  | 'required-source-truncated'
  | 'unsupported-kernel-kind'
  | 'environment-lock-missing'
  | 'environment-lock-partial'
  | 'activity-evidence-not-complete'
  | 'helper-source-incomplete'
  | 'execution-evidence-truncated'
  | 'crossing-entity-unavailable'
  | 'materialization-path-conflict'
  | 'absolute-read-remapping-required'
  | 'absolute-write-not-isolated'
  | 'advisory-dependency'
  | 'ambiguous-activity-order'
  | 'compute-recipe-unavailable'
  | 'recipe-budget-exceeded'

export type ArtifactReproducibilityEnvironmentRequirement = {
  requirementId: string
  kernelKind: 'python' | 'r'
  environmentName?: string
  lockChecksum: string
  lockState: 'available' | 'partial'
}

export type NotebookHelperModuleEvidence = {
  helperId: string
  skillIdentity: string
  packageOrigin: string
  interfaceRevision: string
  registeredGeneration: string
  exports: string[]
  dependencies?: string[]
  source: string
  sourceDigest: string
}

export type ArtifactHelperEvidenceStatus = NotebookHelperEvidenceStatus

export type NotebookHelperEvidenceStatus =
  | { state: 'complete' }
  | {
      state: 'incomplete'
      reasons: Array<'source-missing' | 'source-corrupt' | 'payload-limit'>
    }

export type ArtifactReproducibilityProjection = {
  completeness: ArtifactProvenanceGraph['completeness']
  reasonCodes: ArtifactProvenanceGraphReason[]
  checkReasonCodes?: ArtifactReproducibilityRecipeBarrier[]
  targetEntityId: string
  activities: ArtifactReproducibilityActivity[]
  entities: ArtifactReproducibilityEntity[]
  outputGroups: ArtifactReproducibilityOutputGroup[]
  edges: ArtifactReproducibilityEdge[]
  startFrontiers: ArtifactReproducibilityStartFrontier[]
  executionRunCount: number
  includedNotebookRunCount: number
  skippedRunCount: number
}

export type ArtifactReproducibilityActivity = Pick<
  ArtifactProvenanceGraphActivity,
  'activityId' | 'kind' | 'sequence' | 'runIndex' | 'inclusion' | 'evidenceState'
>

export type ArtifactReproducibilityEntity = {
  entityId: string
  kind: ArtifactProvenanceGraphEntity['kind']
  label: string
  checksum: string
  sizeBytes: number
  pathPortability?: 'relative' | 'absolute'
  sourceKind?: NotebookRunInputFile['sourceKind']
}

export type ArtifactReproducibilityOutputGroup = {
  outputId: string
  activityId: string
  label: string
  storageShape: Exclude<ScientificOutputStorageShape, 'single-file'>
  formatHint?: string
  memberEntityIds: string[]
  riskCodes: ScientificOutputRisk[]
}

export type ArtifactReproducibilityEdge =
  | Pick<
      Extract<ArtifactProvenanceGraphEdge, { kind: 'used' | 'generated' }>,
      'kind' | 'activityId' | 'entityId' | 'authority' | 'evidenceSource'
    >
  | Pick<
      Extract<ArtifactProvenanceGraphEdge, { kind: 'depends-on' }>,
      'kind' | 'activityId' | 'dependencyActivityId' | 'authority' | 'evidenceSource'
    >

export type ArtifactReproducibilityStartFrontier = {
  frontierId: string
  kind: 'original-inputs' | 'checkpoint'
  claimScope: 'end-to-end' | 'downstream-only'
  eligibility: 'available' | 'limited' | 'blocked'
  afterActivityId?: string
  crossingEntityIds: string[]
  downstreamActivityIds: string[]
  reasonCodes: ArtifactReproducibilityBarrierReason[]
  checkReasonCodes?: ArtifactReproducibilityRecipeBarrier[]
  // File identities with no materialization entry in the saved plan; no live disk inspection.
  unavailableEntityIds?: string[]
}

export type ArtifactReproducibilityBarrierReason =
  | ArtifactProvenanceGraphReason
  | 'absolute-path-boundary'
  | 'activity-evidence-not-complete'
  | 'advisory-boundary'
  | 'ambiguous-activity-order'

export type ArtifactReproducibilityCheckLog = ArtifactReproducibilityCheckLogBase &
  (
    | {
        source: 'environment'
        requirementId: string
        environmentIndex: number
        environmentTotal: number
      }
    | {
        source: 'notebook'
        stepId: string
        runIndex: number
      }
  )

export type ArtifactReproducibilityCheckLogBase = {
  kernelKind: 'python' | 'r'
  stream: 'stdout' | 'stderr'
  text: string
  recordedAt?: string
  truncated?: boolean
}

export type ArtifactReproducibilityReceiptComparison = ArtifactReproducibilityCheckComparison & {
  contentComparison?: OutputComparisonReport
  contentComparisonUnavailableReason?:
    'unsupported-format' | 'budget-exceeded' | 'comparison-failed'
  stepId: string
  entityId: string
  expectedChecksum: string
  expectedSizeBytes: number
  actualChecksum?: string
  actualSizeBytes?: number
  outputCaptured?: true
  outputCaptureReason?: 'too-large' | 'storage-limit' | 'unavailable'
}

export type ArtifactReproducibilityCheckComparison = {
  relativePath: string
  status: 'matched' | 'different'
  reason?: 'missing' | 'not-file' | 'linked' | 'size-mismatch' | 'checksum-mismatch'
}
