// A faithful fake `host.agents` SDK for the customize Skill contract tests.
//
// The real SDK lives in the control-plane REPL and is wired by issue 08. This fake implements the
// FULL public surface from design.md §4 / PRD §2 against in-memory state, so the customize Skill's
// workflow tests can exercise create/read/update/capability-update/delete/switch with the camelCase
// JavaScript contract, the monotonic revision, the
// structured decline result, and the sanitized `host.agents.<method>:` errors — without depending on
// the not-yet-built mutation modules (issues 03/04/05).
//
// The fake is intentionally faithful to the CONTRACT, not to ProfileService internals: it owns its
// own minimal profile records and catalogs. Behavior mirrors the rules in design.md §5 (capability
// semantics), §8 (revision + read-back), §10 (delete leaves bindings unavailable).

import type {
  AgentDetailReadModel,
  AgentSummaryReadModel,
  ConnectorReadModel,
  SkillCatalogReadModel
} from '../agents-service'

// ---------------------------------------------------------------------------
// Internal fake state
// ---------------------------------------------------------------------------

export type FakeProfileRecord = {
  id: string
  name: string
  displayName: string
  description: string
  systemPrompt: string
  iconKey?: string
  colorKey?: string
  enabled: boolean
  unrestricted: boolean
  skillIds: string[]
  connectorIds: string[]
  revision: number
}

export type FakeSkillCatalogEntry = SkillCatalogReadModel
export type FakeConnectorCatalogEntry = ConnectorReadModel

export type FakeHostAgentsOptions = {
  profiles?: FakeProfileRecord[]
  skills?: FakeSkillCatalogEntry[]
  connectors?: FakeConnectorCatalogEntry[]
  // Injected approval gateway + switch notifier, mirroring AgentsServiceDeps. Production wires the
  // real ACP broker; the customize Skill tests wire a recording fake.
  approvalGateway?: {
    decide: (request: {
      operation: 'delete' | 'switch'
      summary: { name?: string; newName?: string; target?: string | null }
    }) => Promise<{ status: 'approved' | 'declined'; reason?: string }>
  }
  switchNotifier?: { notify: (pending: { sessionId: string; targetName: string | null }) => void }
  // The trusted calling session captured outside the sandbox. switch() targets this only.
  callingSession?: { sessionId: string }
}

const METHOD_PREFIX = 'host.agents'

const agentsError = (method: string, message: string): Error => {
  const error = new Error(`${METHOD_PREFIX}.${method}: ${message}`)
  error.name = 'AgentsCallError'
  return error
}

const clone = <T>(value: T): T =>
  typeof structuredClone === 'function'
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T)

// ---------------------------------------------------------------------------
// The fake SDK
// ---------------------------------------------------------------------------

export class FakeHostAgents {
  private profiles: Map<string, FakeProfileRecord> = new Map()
  private readonly skills: FakeSkillCatalogEntry[]
  private readonly connectors: FakeConnectorCatalogEntry[]
  private readonly approvalGateway?: FakeHostAgentsOptions['approvalGateway']
  private readonly switchNotifier?: FakeHostAgentsOptions['switchNotifier']
  private readonly callingSession: { sessionId: string }
  // The persisted pending-switch binding; switch() mutates this and takes effect "on the next
  // message". Mirrors design.md §9.
  private binding: { sessionId: string; targetName: string | null } | undefined
  private nextId = 1

  constructor(options: FakeHostAgentsOptions = {}) {
    for (const profile of options.profiles ?? []) {
      this.profiles.set(profile.name, clone(profile))
    }
    this.skills = options.skills ? clone(options.skills) : []
    this.connectors = options.connectors ? clone(options.connectors) : []
    this.approvalGateway = options.approvalGateway
    this.switchNotifier = options.switchNotifier
    this.callingSession = options.callingSession ?? { sessionId: 'session-1' }
  }

  // ----- read models (camelCase) -------------------------------------------------

  // Validates that every supplied Skill/Connector reference resolves against the live catalog
  // (exact stable id first, otherwise unique immutable name). Mirrors the real catalog resolution so
  // the customize Skill's review reflects only attachable references. design.md §4.
  private validateCatalogRefs(
    skillNames: string[],
    connectorNames: string[],
    method: string
  ): void {
    for (const ref of skillNames) {
      if (!this.skills.some((s) => s.id === ref || s.name === ref)) {
        throw agentsError(method, `Unknown skill reference "${ref}"`)
      }
    }
    for (const ref of connectorNames) {
      if (!this.connectors.some((c) => c.id === ref || c.name === ref)) {
        throw agentsError(method, `Unknown connector reference "${ref}"`)
      }
    }
  }

  private projectSummary(profile: FakeProfileRecord): AgentSummaryReadModel {
    return {
      id: profile.id,
      name: profile.name,
      displayName: profile.displayName,
      description: profile.description,
      enabled: profile.enabled
    }
  }

  private project(profile: FakeProfileRecord): AgentDetailReadModel {
    return {
      id: profile.id,
      name: profile.name,
      displayName: profile.displayName,
      description: profile.description,
      systemPrompt: profile.systemPrompt,
      iconKey: profile.iconKey,
      colorKey: profile.colorKey,
      enabled: profile.enabled,
      capabilityMode: profile.unrestricted ? 'full' : 'selected',
      fullAccess: {
        excludedSkillIds: [],
        excludedConnectorIds: [],
        connectorTools: []
      },
      selectedCapabilities: {
        skillIds: profile.skillIds,
        connectorIds: profile.connectorIds,
        connectorTools: []
      },
      revision: profile.revision
    }
  }

  // ----- public read surface -----------------------------------------------------

  async list(): Promise<AgentSummaryReadModel[]> {
    return Array.from(this.profiles.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((profile) => this.projectSummary(profile))
  }

  async get(name: string): Promise<AgentDetailReadModel> {
    const profile = this.profiles.get(name)
    if (!profile) throw agentsError('get', `Specialist "${name}" not found.`)
    return this.project(profile)
  }

  async listSkills(nameOrId?: string): Promise<FakeSkillCatalogEntry[]> {
    if (!nameOrId) return clone(this.skills)
    return applyNameOrIdFilter(this.skills, nameOrId, 'listSkills')
  }

  async listConnectors(nameOrId?: string): Promise<FakeConnectorCatalogEntry[]> {
    if (!nameOrId) return clone(this.connectors)
    return applyNameOrIdFilter(this.connectors, nameOrId, 'listConnectors')
  }

  // ----- create ------------------------------------------------------------------

  async create(input: {
    name: string
    displayName?: string
    description?: string
    systemPrompt?: string
    iconKey?: string
    colorKey?: string
    enabled?: boolean
    unrestricted?: boolean
    skillNames?: string[]
    connectorNames?: string[]
  }): Promise<AgentDetailReadModel> {
    const method = 'create'
    const name = input.name
    if (!name || typeof name !== 'string') throw agentsError(method, 'name is required')
    if (this.profiles.has(name)) throw agentsError(method, `Specialist "${name}" already exists`)

    const hasSkillNames = input.skillNames !== undefined
    const hasConnectorNames = input.connectorNames !== undefined
    // design.md §5: omit both arrays => Full; supply either => Selected (omitted other => empty).
    const unrestricted =
      (input.unrestricted ?? !(hasSkillNames || hasConnectorNames)) ? true : false

    const skillNames = input.skillNames ?? (unrestricted ? [] : [])
    const connectorNames = input.connectorNames ?? (unrestricted ? [] : [])
    this.validateCatalogRefs(skillNames, connectorNames, method)

    const record: FakeProfileRecord = {
      id: `sp-${this.nextId++}`,
      name,
      displayName: input.displayName ?? name,
      description: input.description ?? '',
      systemPrompt: input.systemPrompt ?? '',
      iconKey: input.iconKey,
      colorKey: input.colorKey,
      enabled: input.enabled ?? true,
      unrestricted,
      skillIds: skillNames,
      connectorIds: connectorNames,
      revision: 1
    }
    this.profiles.set(name, record)
    return this.project(record)
  }

  // ----- update ------------------------------------------------------------------

  async update(
    name: string,
    patch: {
      displayName?: string
      description?: string
      systemPrompt?: string
      iconKey?: string
      colorKey?: string
      enabled?: boolean
      unrestricted?: boolean
      skillNames?: string[]
      connectorNames?: string[]
      revision?: number
    }
  ): Promise<AgentDetailReadModel> {
    const method = 'update'
    const existing = this.profiles.get(name)
    if (!existing) throw agentsError(method, `Specialist "${name}" not found.`)

    // design.md §8: carry the reviewed revision; stale => fail without merge/retry.
    if (patch.revision !== undefined && patch.revision !== existing.revision) {
      throw agentsError(method, 'stale revision — re-read and review again')
    }

    const next: FakeProfileRecord = { ...existing }
    next.displayName = patch.displayName ?? next.displayName
    next.description = patch.description ?? next.description
    next.systemPrompt = patch.systemPrompt ?? next.systemPrompt
    next.iconKey = patch.iconKey ?? next.iconKey
    next.colorKey = patch.colorKey ?? next.colorKey
    next.enabled = patch.enabled ?? next.enabled

    // design.md §5 capability semantics for update.
    if (patch.unrestricted === true) {
      next.unrestricted = true // switch to Full, preserve stored Selected config
    } else if (patch.skillNames !== undefined || patch.connectorNames !== undefined) {
      // Supplying a collection exactly replaces it and switches to Selected; omitted is preserved.
      next.unrestricted = false
      next.skillIds = patch.skillNames ?? next.skillIds
      next.connectorIds = patch.connectorNames ?? next.connectorIds
    }
    this.validateCatalogRefs(next.skillIds, next.connectorIds, method)

    next.revision = existing.revision + 1
    this.profiles.set(next.name, next)
    return this.project(next)
  }

  // ----- incremental attach/detach (single-collection, does not change mode) -----

  async attachSkill(
    name: string,
    skillRef: string,
    options: { revision?: number } = {}
  ): Promise<AgentDetailReadModel> {
    return this.mutateCollection(name, 'skill', skillRef, 'attach', options.revision)
  }

  async detachSkill(
    name: string,
    skillRef: string,
    options: { revision?: number } = {}
  ): Promise<AgentDetailReadModel> {
    return this.mutateCollection(name, 'skill', skillRef, 'detach', options.revision)
  }

  async attachConnector(
    name: string,
    connectorRef: string,
    options: { revision?: number } = {}
  ): Promise<AgentDetailReadModel> {
    return this.mutateCollection(name, 'connector', connectorRef, 'attach', options.revision)
  }

  async detachConnector(
    name: string,
    connectorRef: string,
    options: { revision?: number } = {}
  ): Promise<AgentDetailReadModel> {
    return this.mutateCollection(name, 'connector', connectorRef, 'detach', options.revision)
  }

  private mutateCollection(
    name: string,
    kind: 'skill' | 'connector',
    ref: string,
    action: 'attach' | 'detach',
    revision: number | undefined
  ): AgentDetailReadModel {
    const method = `${action}${kind[0].toUpperCase()}${kind.slice(1)}`
    const existing = this.profiles.get(name)
    if (!existing) throw agentsError(method, `Specialist "${name}" not found.`)
    if (revision !== undefined && revision !== existing.revision) {
      throw agentsError(method, 'stale revision — re-read and review again')
    }
    const collection = kind === 'skill' ? existing.skillIds : existing.connectorIds
    if (existing.unrestricted) {
      // Full mode: attach removes an exclusion (no-op here, no exclusions stored); detach adds one.
      // We model Full with no exclusions, so attach is a no-op and detach is rejected as it would
      // require storing an exclusion the fake does not model. Ordinary update({unrestricted}) is the
      // documented path for mode switches.
      if (action === 'detach') {
        throw agentsError(method, 'detach in Full mode is not supported by this fake')
      }
    } else {
      const index = collection.indexOf(ref)
      if (action === 'attach' && index === -1) collection.push(ref)
      if (action === 'detach' && index !== -1) collection.splice(index, 1)
    }
    existing.revision += 1
    return this.project(existing)
  }

  // ----- delete ------------------------------------------------------------------

  async delete(
    name: string,
    options: { revision?: number } = {}
  ): Promise<{ status: 'deleted'; name: string } | { status: 'declined'; operation: 'delete' }> {
    const method = 'delete'
    const existing = this.profiles.get(name)
    if (!existing) throw agentsError(method, `Specialist "${name}" not found.`)
    if (options.revision !== undefined && options.revision !== existing.revision) {
      throw agentsError(method, 'stale revision — re-read and review again')
    }
    // design.md §10 / PRD §9: delete is privileged. The card is the single authorization point.
    const decision = await this.approvalGateway?.decide({
      operation: 'delete',
      summary: { name }
    })
    if (decision?.status === 'declined') {
      return { status: 'declined', operation: 'delete' }
    }
    this.profiles.delete(name)
    // design.md §10: existing session bindings are NOT rewritten; they resolve unavailable.
    return { status: 'deleted', name }
  }

  // ----- switch ------------------------------------------------------------------

  async switch(
    nameOrNull: string | null
  ): Promise<
    | { status: 'switched'; sessionBinding: { sessionId: string; targetName: string | null } }
    | { status: 'declined'; operation: 'switch' }
  > {
    const method = 'switch'
    if (nameOrNull !== null) {
      const existing = this.profiles.get(nameOrNull)
      if (!existing) throw agentsError(method, `Specialist "${nameOrNull}" not found.`)
    }
    // design.md §7/§9: switch is privileged; explain the impending action then invoke the SDK.
    const decision = await this.approvalGateway?.decide({
      operation: 'switch',
      summary: { target: nameOrNull }
    })
    if (decision?.status === 'declined') {
      return { status: 'declined', operation: 'switch' }
    }
    // design.md §9: persist immediately; takes effect on the next message (not this reply).
    this.binding = { sessionId: this.callingSession.sessionId, targetName: nameOrNull }
    this.switchNotifier?.notify(this.binding)
    return { status: 'switched', sessionBinding: this.binding }
  }

  // ----- test helpers ------------------------------------------------------------

  getPendingBinding(): { sessionId: string; targetName: string | null } | undefined {
    return this.binding ? clone(this.binding) : undefined
  }
}

// ---------------------------------------------------------------------------
// Shared name-or-id resolution (mirrors the real catalog read contract)
// ---------------------------------------------------------------------------

function applyNameOrIdFilter<T extends { id: string; name?: string; displayName?: string }>(
  entries: T[],
  ref: string,
  method: string
): T[] {
  const byId = entries.filter((entry) => entry.id === ref)
  if (byId.length > 0) return clone(byId)
  const byName = entries.filter((entry) => entry.name === ref)
  if (byName.length === 0) {
    throw agentsError(method, `No catalog entry matches "${ref}".`)
  }
  if (byName.length > 1) {
    throw agentsError(method, `Multiple catalog entries match "${ref}".`)
  }
  return clone(byName)
}
