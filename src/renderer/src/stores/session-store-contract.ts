import type {
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind
} from '@agentclientprotocol/sdk'
import type { ElicitationProjection, ElicitationValue } from '../../../shared/elicitation'
import type { PermissionProfileId } from '../../../shared/permission-profiles'
import type { SessionAttention } from '../../../shared/session-attention-contract'
import type {
  PersistedArtifact,
  PersistedChatMessage
} from '../../../shared/session-message-contract'
import type { PersistedSessionStatus } from '../../../shared/session-run-contract'
import type { PersistedChatSession, SessionSummary } from '../../../shared/session-persistence'
import type { ActivePlanProjection } from '../../../shared/session-plan/contract'
import type { SessionInteractionState } from './session-interaction-contract'

export type SessionStatus = PersistedSessionStatus

export type ChatMessage = PersistedChatMessage & { sortIndex?: number }

export type ToolActivityStatus = ToolCallStatus

export type ToolActivity = {
  id: string
  kind: 'tool'
  title: string
  activityGroupId?: string
  promptMessageId?: string
  status: ToolActivityStatus
  toolDisposition?: 'declined' | 'permission-closed'
  executionInvocationId?: string
  // Set only by the main-process permission owner, never by provider metadata.
  appOwned?: true
  eventIds: string[]
  sortIndex: number
  providerToolName?: string
  toolKind?: ToolKind
  toolContent?: ToolCallContent[]
  toolLocations?: ToolCallLocation[]
  rawInput?: unknown
  rawOutput?: unknown
  terminalOutput?: string
  terminalExitCode?: number | null
  elicitation?: ElicitationProjection
  createdAt: number
  updatedAt: number
}

export type ChatArtifact = PersistedArtifact & { isPublished?: boolean }

export type ElicitationEditDraft = {
  requestId: string
  values: Record<string, ElicitationValue | undefined>
  activeQuestionIndex: number
}

export type ChatSession = Omit<
  PersistedChatSession,
  'messages' | 'activities' | 'permissionProfile' | 'artifacts'
> & {
  artifacts?: ChatArtifact[]
  permissionProfile?: PermissionProfileId
  messages: ChatMessage[]
  activities?: ToolActivity[]
  elicitationEditDrafts?: Record<string, ElicitationEditDraft>
  activePlanProjection?: ActivePlanProjection
  planHistoryProjections?: ActivePlanProjection[]
  isPending?: boolean
  // Renderer-only identity of the durable seed while the optimistic Session is being prepared.
  pendingBindingSessionId?: string
  // Transient presentation hint returned from Main's durable WSL setup binding. It carries no
  // authority and is refreshed from startup summaries and create/resume responses rather than
  // persisted by renderer.
  wslSetup?: true
  // Lightweight import identity is available before the transcript is hydrated.
  importedResearch?: SessionSummary['importedResearch']
  // Transient: the first send has captured Delegation, but Main has not acknowledged the new
  // Session policy yet. Binding an Agent Session does not make this policy authoritative.
  delegationPolicyAuthorityPending?: true
  // Transient: renameSession wrote a title that disk has not acknowledged.
  unsavedTitle?: true
  interrupted?: boolean
  fixLoopActive?: boolean
  compacting?: boolean
  agentStatus?: string
  awaitingFirstAgentOutput?: boolean
  agentPromptInFlight?: boolean
  // Transient provenance owner for responses emitted while an interrupted turn is resumed.
  activeRunRuntimeSegmentId?: string
  specialistSwitchResetRequired?: boolean
  // Transient: a restored durable choice resumed into a fresh Agent context. Keep the request id
  // until its hidden continuation is accepted so a renderer/IPC retry replays the same history.
  elicitationHistoryReplayRequestId?: string
  branchSwitchBlocked?: boolean
  conversationGraphSyncBlocked?: boolean
  pendingContextReplayMessageId?: string
  // Transient independent facts for the blocking lane. Plan remains owned by its durable
  // projection, while Side chat remains an overlay that never settles these facts.
  interactionState?: SessionInteractionState
  // False only for a SQLite-backed startup row whose transcript JSON has not been opened yet.
  contentLoaded?: false
  activeMessageCount?: number
  artifactCount?: number
  presentedActivityAt?: number
  attention?: SessionAttention
}
