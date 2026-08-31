import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { createHash, randomUUID } from 'node:crypto'

import type {
  AcpPermissionGrant,
  AcpPermissionRequest,
  AcpPermissionResponse,
  AcpPermissionSettlementState
} from '../../shared/acp'
import type { SessionPermissionProfileState } from '../../shared/permission-profiles'
import type {
  PermissionCapability,
  PermissionGrantRecord,
  PermissionGrantScope
} from '../../shared/permission-grants'
import type { SessionPermissionRuntimeContext } from '../../shared/session-persistence'
import type { CommandShellDialect } from '../agent-framework/types'
import { extractProviderToolName } from './runtime-events'
import {
  isMcpToolName,
  resolveMcpProviderLeafIdentity,
  resolveAutomaticPermission,
  trustedMcpToolIdentity,
  type PermissionPolicyContext
} from './permission-policy'
import {
  canonicalAppMcpServerName,
  resolveCanonicalMcpToolIdentity
} from '../agent-framework/app-mcp-names'
import {
  capabilityFromLegacyCategory,
  categoryFromTrustedToolName,
  commandPrefixPermissionCategory,
  containsSecretBearingMaterial
} from '../permission-grants/capability'
import { projectPermissionGrantSnapshot } from '../permission-grants/catalog'
import type { PermissionGrantRegistry } from '../permission-grants/registry'

type PendingPermission = {
  request: AcpPermissionRequest
  automaticRequest?: RequestPermissionRequest
  policyContext?: PermissionPolicyContext
  categoryKey?: string
  capability?: PermissionCapability
  projectId?: string
  providerAllowOnceOptionId?: string
  durableCandidate?: DurablePermissionWaitCandidate
  durablePersisted?: boolean
  durableReady?: Promise<void>
  durableStarted?: boolean
  durablePersistenceSettled?: boolean
  settled?: boolean
  resolve: (response: RequestPermissionResponse) => void
  reject: (error: unknown) => void
}

type EmitPermissionRequest = (request: AcpPermissionRequest) => void

type DurablePermissionWaitCandidate = Readonly<{
  request: AcpPermissionRequest
  projectId?: string
  promptMessageId?: string
  fingerprint: string
  categoryKey?: string
  capability?: PermissionCapability
}>

type PermissionWaitHooks = Readonly<{
  persist: (candidate: DurablePermissionWaitCandidate) => Promise<boolean>
  settleLive: (candidate: DurablePermissionWaitCandidate) => Promise<void>
}>

type SessionCancellationToken = { cancelled: boolean }

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
const PROJECT_ALLOW_OPTION_ID_PREFIX = 'open-science:allow-project:'
const GLOBAL_ALLOW_OPTION_ID_PREFIX = 'open-science:allow-global:'
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
const CODEX_EXEC_POLICY_AMENDMENT_OPTION_ID = 'accept_execpolicy_amendment'

const metadataRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const canonicalPermissionValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalPermissionValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalPermissionValue(entry)])
  )
}

const permissionRequestFingerprint = (request: AcpPermissionRequest): string | undefined => {
  try {
    const canonical = JSON.stringify(
      canonicalPermissionValue({
        title: request.title,
        providerToolName: request.providerToolName,
        isMcp: request.isMcp,
        mcpIdentity: request.mcpIdentity,
        toolKind: request.toolKind,
        toolLocations: request.toolLocations,
        commandPrefix: request.commandPrefix,
        rawInput: request.rawInput
      })
    )
    return canonical === undefined
      ? undefined
      : createHash('sha256').update(canonical).digest('hex')
  } catch {
    return undefined
  }
}

type CodexCommandGroup = { categoryKey: string; commandPrefix: string[] }
type CodexCommandGroupMatch = { kind: 'group'; group: CodexCommandGroup } | { kind: 'unsafe' }
type SimpleCommandToken = { value: string; hasPathnameExpansion: boolean }

const commandFromRawInput = (rawInput: unknown): string | undefined => {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return undefined

  const command = (rawInput as Record<string, unknown>).command

  return typeof command === 'string' && command.trim() ? command : undefined
}

const startsVariableExpansion = (
  command: string,
  index: number,
  shellDialect: CommandShellDialect
): boolean => {
  const character = command[index]
  const next = command[index + 1]
  if (!next) return false

  if (character === '$') {
    return shellDialect === 'posix'
      ? /[A-Za-z0-9_@*#?$!{(-]/u.test(next)
      : /[\p{L}\p{N}_?^$:{(]/u.test(next)
  }

  return shellDialect === 'powershell' && character === '@' && /[\p{L}\p{N}_?^$]/u.test(next)
}

const simpleCommandArgv = (
  command: string,
  shellDialect: CommandShellDialect
): SimpleCommandToken[] | undefined => {
  const argv: SimpleCommandToken[] = []
  let token = ''
  let tokenStarted = false
  let tokenHasPathnameExpansion = false
  let quote: "'" | '"' | undefined

  const pushToken = (): void => {
    if (!tokenStarted) return
    argv.push({ value: token, hasPathnameExpansion: tokenHasPathnameExpansion })
    token = ''
    tokenStarted = false
    tokenHasPathnameExpansion = false
  }

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    if (character === '\r' || character === '\n') return undefined

    if (quote === "'") {
      if (character !== "'") {
        token += character
        tokenStarted = true
        continue
      }
      if (shellDialect === 'powershell' && command[index + 1] === "'") {
        token += "'"
        tokenStarted = true
        index += 1
      } else {
        quote = undefined
      }
      continue
    }

    if (quote === '"') {
      const escape = shellDialect === 'powershell' ? '`' : '\\'
      if (character === escape) {
        const escaped = command[index + 1]
        if (escaped === undefined || /[\r\n]/u.test(escaped)) return undefined
        token +=
          shellDialect === 'posix' && !/[$`"\\]/u.test(escaped) ? `${character}${escaped}` : escaped
        tokenStarted = true
        index += 1
        continue
      }
      if (character === '"') {
        quote = undefined
        continue
      }
      if (
        (shellDialect === 'posix' && character === '`') ||
        (character === '$' && startsVariableExpansion(command, index, shellDialect))
      ) {
        return undefined
      }
      token += character
      tokenStarted = true
      continue
    }

    const isWordSeparator =
      shellDialect === 'posix' ? character === ' ' || character === '\t' : /\s/u.test(character)
    if (isWordSeparator) {
      pushToken()
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      tokenStarted = true
      continue
    }

    const escape = shellDialect === 'powershell' ? '`' : '\\'
    if (character === escape) {
      const escaped = command[index + 1]
      if (escaped === undefined || /[\r\n]/u.test(escaped)) return undefined
      token += escaped
      tokenStarted = true
      index += 1
      continue
    }

    if (
      /[;&|<>\r\n]/u.test(character) ||
      (shellDialect === 'posix' && /[`()]/u.test(character)) ||
      (shellDialect === 'powershell' && /[(){}]/u.test(character)) ||
      startsVariableExpansion(command, index, shellDialect)
    ) {
      return undefined
    }
    if (
      (character === '~' &&
        (!tokenStarted ||
          (shellDialect === 'posix' &&
            (token.endsWith('=') || (token.includes('=') && token.endsWith(':')))))) ||
      /[?*[]/u.test(character) ||
      (shellDialect === 'posix' && (character === '{' || (character === '=' && !tokenStarted)))
    ) {
      tokenHasPathnameExpansion = true
    }
    token += character
    tokenStarted = true
  }

  if (quote) return undefined
  pushToken()
  return argv
}

// Reads Codex's structured argv-prefix proposal only when the provider offers the matching native
// policy amendment. Some codex-acp shapes repeat the prefix on the request instead of the option.
const codexCommandGroup = (
  params: RequestPermissionRequest,
  shellDialect: CommandShellDialect | undefined
): CodexCommandGroupMatch | undefined => {
  const option = params.options.find(
    (candidate) =>
      candidate.optionId === CODEX_EXEC_POLICY_AMENDMENT_OPTION_ID &&
      candidate.kind.toLowerCase() === ALLOW_ALWAYS_OPTION_KIND
  )
  if (!option || !shellDialect) return undefined

  const optionCodex = metadataRecord(option._meta?.codex)
  const requestCodex = metadataRecord(params._meta?.codex)
  const requestParams = metadataRecord(requestCodex?.params)

  const amendment = optionCodex?.execpolicyAmendment ?? requestParams?.proposedExecpolicyAmendment
  if (!Array.isArray(amendment)) return undefined
  const command = commandFromRawInput(params.toolCall.rawInput)
  if (command && containsSecretBearingMaterial(command)) return { kind: 'unsafe' }
  const categoryKey = commandPrefixPermissionCategory(amendment)
  if (!categoryKey) return undefined

  const commandPrefix = amendment.filter((token): token is string => typeof token === 'string')
  const commandArgv = command ? simpleCommandArgv(command, shellDialect) : undefined
  if (
    !command ||
    !commandArgv ||
    !commandPrefix.every((token, index) => commandArgv[index]?.value === token)
  ) {
    return undefined
  }
  if (commandPrefix.some((_, index) => commandArgv[index]?.hasPathnameExpansion)) {
    return { kind: 'unsafe' }
  }

  return {
    kind: 'group',
    group: { categoryKey, commandPrefix }
  }
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
): string | undefined =>
  resolveCanonicalMcpToolIdentity(name, mcpServerNames) ??
  resolveMcpProviderLeafIdentity(name, mcpServerNames)

const resolveTrustedMcpToolIdentity = (
  params: RequestPermissionRequest,
  mcpServerNames: readonly string[]
): string | undefined => {
  const identity = trustedMcpToolIdentity(params)
  const separator = identity?.indexOf('/') ?? -1
  if (!identity || separator <= 0 || separator === identity.length - 1) return undefined

  const server = canonicalAppMcpServerName(identity.slice(0, separator))
  const configuredServers = new Set(mcpServerNames.map(canonicalAppMcpServerName))
  if (!configuredServers.has(server)) return undefined

  return `${server}/${identity.slice(separator + 1)}`
}

const commandSignature = (command: string): string => command.trim()

const resolveLegacyClaudeMcpIdentity = (name: string | null | undefined): string | undefined => {
  if (!name?.startsWith('mcp__')) return undefined
  const [server, ...toolParts] = name.slice('mcp__'.length).split('__')
  return server && toolParts.length > 0 ? `${server}/${toolParts.join('__')}` : undefined
}

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

// Durable Skill identity requires provider metadata. Display-only titles are accepted only by the
// legacy in-memory broker, where they cannot create persistent authority.
const isSkillPermission = (
  params: RequestPermissionRequest,
  allowLegacyDisplayIdentity = false
): boolean => {
  const providerToolName = extractProviderToolName(params.toolCall)?.trim().toLowerCase()

  if (providerToolName === 'skill') return true
  return allowLegacyDisplayIdentity && /\bskill\b/i.test(params.toolCall.title ?? '')
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

  return resolveNotebookPermissionContextForIdentity(identity, rawInput)
}

const resolveNotebookPermissionContextForIdentity = (
  identity: string,
  rawInput: unknown
): { runtime?: string } | undefined => {
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
    resolveTrustedMcpToolIdentity(params, mcpServerNames) != null ||
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
// 2. Native Skill tool: keyed by the stable provider capability.
// 3. Shell/execute tool (provider tool name Bash, or execute kind): keyed by concrete command signature.
// 4. File operations: keyed by stable operation/tool identity, independent of target path.
// 5. Other built-ins: keyed by stable provider tool name.
// The MCP check runs before the execute branch so an opencode MCP tool reporting kind:execute (e.g. a
// notebook execute-cell) is grouped as its own MCP tool, not misrouted to the shared Bash category.
const resolveCategoryKey = (
  params: RequestPermissionRequest,
  mcpServerNames: readonly string[] = [],
  allowLegacyReportedMcp = false
): string | undefined => {
  const { toolCall } = params
  const providerToolName = extractProviderToolName(toolCall)
  const trustedIdentity = resolveTrustedMcpToolIdentity(params, mcpServerNames)

  if (isMcpPermission(params, mcpServerNames)) {
    const identity =
      trustedIdentity ??
      resolveMcpToolIdentity(providerToolName, mcpServerNames) ??
      (allowLegacyReportedMcp
        ? (resolveMcpToolIdentity(toolCall.title, mcpServerNames) ??
          resolveLegacyClaudeMcpIdentity(providerToolName) ??
          resolveLegacyClaudeMcpIdentity(toolCall.title))
        : undefined)

    if (!identity) return undefined

    const notebookContext =
      (trustedIdentity
        ? resolveNotebookPermissionContextForIdentity(trustedIdentity, toolCall.rawInput)
        : resolveNotebookPermissionContext(providerToolName, toolCall.rawInput, mcpServerNames)) ??
      (allowLegacyReportedMcp
        ? (() => {
            const tool = resolveNotebookExecutionTool(identity)
            return tool ? { runtime: resolveNotebookRuntime(tool, toolCall.rawInput) } : undefined
          })()
        : undefined)
    if (notebookContext) {
      return notebookContext.runtime ? `mcp:${identity}:${notebookContext.runtime}` : undefined
    }

    return `mcp:${identity}`
  }

  // Only provider metadata/codecs may create durable identities. `title` is display text and can be
  // model-controlled on some ACP bridges, so title-only requests remain Once-only.
  const registeredCategory = categoryFromTrustedToolName(providerToolName)
  if (registeredCategory) return registeredCategory

  if (isSkillPermission(params, allowLegacyReportedMcp)) return 'skill'

  // V1 provider-native web tools are always one-shot, including the legacy in-memory broker path.
  if (providerToolName === 'WebFetch' || providerToolName === 'WebSearch') return undefined

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
  if (categoryKey.startsWith('shell-group:')) {
    return { categoryKey, kind: 'shell', label: 'Command group', scope: 'session' }
  }

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

  if (categoryKey === 'skill') {
    return {
      categoryKey,
      kind: 'tool',
      label: 'Skill',
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

const describeRegistryGrant = (record: PermissionGrantRecord): AcpPermissionGrant => {
  const [view] = projectPermissionGrantSnapshot([record]).grants
  const label = view.qualifierLabel
    ? `${view.capabilityLabel} · ${view.qualifierLabel}`
    : view.capabilityLabel
  return {
    // Existing renderer plumbing treats this field as opaque. Registry-backed Session grants use the
    // durable row id so composer revoke cannot accidentally broaden to another capability.
    categoryKey: record.id,
    label,
    kind:
      record.capability.kind === 'execution'
        ? 'shell'
        : record.capability.kind === 'mcp_tool'
          ? 'mcp'
          : 'tool',
    scope: 'session'
  }
}

const projectRegistrySessionGrants = (
  records: PermissionGrantRecord[]
): Record<string, AcpPermissionGrant[]> => {
  const grantsBySession: Record<string, AcpPermissionGrant[]> = {}
  for (const record of records) {
    if (record.scope.kind !== 'session') continue
    const grants = grantsBySession[record.scope.sessionId] ?? []
    grants.push(describeRegistryGrant(record))
    grantsBySession[record.scope.sessionId] = grants
  }
  return grantsBySession
}

// Tracks permission requests until the renderer chooses an outcome.
class AcpPermissionBroker {
  private pendingRequests = new Map<string, PendingPermission>()
  private readonly restoredAllowOnceBySession = new Map<string, string>()
  private readonly durableRequestQueues = new Map<string, string[]>()
  private readonly activeDurableRequestBySession = new Map<string, string>()
  private cancellationGeneration = 0
  private readonly sessionCancellationTokens = new Map<string, Set<SessionCancellationToken>>()
  private readonly livePermissionProfiles = new Map<
    string,
    {
      profile: Readonly<SessionPermissionProfileState>
      isCurrent: () => boolean
      providerUpdatesBlocked: boolean
    }
  >()

  // Accepts the callback used to publish new permission requests to listeners.
  constructor(
    private readonly emitPermissionRequest: EmitPermissionRequest,
    private readonly conversationGrants = new ConversationPermissionGrantStore(),
    private readonly permissionGrantRegistry?: PermissionGrantRegistry,
    private readonly onPermissionSettled?: (
      requestId: string,
      state: AcpPermissionSettlementState,
      request: AcpPermissionRequest
    ) => void,
    private readonly permissionWaitHooks?: PermissionWaitHooks
  ) {}

  // Returns serializable pending requests for runtime snapshots.
  getPendingRequests(): AcpPermissionRequest[] {
    return Array.from(this.pendingRequests.values())
      .filter(
        (pending) =>
          !pending.durableCandidate ||
          !this.permissionWaitHooks ||
          pending.durablePersistenceSettled === true
      )
      .map(({ request }) => request)
  }

  hasPendingForSession(sessionId: string): boolean {
    return Array.from(this.pendingRequests.values()).some(
      ({ request }) => request.sessionId === sessionId
    )
  }

  hasDurablePendingForSession(sessionId: string): boolean {
    return Array.from(this.pendingRequests.values()).some(
      ({ request, durablePersisted }) =>
        request.sessionId === sessionId && durablePersisted === true
    )
  }

  // Publishes the committed Session posture used by new provider permission requests.
  setLivePermissionProfile(
    sessionId: string,
    profile: Readonly<SessionPermissionProfileState>,
    isCurrent: () => boolean = () => true
  ): void {
    this.livePermissionProfiles.set(sessionId, {
      profile,
      isCurrent,
      providerUpdatesBlocked: false
    })
  }

  beginPermissionProfileTransition(
    sessionId: string,
    profile: Readonly<SessionPermissionProfileState>,
    isCurrent: () => boolean
  ): void {
    this.livePermissionProfiles.set(sessionId, { profile, isCurrent, providerUpdatesBlocked: true })
  }

  // A user-requested transition remains authoritative until its runtime operation commits or rolls
  // back, so a delayed provider mode notification cannot restore stale Full access in the meantime.
  setProviderPermissionProfile(
    sessionId: string,
    profile: Readonly<SessionPermissionProfileState>
  ): boolean {
    if (this.livePermissionProfiles.get(sessionId)?.providerUpdatesBlocked) return false
    this.setLivePermissionProfile(sessionId, profile)
    return true
  }

  clearLivePermissionProfile(sessionId: string): void {
    this.livePermissionProfiles.delete(sessionId)
  }

  async applyPermissionProfile(
    sessionId: string,
    profile: Readonly<SessionPermissionProfileState>,
    isCurrent: () => boolean = () => true
  ): Promise<string[]> {
    const providerUpdatesBlocked =
      this.livePermissionProfiles.get(sessionId)?.providerUpdatesBlocked ?? false
    this.livePermissionProfiles.set(sessionId, { profile, isCurrent, providerUpdatesBlocked })
    const resolvedRequestIds: string[] = []
    for (const [requestId, pending] of Array.from(this.pendingRequests)) {
      if (!isCurrent()) break
      if (pending.request.sessionId !== sessionId || !pending.automaticRequest) continue

      const optionId = resolveAutomaticPermission(pending.automaticRequest, {
        ...pending.policyContext,
        profile: profile.selectedProfile,
        autoReviewStrategy: profile.autoReviewStrategy
      })
      if (!optionId) continue
      if (!isCurrent()) break

      if (await this.respond({ requestId, optionId })) resolvedRequestIds.push(requestId)
    }
    return resolvedRequestIds
  }

  // Lists the app conversation's grants so the composer can show and revoke them.
  listGrants(sessionId: string): AcpPermissionGrant[] {
    if (this.permissionGrantRegistry) {
      return this.permissionGrantRegistry
        .listCached()
        .filter((record) => record.scope.kind === 'session' && record.scope.sessionId === sessionId)
        .map(describeRegistryGrant)
    }
    return this.conversationGrants.list(sessionId).map(describeGrant)
  }

  // Removes one session grant so its tool prompts again on the next call.
  async revokeGrant(sessionId: string, categoryKey: string): Promise<void> {
    if (this.permissionGrantRegistry) {
      const record = this.permissionGrantRegistry
        .listCached()
        .find(
          (candidate) =>
            candidate.id === categoryKey &&
            candidate.scope.kind === 'session' &&
            candidate.scope.sessionId === sessionId
        )
      if (!record) return
      await this.permissionGrantRegistry.revoke({
        grants: [{ id: record.id, revision: record.revision }]
      })
      return
    }
    this.conversationGrants.revoke(sessionId, categoryKey)
  }

  // Parks an application-owned approval on the same renderer permission surface used for provider
  // tool calls. This deliberately reuses the broker's pending map, cancellation, and response
  // validation instead of creating a second Specialist approval state machine.
  requestAppApproval(input: {
    sessionId: string
    title: string
    rawInput: unknown
  }): Promise<boolean> {
    const requestId = randomUUID()
    const approveOptionId = `${requestId}:approve`
    const request: AcpPermissionRequest = {
      requestId,
      sessionId: input.sessionId,
      toolCallId: `app-approval:${requestId}`,
      title: input.title,
      providerToolName: 'Open Science',
      rawInput: input.rawInput,
      options: [
        { optionId: approveOptionId, name: 'Approve', kind: 'allow_once', scope: 'once' },
        { optionId: `${requestId}:decline`, name: 'Decline', kind: 'reject_once' }
      ]
    }

    return this.enqueuePermissionRequest({
      requestId,
      request,
      providerAllowOnceOptionId: approveOptionId
    }).then(
      (response) =>
        response.outcome.outcome === 'selected' && response.outcome.optionId === approveOptionId
    )
  }

  // Stores a permission request and resolves it later from a renderer response.
  requestPermission(
    params: RequestPermissionRequest,
    policyContext?: PermissionPolicyContext
  ): Promise<RequestPermissionResponse> {
    const cancellationGeneration = this.cancellationGeneration
    const requestId = randomUUID()
    const mcpServerNames = policyContext?.mcpServerNames ?? []
    const isMcp = isMcpPermission(params, mcpServerNames)
    const codexGroupMatch =
      policyContext?.frameworkId === 'codex' && !isMcp
        ? codexCommandGroup(params, policyContext.shellDialect)
        : undefined
    const codexGroup = codexGroupMatch?.kind === 'group' ? codexGroupMatch.group : undefined
    const categoryKey =
      codexGroup?.categoryKey ??
      (codexGroupMatch?.kind === 'unsafe'
        ? undefined
        : resolveCategoryKey(params, mcpServerNames, !this.permissionGrantRegistry))
    const capability = categoryKey ? capabilityFromLegacyCategory(categoryKey) : undefined
    const mcpIdentity = isMcp
      ? (resolveTrustedMcpToolIdentity(params, mcpServerNames) ??
        resolveMcpToolIdentity(params.toolCall.title, mcpServerNames) ??
        resolveMcpToolIdentity(extractProviderToolName(params.toolCall), mcpServerNames))
      : undefined
    const projectedProviderOptions = projectPermissionOptions(params, policyContext, isMcp)
    const providerPermissionOptions = projectedProviderOptions.filter(
      (option) =>
        option.kind.toLowerCase() !== ALLOW_ALWAYS_OPTION_KIND &&
        option.kind.toLowerCase() !== REJECT_ALWAYS_OPTION_KIND
    )
    const providerAllowOnceOption = providerPermissionOptions.find(
      (option) => option.kind.toLowerCase() === ALLOW_ONCE_OPTION_KIND
    )
    // Remembered scopes are app-owned, but every released call must still select a provider-native
    // one-call option. Without one there is no safe positive response, so fail closed immediately.
    if (!providerAllowOnceOption) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    }
    const permissionOptions: AcpPermissionRequest['options'] = providerPermissionOptions.map(
      (option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
        ...(option.kind.toLowerCase() === ALLOW_ONCE_OPTION_KIND ? { scope: 'once' as const } : {})
      })
    )
    if (categoryKey) {
      if (this.permissionGrantRegistry && capability && policyContext?.projectId) {
        permissionOptions.push(
          {
            optionId: `${SESSION_ALLOW_OPTION_ID_PREFIX}${requestId}`,
            name: 'This session',
            kind: ALLOW_ALWAYS_OPTION_KIND,
            scope: 'session'
          },
          {
            optionId: `${PROJECT_ALLOW_OPTION_ID_PREFIX}${requestId}`,
            name: 'This project',
            kind: ALLOW_ALWAYS_OPTION_KIND,
            scope: 'project'
          },
          {
            optionId: `${GLOBAL_ALLOW_OPTION_ID_PREFIX}${requestId}`,
            name: 'Always',
            kind: ALLOW_ALWAYS_OPTION_KIND,
            scope: 'global'
          }
        )
      } else if (!this.permissionGrantRegistry) {
        permissionOptions.push({
          optionId: `${SESSION_ALLOW_OPTION_ID_PREFIX}${requestId}`,
          name: 'This session',
          kind: ALLOW_ALWAYS_OPTION_KIND,
          scope: 'session'
        })
      }
    }
    const request: AcpPermissionRequest = {
      requestId,
      sessionId: params.sessionId,
      toolCallId: params.toolCall.toolCallId,
      title: resolvePermissionTitle(params, isMcp),
      status: params.toolCall.status ?? undefined,
      providerToolName: extractProviderToolName(params.toolCall),
      isMcp,
      ...(mcpIdentity ? { mcpIdentity } : {}),
      toolKind: params.toolCall.kind ?? undefined,
      toolLocations: params.toolCall.locations ?? undefined,
      ...(codexGroup ? { commandPrefix: codexGroup.commandPrefix } : {}),
      rawInput: params.toolCall.rawInput,
      options: permissionOptions
    }
    const fingerprint = permissionRequestFingerprint(request)
    const durableCandidate: DurablePermissionWaitCandidate | undefined = fingerprint
      ? {
          request,
          projectId: policyContext?.projectId,
          promptMessageId: policyContext?.promptMessageId,
          fingerprint,
          categoryKey,
          capability
        }
      : undefined

    if (
      durableCandidate &&
      this.restoredAllowOnceBySession.get(request.sessionId) === durableCandidate.fingerprint
    ) {
      this.restoredAllowOnceBySession.delete(request.sessionId)
      return Promise.resolve({
        outcome: { outcome: 'selected', optionId: providerAllowOnceOption.optionId }
      })
    }

    // A model-independent fallback auto-reviews only structured, workspace-contained low-risk tools.
    // Resolve against the projected options so a stripped policy amendment can never be an automatic
    // outcome — the "amendments are never selectable" invariant must hold on the auto path too.
    const automaticRequest = { ...params, options: providerPermissionOptions }
    const automaticOptionId = this.resolveCurrentAutomaticPermission(
      automaticRequest,
      policyContext
    )

    if (automaticOptionId) {
      return Promise.resolve({
        outcome: { outcome: 'selected', optionId: automaticOptionId }
      })
    }

    if (this.permissionGrantRegistry && capability) {
      const sessionCancellationToken = this.trackSessionCancellation(params.sessionId)
      return this.permissionGrantRegistry
        .resolve(capability, {
          projectId: policyContext?.projectId,
          sessionId: policyContext?.permissionGrantSessionId ?? params.sessionId
        })
        .then((match) => {
          if (
            cancellationGeneration !== this.cancellationGeneration ||
            sessionCancellationToken.cancelled
          ) {
            return { outcome: { outcome: 'cancelled' as const } }
          }
          if (match && providerAllowOnceOption) {
            return {
              outcome: { outcome: 'selected' as const, optionId: providerAllowOnceOption.optionId }
            }
          }
          return this.resolveOrEnqueuePermissionRequest({
            requestId,
            request,
            automaticRequest,
            policyContext,
            categoryKey,
            capability,
            projectId: policyContext?.projectId,
            providerAllowOnceOptionId: providerAllowOnceOption?.optionId,
            durableCandidate
          })
        })
        .finally(() => {
          this.releaseSessionCancellation(params.sessionId, sessionCancellationToken)
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
    return this.resolveOrEnqueuePermissionRequest({
      requestId,
      request,
      automaticRequest,
      policyContext,
      categoryKey,
      providerAllowOnceOptionId: providerAllowOnceOption?.optionId,
      durableCandidate
    })
  }

  private resolveOrEnqueuePermissionRequest(
    pending: Omit<PendingPermission, 'resolve' | 'reject'> & { requestId: string }
  ): Promise<RequestPermissionResponse> {
    const liveAutomaticOptionId = pending.automaticRequest
      ? this.resolveCurrentAutomaticPermission(pending.automaticRequest, pending.policyContext)
      : undefined

    if (liveAutomaticOptionId) {
      return Promise.resolve({
        outcome: { outcome: 'selected', optionId: liveAutomaticOptionId }
      })
    }

    return this.enqueuePermissionRequest(pending)
  }

  private resolveCurrentAutomaticPermission(
    request: RequestPermissionRequest,
    policyContext?: PermissionPolicyContext
  ): string | undefined {
    const liveProfile = this.livePermissionProfiles.get(request.sessionId)
    if (!liveProfile) return resolveAutomaticPermission(request, policyContext)
    if (!liveProfile.isCurrent()) return undefined

    return resolveAutomaticPermission(request, {
      ...policyContext,
      profile: liveProfile.profile.selectedProfile,
      autoReviewStrategy: liveProfile.profile.autoReviewStrategy
    })
  }

  private enqueuePermissionRequest(
    pending: Omit<PendingPermission, 'resolve' | 'reject'> & { requestId: string }
  ): Promise<RequestPermissionResponse> {
    let resolveResponse!: (response: RequestPermissionResponse) => void
    let rejectResponse!: (error: unknown) => void
    const response = new Promise<RequestPermissionResponse>((resolve, reject) => {
      resolveResponse = resolve
      rejectResponse = reject
    })
    const { requestId, ...entry } = pending
    const stored: PendingPermission = {
      ...entry,
      resolve: resolveResponse,
      reject: rejectResponse
    }
    this.pendingRequests.set(requestId, stored)

    if (!stored.durableCandidate || !this.permissionWaitHooks) {
      this.emitPermissionRequest(entry.request)
      return response
    }

    const sessionId = stored.request.sessionId
    const queue = this.durableRequestQueues.get(sessionId) ?? []
    queue.push(requestId)
    this.durableRequestQueues.set(sessionId, queue)
    this.startNextDurablePermission(sessionId)
    return response
  }

  private startNextDurablePermission(sessionId: string): void {
    if (this.activeDurableRequestBySession.has(sessionId)) return

    const hooks = this.permissionWaitHooks
    if (!hooks) return
    const queue = this.durableRequestQueues.get(sessionId)
    while (queue?.length) {
      const requestId = queue.shift()!
      const stored = this.pendingRequests.get(requestId)
      const candidate = stored?.durableCandidate
      if (!stored || !candidate) continue

      if (queue.length === 0) this.durableRequestQueues.delete(sessionId)
      this.activeDurableRequestBySession.set(sessionId, requestId)
      stored.durableStarted = true
      stored.durablePersistenceSettled = false
      stored.durableReady = hooks.persist(candidate).then((persisted) => {
        stored.durablePersisted = persisted
        stored.durablePersistenceSettled = true
        if (persisted) stored.request = { ...stored.request, durable: true }

        if (this.pendingRequests.get(requestId) === stored) {
          this.emitPermissionRequest(stored.request)
        }
        if (!persisted) this.releaseDurablePermissionSlot(stored)
      })
      void stored.durableReady.catch((error: unknown) => {
        stored.durablePersistenceSettled = true
        if (this.pendingRequests.get(requestId) === stored) {
          this.pendingRequests.delete(requestId)
        }
        this.rejectPending(stored, error, 'cancelled')
        this.cancelQueuedDurablePermissions(sessionId)
        this.activeDurableRequestBySession.delete(sessionId)
      })
      return
    }

    this.durableRequestQueues.delete(sessionId)
  }

  private releaseDurablePermissionSlot(pending: PendingPermission): void {
    const sessionId = pending.request.sessionId
    if (this.activeDurableRequestBySession.get(sessionId) !== pending.request.requestId) {
      return
    }

    this.activeDurableRequestBySession.delete(sessionId)
    this.startNextDurablePermission(sessionId)
  }

  private removeQueuedDurablePermission(pending: PendingPermission): void {
    const sessionId = pending.request.sessionId
    const queue = this.durableRequestQueues.get(sessionId)
    if (!queue) return

    const requestIndex = queue.indexOf(pending.request.requestId)
    if (requestIndex >= 0) queue.splice(requestIndex, 1)
    if (queue.length === 0) this.durableRequestQueues.delete(sessionId)
  }

  private cancelQueuedDurablePermissions(sessionId: string): void {
    const requestIds = this.durableRequestQueues.get(sessionId) ?? []
    this.durableRequestQueues.delete(sessionId)

    for (const requestId of requestIds) {
      const queued = this.pendingRequests.get(requestId)
      if (!queued) continue
      this.pendingRequests.delete(requestId)
      this.settlePending(queued, { outcome: { outcome: 'cancelled' } }, 'cancelled')
    }
  }

  // Resolves one pending request and reports whether it was found.
  async respond(response: AcpPermissionResponse): Promise<boolean> {
    const pending = this.pendingRequests.get(response.requestId)

    if (!pending) {
      return false
    }

    this.pendingRequests.delete(response.requestId)

    if (response.cancelled || !response.optionId) {
      const persistence = this.persistLiveSettlement(pending)
      if (persistence) await persistence
      this.settlePending(pending, { outcome: { outcome: 'cancelled' } }, 'cancelled')
      return true
    }

    // Only options projected to the renderer are valid responses. This keeps provider-specific
    // persistent policy actions hidden at the protocol boundary as well as in the UI.
    if (!pending.request.options.some((option) => option.optionId === response.optionId)) {
      const persistence = this.persistLiveSettlement(pending)
      if (persistence) await persistence
      this.settlePending(pending, { outcome: { outcome: 'cancelled' } }, 'cancelled')
      return true
    }

    const selected = pending.request.options.find((option) => option.optionId === response.optionId)
    const settlementState: AcpPermissionSettlementState = selected?.kind
      .toLowerCase()
      .startsWith('reject')
      ? 'rejected'
      : 'resolved'
    const rememberedScope =
      selected?.scope === 'session' || selected?.scope === 'project' || selected?.scope === 'global'
    const providerOptionId = rememberedScope ? pending.providerAllowOnceOptionId : response.optionId

    if (!providerOptionId) {
      const persistence = this.persistLiveSettlement(pending)
      if (persistence) await persistence
      this.settlePending(pending, { outcome: { outcome: 'cancelled' } }, 'cancelled')
      return true
    }

    if (
      rememberedScope &&
      selected?.scope &&
      pending.capability &&
      pending.projectId &&
      this.permissionGrantRegistry
    ) {
      const scope: PermissionGrantScope =
        selected.scope === 'global'
          ? { kind: 'global' }
          : selected.scope === 'project'
            ? { kind: 'project', projectId: pending.projectId }
            : {
                kind: 'session',
                projectId: pending.projectId,
                sessionId:
                  pending.policyContext?.permissionGrantSessionId ?? pending.request.sessionId
              }
      try {
        const persistence = this.persistLiveSettlement(pending)
        if (persistence) await persistence
        await this.permissionGrantRegistry.remember({ capability: pending.capability, scope })
        this.settlePending(
          pending,
          { outcome: { outcome: 'selected', optionId: providerOptionId } },
          settlementState
        )
      } catch (error) {
        this.settlePending(pending, { outcome: { outcome: 'cancelled' } }, 'cancelled')
        throw new Error('Permission approval could not be saved; the tool call was cancelled.', {
          cause: error
        })
      }
      return true
    }

    // Legacy Session grants are owned by Open Science. The Agent receives only its one-shot option.
    if (pending.categoryKey) {
      this.rememberSessionGrant(pending.request, pending.categoryKey, response.optionId)
    }

    const persistence = this.persistLiveSettlement(pending)
    if (persistence) await persistence

    this.settlePending(
      pending,
      {
        outcome: {
          outcome: 'selected',
          optionId: providerOptionId
        }
      },
      settlementState
    )

    return true
  }

  private persistLiveSettlement(pending: PendingPermission): Promise<void> | undefined {
    const candidate = pending.durableCandidate
    const hooks = this.permissionWaitHooks
    if (!candidate || !hooks) return undefined
    return (async () => {
      if (!pending.durableStarted) {
        this.removeQueuedDurablePermission(pending)
        return
      }

      try {
        await pending.durableReady
        if (!pending.durablePersisted) return
        await hooks.settleLive(candidate)
        this.releaseDurablePermissionSlot(pending)
      } catch (error) {
        this.cancelQueuedDurablePermissions(pending.request.sessionId)
        this.activeDurableRequestBySession.delete(pending.request.sessionId)
        this.settlePending(pending, { outcome: { outcome: 'cancelled' } }, 'cancelled')
        throw new Error(
          'Permission decision could not be persisted; the tool call was cancelled.',
          {
            cause: error
          }
        )
      }
    })()
  }

  private settlePending(
    pending: PendingPermission,
    response: RequestPermissionResponse,
    state: AcpPermissionSettlementState
  ): void {
    if (pending.settled) return
    pending.settled = true
    pending.resolve(response)
    try {
      this.onPermissionSettled?.(pending.request.requestId, state, pending.request)
    } catch {
      // Notification projection failures must never change the permission decision.
    }
  }

  private rejectPending(
    pending: PendingPermission,
    error: unknown,
    state: AcpPermissionSettlementState
  ): void {
    if (pending.settled) return
    pending.settled = true
    pending.reject(error)
    try {
      this.onPermissionSettled?.(pending.request.requestId, state, pending.request)
    } catch {
      // Notification projection failures must never change the permission decision.
    }
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

  async prepareRestoredDecision(
    permission: SessionPermissionRuntimeContext,
    option: AcpPermissionRequest['options'][number] | undefined,
    projectId: string
  ): Promise<void> {
    if (!option || option.kind.toLowerCase().startsWith('reject_')) return
    if (!option.kind.toLowerCase().startsWith('allow_')) {
      throw new Error('The restored permission option cannot be replayed safely.')
    }

    if (option.scope === 'once' || option.kind.toLowerCase() === ALLOW_ONCE_OPTION_KIND) {
      this.restoredAllowOnceBySession.set(permission.request.sessionId, permission.fingerprint)
      return
    }

    if (
      (option.scope === 'session' || option.scope === 'project' || option.scope === 'global') &&
      permission.capability &&
      this.permissionGrantRegistry
    ) {
      const scope: PermissionGrantScope =
        option.scope === 'global'
          ? { kind: 'global' }
          : option.scope === 'project'
            ? { kind: 'project', projectId }
            : { kind: 'session', projectId, sessionId: permission.request.sessionId }
      await this.permissionGrantRegistry.remember({ capability: permission.capability, scope })
      return
    }

    if (option.scope === 'session' && permission.categoryKey) {
      this.conversationGrants.remember(permission.request.sessionId, permission.categoryKey)
      return
    }
    throw new Error('The restored permission scope cannot be granted safely.')
  }

  clearRestoredDecision(sessionId: string): void {
    this.restoredAllowOnceBySession.delete(sessionId)
  }

  // Process/connection teardown must release the dead provider RPC without erasing the durable
  // human decision. No settlement callback fires because the restored card remains pending.
  abandonAllPending(): void {
    this.cancellationGeneration += 1
    this.livePermissionProfiles.clear()
    this.restoredAllowOnceBySession.clear()
    this.durableRequestQueues.clear()
    this.activeDurableRequestBySession.clear()
    const pending = Array.from(this.pendingRequests.values())
    this.pendingRequests.clear()
    for (const request of pending) {
      if (request.settled) continue
      if (
        request.durablePersisted ||
        (request.durableReady && !request.durablePersistenceSettled)
      ) {
        request.settled = true
        request.resolve({ outcome: { outcome: 'cancelled' } })
      } else {
        this.settlePending(request, { outcome: { outcome: 'cancelled' } }, 'cancelled')
      }
    }
  }

  // Cancels every pending request while preserving conversation grants across Agent reconnects.
  cancelAllPending(): void {
    this.cancellationGeneration += 1
    this.sessionCancellationTokens.clear()
    this.livePermissionProfiles.clear()
    this.restoredAllowOnceBySession.clear()
    const pendingRequests = Array.from(this.pendingRequests.keys())

    for (const requestId of pendingRequests) {
      void this.respond({ requestId, cancelled: true }).catch(() => undefined)
    }
  }

  // Cancels pending requests for one session while leaving other sessions intact.
  cancelForSession(sessionId: string): void {
    const cancellationTokens = this.sessionCancellationTokens.get(sessionId)
    this.sessionCancellationTokens.delete(sessionId)
    for (const token of cancellationTokens ?? []) token.cancelled = true
    this.restoredAllowOnceBySession.delete(sessionId)
    const pendingRequests = Array.from(this.pendingRequests.values())

    for (const { request } of pendingRequests) {
      if (request.sessionId === sessionId) {
        void this.respond({ requestId: request.requestId, cancelled: true }).catch(() => undefined)
      }
    }
  }

  private trackSessionCancellation(sessionId: string): SessionCancellationToken {
    const token = { cancelled: false }
    const tokens = this.sessionCancellationTokens.get(sessionId) ?? new Set()
    tokens.add(token)
    this.sessionCancellationTokens.set(sessionId, tokens)
    return token
  }

  private releaseSessionCancellation(sessionId: string, token: SessionCancellationToken): void {
    const tokens = this.sessionCancellationTokens.get(sessionId)
    tokens?.delete(token)
    if (tokens?.size === 0) this.sessionCancellationTokens.delete(sessionId)
  }

  // Ends one Agent session: cancel its outstanding prompts and discard its non-persistent grants.
  clearSession(sessionId: string): void {
    this.cancelForSession(sessionId)
    this.livePermissionProfiles.delete(sessionId)
    this.conversationGrants.clear(sessionId)
  }
}

export {
  AcpPermissionBroker,
  ConversationPermissionGrantStore,
  projectRegistrySessionGrants,
  permissionRequestFingerprint,
  resolveCategoryKey,
  resolveNotebookPermissionContext
}
export type { DurablePermissionWaitCandidate, PermissionWaitHooks }
