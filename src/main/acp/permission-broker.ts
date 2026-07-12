import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { randomUUID } from 'node:crypto'

import type { AcpPermissionRequest, AcpPermissionResponse } from '../../shared/acp'

type PendingPermission = {
  request: AcpPermissionRequest
  resolve: (response: RequestPermissionResponse) => void
}

type EmitPermissionRequest = (request: AcpPermissionRequest) => void

// Claude Code namespaces MCP tools as mcp__<server>__<tool>; this is the notebook server's prefix.
// Notebook tool calls carry this prefix as their permission title (see runtime notes).
const NOTEBOOK_TOOL_TITLE_PREFIX = 'mcp__open-science-notebook__'

const ALLOW_ALWAYS_OPTION_KIND = 'allow_always'
const ALLOW_ONCE_OPTION_KIND = 'allow_once'

// Auto-allow is scoped to the local notebook the user opted into; shell/edit tools always prompt.
const isNotebookToolTitle = (title: string): boolean => title.startsWith(NOTEBOOK_TOOL_TITLE_PREFIX)

// Tracks permission requests until the renderer chooses an outcome.
class AcpPermissionBroker {
  private pendingRequests = new Map<string, PendingPermission>()
  // Per-session set of notebook tool titles the user chose to always allow this session.
  private alwaysAllowedNotebookTools = new Map<string, Set<string>>()

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

    // A prior "Always" choice on this notebook tool auto-approves without prompting again.
    const autoAllowOptionId = this.resolveAutoAllowOptionId(request)

    if (autoAllowOptionId) {
      return Promise.resolve({
        outcome: { outcome: 'selected', optionId: autoAllowOptionId }
      })
    }

    // The returned promise is held open until the UI selects or cancels an option.
    return new Promise((resolve) => {
      this.pendingRequests.set(requestId, { request, resolve })
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

    // "Always" on a notebook tool suppresses future prompts for that same tool this session.
    this.rememberAlwaysAllowed(pending.request, response.optionId)

    pending.resolve({
      outcome: {
        outcome: 'selected',
        optionId: response.optionId
      }
    })

    return true
  }

  // Returns an allow option id when this notebook tool was already always-allowed, else undefined.
  private resolveAutoAllowOptionId(request: AcpPermissionRequest): string | undefined {
    if (!isNotebookToolTitle(request.title)) return undefined
    if (!this.alwaysAllowedNotebookTools.get(request.sessionId)?.has(request.title)) {
      return undefined
    }

    // Prefer a one-shot allow so the agent still governs the always-allow lifecycle itself.
    const allowOption =
      request.options.find((option) => option.kind.toLowerCase() === ALLOW_ONCE_OPTION_KIND) ??
      request.options.find((option) => option.kind.toLowerCase() === ALLOW_ALWAYS_OPTION_KIND)

    return allowOption?.optionId
  }

  // Records the notebook tool as always-allowed when the user picked its allow_always option.
  private rememberAlwaysAllowed(request: AcpPermissionRequest, optionId: string): void {
    if (!isNotebookToolTitle(request.title)) return

    const chosen = request.options.find((option) => option.optionId === optionId)

    if (chosen?.kind.toLowerCase() !== ALLOW_ALWAYS_OPTION_KIND) return

    const allowed = this.alwaysAllowedNotebookTools.get(request.sessionId) ?? new Set<string>()

    allowed.add(request.title)
    this.alwaysAllowedNotebookTools.set(request.sessionId, allowed)
  }

  // Cancels every pending request during full runtime teardown.
  cancelAll(): void {
    const pendingRequests = Array.from(this.pendingRequests.keys())

    for (const requestId of pendingRequests) {
      this.respond({ requestId, cancelled: true })
    }

    this.alwaysAllowedNotebookTools.clear()
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

export { AcpPermissionBroker }
