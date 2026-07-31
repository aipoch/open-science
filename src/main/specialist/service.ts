import { randomUUID } from 'node:crypto'

import { createLogger } from '../logger'
import { SpecialistRepository } from './repository'
import type { StoredSpecialist } from './types'
import type {
  SpecialistProfileView,
  SpecialistListItem,
  CreateSpecialistInput,
  UpdateSpecialistInput,
  SpecialistCapabilityMode,
  SpecialistFullAccessConfig,
  SpecialistSelectedConfig
} from '../../shared/specialist'
import {
  validateCreateSpecialistInput,
  validateUpdateSpecialistInput,
  validateSpecialistPublicName,
  emptyFullAccessConfig,
  emptySelectedConfig
} from '../../shared/specialist'

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
  capabilityMode: s.capabilityMode,
  fullAccess: s.fullAccess,
  selectedCapabilities: s.selectedCapabilities,
  revision: s.revision
})

const assertOptionalIdentityFieldShapes = (
  input: Pick<
    UpdateSpecialistInput,
    'description' | 'displayName' | 'systemPrompt' | 'iconKey' | 'colorKey'
  >
): void => {
  const optionalTextFields = [
    ['description', input.description],
    ['display name', input.displayName],
    ['system prompt', input.systemPrompt],
    ['icon', input.iconKey],
    ['color', input.colorKey]
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

  constructor(private readonly repo: SpecialistRepository) {}

  // Returns all custom specialists as views (no Reviewer, no Main Agent, no None).
  async list(): Promise<SpecialistProfileView[]> {
    const doc = await this.repo.getAll()
    return doc.specialists.map(toView)
  }

  // Returns the full list for the Settings UI, including the built-in Reviewer placeholder.
  async listForSettings(): Promise<SpecialistListItem[]> {
    const custom = await this.list()
    const items: SpecialistListItem[] = custom.map((v) => ({ kind: 'custom' as const, ...v }))
    items.push({ kind: 'reviewer', id: 'reviewer' })
    return items
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

  async create(input: CreateSpecialistInput): Promise<SpecialistProfileView> {
    assertCreateInputShape(input)

    const doc = await this.repo.getAll()
    const existingNames = doc.specialists.map((s) => s.name)
    const existingIds = new Map(doc.specialists.map((s) => [s.name, s.id]))

    // Validate the required name and optional display name through the shared
    // boundary rules before constructing the persisted record.
    const errors = validateCreateSpecialistInput(input, existingNames, existingIds)
    if (errors.length > 0) {
      throw new Error(errors.map((e) => e.message).join('; '))
    }

    const name = input.name

    const stored: StoredSpecialist = {
      id: randomUUID(),
      name,
      displayName: input.displayName ?? name,
      description: input.description ?? '',
      systemPrompt: input.systemPrompt ?? '',
      iconKey: input.iconKey,
      colorKey: input.colorKey,
      enabled: true,
      capabilityMode: input.capabilityMode ?? 'full',
      fullAccess: input.fullAccess ?? emptyFullAccessConfig(),
      selectedCapabilities: input.selectedCapabilities ?? emptySelectedConfig(),
      revision: 1
    }

    // Do NOT log systemPrompt content per cross-cutting requirement.
    log.info('creating specialist', { id: stored.id, name: stored.name })

    await this.repo.insert(stored)
    this.notify()
    return toView(stored)
  }

  async setEnabled(id: string, enabled: boolean): Promise<SpecialistProfileView> {
    if (typeof id !== 'string' || !id.trim()) {
      throw new Error('Specialist id must be a non-empty string.')
    }
    if (typeof enabled !== 'boolean') throw new Error('Enabled must be a boolean.')
    const updatedDoc = await this.repo.setEnabled(id, enabled)
    this.notify()
    const found = updatedDoc.specialists.find((s) => s.id === id)
    if (!found) throw new Error(`Specialist ${id} not found after setEnabled.`)
    return toView(found)
  }

  // Atomically patches identity/instructions fields on an existing specialist.
  // Re-validates display name and public name (uniqueness skips the record's own
  // id so self-rename is allowed). `revision` must match the stored record
  // (optimistic concurrency); the repository bumps it and rejects stale writes.
  async update(input: UpdateSpecialistInput): Promise<SpecialistProfileView> {
    if (!input || typeof input.id !== 'string' || typeof input.revision !== 'number') {
      throw new Error('Update requires id and revision.')
    }
    if (input.name !== undefined && typeof input.name !== 'string') {
      throw new Error('Name must be a string.')
    }
    assertOptionalIdentityFieldShapes(input)
    assertCapabilityConfigShape(input)

    const doc = await this.repo.getAll()
    const existingNames = doc.specialists.map((s) => s.name)
    const existingIds = new Map(doc.specialists.map((s) => [s.name, s.id]))

    const errors = validateUpdateSpecialistInput(input, existingNames, existingIds)
    if (errors.length > 0) {
      throw new Error(errors.map((e) => e.message).join('; '))
    }

    const patch: Partial<StoredSpecialist> = {}
    if (input.name !== undefined) patch.name = input.name
    if (input.displayName !== undefined) patch.displayName = input.displayName
    if (input.description !== undefined) patch.description = input.description
    if (input.systemPrompt !== undefined) patch.systemPrompt = input.systemPrompt
    if (input.iconKey !== undefined) patch.iconKey = input.iconKey
    if (input.colorKey !== undefined) patch.colorKey = input.colorKey
    if (input.capabilityMode !== undefined) patch.capabilityMode = input.capabilityMode
    if (input.fullAccess !== undefined) patch.fullAccess = input.fullAccess
    if (input.selectedCapabilities !== undefined) {
      patch.selectedCapabilities = input.selectedCapabilities
    }

    log.info('updating specialist', { id: input.id, name: patch.name })

    const updatedDoc = await this.repo.update(input.id, patch, input.revision)
    this.notify()
    const updated = updatedDoc.specialists.find((s) => s.id === input.id)
    if (!updated) throw new Error(`Specialist ${input.id} not found after update.`)
    return toView(updated)
  }

  // Naming is kept as a separate lifecycle mutation so SDK approval flows can
  // re-check the exact record and revision immediately before committing.
  async rename(input: {
    id: string
    name: string
    expectedRevision?: number
  }): Promise<SpecialistProfileView> {
    // Use the same relaxed public-name validator as create() for consistency.
    const nameError = validateSpecialistPublicName(input.name)
    if (nameError) throw new Error(nameError)
    const current = await this.getById(input.id)
    const revision = input.expectedRevision ?? current.revision
    return this.update({ id: input.id, name: input.name, revision })
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
    await this.repo.delete(id, expectedRevision)
    this.notify()
  }

  async duplicate(id: string): Promise<Omit<CreateSpecialistInput, 'name'> & { name: string }> {
    const source = await this.getById(id)
    const names = new Set((await this.list()).map((profile) => profile.name))
    // Use the display name (which equals name in the single-name model) as the base.
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

export const createProfileService = (storageDir: string): ProfileService => {
  return new ProfileService(new SpecialistRepository(storageDir))
}
