import type { ArtifactFile, ArtifactSourceFileObservation, ArtifactWriteSource } from './artifacts'
import type { ArtifactLiteratureManifest, ArtifactLiteratureRequest } from './artifact-literature'
import type {
  NotebookInputAssociation,
  NotebookInputAccessEvidence,
  NotebookHelperModuleEvidence,
  NotebookHelperEvidenceStatus,
  NotebookKernelKind,
  NotebookInputFileSummary,
  NotebookRunEnvironmentCapture,
  NotebookRunEnvironmentLockCapture,
  NotebookRunInputFile,
  NotebookRunStatus
} from './notebook'
import type {
  MessageAttribution,
  PersistedActivityGroup,
  PersistedMessageRole,
  PersistedToolActivity
} from './session-persistence'
import type { ArtifactVersionReviewProjection } from './reviewer'
import type { ComputeJobStatus } from './compute'
import type {
  ExecutionFileEvidenceReason,
  ScientificOutputRisk,
  ScientificOutputStorageShape
} from './execution-file-evidence'

export type CreateArtifactVersionRequest = {
  projectId: string
  appSessionId: string
  artifactStorageSessionId: string
  artifactRunId: string
  writeOperationId: string
  writeRequestChecksum: string
  rootFrameId: string
  agentFrameId: string
  messageBranchId: string
  messageBranchAncestry?: string[]
  messageAncestry?: string[]
  runtimeSegmentId: string
  promptMessageId: string
  agentName?: string
  notebookSessionId?: string
  producerRunId?: string
  // App-owned adapter classification of the imported source. Legacy or unclassified requests stay
  // fail-closed when producer attribution would otherwise depend on the absence of a file observation.
  sourceKind?: ArtifactWriteSource['kind']
  // Untrusted adapter observation hint for a local source file. Main re-observes the path under the
  // durable Notebook roots and verifies its bytes before it may support producer attribution.
  sourceFileObservation?: ArtifactSourceFileObservation
  filename: string
  contentType?: string
  titleSnapshot?: string
  resourceReservationId?: string
  resourceSizeBytes?: number
  resourceChecksum?: string
  literature?: ArtifactLiteratureRequest
}

export type ReserveArtifactWriteRequest = {
  projectId: string
  appSessionId: string
  artifactStorageSessionId: string
  artifactRunId: string
  writeOperationId: string
  filename: string
  fileBytes: number
}

export type ArtifactWriteReservation = {
  id: string
  fileBytes: number
  expiresAt: number
}

export type ReleaseArtifactWriteReservationRequest = {
  projectId: string
  appSessionId: string
  artifactStorageSessionId: string
  artifactRunId: string
  reservationId: string
}

export type ReplayArtifactVersionRequest = {
  projectId: string
  appSessionId: string
  artifactStorageSessionId: string
  artifactRunId: string
  writeOperationId: string
  filename: string
  contentType?: string
  producerRunId?: string
}

export type ArtifactRpcMethod =
  | 'artifactReserveWrite'
  | 'artifactReleaseWrite'
  | 'artifactCreateVersion'
  | 'artifactReplayVersion'

// App-issued capability scope for one active assistant turn. These fields are runtime-owned and
// must match every durable Artifact RPC call; the model and MCP process cannot widen the scope.
export type ArtifactRpcCapabilityBinding = {
  executionId?: string
  projectId: string
  appSessionId: string
  artifactStorageSessionId: string
  artifactRunId: string
  rootFrameId: string
  agentFrameId: string
  messageBranchId: string
  messageBranchAncestry?: readonly string[]
  messageAncestry?: readonly string[]
  runtimeSegmentId: string
  promptMessageId: string
  agentName?: string
  notebookSessionId?: string
  allowedMethods?: ArtifactRpcMethod[]
}

export type ArtifactVersionFile = ArtifactFile & {
  artifactId: string
  versionId: string
  versionNumber: number
  checksum: string
  createdAt: string
  producerRunId?: string
  environment?: string
}

export type FinalizeArtifactVersionsRequest = {
  projectId: string
  appSessionId: string
  artifactRunId: string
  artifactVersionIds: string[]
  rootFrameId: string
  agentFrameId: string
  messageBranchId: string
  runtimeSegmentId: string
  promptMessageId: string
  messageId: string
  messageBranchAncestry?: string[]
  messageAncestry?: string[]
}

export type GetArtifactLineageRequest = {
  projectId: string
  appSessionId: string
  artifactId: string
  versionId?: string
  cursor?: string
}

export type GetArtifactVersionProvenanceRequest = GetArtifactLineageRequest & {
  versionId: string
}

export type ArtifactVersionIdentity = GetArtifactVersionProvenanceRequest

const ARTIFACT_VERSION_LOCATOR_PREFIX = 'artifact-version:'

// Renderer state persists this opaque, root-independent identity instead of a local filesystem path.
// Main parses it and resolves the immutable Version through SQLite after every data-root migration.
export const createArtifactVersionLocator = (identity: ArtifactVersionIdentity): string =>
  `${ARTIFACT_VERSION_LOCATOR_PREFIX}${[
    identity.projectId,
    identity.appSessionId,
    identity.artifactId,
    identity.versionId
  ]
    .map(encodeURIComponent)
    .join('/')}`

export const parseArtifactVersionLocator = (value: string): ArtifactVersionIdentity | undefined => {
  if (!value.startsWith(ARTIFACT_VERSION_LOCATOR_PREFIX)) return undefined
  const parts = value.slice(ARTIFACT_VERSION_LOCATOR_PREFIX.length).split('/')
  if (parts.length !== 4 || parts.some((part) => part.length === 0)) return undefined

  try {
    const [projectId, appSessionId, artifactId, versionId] = parts.map(decodeURIComponent)
    if (!projectId || !appSessionId || !artifactId || !versionId) return undefined
    return { projectId, appSessionId, artifactId, versionId }
  } catch {
    return undefined
  }
}

// Lineage crosses IPC and is persisted in renderer state, so it deliberately excludes root-bound
// path/fileUrl fields. File access goes through the opaque Artifact Version locator above.
export type ArtifactVersionDescriptor = Omit<ArtifactVersionFile, 'path' | 'fileUrl'> & {
  state: 'pending' | 'finalized'
  messageId?: string
  // Presence only: the full immutable manifest stays behind the Version provenance read.
  hasLiterature?: boolean
  // Optional for renderer state written before managed text editing shipped. New native lineage
  // projections always classify the version so user edits are never presented as Agent output.
  originKind?: 'agent_generated' | 'user_edit' | 'legacy'
  basedOnVersionId?: string
}

export type ArtifactLineageProvenance = {
  artifactId: string
  filename: string
  originSession: {
    sessionId: string
    state: 'active' | 'deleting' | 'deleted'
    title?: string
    deletedAt?: string
  }
  versions: ArtifactVersionDescriptor[]
  nextCursor?: string
  selectedVersion?: ArtifactVersionDescriptor
  headVersion?: ArtifactVersionDescriptor
  basedOnVersion?: ArtifactVersionDescriptor
  previousVersion?: ArtifactVersionDescriptor
  nextVersion?: ArtifactVersionDescriptor
}

type ArtifactEnvironmentUnavailableReason = Extract<
  NotebookRunEnvironmentCapture,
  { state: 'unavailable' }
>['reason']

export type ArtifactProducerUnavailableReason =
  'producer-not-supplied' | 'producer-source-unverifiable'

export type ArtifactVersionAvailability =
  | { state: 'available' | 'partial' }
  | {
      state: 'unavailable'
      reason: ArtifactProducerUnavailableReason | ArtifactEnvironmentUnavailableReason
    }

export type ArtifactVersionInputEvidence = {
  ordinal: number
  input_file_version_id: string
  source_kind: 'upload-version' | 'artifact-version'
  source_file_id: string
  source_version_number?: number
  source_created_at?: string
  source_project_id: string
  source_session_id: string
  filename: string
  content_type?: string
  size_bytes: number
  checksum: string
  storage_key: string
  strongest_association: NotebookInputAssociation
  access_evidence?: NotebookInputAccessEvidence
}

export type ArtifactConnectorArgumentValue =
  | null
  | boolean
  | number
  | string
  | ArtifactConnectorArgumentValue[]
  | { [key: string]: ArtifactConnectorArgumentValue }

// Only app-owned Connector handlers may supply this receipt. It is deliberately not part of the
// Artifact MCP/RPC request so a model or custom MCP server cannot promote its own claims to trusted
// producer evidence.
export type AppGeneratedArtifactProducer = {
  kind: 'connector'
  connectorId: string
  toolId: string
  invocationId: string
  implementationVersion: string
  normalizedArguments: { [key: string]: ArtifactConnectorArgumentValue }
  inputFiles?: NotebookRunInputFile[]
}

export type ArtifactConnectorExecutionEvidence = {
  schema_version: 1
  normalized_arguments: { [key: string]: ArtifactConnectorArgumentValue }
  arguments_checksum: string
}

export type ArtifactComputeExecutionEvidence = {
  activity_id: string
  provider_id: string
  shape: string
  status: ComputeJobStatus
  file_evidence: {
    state: 'available' | 'partial' | 'unavailable'
    evidence_id?: string
    checksum?: string
    storage_key?: string
    generation_count?: number
    reason_codes: ExecutionFileEvidenceReason[]
  }
}

export type ArtifactNotebookProducerEvidence = {
  state: 'available'
  notebook_session_id: string
  producer_run_id: string
  run_index: number
  kernel_kind: NotebookKernelKind
  association_method: 'agent-declared-and-session-validated' | 'server-inferred-file-observation'
  environment_manifest_checksum?: string
}

export type ArtifactConnectorProducerEvidence = {
  state: 'available'
  kind: 'connector'
  connector_id: string
  tool_id: string
  invocation_id: string
  implementation_version: string
  arguments_checksum: string
  association_method: 'app-owned-handler'
}

export const isArtifactNotebookProducer = (
  producer: ArtifactVersionEvidence['producer']
): producer is ArtifactNotebookProducerEvidence =>
  producer.state === 'available' && !('kind' in producer)

export type ArtifactPackageSourceEvidence =
  | { type: 'github'; repository: string; ref?: string; commit?: string; subdirectory?: string }
  | { type: 'bioconductor'; version?: string }

export type ArtifactVersionEnvironmentEvidence = {
  execution_context?: import('./notebook-execution-context').NotebookExecutionContext
  capture_kind: 'completed-run'
  environment_name: string
  kernel_kind: 'python' | 'r'
  runtime_source: 'managed' | 'external'
  runtime_version?: string
  platform?: string
  architecture?: string
  packages: Array<{
    name: string
    version?: string
    version_status: 'known' | 'unavailable'
    ecosystem: 'python' | 'r' | 'native' | 'unknown'
    evidence_sources: Array<
      | 'python-importlib-metadata'
      | 'python-kernel-modules'
      | 'r-installed-packages'
      | 'r-session-info'
    >
    loaded_state: 'attached' | 'loaded' | 'installed-only' | 'unknown'
    library_rank?: number
    library_scope?: 'environment' | 'user' | 'system' | 'unknown'
    built_for_runtime?: string
    priority?: 'base' | 'recommended' | 'other'
    source?: ArtifactPackageSourceEvidence
  }>
  python_version?: string
  r_version?: string
  inventory_sources: Array<'kernel-native' | 'interpreter-native' | 'operation-log'>
  installed_inventory: {
    captured_at: string
    source: 'full-scan' | 'cache-reused'
    validation: 'full-scan' | 'best-effort'
  }
  op_log?: Array<{
    operation_id: string
    timestamp: string
    operation: 'create' | 'install' | 'uninstall' | 'update'
    packages: string[]
    result: 'success' | 'failure'
    attempts: Array<{
      group_ordinal: number
      installer:
        | 'conda'
        | 'pip'
        | 'uv'
        | 'poetry'
        | 'r-install-packages'
        | 'renv'
        | 'pak'
        | 'biocmanager'
        | 'github'
        | 'unknown'
      packages: string[]
      status: 'succeeded' | 'failed' | 'skipped'
      mutation_risk: 'none' | 'possible' | 'confirmed' | 'unknown'
      reason?:
        | 'package-not-found'
        | 'solver-failed'
        | 'installer-unavailable'
        | 'permission'
        | 'network'
        | 'authentication'
        | 'tls-policy'
        | 'validation'
        | 'cancelled'
        | 'process-unconfirmed'
        | 'recovery-blocked'
        | 'unknown'
    }>
    fallback_used: boolean
    inventory_refresh: 'published' | 'unchanged' | 'failed'
    inventory_refresh_attempts: Array<{
      attempt: number
      trigger: 'terminal' | 'recovery'
      timestamp: string
      result: 'published' | 'unchanged' | 'failed'
      error?: string
    }>
    package_changes?: Array<{
      name: string
      ecosystem: 'python' | 'r' | 'native' | 'unknown'
      relationship: 'requested' | 'dependency' | 'unattributed'
      change: 'installed' | 'updated' | 'removed' | 'unchanged' | 'observed'
      before_version?: string
      after_version?: string
      library_rank?: number
      library_scope?: 'environment' | 'user' | 'system' | 'unknown'
      source?: ArtifactPackageSourceEvidence
    }>
  }>
  op_log_truncation?: {
    omitted_count: number
    earliest_retained_at?: string
  }
  captured_at: string
  source_manifest_checksum: string
  complete: boolean
  capture_status: 'complete' | 'partial'
  warnings?: string[]
}

export type ArtifactVersionEvidence = {
  schema_version: 1
  project_id: string
  app_session_id: string
  artifact_id: string
  version_id: string
  version_number: number
  filename: string
  content_type?: string
  size_bytes: number
  checksum: string
  created_at: string
  agent_name?: string
  conversation: {
    root_frame_id: string
    agent_frame_id: string
    message_branch_id: string
    runtime_segment_id: string
    prompt_message_id: string
  }
  is_user_upload: false
  reproduction_code?: string
  execution_snapshot_checksum?: string
  connector_execution?: ArtifactConnectorExecutionEvidence
  compute_executions?: ArtifactComputeExecutionEvidence[]
  execution_status: ArtifactVersionAvailability
  inputs: ArtifactVersionInputEvidence[]
  producer:
    | ArtifactNotebookProducerEvidence
    | ArtifactConnectorProducerEvidence
    | { state: 'unavailable'; reason: ArtifactProducerUnavailableReason }
  environment?: ArtifactVersionEnvironmentEvidence
  environment_status: ArtifactVersionAvailability
}

export type ProvenanceNotebookOutput =
  | { type: 'text'; text: string; truncated?: boolean }
  | { type: 'error'; name?: string; message: string; traceback?: string[] }
  | { type: 'table'; columns: string[]; rowCount: number; previewRows: unknown[][] }
  | { type: 'omitted-media'; mimeType: string; byteLength?: number }

export type ProvenanceNotebookRun = {
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

export type ArtifactHelperEvidenceStatus = NotebookHelperEvidenceStatus

export type ArtifactNotebookHelperEvidence = Omit<
  NotebookHelperModuleEvidence,
  'source' | 'dependencies'
> & {
  sourceAvailable: boolean
}

export type ArtifactExecutionInputAvailability =
  | { state: 'available' }
  | {
      state: 'unavailable'
      reason: 'input-content-missing' | 'input-content-corrupt'
    }

export type ProvenanceExecutionInputFile = NotebookInputFileSummary & {
  availability: ArtifactExecutionInputAvailability
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
  inclusion: 'target-closure' | 'kernel-epoch-conservative'
  evidenceState: 'available' | 'partial' | 'unavailable'
  evidenceId?: string
  evidenceChecksum?: string
  evidenceReasonCodes?: ExecutionFileEvidenceReason[]
}

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

type ArtifactProvenanceGraphEntityEdge<Kind extends 'used' | 'generated'> = {
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

export type ArtifactProvenanceGraphOutputGroup = {
  outputId: string
  activityId: string
  storageShape: Exclude<ScientificOutputStorageShape, 'single-file'>
  formatHint?: string
  memberEntityIds: string[]
  riskCodes: ScientificOutputRisk[]
}

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

export type ArtifactReproducibilityBarrierReason =
  | ArtifactProvenanceGraphReason
  | 'absolute-path-boundary'
  | 'activity-evidence-not-complete'
  | 'advisory-boundary'
  | 'ambiguous-activity-order'

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

// Read-only renderer projection derived from the immutable graph. It deliberately excludes storage
// keys, evidence object ids, and original absolute path strings.
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

export type ArtifactReproducibilityRecipeFile = {
  entityId: string
  checksum: string
  sizeBytes: number
  contentStorageKey: string
  materializationPath: string
}

export type ArtifactReproducibilityFrontierPlan = {
  frontierId: string
  claimScope: 'end-to-end' | 'downstream-only'
  afterActivityId?: string
  stepIds: string[]
  crossingFiles: ArtifactReproducibilityRecipeFile[]
  reasonCodes: ArtifactReproducibilityRecipeBarrier[]
}

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

// Persisted only in main-process SQLite/immutable execution.json. storageKey is required to verify and
// resolve the exact input Version, but this type must never cross the renderer IPC seam.
export type PersistedArtifactExecutionSnapshot = {
  schemaVersion: 2
  rootFrameId: string
  agentFrameId: string
  messageBranchId: string
  terminalPromptMessageId: string
  producerRunId: string
  producerRunIndex: number
  createdAt: string
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

// Renderer-safe execution projection. Input storage keys are resolved in main and replaced with the
// current immutable-byte availability before this value crosses IPC.
export type ArtifactExecutionSnapshot = Omit<
  PersistedArtifactExecutionSnapshot,
  'inputFiles' | 'helperModules' | 'provenanceGraph' | 'reproducibilityRecipe'
> & {
  inputFiles: ProvenanceExecutionInputFile[]
  helperModules?: ArtifactNotebookHelperEvidence[]
  reproducibility?: ArtifactReproducibilityProjection
}

export type ArtifactVersionProvenance = {
  descriptor: ArtifactVersionDescriptor
  contentStatus:
    { state: 'available' } | { state: 'unavailable'; reason: 'missing' | 'checksum-mismatch' }
  evidence: ArtifactVersionEvidence
  literature?: ArtifactLiteratureManifest
  execution?: ArtifactExecutionSnapshot
  messages:
    | {
        state: 'available'
        items: ProvenanceMessage[]
        activities: PersistedToolActivity[]
        activityGroups: PersistedActivityGroup[]
      }
    | {
        state: 'unavailable'
        reason:
          | 'not-loaded'
          | 'message-snapshot-pending'
          | 'message-snapshot-unsupported'
          | 'message-snapshot-corrupt'
      }
  review:
    | {
        state: 'available'
        value: ArtifactVersionReviewProjection
      }
    | {
        state: 'unavailable'
        reason: 'not-loaded' | 'not-triggered' | 'source-session-unavailable'
      }
}

export type ArtifactVersionCoreProvenance = Pick<
  ArtifactVersionProvenance,
  'descriptor' | 'contentStatus' | 'evidence' | 'literature'
>

export type ArtifactVersionExecutionProvenance = Pick<ArtifactVersionProvenance, 'execution'>
export type ArtifactVersionMessagesProvenance = Pick<ArtifactVersionProvenance, 'messages'>
export type ArtifactVersionReviewProvenance = Pick<ArtifactVersionProvenance, 'review'>

export type ProvenanceMessagePart =
  | { type: 'text'; text: string }
  | { type: 'skill'; name: string }
  | { type: 'artifact'; versionId?: string; name: string }

export type ProvenanceMessage = {
  id: string
  parentMessageId?: string
  supersedesMessageId?: string
  role: PersistedMessageRole
  content: string
  attribution?: MessageAttribution
  parts?: ProvenanceMessagePart[]
  artifacts?: Array<{ versionId: string; name: string }>
  createdAt: number
  hasOmittedMedia?: boolean
  agentAttribution?: {
    frameworkId: string
    agentName?: string
    model?: string
  }
}

type ArtifactMessageSnapshotBase = {
  snapshotId: string
  rootFrameId: string
  agentFrameId: string
  messageBranchId: string
  terminalMessageId: string
  createdAt: string
  messages: ProvenanceMessage[]
}

export type ArtifactMessageSnapshotFile =
  | (ArtifactMessageSnapshotBase & { schemaVersion: 2 })
  | (ArtifactMessageSnapshotBase & {
      schemaVersion: 3
      activities: PersistedToolActivity[]
      activityGroups: PersistedActivityGroup[]
    })
