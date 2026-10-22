import type { NotebookSessionReference } from '../../../shared/notebook'
import type { ProjectFileOriginSession } from '../../../shared/project-files'
import type { FindingLocator } from '../../../shared/reviewer'
import type { SessionPdfSourceKind } from '../../../shared/session-persistence'

export type PreviewPanelState = 'open' | 'collapsed'

export type PreviewFileFormat =
  | 'code'
  | 'markdown'
  | 'text'
  | 'json'
  | 'csv'
  | 'fasta'
  | 'html'
  | 'image'
  | 'tiff'
  | 'pdb'
  | 'molecule'
  | 'pdf'
  | 'word'
  | 'spreadsheet'
  | 'presentation'
  | 'unknown'

// Distinguishes generated artifacts from user uploads, notebook inputs, and local ("This computer")
// files when preview readers and header actions differ. 'local' files live outside app storage:
// their path is an absolute filesystem path read via window.api.localFs.
export type PreviewFileSource = 'artifact' | 'upload' | 'notebook-input' | 'literature' | 'local'

type PreviewItemBase = {
  id: string
  projectId?: string
  sessionId: string
  title: string
}

export type PreviewFileItem = PreviewItemBase & {
  type: 'file'
  source?: PreviewFileSource
  path: string
  format: PreviewFileFormat
  name: string
  mimeType?: string
  size?: number
  mtimeMs?: number
  artifactId?: string
  managedFileId?: string
  selectedVersionId?: string
  versionNumber?: number
  originSession?: ProjectFileOriginSession
}

// Tool previews share the workbench chrome with files, but keep their own render path.
export type PreviewToolItem = PreviewItemBase & {
  type: 'tool'
  // Exact local Run identity only; viewer credentials and URLs never enter preview persistence.
  replayRunTarget?: import('../../../shared/run-observation').RunObservationTarget
  replayRecordingFormat?: 'run-observation' | 'project-recording' | 'web-recording'
  replayRecordingTarget?: import('../../../shared/run-observation-recorded').RecordedObservationTarget
  sideChatId?: string
  // A message chip can request a transient Library scope without changing the durable tab format.
  libraryScopeRequest?: { section?: 'inbox'; collectionId?: string; collectionName?: string }
  toolKind?:
    | 'notebook'
    | 'files'
    | 'library'
    | 'compute'
    | 'reviewer'
    | 'plan'
    | 'subagents'
    | 'side-chat'
    | 'replay'
  // A replay tab retains its source when the left-hand discussion selects another Session.
  replaySourceProjectId?: string
  replaySourceSessionId?: string
  replayStepId?: string
  replayBranchId?: string
  // Transient explicit navigation to the player; excluded from durable preview state.
  replayRevealRequest?: number
  replayRevealMode?: 'runs' | 'replay'
  // Transient navigation-owned preview. A deliberate tab selection makes it a user reference.
  replayAutomatic?: boolean
  notebook?: NotebookSessionReference
  notebookRunId?: string
  notebookRunFocusRequest?: number
  // Reviewer-specific: which session's reviews to show, which review to select, and the active
  // finding to scroll to.
  reviewerSessionId?: string
  reviewerReviewId?: string
  reviewerActiveFindingId?: string
  planArtifactVersionId?: string
  // Session-scoped Subagents Preview: one stable item owns the selected read-only Agent Frame.
  selectedAgentFrameId?: string
}

export type PreviewSourceItem = PreviewItemBase & {
  type: 'source'
  url: string
}

export type PreviewItem = PreviewFileItem | PreviewToolItem | PreviewSourceItem

export type PendingPdfContextSelection =
  | { kind: 'staged-upload'; attachmentId: string; previewItemId: string }
  | {
      kind: 'version'
      sourceKind: SessionPdfSourceKind
      sourceFileId?: string
      sourceVersionId: string
      previewItemId: string
    }

export type PendingPdfContext =
  | PendingPdfContextSelection
  | { kind: 'multiple'; selections: readonly PendingPdfContextSelection[] }

export type PreviewProvenanceTab =
  'code' | 'sources' | 'reproducibility' | 'execution' | 'messages' | 'environment' | 'review'

export type PreviewFileViewState = {
  provenanceOpen?: boolean
  provenanceTab?: PreviewProvenanceTab
}

// The durable subset restored from persistence when a project is first activated in a session.
export type RestoredPreviewSlice = {
  items?: PreviewItem[]
  activeItemId?: string
  panelState?: PreviewPanelState
}

// Input for opening the Session reviewer panel; findingId/locator determine scroll position.
export type SessionReviewerPreviewInput = {
  sessionId: string
  reviewId: string
  findingId: string | undefined
  locator: FindingLocator | undefined
}
