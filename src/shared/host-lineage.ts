import type {
  ArtifactVersionAvailability,
  ArtifactVersionEnvironmentEvidence
} from './artifact-provenance'
import type { NotebookInputAssociation } from './notebook'

export type HostLineageDirection = 'up' | 'down'

export type HostLineageNode = {
  file_id: string
  version_id: string
  filename: string
  version_number: number
  session_id: string
  root_frame_id: string | null
  agent_frame_id: string | null
  created_at: string
  content_type?: string
  size_bytes: number
  checksum: string
  is_user_upload: boolean
}

export type HostLineageEdge = {
  version_id: string
  depends_on_version_id: string
  ordinal: number
  source_kind: 'artifact-version' | 'upload-version'
  input_filename: string
  association: NotebookInputAssociation
}

export type HostLineageGraph = {
  project_id: string
  root_version_id: string
  direction: HostLineageDirection
  truncated: boolean
  truncation_reason?: 'max_depth' | 'max_nodes'
  frontier_version_ids?: string[]
  nodes: HostLineageNode[]
  edges: HostLineageEdge[]
}

export type HostLineageVersion = {
  project_id: string
  artifact_id: string
  version_id: string
  filename: string
  version_number: number
  session_id: string
  root_frame_id: string
  agent_frame_id: string
  message_branch_id: string
  runtime_segment_id: string
  prompt_message_id: string
  created_at: string
  content_type?: string
  size_bytes: number
  checksum: string
  agent_name?: string
  content_status:
    { state: 'available' } | { state: 'unavailable'; reason: 'missing' | 'checksum-mismatch' }
  reproduction_code?: string
  execution_status: ArtifactVersionAvailability
  producer:
    | {
        state: 'available'
        notebook_session_id: string
        producer_run_id: string
        run_index: number
        kernel_kind: 'python' | 'r' | 'repl' | 'bash'
        association_method:
          'agent-declared-and-session-validated' | 'server-inferred-file-observation'
        environment_manifest_checksum?: string
      }
    | {
        state: 'available'
        kind: 'connector'
        connector_id: string
        tool_id: string
        invocation_id: string
        implementation_version: string
        arguments_checksum: string
        association_method: 'app-owned-handler'
      }
    | {
        state: 'unavailable'
        reason: 'producer-not-supplied' | 'producer-source-unverifiable'
      }
  environment_status: ArtifactVersionAvailability
  environment?: ArtifactVersionEnvironmentEvidence
  inputs: Array<{
    ordinal: number
    version_id: string
    file_id: string
    source_kind: 'artifact-version' | 'upload-version'
    version_number?: number
    created_at?: string
    session_id: string
    filename: string
    content_type?: string
    size_bytes: number
    checksum: string
    association: NotebookInputAssociation
  }>
}

export type HostLineageDependencyRelation = {
  versionId: string
  dependsOnVersionId: string
  ordinal: number
  sourceKind: 'artifact-version' | 'upload-version'
  inputFilename: string
  association: NotebookInputAssociation
}
