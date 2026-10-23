import type { SandboxNetworkApproval } from './sandbox-network-approval'
import type { AcpPermissionRequest } from './acp-permission-contract'
import type { SessionDelegatedWorkRuntimeContext } from './delegated-work-contract'
import type { ReasoningEffort } from './model-preference-contract'
import type { PermissionCapability } from './permission-grants'
import type { SessionPdfContext } from './session-pdf-contract'
import type { SessionPlanRuntimeContext } from './session-plan/contract'
import type { SessionReadingContext } from './session-reading'
import type { AgentFrameworkId } from './settings'
import type { SideChatEntry } from './side-chat-entry-contract'
export {
  type DelegatedCallerSource,
  type DelegatedMessageCommand,
  type DelegatedQuestionAnswer,
  type DelegatedQuestionRequest,
  type DelegatedWorkAttemptRecord,
  type DelegatedWorkAttemptStatus,
  type DelegatedWorkCancellationReason,
  type DelegatedWorkRecord,
  type DelegatedWorkResolvedAgent,
  type ResolvedSubagentModelSnapshot,
  type SessionDelegatedWorkRuntimeContext
} from './delegated-work-contract'
export {
  MAX_SESSION_PDF_CONTEXTS,
  type FilterSessionPdfContextCandidatesRequest,
  type FilterSessionPdfContextCandidatesResult,
  type LinkSessionPdfContextRequest,
  type MessagePdfContextSnapshot,
  type PdfReadingPosition,
  type PendingSessionPdfContextCandidate,
  type SessionPdfBinding,
  type SessionPdfContext,
  type SessionPdfContextSource,
  type UnlinkSessionPdfContextRequest
} from './session-pdf-contract'
export {
  type SessionPlanApproval,
  type SessionPlanDelivery,
  type SessionPlanRuntimeContext,
  type SessionPlanStepStatus
} from './session-plan/contract'

export type SessionRuntimeContextValue =
  | null
  | boolean
  | number
  | string
  | SessionRuntimeContextValue[]
  | { [key: string]: SessionRuntimeContextValue }

export type SessionRuntimeContextOwner =
  | 'plan'
  | 'delegatedWork'
  | 'permission'
  | 'networkApprovals'
  | 'sideChat'
  | 'sideChatRelays'
  | 'pdfContext'
  | 'sessionContext'

export type SessionPdfSourceKind =
  'artifact-version' | 'upload-version' | 'literature-attachment-version'

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
  networkApprovals?: readonly SandboxNetworkApproval[]
  permission?: SessionPermissionRuntimeContext
  sessionContext?: SessionReadingContext
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
    networkApprovals: readonly SandboxNetworkApproval[] | undefined
    permission: SessionPermissionRuntimeContext | undefined
    sessionContext: SessionReadingContext | undefined
    pdfContext: SessionPdfContext | undefined
    sideChat: PersistedSideChat | undefined
    sideChats: readonly PersistedSideChat[] | undefined
    sideChatRelays: readonly PersistedSideChatRelay[] | undefined
  }>
>
