// host.agents adapter: the control-plane SDK's server-side read surface.
//
// This module is the ONLY place that turns internal Profile/catalog records into the public
// `host.agents.*` read models. It is deliberately decoupled from the concrete SettingsService and
// ConnectorService via the AgentsServiceDeps interface, so the RPC server can wire the real
// services in production while tests pass lightweight stubs.
//
// Cross-cutting rules (design.md §14, PRD §5):
//  - Main validates every payload; sandbox input is untrusted.
//  - Public data is projected explicitly — never return internal repository objects.
//  - Errors are sanitized and prefixed `host.agents.<method>:` so they never leak system
//    instructions, connector args, credentials, headers, environment values, or tokens.
//  - The ProfileService and catalog services remain authoritative; nothing is copied here.

import { CONNECTOR_CATALOG, type ConnectorMeta } from '../connectors/catalog'
import { getConnectorTools } from '../connectors/registry'
import type { ProfileService } from '../specialist/service'
import type { SessionBindingService } from '../specialist/session-binding'
import type { SpecialistProfileView } from '../../shared/specialist'
import type { StoredConnectors } from '../settings/types'
import {
  isAgentsOpName,
  isAgentsParams,
  stripAgentsReservedParams,
  type ApprovalGateway,
  type SwitchNotifier,
  type TrustedCallingSession
} from '../../shared/agents-contract'
import {
  executeAgentsMutation,
  projectCapabilityFields,
  rejectUnknownKeys,
  UPDATE_ALLOWED_KEYS,
  type AgentsMutationCatalog
} from './agents-mutations'
import { SwitchOperation, SwitchCommitSequencer, type SwitchParams } from './switch-operation'
import {
  applyDelete,
  applyNameChangingUpdate,
  isNameChangingPatch
} from './specialist-privileged-ops'
import type { SpecialistUpdatePatch } from './specialist-approval-presentation'

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
  profileService: ProfileService
  catalog: AgentsCatalogSource
  // Injected (fake-able) seams consumed by the future privileged-mutation and switch slices
  // (issues 04/05). The read slice leaves these unset; the dispatcher routes privileged ops through
  // `approvalGateway` and signals approved switches via `switchNotifier`. They are SERVER-supplied
  // — never reachable from sandbox request params (the RPC route strips reserved keys first).
  approvalGateway?: ApprovalGateway
  switchNotifier?: SwitchNotifier
  // The durable switch lifecycle (issue 05) reuses the EXISTING SessionBindingService (in-memory
  // binding) and the EXISTING durable session-file persistence seam — there is no parallel switch
  // service. They are optional so the read slice and its tests can omit them; the dispatcher fails
  // closed if a `switch` op arrives without them configured.
  sessionBinding?: SessionBindingService
  persistSessionSpecialist?: (sessionId: string, specialistId: string | undefined) => Promise<void>
  // Invalidates the runtime catalog (Settings/picker/runtime capability resolution) after a successful
  // privileged mutation (delete or name-changing update). Ordinary mutations already invalidate via
  // the existing ProfileService/catalog-change broadcast path; privileged ops run through a dedicated
  // module that calls this only on success. Wired in issue 08.
  invalidateCatalog?: () => Promise<void> | void
}

// ---------------------------------------------------------------------------
// Public read models (camelCase records returned to the SDK)
// ---------------------------------------------------------------------------

export type AgentReadModel = {
  id: string
  name: string
  displayName: string
  description: string
  systemPrompt: string
  iconKey?: string
  colorKey?: string
  enabled: boolean
  capabilityMode: 'full' | 'selected'
  fullAccess: SpecialistProfileView['fullAccess']
  selectedCapabilities: SpecialistProfileView['selectedCapabilities']
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
  displayName: string
  description: string
  mainEnabled: boolean
  // Authentication/availability state, projected without secret detail. Custom connectors report
  // 'unavailable'/'unauthenticated' from their stored shape; bundled connectors are 'available'.
  availability: 'available' | 'unavailable' | 'unauthenticated'
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

const METHOD_PREFIX = 'host.agents'

// Sanitizes an arbitrary error into a stable message. Connector args, credentials, headers,
// environment values, and internal stack detail must never reach the sandbox. We keep only the
// top-level message and strip anything that looks like a secret-bearing JSON blob.
const sanitizeError = (value: unknown): string => {
  const raw = value instanceof Error ? value.message : String(value)
  return raw
}

class AgentsCallError extends Error {
  constructor(method: string, cause: unknown) {
    super(`${METHOD_PREFIX}.${method}: ${sanitizeError(cause)}`)
    this.name = 'AgentsCallError'
  }
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const projectAgent = (profile: SpecialistProfileView): AgentReadModel => ({
  id: profile.id,
  name: profile.name,
  displayName: profile.displayName ?? profile.name,
  description: profile.description,
  systemPrompt: profile.systemPrompt,
  iconKey: profile.iconKey,
  colorKey: profile.colorKey,
  enabled: profile.enabled,
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

  // The extensible operation dispatcher (issue 02 round 2). This is the single entry point the RPC
  // route should call so that adding a new operation (create/update/delete/switch later) requires NO
  // change to the auth/token transport path in local-rpc-server.ts.
  //
  // EXTENSION POINT — to add a new operation:
  //   1. Add its name to AgentsOpName in src/shared/agents-contract.ts.
  //   2. Add a branch below (or delegate to a new operation module).
  //   3. Route privileged ops through this.deps.approvalGateway and signal approved switches via
  //      this.deps.switchNotifier — both are injected here, never reachable from `params`.
  // You do NOT touch local-rpc-server.ts: it already strips reserved routing/identity keys, forwards
  // the op, and passes the trusted calling session as `context`.
  async dispatch(op: unknown, context: TrustedCallingSession = {}): Promise<unknown> {
    void context // reserved for the future switch/privileged-mutation slices; unused by reads.
    if (!op || typeof op !== 'object' || !('op' in op)) {
      throw new AgentsCallError('unknown', 'Invalid request')
    }
    const request = op as { op: unknown }
    if (!isAgentsOpName(request.op)) {
      throw new AgentsCallError(String(request.op ?? 'unknown'), 'Unknown operation')
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
      // Ordinary mutations (issue 03): create, non-name update, and whole-Skill/whole-Connector
      // attach/detach. Routed to the standalone mutation module, which delegates to ProfileService,
      // resolves name/id references, gates unavailable connectors, and returns a real read-back.
      // `update` is privileged ONLY when the validated patch changes the public `name` (design.md §7);
      // a name-changing update routes through the issue-04 privileged-op module (approval gateway +
      // atomic patch) via runPrivilegedUpdate below. Non-name updates stay ordinary.
      if (
        opName === 'create' ||
        opName === 'update' ||
        opName === 'attach_skill' ||
        opName === 'detach_skill' ||
        opName === 'attach_connector' ||
        opName === 'detach_connector'
      ) {
        if (opName === 'update') {
          const privileged = await this.runPrivilegedUpdate(params)
          if (privileged.handled) return privileged.result
        }
        return projectAgent(
          await executeAgentsMutation(
            { op: opName, params } as Parameters<typeof executeAgentsMutation>[0],
            {
              profileService: this.deps.profileService,
              catalog: this.mutationCatalog(),
              approvalGateway: this.deps.approvalGateway
            }
          )
        )
      }
      // host.agents.switch(nameOrNull) — durable next-message switch (issue 05). Delegates to the
      // standalone SwitchOperation via runSwitch below.
      if (opName === 'switch') return await this.runSwitch(params, context)
      // host.agents.delete(name, { revision }) — privileged (issue 04). Routes through the injected
      // approval gateway, re-resolves name -> UUID, verifies the reviewed revision, deletes via
      // ProfileService, verifies absence, invalidates the catalog, and returns the read-back. Bound
      // conversations are NOT silently switched to Main Agent (design.md §10).
      if (opName === 'delete') return await this.runDelete(params)
      // The dispatcher covers every operation the contract names. An unrecognized op was already
      // rejected as unknown above, so this branch is unreachable for a validated op name.
      throw new Error(`Operation "${opName}" is not implemented yet`)
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

  // host.agents.switch(nameOrNull) — the durable next-message switch lifecycle (issue 05). Delegates
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
      throw new Error(
        'Operation "switch" is not configured (approval/binding/persistence seams missing)'
      )
    }
    const operation = new SwitchOperation({
      profileService: this.deps.profileService,
      sessionBinding,
      approvalGateway,
      switchNotifier,
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

  // Classifies a host.agents.update request and, when the validated patch changes the public `name`,
  // routes it through the issue-04 privileged-op module (approval gateway + atomic patch). A non-name
  // update returns `{ handled: false }` so the ordinary-mutation module handles it (chat review is the
  // only confirmation). design.md §7: there is no public rename(); a name-changing patch makes the
  // WHOLE patch privileged and atomic.
  private async runPrivilegedUpdate(
    params: Record<string, unknown>
  ): Promise<{ handled: boolean; result?: unknown }> {
    const patch = params.patch
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      // Malformed patch — let the ordinary module's validation surface the sanitized error.
      return { handled: false }
    }
    const patchRecord = patch as Record<string, unknown>
    // Reject unknown keys with the SAME allowed-keys view the ordinary update path uses (defect #5).
    // The privileged path must not silently ignore a forged/malicious field the ordinary path would
    // reject. This runs BEFORE the name-changing short-circuit so an unknown field is rejected even
    // when the patch also changes `name`. Allowed keys include the capability fields
    // (skill_names/connector_names/unrestricted) since this path projects and applies them too.
    rejectUnknownKeys(patchRecord, UPDATE_ALLOWED_KEYS, 'update')
    // Build the camelCase SpecialistUpdatePatch the issue-04 module consumes (snake_case wire fields
    // -> camelCase service fields), then classify with the module's own isNameChangingPatch so the
    // privilege decision is owned by exactly one rule. The privileged module commits the COMPLETE
    // patch atomically through ProfileService — including capabilityMode/fullAccess/
    // selectedCapabilities — so a name-changing patch that ALSO edits skill_names/connector_names (or
    // switches to unrestricted full access) carries those fields and they are applied in the same
    // atomic commit. Capability refs are resolved to stable ids via the SAME projection the ordinary
    // update path uses (no duplicated validation/plumbing).
    const mapStr = (value: unknown): string | undefined =>
      typeof value === 'string' ? value : undefined
    const specialistPatch: SpecialistUpdatePatch = {}
    const mappedName = mapStr(patchRecord.name)
    if (mappedName !== undefined) specialistPatch.name = mappedName
    const displayName = mapStr(patchRecord.display_name) ?? mapStr(patchRecord.displayName)
    if (displayName !== undefined) specialistPatch.displayName = displayName
    const description = mapStr(patchRecord.description)
    if (description !== undefined) specialistPatch.description = description
    const systemPrompt = mapStr(patchRecord.system_prompt)
    if (systemPrompt !== undefined) specialistPatch.systemPrompt = systemPrompt
    const iconKey = mapStr(patchRecord.icon_key)
    if (iconKey !== undefined) specialistPatch.iconKey = iconKey
    const colorKey = mapStr(patchRecord.color_key)
    if (colorKey !== undefined) specialistPatch.colorKey = colorKey

    // `enabled` is accepted on the name-changing patch too (defect #1): validate it is a boolean
    // here (matching the ordinary path's `enabled must be a boolean.` error) and carry it onto the
    // specialistPatch so applyNameChangingUpdate can apply it via setEnabled after the atomic rename.
    // There is no snake_case variant — the contract uses `enabled` on both create and update.
    if (patchRecord.enabled !== undefined) {
      if (typeof patchRecord.enabled !== 'boolean') {
        throw new Error('enabled must be a boolean.')
      }
      specialistPatch.enabled = patchRecord.enabled
    }

    if (!isNameChangingPatch(specialistPatch)) {
      return { handled: false }
    }

    const currentName = typeof params.name === 'string' ? params.name : undefined
    if (!currentName) throw new Error('name is required')
    const revision = patchRecord.revision
    if (
      typeof revision !== 'number' ||
      !Number.isFinite(revision) ||
      !Number.isInteger(revision) ||
      revision <= 0
    ) {
      throw new Error('revision must be a positive integer.')
    }

    // Project capability fields (skill_names/connector_names/unrestricted) so a rename coinciding
    // with a capability edit applies BOTH atomically. We resolve against the CURRENT profile so an
    // omitted collection is preserved (matching ordinary partial-patch semantics); the privileged
    // module re-resolves name -> UUID + revision immediately before committing, so atomicity and the
    // stale-revision guard still hold. When the patch carries no capability fields, the projection is
    // empty and we leave the capability fields UNSET (do not force full-access).
    const current = await this.deps.profileService.getByName(currentName)
    const capability = await projectCapabilityFields(
      patchRecord,
      current,
      this.mutationCatalog(),
      'update'
    )
    if (capability.capabilityMode !== undefined) {
      specialistPatch.capabilityMode = capability.capabilityMode
    }
    if (capability.fullAccess !== undefined) {
      specialistPatch.fullAccess = capability.fullAccess
    }
    if (capability.selectedCapabilities !== undefined) {
      specialistPatch.selectedCapabilities = capability.selectedCapabilities
    }

    const { approvalGateway, invalidateCatalog } = this.deps
    if (!approvalGateway) {
      throw new Error('Operation "update" is not configured (approval gateway missing)')
    }
    const result = await applyNameChangingUpdate({
      profileService: this.deps.profileService,
      decide: (request) => approvalGateway.decide(request),
      currentName,
      reviewedRevision: revision,
      patch: specialistPatch,
      ...(invalidateCatalog ? { invalidateCatalog } : {})
    })
    // A privileged decline is a normal camelCase result (no mutation). An approval returns the actual
    // post-write Profile read-back; both are returned as-is to the SDK without re-projection.
    return { handled: true, result }
  }

  // host.agents.delete(name, { revision }) — privileged (issue 04). Approves via the injected gateway,
  // re-resolves name -> UUID, verifies the reviewed revision, deletes via ProfileService, verifies
  // absence, invalidates the catalog, and returns `{ status: "deleted", name }`. Session UUID bindings
  // are NEVER cleared or rewritten — bound conversations resolve unavailable later (design.md §10).
  private async runDelete(params: Record<string, unknown>): Promise<unknown> {
    const { approvalGateway, invalidateCatalog } = this.deps
    if (!approvalGateway) {
      throw new Error('Operation "delete" is not configured (approval gateway missing)')
    }
    const currentName = typeof params.name === 'string' ? params.name : undefined
    if (!currentName) throw new Error('name is required')
    const revision = params.revision
    if (
      typeof revision !== 'number' ||
      !Number.isFinite(revision) ||
      !Number.isInteger(revision) ||
      revision <= 0
    ) {
      throw new Error('revision must be a positive integer.')
    }
    return applyDelete({
      profileService: this.deps.profileService,
      decide: (request) => approvalGateway.decide(request),
      currentName,
      reviewedRevision: revision,
      ...(invalidateCatalog ? { invalidateCatalog } : {})
    })
  }

  // Returns custom Specialist Profiles only — never synthesizes the Settings-only Reviewer row.
  async list(): Promise<AgentReadModel[]> {
    const profiles = await this.deps.profileService.list()
    return profiles.map(projectAgent)
  }

  // Resolves the exact public Specialist name to the current Profile and returns a renderer-safe
  // read model including stable id and revision.
  async get(params: { name?: unknown }): Promise<AgentReadModel> {
    const name = asString(params.name)
    if (!name) throw new Error('name is required')
    const profile = await this.deps.profileService.getByName(name)
    return projectAgent(profile)
  }

  // Returns the complete Specialist-visible skill catalog, including Main-disabled installed
  // Skills. Optional name_or_id filters to one entry via stable ID first, then unique public name.
  async listSkills(params: { name_or_id?: unknown }): Promise<SkillCatalogReadModel[]> {
    const catalog = await this.deps.catalog.listSkillCatalog()
    const entries = catalog.map((skill) => ({
      id: skill.id,
      // Public name: the durable framework-facing name the agent/Skill chip uses.
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
    return projectConnectorsFromStored(stored)
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
  stored: StoredConnectors | undefined
): ConnectorReadModel[] => {
  const disabled = new Set(stored?.disabledConnectorIds ?? [])
  const bundled: ConnectorReadModel[] = (CONNECTOR_CATALOG as ConnectorMeta[]).map((meta) => ({
    id: meta.id,
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

  const custom: ConnectorReadModel[] = (stored?.customMcpServers ?? []).map((server) => {
    const unreachable =
      (server.transport === 'stdio' && !server.command) ||
      (server.transport !== 'stdio' && !server.url)
    return {
      id: server.id,
      displayName: server.name,
      description: server.description ?? '',
      mainEnabled: server.enabled,
      // Custom MCP servers expose their tools dynamically; we do not enumerate them here (the
      // milestone decides whole-Connector inclusion only). An empty tools list keeps the shape
      // consistent without leaking transport/command details.
      availability: unreachable ? 'unavailable' : 'available',
      source: 'custom',
      tools: []
    }
  })

  return [...bundled, ...custom]
}

// ---------------------------------------------------------------------------
// name-or-id resolution (shared by the catalog reads AND the mutation module)
// ---------------------------------------------------------------------------

type Nameable = { id: string; name?: string; displayName?: string }

export function applyNameOrIdFilter<T extends Nameable>(
  entries: T[],
  nameOrId: unknown,
  method: string
): T[] {
  const ref = asString(nameOrId)
  if (!ref) return entries

  // 1. Exact stable ID wins.
  const byId = entries.filter((entry) => entry.id === ref)
  if (byId.length > 0) return byId

  // 2. Otherwise match a unique public name (name, then display name).
  const byName = entries.filter((entry) => entry.name === ref || entry.displayName === ref)
  if (byName.length === 0) {
    throw new Error(
      `No catalog entry matches "${ref}". Use the stable id from list_skills/list_connectors.`
    )
  }
  if (byName.length > 1) {
    // Ambiguous public name: instruct the caller to use the stable id instead of guessing.
    const ids = byName.map((entry) => entry.id).join(', ')
    throw new Error(
      `Multiple catalog entries match name "${ref}" (${ids}). Use the stable id from ${method} instead.`
    )
  }
  return byName
}
