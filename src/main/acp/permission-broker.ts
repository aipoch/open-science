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
  resolveMcpProviderLeafIdentity,
  resolveAutomaticPermission,
  type PermissionPolicyContext
} from './permission-policy'

type PendingPermission = {
  request: AcpPermissionRequest
  categoryKey?: string
  providerAllowOnceOptionId?: string
  resolve: (response: RequestPermissionResponse) => void
}

type EmitPermissionRequest = (request: AcpPermissionRequest) => void

class ConversationPermissionGrantStore {
  private readonly categoriesBySession = new Map<string, Set<string>>()

  list(sessionId: string): string[] {
    return Array.from(this.categoriesBySession.get(sessionId) ?? [])
  }

  snapshot(): Record<string, AcpPermissionGrant[]> {
    return Object.fromEntries(
      Array.from(this.categoriesBySession, ([sessionId, categories]) => [
        sessionId,
        Array.from(categories, describeGrant)
      ])
    )
  }

  has(sessionId: string, categoryKey: string): boolean {
    return this.categoriesBySession.get(sessionId)?.has(categoryKey) ?? false
  }

  remember(sessionId: string, categoryKey: string): void {
    const categories = this.categoriesBySession.get(sessionId) ?? new Set<string>()
    categories.add(categoryKey)
    this.categoriesBySession.set(sessionId, categories)
  }

  revoke(sessionId: string, categoryKey: string): void {
    const categories = this.categoriesBySession.get(sessionId)
    categories?.delete(categoryKey)
    if (categories?.size === 0) this.categoriesBySession.delete(sessionId)
  }

  clear(sessionId: string): void {
    this.categoriesBySession.delete(sessionId)
  }
}

const ALLOW_ALWAYS_OPTION_KIND = 'allow_always'
const ALLOW_ONCE_OPTION_KIND = 'allow_once'
const REJECT_ALWAYS_OPTION_KIND = 'reject_always'
const SESSION_ALLOW_OPTION_ID_PREFIX = 'open-science:allow-session:'
const FILE_TOOL_KINDS = new Set(['read', 'edit', 'delete', 'move'])
const FILE_PROVIDER_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const NOTEBOOK_SERVER = 'open-science-notebook'
const NOTEBOOK_EXECUTION_TOOLS = new Set(['notebook_execute', 'repl_execute', 'bash_execute'])
// Depends on the codex-acp option-ID contract: persistent exec/network policy amendments are the only
// options whose IDs match this shape. If codex-acp renames them, projection silently stops — the
// projection tests (permission-broker.test.ts) pin this contract and would fail on such a drift.
const CODEX_POLICY_AMENDMENT_OPTION_ID_PATTERN = /^accept_.*policy_amendment$/
// Codex sends two allow_always options for MCP tool requests. The persistent cross-session one uses
// this option ID; the session-scoped one uses 'allow_session'. Keying on the persistent ID (not
// position) is robust to option reordering — tests pin this contract.
const CODEX_MCP_PERSISTENT_ALLOW_OPTION_ID = 'allow_always'

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

const resolveMcpToolIdentity = (
  name: string | null | undefined,
  mcpServerNames: readonly string[]
): string | undefined => {
  if (!name) return undefined

  if (name.startsWith('mcp__')) {
    const [reportedServer, ...toolParts] = name.slice('mcp__'.length).split('__')
    if (!reportedServer || toolParts.length === 0) return undefined

    // Some bridges sanitize MCP server names for tool-call compatibility (hyphens become
    // underscores). Project back to the configured server identity so the same app-owned grant is
    // reused after a framework/runtime switch instead of creating a second category.
    const server =
      mcpServerNames.find(
        (candidate) =>
          candidate === reportedServer || candidate.replaceAll('-', '_') === reportedServer
      ) ?? reportedServer
    return `${server}/${toolParts.join('__')}`
  }

  for (const server of [...mcpServerNames].sort((left, right) => right.length - left.length)) {
    const codexPrefix = `mcp.${server}.`
    if (name.startsWith(codexPrefix)) return `${server}/${name.slice(codexPrefix.length)}`

    const opencodePrefix = `${server}_`
    if (name.startsWith(opencodePrefix)) return `${server}/${name.slice(opencodePrefix.length)}`
  }

  return resolveMcpProviderLeafIdentity(name, mcpServerNames)
}

const commandSignature = (command: string): string => command.trim()

const resolveShellCommand = (params: RequestPermissionRequest): string | undefined =>
  commandFromRawInput(params.toolCall.rawInput)?.trim()

const recordInput = (rawInput: unknown): Record<string, unknown> | undefined => {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return undefined

  const record = rawInput as Record<string, unknown>
  const nested = record.arguments

  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : record
}

const normalizeNotebookRuntime = (value: string): string | undefined => {
  const normalized = value.trim().toLowerCase()

  if (normalized === 'python' || normalized === 'py') return 'python'
  if (normalized === 'r') return 'r'
  if (['repl', 'javascript', 'js', 'node'].includes(normalized)) return 'javascript'
  if (normalized === 'bash' || normalized === 'shell') return 'bash'
  return undefined
}

const resolveNotebookExecutionTool = (identity: string): string | undefined => {
  const separator = identity.indexOf('/')
  if (separator < 0) return undefined

  const server = identity.slice(0, separator).replaceAll('_', '-').toLowerCase()
  const tool = identity.slice(separator + 1).toLowerCase()
  if (server !== NOTEBOOK_SERVER || !NOTEBOOK_EXECUTION_TOOLS.has(tool)) return undefined

  return tool
}

const resolveNotebookRuntime = (tool: string, rawInput: unknown): string | undefined => {
  if (tool === 'repl_execute') return 'javascript'
  if (tool === 'bash_execute') return 'bash'

  const input = recordInput(rawInput)
  for (const field of ['kernelKind', 'kernel', 'language']) {
    const value = input?.[field]
    if (typeof value !== 'string') continue

    const runtime = normalizeNotebookRuntime(value)
    if (runtime) return runtime
  }

  const code = input?.code
  if (
    typeof code === 'string' &&
    code.trim() &&
    (/<-/.test(code) ||
      /\blibrary\(/.test(code) ||
      /\bdata\.frame\(/.test(code) ||
      /\b(ggplot|dplyr|tidyr)\(/.test(code))
  ) {
    return 'r'
  }

  return tool === 'notebook_execute' ? 'python' : undefined
}

const resolveNotebookPermissionContext = (
  name: string | null | undefined,
  rawInput: unknown,
  mcpServerNames: readonly string[]
): { runtime?: string } | undefined => {
  const identity = resolveMcpToolIdentity(name, mcpServerNames)
  if (!identity) return undefined

  const tool = resolveNotebookExecutionTool(identity)
  if (!tool) return undefined

  return { runtime: resolveNotebookRuntime(tool, rawInput) }
}

const isMcpPermission = (
  params: RequestPermissionRequest,
  mcpServerNames: readonly string[]
): boolean => {
  const providerToolName = extractProviderToolName(params.toolCall)
  return (
    isMcpToolName(params.toolCall.title, mcpServerNames) ||
    isMcpToolName(providerToolName, mcpServerNames)
  )
}

// Open Science owns per-session grants, so Codex approvals omit options that grant persistent
// (cross-session) access outside the app's visible, revocable grant model.
const projectPermissionOptions = (
  params: RequestPermissionRequest,
  policyContext: PermissionPolicyContext | undefined,
  isMcp: boolean
): RequestPermissionRequest['options'] => {
  if (policyContext?.frameworkId !== 'codex') {
    return params.options
  }

  // Codex MCP tools send two allow_always variants: a session-scoped one ('allow_session') and
  // a persistent cross-session one ('allow_always'). Strip the persistent one by its known
  // option ID so the app's session-only, revocable grant model is never bypassed.
  if (isMcp) {
    return params.options.filter(
      (option) => option.optionId !== CODEX_MCP_PERSISTENT_ALLOW_OPTION_ID
    )
  }

  // For non-MCP Codex tools, strip native policy amendments that persist outside the app.
  // Their presence also identifies execute requests when optional kind metadata is absent.
  const hasPolicyAmendment = params.options.some((option) =>
    CODEX_POLICY_AMENDMENT_OPTION_ID_PATTERN.test(option.optionId)
  )

  if (params.toolCall.kind !== 'execute' && !hasPolicyAmendment) {
    return params.options
  }

  return params.options.filter(
    (option) => !CODEX_POLICY_AMENDMENT_OPTION_ID_PATTERN.test(option.optionId)
  )
}

// Derives an app-owned session grant category key from a permission request (first match wins):
// 1. MCP tool (recognized across frameworks — Claude's mcp__ prefix or an opencode <server>_ name):
//    keyed by tool identity, with notebook execution tools further separated by runtime.
// 2. Shell/execute tool (provider tool name Bash, or execute kind): keyed by concrete command signature.
// 3. File operations: keyed by stable operation/tool identity, independent of target path.
// 4. Other built-ins (WebFetch/…): keyed by stable provider tool name.
// The MCP check runs before the execute branch so an opencode MCP tool reporting kind:execute (e.g. a
// notebook execute-cell) is grouped as its own MCP tool, not misrouted to the shared Bash category.
const resolveCategoryKey = (
  params: RequestPermissionRequest,
  mcpServerNames: readonly string[] = []
): string | undefined => {
  const { toolCall } = params
  const providerToolName = extractProviderToolName(toolCall)

  if (isMcpPermission(params, mcpServerNames)) {
    const identity =
      resolveMcpToolIdentity(toolCall.title, mcpServerNames) ??
      resolveMcpToolIdentity(providerToolName, mcpServerNames)

    if (!identity) return undefined

    const notebookContext =
      resolveNotebookPermissionContext(toolCall.title, toolCall.rawInput, mcpServerNames) ??
      resolveNotebookPermissionContext(providerToolName, toolCall.rawInput, mcpServerNames)
    if (notebookContext) {
      return notebookContext.runtime ? `mcp:${identity}:${notebookContext.runtime}` : undefined
    }

    return `mcp:${identity}`
  }

  if (providerToolName === 'Bash' || toolCall.kind === 'execute') {
    const command = resolveShellCommand(params)
    return command ? `shell:${commandSignature(command)}` : undefined
  }

  if (
    toolCall.locations?.length ||
    (toolCall.kind && FILE_TOOL_KINDS.has(toolCall.kind)) ||
    (providerToolName && FILE_PROVIDER_TOOLS.has(providerToolName))
  ) {
    const operation = providerToolName ?? toolCall.kind
    return operation ? `file:${operation}` : undefined
  }

  return providerToolName ? `tool:${providerToolName}` : undefined
}

// Projects an opaque category key into the display grant shown in the composer.
const describeGrant = (categoryKey: string): AcpPermissionGrant => {
  if (categoryKey.startsWith('shell:')) {
    return {
      categoryKey,
      kind: 'shell',
      label: categoryKey.slice('shell:'.length),
      scope: 'session'
    }
  }

  if (categoryKey.startsWith('mcp:')) {
    const descriptor = categoryKey.slice('mcp:'.length)
    const runtimeSeparator = descriptor.lastIndexOf(':')
    const identity = runtimeSeparator >= 0 ? descriptor.slice(0, runtimeSeparator) : descriptor
    const runtime = runtimeSeparator >= 0 ? descriptor.slice(runtimeSeparator + 1) : undefined
    const runtimeLabel =
      runtime === 'python'
        ? 'Python'
        : runtime === 'r'
          ? 'R'
          : runtime === 'javascript'
            ? 'JavaScript'
            : runtime === 'bash'
              ? 'Bash'
              : undefined
    const [server, tool] = identity.split('/')
    const notebookToolLabel =
      server?.replaceAll('_', '-').toLowerCase() === NOTEBOOK_SERVER
        ? tool === 'bash_execute'
          ? 'Notebook shell'
          : tool === 'notebook_execute' || tool === 'repl_execute'
            ? 'Notebook REPL'
            : undefined
        : undefined

    return {
      categoryKey,
      kind: 'mcp',
      label: runtimeLabel
        ? `${notebookToolLabel ?? identity} (${runtimeLabel})`
        : (notebookToolLabel ?? descriptor),
      scope: 'session'
    }
  }

  if (categoryKey.startsWith('file:')) {
    return {
      categoryKey,
      kind: 'tool',
      label: categoryKey.slice('file:'.length),
      scope: 'session'
    }
  }

  if (categoryKey.startsWith('tool:')) {
    return { categoryKey, kind: 'tool', label: categoryKey.slice('tool:'.length), scope: 'session' }
  }

  return { categoryKey, kind: 'tool', label: categoryKey, scope: 'session' }
}

// Tracks permission requests until the renderer chooses an outcome.
class AcpPermissionBroker {
  private pendingRequests = new Map<string, PendingPermission>()

  // Accepts the callback used to publish new permission requests to listeners.
  constructor(
    private readonly emitPermissionRequest: EmitPermissionRequest,
    private readonly conversationGrants = new ConversationPermissionGrantStore()
  ) {}

  // Returns serializable pending requests for runtime snapshots.
  getPendingRequests(): AcpPermissionRequest[] {
    return Array.from(this.pendingRequests.values(), ({ request }) => request)
  }

  hasPendingForSession(sessionId: string): boolean {
    return Array.from(this.pendingRequests.values()).some(
      ({ request }) => request.sessionId === sessionId
    )
  }

  // Lists the app conversation's grants so the composer can show and revoke them.
  listGrants(sessionId: string): AcpPermissionGrant[] {
    return this.conversationGrants.list(sessionId).map(describeGrant)
  }

  // Removes one session grant so its tool prompts again on the next call.
  revokeGrant(sessionId: string, categoryKey: string): void {
    this.conversationGrants.revoke(sessionId, categoryKey)
  }

  // Stores a permission request and resolves it later from a renderer response.
  requestPermission(
    params: RequestPermissionRequest,
    policyContext?: PermissionPolicyContext
  ): Promise<RequestPermissionResponse> {
    const requestId = randomUUID()
    const mcpServerNames = policyContext?.mcpServerNames ?? []
    const categoryKey = resolveCategoryKey(params, mcpServerNames)
    const isMcp = isMcpPermission(params, mcpServerNames)
    const projectedProviderOptions = projectPermissionOptions(params, policyContext, isMcp)
    const providerPermissionOptions = projectedProviderOptions.filter(
      (option) =>
        option.kind.toLowerCase() !== ALLOW_ALWAYS_OPTION_KIND &&
        option.kind.toLowerCase() !== REJECT_ALWAYS_OPTION_KIND
    )
    const providerAllowOnceOption = providerPermissionOptions.find(
      (option) => option.kind.toLowerCase() === ALLOW_ONCE_OPTION_KIND
    )
    const permissionOptions: AcpPermissionRequest['options'] = providerPermissionOptions.map(
      (option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
        ...(option.kind.toLowerCase() === ALLOW_ONCE_OPTION_KIND ? { scope: 'once' as const } : {})
      })
    )
    if (providerAllowOnceOption && categoryKey) {
      permissionOptions.push({
        optionId: `${SESSION_ALLOW_OPTION_ID_PREFIX}${requestId}`,
        name: 'This conversation',
        kind: ALLOW_ALWAYS_OPTION_KIND,
        scope: 'session'
      })
    }
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
      options: permissionOptions
    }

    // A model-independent fallback auto-reviews only structured, workspace-contained low-risk tools.
    // Resolve against the projected options so a stripped policy amendment can never be an automatic
    // outcome — the "amendments are never selectable" invariant must hold on the auto path too.
    const automaticOptionId = resolveAutomaticPermission(
      { ...params, options: providerPermissionOptions },
      policyContext
    )

    if (automaticOptionId) {
      return Promise.resolve({
        outcome: { outcome: 'selected', optionId: automaticOptionId }
      })
    }

    // A prior app-owned session grant auto-approves without prompting again.
    const autoAllowOptionId = categoryKey
      ? this.resolveAutoAllowOptionId(request, categoryKey)
      : undefined

    if (autoAllowOptionId) {
      return Promise.resolve({
        outcome: { outcome: 'selected', optionId: autoAllowOptionId }
      })
    }

    // The returned promise is held open until the UI selects or cancels an option.
    return new Promise((resolve) => {
      this.pendingRequests.set(requestId, {
        request,
        categoryKey,
        providerAllowOnceOptionId: providerAllowOnceOption?.optionId,
        resolve
      })
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

    // Only options projected to the renderer are valid responses. This keeps provider-specific
    // persistent policy actions hidden at the protocol boundary as well as in the UI.
    if (!pending.request.options.some((option) => option.optionId === response.optionId)) {
      pending.resolve({ outcome: { outcome: 'cancelled' } })
      return true
    }

    const selected = pending.request.options.find((option) => option.optionId === response.optionId)
    const providerOptionId =
      selected?.scope === 'session' ? pending.providerAllowOnceOptionId : response.optionId

    if (!providerOptionId) {
      pending.resolve({ outcome: { outcome: 'cancelled' } })
      return true
    }

    // Session grants are owned by Open Science. The Agent receives only its one-shot option.
    if (pending.categoryKey) {
      this.rememberSessionGrant(pending.request, pending.categoryKey, response.optionId)
    }

    pending.resolve({
      outcome: {
        outcome: 'selected',
        optionId: providerOptionId
      }
    })

    return true
  }

  // Returns a one-shot allow option when this category has an app-owned session grant.
  private resolveAutoAllowOptionId(
    request: AcpPermissionRequest,
    categoryKey: string
  ): string | undefined {
    if (!this.conversationGrants.has(request.sessionId, categoryKey)) {
      return undefined
    }

    return request.options.find((option) => option.scope === 'once')?.optionId
  }

  // Records the category when the user picks Open Science's synthetic session scope.
  private rememberSessionGrant(
    request: AcpPermissionRequest,
    categoryKey: string,
    optionId: string
  ): void {
    const chosen = request.options.find((option) => option.optionId === optionId)

    if (chosen?.scope !== 'session') return

    this.conversationGrants.remember(request.sessionId, categoryKey)
  }

  // Cancels every pending request while preserving conversation grants across Agent reconnects.
  cancelAllPending(): void {
    const pendingRequests = Array.from(this.pendingRequests.keys())

    for (const requestId of pendingRequests) {
      this.respond({ requestId, cancelled: true })
    }
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

  // Ends one Agent session: cancel its outstanding prompts and discard its non-persistent grants.
  clearSession(sessionId: string): void {
    this.cancelForSession(sessionId)
    this.conversationGrants.clear(sessionId)
  }
}

export {
  AcpPermissionBroker,
  ConversationPermissionGrantStore,
  resolveCategoryKey,
  resolveNotebookPermissionContext
}
