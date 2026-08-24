import { randomUUID } from 'node:crypto'

import { createLogger } from '../logger'
import { SpecialistIdConflictError, SpecialistRepository } from './repository'
import type { StoredSpecialist } from './types'
import type {
  BuiltinSpecialistRegistryEntry,
  BuiltinSpecialistRegistryResult,
  PackageDiagnostic
} from '../../shared/specialist-package'
import type {
  BuiltinSpecialistEntry,
  SpecialistCatalogSnapshot,
  SpecialistProfileView,
  SpecialistListItem,
  CreateSpecialistInput,
  UpdateSpecialistInput,
  SpecialistCapabilityMode,
  SpecialistFullAccessConfig,
  SpecialistSelectedConfig
} from '../../shared/specialist'
import {
  inferSpecialistId,
  validateCreateSpecialistInput,
  validateUpdateSpecialistInput,
  emptyFullAccessConfig,
  emptySelectedConfig
} from '../../shared/specialist'
import { specialistContentModifiedSinceImport } from './package/validator'

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const isConnectorToolRuleArray = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every(
    (rule) =>
      rule &&
      typeof rule === 'object' &&
      typeof (rule as { connectorId?: unknown }).connectorId === 'string' &&
      (
        [
          (rule as { includedMethods?: unknown }).includedMethods,
          (rule as { excludedMethods?: unknown }).excludedMethods
        ] as unknown[]
      ).every((methods) => methods === undefined || isStringArray(methods)) &&
      [
        (rule as { includeToolsPattern?: unknown }).includeToolsPattern,
        (rule as { excludeToolsPattern?: unknown }).excludeToolsPattern
      ].every((pattern) => pattern === undefined || typeof pattern === 'string')
  )

const assertCapabilityConfigShape = (
  input: Pick<UpdateSpecialistInput, 'capabilityMode' | 'fullAccess' | 'selectedCapabilities'>
): void => {
  if (
    input.capabilityMode !== undefined &&
    input.capabilityMode !== 'full' &&
    input.capabilityMode !== 'selected'
  ) {
    throw new Error('Capability mode must be "full" or "selected".')
  }
  if (input.fullAccess !== undefined) {
    const config = input.fullAccess
    if (
      !config ||
      typeof config !== 'object' ||
      !isStringArray((config as SpecialistFullAccessConfig).excludedSkillIds) ||
      !isStringArray((config as SpecialistFullAccessConfig).excludedConnectorIds) ||
      !isConnectorToolRuleArray((config as SpecialistFullAccessConfig).connectorTools)
    ) {
      throw new Error('Full access capability configuration is invalid.')
    }
  }
  if (input.selectedCapabilities !== undefined) {
    const config = input.selectedCapabilities
    if (
      !config ||
      typeof config !== 'object' ||
      !isStringArray((config as SpecialistSelectedConfig).skillIds) ||
      !isStringArray((config as SpecialistSelectedConfig).connectorIds) ||
      !isConnectorToolRuleArray((config as SpecialistSelectedConfig).connectorTools)
    ) {
      throw new Error('Selected capabilities configuration is invalid.')
    }
  }
}

const log = createLogger('specialist.service')
const MAX_AVAILABLE_SPECIALIST_NAMES = 8

const specialistReferenceError = (
  reason: 'unknown' | 'ambiguous' | 'unavailable',
  profiles: readonly SpecialistProfileView[]
): Error => {
  const names = [
    ...new Set(
      profiles
        .filter((profile) => profile.enabled && profile.setupPending !== true)
        .map((profile) => profile.name.trim())
        .filter(Boolean)
    )
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  const listed = names.slice(0, MAX_AVAILABLE_SPECIALIST_NAMES)
  const availability =
    listed.length === 0
      ? 'No enabled Specialists are available.'
      : `Available Specialists: ${listed.join(', ')}${
          names.length > listed.length ? ' (list truncated).' : '.'
        }`
  return new Error(`Requested Specialist is ${reason}. ${availability}`)
}

export class SpecialistReadonlyError extends Error {
  readonly code = 'SPECIALIST_READ_ONLY' as const

  constructor(
    readonly targetKind: 'builtin' | 'reviewer' | 'marketplace',
    readonly specialistId: string
  ) {
    super(
      targetKind === 'reviewer'
        ? 'Reviewer is read-only.'
        : targetKind === 'marketplace'
          ? `Marketplace-managed Specialist ${specialistId} content is read-only.`
          : `Builtin Specialist ${specialistId} is read-only.`
    )
    this.name = 'SpecialistReadonlyError'
  }
}

export class BuiltinSpecialistConformanceError extends Error {
  constructor(readonly diagnostics: readonly PackageDiagnostic[]) {
    super(
      `Builtin Specialist conformance failed: ${diagnostics
        .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
        .join('; ')}`
    )
    this.name = 'BuiltinSpecialistConformanceError'
  }
}

// ---------------------------------------------------------------------------
// View projection
// ---------------------------------------------------------------------------

const toView = (s: StoredSpecialist): SpecialistProfileView => ({
  id: s.id,
  name: s.name,
  displayName: s.displayName ?? s.name,
  description: s.description,
  systemPrompt: s.systemPrompt,
  iconKey: s.iconKey,
  colorKey: s.colorKey,
  enabled: s.enabled,
  setupPending: s.setupPending ?? false,
  capabilityMode: s.capabilityMode,
  fullAccess: s.fullAccess,
  selectedCapabilities: s.selectedCapabilities,
  revision: s.revision,
  packageVersion: s.packageVersion,
  origin: s.origin,
  ownedSkillIds: s.ownedSkillIds,
  importBaseline: s.importBaseline,
  modifiedSinceImport:
    s.origin === 'imported' && s.importBaseline !== undefined
      ? specialistContentModifiedSinceImport({ ...s, importBaseline: s.importBaseline })
      : false
})

const MARKETPLACE_UPDATE_KEYS = new Set<keyof UpdateSpecialistInput>([
  'id',
  'revision',
  'iconKey',
  'colorKey'
])

const assertOptionalIdentityFieldShapes = (
  input: Pick<
    UpdateSpecialistInput,
    'description' | 'displayName' | 'systemPrompt' | 'iconKey' | 'colorKey' | 'packageVersion'
  >
): void => {
  const optionalTextFields = [
    ['description', input.description],
    ['display name', input.displayName],
    ['system prompt', input.systemPrompt],
    ['icon', input.iconKey],
    ['color', input.colorKey],
    ['package version', input.packageVersion]
  ] as const
  for (const [label, value] of optionalTextFields) {
    if (value !== undefined && typeof value !== 'string') {
      throw new Error(`${label[0].toUpperCase()}${label.slice(1)} must be a string.`)
    }
  }
}

const assertCreateInputShape = (input: CreateSpecialistInput): void => {
  if (!input || typeof input !== 'object' || typeof input.name !== 'string') {
    throw new Error('Name must be a string.')
  }
  if (input.id !== undefined && typeof input.id !== 'string') {
    throw new Error('ID must be a string.')
  }
  assertOptionalIdentityFieldShapes(input)

  if (
    input.capabilityMode !== undefined &&
    input.capabilityMode !== 'full' &&
    input.capabilityMode !== 'selected'
  ) {
    throw new Error('Capability mode must be "full" or "selected".')
  }
  assertCapabilityConfigShape(input)
}

// ---------------------------------------------------------------------------
// ProfileService
// ---------------------------------------------------------------------------

// The single domain service for Specialist Profiles.
// Settings, IPC handlers, and future SDK callers must use this — never bypass
// it to write directly to the repository.
export class ProfileService {
  private readonly listeners: Set<() => void> = new Set()
  private builtinEntriesPromise: Promise<readonly BuiltinSpecialistRegistryEntry[]> | undefined

  constructor(
    private readonly repo: SpecialistRepository,
    private readonly builtinRegistry?: { load(): Promise<BuiltinSpecialistRegistryResult> }
  ) {}

  private async builtinEntries(): Promise<readonly BuiltinSpecialistRegistryEntry[]> {
    if (!this.builtinRegistry) return []
    this.builtinEntriesPromise ??= this.builtinRegistry.load().then((result) => {
      const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
      if (errors.length > 0) throw new BuiltinSpecialistConformanceError(errors)
      return result.entries
    })
    return this.builtinEntriesPromise
  }

  private toBuiltinView(entry: BuiltinSpecialistRegistryEntry): BuiltinSpecialistEntry {
    return { ...entry, revision: 0 }
  }

  async ensureBuiltinCatalogReady(): Promise<void> {
    await this.builtinEntries()
  }

  private async assertMutableId(id: string): Promise<void> {
    if (id === 'reviewer') throw new SpecialistReadonlyError('reviewer', id)
    if ((await this.builtinEntries()).some((entry) => entry.id === id)) {
      throw new SpecialistReadonlyError('builtin', id)
    }
  }

  private async assertContentMutableId(id: string): Promise<void> {
    await this.assertMutableId(id)
    const specialist = (await this.repo.getAll()).specialists.find(
      (candidate) => candidate.id === id
    )
    if (specialist?.origin === 'marketplace') {
      throw new SpecialistReadonlyError('marketplace', id)
    }
  }

  private async assertCreatableName(name: string): Promise<void> {
    if (name.trim().toLowerCase() === 'reviewer') {
      throw new SpecialistReadonlyError('reviewer', 'reviewer')
    }
    const builtin = (await this.builtinEntries()).find(
      (entry) => entry.name.toLowerCase() === name.trim().toLowerCase()
    )
    if (builtin) throw new SpecialistReadonlyError('builtin', builtin.id)
  }

  // Returns all custom specialists as views (no Reviewer, no Main Agent, no None).
  async list(): Promise<SpecialistProfileView[]> {
    const doc = await this.repo.getAll()
    return doc.specialists.map(toView)
  }

  // Returns the full list for the Settings UI, including the built-in Reviewer placeholder.
  async listForSettings(): Promise<SpecialistListItem[]> {
    return (await this.listForSettingsSnapshot()).items
  }

  async listForSettingsSnapshot(): Promise<SpecialistCatalogSnapshot> {
    const [snapshot, builtin] = await Promise.all([
      this.repo.getAllWithIntegrity(),
      this.builtinEntries()
    ])
    const custom = snapshot.document.specialists.map(toView)
    const items: SpecialistListItem[] = custom.map((v) => ({ kind: 'custom' as const, ...v }))
    items.push(...builtin.map((entry) => this.toBuiltinView(entry)))
    items.push({ kind: 'reviewer', id: 'reviewer' })
    return { items, integrity: snapshot.integrity }
  }

  async resolveRunnableById(id: string): Promise<SpecialistProfileView> {
    const custom = await this.list()
    const customMatch = custom.find((profile) => profile.id === id)
    if (customMatch) return customMatch
    const builtin = (await this.builtinEntries()).find((entry) => entry.id === id)
    if (builtin) return this.toBuiltinView(builtin)
    throw new Error(`Runnable Specialist ${id} not found.`)
  }

  async resolveRunnableByName(name: string): Promise<SpecialistProfileView> {
    const custom = await this.list()
    const customMatch = custom.find((profile) => profile.name === name)
    if (customMatch) return customMatch
    const builtin = (await this.builtinEntries()).find((entry) => entry.name === name)
    if (builtin) return this.toBuiltinView(builtin)
    throw new Error(`Runnable Specialist "${name}" not found.`)
  }

  async resolveRunnableByReference(reference: string): Promise<SpecialistProfileView> {
    const profiles = [
      ...(await this.list()),
      ...(await this.builtinEntries()).map((entry) => this.toBuiltinView(entry))
    ]
    const byId = profiles.find((profile) => profile.id === reference)
    if (byId) {
      if (!byId.enabled || byId.setupPending === true) {
        throw specialistReferenceError('unavailable', profiles)
      }
      return byId
    }
    const byName = profiles.filter((profile) => profile.name === reference)
    if (byName.length === 0) throw specialistReferenceError('unknown', profiles)
    if (byName.length > 1) throw specialistReferenceError('ambiguous', profiles)
    const selected = byName[0]
    if (!selected.enabled || selected.setupPending === true) {
      throw specialistReferenceError('unavailable', profiles)
    }
    return selected
  }

  async getById(id: string): Promise<SpecialistProfileView> {
    const doc = await this.repo.getAll()
    const found = doc.specialists.find((s) => s.id === id)
    if (!found) throw new Error(`Specialist ${id} not found.`)
    return toView(found)
  }

  async getByName(name: string): Promise<SpecialistProfileView> {
    const doc = await this.repo.getAll()
    const found = doc.specialists.find((s) => s.name === name)
    if (!found) throw new Error(`Specialist "${name}" not found.`)
    return toView(found)
  }

  async resolveCustomMutationByName(name: string): Promise<SpecialistProfileView> {
    await this.assertCreatableName(name)
    return this.getByName(name)
  }

  async create(input: CreateSpecialistInput): Promise<SpecialistProfileView> {
    assertCreateInputShape(input)
    await this.assertCreatableName(input.name)

    const doc = await this.repo.getAll()
    const existingNames = doc.specialists.map((s) => s.name)
    const existingIds = new Map(doc.specialists.map((s) => [s.name, s.id]))
    const usedIds = new Set([
      'reviewer',
      ...doc.specialists.map((specialist) => specialist.id),
      ...(await this.builtinEntries()).map((specialist) => specialist.id)
    ])

    // Validate the required name and optional display name through the shared
    // boundary rules before constructing the persisted record.
    const errors = validateCreateSpecialistInput(input, existingNames, existingIds, [...usedIds])
    if (errors.length > 0) {
      throw new Error(errors.map((e) => e.message).join('; '))
    }

    const name = input.name
    const inferredId = inferSpecialistId(name)

    const stored: StoredSpecialist = {
      id: input.id ?? (inferredId && !usedIds.has(inferredId) ? inferredId : randomUUID()),
      name,
      displayName: input.displayName ?? name,
      description: input.description ?? '',
      systemPrompt: input.systemPrompt ?? '',
      iconKey: input.iconKey,
      colorKey: input.colorKey,
      enabled: true,
      setupPending: false,
      capabilityMode: input.capabilityMode ?? 'full',
      fullAccess: input.fullAccess ?? emptyFullAccessConfig(),
      selectedCapabilities: input.selectedCapabilities ?? emptySelectedConfig(),
      revision: 1,
      packageVersion: '0.1.0',
      origin: 'local',
      ownedSkillIds: []
    }

    try {
      await this.repo.insert(stored)
    } catch (error) {
      if (input.id !== undefined || !(error instanceof SpecialistIdConflictError)) {
        throw error
      }
      stored.id = randomUUID()
      await this.repo.insert(stored)
    }
    // Do NOT log systemPrompt content per cross-cutting requirement.
    log.info('creating specialist', { id: stored.id, name: stored.name })
    this.notify()
    return toView(stored)
  }

  async setEnabled(id: string, enabled: boolean): Promise<SpecialistProfileView> {
    if (typeof id !== 'string' || !id.trim()) {
      throw new Error('Specialist id must be a non-empty string.')
    }
    if (typeof enabled !== 'boolean') throw new Error('Enabled must be a boolean.')
    await this.assertMutableId(id)
    if (enabled) {
      const current = await this.getById(id)
      if (current.setupPending) {
        throw new Error('Complete Specialist setup before enabling it.')
      }
    }
    const updatedDoc = await this.repo.setEnabled(id, enabled)
    this.notify()
    const found = updatedDoc.specialists.find((s) => s.id === id)
    if (!found) throw new Error(`Specialist ${id} not found after setEnabled.`)
    return toView(found)
  }

  // Atomically patches presentation/instructions fields on an existing specialist.
  // The stable name is immutable. `revision` must match the stored record
  // (optimistic concurrency); the repository bumps it and rejects stale writes.
  async update(input: UpdateSpecialistInput): Promise<SpecialistProfileView> {
    if (!input || typeof input.id !== 'string' || typeof input.revision !== 'number') {
      throw new Error('Update requires id and revision.')
    }
    if ('name' in input) {
      throw new Error('Specialist name is immutable.')
    }
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
      throw new Error('Enabled must be a boolean.')
    }
    if (input.completeSetup !== undefined && input.completeSetup !== true) {
      throw new Error('Complete setup must be true when provided.')
    }
    await this.assertMutableId(input.id)
    assertOptionalIdentityFieldShapes(input)
    assertCapabilityConfigShape(input)

    const doc = await this.repo.getAll()
    const errors = validateUpdateSpecialistInput(input)
    if (errors.length > 0) {
      throw new Error(errors.map((e) => e.message).join('; '))
    }

    const current = doc.specialists.find((s) => s.id === input.id)
    if (!current) throw new Error(`Specialist ${input.id} not found.`)
    if (
      current.origin === 'marketplace' &&
      (Object.keys(input) as Array<keyof UpdateSpecialistInput>).some(
        (key) => !MARKETPLACE_UPDATE_KEYS.has(key)
      )
    ) {
      throw new SpecialistReadonlyError('marketplace', input.id)
    }

    const patch: Partial<StoredSpecialist> = {}
    if (input.completeSetup && !current?.setupPending) {
      throw new Error('Specialist setup is not pending.')
    }
    if (current?.setupPending && input.enabled === true && !input.completeSetup) {
      throw new Error('Complete Specialist setup before enabling it.')
    }
    if (input.packageVersion !== undefined) patch.packageVersion = input.packageVersion
    if (input.displayName !== undefined) {
      patch.displayName = input.displayName
    }
    if (input.description !== undefined) patch.description = input.description
    if (input.systemPrompt !== undefined) patch.systemPrompt = input.systemPrompt
    if (input.iconKey !== undefined) patch.iconKey = input.iconKey
    if (input.colorKey !== undefined) patch.colorKey = input.colorKey
    if (input.enabled !== undefined) patch.enabled = input.enabled
    if (input.completeSetup) {
      patch.setupPending = false
      patch.enabled = true
    }
    if (input.capabilityMode !== undefined) patch.capabilityMode = input.capabilityMode
    if (input.fullAccess !== undefined) patch.fullAccess = input.fullAccess
    if (input.selectedCapabilities !== undefined) {
      patch.selectedCapabilities = input.selectedCapabilities
    }

    log.info('updating specialist', { id: input.id })

    const updatedDoc = await this.repo.update(input.id, patch, input.revision)
    this.notify()
    const updated = updatedDoc.specialists.find((s) => s.id === input.id)
    if (!updated) throw new Error(`Specialist ${input.id} not found after update.`)
    return toView(updated)
  }

  async markMarketplaceManaged(
    id: string,
    expectedRevision: number
  ): Promise<SpecialistProfileView> {
    const current = await this.getById(id)
    if (current.revision !== expectedRevision) {
      throw new Error(`Revision conflict: expected ${expectedRevision}, found ${current.revision}.`)
    }
    if (current.origin === 'marketplace') return current
    if (current.origin !== 'imported' || !current.importBaseline) {
      throw new Error('Only an exact imported package can become Marketplace-managed.')
    }
    const updated = await this.repo.update(id, { origin: 'marketplace' }, expectedRevision)
    this.notify()
    const managed = updated.specialists.find((specialist) => specialist.id === id)
    if (!managed) throw new Error(`Specialist ${id} not found after Marketplace migration.`)
    return toView(managed)
  }

  async delete(id: string, expectedRevision?: number): Promise<void> {
    if (typeof id !== 'string' || !id.trim()) {
      throw new Error('Specialist id must be a non-empty string.')
    }
    if (
      expectedRevision !== undefined &&
      (!Number.isInteger(expectedRevision) || expectedRevision < 1)
    ) {
      throw new Error('Expected revision must be a positive integer.')
    }
    await this.assertMutableId(id)
    await this.repo.delete(id, expectedRevision)
    this.notify()
  }

  async duplicate(id: string): Promise<Omit<CreateSpecialistInput, 'name'> & { name: string }> {
    await this.assertMutableId(id)
    const source = await this.getById(id)
    const names = new Set((await this.list()).map((profile) => profile.name))
    // Use the current display label as the base for the new Specialist's identity.
    const sourceName = source.displayName ?? source.name
    const base = `${sourceName} Copy`
    let name = base.slice(0, 80)
    let suffix = 2
    while (names.has(name)) {
      const tail = ` ${suffix++}`
      name = `${base.slice(0, 80 - tail.length)}${tail}`
    }
    return {
      name,
      displayName: name,
      description: source.description,
      systemPrompt: source.systemPrompt,
      iconKey: source.iconKey,
      colorKey: source.colorKey,
      capabilityMode: source.capabilityMode,
      fullAccess: structuredClone(source.fullAccess),
      selectedCapabilities: structuredClone(source.selectedCapabilities)
    }
  }

  private async patchCollection(
    id: string,
    expectedRevision: number,
    mode: SpecialistCapabilityMode,
    field: 'skillIds' | 'connectorIds' | 'excludedSkillIds' | 'excludedConnectorIds',
    value: string,
    attach: boolean
  ): Promise<SpecialistProfileView> {
    await this.assertContentMutableId(id)
    const current = await this.getById(id)
    if (mode === 'full') {
      const config = structuredClone(current.fullAccess)
      const values = config[field as 'excludedSkillIds' | 'excludedConnectorIds']
      config[field as 'excludedSkillIds' | 'excludedConnectorIds'] = attach
        ? [...new Set([...values, value])]
        : values.filter((entry) => entry !== value)
      return this.update({ id, revision: expectedRevision, fullAccess: config })
    }
    const config = structuredClone(current.selectedCapabilities)
    const values = config[field as 'skillIds' | 'connectorIds']
    config[field as 'skillIds' | 'connectorIds'] = attach
      ? [...new Set([...values, value])]
      : values.filter((entry) => entry !== value)
    return this.update({ id, revision: expectedRevision, selectedCapabilities: config })
  }

  async attachSkill(
    id: string,
    skillId: string,
    expectedRevision: number,
    mode: SpecialistCapabilityMode = 'selected'
  ): Promise<SpecialistProfileView> {
    return this.patchCollection(
      id,
      expectedRevision,
      mode,
      mode === 'full' ? 'excludedSkillIds' : 'skillIds',
      skillId,
      mode !== 'full'
    )
  }

  async detachSkill(
    id: string,
    skillId: string,
    expectedRevision: number,
    mode: SpecialistCapabilityMode = 'selected'
  ): Promise<SpecialistProfileView> {
    return this.patchCollection(
      id,
      expectedRevision,
      mode,
      mode === 'full' ? 'excludedSkillIds' : 'skillIds',
      skillId,
      mode === 'full'
    )
  }

  async attachConnector(
    id: string,
    connectorId: string,
    expectedRevision: number,
    mode: SpecialistCapabilityMode = 'selected'
  ): Promise<SpecialistProfileView> {
    return this.patchCollection(
      id,
      expectedRevision,
      mode,
      mode === 'full' ? 'excludedConnectorIds' : 'connectorIds',
      connectorId,
      mode !== 'full'
    )
  }

  async detachConnector(
    id: string,
    connectorId: string,
    expectedRevision: number,
    mode: SpecialistCapabilityMode = 'selected'
  ): Promise<SpecialistProfileView> {
    return this.patchCollection(
      id,
      expectedRevision,
      mode,
      mode === 'full' ? 'excludedConnectorIds' : 'connectorIds',
      connectorId,
      mode === 'full'
    )
  }

  // Subscribes a listener to be called whenever the profile catalog changes.
  // Returns an unsubscribe function.
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        log.error('specialist catalog listener threw', { error })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createProfileService = (
  storageDir: string,
  builtinRegistry?: { load(): Promise<BuiltinSpecialistRegistryResult> }
): ProfileService => {
  return new ProfileService(new SpecialistRepository(storageDir), builtinRegistry)
}
