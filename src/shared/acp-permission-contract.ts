import type { ToolCallLocation, ToolKind } from '@agentclientprotocol/sdk'

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

// An Open-Science-owned tool grant. `categoryKey` is the broker's opaque matcher key;
// `label`/`kind` are the display projection and `scope` reserves future project/global ownership.
export type AcpPermissionGrant = {
  categoryKey: string
  label: string
  kind: 'shell' | 'mcp' | 'tool'
  scope: AcpPermissionGrantScope
}
