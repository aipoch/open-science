export type ProjectFileSource = 'artifact' | 'upload'

// Renderer-facing metadata projection. File bytes remain on disk and are read lazily through the
// existing source-specific preview IPC only after this DTO has been paged into the Files view.
export type ProjectFileItem = {
  id: string
  source: ProjectFileSource
  sourceFileId: string
  projectId: string
  sessionId: string
  messageId?: string
  name: string
  path: string
  mimeType?: string
  size: number
  mtimeMs?: number
  sortAtMs: number
}

export type ListProjectFilesRequest = {
  projectId: string
  // Uploads and each session's artifacts are deliberately separate collections with independent
  // cursors; flattening them would break uploads-first and session-grouped rendering.
  collection: { kind: 'uploads' } | { kind: 'sessionArtifacts'; sessionId: string }
  cursor?: string
  limit: number
}

export type ProjectFilesPage = {
  items: ProjectFileItem[]
  nextCursor?: string
  totalCount: number
}

export type ListArtifactGroupsRequest = {
  projectId: string
  cursor?: string
  limit: number
}

export type ArtifactGroupItem = {
  sessionId: string
  artifactCount: number
}

export type ArtifactGroupPage = {
  items: ArtifactGroupItem[]
  nextCursor?: string
  totalCount: number
}

export type ProjectFilesOverview = {
  totalCount: number
  uploadCount: number
  artifactCount: number
  artifactGroupCount: number
  // False means the current rows are usable but may be partial; the renderer must expose repair
  // rather than treating a zero count as an authoritative empty project.
  isIndexComplete: boolean
}

// Main-process invalidation event. A missing sessionId or reset kind invalidates every cursor layer;
// a scoped event lets the renderer reload only uploads or one artifact session plus group metadata.
export type ProjectFilesChangedEvent = {
  projectId: string
  sessionId?: string
  sources: ProjectFileSource[]
  kind: 'upsert' | 'delete' | 'reset'
}
