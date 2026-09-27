import type { AgentUserChoicePrompt } from './elicitation'
import type { PlanDocumentV1 } from './session-plan/contract'
import type { AgentFrameworkId, ReasoningEffort } from './settings'
import type { ResolvedReasoningEffort } from './reasoning-effort'
import type { AcpPermissionRequest } from './acp'
import type { PermissionCapability } from './permission-grants'
import type { SideChatEntry } from './side-chat'

export type SessionRuntimeContextValue =
  | null
  | boolean
  | number
  | string
  | SessionRuntimeContextValue[]
  | { [key: string]: SessionRuntimeContextValue }

export type SessionRuntimeContextOwner =
  'plan' | 'delegatedWork' | 'permission' | 'sideChat' | 'sideChatRelays' | 'pdfContext'

export const MAX_SESSION_PDF_CONTEXTS = 3

export type SessionPdfSourceKind =
  'artifact-version' | 'upload-version' | 'literature-attachment-version'

type SessionPdfBindingBase = Readonly<{
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

export type DelegatedWorkAttemptStatus = 'running' | 'completed' | 'cancelled' | 'error'
export type DelegatedWorkCancellationReason =
  'main_agent_stop' | 'session_stop' | 'runtime_interrupted'

export type DelegatedWorkResolvedAgent =
  | Readonly<{ kind: 'main' }>
  | Readonly<{
      kind: 'specialist'
      profileId: string
      revision: number
      displayName: string
    }>

export type ResolvedSubagentModelSnapshot = Readonly<{
  frameworkId: AgentFrameworkId
  providerId: string
  backendId: string
  modelRoute:
    | 'claude-anthropic'
    | 'opencode-anthropic'
    | 'opencode-openai'
    | 'codebuddy-openai'
    | 'codex-responses'
    | 'codex-responses-compatibility'
    | 'codex-bridge'
  model: string
  reasoningEffort: ResolvedReasoningEffort
}>

export type DelegatedCallerSource = Readonly<{
  rootMessageId: string
  toolInvocationId: string
}>

export type DelegatedWorkAttemptRecord = Readonly<{
  id: string
  // Durable identity of the root Message whose Conversation Turn admitted this Attempt.
  // Legacy terminal Attempts may omit it; new initial and continuation Attempts always write it.
  initiatingTurnMessageId?: string
  status: DelegatedWorkAttemptStatus
  resolvedAgent: DelegatedWorkResolvedAgent
  executionModel?: ResolvedSubagentModelSnapshot
  runtimeSegmentIds: readonly string[]
  startedAt: number
  endedAt?: number
  terminalMessageId?: string
  cancellationReason?: DelegatedWorkCancellationReason
  error?: Readonly<{ code: string; message: string }>
}>

export type DelegatedMessageCommand = Readonly<{
  messageId: string
  requestId: string
  sourcePrincipal: string
  canonicalDigest: string
  sourceFrameId: string
  sourceAttemptId?: string
  targetFrameId: string
  targetAttemptId?: string
  continuationAttemptId?: string
  rootPromptMessageId?: string
  rootOriginMessageId: string
  callerRootMessageId: string
  rootBranchId: string
  rootBranchRevision: string
  direction: 'to_child' | 'to_parent'
  disposition: 'message' | 'continued'
  text: string
  kind: 'info' | 'question'
  replyToMessageId?: string
  retryOfMessageId?: string
  laneSequence: number
  queuedAt: number
  receipt:
    | Readonly<{ status: 'queued'; dispatchStartedAt?: number; dispatchEpoch?: string }>
    | Readonly<{
        status: 'accepted'
        acceptedAt: number
        evidence: 'provider_prompt_accepted' | 'provider_prompt_completed'
      }>
    | Readonly<{
        status: 'failed'
        failedAt: number
        error: Readonly<{ code: string; message: string; retryable: boolean }>
      }>
    | Readonly<{
        status: 'uncertain'
        uncertainAt: number
        resolution: 'pending' | 'acknowledged'
      }>
}>

export type DelegatedWorkRecord = Readonly<{
  agentFrameId: string
  attempts: readonly DelegatedWorkAttemptRecord[]
}>

export type DelegatedQuestionAnswer = Readonly<{ questionIndex: number; value: string }>

export type DelegatedQuestionRequest = Readonly<{
  requestId: string
  canonicalDigest: string
  sourceFrameId: string
  sourceAttemptId: string
  sourceRuntimeSegmentId: string
  sourceMessageBranchId: string
  rootOriginMessageId: string
  rootBranchId: string
  sourceName: string
  questions: readonly AgentUserChoicePrompt[]
  sequence?: number
  askedAt: number
  status: 'pending' | 'confirmed' | 'cancelled' | 'failed'
  draftAnswers: readonly DelegatedQuestionAnswer[]
  draftQuestionIndex: number
  answers?: readonly DelegatedQuestionAnswer[]
  respondedAt?: number
  continuationAttemptId?: string
  failure?: Readonly<{ code: string; message: string }>
}>

export type SessionDelegatedWorkRuntimeContext = Readonly<{
  records: readonly DelegatedWorkRecord[]
  recordsQuarantine?: unknown
  messageCommands?: readonly DelegatedMessageCommand[]
  messageCommandsQuarantine?: unknown
  questionRequests?: readonly DelegatedQuestionRequest[]
  questionRequestsQuarantine?: unknown
}>

export type SessionPlanApproval = 'pending' | 'approved' | 'rejected'
export type SessionPlanStepStatus = 'in_progress' | 'completed' | 'blocked' | 'skipped'
export type SessionPlanDelivery = Readonly<{
  commandId: string
  kind: 'approved-plan' | 'rejected-plan' | 'review-feedback'
  // `delivering` is a durable claim before provider acceptance has been observed. `accepted`
  // records that boundary so restart recovery can settle instead of replaying the wakeup.
  state: 'queued' | 'delivering' | 'accepted' | 'interrupted'
  originatingPromptMessageId: string
  createdAt: number
}>
export type SessionPlanRuntimeContext = Readonly<{
  artifactId: string
  artifactVersionId: string
  artifactChecksum: string
  // Verified immutable copy used to reconstruct Plan review/context while the originating Agent
  // turn is parked and its provenance Artifact Version is still awaiting publication.
  document?: PlanDocumentV1
  // The user Message whose Conversation Turn generated this Plan. Older persisted Plans may omit it.
  originatingPromptMessageId?: string
  // Durable causal boundary recorded after the Plan Artifact is verified and before approval begins.
  materializedAt?: number
  approval: SessionPlanApproval
  // A persisted user Message that asks the Agent to revise or interpret this still-pending Plan.
  // It is neutral review input, not an approval decision.
  reviewFeedbackMessageId?: string
  // One-shot approval or review-feedback handoff receipt. This is delivery state, not an execution
  // capability, and never determines whether the Plan is active or updateable.
  delivery?: SessionPlanDelivery
  stepStatuses: Readonly<
    Record<
      string,
      Readonly<{
        status: SessionPlanStepStatus
        updatedAt: number
        notes?: string
      }>
    >
  >
}>

export type SessionPermissionRuntimeContext = Readonly<{
  state: 'pending' | 'continuing'
  request: AcpPermissionRequest
  originatingPromptMessageId: string
  fingerprint: string
  categoryKey?: string
  capability?: PermissionCapability
  createdAt: number
}>

export type PersistedSideChatLifecycle = 'open' | 'interrupted' | 'error'

export type PersistedSideChatRelay = Readonly<{
  id: string
  sideChatId: string
  text: string
  createdAt: number
}>

export type PersistedSideChat = Readonly<{
  version: 1
  id: string
  lifecycle: PersistedSideChatLifecycle
  frameworkId: AgentFrameworkId
  providerId?: string
  backendId?: string
  providerSessionId?: string
  providerContinuityToken?: string
  model?: string
  reasoningEffort?: ReasoningEffort
  historyPreamble: string
  entries: readonly SideChatEntry[]
  createdAt: number
  updatedAt: number
}>

// Main-owned mutable authority embedded in the Session record. Owner modules use top-level keys
// (for example `plan`); renderer consumers receive this only as a read projection. Versioning lets a
// future incompatible envelope fail closed instead of reviving authority under unknown semantics.
export type SessionRuntimeContext = Readonly<{
  version: 1
  revision: number
  plan?: SessionPlanRuntimeContext
  delegatedWork?: SessionDelegatedWorkRuntimeContext
  permission?: SessionPermissionRuntimeContext
  pdfContext?: SessionPdfContext
  sideChat?: PersistedSideChat
  sideChats?: readonly PersistedSideChat[]
  sideChatRelays?: readonly PersistedSideChatRelay[]
}>

// Keep the legacy first-chat slot readable while extending a parent to multiple independent chats.
export const getPersistedSideChats = (
  context: SessionRuntimeContext | undefined
): readonly PersistedSideChat[] => [
  ...(context?.sideChat ? [context.sideChat] : []),
  ...(context?.sideChats ?? [])
]

export type SessionRuntimeContextPatch = Readonly<
  Partial<{
    plan: SessionPlanRuntimeContext | undefined
    delegatedWork: SessionDelegatedWorkRuntimeContext | undefined
    permission: SessionPermissionRuntimeContext | undefined
    pdfContext: SessionPdfContext | undefined
    sideChat: PersistedSideChat | undefined
    sideChats: readonly PersistedSideChat[] | undefined
    sideChatRelays: readonly PersistedSideChatRelay[] | undefined
  }>
>
