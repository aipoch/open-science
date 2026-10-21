import type { ToolCallContent, ToolCallLocation, ToolKind, Usage } from '@agentclientprotocol/sdk'
import type { AcpMessageImage, AcpReplayMessageImage } from './acp-image-contract'
import { ACP_MESSAGE_IMAGE_EVENT_TEXT, sanitizeAcpMessageImage } from './acp-image-contract'
import type { AcpPermissionGrant, AcpPermissionRequest } from './acp-permission-contract'
import type {
  AcpContextUsage,
  AcpContextUsageBreakdown,
  AcpContextUsageCategory,
  AcpContextUsageCategoryKey,
  AcpContextWindowSample,
  AcpContextWindowSampleSource,
  AcpModelCallUsage,
  AcpPromptStopReason,
  AcpPromptTermination,
  AcpTerminalContextWindow,
  AcpTurnTokenUsage
} from './acp-usage-contract'
import type { ArtifactFile, FileReference } from './artifacts'
import type { DelegatedQuestionAnswer } from './delegated-work-contract'
import type {
  AgentTurnProvenanceContext,
  ElicitationResponse as BaseElicitationResponse,
  ElicitationProjection,
  PendingElicitationRequest
} from './elicitation'
import type { PermissionProfileId, SessionPermissionProfileState } from './permission-profiles'
import type { MessageAttribution, MessagePart, SessionReference } from './session-message-contract'
import type { AgentFrameworkId, SessionAgentConfiguration } from './settings'
import type { PersistedUploadedAttachment, UploadedAttachment } from './uploads'
export {
  ACP_MESSAGE_IMAGE_EVENT_TEXT,
  MAX_ACP_MESSAGE_IMAGE_BYTES,
  MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE,
  MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE,
  MAX_ACP_SESSION_IMAGE_BYTES,
  sanitizeAcpMessageImage,
  type AcpMessageImage,
  type AcpMessageImageMimeType,
  type AcpReplayMessageImage
} from './acp-image-contract'
export {
  type AcpPermissionGrant,
  type AcpPermissionGrantScope,
  type AcpPermissionOption,
  type AcpPermissionRequest,
  type AcpPermissionScope
} from './acp-permission-contract'
export {
  type AcpContextUsage,
  type AcpContextUsageBreakdown,
  type AcpContextUsageCategory,
  type AcpContextUsageCategoryKey,
  type AcpContextWindowSample,
  type AcpContextWindowSampleSource,
  type AcpModelCallUsage,
  type AcpModelStepTokenUsage,
  type AcpPromptStopReason,
  type AcpPromptTermination,
  type AcpTerminalContextWindow,
  type AcpTurnTokenUsage
} from './acp-usage-contract'

export {
  isDurableAgentUserChoiceRequest,
  isValidElicitationValue,
  MAX_ELICITATION_MESSAGE_CHARS,
  resolveAgentUserChoiceQuestions
} from './elicitation'
export type {
  AgentTurnProvenanceContext,
  AgentUserChoiceQuestion,
  ElicitationAnswer,
  ElicitationField,
  ElicitationProjection,
  ElicitationValue,
  PendingElicitationRequest
} from './elicitation'

export type ElicitationResponse = BaseElicitationResponse & {
  delegatedQuestion?: Readonly<{
    projectId: string
    sessionId: string
    action: 'draft' | 'confirm'
    answers: readonly DelegatedQuestionAnswer[]
    questionIndex?: number
  }>
  // Added only when a restored provider session had to adopt fresh context. The bounded transcript
  // and media use the same replay path as ordinary post-reset prompts.
  historyReplay?: {
    historyPreamble?: string
    historyAttachments?: UploadedAttachment[]
    historyImages?: AcpReplayMessageImage[]
  }
}
export const MAX_ACP_RUNTIME_EVENTS = 500

export type AcpConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'closed'

export type AcpRuntimeEventKind =
  | 'system'
  | 'message'
  | 'thought'
  | 'tool'
  | 'plan'
  | 'permission'
  | 'artifact'
  | 'compaction'
  | 'error'
  | 'stop'
  | 'raw'

// Durable renderer marker for compaction lifecycle rows stored through the existing tool-activity
// projection. The runtime event remains `kind: 'compaction'`; this value only identifies its transcript
// activity after persistence and replay.
export const ACP_CONTEXT_COMPACTION_ACTIVITY_TOOL_NAME = 'ContextCompaction'

export type AcpRuntimeEventLevel = 'info' | 'warning' | 'error'

export type AcpHandoffFailure = {
  targetName: string | null
  generation: number
  failedPhase: 'stop-or-reconfigure' | 'continuation-startup'
  retryable: true
}

// Title of the error event marking a genuinely failed prompt turn. Shared between the runtime
// producer and consumers (e.g. desktop notifications) that must distinguish turn failures from
// ancillary session-scoped errors (artifact cleanup, cancel timeout) — a copy edit here updates
// both sides at once.
export const ACP_PROMPT_FAILED_EVENT_TITLE = 'Prompt failed'

// An application continuation can fail before acquiring a durable turn outcome.
export const ACP_APP_CONTINUATION_FAILED_EVENT_TITLE = 'Could not continue the Agent task'

// Live, non-terminal notice that Artifact cleanup failed after the turn settled. It never rewrites
// the Turn Outcome and is not an Artifact publication failure.
export const ACP_ARTIFACT_CLEANUP_FAILED_EVENT_TITLE = 'Artifact cleanup failed'

// Main owns restored permission authority. These lifecycle events let renderer projections follow
// durable settlement without making the renderer part of the persistence protocol.
export const ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE =
  'Restored permission continuation re-armed'
export const ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE =
  'Restored permission continuation settled'
export const ACP_RESTORED_PERMISSION_CLEAR_FAILED_EVENT_TITLE =
  'Permission continuation completed but its wait could not be cleared'
export const ACP_RESTORED_PERMISSION_REARM_FAILED_EVENT_TITLE =
  'Permission continuation failed and its wait could not be restored'

// Marks a prompt failure the app can auto-recover from without user action. 'context-overflow' means
// the conversation outgrew the provider's request-size limit; the renderer tries framework-native
// compaction first, then falls back to a fresh context plus text replay. 'session-lost' means the
// provider session disappeared; the renderer creates a fresh provider session and replays the text.
// Absent on ordinary events.
export type AcpRecoverableFailure = 'context-overflow' | 'session-lost'

const asTokenCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const ACP_CONTEXT_USAGE_CATEGORY_KEYS = new Set<AcpContextUsageCategoryKey>([
  'system',
  'tools',
  'messages',
  'mcp',
  'skills',
  'other'
])
const ACP_CONTEXT_USAGE_TOKENIZERS = new Set<NonNullable<AcpContextUsageBreakdown['tokenizer']>>([
  'anthropic',
  'o200k_base',
  'cl100k_base'
])

// Re-validates the last known context snapshot before restoring it from Session JSON.
export const sanitizeAcpContextUsage = (value: unknown): AcpContextUsage | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined

  const usage = value as Record<string, unknown>
  const used = asTokenCount(usage.used)
  if (used === undefined) return undefined

  const sanitized: AcpContextUsage = { used }
  const agentUsed = asTokenCount(usage.agentUsed)
  const size = asTokenCount(usage.size)
  if (agentUsed !== undefined) sanitized.agentUsed = agentUsed
  if (size !== undefined && size > 0) sanitized.size = size

  if (typeof usage.breakdown !== 'object' || usage.breakdown === null) return sanitized
  const breakdown = usage.breakdown as Record<string, unknown>
  const estimatedTokens = asTokenCount(breakdown.estimatedTokens)
  const difference = breakdown.difference
  const source = breakdown.source
  const status = breakdown.status
  if (
    (source !== 'estimated' && source !== 'native') ||
    estimatedTokens === undefined ||
    typeof difference !== 'number' ||
    !Number.isSafeInteger(difference) ||
    (status !== 'preflight' && status !== 'reconciled') ||
    !Array.isArray(breakdown.categories)
  ) {
    return sanitized
  }

  const categories: AcpContextUsageCategory[] = []
  const categoryKeys = new Set<AcpContextUsageCategoryKey>()
  for (const value of breakdown.categories) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return sanitized
    const category = value as Record<string, unknown>
    const key = category.key as AcpContextUsageCategoryKey
    const tokens = asTokenCount(category.tokens)
    if (
      !ACP_CONTEXT_USAGE_CATEGORY_KEYS.has(key) ||
      categoryKeys.has(key) ||
      tokens === undefined ||
      typeof category.estimated !== 'boolean'
    ) {
      return sanitized
    }
    categoryKeys.add(key)
    categories.push({ key, tokens, estimated: category.estimated })
  }

  const tokenizer = breakdown.tokenizer as AcpContextUsageBreakdown['tokenizer']
  const model = typeof breakdown.model === 'string' && breakdown.model ? breakdown.model : undefined
  sanitized.breakdown = {
    source,
    ...(tokenizer && ACP_CONTEXT_USAGE_TOKENIZERS.has(tokenizer) ? { tokenizer } : {}),
    ...(model ? { model } : {}),
    estimatedTokens,
    difference,
    status,
    categories
  }
  return sanitized
}

// Private PromptResponse metadata used by the managed Codex adapter to keep whole-turn totals
// separate from ACP's latest-request usage snapshot.
export const ACP_TURN_TOKEN_USAGE_META_KEY = 'open-science/turn-usage'
export const ACP_MODEL_TURN_COUNT_META_KEY = 'open-science/model-turn-count'
export const ACP_MODEL_CALL_USAGE_META_KEY = 'open-science/model-call-usage'

// Normalizes ACP's experimental PromptResponse usage into the stable, provider-neutral projection the
// renderer persists. Missing cache categories mean zero; malformed totals suppress the entire footer.
export const toAcpTurnTokenUsage = (value: unknown): AcpTurnTokenUsage | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined

  const usage = value as Partial<Usage>

  const inputTokens = asTokenCount(usage.inputTokens)
  const outputTokens = asTokenCount(usage.outputTokens)
  const cachedReadTokens = asTokenCount(usage.cachedReadTokens ?? 0)
  const cachedWriteTokens = asTokenCount(usage.cachedWriteTokens ?? 0)

  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cachedReadTokens === undefined ||
    cachedWriteTokens === undefined
  ) {
    return undefined
  }

  const cacheTokens = cachedReadTokens + cachedWriteTokens
  if (!Number.isSafeInteger(cacheTokens)) return undefined

  const hasCacheBreakdown = usage.cachedReadTokens != null && usage.cachedWriteTokens != null
  return {
    inputTokens,
    cacheTokens,
    ...(hasCacheBreakdown ? { cachedReadTokens, cachedWriteTokens } : {}),
    outputTokens
  }
}

// Re-validates the durable projection when loading session JSON, dropping unknown or unsafe values.
export const sanitizeAcpTurnTokenUsage = (value: unknown): AcpTurnTokenUsage | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined

  const usage = value as Record<string, unknown>
  const inputTokens = asTokenCount(usage.inputTokens)
  const cacheTokens = asTokenCount(usage.cacheTokens)
  const outputTokens = asTokenCount(usage.outputTokens)
  const turnCount = asTokenCount(usage.turnCount)

  if (inputTokens === undefined || cacheTokens === undefined || outputTokens === undefined) {
    return undefined
  }

  const cachedReadTokens = asTokenCount(usage.cachedReadTokens)
  const cachedWriteTokens = asTokenCount(usage.cachedWriteTokens)
  const hasCacheBreakdown =
    cachedReadTokens !== undefined &&
    cachedWriteTokens !== undefined &&
    Number.isSafeInteger(cachedReadTokens + cachedWriteTokens) &&
    cachedReadTokens + cachedWriteTokens === cacheTokens

  return {
    inputTokens,
    cacheTokens,
    ...(hasCacheBreakdown ? { cachedReadTokens, cachedWriteTokens } : {}),
    outputTokens,
    ...(turnCount !== undefined && turnCount > 0 ? { turnCount } : {})
  }
}

export const sanitizeAcpModelCallUsage = (value: unknown): AcpModelCallUsage | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined

  const call = value as Record<string, unknown>
  const id = typeof call.id === 'string' ? call.id.trim() : ''
  const index = asTokenCount(call.index)
  const usage = sanitizeAcpTurnTokenUsage(call)
  if (!id || index === undefined || !usage) return undefined

  const sourceInvocationId =
    typeof call.sourceInvocationId === 'string' ? call.sourceInvocationId.trim() : ''
  const contextUsedTokens = asTokenCount(call.contextUsedTokens)
  const contextWindowSize = asTokenCount(call.contextWindowSize)
  delete usage.turnCount
  return {
    id,
    index,
    ...usage,
    ...(sourceInvocationId ? { sourceInvocationId } : {}),
    ...(contextUsedTokens === undefined ? {} : { contextUsedTokens }),
    ...(contextWindowSize !== undefined && contextWindowSize > 0 ? { contextWindowSize } : {})
  }
}

const ACP_PROMPT_STOP_REASONS = new Set<AcpPromptStopReason>([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled'
])
const ACP_CONTEXT_WINDOW_SAMPLE_SOURCES = new Set<AcpContextWindowSampleSource>([
  'provider-response',
  'provider-update',
  'local-estimate'
])

const sanitizeAcpPromptTermination = (value: unknown): AcpPromptTermination | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const termination = value as Record<string, unknown>
  if (termination.kind === 'error') return { kind: 'error' }
  if (termination.kind !== 'stop') return undefined
  const stopReason = termination.stopReason as AcpPromptStopReason
  return ACP_PROMPT_STOP_REASONS.has(stopReason) ? { kind: 'stop', stopReason } : undefined
}

export const sanitizeAcpContextWindowSample = (
  value: unknown
): AcpContextWindowSample | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const sample = value as Record<string, unknown>
  const id = typeof sample.id === 'string' && sample.id ? sample.id : undefined
  const timestamp = asTokenCount(sample.timestamp)
  const termination = sanitizeAcpPromptTermination(sample.termination)
  const contextWindow = sanitizeAcpContextUsage(sample.contextWindow)
  const source = sample.source as AcpContextWindowSampleSource
  if (
    !id ||
    timestamp === undefined ||
    !termination ||
    !contextWindow ||
    !ACP_CONTEXT_WINDOW_SAMPLE_SOURCES.has(source)
  ) {
    return undefined
  }

  const runtimeSegmentId =
    typeof sample.runtimeSegmentId === 'string' && sample.runtimeSegmentId
      ? sample.runtimeSegmentId
      : undefined
  const modelStepUsage = sanitizeAcpTurnTokenUsage(sample.modelStepUsage)
  if (modelStepUsage) delete modelStepUsage.turnCount

  return {
    id,
    timestamp,
    termination,
    contextWindow,
    ...(modelStepUsage ? { modelStepUsage } : {}),
    source,
    ...(runtimeSegmentId ? { runtimeSegmentId } : {})
  }
}

type AcpRuntimeEventBase = {
  id: string
  timestamp: number
  level: AcpRuntimeEventLevel
  // Correlates transient permission lifecycle events without extending durable Session data.
  permissionRequestId?: string
  // Present only on a usage_update-derived event; the runtime records it per session and does not push
  // the event into the visible conversation.
  contextUsage?: AcpContextUsage
  // Present on a completed prompt's stop event when the Agent reports whole-turn token totals.
  turnUsage?: AcpTurnTokenUsage
  // Exact per-inference usage for the completed visible turn. Absent means unavailable, never zero.
  modelCallUsage?: AcpModelCallUsage[]
  // Frozen last-model-step context facts for a visible prompt stop/error. Renderer discards an
  // intermediate recoverable overflow when compaction takes ownership of retrying the same Run.
  terminalContextWindow?: AcpTerminalContextWindow
  // Identifies who owns a native compaction lifecycle so overflow recovery can keep its retry gate
  // active until the replacement prompt takes over, even if control-turn events arrive first.
  compactionReason?: 'automatic' | 'manual' | 'overflow-recovery'
  // Set on an error event the app can auto-recover from, so the renderer compacts-and-retries instead
  // of surfacing a dead-end error.
  recoverable?: AcpRecoverableFailure
  // App-owned, fail-closed Specialist handoff failures are visible to the renderer but use a
  // separate recovery path from automatic context-overflow compaction. Completion contents and
  // prompt text deliberately remain in the main-process recovery store, not this event.
  handoffFailure?: AcpHandoffFailure
  planProjection?: import('./session-plan/contract').ActivePlanProjection
  // Set on an error event whose failure originates upstream of the app — the agent relayed a
  // model/provider error (bad key, rate limit, quota, provider 5xx/overloaded, wrong model id). The
  // renderer uses this to withhold the "Report error" affordance: a provider-side problem is the user's
  // or provider's to resolve, not an app bug worth a GitHub issue. Absent (falsy) means the failure came
  // from the ACP layer itself (our runtime) and stays reportable unless it is one of our own crafted,
  // actionable reminder messages.
  providerError?: boolean
  // Main-owned terminal classification, independent of provider error wording.
  interruptionCause?: 'app-restart' | 'connection-lost' | 'terminal-commit-failed'
  // Live-only release after bounded terminal persistence retries. Never written to Session JSON.
  terminalCommitFailure?: 'missing-record' | 'storage'
  terminalCommitError?: string
  promptExecutionId?: string
  terminalScope?: {
    projectId: string
    executionId: string
    startedAt: number
    agentFrameId: string
    messageBranchId: string
    runtimeSegmentId: string
  }
  errorReportable?: boolean
  // A post-terminal Artifact failure still belongs to the original prompt.
  artifactFailure?: true
  // Main has durably committed this event's Message/Artifact projection before publication.
  publicationOwner?: 'main'
  sessionId?: string
  messageId?: string
  role?: 'assistant' | 'user'
  attribution?: MessageAttribution
  title?: string
  status?: string
  text?: string
  image?: AcpMessageImage
  toolCallId?: string
  // App-owned authorization outcome. It stays separate from provider tool status so a rejected or
  // otherwise closed permission request cannot be presented as an execution failure.
  toolDisposition?: 'declined' | 'permission-closed'
  // App-owned one-shot identity for exact Notebook activity/Run correlation. Provider payloads
  // cannot supply it; the permission and authenticated RPC owners issue and consume it.
  executionInvocationId?: string
  // Set only by the main-process permission owner, never by provider metadata.
  appOwned?: true
  providerToolName?: string
  toolKind?: ToolKind
  toolContent?: ToolCallContent[]
  toolLocations?: ToolCallLocation[]
  // Raw tool arguments/results let the activity UI show what a tool executed and returned.
  rawInput?: unknown
  rawOutput?: unknown
  // Terminal metadata carries Bash stdout/stderr and exit code when terminal output is streamed.
  terminalOutput?: string
  terminalExitCode?: number | null
  elicitation?: ElicitationProjection
  // Prompt identity scopes chat, tool/activity, stop/error, and Artifact events to the originating
  // user turn. App-owned continuations retain it after the renderer's ordinary active run has settled.
  runId?: string
  promptMessageId?: string
  // Existing application-continuation provenance, copied from AgentTurnProvenanceContext by Main.
  // Optional for provider events and older snapshots that only carry the prompt identity.
  agentFrameId?: string
  messageBranchId?: string
  // Mid-turn injected user messages persist composer uploads/parts without opening a new run.
  uploads?: PersistedUploadedAttachment[]
  parts?: MessagePart[]
  // Diagnostic and protocol-compatibility payload. It is transient runtime data, not a durable
  // Session format; producers must bound or sanitize it before publication.
  raw?: unknown
}

type AcpNonArtifactRuntimeFields = {
  artifactSessionId?: never
  artifactClaimId?: never
  artifacts?: never
}

type AcpRuntimeEventPayloadMap = {
  system: AcpNonArtifactRuntimeFields
  message: AcpNonArtifactRuntimeFields & {
    role: 'assistant' | 'user'
    text: string
  }
  thought: AcpNonArtifactRuntimeFields & {
    text: string
  }
  tool: AcpNonArtifactRuntimeFields
  plan: AcpNonArtifactRuntimeFields
  permission: AcpNonArtifactRuntimeFields & {
    permissionRequestId: string
  }
  artifact: {
    sessionId: string
    runId: string
    artifactSessionId?: string
    artifactClaimId: string
    artifacts: ArtifactFile[]
  }
  compaction: AcpNonArtifactRuntimeFields
  error: AcpNonArtifactRuntimeFields
  stop: AcpNonArtifactRuntimeFields
  raw: AcpNonArtifactRuntimeFields & {
    raw: unknown
  }
}

export type AcpRuntimeEvent = {
  [Kind in AcpRuntimeEventKind]: AcpRuntimeEventBase & {
    kind: Kind
  } & AcpRuntimeEventPayloadMap[Kind]
}[AcpRuntimeEventKind]

export type AcpRuntimeEventInput = AcpRuntimeEvent extends infer Event
  ? Event extends AcpRuntimeEvent
    ? Omit<Event, 'id' | 'timestamp' | 'level'> & Partial<Pick<Event, 'id' | 'timestamp' | 'level'>>
    : never
  : never

// Durable app-owned identity for one live Agent Runtime Segment. Provider Session and prompt ids are
// deliberately excluded from the nested event below so consumers have exactly one routing owner.
export type AcpAgentRuntimeScope = Readonly<{
  projectId: string
  sessionId: string
  agentFrameId: string
  attemptId: string
  runtimeSegmentId: string
  promptMessageId: string
}>

export type AcpAgentRuntimeEvent = AcpRuntimeEvent extends infer Event
  ? Event extends AcpRuntimeEvent
    ? Readonly<
        Omit<Event, 'sessionId' | 'promptMessageId'> & {
          sessionId?: never
          promptMessageId?: never
        }
      >
    : never
  : never

export type AcpAgentRuntimeUpdate = Readonly<{
  scope: AcpAgentRuntimeScope
  event: AcpAgentRuntimeEvent
}>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Reads an image from either the normalized field or the bounded raw fallback retained by the
// existing runtime event projection. Both paths pass through the same validator.
export const getAcpRuntimeEventImage = (event: AcpRuntimeEvent): AcpMessageImage | undefined => {
  const directImage = sanitizeAcpMessageImage(event.image)

  if (directImage) return directImage
  if (!isRecord(event.raw) || !isRecord(event.raw.update)) return undefined

  return sanitizeAcpMessageImage(event.raw.update.content)
}

// Hides the internal image sentinel while preserving every ordinary text event verbatim.
export const getAcpRuntimeEventText = (event: AcpRuntimeEvent): string | undefined =>
  getAcpRuntimeEventImage(event) && event.text === ACP_MESSAGE_IMAGE_EVENT_TEXT
    ? undefined
    : event.text

const CLAUDE_CODE_USAGE_POLICY_REFUSAL_PREFIX =
  'API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup).'
const PROVIDER_NEUTRAL_REFUSAL_PREFIX =
  'The selected model declined to complete this response under its safety policy.'

export const normalizeClaudeCodeRefusalText = (text: string): string =>
  text.startsWith(CLAUDE_CODE_USAGE_POLICY_REFUSAL_PREFIX)
    ? `${PROVIDER_NEUTRAL_REFUSAL_PREFIX}${text.slice(CLAUDE_CODE_USAGE_POLICY_REFUSAL_PREFIX.length)}`
    : text

// Why Subagents are unavailable for a Session that has none yet: the user's own Delegation policy,
// recoverable from the composer agent controls menu, or a configuration problem whose recovery
// lives in Settings. The kind routes the notice; the reason is user-facing copy.
export type DelegatedWorkUnavailableReason =
  | Readonly<{ kind: 'delegation-disabled'; reason: string }>
  | Readonly<{ kind: 'unavailable'; reason: string }>

export type AcpRuntimeState = {
  // Main-owned construction order lets the renderer reject delayed older IPC snapshots. It is
  // transient runtime state and is not persisted with Session data.
  revision?: number
  status: AcpConnectionStatus
  // A coordinator may keep multiple framework generations alive. Callers handling one session should
  // prefer its owning runtime status over the active generation's top-level compatibility status.
  sessionConnectionStatuses?: Partial<Record<string, AcpConnectionStatus>>
  cwd: string
  sessionId?: string
  sessionIds: string[]
  // Visible sessions still owned by a retiring runtime generation. The renderer must resume these
  // before dispatch even though their final turn remains visible while it drains.
  sessionResumeRequiredIds?: string[]
  error?: string
  pendingPermissions: AcpPermissionRequest[]
  // Optional for rolling renderer/main reload compatibility; current runtimes always publish it.
  pendingElicitations?: PendingElicitationRequest[]
  permissionProfiles: Record<string, SessionPermissionProfileState>
  // Open-Science-owned grants by app conversation, so the UI can show and revoke them.
  permissionGrants: Record<string, AcpPermissionGrant[]>
  // Latest context-window usage for each logical app session's current agent-context generation.
  // Missing means unknown or invalidated; framework switches and reconnects clear the old generation.
  contextUsageBySession: Record<string, AcpContextUsage>
  // Monotonic process-local signal that durable delegated-work records changed. The renderer uses
  // it only to refresh the authoritative Session projection; the records remain persistence-owned.
  delegatedWorkRevision?: number
  // Why Subagents are unavailable for a Session with none yet; see DelegatedWorkUnavailableReason.
  delegatedWorkUnavailableBySession?: Record<string, DelegatedWorkUnavailableReason>
  // Sessions whose attached framework exposes a native compaction control turn. Missing is accepted
  // from an older main process during a rolling dev reload.
  nativeContextCompactionSessionIds?: string[]
  promptInFlight: boolean
  // Prompt-only ownership for first-output UI. `promptInFlightSessionIds` remains the broader
  // interaction lock and also contains framework compaction control turns.
  agentPromptInFlightSessionIds?: string[]
  promptInFlightSessionIds: string[]
}

// Retained event history is an explicit synchronization payload. Routine state publications and
// command responses use AcpRuntimeState so large tool payloads stay on the incremental event path.
export type AcpStateSnapshot = AcpRuntimeState & {
  events: AcpRuntimeEvent[]
}

// A new renderer accepts the historical full-snapshot state event during rolling development, while
// current Main processes publish state without the retained event window.
export type AcpStateUpdate = AcpRuntimeState & {
  events?: AcpRuntimeEvent[]
}

export type AcpStateCommandResponse = {
  revision: number
  result: Omit<AcpRuntimeState, 'revision'>
}

export const toAcpStateCommandResponse = (state: AcpStateUpdate): AcpStateCommandResponse => {
  if (state.revision === undefined) {
    throw new Error('ACP command state is missing its Main-owned revision.')
  }
  const result = { ...state }
  delete result.events
  delete result.revision
  return { revision: state.revision, result }
}

export type AcpConnectRequest = {
  cwd?: string
}

export type AcpSessionAgentTarget = SessionAgentConfiguration & {
  frameworkId: AgentFrameworkId
}

export type AcpCreateSessionRequest = {
  cwd?: string
  // Scopes generated artifacts / notebooks to a project's storage subtree. Defaults per runtime.
  projectId?: string
  permissionProfile?: PermissionProfileId
  // Per-conversation Memory preference. Missing preserves the historical enabled behavior.
  memoryEnabled?: boolean
  // Immutable Specialist ID to bind on first turn. Main process resolves the latest Profile at
  // session-creation time — the renderer MUST NOT send systemPrompt or capability data, only the
  // stable ID. Absent or undefined means no specialist; use Main Agent.
  specialistId?: string
  // The first prompt will link a PDF before dispatch. Provision Literature with session/new so a
  // provider that has not produced its first resumable rollout does not need an immediate resume.
  literatureContext?: true
  // Opaque, short-lived capability minted by the local WSL setup entry point. Main validates it
  // before exposing setup tools and never forwards it to the model or persists it with the Session.
  setupSessionToken?: string
  agentTarget?: AcpSessionAgentTarget
}

export type AcpCreateSessionResponse = {
  // Stable application identity used by renderer state and IPC routing.
  sessionId: string
  // Actual ACP/provider identity. It can differ after fresh adoption under a stable app id and must
  // survive app restart so the next session/resume targets the provider's real session.
  providerSessionId?: string
  providerContinuityToken?: string
  cwd?: string
  frameworkId?: AgentFrameworkId
  backendId?: string
  // Main-owned marker derived from the durable setup capability. Renderer uses it for setup UI;
  // it grants no authority by itself.
  wslSetup?: true
  // True when a resume could not reattach the agent's own session and a fresh one was adopted under the
  // same app id (framework switch, or a restart the agent could not resume). Agent-side context is gone,
  // so the caller may replay a transcript preamble into the next prompt to restore continuity.
  contextReset?: boolean
}

export type AcpResumeSessionRequest = {
  sessionId: string
  providerSessionId?: string
  providerContinuityToken?: string
  cwd: string
  projectId?: string
  permissionProfile?: PermissionProfileId
  memoryEnabled?: boolean
  previousFrameworkId?: AgentFrameworkId
  previousBackendId?: string
  // Durable session binding, supplied on restore so session/resume reissues the Specialist whitelist.
  specialistId?: string
  // True when disk holds a desired Specialist that the prior runtime never confirmed. A restored
  // resume must adopt fresh provider context with that target before Main clears the durable marker.
  specialistBindingPending?: true
  agentTarget?: AcpSessionAgentTarget
}

export type AcpContinueInterruptedTurnRequest = {
  sessionId: string
  projectId: string
  promptMessageId: string
  // Present only when session/resume adopted a fresh provider context. Main validates the Runtime
  // Segment against the persisted active Conversation Branch before using the replay policy.
  contextReset?: {
    runtimeSegmentId: string
    historyReplayTarget: import('./history-replay-contract').HistoryReplayTarget
    contextWindow?: number
    supportsImageInput?: boolean
  }
}

export type AcpCompactSessionRequest = {
  sessionId: string
  reason?: 'manual' | 'overflow-recovery'
}

export type AcpSaveAsSkillRequest = {
  projectId: string
  sessionId: string
  agentFrameId: string
  messageBranchId: string
  // Renderer capability hint only. Main still captures and validates the configured Vision target
  // before any retained history image can reach the active text-only model.
  supportsImageRelay?: boolean
  // Durable hidden control Message created on the active Branch before dispatch.
  promptMessageId: string
}

export type AcpSetPermissionProfileRequest = {
  sessionId: string
  profile: PermissionProfileId
}

export type AcpPromptRequest = {
  /** Application-owned execution policy; never grants additional authority. */
  permissionPrompts?: 'none'
  sessionId: string
  text: string
  // Renderer-owned Session preference. Main still applies the higher-priority global Memory gate.
  memoryEnabled?: boolean
  // Closed, application-owned behavior requested for this Conversation Turn only.
  turnIntent?: 'plan-first'
  // An application-owned continuation retains the originating user request but must not create a
  // second visible user-message event. It is never accepted from renderer IPC.
  continuation?: {
    kind: 'specialist-handoff'
    originatingTurnToken: string
    targetName: string | null
    completion: { kind: 'returned'; value: unknown } | { kind: 'threw'; errorMessage: string }
  }
  // Application-owned continuations may send provider context without projecting a second user
  // message. The original user turn remains the visible/provenance owner.
  suppressUserMessage?: boolean
  // Immutable conversation-graph binding for Artifact Provenance. Older callers may omit it; the
  // runtime supplies a root-frame/root-branch compatibility binding during the Session JSON v2
  // rollout.
  provenanceContext?: AgentTurnProvenanceContext
  attachments?: UploadedAttachment[]
  // Skills the user explicitly picked in the composer; the runtime force-loads and nudges them.
  forcedSkillIds?: string[]
  // Existing files referenced via composer `@` mentions; appended as prompt content blocks.
  referencedArtifacts?: FileReference[]
  // Sessions explicitly picked via composer `#` mentions. Titles are display snapshots; Main and
  // Host capabilities resolve ownership and content from the globally unique Session id.
  referencedSessions?: SessionReference[]
  // Ordered immutable composer segments. Main uses application-owned Literature snapshots from
  // this list to prepare provider-neutral citation context and persists the same parts on history.
  parts?: MessagePart[]
  // Transcript of prior turns injected only into the content sent to the agent (never the user-facing
  // message), so a freshly-adopted session after a framework switch keeps conversational continuity.
  historyPreamble?: string
  historyAttachments?: UploadedAttachment[]
  historyImages?: AcpReplayMessageImage[]
  // Current-turn visual Evidence. This is transient prompt input, never replay history or durable
  // Session state, so text-only compatibility must fail closed instead of silently omitting it.
  currentImages?: AcpMessageImage[]
  // Transient prompt-boundary signal: the provider context was replaced, so live application state
  // must be handed off even when there are no replayable transcript turns. Never persisted.
  contextReset?: boolean
  // Prepared by the renderer for an internal skill-triggered reconnect. Used only if that reconnect
  // cannot resume the agent session and must adopt a fresh one.
  resumeFallback?: {
    historyPreamble?: string
    historyAttachments?: UploadedAttachment[]
    historyImages?: AcpReplayMessageImage[]
  }
}

export type AcpSteerFollowUpRequest = {
  agentTarget?: AcpSessionAgentTarget
  sessionId: string
  text: string
  attachments?: UploadedAttachment[]
  referencedArtifacts?: FileReference[]
  forcedSkillIds?: string[]
  parts?: MessagePart[]
}

export type AcpSteerFollowUpTransport = 'acp-steering' | 'codebuddy-acp-steer' | 'opencode-http'

export type AcpSteerFollowUpRefuseReason =
  | 'empty-text'
  | 'attachments'
  | 'no-live-turn'
  | 'not-advertised'
  | 'started-new-turn'
  | 'prompt-required'
  | 'unrecognized-success'
  | 'missing-outcome'
  | 'unknown-outcome'
  | 'dispatch-failed'

export type AcpSteerFollowUpResult =
  | {
      injected: true
      transport: AcpSteerFollowUpTransport
      messageId: string
    }
  | {
      injected: false
      reason: AcpSteerFollowUpRefuseReason
    }

export type AcpCancelPromptRequest = {
  sessionId: string
  scope?: 'turn' | 'subagents'
}

export type AcpDeleteSessionRequest = {
  sessionId: string
}

export type AcpPermissionResponse = {
  requestId: string
  optionId?: string
  cancelled?: boolean
  // Present only when the renderer is answering main-owned permission authority restored from the
  // Session record. Main reloads and validates that authority; this locator and replay projection do
  // not themselves grant permission.
  restored?: {
    sessionId: string
    projectId: string
  }
}

export type AcpPermissionSettlementState = 'resolved' | 'rejected' | 'cancelled'

export type AcpRevokePermissionGrantRequest = {
  sessionId: string
  categoryKey: string
}
