export type ProjectFileSource = 'artifact' | 'upload'

export type ProjectFileOriginSession = {
  state: 'active' | 'deleting' | 'deleted'
  title?: string
  deletedAt?: string
}

// Renderer-facing metadata projection. File bytes remain on disk and are read lazily through the
// existing source-specific preview IPC only after this DTO has been paged into the Files view.
export type ProjectFileItem = {
  id: string
  source: ProjectFileSource
  sourceFileId: string
  sourceVersionId?: string
  checksum?: string
  projectId: string
  sessionId: string
  messageId?: string
  name: string
  path: string
  mimeType?: string
  size: number
  mtimeMs?: number
  sortAtMs: number
  originSession?: ProjectFileOriginSession
}

export type ListProjectFilesRequest = {
  projectId: string
  // Uploads and each session's artifacts are deliberately separate collections with independent
  // cursors for the Files page. The flat `all` collection is reserved for cross-session file pickers
  // that need one canonical Project Files read model rather than reconstructing Session metadata.
  collection:
    { kind: 'all' } | { kind: 'uploads' } | { kind: 'sessionArtifacts'; sessionId: string }
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
  originSession?: ProjectFileOriginSession
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
