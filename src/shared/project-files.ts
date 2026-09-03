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
  sourceVersionId: string
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

export type ProjectFilesSearch = {
  // Filename substring search is ASCII case-insensitive; non-ASCII characters match literally.
  filenameContains: string
  // Active workspace surfaces exclude archived Sessions at query time so counts and cursors match
  // the visible Files catalog. Archive management continues to query without this filter.
  excludedSessionIds?: string[]
}

export type GetProjectFilesOverviewRequest = {
  projectId: string
  search?: ProjectFilesSearch
}

export type ListProjectFilesRequest = {
  projectId: string
  // Uploads and each session's artifacts are deliberately separate collections with independent
  // cursors for the Files page. The flat `all` collection is reserved for cross-session file pickers
  // that need one canonical Project Files read model rather than reconstructing Session metadata.
  collection:
    { kind: 'all' } | { kind: 'uploads' } | { kind: 'sessionArtifacts'; sessionId: string }
  search?: ProjectFilesSearch
  cursor?: string
  limit: number
}

export type ProjectFilesPage = {
  items: ProjectFileItem[]
  nextCursor?: string
  totalCount: number
}

// Compatibility lookup for a restored preview tab. Hints identify metadata only; callers still
// read file bytes through the returned logical sourceFileId/sourceVersionId pair.
export type ResolveProjectFileRequest = {
  projectId: string
  sessionId: string
  source: ProjectFileSource
  fileIdHint?: string
  identityHint: 'logical' | 'legacy'
  name: string
}

// Bounded global-search projection. The primary Project is independently paged; Other Projects
// deliberately return only a small combined sample so the command palette remains responsive.
export type SearchArtifactsRequest = {
  primaryProjectId: string
  otherProjectIds: string[]
  filenameContains?: string
  excludedSessionIds?: string[]
  primaryLimit: number
  primaryCursor?: string
  otherLimit: 0 | 1 | 2 | 3 | 4 | 5
}

export type SearchArtifactsResult = {
  primary: ProjectFilesPage
  other: ProjectFileItem[]
  isIndexComplete: boolean
}

export type ListArtifactGroupsRequest = {
  projectId: string
  search?: ProjectFilesSearch
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

// Main-only read projection used by the session-bound JavaScript host API. Latest reads come from
// ManagedFile; exact Version reads use the same source tables without exposing storage keys.
export type HostArtifactCatalogItem = {
  source: ProjectFileSource
  sourceFileId: string
  versionId: string
  versionNumber?: number
  checksum?: string
  projectId: string
  sessionId: string
  filename: string
  contentType?: string
  sizeBytes: number
  sortAtMs: number
  // Selected Version creation/registration time. Lineage nodes compare this with core provenance.
  createdAt: string
  // Input Version time captured in dependency provenance; legacy Uploads may not have one.
  sourceCreatedAt?: string
  // Parent ArtifactLineage/UploadFile creation time for the Host Artifacts public projection.
  sourceFileCreatedAt?: string
  rootFrameId: string | null
  agentFrameId: string | null
}

export type HostArtifact = {
  id: string
  filename: string
  contentType: string | null
  sizeBytes: number
  latestVersionId: string
  checksum: string | null
  projectId: string
  sessionId: string
  rootFrameId: string | null
  agentFrameId: string | null
  isUserUpload: boolean
  createdAt: string
  latestVersionCreatedAt: string
}

export type HostArtifactsResult = {
  count: number
  projectId: string
  truncated: boolean
  nextCursor?: string
  artifacts: HostArtifact[]
}
