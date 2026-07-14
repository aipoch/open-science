// Renderer-safe description of one generated file without embedding file contents.
export type ArtifactFile = {
  id: string
  projectName: string
  sessionId: string
  messageId?: string
  runId?: string
  name: string
  path: string
  fileUrl: string
  mimeType?: string
  size: number
  mtimeMs: number
}

// A user-picked reference to an existing file (upload or generated output) inserted via the
// composer `@` mention. Carries the durable path so the runtime can resolve and attach the file.
export type ArtifactReference = {
  id: string
  name: string
  path: string
  source: 'upload' | 'artifact'
  mimeType?: string
  // Reserved for a future version switcher; no version UI ships yet.
  versionId?: string
}

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

// Default logical project bucket used until the app exposes user-selected project names.
export const DEFAULT_ARTIFACT_PROJECT_NAME = 'default-project'

// Repository write request for files that are still scoped to an active assistant run.
export type WritePendingArtifactFileRequest = {
  projectName: string
  sessionId: string
  runId: string
  filename: string
  mimeType?: string
  source: ArtifactWriteSource
}

// Renderer request to claim a runtime-generated run for a concrete message id.
export type FinalizeRunArtifactsRequest = {
  claimId: string
  messageId: string
}

// Renderer request to open one managed artifact through main-process path validation.
export type OpenArtifactFileRequest = {
  path: string
}

// Renderer request for a bounded text preview of one managed artifact.
export type ReadArtifactPreviewRequest = {
  path: string
  maxBytes?: number
  encoding?: 'utf8' | 'base64'
}

export type ArtifactPreviewResult = {
  content: string
  encoding: 'utf8' | 'base64'
  size: number
  truncated: boolean
}

// Renderer request for the full bytes of one managed artifact (e.g. to render a PDF thumbnail).
export type ReadArtifactBytesRequest = {
  path: string
}

// Full-file bytes for a managed artifact, base64-encoded so it survives IPC structured cloning.
export type ManagedFileBytesResult = {
  data: string
  size: number
}

// Repository request that moves pending run files into a durable message directory.
export type MovePendingRunArtifactsRequest = {
  projectName: string
  sessionId: string
  sourceSessionId?: string
  runId: string
  messageId: string
}

// Repository request for files written during a run before the renderer finalizes them.
export type ListPendingRunArtifactsRequest = {
  projectName: string
  sessionId: string
  runId: string
}

// Public message-file list request shape before the project name is resolved.
export type ListMessageArtifactsRequest = {
  sessionId: string
  messageId: string
}

// Internal repository list request after the app has resolved the logical project bucket.
export type ListProjectMessageArtifactsRequest = ListMessageArtifactsRequest & {
  projectName: string
}
