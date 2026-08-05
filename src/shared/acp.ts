import type { ToolCallContent, ToolCallLocation, ToolKind, Usage } from '@agentclientprotocol/sdk'
import type { ArtifactFile, FileReference } from './artifacts'
import type { UploadedAttachment } from './uploads'
import type { PermissionProfileId, SessionPermissionProfileState } from './permission-profiles'
import type { AgentFrameworkId } from './settings'

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

// Message images are embedded in runtime IPC and session JSON, so keep each block small enough to
// render without turning an agent event into an unbounded binary transport. SVG is deliberately not
// accepted because active image content does not belong in the transcript renderer.
export const MAX_ACP_MESSAGE_IMAGE_BYTES = 4 * 1024 * 1024
export const MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE = 4
export const MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE = 8 * 1024 * 1024
export const MAX_ACP_SESSION_IMAGE_BYTES = 24 * 1024 * 1024
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

// Private PromptResponse metadata used by the managed Codex adapter to keep whole-turn totals
// separate from ACP's latest-request usage snapshot.
export const ACP_TURN_TOKEN_USAGE_META_KEY = 'open-science/turn-usage'
export const ACP_MODEL_TURN_COUNT_META_KEY = 'open-science/model-turn-count'

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

export type AcpRuntimeEvent = {
  id: string
  timestamp: number
  kind: AcpRuntimeEventKind
  level: AcpRuntimeEventLevel
  // Present only on a usage_update-derived event; the runtime records it per session and does not push
  // the event into the visible conversation.
  contextUsage?: AcpContextUsage
  // Present on a completed prompt's stop event when the Agent reports whole-turn token totals.
  turnUsage?: AcpTurnTokenUsage
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
  text?: string
  image?: AcpMessageImage
  title?: string
  status?: string
  toolCallId?: string
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
  // Prompt identity scopes chat, tool/activity, stop/error, and Artifact events to the originating
  // user turn. App-owned continuations retain it after the renderer's ordinary active run has settled.
  runId?: string
  promptMessageId?: string
  artifactSessionId?: string
  artifactClaimId?: string
  artifacts?: ArtifactFile[]
  raw?: unknown
}

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
}

// An Open Science-owned tool grant. `categoryKey` is the broker's opaque matcher key;
// `label`/`kind` are the display projection and `scope` reserves future project/global ownership.
export type AcpPermissionGrant = {
  categoryKey: string
  label: string
  kind: 'shell' | 'mcp' | 'tool'
  scope: AcpPermissionGrantScope
}

export type AcpStateSnapshot = {
  status: AcpConnectionStatus
  // A coordinator may keep multiple framework generations alive. Callers handling one session should
  // prefer its owning runtime status over the active generation's top-level compatibility status.
  sessionConnectionStatuses?: Partial<Record<string, AcpConnectionStatus>>
  cwd: string
  sessionId?: string
  sessionIds: string[]
  error?: string
  events: AcpRuntimeEvent[]
  pendingPermissions: AcpPermissionRequest[]
  permissionProfiles: Record<string, SessionPermissionProfileState>
  // Open Science-owned grants by app conversation, so the UI can show and revoke them.
  permissionGrants: Record<string, AcpPermissionGrant[]>
  // Latest context-window usage for each logical app session's current agent-context generation.
  // Missing means unknown or invalidated; framework switches and reconnects clear the old generation.
  contextUsageBySession: Record<string, AcpContextUsage>
  // Sessions whose attached framework exposes a native compaction control turn. Missing is accepted
  // from an older main process during a rolling dev reload.
  nativeContextCompactionSessionIds?: string[]
  promptInFlight: boolean
  promptInFlightSessionIds: string[]
}

export type AcpConnectRequest = {
  cwd?: string
}

export type AcpCreateSessionRequest = {
  cwd?: string
  // Scopes generated artifacts / notebooks to a project's storage subtree. Defaults per runtime.
  projectName?: string
  permissionProfile?: PermissionProfileId
  // Immutable Specialist UUID to bind on first turn. Main process resolves the latest Profile at
  // session-creation time — the renderer MUST NOT send systemPrompt or capability data, only the
  // stable UUID. Absent or undefined means no specialist; use Main Agent.
  specialistId?: string
}

export type AcpCreateSessionResponse = {
  sessionId: string
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
  cwd: string
  projectName?: string
  permissionProfile?: PermissionProfileId
  previousFrameworkId?: AgentFrameworkId
  previousBackendId?: string
  // Durable session binding, supplied on restore so session/resume reissues the Specialist whitelist.
  specialistId?: string
}

export type AcpCompactSessionRequest = {
  sessionId: string
  reason?: 'manual' | 'overflow-recovery'
}

export type AcpSetPermissionProfileRequest = {
  sessionId: string
  profile: PermissionProfileId
}

export type AcpPromptRequest = {
  sessionId: string
  text: string
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
  provenanceContext?: {
    promptMessageId: string
    rootFrameId?: string
    agentFrameId?: string
    messageBranchId?: string
    messageBranchAncestry?: string[]
    messageAncestry?: string[]
    runtimeSegmentId?: string
  }
  attachments?: UploadedAttachment[]
  // Skills the user explicitly picked in the composer; the runtime force-loads and nudges them.
  forcedSkillIds?: string[]
  // Existing files referenced via composer `@` mentions; appended as prompt content blocks.
  referencedArtifacts?: FileReference[]
  // Transcript of prior turns injected only into the content sent to the agent (never the user-facing
  // message), so a freshly-adopted session after a framework switch keeps conversational continuity.
  historyPreamble?: string
  historyAttachments?: UploadedAttachment[]
  historyImages?: AcpMessageImage[]
  // Transient prompt-boundary signal: the provider context was replaced, so live application state
  // must be handed off even when there are no replayable transcript turns. Never persisted.
  contextReset?: boolean
  // Prepared by the renderer for an internal skill-triggered reconnect. Used only if that reconnect
  // cannot resume the agent session and must adopt a fresh one.
  resumeFallback?: {
    historyPreamble?: string
    historyAttachments?: UploadedAttachment[]
    historyImages?: AcpMessageImage[]
  }
}

export type AcpCancelPromptRequest = {
  sessionId: string
}

export type AcpDeleteSessionRequest = {
  sessionId: string
}

export type AcpPermissionResponse = {
  requestId: string
  optionId?: string
  cancelled?: boolean
}

export type AcpRevokePermissionGrantRequest = {
  sessionId: string
  categoryKey: string
}
