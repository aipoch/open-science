import { createHmac, randomBytes } from 'node:crypto'

import { ParserEngine } from './engine'
import { ALL_CONNECTOR_IDS, getDescriptor } from './registry'
import {
  classifyCustomMcpFailure,
  isCustomMcpServerRouteSafe,
  toCustomMcpConfig,
  type CustomMcpFailureAvailability
} from './custom-mcp-bootstrap'
import { McpToolCallError, type CustomMcpServerConfig } from './mcp-client-manager'
import type { ConnectorCredentials, ToolDescriptor } from './types'
import type { StoredConnectors, StoredCustomMcpServer } from '../settings/types'
import type { PermissionGrantRegistry } from '../permission-grants/registry'
import { ConnectorPermissionBroker } from '../permission-grants/connector-broker'
import type { ConnectorPermissionRequest } from '../permission-grants/connector-broker'
import type { PermissionGrantScope } from '../../shared/permission-grants'
import type { ApprovalDecision, ConnectorApprovalScope } from '../../shared/settings'
import type { SpecialistProfileView } from '../../shared/specialist'

type McpClientManagerLike = {
  listTools(config: CustomMcpServerConfig, signal?: AbortSignal): Promise<Array<{ name: string }>>
  call(
    config: CustomMcpServerConfig,
    method: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown>
}

type ConnectorServiceDeps = {
  engine?: ParserEngine
  mcpClientManager?: McpClientManagerLike
  getConnectors: () => StoredConnectors | undefined
  // Re-read durable settings after an asynchronous approval/grant lookup so a policy change that
  // completed while the call was waiting remains the final dispatch boundary.
  getConnectorsFresh?: () => Promise<StoredConnectors | undefined>
  resolveApiKey: (ref?: string) => string | undefined
  permissionGrantRegistry?: PermissionGrantRegistry
  // Human approval gate for a tool call that isn't pre-approved. A connector call sends data to an
  // external service, so a call that is neither pre-allowed nor skip-approved fails closed when this
  // transport is absent.
  requestApproval?: (
    info: {
      connector: string
      method: string
      args: Record<string, unknown>
      // The session that triggered the call, when one is known, so the resulting notification can
      // open the right conversation.
      sessionId?: string
      availableScopes: ConnectorApprovalScope[]
    },
    signal?: AbortSignal
  ) => Promise<ApprovalDecision>
  // Handlers for bundled tools that run privileged local code (e.g. write an artifact, open a preview)
  // instead of the read-only HTTP ParserEngine. Keyed by `${connector}/${method}`; invoked after the
  // same enable/policy/approval gate as any other bundled call. The call context carries the id of the
  // session that triggered the call so a handler can attribute side effects (e.g. a generated artifact)
  // to the right session instead of a global "current" one.
  localToolHandlers?: Record<
    string,
    (
      args: Record<string, unknown>,
      context: ConnectorCallContext,
      signal?: AbortSignal
    ) => Promise<unknown>
  >
  // Resolves the current specialist profile immediately before agent dispatch. This is intentionally
  // a function (rather than a session-start snapshot) so edited/deleted profiles take effect on the
  // next connector call.
  resolveSpecialistProfile?: (specialistId: string) => Promise<SpecialistProfileView | undefined>
  onCustomServerAvailabilityChanged?: (
    serverId: string,
    availability: CustomMcpFailureAvailability | undefined
  ) => void
}

// Optional routing context for a connector call. Present for calls that originate inside a session
// (e.g. notebook host.mcp); absent for context-free callers.
export type ConnectorCallContext = {
  sessionId?: string
  projectId?: string
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

type CustomServerSecurityChangeGuard = {
  commit(server: StoredCustomMcpServer): void
  rollback(): void
}

const customMcpFailureCategory = (
  availability: CustomMcpFailureAvailability
): 'connector_unavailable' | 'connector_unauthenticated' => `connector_${availability}`

const CUSTOM_MCP_RETRY_BASE_MS = 1_000
const CUSTOM_MCP_RETRY_MAX_MS = 30_000

type CustomMcpFailureState = {
  category: 'connector_unavailable' | 'connector_unauthenticated'
  failureCount: number
  retryAt?: number
  probing: boolean
}

const stableRecordEntries = (record: Record<string, string> | undefined): [string, string][] =>
  Object.entries(record ?? {}).sort(([left], [right]) => left.localeCompare(right))

const customServerSecurityFingerprintKey = randomBytes(32)

// Authenticates fields that can contain credentials. The process-local key lets the barrier compare
// a configuration generation without retaining another plaintext copy or exposing an enumerable
// digest. OAuth configuration contains only public metadata, so it remains outside the keyed digest.
const customServerCredentialFingerprint = (server: StoredCustomMcpServer): string =>
  createHmac('sha256', customServerSecurityFingerprintKey)
    .update(
      JSON.stringify([
        server.transport,
        server.command ?? null,
        server.args ?? [],
        server.url ?? null,
        stableRecordEntries(server.envRefs ?? server.env),
        stableRecordEntries(server.headerRefs ?? server.headers),
        server.oauthClientSecretRef ?? null
      ])
    )
    .digest('hex')

const customServerSecurityFingerprint = (server: StoredCustomMcpServer): string =>
  JSON.stringify([server.oauth ?? null, customServerCredentialFingerprint(server)])

const unavailableConnectorMessage = (connector: string): string =>
  `Connector ${JSON.stringify(connector)} is unavailable. ` +
  'Do not retry with guessed Connector names. ' +
  'Use only Connector names and methods documented by a loaded mcp-* Skill. ' +
  'If the required Skill is unavailable, ask the user to enable or add the Connector in Settings > Connectors, then retry.'

const disabledConnectorMessage = (connector: string): string =>
  `Connector ${JSON.stringify(connector)} is disabled. ` +
  'Do not retry with guessed Connector names. ' +
  'Ask the user to enable it in Settings > Connectors, then retry the same call.'

const unknownConnectorToolMessage = (connector: string, method: string): string =>
  `unknown tool: ${connector}/${method}. ` +
  'Do not retry with guessed method names. ' +
  'Use only methods documented by a loaded mcp-* Skill, then retry with a documented method.'

const connectorGateGuidance: Readonly<Record<string, string>> = {
  missing_session:
    'The Connector call could not be associated with the current Session. Do not retry this call. Ask the user to start a new Session before retrying.',
  specialist_unavailable:
    'The current Specialist is unavailable. Do not retry from this Specialist. Ask the user to switch to Main Agent or an available Specialist, then retry the same call.',
  specialist_capability_denied:
    "The current Specialist is not allowed to use this Connector. Do not retry from this Specialist. Use an allowed Connector, or ask the user to update this Specialist's Connector access in Settings > Specialists, then retry the same call.",
  connector_unavailable:
    'The Connector is unavailable. Do not retry with guessed Connector names or methods. Use only Connector names and methods documented by a loaded mcp-* Skill. Wait briefly and retry the same documented call once. If it remains unavailable, ask the user to check the Connector in Settings > Connectors.',
  connector_disabled:
    'The Connector is disabled. Do not retry until the user enables it in Settings > Connectors, then retry the same call.',
  connector_unauthenticated:
    'Connector authentication is required. Do not retry until the user signs in from Settings > Connectors, then retry the same call.',
  connector_runtime_unavailable:
    'The Connector runtime is unavailable. Wait briefly and retry the same call once. If it fails again, ask the user to restart Open Science before retrying.',
  connector_configuration_changed:
    'The Connector configuration changed before the external tool was called. Retry the exact same call once.'
}

const connectorGateMessage = (category: string): string => {
  const guidance = connectorGateGuidance[category]
  return `connector call rejected: ${category}${guidance ? `. ${guidance}` : ''}`
}

// Deliberately contains only a stable category. In particular it must not interpolate connector
// arguments, custom-server headers, credentials, or a Specialist's system prompt into an error that
// may be rendered back to an agent.
class ConnectorGateError extends Error {
  constructor(
    readonly category: string,
    message = connectorGateMessage(category)
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
  // enablement is only a logical preference and may be overridden by a Specialist; this state may
  // not. Transient transport failures become eligible for one demand-driven probe after backoff.
  private readonly unavailableCustomConnectors = new Map<string, CustomMcpFailureState>()
  private readonly customServerFailureEpochs = new Map<string, number>()
  private readonly permissionBroker: ConnectorPermissionBroker
  private readonly customServerGenerations = new Map<string, number>()
  private readonly customServerBarriers = new Map<
    string,
    { generation: number; expectedFingerprint?: string }
  >()
  constructor(private readonly deps: ConnectorServiceDeps) {
    this.engine = deps.engine ?? new ParserEngine()
    this.permissionBroker = new ConnectorPermissionBroker(
      deps.permissionGrantRegistry,
      deps.requestApproval
    )
  }

  isEnabled(
    connector: string,
    connectors: StoredConnectors | undefined = this.deps.getConnectors()
  ): boolean {
    // Bundled connectors are enabled by default; only an explicit opt-out disables one.
    return !(connectors?.disabledConnectorIds ?? []).includes(connector)
  }

  // Invalidates every call that captured the previous custom-server configuration. While the
  // settings write is in progress, new calls fail closed. After commit they remain blocked until the
  // refreshed connector snapshot exposes the exact persisted security configuration.
  beginCustomServerSecurityChange(serverId: string): CustomServerSecurityChangeGuard {
    const generation = (this.customServerGenerations.get(serverId) ?? 0) + 1
    this.customServerGenerations.set(serverId, generation)
    this.customServerBarriers.set(serverId, { generation })

    return {
      commit: (server) => {
        const barrier = this.customServerBarriers.get(serverId)
        if (barrier?.generation !== generation) return
        this.customServerBarriers.set(serverId, {
          generation,
          expectedFingerprint: customServerSecurityFingerprint(server)
        })
      },
      rollback: () => {
        if (this.customServerBarriers.get(serverId)?.generation === generation) {
          this.customServerBarriers.delete(serverId)
        }
      }
    }
  }

  clearCustomServerFailure(serverId: string): void {
    this.customServerFailureEpochs.set(
      serverId,
      (this.customServerFailureEpochs.get(serverId) ?? 0) + 1
    )
    if (this.unavailableCustomConnectors.delete(serverId)) {
      this.deps.onCustomServerAvailabilityChanged?.(serverId, undefined)
    }
  }

  async call(
    connector: string,
    method: string,
    args: Record<string, unknown>,
    context: ConnectorCallContext = {},
    signal?: AbortSignal
  ): Promise<unknown> {
    signal?.throwIfAborted()
    const descriptor = getDescriptor(connector, method)
    const isBundled = descriptor !== undefined || ALL_CONNECTOR_IDS.includes(connector)
    if (isBundled) {
      const access = await this.resolveAccess(connector, context, [connector], signal)
      return this.callBundled(connector, method, args, descriptor, context, access, signal)
    }

    const customServers = (await this.currentConnectors())?.customMcpServers ?? []
    signal?.throwIfAborted()
    const custom = customServers.find((server) => server.name === connector)
    const access = await this.resolveAccess(
      connector,
      context,
      custom ? [custom.id, custom.name] : [connector],
      signal
    )
    if (!custom) {
      throw new ConnectorGateError(
        'connector_unavailable',
        access.specialistScoped ? undefined : unavailableConnectorMessage(connector)
      )
    }
    return this.callCustom(custom, customServers, method, args, context, access, signal)
  }

  private async resolveAccess(
    connector: string,
    context: ConnectorCallContext,
    aliases: readonly string[] = [connector],
    signal?: AbortSignal
  ): Promise<ConnectorAccess> {
    signal?.throwIfAborted()
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
    signal?.throwIfAborted()
    if (!profile || !profile.enabled) throw new ConnectorGateError('specialist_unavailable')

    const allowed =
      profile.capabilityMode === 'full'
        ? !aliases.some((alias) => profile.fullAccess.excludedConnectorIds.includes(alias))
        : aliases.some((alias) => profile.selectedCapabilities.connectorIds.includes(alias))
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
    access: ConnectorAccess,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (!descriptor)
      throw new ConnectorGateError(
        'connector_unavailable',
        unknownConnectorToolMessage(connector, method)
      )

    const authorizedConnectors = access.bypassMainPolicy
      ? undefined
      : await this.ensureAuthorized(
          connector,
          connector,
          [connector],
          method,
          args,
          context,
          signal
        )

    // Bundled tools that need privileged local behavior run here, after the same gate, instead of the
    // read-only HTTP engine.
    signal?.throwIfAborted()
    const localHandler = this.deps.localToolHandlers?.[`${connector}/${method}`]
    if (localHandler) {
      return signal ? localHandler(args, context, signal) : localHandler(args, context)
    }

    const credentials = this.credentials(authorizedConnectors)
    return signal
      ? this.engine.call(descriptor, args, credentials, signal)
      : this.engine.call(descriptor, args, credentials)
  }

  private async callCustom(
    custom: NonNullable<StoredConnectors['customMcpServers']>[number],
    customServers: readonly StoredCustomMcpServer[],
    method: string,
    args: Record<string, unknown>,
    context: ConnectorCallContext,
    access: ConnectorAccess,
    signal?: AbortSignal
  ): Promise<unknown> {
    signal?.throwIfAborted()
    const generation = this.assertCustomServerCurrent(custom)
    const failureEpoch = this.customServerFailureEpochs.get(custom.id) ?? 0
    const physicalFailure = this.unavailableCustomConnectors.get(custom.id)
    if (physicalFailure && !this.isCustomServerProbeDue(physicalFailure)) {
      throw new ConnectorGateError(physicalFailure.category)
    }
    if (!access.bypassMainEnablement && !custom.enabled) {
      throw new ConnectorGateError(
        'connector_disabled',
        disabledConnectorMessage(custom.displayName)
      )
    }
    if (!this.isCustomConfigRunnable(custom, customServers)) {
      throw new ConnectorGateError('connector_unavailable')
    }
    if (custom.oauth && !custom.oauthState?.tokens?.access_token) {
      throw new ConnectorGateError('connector_unauthenticated')
    }
    if (!this.deps.mcpClientManager) throw new ConnectorGateError('connector_runtime_unavailable')

    // Approval must precede tools/list because even discovery connects the external server. The
    // authorization state is retained across later policy rechecks so one Once approval never prompts
    // twice merely because discovery itself was asynchronous.
    let authorization = await this.authorizeCustomForCurrentPolicy(
      custom,
      method,
      args,
      context,
      access,
      generation,
      signal
    )
    const config = toCustomMcpConfig(authorization.custom)
    if (physicalFailure) this.claimCustomServerProbe(custom.id, physicalFailure)

    let tools: Array<{ name: string }>
    try {
      tools = signal
        ? await this.deps.mcpClientManager.listTools(config, signal)
        : await this.deps.mcpClientManager.listTools(config)
    } catch (error) {
      if (signal?.aborted) {
        if (physicalFailure) this.releaseCustomServerProbe(custom.id, physicalFailure)
        throw error
      }
      // Never relay a transport error: custom server URLs, headers, or server-provided diagnostics
      // can contain credentials. Record only the availability category for subsequent fail-closed
      // dispatches; a successful connection clears the transient state.
      const availability = classifyCustomMcpFailure(error)
      this.recordCustomServerFailure(custom.id, failureEpoch, availability)
      throw new ConnectorGateError(customMcpFailureCategory(availability))
    }

    this.publishCustomServerRecovery(custom.id, failureEpoch)

    if (!tools.some((tool) => tool.name === method)) {
      throw new ConnectorGateError(
        'connector_unavailable',
        unknownConnectorToolMessage(authorization.custom.name, method)
      )
    }
    authorization = await this.authorizeCustomForCurrentPolicy(
      authorization.custom,
      method,
      args,
      context,
      access,
      generation,
      signal,
      authorization
    )
    if (authorization.deferredScope) {
      signal?.throwIfAborted()
      await this.permissionBroker.remember(authorization.request, authorization.deferredScope)
      signal?.throwIfAborted()
    }

    await this.authorizeCustomForCurrentPolicy(
      authorization.custom,
      method,
      args,
      context,
      access,
      generation,
      signal,
      authorization
    )

    try {
      const result = signal
        ? await this.deps.mcpClientManager.call(config, method, args, signal)
        : await this.deps.mcpClientManager.call(config, method, args)
      this.publishCustomServerRecovery(custom.id, failureEpoch)
      return result
    } catch (error) {
      if (signal?.aborted) throw error
      const availability = classifyCustomMcpFailure(error)
      // A structured tool error proves the MCP server is reachable. Keep connector-managed login
      // tools callable, but publish stale host-managed OAuth so Settings can offer sign-in recovery.
      if (
        !(error instanceof McpToolCallError) ||
        (custom.oauth && availability === 'unauthenticated')
      ) {
        this.recordCustomServerFailure(custom.id, failureEpoch, availability)
      }
      throw new ConnectorGateError(customMcpFailureCategory(availability))
    }
  }

  private recordCustomServerFailure(
    serverId: string,
    expectedEpoch: number,
    availability: CustomMcpFailureAvailability
  ): void {
    if ((this.customServerFailureEpochs.get(serverId) ?? 0) === expectedEpoch) {
      const category = customMcpFailureCategory(availability)
      const previous = this.unavailableCustomConnectors.get(serverId)
      const failureCount =
        category === 'connector_unavailable' && previous?.category === category
          ? previous.failureCount + 1
          : 1
      const retryDelay = Math.min(
        CUSTOM_MCP_RETRY_BASE_MS * 2 ** (failureCount - 1),
        CUSTOM_MCP_RETRY_MAX_MS
      )
      this.unavailableCustomConnectors.set(serverId, {
        category,
        failureCount,
        ...(category === 'connector_unavailable' ? { retryAt: Date.now() + retryDelay } : {}),
        probing: false
      })
      this.deps.onCustomServerAvailabilityChanged?.(serverId, availability)
    }
  }

  private isCustomServerProbeDue(failure: CustomMcpFailureState): boolean {
    return (
      failure.category === 'connector_unavailable' &&
      !failure.probing &&
      failure.retryAt !== undefined &&
      Date.now() >= failure.retryAt
    )
  }

  private claimCustomServerProbe(serverId: string, expected: CustomMcpFailureState): void {
    const current = this.unavailableCustomConnectors.get(serverId)
    if (!current) return
    if (current !== expected || !this.isCustomServerProbeDue(current)) {
      throw new ConnectorGateError(current.category)
    }
    current.probing = true
  }

  private releaseCustomServerProbe(serverId: string, expected: CustomMcpFailureState): void {
    if (this.unavailableCustomConnectors.get(serverId) === expected) expected.probing = false
  }

  private publishCustomServerRecovery(serverId: string, expectedEpoch: number): void {
    if (
      (this.customServerFailureEpochs.get(serverId) ?? 0) === expectedEpoch &&
      this.unavailableCustomConnectors.delete(serverId)
    ) {
      this.deps.onCustomServerAvailabilityChanged?.(serverId, undefined)
    }
  }

  private assertCustomServerCurrent(
    custom: StoredCustomMcpServer,
    expectedGeneration?: number
  ): number {
    const generation = this.customServerGenerations.get(custom.id) ?? 0
    if (expectedGeneration !== undefined && expectedGeneration !== generation) {
      throw new ConnectorGateError('connector_configuration_changed')
    }

    const barrier = this.customServerBarriers.get(custom.id)
    if (!barrier) return generation
    if (
      barrier.expectedFingerprint === undefined ||
      barrier.expectedFingerprint !== customServerSecurityFingerprint(custom)
    ) {
      throw new ConnectorGateError('connector_configuration_changed')
    }

    this.customServerBarriers.delete(custom.id)
    return generation
  }

  private isCustomConfigRunnable(
    custom: NonNullable<StoredConnectors['customMcpServers']>[number],
    customServers: readonly StoredCustomMcpServer[]
  ): boolean {
    if (!isCustomMcpServerRouteSafe(custom, customServers)) return false
    if (custom.transport === 'stdio') return Boolean(custom.command)
    return Boolean(custom.url)
  }

  // The Permission Broker owns Connector policy precedence as well as durable grant matching. This
  // service supplies only the registered identity and current settings snapshot.
  private async ensureAuthorized(
    connectorLabel: string,
    capabilityServerId: string,
    policyIds: readonly string[],
    method: string,
    args: Record<string, unknown>,
    context: ConnectorCallContext,
    signal?: AbortSignal
  ): Promise<StoredConnectors | undefined> {
    let requireApprovalSatisfied = false
    for (;;) {
      signal?.throwIfAborted()
      const connectors = await this.currentConnectors()
      signal?.throwIfAborted()
      if (!this.isEnabled(connectorLabel, connectors)) {
        throw new ConnectorGateError('connector_disabled', disabledConnectorMessage(connectorLabel))
      }
      const request = this.authorizationRequest(
        connectorLabel,
        capabilityServerId,
        policyIds,
        method,
        args,
        context,
        connectors
      )
      const policyDecision = this.permissionBroker.preflight(request)
      if (policyDecision === 'allow' || requireApprovalSatisfied) return connectors

      await this.permissionBroker.authorize(request, policyDecision, { signal })
      requireApprovalSatisfied = true
    }
  }

  private async authorizeCustomForCurrentPolicy(
    custom: StoredCustomMcpServer,
    method: string,
    args: Record<string, unknown>,
    context: ConnectorCallContext,
    access: ConnectorAccess,
    generation: number,
    signal?: AbortSignal,
    prior?: {
      requireApprovalSatisfied: boolean
      deferredScope?: PermissionGrantScope
    }
  ): Promise<{
    custom: StoredCustomMcpServer
    request: ConnectorPermissionRequest
    requireApprovalSatisfied: boolean
    deferredScope?: PermissionGrantScope
  }> {
    let requireApprovalSatisfied = prior?.requireApprovalSatisfied ?? false
    let deferredScope = prior?.deferredScope

    for (;;) {
      signal?.throwIfAborted()
      const connectors = await this.currentConnectors()
      signal?.throwIfAborted()
      const customServers = connectors?.customMcpServers ?? []
      const current = customServers.find((server) => server.id === custom.id)
      if (!current) throw new ConnectorGateError('connector_unavailable')
      this.assertCustomServerCurrent(current, generation)
      if (!access.bypassMainEnablement && !current.enabled) {
        throw new ConnectorGateError(
          'connector_disabled',
          disabledConnectorMessage(current.displayName)
        )
      }
      if (!this.isCustomConfigRunnable(current, customServers)) {
        throw new ConnectorGateError('connector_unavailable')
      }

      const request = this.authorizationRequest(
        current.displayName,
        current.id,
        [current.name],
        method,
        args,
        context,
        connectors
      )
      if (access.bypassMainPolicy) {
        return { custom: current, request, requireApprovalSatisfied }
      }

      const policyDecision = this.permissionBroker.preflight(request)
      if (policyDecision === 'allow') {
        return { custom: current, request, requireApprovalSatisfied }
      }
      if (requireApprovalSatisfied) {
        return {
          custom: current,
          request,
          requireApprovalSatisfied,
          ...(deferredScope ? { deferredScope } : {})
        }
      }

      deferredScope = await this.permissionBroker.authorize(request, policyDecision, {
        deferRemember: true,
        signal
      })
      requireApprovalSatisfied = true
    }
  }

  private currentConnectors(): Promise<StoredConnectors | undefined> {
    return this.deps.getConnectorsFresh?.() ?? Promise.resolve(this.deps.getConnectors())
  }

  private authorizationRequest(
    connectorLabel: string,
    capabilityServerId: string,
    policyIds: readonly string[],
    method: string,
    args: Record<string, unknown>,
    context: ConnectorCallContext,
    connectors: StoredConnectors | undefined = this.deps.getConnectors()
  ): ConnectorPermissionRequest {
    return {
      capability: { kind: 'mcp_tool', key: `mcp:${capabilityServerId}/${method}` },
      context,
      connector: connectorLabel,
      method,
      args,
      policy: {
        aliases: policyIds,
        autoAllowIds: connectors?.autoAllowIds,
        blockedToolIds: connectors?.blockedToolIds,
        askToolIds: connectors?.askToolIds
      }
    }
  }

  private credentials(
    c: StoredConnectors | undefined = this.deps.getConnectors()
  ): ConnectorCredentials {
    return { ncbiEmail: c?.contactEmail, ncbiApiKey: this.deps.resolveApiKey(c?.ncbiApiKeyRef) }
  }
}
