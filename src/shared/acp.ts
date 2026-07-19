import type { ToolCallContent, ToolCallLocation, ToolKind } from '@agentclientprotocol/sdk'
import type { ArtifactFile, ArtifactReference } from './artifacts'
import type { UploadedAttachment } from './uploads'
import type { PermissionProfileId, SessionPermissionProfileState } from './permission-profiles'

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
