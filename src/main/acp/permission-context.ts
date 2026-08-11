import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification
} from '@agentclientprotocol/sdk'

import type {
  AcpPermissionGrant,
  AcpPermissionRequest,
  AcpPermissionResponse,
  AcpPermissionSettlementState
} from '../../shared/acp'
import { DEFAULT_PERMISSION_PROFILE } from '../../shared/permission-profiles'
import type { SessionPermissionProfileState } from '../../shared/permission-profiles'
import type { AgentFrameworkId } from '../../shared/settings'
import { getAgentFramework, type AgentFramework } from '../agent-framework'
import type { PermissionGrantRegistry } from '../permission-grants/registry'
import type { SessionPermissionRuntimeContext } from '../../shared/session-persistence'
import { resolveCanonicalMcpToolIdentity } from '../agent-framework/app-mcp-names'
import { createLogger } from '../logger'
import {
  AcpPermissionBroker,
  ConversationPermissionGrantStore,
  resolveNotebookPermissionContext,
  type PermissionWaitHooks
} from './permission-broker'
import type { PermissionPolicyContext } from './permission-policy'
import {
  isMcpToolName,
  withTrustedMcpToolIdentity,
  withTrustedNativeToolIdentity
} from './permission-policy'
import { extractProviderToolName, toAcpRuntimeEvent } from './runtime-events'

const log = createLogger('acp')

type PermissionFramework = 'codex' | 'opencode' | 'claude-code' | string | undefined

type PermissionToolContext = {
  sessionId: string
  framework: PermissionFramework
  mcpServerNames: readonly string[]
}

type PermissionRestoreContext = PermissionToolContext & {
  isCancelled: () => boolean
}

type ToolCallSessionUpdate = Extract<
  SessionNotification['update'],
  { sessionUpdate: 'tool_call' | 'tool_call_update' }
>

type CodexMcpToolIdentity = {
  title: string
  providerToolName: string
  mcpIdentity: string
  rawInput?: unknown
}

type OpenCodeMcpToolInput = {
  title: string
  providerToolName: string
  mcpIdentity: string
  rawInput?: unknown
}

type ClaudeCodeMcpToolInput = {
  title: string
  providerToolName: string
  mcpIdentity: string
  rawInput?: Record<string, unknown>
}

type OpenCodePermissionContextWaitOutcome = 'ready' | 'timeout' | 'cancelled'
type OpenCodePermissionContextWaiter = (outcome: OpenCodePermissionContextWaitOutcome) => void

type AuthorizedPermissionActionOrigin = Readonly<{
  kind: 'human' | 'agent' | 'system'
}>

type AcpPermissionContextOptions = {
  emitPermissionRequest: (request: AcpPermissionRequest) => void
  routing: {
    resolveAppSessionId: (providerSessionId: string) => string
    sessionSnapshot: (sessionId: string) =>
      | {
          cwd?: string
          frameworkId?: AgentFrameworkId
          permissionProfile?: Readonly<
            Pick<SessionPermissionProfileState, 'selectedProfile' | 'autoReviewStrategy'>
          >
        }
      | undefined
    hasActivePrimarySession: (sessionId: string) => boolean
    capturePrompt: (sessionId: string) =>
      | {
          sequence: number
          promptMessageId?: string
          isCancellationAccepted: () => boolean
        }
      | undefined
    currentInteractionSequence: (sessionId: string) => number | undefined
    mcpServerNamesFor: (sessionId: string) => readonly string[]
    reviewerContextFor: (providerSessionId: string) =>
      | {
          frameworkId: AgentFrameworkId
          mcpServerNames: readonly string[]
        }
      | undefined
    resolveReviewerPermission: (
      request: RequestPermissionRequest
    ) => RequestPermissionResponse | undefined
    currentFramework: () => AgentFramework
    resolveProjectId: (sessionId: string) => string
  }
  conversationGrants?: ConversationPermissionGrantStore
  permissionGrantRegistry?: PermissionGrantRegistry
  permissionGrantContext?: Readonly<{ projectId: string; sessionId: string }>
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
  onOpenCodeWaitTimeout?: (details: {
    sessionId: string
    toolCallId: string
    waitMs: number
  }) => void
  onPermissionSettled?: (requestId: string, state: AcpPermissionSettlementState) => void
  permissionWaitHooks?: PermissionWaitHooks
}

type PermissionContextSessionSnapshot = {
  codexMcpIdentities: number
  claudeCodeMcpInputs: number
  opencodeMcpInputs: number
  opencodeNativeSkills: number
  opencodeClosedToolCalls: number
  pendingWaiters: number
}

type AcpPermissionContextSnapshot = {
  pendingRequests: Array<{
    requestId: string
    sessionId: string
    toolCallId: string
    requiredOrigin: 'human'
  }>
  sessions: Record<string, PermissionContextSessionSnapshot>
}

const AGENT_PERMISSION_ACTION_ORIGIN: AuthorizedPermissionActionOrigin = { kind: 'agent' }
const HUMAN_PERMISSION_ACTION_ORIGIN: AuthorizedPermissionActionOrigin = { kind: 'human' }
const SYSTEM_PERMISSION_ACTION_ORIGIN: AuthorizedPermissionActionOrigin = { kind: 'system' }

const MAX_CODEX_MCP_TOOL_IDENTITIES_PER_SESSION = 32
const MAX_CLAUDE_CODE_MCP_TOOL_INPUTS_PER_SESSION = 32
const MAX_OPENCODE_MCP_TOOL_INPUTS_PER_SESSION = 32
const MAX_PERMISSION_CODE_PREVIEW_CHARS = 7_500
const OPENCODE_PERMISSION_CONTEXT_WAIT_MS = 1_000

const errorMessage = (error: unknown): string => {
  try {
    const raw = error instanceof Error ? (error as { message?: unknown }).message : error
    return typeof raw === 'string' ? raw : String(raw)
  } catch {
    return 'unknown error'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isOpenCodeNativeSkillToolCall = (update: SessionNotification['update']): boolean => {
  if (update.sessionUpdate !== 'tool_call' || update.kind !== 'other') return false
  const providerToolName = extractProviderToolName(update)?.trim().toLowerCase()
  if (providerToolName !== undefined) return providerToolName === 'skill'

  const rawInput = isRecord(update.rawInput) ? update.rawInput : undefined
  return (
    update.title?.trim().toLowerCase() === 'skill' &&
    typeof rawInput?.name === 'string' &&
    rawInput.name.trim().length > 0
  )
}

const boundedNotebookPermissionInput = (
  title: string,
  rawInput: unknown,
  mcpServerNames: readonly string[]
): Record<string, unknown> | undefined => {
  const context = resolveNotebookPermissionContext(title, rawInput, mcpServerNames)
  if (!context) return undefined

  const outer = isRecord(rawInput) ? rawInput : {}
  const input = isRecord(outer.arguments) ? outer.arguments : outer
  const bounded: Record<string, unknown> = {}
  const hasExecutionInput = ['code', 'command', 'script'].some(
    (field) => typeof input[field] === 'string'
  )

  for (const field of ['kernelKind', 'kernel', 'language']) {
    if (typeof input[field] === 'string') bounded[field] = input[field]
  }
  if (
    context.runtime &&
    hasExecutionInput &&
    !bounded.kernelKind &&
    !bounded.kernel &&
    !bounded.language
  ) {
    bounded.language = context.runtime
  }

  for (const field of ['code', 'command', 'script']) {
    const value = input[field]
    if (typeof value !== 'string') continue

    bounded[field] = value.slice(0, MAX_PERMISSION_CODE_PREVIEW_CHARS)
    if (value.length > MAX_PERMISSION_CODE_PREVIEW_CHARS) bounded.inputTruncated = true
    break
  }

  return bounded
}

const isCodexMcpApproval = (params: RequestPermissionRequest): boolean => {
  const meta = (params as RequestPermissionRequest & { _meta?: unknown })._meta
  return isRecord(meta) && meta.is_mcp_tool_approval === true
}

const isCodexMcpToolCall = (
  update: SessionNotification['update']
): update is ToolCallSessionUpdate => {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update')
    return false
  const meta = (update as SessionNotification['update'] & { _meta?: unknown })._meta
  return isRecord(meta) && meta.is_mcp_tool_call === true
}

const codexMcpToolIdentity = (
  event: ReturnType<typeof toAcpRuntimeEvent>,
  rawInput: unknown,
  mcpServerNames: readonly string[]
): CodexMcpToolIdentity | undefined => {
  if (event.kind !== 'tool' || !isRecord(rawInput)) return undefined

  const server = rawInput.server
  const tool = rawInput.tool
  if (typeof server !== 'string' || typeof tool !== 'string' || !tool.trim()) return undefined

  const title = `mcp.${server}.${tool}`
  if (event.title !== title) return undefined
  const mcpIdentity = resolveCanonicalMcpToolIdentity(title, mcpServerNames)
  if (!mcpIdentity) return undefined
  // Runtime events intentionally omit oversized payloads. Keep correlation independent from that
  // projection while retaining at most the existing bounded execution preview for permission UI.
  const permissionInput = isRecord(event.rawInput)
    ? event.rawInput.arguments
    : boundedNotebookPermissionInput(title, rawInput, mcpServerNames)

  return {
    title,
    providerToolName: tool,
    mcpIdentity,
    ...(permissionInput === undefined ? {} : { rawInput: permissionInput })
  }
}

const countNested = <T>(contexts: Map<string, Map<string, T>>, sessionId: string): number =>
  contexts.get(sessionId)?.size ?? 0

// Owns provider permission routing, correlation, and pending decisions. Protocol messages never infer
// human authority; only the explicit response origin can release a human-owned decision.
class AcpPermissionContext {
  private readonly broker: AcpPermissionBroker
  private readonly humanOnlyRequestIds = new Set<string>()
  private readonly codexMcpToolIdentities = new Map<string, Map<string, CodexMcpToolIdentity>>()
  private readonly claudeCodeMcpToolInputs = new Map<string, Map<string, ClaudeCodeMcpToolInput>>()
  private readonly opencodeMcpToolInputs = new Map<string, Map<string, OpenCodeMcpToolInput>>()
  private readonly opencodeNativeSkillToolCalls = new Map<string, Map<string, true>>()
  private readonly opencodeMcpToolInputWaiters = new Map<
    string,
    Map<string, Set<OpenCodePermissionContextWaiter>>
  >()
  private readonly closedOpenCodeToolCalls = new Map<string, Set<string>>()
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void

  constructor(private readonly options: AcpPermissionContextOptions) {
    this.broker = new AcpPermissionBroker(
      (request) => {
        this.humanOnlyRequestIds.add(request.requestId)
        const sessionId = options.routing.resolveAppSessionId(request.sessionId)
        options.emitPermissionRequest(
          sessionId && sessionId !== request.sessionId ? { ...request, sessionId } : request
        )
      },
      options.conversationGrants,
      options.permissionGrantRegistry,
      options.onPermissionSettled,
      options.permissionWaitHooks
    )
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
  }

  async handleProviderRequest(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    const routing = this.options.routing

    const appSessionId = routing.resolveAppSessionId(params.sessionId)
    const reviewerContext = routing.reviewerContextFor(params.sessionId)
    const mcpServerNames =
      reviewerContext?.mcpServerNames ?? routing.mcpServerNamesFor(appSessionId)
    const promptInteraction = routing.capturePrompt(appSessionId)
    const promptTurn = promptInteraction?.sequence
    const aggregateSnapshot = routing.sessionSnapshot(appSessionId)
    const framework = reviewerContext?.frameworkId ?? aggregateSnapshot?.frameworkId
    const isCancelled = (): boolean =>
      framework === 'opencode' &&
      (promptTurn === undefined
        ? routing.hasActivePrimarySession(appSessionId)
        : routing.currentInteractionSequence(appSessionId) !== promptTurn ||
          promptInteraction?.isCancellationAccepted() === true)
    const restoreContext = {
      sessionId: appSessionId,
      framework,
      mcpServerNames,
      isCancelled
    }
    const normalizedParams = await this.restoreToolCall(params, restoreContext)
    if (
      !normalizedParams ||
      this.isPermissionRequestCancelled(params.toolCall.toolCallId, restoreContext)
    ) {
      return { outcome: { outcome: 'cancelled' } }
    }

    // Keep the audit record useful without logging titles, URLs, raw input, or provider payloads.
    const toolName = extractProviderToolName(normalizedParams.toolCall)
    const isMcp =
      isMcpToolName(normalizedParams.toolCall.title, mcpServerNames) ||
      isMcpToolName(toolName, mcpServerNames)
    log.info('permission request received', {
      tool:
        this.toolIdentityForDiagnostics(toolName, appSessionId) ?? normalizedParams.toolCall.kind,
      isMcp,
      toolCallId: normalizedParams.toolCall.toolCallId,
      sessionId: params.sessionId,
      optionCount: params.options.length
    })

    try {
      if (reviewerContext) {
        const response = routing.resolveReviewerPermission(normalizedParams)
        if (response) return response
        throw new Error(`Unknown ACP reviewer session: ${params.sessionId}`)
      }

      if (!routing.hasActivePrimarySession(appSessionId)) {
        throw new Error(`Unknown ACP session: ${appSessionId}`)
      }

      const profileState = aggregateSnapshot?.permissionProfile
      const currentFramework = routing.currentFramework()
      const frameworkId = aggregateSnapshot?.frameworkId ?? currentFramework.id
      const permissionFramework =
        frameworkId === currentFramework.id ? currentFramework : getAgentFramework(frameworkId)

      return await this.requestPermission(
        appSessionId === normalizedParams.sessionId
          ? normalizedParams
          : { ...normalizedParams, sessionId: appSessionId },
        {
          profile: profileState?.selectedProfile ?? DEFAULT_PERMISSION_PROFILE,
          frameworkId,
          shellDialect: permissionFramework.commandShellDialect,
          autoReviewStrategy: profileState?.autoReviewStrategy,
          cwd: aggregateSnapshot?.cwd,
          mcpServerNames,
          projectId:
            this.options.permissionGrantContext?.projectId ??
            routing.resolveProjectId(appSessionId),
          permissionGrantSessionId: this.options.permissionGrantContext?.sessionId,
          promptMessageId: promptInteraction?.promptMessageId
        }
      )
    } catch (error) {
      log.error('permission request failed', {
        message: errorMessage(error),
        tool:
          this.toolIdentityForDiagnostics(
            extractProviderToolName(normalizedParams.toolCall),
            appSessionId
          ) ?? normalizedParams.toolCall.kind,
        toolCallId: params.toolCall.toolCallId,
        sessionId: params.sessionId
      })
      throw error
    }
  }

  observeProviderUpdate(notification: SessionNotification): void {
    const routing = this.options.routing

    const sessionId = routing.resolveAppSessionId(notification.sessionId)
    const reviewerContext = routing.reviewerContextFor(notification.sessionId)
    const routed = structuredClone(notification)
    routed.sessionId = sessionId
    this.observeToolCall(routed, {
      sessionId,
      framework: reviewerContext?.frameworkId ?? routing.sessionSnapshot(sessionId)?.frameworkId,
      mcpServerNames: reviewerContext?.mcpServerNames ?? routing.mcpServerNamesFor(sessionId)
    })
  }

  getPendingRequests(): AcpPermissionRequest[] {
    return this.broker.getPendingRequests()
  }

  hasDurablePendingForSession(sessionId: string): boolean {
    return this.broker.hasDurablePendingForSession(sessionId)
  }

  prepareRestoredDecision(
    permission: SessionPermissionRuntimeContext,
    option: AcpPermissionRequest['options'][number] | undefined,
    projectId: string
  ): Promise<void> {
    return this.broker.prepareRestoredDecision(permission, option, projectId)
  }

  clearRestoredDecision(sessionId: string): void {
    this.broker.clearRestoredDecision(sessionId)
  }

  async applyPermissionProfile(
    sessionId: string,
    profile: Readonly<SessionPermissionProfileState>,
    isCurrent: () => boolean
  ): Promise<void> {
    const resolvedRequestIds = await this.broker.applyPermissionProfile(
      sessionId,
      profile,
      isCurrent
    )
    for (const requestId of resolvedRequestIds) this.humanOnlyRequestIds.delete(requestId)
  }

  setLivePermissionProfile(
    sessionId: string,
    profile: Readonly<SessionPermissionProfileState>,
    isCurrent: () => boolean = () => true
  ): void {
    this.broker.setLivePermissionProfile(sessionId, profile, isCurrent)
  }

  beginPermissionProfileTransition(
    sessionId: string,
    profile: Readonly<SessionPermissionProfileState>,
    isCurrent: () => boolean
  ): void {
    this.broker.beginPermissionProfileTransition(sessionId, profile, isCurrent)
  }

  setProviderPermissionProfile(
    sessionId: string,
    profile: Readonly<SessionPermissionProfileState>
  ): boolean {
    return this.broker.setProviderPermissionProfile(sessionId, profile)
  }

  clearLivePermissionProfile(sessionId: string): void {
    this.broker.clearLivePermissionProfile(sessionId)
  }

  listGrants(sessionId: string): AcpPermissionGrant[] {
    return this.broker.listGrants(sessionId)
  }

  revokeGrant(sessionId: string, categoryKey: string): Promise<void> {
    return this.broker.revokeGrant(sessionId, categoryKey)
  }

  requestPermission(
    params: RequestPermissionRequest,
    policyContext?: PermissionPolicyContext
  ): Promise<RequestPermissionResponse> {
    return this.broker.requestPermission(params, policyContext)
  }

  requestAppApproval(input: {
    sessionId: string
    title: string
    rawInput: unknown
  }): Promise<boolean> {
    return this.broker.requestAppApproval(input)
  }

  respondToPermission(
    response: AcpPermissionResponse,
    origin: AuthorizedPermissionActionOrigin
  ): Promise<boolean> {
    if (this.humanOnlyRequestIds.has(response.requestId) && origin.kind === 'agent') {
      return Promise.resolve(false)
    }

    return this.broker.respond(response).finally(() => {
      if (!this.getPendingRequests().some((request) => request.requestId === response.requestId)) {
        this.humanOnlyRequestIds.delete(response.requestId)
      }
    })
  }

  observeToolCall(notification: SessionNotification, context: PermissionToolContext): void {
    const { sessionId, framework, mcpServerNames } = context
    if (framework !== 'codex' && framework !== 'opencode' && framework !== 'claude-code') return

    const routed =
      sessionId === notification.sessionId ? notification : { ...notification, sessionId }
    const event = toAcpRuntimeEvent(routed, 'permission-tool-context')
    if (event.kind !== 'tool' || !event.toolCallId) return

    if (event.status === 'completed' || event.status === 'failed') {
      this.deleteToolCall(sessionId, event.toolCallId, framework)
      return
    }

    if (framework === 'codex') {
      if (!isCodexMcpToolCall(notification.update)) return
      const identity = codexMcpToolIdentity(event, notification.update.rawInput, mcpServerNames)
      if (!identity) return

      const identities = this.codexMcpToolIdentities.get(sessionId) ?? new Map()
      this.setBounded(
        identities,
        event.toolCallId,
        identity,
        MAX_CODEX_MCP_TOOL_IDENTITIES_PER_SESSION
      )
      this.codexMcpToolIdentities.set(sessionId, identities)
      return
    }

    if (framework === 'claude-code') {
      const title = event.title
      if (!title || !isMcpToolName(title, mcpServerNames)) return
      const providerToolName = event.providerToolName ?? title
      const mcpIdentity =
        resolveCanonicalMcpToolIdentity(providerToolName, mcpServerNames) ??
        resolveCanonicalMcpToolIdentity(title, mcpServerNames)
      if (!mcpIdentity) return

      const inputs = this.claudeCodeMcpToolInputs.get(sessionId) ?? new Map()
      this.setBounded(
        inputs,
        event.toolCallId,
        {
          title,
          providerToolName,
          mcpIdentity,
          ...(isRecord(event.rawInput) ? { rawInput: event.rawInput } : {})
        },
        MAX_CLAUDE_CODE_MCP_TOOL_INPUTS_PER_SESSION
      )
      this.claudeCodeMcpToolInputs.set(sessionId, inputs)
      return
    }

    const update = notification.update
    if (update.sessionUpdate === 'tool_call') {
      const closedToolCalls = this.closedOpenCodeToolCalls.get(sessionId)
      closedToolCalls?.delete(event.toolCallId)
      if (closedToolCalls?.size === 0) this.closedOpenCodeToolCalls.delete(sessionId)
    }
    if (isOpenCodeNativeSkillToolCall(update)) {
      const calls = this.opencodeNativeSkillToolCalls.get(sessionId) ?? new Map<string, true>()
      this.setBounded(calls, event.toolCallId, true, MAX_OPENCODE_MCP_TOOL_INPUTS_PER_SESSION)
      this.opencodeNativeSkillToolCalls.set(sessionId, calls)
      this.resolveOpenCodeWaiters(sessionId, event.toolCallId)
      return
    }

    const originalRawInput =
      update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update'
        ? update.rawInput
        : undefined
    const inputs = this.opencodeMcpToolInputs.get(sessionId) ?? new Map()
    const previous = inputs.get(event.toolCallId)
    const title = event.title ?? previous?.title
    if (!title || !isMcpToolName(title, mcpServerNames)) return
    const canReusePreviousIdentity = event.title == null || event.title === previous?.title
    const providerToolName =
      event.providerToolName ??
      (canReusePreviousIdentity ? previous?.providerToolName : undefined) ??
      title
    const mcpIdentity =
      resolveCanonicalMcpToolIdentity(providerToolName, mcpServerNames) ??
      resolveCanonicalMcpToolIdentity(title, mcpServerNames) ??
      (canReusePreviousIdentity ? previous?.mcpIdentity : undefined)
    if (!mcpIdentity) return

    const rawInput =
      boundedNotebookPermissionInput(title, originalRawInput, mcpServerNames) ?? event.rawInput
    const hasRawInput = isRecord(rawInput) && Object.keys(rawInput).length > 0
    const next: OpenCodeMcpToolInput = {
      title,
      providerToolName,
      mcpIdentity,
      ...(hasRawInput
        ? { rawInput }
        : canReusePreviousIdentity && previous?.rawInput !== undefined
          ? { rawInput: previous.rawInput }
          : {})
    }

    this.setBounded(inputs, event.toolCallId, next, MAX_OPENCODE_MCP_TOOL_INPUTS_PER_SESSION)
    this.opencodeMcpToolInputs.set(sessionId, inputs)
    if (hasRawInput) this.resolveOpenCodeWaiters(sessionId, event.toolCallId)
  }

  async restoreToolCall(
    params: RequestPermissionRequest,
    context: PermissionRestoreContext
  ): Promise<RequestPermissionRequest | undefined> {
    const { sessionId, framework, mcpServerNames } = context
    if (framework === 'claude-code') {
      return this.restoreClaudeCodeMcpToolInput(params, sessionId, mcpServerNames)
    }
    if (framework === 'opencode') {
      if (this.isOpenCodeRequestCancelled(sessionId, params.toolCall.toolCallId, context)) {
        return undefined
      }
      const trustedNativeSkill = this.restoreOpenCodeNativeSkillPermission(params, sessionId)
      if (trustedNativeSkill !== params) return trustedNativeSkill

      const restored = this.restoreOpenCodeMcpToolInput(params, sessionId, mcpServerNames)
      const isMcpRequest = isMcpToolName(params.toolCall.title, mcpServerNames)
      const isNativeSkillCandidate =
        params.toolCall.kind === 'other' && params.toolCall.title?.trim().toLowerCase() === 'skill'
      if (!isMcpRequest && !isNativeSkillCandidate) return restored
      if (
        isMcpRequest &&
        isRecord(restored.toolCall.rawInput) &&
        Object.keys(restored.toolCall.rawInput).length > 0
      ) {
        return restored
      }

      const outcome = await this.waitForOpenCodeMcpToolInput(
        sessionId,
        params.toolCall.toolCallId,
        context
      )
      if (outcome === 'cancelled') return undefined
      if (outcome === 'timeout') {
        this.options.onOpenCodeWaitTimeout?.({
          sessionId,
          toolCallId: params.toolCall.toolCallId,
          waitMs: OPENCODE_PERMISSION_CONTEXT_WAIT_MS
        })
      }
      const restoredNativeSkill = this.restoreOpenCodeNativeSkillPermission(params, sessionId)
      if (restoredNativeSkill !== params) return restoredNativeSkill
      const finalRequest = this.restoreOpenCodeMcpToolInput(params, sessionId, mcpServerNames)
      if (outcome === 'timeout') this.forgetToolCall(sessionId, params.toolCall.toolCallId)
      return finalRequest
    }
    if (framework !== 'codex' || !isCodexMcpApproval(params)) return params

    const identities = this.codexMcpToolIdentities.get(sessionId)
    const identity = identities?.get(params.toolCall.toolCallId)
    if (!identity || !isMcpToolName(identity.title, mcpServerNames)) return params

    identities?.delete(params.toolCall.toolCallId)
    if (identities?.size === 0) this.codexMcpToolIdentities.delete(sessionId)
    const toolMeta = isRecord(params.toolCall._meta) ? params.toolCall._meta : {}

    return withTrustedMcpToolIdentity(
      {
        ...params,
        toolCall: {
          ...params.toolCall,
          title: params.toolCall.title ?? identity.title,
          rawInput: params.toolCall.rawInput ?? identity.rawInput,
          _meta: { ...toolMeta, toolName: identity.providerToolName }
        }
      },
      identity.mcpIdentity
    )
  }

  isPermissionRequestCancelled(toolCallId: string, context: PermissionRestoreContext): boolean {
    return (
      context.framework === 'opencode' &&
      this.isOpenCodeRequestCancelled(context.sessionId, toolCallId, context)
    )
  }

  consumeTrustedCodexMcpToolCall(
    sessionId: string,
    toolCallId: string,
    mcpIdentity: string
  ): boolean {
    const identities = this.codexMcpToolIdentities.get(sessionId)
    if (identities?.get(toolCallId)?.mcpIdentity !== mcpIdentity) return false

    identities.delete(toolCallId)
    if (identities.size === 0) this.codexMcpToolIdentities.delete(sessionId)
    return true
  }

  hasTrustedCodexMcpToolCall(sessionId: string, toolCallId: string): boolean {
    return this.codexMcpToolIdentities.get(sessionId)?.has(toolCallId) ?? false
  }

  cancelAllPending(): void {
    this.broker.cancelAllPending()
    this.humanOnlyRequestIds.clear()
  }

  cancelForSession(sessionId: string): void {
    for (const request of this.getPendingRequests()) {
      if (request.sessionId === sessionId) this.humanOnlyRequestIds.delete(request.requestId)
    }
    this.broker.cancelForSession(sessionId)
    this.clearCorrelationsForSession(sessionId)
  }

  clearSession(sessionId: string): void {
    for (const request of this.getPendingRequests()) {
      if (request.sessionId === sessionId) this.humanOnlyRequestIds.delete(request.requestId)
    }
    this.broker.clearSession(sessionId)
    this.clearCorrelationsForSession(sessionId)
  }

  clearCorrelationsForSession(sessionId: string): void {
    this.codexMcpToolIdentities.delete(sessionId)
    this.claudeCodeMcpToolInputs.delete(sessionId)
    this.opencodeMcpToolInputs.delete(sessionId)
    this.opencodeNativeSkillToolCalls.delete(sessionId)
    this.closedOpenCodeToolCalls.delete(sessionId)
    const sessionWaiters = this.opencodeMcpToolInputWaiters.get(sessionId)
    if (!sessionWaiters) return

    for (const waiters of Array.from(sessionWaiters.values())) {
      for (const finish of Array.from(waiters)) finish('cancelled')
    }
  }

  dispose(): void {
    this.broker.abandonAllPending()
    this.humanOnlyRequestIds.clear()
    const sessionIds = new Set([
      ...this.codexMcpToolIdentities.keys(),
      ...this.claudeCodeMcpToolInputs.keys(),
      ...this.opencodeMcpToolInputs.keys(),
      ...this.opencodeNativeSkillToolCalls.keys(),
      ...this.closedOpenCodeToolCalls.keys(),
      ...this.opencodeMcpToolInputWaiters.keys()
    ])
    for (const sessionId of sessionIds) this.clearCorrelationsForSession(sessionId)
  }

  snapshot(): AcpPermissionContextSnapshot {
    const pendingRequests = this.getPendingRequests().map((request) => ({
      requestId: request.requestId,
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      requiredOrigin: 'human' as const
    }))
    const sessionIds = new Set([
      ...this.codexMcpToolIdentities.keys(),
      ...this.claudeCodeMcpToolInputs.keys(),
      ...this.opencodeMcpToolInputs.keys(),
      ...this.opencodeNativeSkillToolCalls.keys(),
      ...this.closedOpenCodeToolCalls.keys(),
      ...this.opencodeMcpToolInputWaiters.keys()
    ])
    const sessions: Record<string, PermissionContextSessionSnapshot> = {}
    for (const sessionId of sessionIds) {
      sessions[sessionId] = {
        codexMcpIdentities: countNested(this.codexMcpToolIdentities, sessionId),
        claudeCodeMcpInputs: countNested(this.claudeCodeMcpToolInputs, sessionId),
        opencodeMcpInputs: countNested(this.opencodeMcpToolInputs, sessionId),
        opencodeNativeSkills: countNested(this.opencodeNativeSkillToolCalls, sessionId),
        opencodeClosedToolCalls: this.closedOpenCodeToolCalls.get(sessionId)?.size ?? 0,
        pendingWaiters: Array.from(
          this.opencodeMcpToolInputWaiters.get(sessionId)?.values() ?? []
        ).reduce((total, waiters) => total + waiters.size, 0)
      }
    }
    return { pendingRequests, sessions }
  }

  private restoreClaudeCodeMcpToolInput(
    params: RequestPermissionRequest,
    sessionId: string,
    mcpServerNames: readonly string[]
  ): RequestPermissionRequest {
    const title = params.toolCall.title
    if (!isMcpToolName(title, mcpServerNames)) return params

    const inputs = this.claudeCodeMcpToolInputs.get(sessionId)
    const input = inputs?.get(params.toolCall.toolCallId)
    if (!input || input.title !== title) return params

    inputs?.delete(params.toolCall.toolCallId)
    if (inputs?.size === 0) this.claudeCodeMcpToolInputs.delete(sessionId)

    return withTrustedMcpToolIdentity(
      {
        ...params,
        toolCall: {
          ...params.toolCall,
          rawInput: params.toolCall.rawInput ?? input.rawInput,
          _meta: {
            ...(isRecord(params.toolCall._meta) ? params.toolCall._meta : {}),
            toolName: input.providerToolName
          }
        }
      },
      input.mcpIdentity
    )
  }

  private restoreOpenCodeMcpToolInput(
    params: RequestPermissionRequest,
    sessionId: string,
    mcpServerNames: readonly string[]
  ): RequestPermissionRequest {
    const title = params.toolCall.title
    if (!isMcpToolName(title, mcpServerNames)) return params

    const inputs = this.opencodeMcpToolInputs.get(sessionId)
    const input = inputs?.get(params.toolCall.toolCallId)
    if (!input || input.title !== title) return params

    const requestHasInput =
      isRecord(params.toolCall.rawInput) && Object.keys(params.toolCall.rawInput).length > 0
    const cachedHasInput = isRecord(input.rawInput) && Object.keys(input.rawInput).length > 0
    if (requestHasInput || cachedHasInput) {
      inputs?.delete(params.toolCall.toolCallId)
      if (inputs?.size === 0) this.opencodeMcpToolInputs.delete(sessionId)
    }

    return withTrustedMcpToolIdentity(
      {
        ...params,
        toolCall: {
          ...params.toolCall,
          rawInput: requestHasInput ? params.toolCall.rawInput : input.rawInput,
          _meta: {
            ...(isRecord(params.toolCall._meta) ? params.toolCall._meta : {}),
            toolName: input.providerToolName
          }
        }
      },
      input.mcpIdentity
    )
  }

  private restoreOpenCodeNativeSkillPermission(
    params: RequestPermissionRequest,
    sessionId: string
  ): RequestPermissionRequest {
    const calls = this.opencodeNativeSkillToolCalls.get(sessionId)
    if (!calls?.delete(params.toolCall.toolCallId)) return params
    if (calls.size === 0) this.opencodeNativeSkillToolCalls.delete(sessionId)

    const providerToolName = extractProviderToolName(params.toolCall)?.trim().toLowerCase()
    if (
      params.toolCall.kind !== 'other' ||
      params.toolCall.title?.trim().toLowerCase() !== 'skill' ||
      (providerToolName != null && providerToolName !== 'skill')
    ) {
      return params
    }
    return withTrustedNativeToolIdentity(params, 'opencode/skill')
  }

  private waitForOpenCodeMcpToolInput(
    sessionId: string,
    toolCallId: string,
    context: PermissionRestoreContext
  ): Promise<OpenCodePermissionContextWaitOutcome> {
    if (this.isOpenCodeRequestCancelled(sessionId, toolCallId, context)) {
      return Promise.resolve('cancelled')
    }
    if (this.opencodeNativeSkillToolCalls.get(sessionId)?.has(toolCallId)) {
      return Promise.resolve('ready')
    }
    const rawInput = this.opencodeMcpToolInputs.get(sessionId)?.get(toolCallId)?.rawInput
    if (isRecord(rawInput) && Object.keys(rawInput).length > 0) return Promise.resolve('ready')

    return new Promise((resolve) => {
      const sessionWaiters = this.opencodeMcpToolInputWaiters.get(sessionId) ?? new Map()
      const callWaiters =
        sessionWaiters.get(toolCallId) ?? new Set<OpenCodePermissionContextWaiter>()
      const timer: { handle?: ReturnType<typeof setTimeout> } = {}
      let finished = false
      const finish = (outcome: OpenCodePermissionContextWaitOutcome): void => {
        if (finished) return
        finished = true
        if (timer.handle) this.clearTimer(timer.handle)
        callWaiters.delete(finish)
        if (callWaiters.size === 0) sessionWaiters.delete(toolCallId)
        if (sessionWaiters.size === 0) this.opencodeMcpToolInputWaiters.delete(sessionId)
        resolve(outcome)
      }

      callWaiters.add(finish)
      sessionWaiters.set(toolCallId, callWaiters)
      this.opencodeMcpToolInputWaiters.set(sessionId, sessionWaiters)
      timer.handle = this.setTimer(() => finish('timeout'), OPENCODE_PERMISSION_CONTEXT_WAIT_MS)

      if (this.isOpenCodeRequestCancelled(sessionId, toolCallId, context)) {
        finish('cancelled')
        return
      }
      if (this.opencodeNativeSkillToolCalls.get(sessionId)?.has(toolCallId)) {
        finish('ready')
        return
      }
      const latestRawInput = this.opencodeMcpToolInputs.get(sessionId)?.get(toolCallId)?.rawInput
      if (isRecord(latestRawInput) && Object.keys(latestRawInput).length > 0) finish('ready')
    })
  }

  private isOpenCodeRequestCancelled(
    sessionId: string,
    toolCallId: string,
    context: PermissionRestoreContext
  ): boolean {
    return (
      this.closedOpenCodeToolCalls.get(sessionId)?.has(toolCallId) === true || context.isCancelled()
    )
  }

  private resolveOpenCodeWaiters(
    sessionId: string,
    toolCallId: string,
    outcome: OpenCodePermissionContextWaitOutcome = 'ready'
  ): void {
    const waiters = this.opencodeMcpToolInputWaiters.get(sessionId)?.get(toolCallId)
    if (!waiters) return
    for (const finish of Array.from(waiters)) finish(outcome)
  }

  private setBounded<T>(
    contexts: Map<string, T>,
    toolCallId: string,
    context: T,
    limit: number
  ): void {
    if (!contexts.has(toolCallId) && contexts.size >= limit) {
      const oldestToolCallId = contexts.keys().next().value
      if (oldestToolCallId) contexts.delete(oldestToolCallId)
    }
    contexts.set(toolCallId, context)
  }

  private addBounded(contexts: Set<string>, toolCallId: string, limit: number): void {
    if (!contexts.has(toolCallId) && contexts.size >= limit) {
      const oldestToolCallId = contexts.values().next().value
      if (oldestToolCallId) contexts.delete(oldestToolCallId)
    }
    contexts.add(toolCallId)
  }

  private deleteToolCall(
    sessionId: string,
    toolCallId: string,
    framework: PermissionFramework
  ): void {
    const codexIdentities = this.codexMcpToolIdentities.get(sessionId)
    codexIdentities?.delete(toolCallId)
    if (codexIdentities?.size === 0) this.codexMcpToolIdentities.delete(sessionId)

    const claudeCodeInputs = this.claudeCodeMcpToolInputs.get(sessionId)
    claudeCodeInputs?.delete(toolCallId)
    if (claudeCodeInputs?.size === 0) this.claudeCodeMcpToolInputs.delete(sessionId)

    const opencodeInputs = this.opencodeMcpToolInputs.get(sessionId)
    opencodeInputs?.delete(toolCallId)
    if (opencodeInputs?.size === 0) this.opencodeMcpToolInputs.delete(sessionId)
    const opencodeNativeSkills = this.opencodeNativeSkillToolCalls.get(sessionId)
    opencodeNativeSkills?.delete(toolCallId)
    if (opencodeNativeSkills?.size === 0) this.opencodeNativeSkillToolCalls.delete(sessionId)
    if (framework === 'opencode') {
      const closedToolCalls = this.closedOpenCodeToolCalls.get(sessionId) ?? new Set<string>()
      this.addBounded(closedToolCalls, toolCallId, MAX_OPENCODE_MCP_TOOL_INPUTS_PER_SESSION)
      this.closedOpenCodeToolCalls.set(sessionId, closedToolCalls)
    }
    this.resolveOpenCodeWaiters(sessionId, toolCallId, 'cancelled')
  }

  private forgetToolCall(sessionId: string, toolCallId: string): void {
    const contexts = [
      this.codexMcpToolIdentities,
      this.claudeCodeMcpToolInputs,
      this.opencodeMcpToolInputs,
      this.opencodeNativeSkillToolCalls
    ] as const
    for (const sessions of contexts) {
      const calls = sessions.get(sessionId)
      calls?.delete(toolCallId)
      if (calls?.size === 0) sessions.delete(sessionId)
    }
    this.resolveOpenCodeWaiters(sessionId, toolCallId, 'cancelled')
  }

  private toolIdentityForDiagnostics(
    providerToolName: string | undefined,
    sessionId: string
  ): string | undefined {
    if (!providerToolName) return undefined
    const mcpServerNames = this.options.routing.mcpServerNamesFor(sessionId)
    return resolveCanonicalMcpToolIdentity(providerToolName, mcpServerNames) ?? providerToolName
  }
}

export {
  AcpPermissionContext,
  AGENT_PERMISSION_ACTION_ORIGIN,
  HUMAN_PERMISSION_ACTION_ORIGIN,
  SYSTEM_PERMISSION_ACTION_ORIGIN
}
export type {
  AcpPermissionContextOptions,
  AcpPermissionContextSnapshot,
  AuthorizedPermissionActionOrigin,
  PermissionRestoreContext,
  PermissionToolContext
}
