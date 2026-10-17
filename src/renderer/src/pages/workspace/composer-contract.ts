import type { Annotation } from '../../../../shared/annotation-contract'
import type { PermissionProfileId } from '../../../../shared/permission-profiles'
import type { PdfReadingPositionSource } from '../../../../shared/session-pdf-context'
import type {
  MessagePdfContextSnapshot,
  PdfReadingPosition,
  SessionPdfContextSource
} from '../../../../shared/session-pdf-contract'
import type { MessageAttribution } from '../../../../shared/session-message-contract'
import type { SessionAgentConfiguration } from '../../../../shared/settings'
import type { UploadedAttachment } from '../../../../shared/uploads'
import type { ChatSession } from '../../stores/session-store-contract'
import type { ComposerUploadTransfer } from './composer-upload-transfer'
import type { ComposerDoc } from './composer/composer-doc'
import type { SessionDiscussionCapture } from './replay/replay-context'

export type ComposerDraft = {
  // Process-local retry owner for this restored snapshot; never a Main Session field.
  retrySessionOwner?: { sessionId: string; projectId: string }
  setupSessionToken?: string
  queuedEdit?: MessageQueueEditIntent
  doc: ComposerDoc
  annotations: Annotation[]
  attachments: UploadedAttachment[]
  attachmentTransfers: ComposerUploadTransfer[]
  automaticReadingEnabled: boolean
}

export type ComposerSendSnapshot = {
  retrySessionOwner?: ComposerDraft['retrySessionOwner']
  setupSessionToken?: string
  queuedEdit?: ComposerDraft['queuedEdit']
  draftKey: string
  version: number
  doc: ComposerDoc
  annotations: Annotation[]
  discussionFocus?: SessionDiscussionCapture
  attachments: UploadedAttachment[]
  automaticReadingEnabled?: boolean
  pdfContext?: MessagePdfContextSnapshot
  pdfReadingPosition?: PdfReadingPosition
  pdfReadingPositionSource?: PdfReadingPositionSource
  pendingPdfContextAttachmentIds?: string[]
  pendingPdfContextVersions?: Array<{
    sourceKind: SessionPdfContextSource['sourceKind']
    sourceFileId?: string
    sourceVersionId: string
  }>
}

export type MessageQueuePhase = 'queued' | 'interrupting' | 'sending' | 'error'

export type MessageQueueError = {
  kind: 'branch' | 'send' | 'edit' | 'cancel'
  detail?: string
}

export type MessageQueueItem = {
  kind: 'user' | 'application'
  id: string
  sessionId: string
  agentFrameId: string
  messageBranchId: string
  snapshot?: ComposerSendSnapshot
  text: string
  attachmentCount: number
  forcedSkillIds: string[]
  permissionProfile: PermissionProfileId
  agentConfiguration?: SessionAgentConfiguration
  specialistId: string | null | undefined
  agentFrameworkId?: ChatSession['agentFrameworkId']
  agentBackendId?: string
  projectId: string
  cwd: string | undefined
  phase: MessageQueuePhase
  error?: MessageQueueError
  deferredUntilIdle?: boolean
  // Keep the dispatch reserved, but stop duplicating its real message in the queue preview.
  messageAppended?: boolean
  application?: {
    messageId: string
    attribution: Extract<MessageAttribution, { feature: 'compute' }>
    completion: Promise<{ sessionId: string; messageId: string } | undefined>
    resolve: (result: { sessionId: string; messageId: string } | undefined) => void
  }
  revisionMessageId?: string
}

export type MessageQueueEditIntent = Pick<
  MessageQueueItem,
  | 'kind'
  | 'sessionId'
  | 'agentFrameId'
  | 'messageBranchId'
  | 'permissionProfile'
  | 'agentConfiguration'
  | 'specialistId'
  | 'agentFrameworkId'
  | 'agentBackendId'
  | 'projectId'
  | 'cwd'
  | 'revisionMessageId'
>
