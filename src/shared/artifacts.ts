import type { ProjectIdScope } from './project-scope'
import type { PdfReadingPosition } from './session-persistence'

// Renderer-safe description of one generated file without embedding file contents.
export type ArtifactFile = ProjectIdScope & {
  id: string
  sessionId: string
  messageId?: string
  runId?: string
  name: string
  path: string
  fileUrl: string
  mimeType?: string
  size: number
  mtimeMs: number
  // Native Provenance Versions use id === versionId. These fields are absent on compatibility files.
  artifactId?: string
  versionId?: string
  versionNumber?: number
  // Derived from native publication authority; never persist as a second source of truth.
  isPublished?: boolean
  checksum?: string
  createdAt?: string
  producerRunId?: string
  environment?: string
}

export const artifactCreatedAtMs = (createdAt: string | undefined): number | undefined => {
  if (!createdAt) return undefined
  const timestamp = Date.parse(createdAt)
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : undefined
}

// A user-picked reference to an existing file (upload or generated output) inserted via the
// composer `@` mention. Carries the durable path so the runtime can resolve and attach the file.
export type ArtifactReference = {
  id: string
  // Stable ManagedFile identity. Optional only for legacy Message parts written before file
  // versioning; new Project Files pickers persist it separately from the UI row id.
  sourceFileId?: string
  name: string
  path: string
  source: 'upload' | 'artifact'
  mimeType?: string
  // Carries immutable version identity when the selected artifact has native provenance.
  versionId?: string
  // Trusted content identity resolved for one Agent turn. Persisted references may omit it because
  // the immutable Version id remains the authority and Notebook validates the checksum from DB.
  checksum?: string
  // App-owned send-time snapshot for a linked PDF. Ordinary @ references omit it.
  pdfReadingPosition?: PdfReadingPosition
  // App-owned identity for one document in a linked multi-PDF reading context.
  pdfContextDocumentId?: string
  pdfContextDocumentCount?: number
  pdfContextActive?: boolean
}

// Reserved reference shape for future user-linked folders. Persist only a granted root id and a
// relative path; never expose or accept an arbitrary renderer-provided absolute path.
export type LinkedFolderFileReference = {
  id: string
  name: string
  source: 'linked-folder'
  rootId: string
  relativePath: string
  mimeType?: string
}

export type FileReference = ArtifactReference | LinkedFolderFileReference

export type ArtifactWriteEncoding = 'utf8' | 'base64'

export type ArtifactWriteSource =
  | {
      kind: 'inline'
      content: string
      encoding: ArtifactWriteEncoding
    }
  | {
      kind: 'localPath'
      path: string
    }

// Trusted metadata captured by the app while importing an unchanged local source file. It remains
// internal to the main-process persistence path and is never accepted from the model tool schema.
export type ArtifactSourceFileObservation = {
  path: string
  sizeBytes: number
  mtimeMs: number
}

// Default logical Project id used when no concrete Project owns compatibility data.
export const DEFAULT_ARTIFACT_PROJECT_ID = 'default-project'

// Repository write request for files that are still scoped to an active assistant run.
export type WritePendingArtifactFileRequest = {
  projectId: string
  sessionId: string
  runId: string
  filename: string
  mimeType?: string
  kind?: 'plan'
  source: ArtifactWriteSource
}

// Renderer request to claim a runtime-generated run for a concrete message id.
export type FinalizeRunArtifactsRequest = {
  claimId: string
  messageId: string
}

// Ownership races may retry inside one event delivery. Invalid proof is returned only so the
// renderer can keep that terminal failure from offering a manual retry; operational failures reject.
export const ARTIFACT_OWNERSHIP_PERSISTENCE_RACE = 'ownership-persistence-race' as const
export const ARTIFACT_FINALIZATION_INVALID_PROOF = 'invalid-proof' as const

export type ArtifactFinalizationErrorCode =
  typeof ARTIFACT_OWNERSHIP_PERSISTENCE_RACE | typeof ARTIFACT_FINALIZATION_INVALID_PROOF

export type FinalizeRunArtifactsResult =
  | { ok: true; artifacts: ArtifactFile[] }
  | { ok: false; code: ArtifactFinalizationErrorCode; message: string }

// Renderer request to open one managed artifact through main-process path validation.
export type OpenArtifactFileRequest = {
  path: string
}

// Renderer request for a bounded text preview of one managed artifact.
export type ReadArtifactPreviewRequest = {
  path: string
  projectId?: string
  sessionId?: string
  fileId?: string
  versionId?: string
  maxBytes?: number
  encoding?: 'utf8' | 'base64'
  offset?: number
}

export type ArtifactPreviewResult = {
  content: string
  encoding: 'utf8' | 'base64'
  size: number
  truncated: boolean
  offset?: number
  nextOffset?: number
}

// Repository request that moves pending run files into a durable message directory.
export type MovePendingRunArtifactsRequest = {
  projectId: string
  sessionId: string
  sourceSessionId?: string
  runId: string
  messageId: string
  artifactVersionIds?: string[]
  provenanceContext?: {
    rootFrameId: string
    agentFrameId: string
    messageBranchId: string
    runtimeSegmentId: string
    promptMessageId: string
  }
}

// Repository request for files written during a run before the renderer finalizes them.
export type ListPendingRunArtifactsRequest = {
  projectId: string
  sessionId: string
  runId: string
}

// Public message-file list request shape before the Project id is resolved.
export type ListMessageArtifactsRequest = {
  sessionId: string
  messageId: string
}

// A copied conversation stores native generated-file Version ids in its messages, not paths or a
// second file-library entry. Keep this query small because it is issued while historical messages
// mount in the renderer.
export const MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS = 100

// Renderer input for resolving immutable native Artifact Versions referenced by one visible Session.
// Main validates the Session's persisted project ownership before applying this project scope.
export type ResolveArtifactVersionDescriptorsRequest = {
  projectId: string
  appSessionId: string
  versionIds: string[]
}

// Renderer request to re-finalize artifacts after an operational failure or crash. Compatibility
// files retain `.pending/<run>/<file>` paths; native provenance files retain immutable Version ids.
// Returns the message's finalized files so the renderer can replace stale pending references.
export type ReconcilePendingArtifactsRequest = ProjectIdScope & {
  sessionId: string
  messageId: string
  pendingPaths: string[]
  artifactVersionIds?: string[]
}

// Success remains the historical bare array so an older main process can interoperate during a
// renderer reload. Terminal proof rejection is explicit because Electron does not preserve custom
// properties on rejected Error objects.
export type ReconcilePendingArtifactsResult =
  | ArtifactFile[]
  | {
      ok: false
      code: typeof ARTIFACT_FINALIZATION_INVALID_PROOF
      message: string
    }

// Internal repository list request after the app has resolved the logical project bucket.
export type ListProjectMessageArtifactsRequest = ListMessageArtifactsRequest & {
  projectId: string
}
