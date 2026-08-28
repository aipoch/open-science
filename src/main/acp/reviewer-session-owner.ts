import * as acp from '@agentclientprotocol/sdk'
import type {
  ActiveSession,
  ClientConnection,
  McpServer,
  RequestPermissionRequest,
  RequestPermissionResponse
} from '@agentclientprotocol/sdk'
import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { REVIEWER_MCP_SERVER_NAME, REVIEWER_MCP_TOOLS } from '../../shared/reviewer'
import type { AgentFrameworkId } from '../../shared/settings'
import type { AgentFramework } from '../agent-framework'
import { createLogger, diagnosticErrorFields } from '../logger'
import { canonicalAppMcpServerName } from '../agent-framework/app-mcp-names'
import { extractProviderToolName } from './runtime-events'
import { REVIEWER_MCP_PROXY_ARG } from '../mcp-server-args'

const log = createLogger('acp')

const REVIEWER_SESSION_ROLE = 'reviewer' as const

const REVIEWER_MCP_OPENCODE_TOOL_NAMES = new Set(
  Object.values(REVIEWER_MCP_TOOLS).map((toolName) => `${REVIEWER_MCP_SERVER_NAME}_${toolName}`)
)
const REVIEWER_MCP_LEAF_TOOL_NAMES = new Set<string>(Object.values(REVIEWER_MCP_TOOLS))
const REVIEWER_MCP_SERVER_NAME_SANITIZED = REVIEWER_MCP_SERVER_NAME.replace(/[^a-zA-Z0-9]/g, '_')
const REVIEWER_MCP_CLAUDE_TOOL_NAMES = new Set(
  Object.values(REVIEWER_MCP_TOOLS).flatMap((toolName) =>
    [REVIEWER_MCP_SERVER_NAME, REVIEWER_MCP_SERVER_NAME_SANITIZED].map(
      (serverName) => `mcp__${serverName}__${toolName}`
    )
  )
)
const REVIEWER_MCP_PROVIDER_TOOL_NAMES = new Set([
  ...REVIEWER_MCP_OPENCODE_TOOL_NAMES,
  ...REVIEWER_MCP_CLAUDE_TOOL_NAMES
])

const errorMessage = (error: unknown): string => {
  try {
    const raw = error instanceof Error ? (error as { message?: unknown }).message : error
    return typeof raw === 'string' ? raw : String(raw)
  } catch {
    return 'unknown error'
  }
}

const safeLogError = (message: string, data?: unknown): void => {
  try {
    log.error(message, data)
  } catch {
    /* logging must never mask the real error */
  }
}

const safeLogWarn = (message: string, data?: unknown): void => {
  try {
    log.warn(message, data)
  } catch {
    /* logging must never interrupt lifecycle cleanup */
  }
}

export type ReviewerSessionRole = typeof REVIEWER_SESSION_ROLE

export type ReviewerSessionRequest = {
  cwd: string
  mcpServers: McpServer[]
  systemPromptAppend?: string
}

export type ReviewerSessionResult = {
  session: ActiveSession
  cwd: string
  promptPrefix?: string
  role: ReviewerSessionRole
}

export type ReviewerSessionDisposition = {
  rejectedToolCalls: number
  // Undefined for frameworks/providers that do not traverse the Responses bridge.
  reviewerBridgeScoped: boolean | undefined
}

export type ReviewerSessionSnapshot = {
  lifecycle: 'pending' | 'active'
  role: ReviewerSessionRole
  sessionId: string
}

export type ReviewerSessionContext = {
  frameworkId: AgentFrameworkId
  mcpServerNames: readonly string[]
  role: ReviewerSessionRole
}

type ReviewerSessionIdentityReservation = {
  generation: number
  sessionId: string
  token: symbol
}

type ReviewerSessionIdentityReservationResult =
  | { reservation: ReviewerSessionIdentityReservation; collision?: never }
  | { reservation?: never; collision: Error }

type ActiveReviewerSessionOwner = ReviewerSessionContext & {
  cwd: string
  session: ActiveSession
  sessionId: string
  token: symbol
}

export type ReviewerSessionOwnerDependencies = {
  addStartupBlocker: (token: symbol) => void
  assertCurrentConnection: (connection: ClientConnection) => void
  clearPermissionCorrelations: (sessionId: string) => void
  currentSessionSetup: () => {
    framework: AgentFramework
    sessionOptions: Record<string, unknown> | undefined
  }
  currentStartupGeneration: () => number
  isPrimarySessionIdClaimed: (sessionId: string) => boolean
  onActiveSessionReleased: () => void
  registerBridgeSession: (sessionId: string) => void
  removeStartupBlocker: (token: symbol) => void
  unregisterBridgeSession: (sessionId: string) => boolean | undefined
}

export type ReviewerSessionCreateCapability = Readonly<{
  ensureConnected: (cwd: string) => Promise<ClientConnection>
}>

// Owns every ephemeral Reviewer startup, identity, and resource. Runtime supplies only current
// connection/setup facts plus narrow collision, bridge, cleanup, and startup-blocker ports.
export class ReviewerSessionOwner {
  private readonly activeById = new Map<string, ActiveReviewerSessionOwner>()
  private readonly activeBySession = new WeakMap<ActiveSession, ActiveReviewerSessionOwner>()
  private readonly pendingIds = new Map<string, symbol>()
  private readonly rejectedToolCalls = new Map<string, number>()

  constructor(private readonly dependencies: ReviewerSessionOwnerDependencies) {}

  async create(
    request: ReviewerSessionRequest,
    capability: ReviewerSessionCreateCapability
  ): Promise<ReviewerSessionResult> {
    const mcpServerNames = this.validateRequest(request)
    const connection = await capability.ensureConnected(request.cwd)
    this.dependencies.assertCurrentConnection(connection)
    const { framework, sessionOptions } = this.dependencies.currentSessionSetup()
    const startupGeneration = this.dependencies.currentStartupGeneration()
    const reviewerCwd = await mkdtemp(join(tmpdir(), 'open-science-reviewer-'))
    const setup = framework.buildSessionSetup({
      systemPromptAppends: request.systemPromptAppend ? [request.systemPromptAppend] : [],
      sessionOptions
    })
    const reviewerMeta: Record<string, unknown> = {
      ...(setup.meta ?? {}),
      // claude-agent-acp honors this legacy switch. Codex is independently restricted by the
      // Responses bridge and the strict permission decision below.
      disableBuiltInTools: true
    }
    if (framework.id === 'claude-code') {
      const claudeCode =
        typeof reviewerMeta.claudeCode === 'object' && reviewerMeta.claudeCode !== null
          ? (reviewerMeta.claudeCode as Record<string, unknown>)
          : {}
      const claudeOptions =
        typeof claudeCode.options === 'object' && claudeCode.options !== null
          ? (claudeCode.options as Record<string, unknown>)
          : {}
      reviewerMeta.claudeCode = {
        ...claudeCode,
        options: { ...claudeOptions, tools: [] }
      }
    }

    try {
      const session = await connection.agent
        .buildSession({
          cwd: reviewerCwd,
          mcpServers: request.mcpServers,
          _meta: reviewerMeta
        })
        .start()
      const reservationResult = this.reserveIdentity(session.sessionId, startupGeneration)
      if (reservationResult.collision) {
        this.disposeSessionAfterFailure(session, 'reviewer collision session disposal failed')
        throw reservationResult.collision
      }
      const reservation = reservationResult.reservation
      let identityActivated = false

      try {
        const permission = framework.mapPermissionProfile('ask', session.modes)
        if (permission.modeId && permission.modeId !== session.modes?.currentModeId) {
          await connection.agent.request(acp.methods.agent.session.setMode, {
            sessionId: session.sessionId,
            modeId: permission.modeId
          })
        }

        this.activateIdentity(reservation, session, reviewerCwd, framework.id, mcpServerNames)
        identityActivated = true
        this.dependencies.registerBridgeSession(session.sessionId)

        return {
          session,
          cwd: reviewerCwd,
          promptPrefix: setup.promptPrefix,
          role: REVIEWER_SESSION_ROLE
        }
      } catch (error) {
        let startupError = error
        if (!identityActivated) {
          try {
            this.assertIdentityReservation(reservation)
          } catch (supersededError) {
            startupError = supersededError
          }
        }
        this.releaseIdentityReservation(reservation)
        const activeOwner = this.activeById.get(session.sessionId)
        if (identityActivated && activeOwner?.session === session) {
          this.activeById.delete(session.sessionId)
          this.activeBySession.delete(session)
          this.rejectedToolCalls.delete(session.sessionId)
          try {
            this.dependencies.unregisterBridgeSession(session.sessionId)
          } catch (cleanupError) {
            safeLogError('reviewer bridge registration rollback failed', {
              ...diagnosticErrorFields(cleanupError),
              sessionId: session.sessionId
            })
          }
        }
        this.disposeSessionAfterFailure(session, 'reviewer startup session disposal failed')
        throw startupError
      }
    } catch (error) {
      this.removeDirectory(reviewerCwd)
      throw error
    }
  }

  contextFor(sessionId: string): ReviewerSessionContext | undefined {
    const owner = this.activeById.get(sessionId)
    if (!owner) return undefined
    return {
      frameworkId: owner.frameworkId,
      mcpServerNames: owner.mcpServerNames,
      role: owner.role
    }
  }

  snapshot(): ReviewerSessionSnapshot[] {
    const active = [...this.activeById.keys()].map((sessionId): ReviewerSessionSnapshot => ({
      lifecycle: 'active',
      role: REVIEWER_SESSION_ROLE,
      sessionId
    }))
    const pending = [...this.pendingIds.keys()]
      .filter((sessionId) => !this.activeById.has(sessionId))
      .map((sessionId): ReviewerSessionSnapshot => ({
        lifecycle: 'pending',
        role: REVIEWER_SESSION_ROLE,
        sessionId
      }))
    return [...active, ...pending]
  }

  hasActiveSessions(): boolean {
    return this.activeById.size > 0
  }

  hasActiveSessionId(sessionId: string): boolean {
    return this.activeById.has(sessionId)
  }

  hasPendingSessionId(sessionId: string): boolean {
    return this.pendingIds.has(sessionId)
  }

  resolvePermission(params: RequestPermissionRequest): RequestPermissionResponse | undefined {
    const context = this.contextFor(params.sessionId)
    if (!context) return undefined
    const toolName = extractProviderToolName(params.toolCall)
    const reportedTitle = params.toolCall.title
    const opencodeToolName =
      toolName == null &&
      context.frameworkId === 'opencode' &&
      typeof reportedTitle === 'string' &&
      REVIEWER_MCP_OPENCODE_TOOL_NAMES.has(reportedTitle)
        ? reportedTitle
        : undefined
    const codexToolName =
      context.frameworkId === 'codex' &&
      toolName != null &&
      REVIEWER_MCP_LEAF_TOOL_NAMES.has(toolName) &&
      reportedTitle === `mcp.${REVIEWER_MCP_SERVER_NAME}.${toolName}`
        ? toolName
        : undefined
    const claudeToolName =
      toolName == null &&
      context.frameworkId === 'claude-code' &&
      typeof reportedTitle === 'string' &&
      REVIEWER_MCP_CLAUDE_TOOL_NAMES.has(reportedTitle)
        ? reportedTitle
        : undefined
    const isReviewerMcp =
      context.mcpServerNames.length === 1 &&
      context.mcpServerNames[0] === REVIEWER_MCP_SERVER_NAME &&
      ((toolName != null && REVIEWER_MCP_PROVIDER_TOOL_NAMES.has(toolName)) ||
        opencodeToolName != null ||
        codexToolName != null ||
        claudeToolName != null)

    if (!isReviewerMcp) {
      const rejectOption =
        params.options.find((option) => option.kind === 'reject_once') ??
        params.options.find((option) => option.kind === 'reject_always')
      this.rejectedToolCalls.set(
        params.sessionId,
        (this.rejectedToolCalls.get(params.sessionId) ?? 0) + 1
      )
      log.warn('rejecting non-reviewer tool requested by background reviewer', {
        sessionId: params.sessionId,
        tool: toolName ?? params.toolCall.kind,
        toolCallId: params.toolCall?.toolCallId
      })
      return rejectOption
        ? { outcome: { outcome: 'selected', optionId: rejectOption.optionId } }
        : { outcome: { outcome: 'cancelled' } }
    }

    const allowOption =
      params.options.find((option) => option.kind === 'allow_once') ??
      params.options.find((option) => option.kind === 'allow_always')
    if (!allowOption) {
      log.warn('reviewer MCP permission request had no allow option; cancelling', {
        sessionId: params.sessionId,
        toolCallId: params.toolCall?.toolCallId
      })
      return { outcome: { outcome: 'cancelled' } }
    }
    log.debug('approving scope-bounded reviewer MCP tool call', {
      sessionId: params.sessionId,
      toolCallId: params.toolCall?.toolCallId,
      optionId: allowOption.optionId
    })
    return { outcome: { outcome: 'selected', optionId: allowOption.optionId } }
  }

  dispose(session: ActiveSession): ReviewerSessionDisposition {
    const cleanupFailures: unknown[] = []
    const runCleanup = <Result>(stage: string, cleanup: () => Result): Result | undefined => {
      try {
        return cleanup()
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError)
        safeLogError('reviewer session cleanup failed', {
          ...diagnosticErrorFields(cleanupError),
          sessionId: session.sessionId,
          stage
        })
        return undefined
      }
    }

    const owner = this.activeBySession.get(session)
    this.activeBySession.delete(session)
    const ownsActiveIdentity =
      owner !== undefined && this.activeById.get(owner.sessionId)?.token === owner.token
    const rejectedToolCalls = ownsActiveIdentity
      ? (this.rejectedToolCalls.get(owner.sessionId) ?? 0)
      : 0
    let reviewerBridgeScoped: boolean | undefined
    if (ownsActiveIdentity && owner) {
      this.activeById.delete(owner.sessionId)
      reviewerBridgeScoped = runCleanup('bridge', () =>
        this.unregisterBridgeSession(owner.sessionId)
      )
      runCleanup('permission-correlations', () =>
        this.dependencies.clearPermissionCorrelations(owner.sessionId)
      )
      this.rejectedToolCalls.delete(owner.sessionId)
    }

    let disposeFailed = false
    let disposeFailure: unknown
    try {
      session.dispose()
    } catch (error) {
      disposeFailed = true
      disposeFailure = error
    }

    if (owner) this.removeDirectory(owner.cwd)
    if (ownsActiveIdentity) {
      runCleanup('reconnect-retirement', () => this.dependencies.onActiveSessionReleased())
    }

    if (disposeFailed) throw disposeFailure
    if (cleanupFailures.length > 0) throw cleanupFailures[0]
    return { rejectedToolCalls, reviewerBridgeScoped }
  }

  invalidatePending(): void {
    for (const token of this.pendingIds.values()) this.dependencies.removeStartupBlocker(token)
    this.pendingIds.clear()
  }

  clear(): void {
    this.invalidatePending()
    for (const [sessionId, owner] of this.activeById) {
      try {
        this.unregisterBridgeSession(sessionId)
      } catch (error) {
        safeLogError('reviewer bridge cleanup after connection close failed', {
          ...diagnosticErrorFields(error),
          sessionId
        })
      }
      this.removeDirectory(owner.cwd)
      try {
        this.dependencies.clearPermissionCorrelations(sessionId)
      } catch (error) {
        safeLogError('reviewer permission cleanup after connection close failed', {
          ...diagnosticErrorFields(error),
          sessionId
        })
      }
      this.activeBySession.delete(owner.session)
    }
    this.activeById.clear()
    this.rejectedToolCalls.clear()
  }

  private validateRequest(request: ReviewerSessionRequest): string[] {
    const mcpServerNames = request.mcpServers
      .map((server) => (server as { name?: unknown }).name)
      .filter((name): name is string => typeof name === 'string')
      .map(canonicalAppMcpServerName)
    const reviewerMcp = request.mcpServers[0]
    const reviewerMcpHttp =
      reviewerMcp && 'type' in reviewerMcp && reviewerMcp.type === 'http' ? reviewerMcp : undefined
    const reviewerMcpStdio = reviewerMcp && !('type' in reviewerMcp) ? reviewerMcp : undefined
    let reviewerMcpUrl: URL | undefined
    try {
      reviewerMcpUrl = reviewerMcpHttp ? new URL(reviewerMcpHttp.url) : undefined
    } catch {
      reviewerMcpUrl = undefined
    }
    if (
      request.mcpServers.length !== 1 ||
      mcpServerNames.length !== 1 ||
      mcpServerNames[0] !== REVIEWER_MCP_SERVER_NAME ||
      !(
        (reviewerMcpHttp &&
          reviewerMcpUrl?.protocol === 'http:' &&
          reviewerMcpUrl.hostname === '127.0.0.1') ||
        (reviewerMcpStdio &&
          reviewerMcpStdio.args?.at(-1) === REVIEWER_MCP_PROXY_ARG &&
          reviewerMcpStdio.env?.some(
            (entry) => entry.name === 'OPEN_SCIENCE_REVIEWER_MCP_SOCKET_PATH' && entry.value
          ) &&
          reviewerMcpStdio.env.some(
            (entry) => entry.name === 'OPEN_SCIENCE_REVIEWER_MCP_TOKEN' && entry.value
          ))
      )
    ) {
      throw new Error(
        `Reviewer sessions require exactly one app-owned ${REVIEWER_MCP_SERVER_NAME} MCP server.`
      )
    }
    return mcpServerNames
  }

  private reserveIdentity(
    sessionId: string,
    generation: number
  ): ReviewerSessionIdentityReservationResult {
    if (generation !== this.dependencies.currentStartupGeneration()) {
      return { collision: new Error('ACP session startup was superseded.') }
    }
    if (
      this.dependencies.isPrimarySessionIdClaimed(sessionId) ||
      this.activeById.has(sessionId) ||
      this.pendingIds.has(sessionId)
    ) {
      return { collision: new Error(`Reviewer session id collision: ${sessionId}`) }
    }
    const reservation = {
      generation,
      sessionId,
      token: Symbol('reviewer-session-identity')
    } satisfies ReviewerSessionIdentityReservation
    this.pendingIds.set(sessionId, reservation.token)
    this.dependencies.addStartupBlocker(reservation.token)
    return { reservation }
  }

  private activateIdentity(
    reservation: ReviewerSessionIdentityReservation,
    session: ActiveSession,
    cwd: string,
    frameworkId: AgentFrameworkId,
    mcpServerNames: readonly string[]
  ): void {
    this.assertIdentityReservation(reservation)
    this.pendingIds.delete(reservation.sessionId)
    this.dependencies.removeStartupBlocker(reservation.token)
    const owner = {
      cwd,
      frameworkId,
      mcpServerNames,
      role: REVIEWER_SESSION_ROLE,
      session,
      sessionId: reservation.sessionId,
      token: reservation.token
    } satisfies ActiveReviewerSessionOwner
    this.activeById.set(reservation.sessionId, owner)
    this.activeBySession.set(session, owner)
    this.rejectedToolCalls.delete(reservation.sessionId)
  }

  private assertIdentityReservation(reservation: ReviewerSessionIdentityReservation): void {
    if (
      reservation.generation !== this.dependencies.currentStartupGeneration() ||
      this.pendingIds.get(reservation.sessionId) !== reservation.token
    ) {
      throw new Error('ACP session startup was superseded.')
    }
  }

  private releaseIdentityReservation(reservation: ReviewerSessionIdentityReservation): void {
    this.dependencies.removeStartupBlocker(reservation.token)
    if (this.pendingIds.get(reservation.sessionId) === reservation.token) {
      this.pendingIds.delete(reservation.sessionId)
    }
  }

  private unregisterBridgeSession(sessionId: string): boolean | undefined {
    const scoped = this.dependencies.unregisterBridgeSession(sessionId)
    if (scoped === false) log.error('reviewer bridge request was never scoped', { sessionId })
    return scoped
  }

  private disposeSessionAfterFailure(session: ActiveSession, logMessage: string): void {
    try {
      session.dispose()
    } catch (cleanupError) {
      safeLogError(logMessage, {
        ...diagnosticErrorFields(cleanupError),
        sessionId: session.sessionId
      })
    }
  }

  private removeDirectory(reviewerCwd: string): void {
    try {
      rmSync(reviewerCwd, { recursive: true, force: true })
    } catch (error) {
      safeLogWarn('failed to remove temporary reviewer directory', {
        reviewerCwd,
        error: errorMessage(error)
      })
    }
  }
}
