export const MAX_SESSION_PDF_CONTEXTS = 3

export type SessionPdfBindingBase = Readonly<{
  version: 1
  bindingId: string
  sourceFileId: string
  sourceVersionId: string
  name: string
  mimeType: 'application/pdf'
  sizeBytes: number
  checksum: string
  linkedAt: number
}>

export type SessionPdfBinding = SessionPdfBindingBase &
  (
    | Readonly<{
        sourceKind: 'artifact-version' | 'upload-version'
        sourceSessionId: string
      }>
    | Readonly<{
        sourceKind: 'literature-attachment-version'
        sourceSessionId?: never
      }>
  )

export type SessionPdfContext = Readonly<{
  version: 1
  bindings: readonly SessionPdfBinding[]
}>

export type PdfReadingPosition = Readonly<{
  pageNumber: number
  pageCount: number
}>

export type MessagePdfContextSnapshot = SessionPdfContext &
  Readonly<{
    activeBindingId?: string
    readingPosition?: PdfReadingPosition
  }>

export type SessionPdfContextSource = Readonly<{
  sourceKind: SessionPdfBinding['sourceKind']
  sourceFileId?: string
  sourceVersionId: string
}>

export type PendingSessionPdfContextCandidate = Readonly<{
  attachmentId: string
  path: string
  name: string
  mimeType?: string
}>

export type FilterSessionPdfContextCandidatesRequest = Readonly<{
  projectId: string
  sources: readonly SessionPdfContextSource[]
  pendingAttachments?: readonly PendingSessionPdfContextCandidate[]
}>

export type FilterSessionPdfContextCandidatesResult = Readonly<{
  sources: readonly SessionPdfContextSource[]
  pendingAttachmentIds: readonly string[]
  unavailableSources?: readonly SessionPdfContextSource[]
}>

export type LinkSessionPdfContextRequest = Readonly<{
  projectId: string
  sessionId: string
  expectedRevision: number
  sources: readonly SessionPdfContextSource[]
  excludeSinglePage?: boolean
}>

export type UnlinkSessionPdfContextRequest = Readonly<{
  projectId: string
  sessionId: string
  expectedRevision: number
  bindingId: string
}>
