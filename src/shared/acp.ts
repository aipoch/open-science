import type { ToolCallContent, ToolCallLocation, ToolKind } from '@agentclientprotocol/sdk'
import type { ArtifactFile, ArtifactReference } from './artifacts'
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
  | 'error'
  | 'stop'
  | 'raw'

export type AcpRuntimeEventLevel = 'info' | 'warning' | 'error'

// Marks a prompt failure the app can auto-recover from without user action. 'context-overflow' means
// the conversation outgrew the provider's request-size limit (accumulated media); the renderer resets
// the agent context and replays a text-only transcript. Absent on ordinary events.
export type AcpRecoverableFailure = 'context-overflow'

export type AcpRuntimeEvent = {
  id: string
  timestamp: number
  kind: AcpRuntimeEventKind
  level: AcpRuntimeEventLevel
  // Set on an error event the app can auto-recover from, so the renderer compacts-and-retries instead
  // of surfacing a dead-end error.
  recoverable?: AcpRecoverableFailure
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
  // Artifact events use these ids to bridge runtime-owned runs to renderer-owned messages.
  runId?: string
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

export type AcpPermissionOption = {
  optionId: string
  name: string
  kind: string
}

export type AcpPermissionRequest = {
  requestId: string
  sessionId: string
  toolCallId: string
  title: string
  status?: string
  providerToolName?: string
  toolKind?: ToolKind
  toolLocations?: ToolCallLocation[]
  rawInput?: unknown
  options: AcpPermissionOption[]
  raw: unknown
}

// A tool category the user chose to always-allow for the rest of a session. `categoryKey` is the
// broker's opaque grouping key; `label`/`kind` are the display projection shown in the composer.
export type AcpPermissionGrant = {
  categoryKey: string
  label: string
  kind: 'shell' | 'mcp' | 'tool'
}

export type AcpStateSnapshot = {
  status: AcpConnectionStatus
  cwd: string
  sessionId?: string
  sessionIds: string[]
  error?: string
  events: AcpRuntimeEvent[]
  pendingPermissions: AcpPermissionRequest[]
  permissionProfiles: Record<string, SessionPermissionProfileState>
  // Per-session always-allow grants (from per-request "Always"), so the UI can show and revoke them.
  permissionGrants: Record<string, AcpPermissionGrant[]>
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
}

export type AcpSetPermissionProfileRequest = {
  sessionId: string
  profile: PermissionProfileId
}

export type AcpPromptRequest = {
  sessionId: string
  text: string
  attachments?: UploadedAttachment[]
  // Skills the user explicitly picked in the composer; the runtime force-loads and nudges them.
  forcedSkillIds?: string[]
  // Existing files referenced via composer `@` mentions; appended as prompt content blocks.
  referencedArtifacts?: ArtifactReference[]
  // Transcript of prior turns injected only into the content sent to the agent (never the user-facing
  // message), so a freshly-adopted session after a framework switch keeps conversational continuity.
  historyPreamble?: string
  historyAttachments?: UploadedAttachment[]
  historyImages?: AcpMessageImage[]
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
