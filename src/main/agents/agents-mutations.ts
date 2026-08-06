// host.agents ordinary-mutation operation module (issue 03).
//
// This module implements the ORDINARY Profile mutations + read-back: create, non-name update,
// enable/disable, and incremental whole-Skill/whole-Connector attach/detach. It is deliberately a
// standalone module so issue 08 can compose it into the shared dispatcher without changing issues
// 04/05. The privileged ops (delete, switch, and name-changing update) stay out of scope here — they
// require the injected approval gateway.
//
// Design rules (design.md §4/§5/§8, PRD §2/§4):
//  - ProfileService is the SINGLE domain mutation service. This module never writes the repository
//    directly and never re-implements the Full/Selected collection rules; it only translates the
//    public snake_case SDK input into ProfileService input and delegates.
//  - Every successful mutation returns an actual post-write camelCase Profile read-back, never an
//    echo of the requested input.
//  - Skill/Connector references resolve an exact catalog ID first, otherwise an unambiguous public
//    name, and persist only the stable ID.
//  - update/delete-style mutations require the current existing revision; a stale revision fails
//    without merge or retry (delegated to the repository's optimistic-concurrency check).
//  - Errors are sanitized and prefixed `host.agents.<method>:` so system instructions, connector
//    args, secrets, headers, environment values, and the RPC token never leak.
//  - Main validates every payload before reaching the repository: unknown, malformed, non-finite,
//    or wrong-shaped fields are rejected here.
//
// This module does NOT own conversational review or a permission card — that is the /customize Skill
// (later slice). Ordinary mutations do not request a system permission card.

import type { ConnectorReadModel, SkillCatalogReadModel } from './agents-service'
import { applyNameOrIdFilter } from './agents-service'
import type { ProfileService } from '../specialist/service'
import type { SpecialistProfileView } from '../../shared/specialist'
import type {
  CreateSpecialistInput,
  SpecialistCapabilityMode,
  SpecialistFullAccessConfig,
  SpecialistSelectedConfig
} from '../../shared/specialist'
import { emptyFullAccessConfig, emptySelectedConfig } from '../../shared/specialist'
import type { ApprovalGateway } from '../../shared/agents-contract'

// The catalog resolution seam this module consumes. It receives the ALREADY-PROJECTED public read
// models (the same models the read slice returns from list_skills/list_connectors), so this module
// never duplicates the connector catalog projection rules or the Full/Selected collection rules. In
// production this is wired to the AgentsService read methods; in tests it is stubbed directly.
export type AgentsMutationCatalog = {
  // The complete Specialist-visible skill catalog, including Main-disabled installed skills.
  listSkills(): Promise<SkillCatalogReadModel[]>
  // The complete Specialist-visible connector catalog, projected without secret material.
  listConnectors(): Promise<ConnectorReadModel[]>
}

// The dependency bundle this module needs. `approvalGateway` is accepted so the module signature is
// stable for the privileged slices, but ordinary mutations never call it (ordinary mutations do not
// request a system permission card).
export type AgentsMutationDeps = {
  profileService: ProfileService
  catalog: AgentsMutationCatalog
  approvalGateway?: ApprovalGateway
}

// The ordinary-mutation request union this module serves. The privileged ops (delete/switch) are
// intentionally NOT here.
export type AgentsOrdinaryMutationRequest =
  | { op: 'create'; params: Record<string, unknown> }
  | { op: 'update'; params: Record<string, unknown> }
  | { op: 'attach_skill'; params: Record<string, unknown> }
  | { op: 'detach_skill'; params: Record<string, unknown> }
  | { op: 'attach_connector'; params: Record<string, unknown> }
  | { op: 'detach_connector'; params: Record<string, unknown> }

const METHOD_PREFIX = 'host.agents'

// Sanitizes an arbitrary error into its top-level message only. System instructions, connector args,
// credentials, headers, environment values, internal stack detail, and tokens must never reach the
// sandbox. We keep only the message string (no nested secret-bearing JSON).
const sanitizeError = (value: unknown): string =>
  value instanceof Error ? value.message : String(value)

class AgentsMutationError extends Error {
  constructor(method: string, cause: unknown) {
    super(`${METHOD_PREFIX}.${method}: ${sanitizeError(cause)}`)
    this.name = 'AgentsMutationError'
  }
}

// ---------------------------------------------------------------------------
// Primitive payload guards
// ---------------------------------------------------------------------------

const isString = (value: unknown): value is string => typeof value === 'string'

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'

// A plain record (not null, not an array). Used to validate the nested update `patch` object.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Finite, non-NaN integer revision.
const isFinitePositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0

const optionalStringOrThrow = (value: unknown, label: string): string | undefined => {
  if (value === undefined) return undefined
  if (!isString(value)) throw new Error(`${label} must be a string.`)
  return value
}

// A string array of non-empty references (skill_names / connector_names). Rejects non-arrays,
// non-string elements, and empty-string entries. Duplicates are preserved as-is and de-duped later.
// Exported so the privileged name-changing update path (agents-service.runPrivilegedUpdate) reuses
// the EXACT validation the ordinary update path uses — no duplicated payload plumbing.
export const asStringArray = (value: unknown): string[] | undefined => {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => isString(item) && item.length > 0)) {
    throw new Error('Must be an array of non-empty strings.')
  }
  return value as string[]
}

// ---------------------------------------------------------------------------
// Catalog resolution (reuses the read slice's projection + name/id filter)
// ---------------------------------------------------------------------------

// Resolves each public name/id skill reference to its stable id via the read slice's name/id filter
// (exact id wins, otherwise a unique public name; ambiguity is rejected with a stable-id hint).
// Exported so the privileged name-changing update path reuses the same resolution.
export const resolveSkillRefs = async (
  catalog: AgentsMutationCatalog,
  refs: string[],
  method: string
): Promise<string[]> => {
  const entries = await catalog.listSkills()
  const ids: string[] = []
  for (const ref of refs) {
    const matched = applyNameOrIdFilter(entries, ref, method)
    if (matched.length === 0) {
      throw new Error(`No skill matches "${ref}".`)
    }
    ids.push(matched[0].id)
  }
  return ids
}

// Resolves each connector reference to its stable id and, when `gateUnavailable` is set (a NEW
// attachment via create/attach_connector/update connector_names), rejects a missing, unavailable, or
// unauthenticated custom connector. Existing stale references remain readable and removable via
// detach (which calls this with gateUnavailable=false). Exported so the privileged name-changing
// update path reuses the same resolution + gating.
export const resolveConnectorRefs = async (
  catalog: AgentsMutationCatalog,
  refs: string[],
  method: string,
  options: { gateUnavailable: boolean }
): Promise<{ ids: string[]; models: ConnectorReadModel[] }> => {
  const entries = await catalog.listConnectors()
  const ids: string[] = []
  const models: ConnectorReadModel[] = []
  for (const ref of refs) {
    const matched = applyNameOrIdFilter(entries, ref, method)
    if (matched.length === 0) {
      throw new Error(`No connector matches "${ref}".`)
    }
    const model = matched[0]
    if (options.gateUnavailable && model.availability !== 'available') {
      throw new Error(`Connector "${ref}" is ${model.availability} and cannot be newly attached.`)
    }
    ids.push(model.id)
    models.push(model)
  }
  return { ids, models }
}

// ---------------------------------------------------------------------------
// Shared capability projection (used by BOTH the ordinary update path AND the
// privileged name-changing update path so the two NEVER diverge)
// ---------------------------------------------------------------------------

// The capability-bearing slice of an UpdateSpecialistInput / SpecialistUpdatePatch. Returned
// partially: a field is present ONLY when the patch changed it (matching ordinary partial-patch
// semantics — omitted means "no change").
export type CapabilityProjection = {
  capabilityMode?: SpecialistCapabilityMode
  fullAccess?: SpecialistFullAccessConfig
  selectedCapabilities?: SpecialistSelectedConfig
}

// Projects the snake_case capability fields from a host.agents.update patch
// (skill_names / connector_names / unrestricted) into the camelCase service fields, resolving
// name/id references to stable ids via the shared catalog helpers. Semantics (mirrors the ordinary
// update path exactly):
//   - skill_names and/or connector_names present -> 'selected'; the provided collection is exactly
//     replaced (resolved to stable ids), the omitted collection is preserved from `current`, and
//     connectorTools is re-read from `current`. fullAccess is left unset.
//   - neither array present but unrestricted:true -> 'full' (Selected configuration preserved).
//   - neither -> returns an EMPTY projection (caller leaves capability fields unset; we do NOT
//     force full-access). This is what lets a rename-only patch leave capabilities untouched.
// `current` is the live profile the patch is being applied against (for preserving omitted
// collections and connectorTools). `method` scopes error messages.
export const projectCapabilityFields = async (
  patch: Record<string, unknown>,
  current: SpecialistProfileView,
  catalog: AgentsMutationCatalog,
  method: string
): Promise<CapabilityProjection> => {
  if (patch.unrestricted !== undefined && !isBoolean(patch.unrestricted)) {
    throw new Error('unrestricted must be a boolean.')
  }
  const skillRefs = asStringArray(patch.skill_names)
  const connectorRefs = asStringArray(patch.connector_names)
  const unrestricted = patch.unrestricted === true

  if (skillRefs !== undefined || connectorRefs !== undefined) {
    const baseSelected: SpecialistSelectedConfig = structuredClone(current.selectedCapabilities)
    if (skillRefs !== undefined) {
      baseSelected.skillIds = await resolveSkillRefs(catalog, skillRefs, method)
    }
    if (connectorRefs !== undefined) {
      baseSelected.connectorIds = (
        await resolveConnectorRefs(catalog, connectorRefs, method, {
          gateUnavailable: true
        })
      ).ids
    }
    baseSelected.connectorTools = current.selectedCapabilities.connectorTools
    return { capabilityMode: 'selected', selectedCapabilities: baseSelected }
  }
  if (unrestricted) {
    // update({ unrestricted: true }) switches to Full WITHOUT destroying the stored Selected
    // configuration. We only set the mode; selectedCapabilities is left untouched.
    return { capabilityMode: 'full' }
  }
  return {}
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

// The set of create fields the public SDK accepts. Anything else is rejected (cross-cutting:
// unknown fields must not reach the repository).
const CREATE_ALLOWED_KEYS = new Set([
  'name',
  'description',
  'system_prompt',
  'icon_key',
  'color_key',
  'enabled',
  'unrestricted',
  'skill_names',
  'connector_names'
])

const handleCreate = async (
  params: Record<string, unknown>,
  deps: AgentsMutationDeps
): Promise<SpecialistProfileView> => {
  rejectUnknownKeys(params, CREATE_ALLOWED_KEYS, 'create')

  const name = isString(params.name) ? params.name : throwShape('name is required')
  if (!name.trim()) throw new Error('name is required')

  const description = optionalStringOrThrow(params.description, 'description')
  const systemPrompt = optionalStringOrThrow(params.system_prompt, 'system prompt')
  const iconKey = optionalStringOrThrow(params.icon_key, 'icon key')
  const colorKey = optionalStringOrThrow(params.color_key, 'color key')

  // `enabled` is accepted (design.md §4 create object) but ProfileService.create always starts a
  // new specialist enabled; the update op toggles it. We validate the shape and ignore the value so
  // a malformed boolean is rejected before reaching the repository.
  if (params.enabled !== undefined && !isBoolean(params.enabled)) {
    throw new Error('enabled must be a boolean.')
  }

  if (params.unrestricted !== undefined && !isBoolean(params.unrestricted)) {
    throw new Error('unrestricted must be a boolean.')
  }
  // `unrestricted` is validated for shape but does not change create semantics here: the presence of
  // a capability array always produces Selected, and the absence of both always produces Full (AC).
  // The field is accepted so the agreed create object is honored; its value only affects update.

  const skillRefs = asStringArray(params.skill_names)
  const connectorRefs = asStringArray(params.connector_names)
  const hasCapabilities = skillRefs !== undefined || connectorRefs !== undefined

  const input: CreateSpecialistInput = {
    name,
    description,
    systemPrompt,
    iconKey,
    colorKey
  }

  if (hasCapabilities) {
    // Either capability array present -> Selected; omitted other array stored empty (AC).
    input.capabilityMode = 'selected'
    const skillIds = skillRefs ? await resolveSkillRefs(deps.catalog, skillRefs, 'create') : []
    const connectorIds = connectorRefs
      ? (
          await resolveConnectorRefs(deps.catalog, connectorRefs, 'create', {
            gateUnavailable: true
          })
        ).ids
      : []
    input.selectedCapabilities = {
      skillIds,
      connectorIds,
      connectorTools: []
    }
    input.fullAccess = emptyFullAccessConfig()
  } else {
    // Neither capability array present -> Full access (AC). `unrestricted: true` is an explicit
    // confirmation of the same default; either way the mode is Full and both configs start empty.
    input.capabilityMode = 'full'
    input.fullAccess = emptyFullAccessConfig()
    input.selectedCapabilities = emptySelectedConfig()
  }

  return deps.profileService.create(input)
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

// The set of update-patch keys the public SDK accepts. Anything else is rejected (cross-cutting:
// unknown fields must not reach the repository).
export const UPDATE_ALLOWED_KEYS = new Set([
  'name',
  'revision',
  'description',
  'system_prompt',
  'icon_key',
  'color_key',
  'enabled',
  'unrestricted',
  'skill_names',
  'connector_names'
])

const handleUpdate = async (
  params: Record<string, unknown>,
  deps: AgentsMutationDeps
): Promise<SpecialistProfileView> => {
  const name = isString(params.name) ? params.name : throwShape('name is required')

  // The patch is a NESTED object so a rename (patch.name) never collides with the lookup name
  // (params.name) on the wire — design.md §4 / customize-skill.md: `update(name, patch)` where the
  // patch may carry a new `name`. params.name resolves the target; every field in `patch` is a change.
  const patch = params.patch
  if (!isRecord(patch)) throw new Error('patch is required and must be an object.')
  rejectUnknownKeys(patch, UPDATE_ALLOWED_KEYS, 'update')

  const revision = patch.revision
  if (!isFinitePositiveInt(revision)) {
    throw new Error('revision must be a positive integer.')
  }

  const current = await deps.profileService.resolveCustomMutationByName(name)
  if (current.revision !== revision) {
    throw new Error('revision does not match the current specialist revision.')
  }

  const input: {
    id: string
    revision: number
    name?: string
    description?: string
    systemPrompt?: string
    iconKey?: string
    colorKey?: string
    capabilityMode?: SpecialistCapabilityMode
    fullAccess?: SpecialistFullAccessConfig
    selectedCapabilities?: SpecialistSelectedConfig
  } = { id: current.id, revision }

  // A rename (patch.name) is an ordinary chat-reviewed mutation like every other update field: the
  // revision guard above plus the atomic single-profile update are the only authority. An
  // uncustomized displayName follows the rename inside ProfileService.update, keeping the settings
  // list in sync without a display_name SDK field.
  const mappedName = optionalStringOrThrow(patch.name, 'name')
  if (mappedName !== undefined) input.name = mappedName
  const description = optionalStringOrThrow(patch.description, 'description')
  if (description !== undefined) input.description = description
  const systemPrompt = optionalStringOrThrow(patch.system_prompt, 'system prompt')
  if (systemPrompt !== undefined) input.systemPrompt = systemPrompt
  const iconKey = optionalStringOrThrow(patch.icon_key, 'icon key')
  if (iconKey !== undefined) input.iconKey = iconKey
  const colorKey = optionalStringOrThrow(patch.color_key, 'color key')
  if (colorKey !== undefined) input.colorKey = colorKey

  if (patch.enabled !== undefined && !isBoolean(patch.enabled)) {
    throw new Error('enabled must be a boolean.')
  }

  // Capability projection is shared with the privileged name-changing update path so the two NEVER
  // diverge on the Selected/Full + collection-replacement semantics.
  const capability = await projectCapabilityFields(patch, current, deps.catalog, 'update')
  if (capability.capabilityMode !== undefined) {
    input.capabilityMode = capability.capabilityMode
  }
  if (capability.selectedCapabilities !== undefined) {
    input.selectedCapabilities = capability.selectedCapabilities
  }
  if (capability.fullAccess !== undefined) {
    input.fullAccess = capability.fullAccess
  }

  // enabled lives on a separate ProfileService method (update() does not carry it). When the
  // requested state differs from the current, we toggle AFTER the identity/capability update so the
  // optimistic-concurrency check (revision) gates the whole mutation first, then setEnabled flips the
  // enabled flag. setEnabled is not revision-guarded, so ordering update-first is safe.
  let readBack = await deps.profileService.update(input)
  if (patch.enabled !== undefined && patch.enabled !== readBack.enabled) {
    readBack = await deps.profileService.setEnabled(current.id, patch.enabled)
  }
  return readBack
}

// ---------------------------------------------------------------------------
// attach / detach
// ---------------------------------------------------------------------------

type AttachDetachOp = 'attach_skill' | 'detach_skill' | 'attach_connector' | 'detach_connector'

const ATTACH_DETACH_ALLOWED_KEYS = new Set(['name', 'revision', 'skill_ref', 'connector_ref'])

const handleAttachDetach = async (
  op: AttachDetachOp,
  params: Record<string, unknown>,
  deps: AgentsMutationDeps
): Promise<SpecialistProfileView> => {
  rejectUnknownKeys(params, ATTACH_DETACH_ALLOWED_KEYS, op)

  const name = isString(params.name) ? params.name : throwShape('name is required')
  const revision = params.revision
  if (!isFinitePositiveInt(revision)) {
    throw new Error('revision must be a positive integer.')
  }

  const refKey = op.endsWith('skill') ? 'skill_ref' : 'connector_ref'
  const ref = isString(params[refKey])
    ? (params[refKey] as string)
    : throwShape(`${refKey} is required`)

  const current = await deps.profileService.resolveCustomMutationByName(name)
  if (current.revision !== revision) {
    throw new Error('revision does not match the current specialist revision.')
  }
  const mode: SpecialistCapabilityMode = current.capabilityMode

  // attach resolves the reference to a stable id (and gates unavailable custom connectors). detach is
  // a removal, so an existing STALE reference that no longer appears in the catalog must still be
  // removable (design.md §5: "existing stale references remain readable and removable"). We try to
  // resolve first (so a public name still works), but on detach we fall back to the literal reference
  // as the stable id when nothing matches.
  let stableId: string
  if (op.endsWith('skill')) {
    stableId =
      op === 'attach_skill'
        ? (await resolveSkillRefs(deps.catalog, [ref], op))[0]
        : await resolveOrPassThrough(await deps.catalog.listSkills(), ref, op)
  } else {
    const gateUnavailable = op === 'attach_connector'
    stableId =
      op === 'attach_connector'
        ? (await resolveConnectorRefs(deps.catalog, [ref], op, { gateUnavailable })).ids[0]
        : await resolveOrPassThrough(await deps.catalog.listConnectors(), ref, op)
  }

  if (op === 'attach_skill')
    return deps.profileService.attachSkill(current.id, stableId, revision, mode)
  if (op === 'detach_skill')
    return deps.profileService.detachSkill(current.id, stableId, revision, mode)
  if (op === 'attach_connector') {
    return deps.profileService.attachConnector(current.id, stableId, revision, mode)
  }
  return deps.profileService.detachConnector(current.id, stableId, revision, mode)
}

// Resolves a reference to a stable id when it matches the catalog, otherwise returns the literal
// reference unchanged. Used by detach so a stale reference (no longer in the catalog) can still be
// removed. attach never uses this — it must reject unknown references.
const resolveOrPassThrough = async <T extends SkillCatalogReadModel | ConnectorReadModel>(
  entries: T[],
  ref: string,
  method: string
): Promise<string> => {
  try {
    const matched = applyNameOrIdFilter(entries, ref, method)
    if (matched.length > 0) return matched[0].id
  } catch {
    // Ambiguity on a detach is harmless: fall back to the literal reference.
  }
  return ref
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Exported so the privileged name-changing update path reuses the EXACT unknown-key rejection the
// ordinary path uses (defect #5). Throws a sanitized `Unknown field "<key>".` error.
export function rejectUnknownKeys(
  params: Record<string, unknown>,
  allowed: Set<string>,
  method: string
): void {
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown field "${key}".`)
    }
  }
  void method
}

function throwShape(message: string): never {
  throw new Error(message)
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

// Executes one ordinary-mutation request and returns a real post-write Profile read-back. Wraps any
// thrown error in a sanitized `host.agents.<method>:` error. This is the seam issue 08 composes into
// the shared dispatcher.
export async function executeAgentsMutation(
  request: AgentsOrdinaryMutationRequest,
  deps: AgentsMutationDeps
): Promise<SpecialistProfileView> {
  const method = request.op
  const params = request.params
  try {
    switch (method) {
      case 'create':
        return await handleCreate(params, deps)
      case 'update':
        return await handleUpdate(params, deps)
      case 'attach_skill':
      case 'detach_skill':
      case 'attach_connector':
      case 'detach_connector':
        return await handleAttachDetach(method, params, deps)
      default:
        // Exhaustiveness guard: the switch covers every ordinary-mutation op.
        throw new Error(`Operation "${String(method)}" is not an ordinary mutation.`)
    }
  } catch (error) {
    throw new AgentsMutationError(method, error)
  }
}
