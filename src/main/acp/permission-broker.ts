import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { randomUUID } from 'node:crypto'

import type { AcpPermissionRequest, AcpPermissionResponse } from '../../shared/acp'
import { extractProviderToolName } from './runtime-events'

type PendingPermission = {
  request: AcpPermissionRequest
  categoryKey: string
  resolve: (response: RequestPermissionResponse) => void
}

type EmitPermissionRequest = (request: AcpPermissionRequest) => void

// Claude Code namespaces MCP tools as mcp__<server>__<tool>; notebook and other MCP tool calls carry
// this prefix as their permission title, so their title alone is a stable per-tool category key.
const MCP_TOOL_TITLE_PREFIX = 'mcp__'

const ALLOW_ALWAYS_OPTION_KIND = 'allow_always'
const ALLOW_ONCE_OPTION_KIND = 'allow_once'

// Trivial `KEY=VALUE` env assignment prefixing a shell command (e.g. `FOO=bar python a.py`). Values
// containing whitespace/quotes are not covered (already split away) and fall back to the raw token.
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=[^\s]*$/

// Strips a single matching pair of surrounding quotes from a shell token.
const stripSurroundingQuotes = (token: string): string => {
  const match = token.match(/^(["'])(.*)\1$/)

  return match ? match[2] : token
}

// Derives the command signature (leading executable) used to group shell/execute permissions. Leading
// trivial env assignments are skipped so `FOO=bar python a.py` still groups under `python`.
const leadingExecutable = (command: string): string => {
  const tokens = command.trim().split(/\s+/)
  let index = 0

  while (index < tokens.length - 1 && ENV_ASSIGNMENT_PATTERN.test(tokens[index])) {
    index += 1
  }

  return stripSurroundingQuotes(tokens[index] ?? command.trim())
}

// Derives a session-scoped "Always" category key from a permission request (first match wins):
// 1. MCP/notebook tool (title starts with mcp__): keyed by title (the tool name, no args).
// 2. Shell/execute tool (provider tool name Bash, or execute kind): keyed by leading executable.
// 3. Other built-ins (Write/Edit/WebFetch/…): keyed by provider tool name (falls back to title).
// The mcp__ check runs before the execute branch so a notebook execute-cell is not misrouted to Bash.
const resolveCategoryKey = (params: RequestPermissionRequest): string => {
  const { toolCall } = params
  const title = toolCall.title ?? toolCall.toolCallId
  const providerToolName = extractProviderToolName(toolCall)

  if (title.startsWith(MCP_TOOL_TITLE_PREFIX)) {
    return `tool:${title}`
  }

  if (providerToolName === 'Bash' || toolCall.kind === 'execute') {
    return `bash:${leadingExecutable(title)}`
  }

  return `tool:${providerToolName ?? title}`
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

  // Stores a permission request and resolves it later from a renderer response.
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const requestId = randomUUID()
    const request: AcpPermissionRequest = {
      requestId,
      sessionId: params.sessionId,
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title ?? params.toolCall.toolCallId,
      status: params.toolCall.status ?? undefined,
      options: params.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind
      })),
      raw: params
    }

    const categoryKey = resolveCategoryKey(params)

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
