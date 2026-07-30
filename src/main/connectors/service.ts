import { ParserEngine } from './engine'
import { ALL_CONNECTOR_IDS, getDescriptor } from './registry'
import { toCustomMcpConfig } from './custom-mcp-bootstrap'
import type { CustomMcpServerConfig } from './mcp-client-manager'
import type { ConnectorCredentials, ToolDescriptor } from './types'
import type { StoredConnectors } from '../settings/types'
import type { ApprovalDecision } from '../../shared/settings'
import type { SpecialistProfileView } from '../../shared/specialist'

type McpClientManagerLike = {
  call(
    config: CustomMcpServerConfig,
    method: string,
    args: Record<string, unknown>
  ): Promise<unknown>
}

type ConnectorServiceDeps = {
  engine?: ParserEngine
  mcpClientManager?: McpClientManagerLike
  getConnectors: () => StoredConnectors | undefined
  resolveApiKey: (ref?: string) => string | undefined
  // Human approval gate for a tool call that isn't pre-approved. Absent (e.g. in tests) means the
  // call runs without prompting. A connector call sends data to an external service, so a call that
  // is neither pre-allowed nor skip-approved must be confirmed before it runs.
  requestApproval?: (info: {
    connector: string
    method: string
    args: Record<string, unknown>
    // The session that triggered the call, when one is known, so the resulting notification can
    // open the right conversation.
    sessionId?: string
  }) => Promise<ApprovalDecision>
  // Handlers for bundled tools that run privileged local code (e.g. write an artifact, open a preview)
  // instead of the read-only HTTP ParserEngine. Keyed by `${connector}/${method}`; invoked after the
  // same enable/policy/approval gate as any other bundled call. The call context carries the id of the
  // session that triggered the call so a handler can attribute side effects (e.g. a generated artifact)
  // to the right session instead of a global "current" one.
  localToolHandlers?: Record<
    string,
    (args: Record<string, unknown>, context: ConnectorCallContext) => Promise<unknown>
  >
  // Resolves the current specialist profile immediately before agent dispatch. This is intentionally
  // a function (rather than a session-start snapshot) so edited/deleted profiles take effect on the
  // next connector call.
  resolveSpecialistProfile?: (specialistId: string) => Promise<SpecialistProfileView | undefined>
}

// Optional routing context for a connector call. Present for calls that originate inside a session
// (e.g. notebook host.mcp); absent for context-free callers.
export type ConnectorCallContext = {
  sessionId?: string
  // Agent calls are untrusted model output and must be tied to a known session. Internal callers
  // must opt in explicitly so they cannot accidentally inherit a session capability scope.
  origin?: 'agent' | 'internal'
  // This field is populated only by the main-process session registry, never from connector RPC
  // parameters. It selects an independent Specialist capability configuration for this call.
  specialistId?: string
}

type ConnectorAccess = {
  bypassMainEnablement: boolean
  bypassMainPolicy: boolean
  specialistScoped: boolean
}

// Deliberately contains only a stable category. In particular it must not interpolate connector
// arguments, custom-server headers, credentials, or a Specialist's system prompt into an error that
// may be rendered back to an agent.
class ConnectorGateError extends Error {
  constructor(
    readonly category: string,
    message = `connector call rejected: ${category}`
  ) {
    super(message)
    this.name = 'ConnectorGateError'
  }
}

// Agent-agnostic gate: enforces enabled state + per-tool policy, prompts for approval on un-trusted
// calls, injects credentials, and dispatches each call to either the bundled ParserEngine or a
// user-added custom MCP server's McpClientManager. See docs/internal/2026-07-12-custom-mcp-connectors-plan4.md §3.2.
export class ConnectorService {
  private readonly engine: ParserEngine
  // A connector that cannot authenticate or start is physically unavailable to every scope. Main
  // enablement is only a logical preference and may be overridden by a Specialist; this state may not.
  private readonly unavailableCustomConnectors = new Map<
    string,
    'connector_unavailable' | 'connector_unauthenticated'
  >()
  constructor(private readonly deps: ConnectorServiceDeps) {
    this.engine = deps.engine ?? new ParserEngine()
  }

  isEnabled(connector: string): boolean {
    // Bundled connectors are enabled by default; only an explicit opt-out disables one.
    return !(this.deps.getConnectors()?.disabledConnectorIds ?? []).includes(connector)
  }

  async call(
    connector: string,
    method: string,
    args: Record<string, unknown>,
    context: ConnectorCallContext = {}
  ): Promise<unknown> {
    const access = await this.resolveAccess(connector, context)
    const descriptor = getDescriptor(connector, method)
    const isBundled = descriptor !== undefined || ALL_CONNECTOR_IDS.includes(connector)
    if (isBundled) return this.callBundled(connector, method, args, descriptor, context, access)

    const custom = (this.deps.getConnectors()?.customMcpServers ?? []).find(
      (s) => s.name === connector
    )
    if (!custom) {
      throw new ConnectorGateError(
        'connector_unavailable',
        access.specialistScoped ? undefined : `connector not enabled: ${connector}`
      )
    }
    return this.callCustom(custom, method, args, context, access)
  }

  private async resolveAccess(
    connector: string,
    context: ConnectorCallContext
  ): Promise<ConnectorAccess> {
    if (context.origin === 'internal') {
      return { bypassMainEnablement: false, bypassMainPolicy: false, specialistScoped: false }
    }
    // No call may silently become "internal". Agent entry points must mark their origin and supply a
    // session; internal code must make the same origin declaration explicitly.
    if (!context.sessionId) throw new ConnectorGateError('missing_session')
    if (!context.specialistId) {
      return { bypassMainEnablement: false, bypassMainPolicy: false, specialistScoped: false }
    }
    if (!this.deps.resolveSpecialistProfile) throw new ConnectorGateError('specialist_unavailable')

    const profile = await this.deps.resolveSpecialistProfile(context.specialistId)
    if (!profile || !profile.enabled) throw new ConnectorGateError('specialist_unavailable')

    const allowed =
      profile.capabilityMode === 'full'
        ? !profile.fullAccess.excludedConnectorIds.includes(connector)
        : profile.selectedCapabilities.connectorIds.includes(connector)
    if (!allowed) throw new ConnectorGateError('specialist_capability_denied')

    // A Specialist's configuration is independent from Main's enabled and Allow/Ask/Block settings.
    // Physical availability is still checked by the actual bundled/custom dispatch path below.
    return { bypassMainEnablement: true, bypassMainPolicy: true, specialistScoped: true }
  }

  private async callBundled(
    connector: string,
    method: string,
    args: Record<string, unknown>,
    descriptor: ToolDescriptor | undefined,
    context: ConnectorCallContext,
    access: ConnectorAccess
  ): Promise<unknown> {
    if (!access.bypassMainEnablement && !this.isEnabled(connector)) {
      throw new ConnectorGateError('connector_disabled', `connector not enabled: ${connector}`)
    }
    if (!descriptor)
      throw new ConnectorGateError('connector_unavailable', `unknown tool: ${connector}/${method}`)

    if (!access.bypassMainPolicy && this.isBlocked(connector, method)) {
      throw new ConnectorGateError('tool_blocked', `tool blocked by policy: ${connector}/${method}`)
    }
    if (!access.bypassMainPolicy) {
      await this.ensureApproved(connector, method, args, context.sessionId)
    }

    // Bundled tools that need privileged local behavior run here, after the same gate, instead of the
    // read-only HTTP engine.
    const localHandler = this.deps.localToolHandlers?.[`${connector}/${method}`]
    if (localHandler) return localHandler(args, context)

    return this.engine.call(descriptor, args, this.credentials())
  }

  private async callCustom(
    custom: NonNullable<StoredConnectors['customMcpServers']>[number],
    method: string,
    args: Record<string, unknown>,
    context: ConnectorCallContext,
    access: ConnectorAccess
  ): Promise<unknown> {
    const physicalFailure = this.unavailableCustomConnectors.get(custom.name)
    if (physicalFailure) throw new ConnectorGateError(physicalFailure)
    if (!access.bypassMainEnablement && !custom.enabled) {
      throw new ConnectorGateError('connector_disabled', `connector not enabled: ${custom.name}`)
    }
    if (!this.isCustomConfigRunnable(custom)) throw new ConnectorGateError('connector_unavailable')
    if (!access.bypassMainPolicy && this.isBlocked(custom.name, method)) {
      throw new ConnectorGateError(
        'tool_blocked',
        `tool blocked by policy: ${custom.name}/${method}`
      )
    }
    if (!this.deps.mcpClientManager) throw new ConnectorGateError('connector_runtime_unavailable')
    if (!access.bypassMainPolicy) {
      await this.ensureApproved(custom.name, method, args, context.sessionId)
    }

    try {
      const result = await this.deps.mcpClientManager.call(toCustomMcpConfig(custom), method, args)
      this.unavailableCustomConnectors.delete(custom.name)
      return result
    } catch (error) {
      // Never relay a transport error: custom server URLs, headers, or server-provided diagnostics
      // can contain credentials. Record only the availability category for subsequent fail-closed
      // dispatches; a successful connection clears the transient state.
      const category =
        error instanceof Error &&
        /(?:401|403|unauthoriz|authenticat|forbidden)/i.test(error.message)
          ? 'connector_unauthenticated'
          : 'connector_unavailable'
      this.unavailableCustomConnectors.set(custom.name, category)
      throw new ConnectorGateError(category)
    }
  }

  private isCustomConfigRunnable(
    custom: NonNullable<StoredConnectors['customMcpServers']>[number]
  ): boolean {
    if (custom.transport === 'stdio') return Boolean(custom.command)
    return Boolean(custom.url)
  }

  private isBlocked(connector: string, method: string): boolean {
    const blocked = this.deps.getConnectors()?.blockedToolIds ?? []
    return blocked.includes(`${connector}/${method}`)
  }

  // Tools run without a prompt by default. A call is confirmed by a human only when the tool is
  // explicitly set to "Ask each time" AND the connector does not skip approvals.
  private async ensureApproved(
    connector: string,
    method: string,
    args: Record<string, unknown>,
    sessionId: string | undefined
  ): Promise<void> {
    const c = this.deps.getConnectors()
    const requiresAsk = (c?.askToolIds ?? []).includes(`${connector}/${method}`)
    const skipApprovals = (c?.autoAllowIds ?? []).includes(connector)
    if (!requiresAsk || skipApprovals) return
    if (!this.deps.requestApproval) return // no approver wired (tests) — do not block

    const decision = await this.deps.requestApproval({ connector, method, args, sessionId })

    if (decision !== 'allow') {
      throw new Error(`tool call denied by user: ${connector}/${method}`)
    }
  }

  private credentials(): ConnectorCredentials {
    const c = this.deps.getConnectors()
    return { ncbiEmail: c?.contactEmail, ncbiApiKey: this.deps.resolveApiKey(c?.ncbiApiKeyRef) }
  }
}
