import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { randomUUID } from 'node:crypto'

import type {
  AcpPermissionGrant,
  AcpPermissionRequest,
  AcpPermissionResponse
} from '../../shared/acp'
import { extractProviderToolName } from './runtime-events'
import {
  isMcpToolName,
  resolveAutomaticPermission,
  type PermissionPolicyContext
} from './permission-policy'

type PendingPermission = {
  request: AcpPermissionRequest
  categoryKey: string
  resolve: (response: RequestPermissionResponse) => void
}

type EmitPermissionRequest = (request: AcpPermissionRequest) => void

const ALLOW_ALWAYS_OPTION_KIND = 'allow_always'
const ALLOW_ONCE_OPTION_KIND = 'allow_once'

const commandFromRawInput = (rawInput: unknown): string | undefined => {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return undefined

  const command = (rawInput as Record<string, unknown>).command

  return typeof command === 'string' && command.trim() ? command : undefined
}

const reportedPermissionTitle = (params: RequestPermissionRequest): string =>
  params.toolCall.title ?? params.toolCall.toolCallId

// codex-acp command approvals omit title but retain the exact command in rawInput. Prefer that
// security-relevant value only for confirmed non-MCP shell requests; MCP inputs are arbitrary and
// may contain an unrelated `command` field.
const resolvePermissionTitle = (params: RequestPermissionRequest, isMcp: boolean): string => {
  const isShell =
    extractProviderToolName(params.toolCall) === 'Bash' || params.toolCall.kind === 'execute'
  const hasNoTitle = !params.toolCall.title?.trim()

  return (
    (!isMcp && isShell && hasNoTitle ? commandFromRawInput(params.toolCall.rawInput) : undefined) ??
    reportedPermissionTitle(params)
  )
}

// Trivial `KEY=VALUE` env assignment prefixing a shell command (e.g. `FOO=bar python a.py`). Values
// containing whitespace/quotes are not covered (already split away) and fall back to the raw token.
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=[^\s]*$/

// Derives the normalized full-command signature used to group shell/execute permissions. Leading
// trivial env assignments are skipped, but arguments remain part of the authorization boundary.
const commandSignature = (command: string): string => {
  const tokens = command.trim().split(/\s+/)
  let index = 0

  while (index < tokens.length - 1 && ENV_ASSIGNMENT_PATTERN.test(tokens[index])) {
    index += 1
  }

  const rest = tokens.slice(index)

  return rest.length > 0 ? rest.join(' ') : command.trim()
}

// Derives a session-scoped "Always" category key from a permission request (first match wins):
// 1. MCP tool (recognized across frameworks — Claude's mcp__ prefix or an opencode <server>_ name):
//    keyed by the tool name, no args.
// 2. Shell/execute tool (provider tool name Bash, or execute kind): keyed by full command signature.
// 3. Other built-ins (Write/Edit/WebFetch/…): keyed by provider tool name (falls back to title).
// The MCP check runs before the execute branch so an opencode MCP tool reporting kind:execute (e.g. a
// notebook execute-cell) is grouped as its own MCP tool, not misrouted to the shared Bash category.
const resolveCategoryKey = (
  params: RequestPermissionRequest,
  mcpServerNames: readonly string[] = []
): string => {
  const { toolCall } = params
  const reportedTitle = reportedPermissionTitle(params)
  const providerToolName = extractProviderToolName(toolCall)

  if (
    isMcpToolName(toolCall.title, mcpServerNames) ||
    isMcpToolName(providerToolName, mcpServerNames)
  ) {
    return `mcp:${reportedTitle}`
  }

  const title = resolvePermissionTitle(params, false)

  if (providerToolName === 'Bash' || toolCall.kind === 'execute') {
    return `bash:${commandSignature(title)}`
  }

  return `tool:${providerToolName ?? title}`
}

// Projects an opaque category key into the display grant shown in the composer.
const describeGrant = (categoryKey: string): AcpPermissionGrant => {
  if (categoryKey.startsWith('bash:')) {
    return { categoryKey, kind: 'shell', label: categoryKey.slice('bash:'.length) }
  }

  if (categoryKey.startsWith('mcp:')) {
    return { categoryKey, kind: 'mcp', label: categoryKey.slice('mcp:'.length) }
  }

  if (categoryKey.startsWith('tool:')) {
    return { categoryKey, kind: 'tool', label: categoryKey.slice('tool:'.length) }
  }

  return { categoryKey, kind: 'tool', label: categoryKey }
}

// Tracks permission requests until the renderer chooses an outcome.
class AcpPermissionBroker {
  private pendingRequests = new Map<string, PendingPermission>()
  // Per-session set of category keys the user chose to always allow this session.
  private alwaysAllowedCategories = new Map<string, Set<string>>()

  // Accepts the callback used to publish new permission requests to listeners.
  constructor(private readonly emitPermissionRequest: EmitPermissionRequest) {}

  // Returns serializable pending requests for runtime snapshots.
  getPendingRequests(): AcpPermissionRequest[] {
    return Array.from(this.pendingRequests.values(), ({ request }) => request)
  }

  hasPendingForSession(sessionId: string): boolean {
    return Array.from(this.pendingRequests.values()).some(
      ({ request }) => request.sessionId === sessionId
    )
  }

  // Lists the session's always-allow grants so the composer can show and revoke them.
  listGrants(sessionId: string): AcpPermissionGrant[] {
    const categories = this.alwaysAllowedCategories.get(sessionId)

    return categories ? Array.from(categories, describeGrant) : []
  }

  // Removes one always-allow grant so its tool prompts again on the next call.
  revokeGrant(sessionId: string, categoryKey: string): void {
    this.alwaysAllowedCategories.get(sessionId)?.delete(categoryKey)
  }

  // Stores a permission request and resolves it later from a renderer response.
  requestPermission(
    params: RequestPermissionRequest,
    policyContext?: PermissionPolicyContext
  ): Promise<RequestPermissionResponse> {
    const requestId = randomUUID()
    const categoryKey = resolveCategoryKey(params, policyContext?.mcpServerNames)
    const isMcp = categoryKey.startsWith('mcp:')
    const request: AcpPermissionRequest = {
      requestId,
      sessionId: params.sessionId,
      toolCallId: params.toolCall.toolCallId,
      title: resolvePermissionTitle(params, isMcp),
      status: params.toolCall.status ?? undefined,
      providerToolName: extractProviderToolName(params.toolCall),
      isMcp,
      toolKind: params.toolCall.kind ?? undefined,
      toolLocations: params.toolCall.locations ?? undefined,
      rawInput: params.toolCall.rawInput,
      options: params.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind
      })),
      raw: params
    }

    // A model-independent fallback auto-reviews only structured, workspace-contained low-risk tools.
    const automaticOptionId = resolveAutomaticPermission(params, policyContext)

    if (automaticOptionId) {
      return Promise.resolve({
        outcome: { outcome: 'selected', optionId: automaticOptionId }
      })
    }

    // A prior "Always" choice on this category auto-approves without prompting again.
    const autoAllowOptionId = this.resolveAutoAllowOptionId(request, categoryKey)

    if (autoAllowOptionId) {
      return Promise.resolve({
        outcome: { outcome: 'selected', optionId: autoAllowOptionId }
      })
    }

    // The returned promise is held open until the UI selects or cancels an option.
    return new Promise((resolve) => {
      this.pendingRequests.set(requestId, { request, categoryKey, resolve })
      this.emitPermissionRequest(request)
    })
  }

  // Resolves one pending request and reports whether it was found.
  respond(response: AcpPermissionResponse): boolean {
    const pending = this.pendingRequests.get(response.requestId)

    if (!pending) {
      return false
    }

    this.pendingRequests.delete(response.requestId)

    if (response.cancelled || !response.optionId) {
      pending.resolve({ outcome: { outcome: 'cancelled' } })
      return true
    }

    // "Always" on a tool suppresses future prompts for that same category this session.
    this.rememberAlwaysAllowed(pending.request, pending.categoryKey, response.optionId)

    pending.resolve({
      outcome: {
        outcome: 'selected',
        optionId: response.optionId
      }
    })

    return true
  }

  // Returns an allow option id when this category was already always-allowed, else undefined.
  private resolveAutoAllowOptionId(
    request: AcpPermissionRequest,
    categoryKey: string
  ): string | undefined {
    if (!this.alwaysAllowedCategories.get(request.sessionId)?.has(categoryKey)) {
      return undefined
    }

    // Prefer a one-shot allow so the agent still governs the always-allow lifecycle itself.
    const allowOption =
      request.options.find((option) => option.kind.toLowerCase() === ALLOW_ONCE_OPTION_KIND) ??
      request.options.find((option) => option.kind.toLowerCase() === ALLOW_ALWAYS_OPTION_KIND)

    return allowOption?.optionId
  }

  // Records the category as always-allowed when the user picked its allow_always option.
  private rememberAlwaysAllowed(
    request: AcpPermissionRequest,
    categoryKey: string,
    optionId: string
  ): void {
    const chosen = request.options.find((option) => option.optionId === optionId)

    if (chosen?.kind.toLowerCase() !== ALLOW_ALWAYS_OPTION_KIND) return

    const allowed = this.alwaysAllowedCategories.get(request.sessionId) ?? new Set<string>()

    allowed.add(categoryKey)
    this.alwaysAllowedCategories.set(request.sessionId, allowed)
  }

  // Cancels every pending request during full runtime teardown.
  cancelAll(): void {
    const pendingRequests = Array.from(this.pendingRequests.keys())

    for (const requestId of pendingRequests) {
      this.respond({ requestId, cancelled: true })
    }

    this.alwaysAllowedCategories.clear()
  }

  // Cancels pending requests for one session while leaving other sessions intact.
  cancelForSession(sessionId: string): void {
    const pendingRequests = Array.from(this.pendingRequests.values())

    for (const { request } of pendingRequests) {
      if (request.sessionId === sessionId) {
        this.respond({ requestId: request.requestId, cancelled: true })
      }
    }
  }
}

export { AcpPermissionBroker, resolveCategoryKey }
