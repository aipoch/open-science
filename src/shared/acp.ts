import type { ToolCallContent, ToolCallLocation, ToolKind } from '@agentclientprotocol/sdk'
import type { ArtifactFile } from './artifacts'
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

export type AcpRuntimeEvent = {
  id: string
  timestamp: number
  kind: AcpRuntimeEventKind
  level: AcpRuntimeEventLevel
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
