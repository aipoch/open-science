import type { ArtifactFile, ArtifactSourceFileObservation } from './artifacts'
import type {
  NotebookInputAssociation,
  NotebookKernelKind,
  NotebookInputFileSummary,
  NotebookRunEnvironmentCapture,
  NotebookRunInputFile,
  NotebookRunStatus
} from './notebook'
import type { AgentFrameworkId } from './settings'
import type {
  PersistedActivityGroup,
  PersistedMessageRole,
  PersistedToolActivity
} from './session-persistence'
import type { ArtifactVersionReviewProjection } from './reviewer'

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
  // Untrusted adapter observation hint for a local source file. Main re-observes the path under the
  // durable Notebook roots and verifies its bytes before it may support producer attribution.
  sourceFileObservation?: ArtifactSourceFileObservation
  filename: string
  contentType?: string
  titleSnapshot?: string
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

export type ArtifactRpcMethod = 'artifactCreateVersion' | 'artifactReplayVersion'

// App-issued capability scope for one active assistant turn. These fields are runtime-owned and
// must match every durable Artifact RPC call; the model and MCP process cannot widen the scope.
export type ArtifactRpcCapabilityBinding = {
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
}

export type ArtifactVersionEnvironmentEvidence = {
  capture_kind: 'completed-run'
  environment_name: string
  kernel_kind: 'python' | 'r'
  runtime_source: 'managed' | 'external'
  runtime_version?: string
  platform: string
  architecture: string
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
    }>
  }>
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
  execution_status: ArtifactVersionAvailability
  inputs: ArtifactVersionInputEvidence[]
  producer:
    | {
        state: 'available'
        notebook_session_id: string
        producer_run_id: string
        run_index: number
        kernel_kind: NotebookKernelKind
        association_method:
          'agent-declared-and-session-validated' | 'server-inferred-file-observation'
        environment_manifest_checksum?: string
      }
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
  kernelKind: NotebookKernelKind
  environmentName?: string
  script: string
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
}

// Renderer-safe execution projection. Input storage keys are resolved in main and replaced with the
// current immutable-byte availability before this value crosses IPC.
export type ArtifactExecutionSnapshot = Omit<PersistedArtifactExecutionSnapshot, 'inputFiles'> & {
  inputFiles: ProvenanceExecutionInputFile[]
}

export type ArtifactVersionProvenance = {
  descriptor: ArtifactVersionDescriptor
  contentStatus:
    { state: 'available' } | { state: 'unavailable'; reason: 'missing' | 'checksum-mismatch' }
  evidence: ArtifactVersionEvidence
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
        reason: 'not-loaded' | 'message-snapshot-pending' | 'message-snapshot-corrupt'
      }
  review:
    | {
        state: 'available'
        value: ArtifactVersionReviewProjection
      }
    | { state: 'unavailable'; reason: 'not-loaded' | 'not-triggered' }
}

export type ArtifactVersionCoreProvenance = Pick<
  ArtifactVersionProvenance,
  'descriptor' | 'contentStatus' | 'evidence'
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
  parts?: ProvenanceMessagePart[]
  artifacts?: Array<{ versionId: string; name: string }>
  createdAt: number
  hasOmittedMedia?: boolean
  agentAttribution?: {
    frameworkId: AgentFrameworkId
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
