import type {
  PromptResponse,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
  Usage
} from '@agentclientprotocol/sdk'
import type { ArtifactFile, FileReference } from './artifacts'
import type { PersistedUploadedAttachment, UploadedAttachment } from './uploads'
import type { PermissionProfileId, SessionPermissionProfileState } from './permission-profiles'
import type { AgentFrameworkId, SessionAgentConfiguration } from './settings'
import type {
  DelegatedQuestionAnswer,
  MessageAttribution,
  MessagePart,
  SessionReference
} from './session-persistence'
import type {
  AgentTurnProvenanceContext,
  ElicitationProjection,
  ElicitationResponse as BaseElicitationResponse,
  PendingElicitationRequest
} from './elicitation'

export {
  isDurableAgentUserChoiceRequest,
  isValidElicitationValue,
  MAX_ELICITATION_MESSAGE_CHARS,
  resolveAgentUserChoiceQuestions
} from './elicitation'
export type {
  AgentUserChoiceQuestion,
  AgentTurnProvenanceContext,
  ElicitationAnswer,
  ElicitationField,
  ElicitationProjection,
  ElicitationValue,
  PendingElicitationRequest
} from './elicitation'

const ACP_MESSAGE_IMAGE_MIME_TYPES = [
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp'
] as const

export type AcpMessageImageMimeType = (typeof ACP_MESSAGE_IMAGE_MIME_TYPES)[number]

export type AcpMessageImage = {
  mimeType: AcpMessageImageMimeType
  data: string
  byteLength: number
}

// Replay-only identity. These optional locators are derived from persisted Session messages and
// never become part of provider image content or the durable Session JSON shape.
export type AcpReplayMessageImage = AcpMessageImage & {
  sourceMessageId?: string
  sourceImageId?: string
}

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

// Message images are embedded in runtime IPC and session JSON, so keep each block small enough to
// render without turning an agent event into an unbounded binary transport. SVG is deliberately not
// accepted because active image content does not belong in the transcript renderer.
export const MAX_ACP_MESSAGE_IMAGE_BYTES = 4 * 1024 * 1024
export const MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE = 4
export const MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE = 8 * 1024 * 1024
export const MAX_ACP_SESSION_IMAGE_BYTES = 24 * 1024 * 1024
export const MAX_ACP_RUNTIME_EVENTS = 500
// Existing runtime projection keeps only text-bearing message events. This sentinel carries a valid
// image through that projection and is removed before transcript storage or rendering.
export const ACP_MESSAGE_IMAGE_EVENT_TEXT = '[open-science:acp-message-image]'

const ACP_MESSAGE_IMAGE_MIME_TYPE_SET = new Set<string>(ACP_MESSAGE_IMAGE_MIME_TYPES)
const BASE64_BODY_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

// Computes decoded bytes without allocating a second binary copy. Both padded and unpadded base64
// are accepted, while whitespace and malformed padding are rejected.
const getBase64ByteLength = (data: string): number | undefined => {
  if (!data || !BASE64_BODY_PATTERN.test(data)) return undefined

  const firstPaddingIndex = data.indexOf('=')
  const paddingLength = firstPaddingIndex === -1 ? 0 : data.length - firstPaddingIndex

  if (paddingLength > 0 && data.length % 4 !== 0) return undefined
  if (paddingLength === 0 && data.length % 4 === 1) return undefined

  return Math.floor((data.length * 3) / 4) - paddingLength
}

// Validates an untrusted ACP image at both runtime and persistence boundaries.
export const sanitizeAcpMessageImage = (value: unknown): AcpMessageImage | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined

  const image = value as Record<string, unknown>
  const mimeType = typeof image.mimeType === 'string' ? image.mimeType.toLowerCase() : undefined
  const data = typeof image.data === 'string' ? image.data : undefined

  if (!mimeType || !ACP_MESSAGE_IMAGE_MIME_TYPE_SET.has(mimeType) || !data) return undefined

  const byteLength = getBase64ByteLength(data)

  if (byteLength === undefined || byteLength > MAX_ACP_MESSAGE_IMAGE_BYTES) return undefined

  return {
    mimeType: mimeType as AcpMessageImageMimeType,
    data,
    byteLength
  }
}

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
// compaction first, then falls back to a fresh context plus text replay. Absent on ordinary events.
export type AcpRecoverableFailure = 'context-overflow'

export type AcpContextUsageCategoryKey =
  'system' | 'tools' | 'messages' | 'mcp' | 'skills' | 'other'

export type AcpContextUsageCategory = {
  key: AcpContextUsageCategoryKey
  tokens: number
  // `estimated` distinguishes locally tokenized content from the residual needed to reconcile the
  // category sum with the authoritative Agent total.
  estimated: boolean
}

export type AcpContextUsageBreakdown = {
  source: 'estimated' | 'native'
  // Stable tokenizer/profile id for diagnostics. Native framework reports have no local tokenizer.
  tokenizer?: 'anthropic' | 'o200k_base' | 'cl100k_base'
  model?: string
  // Sum of locally attributable categories before the Agent total is applied.
  estimatedTokens: number
  // Zero while preflight has no Agent comparison. Once reconciled, signed Agent total minus local
  // estimate: positive values become `other`; negative drift stays visible rather than being scaled.
  difference: number
  status: 'preflight' | 'reconciled'
  categories: AcpContextUsageCategory[]
}

// Current agent-context usage projected onto its logical app session. `used` remains the latest Agent
// model-input total once one exists; before the first Agent report it is the local preflight estimate.
// During later preflight updates, `agentUsed` preserves that latest authoritative reading while the
// independent breakdown keeps changing. Output/completion and cache-write tokens are excluded. `size`
// is omitted until the selected model window is known, then remains bound to that same agent-context
// generation. Both expire when that context disconnects or is replaced. Monetary cost is deliberately
// excluded.
export type AcpContextUsage = {
  used: number
  agentUsed?: number
  size?: number
  breakdown?: AcpContextUsageBreakdown
}

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

// Provider-reported totals for one completed prompt turn. `cacheTokens` stays as the comparable
// provider-neutral total. Read/write details are present as a pair only when the adapter reports both
// categories separately.
export type AcpTurnTokenUsage = {
  inputTokens: number
  cacheTokens: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
  outputTokens: number
  // Number of model inference turns performed during this completed agent run. Optional because
  // ACP adapters do not all expose a reliable request count.
  turnCount?: number
}

export type AcpModelStepTokenUsage = Omit<AcpTurnTokenUsage, 'turnCount'>

export type AcpModelCallUsage = AcpModelStepTokenUsage & {
  id: string
  index: number
  sourceInvocationId?: string
  contextUsedTokens?: number
  contextWindowSize?: number
}

export type AcpPromptStopReason = PromptResponse['stopReason']

export type AcpPromptTermination =
  { kind: 'stop'; stopReason: AcpPromptStopReason } | { kind: 'error' }

export type AcpContextWindowSampleSource =
  'provider-response' | 'provider-update' | 'local-estimate'

// Frozen context facts for one visible prompt execution. Main publishes this with the terminal
// runtime event before context cleanup can restore a checkpoint; Renderer later supplies durable
// event/runtime identity when binding it to the owning user Message.
export type AcpTerminalContextWindow = {
  termination: AcpPromptTermination
  contextWindow: AcpContextUsage
  modelStepUsage?: AcpModelStepTokenUsage
  source: AcpContextWindowSampleSource
}

// Branch-bound terminal sample persisted on the user Message. This is a last-model-step context
// snapshot, never a sum across model steps; whole-turn totals remain in `AcpTurnTokenUsage`.
export type AcpContextWindowSample = AcpTerminalContextWindow & {
  id: string
  timestamp: number
  runtimeSegmentId?: string
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

export type AcpPermissionScope = 'once' | 'session' | 'project' | 'global'
export type AcpPermissionGrantScope = Exclude<AcpPermissionScope, 'once'>

export type AcpPermissionOption = {
  optionId: string
  name: string
  kind: string
  scope?: AcpPermissionScope
}

export type AcpPermissionRequest = {
  requestId: string
  sessionId: string
  toolCallId: string
  title: string
  // Main-process provenance for application-owned approvals. Provider payloads are rebuilt by the
  // permission broker and cannot set this projection. It is transient and never persisted.
  appOwned?: true
  // Renderer lifecycle hint only. Main sets this after the request authority reaches Session
  // storage; restored authority is still reloaded and validated independently before use.
  durable?: true
  status?: string
  providerToolName?: string
  // Set by the permission broker after framework-aware classification so the renderer never has to
  // infer MCP origin from provider-specific titles or tool kinds.
  isMcp?: boolean
  // Broker-resolved MCP server/tool identity (`server/tool`), projected only for display. This
  // keeps presentation stable across provider-specific titles without exposing the protocol name.
  mcpIdentity?: string
  toolKind?: ToolKind
  toolLocations?: ToolCallLocation[]
  // Structured argv prefix whose remembered scopes authorize a command group. This is transient
  // approval context only; permission grants persist an opaque digest instead of these tokens.
  commandPrefix?: string[]
  rawInput?: unknown
  options: AcpPermissionOption[]
  // App-owned delegated execution attribution. Provider payloads cannot set this projection;
  // the delegated-work owner binds it from the trusted Frame/Attempt execution handle.
  delegated?: Readonly<{
    frameId: string
    attemptId: string
    childTitle: string
    riskScope: string
  }>
}

// An Open Science-owned tool grant. `categoryKey` is the broker's opaque matcher key;
// `label`/`kind` are the display projection and `scope` reserves future project/global ownership.
export type AcpPermissionGrant = {
  categoryKey: string
  label: string
  kind: 'shell' | 'mcp' | 'tool'
  scope: AcpPermissionGrantScope
}

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
  // Open Science-owned grants by app conversation, so the UI can show and revoke them.
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
    historyReplayTarget: import('./history-preamble').HistoryReplayTarget
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
