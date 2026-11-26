import type { ToolCallLocation, ToolKind } from '@agentclientprotocol/sdk'
import type { NotebookLanguage } from './notebook-language-contract'

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
  // The renderer projection retains the review kind even when its evidence cannot be shown.
  notebookCodeReview?: true
  notebookRuntimeReview?: true
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

type NotebookReviewTarget = {
  language?: unknown
  projectId?: unknown
  promptMessageId?: unknown
  messageBranchId?: unknown
  runtimeId?: unknown
}

export function isAppOwnedNotebookCodeReview(value: unknown): value is {
  appOwned: true
  rawInput: {
    code?: unknown
    notebookCodeRisk: NotebookReviewTarget & {
      runId?: unknown
      environment?: unknown
      risks?: unknown
    }
  }
} {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('appOwned' in value) ||
    value.appOwned !== true
  )
    return false
  const rawInput = 'rawInput' in value ? value.rawInput : undefined
  if (rawInput === null || typeof rawInput !== 'object' || !('notebookCodeRisk' in rawInput))
    return false
  return rawInput.notebookCodeRisk !== null && typeof rawInput.notebookCodeRisk === 'object'
}

export function isAppOwnedNotebookRuntimeReview(value: unknown): value is {
  appOwned: true
  rawInput: {
    notebookRuntimeSelection: NotebookReviewTarget & {
      label?: unknown
      interpreterPath?: unknown
      previousRuntimeId?: unknown
      previousLabel?: unknown
    }
  }
} {
  if (!value || typeof value !== 'object' || !('appOwned' in value) || value.appOwned !== true)
    return false
  const rawInput = 'rawInput' in value ? value.rawInput : undefined
  if (!rawInput || typeof rawInput !== 'object' || !('notebookRuntimeSelection' in rawInput))
    return false
  return Boolean(
    rawInput.notebookRuntimeSelection && typeof rawInput.notebookRuntimeSelection === 'object'
  )
}

export type PendingNotebookReview =
  | { kind: 'code'; runId: string }
  | {
      kind: 'runtime'
      projectId: string
      promptMessageId: string
      messageBranchId: string
      language?: NotebookLanguage
    }

// An Open-Science-owned tool grant. `categoryKey` is the broker's opaque matcher key;
// `label`/`kind` are the display projection and `scope` reserves future project/global ownership.
export type AcpPermissionGrant = {
  categoryKey: string
  label: string
  kind: 'shell' | 'mcp' | 'tool'
  scope: AcpPermissionGrantScope
}
