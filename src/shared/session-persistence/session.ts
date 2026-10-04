import { z } from 'zod'
import type { AgentFrameworkId, ReasoningEffort, SessionAgentConfiguration } from '../settings'
import type { AcpTurnTokenUsage, AcpContextUsage } from '../acp'
import type { PermissionProfileId } from '../permission-profiles'
import type { SessionRuntimeContext } from '../session-runtime-context'
import type { ActivePlanProjection } from '../session-plan/contract'
import type {
  PersistedChatMessage,
  PersistedToolActivity,
  PersistedActivityGroup,
  PersistedArtifact
} from './message'
import type { PersistedConversationGraph } from '../conversation-graph'

export type PersistedSessionStatus =
  'idle' | 'running' | 'waiting-for-user' | 'waiting-permission' | 'waiting-plan-approval' | 'error'

export type SessionWaitReason = Extract<
  PersistedSessionStatus,
  'waiting-for-user' | 'waiting-permission' | 'waiting-plan-approval'
>

export type PersistedActiveRun = {
  promptMessageId: string
  startedAt: number
}

export type PersistedSessionResumeRecovery = {
  kind: 'resume-required'
  cause: 'app-restart' | 'cancelled' | 'connection-lost'
  // References a user Message on the active Branch. Optional for interrupted control operations
  // such as compaction, where there is no prompt to annotate.
  promptMessageId?: string
}

// Main's exact, not-yet-admitted preparation. This is ownership evidence, not conversation history.
export type PersistedPromptPreparation = {
  id: string
  projectId: string
  sessionId: string
  promptMessageId: string
  mode: 'new' | 'resume' | 'rearm'
  preparedAt: number
  runStartedAt?: number
  expectedState: PersistedPromptPreparation['previousState']
  previousState: {
    status: PersistedSessionStatus
    error?: string
    errorReportable?: boolean
    resumeRecovery?: PersistedSessionResumeRecovery
  }
  // Immutable Main-owned display evidence written on every prepare-prompt (new send, Resume,
  // edit or rearm): the original Branch's notice state before the preparation changes it. Keeps
  // the prior notice and Resume visible until admission; never used for rollback or restart
  // execution, where previousState retains those meanings.
  noticeBaseline?: {
    messageBranchId: string
    // Absent only for a legacy recovery with no original user anchor.
    promptMessageId?: string
    state: PersistedPromptPreparation['previousState']
  }
}

export type PersistedPendingHistoryReplay =
  { kind: 'all' } | { kind: 'before-message'; messageId: string }

export const delegationPolicySchema = z.enum(['allow', 'deny'])

export type DelegationPolicy = z.infer<typeof delegationPolicySchema>

export const normalizeDelegationPolicy = (value: unknown): DelegationPolicy =>
  value === 'deny' ? 'deny' : 'allow'

export type PersistedSessionBranchSource = {
  sessionId: string
  agentFrameId?: string
  messageBranchId?: string
  headMessageId?: string
}

export const SESSION_DETAILS_TITLE_MAX_LENGTH = 80

export const SESSION_DETAILS_DESCRIPTION_MAX_LENGTH = 1_000

export type PersistedSessionDetailsSource = 'fallback' | 'generated' | 'manual'

export type SessionDetailsClaim = Readonly<{
  sourceMessageId: string
  requestId: string
  queuedAt: number
}>

export type SessionDetailsAdmission = Readonly<{
  startedAt: number
  frameworkId: AgentFrameworkId
  providerId?: string
  model: string
  reasoningEffort: ReasoningEffort
}>

export type SessionDetailsUsageCapture =
  | Readonly<{ usage: AcpTurnTokenUsage; usageUnavailable?: never }>
  | Readonly<{ usage?: never; usageUnavailable: true }>

type SessionDetailsNoAdmission = Readonly<{
  startedAt?: never
  frameworkId?: never
  providerId?: never
  model?: never
  reasoningEffort?: never
}>

type SessionDetailsNoUsage = Readonly<{ usage?: never; usageUnavailable?: never }>

type SessionDetailsOptionalUsage = SessionDetailsUsageCapture | SessionDetailsNoUsage

export type PersistedSessionDetailsGeneration =
  | (SessionDetailsClaim & Readonly<{ status: 'queued' }>)
  | (SessionDetailsClaim & SessionDetailsAdmission & Readonly<{ status: 'running' }>)
  | (SessionDetailsClaim &
      SessionDetailsAdmission &
      SessionDetailsUsageCapture &
      Readonly<{ status: 'succeeded'; completedAt: number }>)
  | (SessionDetailsClaim &
      Readonly<{ status: 'failed'; completedAt: number }> &
      (
        | (SessionDetailsNoAdmission & Readonly<{ usageUnavailable: true }>)
        | (SessionDetailsAdmission & SessionDetailsUsageCapture)
      ))
  | (SessionDetailsClaim &
      SessionDetailsNoAdmission &
      SessionDetailsNoUsage &
      Readonly<{ status: 'disabled'; completedAt: number }>)
  | (SessionDetailsClaim &
      Readonly<{ status: 'superseded'; completedAt: number }> &
      (
        | (SessionDetailsNoAdmission & SessionDetailsNoUsage)
        | (SessionDetailsAdmission & SessionDetailsOptionalUsage)
      ))

type EditSessionDetailsRequestBase = Readonly<{
  projectId: string
  sessionId: string
  title: string
  description: string
}>

export type EditSessionDetailsRequest = EditSessionDetailsRequestBase &
  (
    | Readonly<{ expectedTitle: string; expectedDescription: string }>
    | Readonly<{ expectedTitle?: never; expectedDescription?: never }>
  )

// Main-owned proof linking an execution Segment to its immutable originating prompt.
// Historical entries remain available for delayed Artifact finalization after restart.
export type PersistedRuntimeSessionAdmission = {
  executionId: string
  promptMessageId: string
  promptRuntimeSegmentId: string
  rootFrameId: string
  agentFrameId: string
  messageBranchId: string
  runtimeSegmentId: string
}

const researchIdentity = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\s/\\]+$/)
  .refine((value) => value !== '.' && value !== '..' && !value.includes('\0'))

// Local organization only; never exported in a .science package or inferred from reading focus.
export const researchMembershipSchema = z
  .object({
    sourceProjectId: researchIdentity,
    sourceSessionId: researchIdentity,
    sourceImportId: researchIdentity,
    sourceTitle: z.string().max(4096)
  })
  .strict()
export type ResearchMembership = z.infer<typeof researchMembershipSchema>

export type PersistedChatSession = {
  // Main-only transient read projection. Never accepted from callers or encoded in Session JSON.
  recordProblems?: readonly import('./attention').SessionRecordProblem[]
  // Imported history has no execution authority. Absence preserves existing local Session behavior.
  packageOrigin?: import('../session-package').SessionPackageOrigin
  // Main-owned stable research grouping; initial renderer saves are validated by Main.
  researchMembership?: ResearchMembership
  // Copy receipt and recovery identity; unlike packageOrigin this grants no read-only status.
  forkOrigin?: import('../session-package').SessionPackageOrigin
  // Local message identity at Fork creation; independent of source links and usage attribution.
  forkHeadMessageId?: string
  id: string
  // App-wide, one-based sequence allocated by SQLite. Historical Session files omit it until the
  // one-time projection backfill assigns numbers in createdAt/id order and rewrites their JSON.
  number?: number
  // Owning project. On load this is authoritative from the file's directory (sessions/<projectId>/).
  projectId: string
  // Whole-Session durable revision used for optimistic concurrency. Historical files omit it and
  // restore as revision 0; Main stamps revision 1 on their next successful state transition.
  revision?: number
  // Immutable source Session and selected conversation path at Branch or Fork creation.
  // Historical Sessions omit it and remain unrelated.
  branchSource?: PersistedSessionBranchSource
  title: string
  description?: string
  sessionDetailsSource?: PersistedSessionDetailsSource
  sessionDetailsGeneration?: PersistedSessionDetailsGeneration
  // Durable one-shot eligibility exists only on newly-created root Sessions that have not yet
  // saved their first visible human message. Legacy and Branch Sessions omit it.
  sessionDetailsGenerationEligible?: true
  cwd: string
  status: PersistedSessionStatus
  agentFrameworkId?: AgentFrameworkId
  // Identifies the provider/profile session store within a framework so a restored session is never
  // resumed against an incompatible backend (for example Codex shared profile vs isolated login).
  agentBackendId?: string
  // Actual provider identity when it differs from the stable app Session id after adoption.
  providerSessionId?: string
  // Opaque identity of an in-memory provider bridge. A mismatch forces fresh adoption because hidden
  // reasoning state is intentionally not serialized.
  providerContinuityToken?: string
  // Model selected when the latest run started. Kept with the session so a later settings change
  // cannot misattribute a failed run's diagnostic report.
  agentModel?: string
  // Desired provider/model/effort for this Session. Historical files omit it and materialize the
  // preference lazily from their last applied runtime identity.
  agentConfiguration?: SessionAgentConfiguration
  // Per-conversation approval posture. Older session files omit it and safely restore to Ask.
  permissionProfile?: PermissionProfileId
  // Per-conversation auto-review toggle. Absent (older files) or non-true is treated as disabled;
  // only an explicit true enables it.
  autoReviewEnabled?: boolean
  // Per-conversation Memory toggle. Historical Sessions predate this control and preserve the
  // original behavior by restoring as enabled; only an explicit false disables Memory.
  memoryEnabled?: boolean
  // Controls admission of new delegated children for this Session. Older files omit it and restore
  // to allow. Switching to deny never cancels or hides children that were already admitted.
  delegationPolicy?: DelegationPolicy
  // Per-session enabled compute hosts (providerIds like "ssh:alias"). Stored as an array for JSON
  // compatibility; semantically a set independent from the selected execution-target pool.
  // Absent on older sessions — treated as empty (no host enabled).
  enabledComputeHosts?: string[]
  // Per-session Compute Hosts selected as execution targets. Selection is always a subset of the
  // enabled hosts. An explicit empty array distinguishes the new Available-only state from legacy
  // Session files where a missing field means every enabled host was selected.
  selectedComputeHosts?: string[]
  // Durable Session-level Compute concurrency limit. Historical Sessions omit it and continue to
  // use only their Compute Host ceilings.
  computeConcurrencyLimit?: number
  // Pins the conversation to a dedicated section at the top of the sidebar. Absent (older files) or
  // non-true restores as unpinned; only an explicit true keeps it pinned across restarts.
  pinned?: boolean
  // Main-owned reversible visibility state. Whole-session renderer saves must preserve the durable
  // value; only the dedicated archive command changes it.
  archivedAt?: number
  // Desired Specialist ID for this Session. Absent means Main Agent. The Profile is resolved fresh
  // from SpecialistService before every turn via the ID.
  specialistId?: string
  // Main-owned commit marker. True means the desired binding above is durable, but the live Agent
  // runtime has not yet confirmed that it applied the same target. User prompts fail closed until
  // Main applies the target and clears this marker. Older Session files omit it and are treated as
  // already applied.
  specialistBindingPending?: true
  // Last known context-window usage. A live attached runtime replaces or clears this snapshot; a
  // detached restored Session keeps it so the indicator survives an app restart.
  contextUsage?: AcpContextUsage
  runtimeContext?: SessionRuntimeContext
  // Read-only UI history for branch-specific Plan discovery and exact-version previews. The active
  // mutable Plan remains exclusively in runtimeContext.plan.
  planHistoryProjections?: ActivePlanProjection[]
  messages: PersistedChatMessage[]
  // Session JSON v2 authority. Flat messages/activities remain an active-Branch compatibility view.
  conversationGraph?: PersistedConversationGraph
  activities?: PersistedToolActivity[]
  activityGroups?: PersistedActivityGroup[]
  activeRun?: PersistedActiveRun
  promptPreparation?: PersistedPromptPreparation
  // Main-owned witness for the latest terminal Task Run whose Session projection was committed.
  // Historical files omit it; Task Run recovery then fails closed.
  taskRunCommitId?: string
  // Once adopted, runtime transcript/Artifact writes belong to Main. Renderer saves carry only
  // preferences and explicit user commands; this marker is never caller-authoritative.
  runtimeTranscriptOwner?: 'main'
  runtimeTranscriptReviewOwner?: {
    promptMessageId: string
    owner: 'task' | 'renderer'
  }
  runtimeTranscriptLastRun?: PersistedActiveRun
  runtimeConversationCommandIds?: string[]
  runtimeSessionAdmissions?: PersistedRuntimeSessionAdmission[]
  // Survives renderer/app restarts so a failed Resume remains retryable without reconstructing the
  // state from an error string or re-sending the interrupted prompt.
  resumeRecovery?: PersistedSessionResumeRecovery
  // A fresh provider adoption has no conversation context. The next user-authored turn replays
  // either the full completed active Branch (for an interrupted control operation) or only history
  // before an interrupted prompt. The interrupted prompt itself is never replayed.
  pendingHistoryReplay?: PersistedPendingHistoryReplay
  // The selected Branch has not yet been accepted by the provider. Resuming its old identity
  // must reset that context before replaying the selected history, including after a restart.
  branchContextResetRequired?: boolean
  error?: string
  // Whether a failed run's error is worth a GitHub issue. False for a recognized failure (a provider/
  // model error the agent relayed, or one of the app's own actionable reminders); true/absent for an
  // unknown ACP-layer failure. Resolved once when the run fails and persisted so the "Report error"
  // gate survives a reload. Absent on older files — treated as reportable (the prior behavior).
  errorReportable?: boolean
  // Identifies the artifact runtime event that owns the current finalization error. Historical
  // Sessions omit it and retain the conservative replay-clearing behavior.
  artifactErrorEventIds?: string[]
  artifacts?: PersistedArtifact[]
  // Incremented only when finalized file metadata changes; text streaming leaves it untouched.
  filesRevision?: number
  createdAt: number
  updatedAt: number
}

// SQLite-backed startup projection. It intentionally excludes messages, activities, runtime
// context, and artifact payloads; those remain in Session JSON and load only when opened.
export type SessionSummary = Readonly<{
  number: number
  researchMembership?: ResearchMembership
  importedResearch?: Readonly<{ importId: string }>
  id: string
  projectId: string
  title: string
  status: PersistedSessionStatus
  presentedStatus: PersistedSessionStatus
  // Transient Main facts; the SQLite schema remains unchanged.
  recordProblems?: readonly import('./attention').SessionRecordProblem[]
  pinned: boolean
  archivedAt?: number
  revision: number
  activeMessageCount: number
  artifactCount: number
  filesRevision: number
  createdAt: number
  updatedAt: number
  presentedActivityAt?: number
  needsStartupRecovery: boolean
  // Transient presentation hint projected from Main's durable WSL setup binding owner. It is not
  // stored in Session JSON and never carries the one-time setup token.
  wslSetup?: true
}>

export type SessionUsageProjection = Readonly<{
  sessionCreatedAt: number[]
  projectCreatedAt: number[]
  artifactCreatedAt: number[]
  runsAt: number[]
  usageEvents: Array<
    Readonly<{
      source?: 'classification' | 'literature-classification'
      scenario?: string
      usageIncomplete?: boolean
      timestamp: number
      inputTokens: number
      cacheTokens: number
      outputTokens: number
    }>
  >
  totalArtifacts: number
}>

// New session-file writes always carry the canonical graph. PersistedChatSession intentionally
// keeps the field optional so historical flat-only files remain readable and can be upgraded on
// their next write.
export type MaterializedPersistedChatSession = PersistedChatSession & {
  conversationGraph: PersistedConversationGraph
}

// Renderer-owned preferences that can be replayed onto a newer durable graph after a stale-graph
// conflict. The field list records intent explicitly, including changes that clear optional values.
export type SessionConflictRebaseField =
  | 'title'
  | 'permissionProfile'
  | 'autoReviewEnabled'
  | 'memoryEnabled'
  | 'agentConfiguration'
  | 'pinned'

export type SaveSessionOptions = {
  runtimeWriterToken?: string
  conflictRebaseFields?: SessionConflictRebaseField[]
  conversationCommands?: import('../session-conversation-command').SessionConversationCommand[]
}
