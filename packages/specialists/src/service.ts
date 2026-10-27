import { SpecialistError, specialistError } from './errors'
import { randomUUID } from 'node:crypto'
import { silentLogger, type SpecialistLogger } from './ports'
import { SpecialistIdConflictError, SpecialistRepository } from './repository'
import type { StoredSpecialist } from './types'
import type {
  BuiltinSpecialistRegistryEntry,
  BuiltinSpecialistRegistryResult,
  PackageDiagnostic
} from './archive-contracts'
import type {
  BuiltinSpecialistEntry,
  SpecialistCatalogSnapshot,
  SpecialistView,
  CreateSpecialistInput,
  UpdateSpecialistInput,
  SpecialistCapabilityMode,
  SpecialistFullAccessConfig,
  SpecialistSelectedConfig
} from './contracts'
import {
  CONNECTOR_TOOL_PATTERN_MAX_LENGTH,
  CONNECTOR_TOOL_RULE_MAX_COUNT,
  inferSpecialistId,
  validateCreateSpecialistInput,
  validateUpdateSpecialistInput,
  emptyFullAccessConfig,
  emptySelectedConfig
} from './contracts'
import { specialistContentModifiedSinceImport } from './package/validator'

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const isConnectorToolRuleArray = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length <= CONNECTOR_TOOL_RULE_MAX_COUNT &&
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
      ].every(
        (pattern) =>
          pattern === undefined ||
          (typeof pattern === 'string' &&
            pattern.length > 0 &&
            pattern.length <= CONNECTOR_TOOL_PATTERN_MAX_LENGTH)
      )
  )

const assertCapabilityConfigShape = (
  input: Pick<UpdateSpecialistInput, 'capabilityMode' | 'fullAccess' | 'selectedCapabilities'>
): void => {
  if (
    input.capabilityMode !== undefined &&
    input.capabilityMode !== 'full' &&
    input.capabilityMode !== 'selected'
  ) {
    throw specialistError('Capability mode must be "full" or "selected".')
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
      throw specialistError('Full access capability configuration is invalid.')
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
      throw specialistError('Selected capabilities configuration is invalid.')
    }
  }
}

const MAX_AVAILABLE_SPECIALIST_NAMES = 8

const specialistReferenceError = (
  reason: 'unknown' | 'ambiguous' | 'unavailable',
  profiles: readonly SpecialistView[]
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
  return specialistError(`Requested Specialist is ${reason}. ${availability}`)
}

export class SpecialistReadonlyError extends SpecialistError {
  readonly code = 'SPECIALIST_READ_ONLY' as const
  constructor(
    readonly targetKind: string,
    readonly specialistId: string,
    message = `Specialist ${specialistId} is read-only.`
  ) {
    super(message)
    this.name = 'SpecialistReadonlyError'
  }
}
export type SpecialistPolicy = {
  reservedIds?: readonly string[]
  assertMutableId?(id: string): void
  assertCreatableName?(name: string): void
  assertContentMutable?(profile: SpecialistView): void
  assertUpdate?(profile: SpecialistView, input: UpdateSpecialistInput): void
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

const toView = (s: StoredSpecialist): SpecialistView => ({
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
      throw specialistError(`${label[0].toUpperCase()}${label.slice(1)} must be a string.`)
    }
  }
}

const assertCreateInputShape = (input: CreateSpecialistInput): void => {
  if (!input || typeof input !== 'object' || typeof input.name !== 'string') {
    throw specialistError('Name must be a string.')
  }
  if (input.id !== undefined && typeof input.id !== 'string') {
    throw specialistError('ID must be a string.')
  }
  assertOptionalIdentityFieldShapes(input)

  if (
    input.capabilityMode !== undefined &&
    input.capabilityMode !== 'full' &&
    input.capabilityMode !== 'selected'
  ) {
    throw specialistError('Capability mode must be "full" or "selected".')
  }
  assertCapabilityConfigShape(input)
}

// ---------------------------------------------------------------------------
// SpecialistService
// ---------------------------------------------------------------------------

// The single domain service for Specialists.
// Settings, IPC handlers, and future SDK callers must use this — never bypass
// it to write directly to the repository.
export class SpecialistService {
  private readonly listeners: Set<() => void> = new Set()
  private builtinEntriesPromise: Promise<readonly BuiltinSpecialistRegistryEntry[]> | undefined

  constructor(
    private readonly repo: SpecialistRepository,
    private readonly builtinRegistry?: { load(): Promise<BuiltinSpecialistRegistryResult> },
    private readonly withMutationRecoveryBarrier?: <T>(operation: () => Promise<T>) => Promise<T>,
    private readonly policy: SpecialistPolicy = {},
    private readonly log: SpecialistLogger = silentLogger
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
    this.policy.assertMutableId?.(id)
    if ((await this.builtinEntries()).some((entry) => entry.id === id)) {
      throw new SpecialistReadonlyError('builtin', id)
    }
  }

  private async assertContentMutableId(id: string): Promise<void> {
    await this.assertMutableId(id)
    const specialist = (await this.repo.getAll()).specialists.find(
      (candidate) => candidate.id === id
    )
    if (specialist) this.policy.assertContentMutable?.(toView(specialist))
  }

  private async assertCreatableName(name: string): Promise<void> {
    this.policy.assertCreatableName?.(name)
    const builtin = (await this.builtinEntries()).find(
      (entry) => entry.name.toLowerCase() === name.trim().toLowerCase()
    )
    if (builtin) throw new SpecialistReadonlyError('builtin', builtin.id)
  }

  // Returns user-stored profiles without synthetic application entries.
  async list(): Promise<SpecialistView[]> {
    const doc = await this.repo.getAll()
    return doc.specialists.map(toView)
  }

  // Returns the catalog with its integrity status.
  async listCatalog(): Promise<SpecialistCatalogSnapshot['items']> {
    return (await this.catalogSnapshot()).items
  }

  async catalogSnapshot(): Promise<SpecialistCatalogSnapshot> {
    const [snapshot, builtin] = await Promise.all([
      this.repo.getAllWithIntegrity(),
      this.builtinEntries()
    ])
    const custom = snapshot.document.specialists.map(toView)
    const items: SpecialistCatalogSnapshot['items'] = custom.map((v) => ({
      kind: 'custom' as const,
      ...v
    }))
    items.push(...builtin.map((entry) => this.toBuiltinView(entry)))
    return { items, integrity: snapshot.integrity }
  }

  private async listRunnableCustom(): Promise<SpecialistView[]> {
    const snapshot = await this.repo.getAllWithIntegrity()
    return snapshot.document.specialists
      .filter((profile) => !snapshot.invalidCapabilityIds.has(profile.id))
      .map(toView)
  }

  async resolveRunnableById(id: string): Promise<SpecialistView> {
    const snapshot = await this.repo.getAllWithIntegrity()
    const customMatch = snapshot.document.specialists.find(
      (profile) => profile.id === id && !snapshot.invalidCapabilityIds.has(id)
    )
    if (customMatch) return toView(customMatch)
    const builtin = (await this.builtinEntries()).find((entry) => entry.id === id)
    if (builtin) return this.toBuiltinView(builtin)
    this.log.warn('runnable specialist lookup failed', {
      operation: 'specialist-resolution',
      phase: 'profile',
      specialistId: id,
      reason: snapshot.invalidCapabilityIds.has(id) ? 'invalid-capabilities' : 'not-found'
    })
    throw specialistError(`Runnable Specialist ${id} not found.`)
  }

  async resolveRunnableByName(name: string): Promise<SpecialistView> {
    const custom = await this.listRunnableCustom()
    const customMatch = custom.find((profile) => profile.name === name)
    if (customMatch) return customMatch
    const builtin = (await this.builtinEntries()).find((entry) => entry.name === name)
    if (builtin) return this.toBuiltinView(builtin)
    throw specialistError(`Runnable Specialist "${name}" not found.`)
  }

  async resolveRunnableByReference(reference: string): Promise<SpecialistView> {
    const profiles = [
      ...(await this.listRunnableCustom()),
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

  async getById(id: string): Promise<SpecialistView> {
    const doc = await this.repo.getAll()
    const found = doc.specialists.find((s) => s.id === id)
    if (!found) throw specialistError(`Specialist ${id} not found.`)
    return toView(found)
  }

  async getByName(name: string): Promise<SpecialistView> {
    const doc = await this.repo.getAll()
    const found = doc.specialists.find((s) => s.name === name)
    if (!found) throw specialistError(`Specialist "${name}" not found.`)
    return toView(found)
  }

  async resolveCustomMutationByName(name: string): Promise<SpecialistView> {
    await this.assertCreatableName(name)
    return this.getByName(name)
  }

  create(input: CreateSpecialistInput): Promise<SpecialistView> {
    const run = (): Promise<SpecialistView> => this.createAfterRecovery(input)
    return this.withMutationRecoveryBarrier ? this.withMutationRecoveryBarrier(run) : run()
  }

  private async createAfterRecovery(input: CreateSpecialistInput): Promise<SpecialistView> {
    assertCreateInputShape(input)
    await this.assertCreatableName(input.name)

    const doc = await this.repo.getAll()
    const existingNames = doc.specialists.map((s) => s.name)
    const existingIds = new Map(doc.specialists.map((s) => [s.name, s.id]))
    const usedIds = new Set([
      ...(this.policy.reservedIds ?? []),
      ...doc.specialists.map((specialist) => specialist.id),
      ...(await this.builtinEntries()).map((specialist) => specialist.id)
    ])

    // Validate the required name and optional display name through the shared
    // boundary rules before constructing the persisted record.
    const errors = validateCreateSpecialistInput(input, existingNames, existingIds, [...usedIds])
    if (errors.length > 0) {
      throw specialistError(errors.map((e) => e.message).join('; '))
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
    this.log.info('creating specialist', { id: stored.id, name: stored.name })
    this.notify()
    return toView(stored)
  }

  setEnabled(id: string, enabled: boolean): Promise<SpecialistView> {
    const run = (): Promise<SpecialistView> => this.setEnabledAfterRecovery(id, enabled)
    return this.withMutationRecoveryBarrier ? this.withMutationRecoveryBarrier(run) : run()
  }

  private async setEnabledAfterRecovery(id: string, enabled: boolean): Promise<SpecialistView> {
    if (typeof id !== 'string' || !id.trim()) {
      throw specialistError('Specialist id must be a non-empty string.')
    }
    if (typeof enabled !== 'boolean') throw specialistError('Enabled must be a boolean.')
    await this.assertMutableId(id)
    if (enabled) {
      const current = await this.getById(id)
      if (current.setupPending) {
        throw specialistError('Complete Specialist setup before enabling it.')
      }
    }
    const updatedDoc = await this.repo.setEnabled(id, enabled)
    this.notify()
    const found = updatedDoc.specialists.find((s) => s.id === id)
    if (!found) throw specialistError(`Specialist ${id} not found after setEnabled.`)
    return toView(found)
  }

  // Atomically patches presentation/instructions fields on an existing specialist.
  // The stable name is immutable. `revision` must match the stored record
  // (optimistic concurrency); the repository bumps it and rejects stale writes.
  update(input: UpdateSpecialistInput): Promise<SpecialistView> {
    const run = (): Promise<SpecialistView> => this.updateAfterRecovery(input)
    return this.withMutationRecoveryBarrier ? this.withMutationRecoveryBarrier(run) : run()
  }

  private async updateAfterRecovery(input: UpdateSpecialistInput): Promise<SpecialistView> {
    if (!input || typeof input.id !== 'string' || typeof input.revision !== 'number') {
      throw specialistError('Update requires id and revision.')
    }
    if ('name' in input) {
      throw specialistError('Specialist name is immutable.')
    }
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
      throw specialistError('Enabled must be a boolean.')
    }
    if (input.completeSetup !== undefined && input.completeSetup !== true) {
      throw specialistError('Complete setup must be true when provided.')
    }
    await this.assertMutableId(input.id)
    assertOptionalIdentityFieldShapes(input)
    assertCapabilityConfigShape(input)

    const doc = await this.repo.getAll()
    const errors = validateUpdateSpecialistInput(input)
    if (errors.length > 0) {
      throw specialistError(errors.map((e) => e.message).join('; '))
    }

    const current = doc.specialists.find((s) => s.id === input.id)
    if (!current) throw specialistError(`Specialist ${input.id} not found.`)
    this.policy.assertUpdate?.(current, input)

    const patch: Partial<StoredSpecialist> = {}
    if (input.completeSetup && !current?.setupPending) {
      throw specialistError('Specialist setup is not pending.')
    }
    if (current?.setupPending && input.enabled === true && !input.completeSetup) {
      throw specialistError('Complete Specialist setup before enabling it.')
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

    this.log.info('updating specialist', { id: input.id })

    const updatedDoc = await this.repo.update(input.id, patch, input.revision)
    this.notify()
    const updated = updatedDoc.specialists.find((s) => s.id === input.id)
    if (!updated) throw specialistError(`Specialist ${input.id} not found after update.`)
    return toView(updated)
  }

  /** Compare-and-set provenance after an external installer has established its own receipt. */
  changeOrigin(
    id: string,
    expectedRevision: number,
    origin: StoredSpecialist['origin']
  ): Promise<SpecialistView> {
    const run = (): Promise<SpecialistView> =>
      this.changeOriginAfterRecovery(id, expectedRevision, origin)
    return this.withMutationRecoveryBarrier ? this.withMutationRecoveryBarrier(run) : run()
  }

  private async changeOriginAfterRecovery(
    id: string,
    expectedRevision: number,
    origin: StoredSpecialist['origin']
  ): Promise<SpecialistView> {
    await this.repo.update(id, { origin }, expectedRevision)
    this.notify()
    return this.getById(id)
  }

  delete(id: string, expectedRevision?: number): Promise<void> {
    const run = (): Promise<void> => this.deleteAfterRecovery(id, expectedRevision)
    return this.withMutationRecoveryBarrier ? this.withMutationRecoveryBarrier(run) : run()
  }

  private async deleteAfterRecovery(id: string, expectedRevision?: number): Promise<void> {
    if (typeof id !== 'string' || !id.trim()) {
      throw specialistError('Specialist id must be a non-empty string.')
    }
    if (
      expectedRevision !== undefined &&
      (!Number.isInteger(expectedRevision) || expectedRevision < 1)
    ) {
      throw specialistError('Expected revision must be a positive integer.')
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
  ): Promise<SpecialistView> {
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
  ): Promise<SpecialistView> {
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
  ): Promise<SpecialistView> {
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
  ): Promise<SpecialistView> {
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
  ): Promise<SpecialistView> {
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

  protected notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        this.log.error('specialist catalog listener threw', { error })
      }
    }
  }
}
