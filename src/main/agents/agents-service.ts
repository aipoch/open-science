// host.agents adapter: the control-plane SDK's server-side read surface.
//
// This module is the ONLY place that turns internal Specialist/catalog records into the public
// `host.agents.*` read models. It is deliberately decoupled from the concrete SettingsService and
// ConnectorService via the AgentsServiceDeps interface, so the RPC server can wire the real
// services in production while tests pass lightweight stubs.
//
// Cross-cutting rules (design.md §14, PRD §5):
//  - Main validates every payload; sandbox input is untrusted.
//  - Public data is projected explicitly — never return internal repository objects.
//  - Errors are sanitized and prefixed `host.agents.<method>:` so they never leak system
//    instructions, connector args, credentials, headers, environment values, or tokens.
//  - The SpecialistService and catalog services remain authoritative; nothing is copied here.

import { CONNECTOR_CATALOG, type ConnectorMeta } from '../connectors/catalog'
import {
  hasUsableCustomMcpCredentials,
  isCustomMcpServerRouteSafe,
  type CustomMcpFailureAvailability
} from '../connectors/custom-mcp-bootstrap'
import { getConnectorTools } from '../connectors/registry'
import type { SpecialistService } from '../specialist/service'
import type { SessionBindingService } from '../specialist/session-binding'
import type { SpecialistView } from '../../shared/specialist'
import type { StoredConnectors } from '../settings/types'
import {
  isAgentsOpName,
  isAgentsParams,
  stripAgentsReservedParams,
  type ApprovalGateway,
  type SwitchNotifier,
  type TrustedCallingSession
} from '../../shared/agents-contract'
import { executeAgentsMutation, type AgentsMutationCatalog } from './agents-mutations'
import { SwitchOperation, SwitchCommitSequencer, type SwitchParams } from './switch-operation'
import { applyDelete } from './specialist-privileged-ops'
import type { HandoffApprovalContext } from '../../shared/handoff-lifecycle'
import type {
  SpecialistDeleteRequest,
  SpecialistDeleteResult
} from '../../shared/specialist-package'
import { AgentsSafeError, agentsPublicError, formatAgentsError } from './agents-error'
import { applyNameOrIdFilter } from './name-or-id-filter'

// The minimal read surface this adapter needs from the settings/connectors catalog. Keeping it
// narrow avoids pulling the whole SettingsService into the SDK contract and lets tests stub it.
export type AgentsCatalogSource = {
  // The complete Specialist-visible skill catalog (featured + imported + personal), including
  // skills the Main Agent disabled. Returns id, public framework name, display name, and Main
  // enabled state.
  listSkillCatalog(): Promise<
    Array<{
      id: string
      frameworkName: string
      displayName: string
      source: string
      mainEnabled: boolean
      available: boolean
    }>
  >
  // The stored connectors document (bundled enablement + custom MCP servers). Used to project
  // public connector information; secret material is never read through this adapter.
  getConnectors(): Promise<StoredConnectors | undefined>
}

export type AgentsServiceDeps = {
  specialistService: SpecialistService
  catalog: AgentsCatalogSource
  // Runtime failures are projected separately from durable Settings. Keeping this as a narrow,
  // optional resolver lets host.agents share the authoritative custom MCP status without owning
  // the connector runtime or forcing read-only tests to construct it.
  customServerAvailability?: (id: string) => CustomMcpFailureAvailability | undefined
  // Injected (fake-able) seams for privileged mutations and Specialist switches. Read-only callers
  // may leave these unset; the dispatcher routes privileged ops through
  // `approvalGateway` and signals approved switches via `switchNotifier`. They are SERVER-supplied
  // — never reachable from sandbox request params (the RPC route strips reserved keys first).
  approvalGateway?: ApprovalGateway
  switchNotifier?: SwitchNotifier
  approvalLifecycle?: {
    onAwaitingApproval(context: HandoffApprovalContext): void
    settleApproval(context: HandoffApprovalContext, approved: boolean): void
  }
  // The durable switch lifecycle reuses the existing SessionBindingService (in-memory
  // binding) and the EXISTING durable session-file persistence seam — there is no parallel switch
  // service. They are optional so the read slice and its tests can omit them; the dispatcher fails
  // closed if a `switch` op arrives without them configured.
  sessionBinding?: SessionBindingService
  persistSessionSpecialist?: (sessionId: string, specialistId: string | undefined) => Promise<void>
  // Invalidates the runtime catalog (Settings/picker/runtime capability resolution) after a successful
  // privileged mutation (delete). Ordinary mutations already invalidate via the
  // existing SpecialistService/catalog-change broadcast path; the privileged delete runs through a
  // dedicated module that calls this only on success.
  invalidateCatalog?: () => Promise<void> | void
  deleteSpecialist?: (request: SpecialistDeleteRequest) => Promise<SpecialistDeleteResult>
}

// ---------------------------------------------------------------------------
// Public read models (camelCase records returned to the SDK)
// ---------------------------------------------------------------------------

// Listing Specialists is a discovery operation, so its collection shape is limited to the five
// fields needed to identify and present a Specialist. Callers that need editable configuration must
// explicitly request one Specialist via get().
export type SpecialistSummaryReadModel = {
  id: string
  name: string
  displayName: string
  description: string
  enabled: boolean
}

// Single-Agent details and mutation read-backs retain the prompt so callers can inspect, edit, and
// verify a complete Specialist configuration.
export type SpecialistDetailReadModel = SpecialistSummaryReadModel & {
  systemPrompt: string
  iconKey?: string
  colorKey?: string
  capabilityMode: 'full' | 'selected'
  fullAccess: SpecialistView['fullAccess']
  selectedCapabilities: SpecialistView['selectedCapabilities']
  revision: number
}

export type SkillCatalogReadModel = {
  id: string
  name: string
  displayName: string
  source: string
  mainEnabled: boolean
  available: boolean
}

export type ConnectorToolReadModel = {
  id: string
  description: string
}

export type ConnectorReadModel = {
  id: string
  name: string
  displayName: string
  description: string
  mainEnabled: boolean
  // Authentication/availability state, projected without secret detail. Custom connectors report
  // 'unavailable'/'unauthenticated'/'credential_unavailable' from their stored shape; bundled
  // connectors are 'available'.
  availability: 'available' | 'unavailable' | 'unauthenticated' | 'credential_unavailable'
  source: 'bundled' | 'custom'
  tools: ConnectorToolReadModel[]
}

// ---------------------------------------------------------------------------
// Public surface read operations
// ---------------------------------------------------------------------------

export type AgentsReadOp =
  | { op: 'list' }
  | { op: 'get'; params: { name?: unknown } }
  | { op: 'list_skills'; params: { name_or_id?: unknown } }
  | { op: 'list_connectors'; params: { name_or_id?: unknown } }

class AgentsCallError extends AgentsSafeError {
  constructor(method: string, cause: unknown) {
    super(formatAgentsError(method, cause))
    this.name = 'AgentsCallError'
  }
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const projectAgentSummary = (profile: SpecialistView): SpecialistSummaryReadModel => ({
  id: profile.id,
  name: profile.name,
  displayName: profile.displayName ?? profile.name,
  description: profile.description,
  enabled: profile.enabled
})

const projectAgentDetail = (profile: SpecialistView): SpecialistDetailReadModel => ({
  ...projectAgentSummary(profile),
  systemPrompt: profile.systemPrompt,
  iconKey: profile.iconKey,
  colorKey: profile.colorKey,
  capabilityMode: profile.capabilityMode,
  fullAccess: profile.fullAccess,
  selectedCapabilities: profile.selectedCapabilities,
  revision: profile.revision
})

export class AgentsService {
  // Long-lived (one per service = one per main process) sequencer shared across every per-call
  // SwitchOperation so the switch last-write-wins guard survives dispatch's per-call instantiation.
  private readonly switchSequencer = new SwitchCommitSequencer()

  constructor(private readonly deps: AgentsServiceDeps) {}

  // The extensible operation dispatcher is the single RPC entry point for reads, mutations, deletes,
  // and switches. Adding another operation requires no change to the auth/token transport path in
  // local-rpc-server.ts.
  //
  // EXTENSION POINT — to add a new operation:
  //   1. Add its name to AgentsOpName in src/shared/agents-contract.ts.
  //   2. Add a branch below (or delegate to a new operation module).
  //   3. Route privileged ops through this.deps.approvalGateway and signal approved switches via
  //      this.deps.switchNotifier — both are injected here, never reachable from `params`.
  // You do NOT touch local-rpc-server.ts: it already strips reserved routing/identity keys, forwards
  // the op, and passes the trusted calling session as `context`.
  async dispatch(op: unknown, context: TrustedCallingSession = {}): Promise<unknown> {
    if (!op || typeof op !== 'object' || !('op' in op)) {
      throw new AgentsCallError('unknown', agentsPublicError('Invalid request'))
    }
    const request = op as { op: unknown }
    if (!isAgentsOpName(request.op)) {
      throw new AgentsCallError(
        String(request.op ?? 'unknown'),
        agentsPublicError('Unknown operation')
      )
    }
    const opName = request.op
    // Defensive: strip any reserved routing/identity/switch keys a second time. The RPC route
    // already strips them, but dispatch must be safe to call directly (tests, future callers) and
    // must never honor a caller-supplied session or switch target.
    const rawParams = (op as { params?: unknown }).params
    const params = stripAgentsReservedParams(isAgentsParams(rawParams) ? rawParams : {})
    try {
      if (opName === 'list') return await this.list()
      if (opName === 'get') return await this.get(params)
      if (opName === 'list_skills') return await this.listSkills(params)
      if (opName === 'list_connectors') return await this.listConnectors(params)
      // Ordinary mutations (issue 03): create, update of mutable fields, and whole-Skill/whole-Connector
      // attach/detach. Routed to the standalone mutation module, which delegates to SpecialistService,
      // resolves name/id references, gates unavailable connectors, and returns a real read-back.
      if (
        opName === 'create' ||
        opName === 'update' ||
        opName === 'attach_skill' ||
        opName === 'detach_skill' ||
        opName === 'attach_connector' ||
        opName === 'detach_connector'
      ) {
        return projectAgentDetail(
          await executeAgentsMutation(
            { op: opName, params } as Parameters<typeof executeAgentsMutation>[0],
            {
              specialistService: this.deps.specialistService,
              catalog: this.mutationCatalog(),
              approvalGateway: this.deps.approvalGateway
            }
          )
        )
      }
      // host.agents.switch(nameOrNull) — durable immediate-handoff switch. Delegates to the
      // standalone SwitchOperation via runSwitch below.
      if (opName === 'switch') {
        if (context.callerRole !== 'main') {
          throw agentsPublicError('Only Main Agent may switch Specialist profile.')
        }
        return await this.runSwitch(params, context)
      }
      // host.agents.delete(name, { revision }) — privileged (issue 04). Routes through the injected
      // approval gateway, re-resolves name -> ID, verifies the reviewed revision, deletes via
      // SpecialistService, verifies absence, invalidates the catalog, and returns the read-back. Bound
      // conversations are NOT silently switched to Main Agent (design.md §10).
      if (opName === 'delete') return await this.runDelete(params, context)
      // The dispatcher covers every operation the contract names. An unrecognized op was already
      // rejected as unknown above, so this branch is unreachable for a validated op name.
      throw agentsPublicError(`Operation "${opName}" is not implemented yet`)
    } catch (error) {
      throw new AgentsCallError(opName, error)
    }
  }

  // Bridges this service's read methods to the ordinary-mutation module's catalog seam so the module
  // reuses the EXACT same skill/connector projection + name/id resolution the read slice uses — no
  // duplicated catalog rules. Built lazily per call.
  private mutationCatalog(): AgentsMutationCatalog {
    return {
      listSkills: async () => this.listSkills({}),
      listConnectors: async () => this.listConnectors({})
    }
  }

  // Backward-compatible read entry point. Existing callers and the 352 read tests keep using it; it
  // now delegates to dispatch() so read and write ops share one extension point. Keeping it means
  // the RPC route's current `agentsService.read(...)` call site and all existing tests stay green
  // while the route can switch to dispatch() without behavior change.
  async read(op: AgentsReadOp, context: TrustedCallingSession = {}): Promise<unknown> {
    return this.dispatch(op, context)
  }

  // host.agents.switch(nameOrNull) — the durable immediate-handoff lifecycle. Delegates
  // to the standalone SwitchOperation, which reuses the existing SessionBindingService + durable
  // persistence seam and broadcasts the pending-reconfigure notification through the injected
  // SwitchNotifier. Fail closed if the durable/binding seams are not configured. The trusted calling
  // session is threaded from server context; this module never reads a caller-supplied session id.
  private async runSwitch(
    params: Record<string, unknown>,
    context: TrustedCallingSession
  ): Promise<unknown> {
    const { approvalGateway, switchNotifier, sessionBinding, persistSessionSpecialist } = this.deps
    if (!approvalGateway || !switchNotifier || !sessionBinding || !persistSessionSpecialist) {
      throw agentsPublicError(
        'Operation "switch" is not configured (approval/binding/persistence seams missing)'
      )
    }
    const operation = new SwitchOperation({
      specialistService: this.deps.specialistService,
      sessionBinding,
      approvalGateway,
      switchNotifier,
      ...(this.deps.approvalLifecycle ? { approvalLifecycle: this.deps.approvalLifecycle } : {}),
      persistBinding: persistSessionSpecialist,
      sequencer: this.switchSequencer
    })
    const name = params.name
    const switchParams: SwitchParams = {
      ...(typeof name === 'string' || name === null ? { name } : {}),
      ...(typeof params.revision === 'number' ? { revision: params.revision } : {})
    }
    return operation.run(switchParams, context)
  }

  // host.agents.delete(name, { revision }) — privileged (issue 04). Approves via the injected gateway,
  // re-resolves name -> ID, verifies the reviewed revision, deletes via SpecialistService, verifies
  // absence, invalidates the catalog, and returns `{ status: "deleted", name }`. Session ID bindings
  // are NEVER cleared or rewritten — bound conversations resolve unavailable later (design.md §10).
  // The trusted calling session is threaded from server context (mirroring runSwitch) so the
  // ACP-backed approval gateway can park the delete card on the CALLING session — without it the
  // bridge reports "approval surface is unavailable" and declines.
  private async runDelete(
    params: Record<string, unknown>,
    context: TrustedCallingSession
  ): Promise<unknown> {
    const { approvalGateway, invalidateCatalog } = this.deps
    if (!approvalGateway) {
      throw agentsPublicError('Operation "delete" is not configured (approval gateway missing)')
    }
    const currentName = typeof params.name === 'string' ? params.name : undefined
    if (!currentName) throw agentsPublicError('name is required')
    const revision = params.revision
    if (
      typeof revision !== 'number' ||
      !Number.isFinite(revision) ||
      !Number.isInteger(revision) ||
      revision <= 0
    ) {
      throw agentsPublicError('revision must be a positive integer.')
    }
    return applyDelete({
      specialistService: this.deps.specialistService,
      decide: (request) => approvalGateway.decide(request),
      currentName,
      reviewedRevision: revision,
      session: context,
      ...(this.deps.deleteSpecialist ? { deleteSpecialist: this.deps.deleteSpecialist } : {}),
      ...(invalidateCatalog ? { invalidateCatalog } : {})
    })
  }

  // Returns custom Specialists only — never synthesizes the Settings-only Reviewer row.
  async list(): Promise<SpecialistSummaryReadModel[]> {
    const profiles = await this.deps.specialistService.list()
    return profiles.map(projectAgentSummary)
  }

  // Resolves the exact public Specialist name to the current configuration and returns a renderer-safe
  // read model including stable id and revision.
  async get(params: { name?: unknown }): Promise<SpecialistDetailReadModel> {
    const name = asString(params.name)
    if (!name) throw agentsPublicError('name is required')
    const profile = await this.deps.specialistService.getByName(name)
    return projectAgentDetail(profile)
  }

  // Returns the complete Specialist-visible skill catalog, including Main-disabled installed
  // Skills. Optional name_or_id filters to one entry via stable ID first, then immutable name.
  async listSkills(params: { name_or_id?: unknown }): Promise<SkillCatalogReadModel[]> {
    const catalog = await this.deps.catalog.listSkillCatalog()
    const entries = catalog.map((skill) => ({
      id: skill.id,
      // Immutable framework-facing invocation name; chips render displayName.
      name: skill.frameworkName,
      displayName: skill.displayName,
      source: skill.source,
      mainEnabled: skill.mainEnabled,
      available: skill.available
    }))
    return applyNameOrIdFilter(entries, params.name_or_id, 'list_skills')
  }

  // Returns public connector information useful for whole-Connector selection: stable id, display
  // name, description, Main enabled state, authentication/availability state, and safe public tool
  // information. Never returns credentials, headers, environment values, or connector arguments.
  async listConnectors(params: { name_or_id?: unknown }): Promise<ConnectorReadModel[]> {
    const stored = await this.deps.catalog.getConnectors()
    return applyNameOrIdFilter(this.projectConnectors(stored), params.name_or_id, 'list_connectors')
  }

  // Shared projection used by both the read slice and the ordinary-mutation module (issue 03), so
  // the mutation module never duplicates the connector catalog rules. Exported via the standalone
  // `projectConnectorsFromStored` below.
  private projectConnectors(stored: StoredConnectors | undefined): ConnectorReadModel[] {
    return projectConnectorsFromStored(stored, this.deps.customServerAvailability)
  }
}

// ---------------------------------------------------------------------------
// Standalone catalog projection + name-or-id resolution
// ---------------------------------------------------------------------------
//
// Exported so the ordinary-mutation module (issue 03) reuses the EXACT same connector projection and
// name/id ambiguity rules the read slice uses — no duplicated Full/Selected or catalog rules outside
// this file. Pure functions; no service state.

// Projects the stored connectors document into public read models. Never returns credentials,
// headers, environment values, or connector arguments.
export const projectConnectorsFromStored = (
  stored: StoredConnectors | undefined,
  customServerAvailability: (id: string) => CustomMcpFailureAvailability | undefined = () =>
    undefined
): ConnectorReadModel[] => {
  const disabled = new Set(stored?.disabledConnectorIds ?? [])
  const bundled: ConnectorReadModel[] = (CONNECTOR_CATALOG as ConnectorMeta[]).map((meta) => ({
    id: meta.id,
    name: meta.id,
    displayName: meta.displayName,
    description: meta.description,
    mainEnabled: !disabled.has(meta.id),
    availability: 'available',
    source: 'bundled',
    tools: getConnectorTools(meta.id).map((tool) => ({
      id: tool.id,
      description: tool.description
    }))
  }))

  const customServers = stored?.customMcpServers ?? []
  const custom: ConnectorReadModel[] = customServers
    .filter((server) => isCustomMcpServerRouteSafe(server, customServers))
    .map((server) => {
      const runtimeAvailability = customServerAvailability(server.id)
      const unreachable =
        (server.transport === 'stdio' && !server.command) ||
        (server.transport !== 'stdio' && !server.url)
      const credentialUnavailable = !hasUsableCustomMcpCredentials(server)
      const unauthenticated = Boolean(server.oauth && !server.oauthState?.tokens?.access_token)
      return {
        // Local Specialist references use the UUID; name remains the immutable public route.
        id: server.id,
        name: server.name,
        displayName: server.displayName,
        description: server.description ?? '',
        mainEnabled: server.enabled && !credentialUnavailable && !unauthenticated,
        // Custom MCP servers expose their tools dynamically; we do not enumerate them here (the
        // milestone decides whole-Connector inclusion only). An empty tools list keeps the shape
        // consistent without leaking transport/command details.
        availability: unreachable
          ? 'unavailable'
          : credentialUnavailable
            ? 'credential_unavailable'
            : unauthenticated
              ? 'unauthenticated'
              : (runtimeAvailability ?? 'available'),
        source: 'custom',
        tools: []
      }
    })

  return [...bundled, ...custom]
}

export { applyNameOrIdFilter }
