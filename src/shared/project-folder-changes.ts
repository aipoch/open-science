// Display data identifies the exact immutable proposal reviewed by the user. Absolute storage
// locations and backup paths remain main-process authority and are never accepted from a caller.
export type ProjectFolderChange = Readonly<{
  id: string
  projectId: string
  sessionId: string
  runId: string
  relativePath: string
  operation: 'create' | 'replace' | 'delete'
  originalChecksum?: string
  candidateChecksum?: string
  candidateSizeBytes?: number
  requiresConfirmation: boolean
  state: 'prepared' | 'rejected' | 'applied' | 'reverted'
}>

export type ProjectFolderChangeScope = Readonly<{
  projectId: string
  sessionId: string
}>

export type ProjectFolderChangeApproval = (
  change: ProjectFolderChange,
  signal?: AbortSignal,
  permissionPrompts?: 'none'
) => Promise<boolean>

export type ProjectFolderRunInput = Readonly<{
  relativePath: string
  checksum?: string
  sizeBytes: number
  frozen: false
}>
export type ProjectFolderChangePage = Readonly<{ changes: ProjectFolderChange[]; nextId?: string }>
export type ProjectFolderFilePreview = Readonly<{
  text: string
  binary: boolean
  truncated: boolean
  sizeBytes: number
}>
export type ProjectFolderChangePreview = Readonly<{
  change: ProjectFolderChange
  original?: ProjectFolderFilePreview
  candidate?: ProjectFolderFilePreview
}>

export type ProjectFolderChangeRequest = ProjectFolderChangeScope & Readonly<{ id: string }>
export type ListProjectFolderChangesRequest = ProjectFolderChangeScope &
  Readonly<{ afterId?: string; limit?: number }>
