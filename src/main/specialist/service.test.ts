import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { ProfileService } from './service'
import { SpecialistRepository } from './repository'
import type { BuiltinSpecialistRegistryEntry } from '../../shared/specialist-package'
import { emptyFullAccessConfig, emptySelectedConfig } from '../../shared/specialist'

let tmpDir: string
let service: ProfileService

beforeEach(async () => {
  tmpDir = join(tmpdir(), `profile-service-${randomUUID()}`)
  await mkdir(tmpDir, { recursive: true })
  service = new ProfileService(new SpecialistRepository(tmpDir))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('ProfileService.list', () => {
  it('fails the whole runnable catalog with structured diagnostics when any builtin is invalid', async () => {
    const diagnostic = {
      severity: 'error' as const,
      code: 'dependency.builtin-skill-missing',
      message: 'A required builtin Skill is unavailable.',
      path: 'manifest.json',
      relatedId: 'missing-skill'
    }
    const guarded = new ProfileService(new SpecialistRepository(tmpDir), {
      load: async () => ({ entries: [], diagnostics: [diagnostic] })
    })

    await expect(guarded.ensureBuiltinCatalogReady()).rejects.toMatchObject({
      name: 'BuiltinSpecialistConformanceError',
      diagnostics: [diagnostic]
    })
    await expect(guarded.listForSettings()).rejects.toThrow(
      /dependency\.builtin-skill-missing.*required builtin Skill/i
    )
  })

  it('keeps custom mutation queries separate from the runnable builtin catalog', async () => {
    const builtin: BuiltinSpecialistRegistryEntry = {
      kind: 'builtin',
      readonly: true,
      id: 'builtin-curator',
      version: '1.0.0',
      name: 'BUILTIN_CURATOR',
      displayName: 'Builtin Curator',
      description: 'Curates repository evidence.',
      systemPrompt: 'Curate the evidence.',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] }
    }
    const withBuiltin = new ProfileService(new SpecialistRepository(tmpDir), {
      load: async () => ({ entries: [builtin], diagnostics: [] })
    })
    const custom = await withBuiltin.create({ name: 'CUSTOM_CURATOR' })

    expect(await withBuiltin.list()).toEqual([custom])
    await expect(withBuiltin.getById(builtin.id)).rejects.toThrow(/not found/i)
    expect(await withBuiltin.resolveRunnableById(builtin.id)).toMatchObject({
      id: builtin.id,
      name: builtin.name,
      revision: 0
    })
    expect(await withBuiltin.resolveRunnableByName(builtin.name)).toMatchObject({ id: builtin.id })
    expect((await withBuiltin.listForSettings()).map((item) => item.kind)).toEqual([
      'custom',
      'builtin',
      'reviewer'
    ])
  })

  it('returns empty array on fresh store', async () => {
    expect(await service.list()).toHaveLength(0)
  })

  it('does not include Reviewer', async () => {
    const result = await service.list()
    expect(result.every((r) => r.id !== 'reviewer')).toBe(true)
  })
})

describe('ProfileService.create', () => {
  it('returns structured read-only errors for builtin and Reviewer mutation targets', async () => {
    const builtin: BuiltinSpecialistRegistryEntry = {
      kind: 'builtin',
      readonly: true,
      id: 'builtin-curator',
      version: '1.0.0',
      name: 'BUILTIN_CURATOR',
      description: 'Curates repository evidence.',
      systemPrompt: 'Curate the evidence.',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] }
    }
    const guarded = new ProfileService(new SpecialistRepository(tmpDir), {
      load: async () => ({ entries: [builtin], diagnostics: [] })
    })
    const builtinError = { code: 'SPECIALIST_READ_ONLY', targetKind: 'builtin' }
    const reviewerError = { code: 'SPECIALIST_READ_ONLY', targetKind: 'reviewer' }

    await expect(guarded.create({ name: builtin.name })).rejects.toMatchObject(builtinError)
    await expect(guarded.create({ name: 'Reviewer' })).rejects.toMatchObject(reviewerError)
    await expect(guarded.resolveCustomMutationByName(builtin.name)).rejects.toMatchObject(
      builtinError
    )
    await expect(guarded.resolveCustomMutationByName('Reviewer')).rejects.toMatchObject(
      reviewerError
    )
    await expect(
      guarded.update({ id: builtin.id, revision: 0, description: 'changed' })
    ).rejects.toMatchObject(builtinError)
    await expect(guarded.setEnabled(builtin.id, false)).rejects.toMatchObject(builtinError)
    await expect(guarded.delete(builtin.id)).rejects.toMatchObject(builtinError)
    await expect(guarded.attachSkill(builtin.id, 'skill-a', 0)).rejects.toMatchObject(builtinError)
    await expect(guarded.detachSkill(builtin.id, 'skill-a', 0)).rejects.toMatchObject(builtinError)
    await expect(guarded.duplicate(builtin.id)).rejects.toMatchObject(builtinError)
    await expect(guarded.delete('reviewer')).rejects.toMatchObject(reviewerError)
  })

  it('creates a specialist with an ID inferred from its public name', async () => {
    const view = await service.create({ name: 'RNA-seq Reviewer' })
    expect(view.id).toBe('rna-seq-reviewer')
  })

  it('uses a valid custom ID instead of the inferred ID', async () => {
    const view = await service.create({ id: 'transcriptomics-reviewer', name: 'RNA Reviewer' })
    expect(view.id).toBe('transcriptomics-reviewer')
  })

  it('falls back to a UUID when the inferred ID is already in use', async () => {
    await service.create({ id: 'rna-reviewer', name: 'Transcriptomics Reviewer' })

    const view = await service.create({ name: 'RNA Reviewer' })

    expect(view.id).not.toBe('rna-reviewer')
    expect(view.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('falls back to a UUID when concurrent names infer the same ID', async () => {
    const created = await Promise.all([
      service.create({ name: 'RNA Reviewer' }),
      service.create({ name: 'RNA_Reviewer' })
    ])

    expect(new Set(created.map((specialist) => specialist.id)).size).toBe(2)
    expect(created.some((specialist) => specialist.id === 'rna-reviewer')).toBe(true)
  })

  it('does not replace a user-provided ID after a concurrent conflict', async () => {
    const results = await Promise.allSettled([
      service.create({ id: 'rna-reviewer', name: 'RNA Reviewer' }),
      service.create({ id: 'rna-reviewer', name: 'RNA_Reviewer' })
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ message: expect.stringContaining('already exists') })
    })
  })

  it('falls back to a UUID when the public name cannot produce a valid ID', async () => {
    const view = await service.create({ name: '中文专家' })

    expect(view.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('rejects a custom ID that is already in use', async () => {
    await service.create({ id: 'rna-reviewer', name: 'Transcriptomics Reviewer' })

    await expect(service.create({ id: 'rna-reviewer', name: 'Another Reviewer' })).rejects.toThrow(
      'ID is already in use.'
    )
  })

  it('stores the provided name verbatim', async () => {
    const view = await service.create({ name: 'RNA-seq Reviewer' })
    expect(view.name).toBe('RNA-seq Reviewer')
  })

  it('defaults to Full access mode', async () => {
    const view = await service.create({ name: 'My Bot' })
    expect(view.capabilityMode).toBe('full')
  })

  it('initialises both empty capability configs', async () => {
    const view = await service.create({ name: 'My Bot' })
    expect(view.fullAccess.excludedSkillIds).toEqual([])
    expect(view.fullAccess.excludedConnectorIds).toEqual([])
    expect(view.selectedCapabilities.skillIds).toEqual([])
  })

  it('persists connector settings supplied by the editor when creating a specialist', async () => {
    const view = await service.create({
      name: 'Connector Bot',
      capabilityMode: 'selected',
      fullAccess: {
        excludedSkillIds: [],
        excludedConnectorIds: ['pubmed'],
        connectorTools: []
      },
      selectedCapabilities: {
        skillIds: [],
        connectorIds: ['chemistry'],
        connectorTools: []
      }
    })
    expect(view.capabilityMode).toBe('selected')
    expect(view.fullAccess.excludedConnectorIds).toEqual(['pubmed'])
    expect(view.selectedCapabilities.connectorIds).toEqual(['chemistry'])
  })

  it('sets enabled=true by default', async () => {
    const view = await service.create({ name: 'My Bot' })
    expect(view.enabled).toBe(true)
  })

  it('rejects empty name', async () => {
    await expect(service.create({ name: '' })).rejects.toThrow()
  })

  it('rejects duplicate name', async () => {
    await service.create({ name: 'My Bot' })
    await expect(service.create({ name: 'My Bot' })).rejects.toThrow()
  })

  it('rejects an unsupported capability mode before persisting the profile', async () => {
    await expect(
      service.create({ name: 'My Bot', capabilityMode: 'unrestricted' } as never)
    ).rejects.toThrow(/capability mode/i)

    expect(await service.list()).toEqual([])
  })

  it('rejects non-string optional identity fields before persisting the profile', async () => {
    await expect(service.create({ name: 'My Bot', description: 42 } as never)).rejects.toThrow(
      /description must be a string/i
    )

    expect(await service.list()).toEqual([])
  })

  it('rejects a non-string custom ID before persisting the profile', async () => {
    await expect(service.create({ id: 42, name: 'My Bot' } as never)).rejects.toThrow(
      /id must be a string/i
    )

    expect(await service.list()).toEqual([])
  })

  it('specialist is visible in list after creation', async () => {
    await service.create({ name: 'RNA-seq Reviewer' })
    const list = await service.list()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('RNA-seq Reviewer')
  })
})

describe('ProfileService.getById', () => {
  it('returns the specialist by id', async () => {
    const created = await service.create({ name: 'RNA-seq Reviewer' })
    const found = await service.getById(created.id)
    expect(found.id).toBe(created.id)
  })

  it('throws for unknown id', async () => {
    await expect(service.getById('no-such-id')).rejects.toThrow()
  })
})

describe('ProfileService.getByName', () => {
  it('returns specialist by name', async () => {
    const created = await service.create({ name: 'RNA-seq Reviewer' })
    const found = await service.getByName(created.name)
    expect(found.id).toBe(created.id)
  })

  it('throws for unknown name', async () => {
    await expect(service.getByName('No Such Name')).rejects.toThrow()
  })
})

describe('ProfileService.setEnabled', () => {
  it('toggles enabled state', async () => {
    const created = await service.create({ name: 'My Bot' })
    const disabled = await service.setEnabled(created.id, false)
    expect(disabled.enabled).toBe(false)

    const re = await service.setEnabled(created.id, true)
    expect(re.enabled).toBe(true)
  })

  it('throws for unknown id', async () => {
    await expect(service.setEnabled('no-such-id', false)).rejects.toThrow()
  })

  it('rejects enabling a Specialist whose imported setup is pending', async () => {
    const repo = new SpecialistRepository(tmpDir)
    await repo.insert({
      id: 'pending-import',
      name: 'PENDING_IMPORT',
      displayName: 'Pending import',
      description: '',
      systemPrompt: '',
      enabled: false,
      setupPending: true,
      capabilityMode: 'selected',
      fullAccess: emptyFullAccessConfig(),
      selectedCapabilities: emptySelectedConfig(),
      revision: 1,
      packageVersion: '0.1.0',
      origin: 'imported',
      ownedSkillIds: []
    })

    await expect(service.setEnabled('pending-import', true)).rejects.toThrow(/complete.*setup/i)
    expect(await service.getById('pending-import')).toMatchObject({
      enabled: false,
      setupPending: true,
      revision: 1
    })
  })

  it('rejects a non-boolean enabled value without corrupting the profile', async () => {
    const created = await service.create({ name: 'My Bot' })

    await expect(service.setEnabled(created.id, 'false' as never)).rejects.toThrow(
      /enabled must be a boolean/i
    )

    expect(await service.getById(created.id)).toMatchObject({
      id: created.id,
      enabled: true,
      revision: created.revision
    })
  })
})

describe('ProfileService.update', () => {
  it('allows only appearance edits for Marketplace-managed Specialists', async () => {
    const repo = new SpecialistRepository(tmpDir)
    await repo.insert({
      id: 'managed-specialist',
      name: 'MANAGED_SPECIALIST',
      displayName: 'Managed Specialist',
      description: 'Publisher description',
      systemPrompt: 'Publisher instructions',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: emptyFullAccessConfig(),
      selectedCapabilities: emptySelectedConfig(),
      revision: 1,
      packageVersion: '1.0.0',
      origin: 'marketplace',
      ownedSkillIds: []
    })

    await expect(
      service.update({
        id: 'managed-specialist',
        revision: 1,
        iconKey: 'microscope',
        colorKey: 'teal'
      })
    ).resolves.toMatchObject({ iconKey: 'microscope', colorKey: 'teal', revision: 2 })
    await expect(
      service.update({
        id: 'managed-specialist',
        revision: 2,
        description: 'Local rewrite'
      })
    ).rejects.toMatchObject({ code: 'SPECIALIST_READ_ONLY', targetKind: 'marketplace' })
    await expect(service.setEnabled('managed-specialist', false)).resolves.toMatchObject({
      enabled: false
    })
    await expect(service.duplicate('managed-specialist')).resolves.toMatchObject({
      name: 'Managed Specialist Copy'
    })
    await expect(
      service.attachSkill('managed-specialist', 'publisher-skill', 3)
    ).rejects.toMatchObject({ code: 'SPECIALIST_READ_ONLY', targetKind: 'marketplace' })
    await expect(
      service.detachSkill('managed-specialist', 'publisher-skill', 3)
    ).rejects.toMatchObject({ code: 'SPECIALIST_READ_ONLY', targetKind: 'marketplace' })
    await expect(
      service.attachConnector('managed-specialist', 'publisher-connector', 3)
    ).rejects.toMatchObject({ code: 'SPECIALIST_READ_ONLY', targetKind: 'marketplace' })
    await expect(
      service.detachConnector('managed-specialist', 'publisher-connector', 3)
    ).rejects.toMatchObject({ code: 'SPECIALIST_READ_ONLY', targetKind: 'marketplace' })
  })

  it('atomically completes imported setup with submitted configuration and enablement', async () => {
    const repo = new SpecialistRepository(tmpDir)
    await repo.insert({
      id: 'pending-import',
      name: 'PENDING_IMPORT',
      displayName: 'Pending import',
      description: '',
      systemPrompt: '',
      enabled: false,
      setupPending: true,
      capabilityMode: 'selected',
      fullAccess: emptyFullAccessConfig(),
      selectedCapabilities: {
        skillIds: ['bundled-skill'],
        connectorIds: [],
        connectorTools: []
      },
      revision: 1,
      packageVersion: '0.1.0',
      origin: 'imported',
      ownedSkillIds: ['bundled-skill']
    })

    const completed = await service.update({
      id: 'pending-import',
      revision: 1,
      displayName: 'Configured import',
      iconKey: 'microscope',
      colorKey: 'teal',
      selectedCapabilities: {
        skillIds: ['bundled-skill'],
        connectorIds: ['pubmed'],
        connectorTools: []
      },
      completeSetup: true
    })

    expect(completed).toMatchObject({
      displayName: 'Configured import',
      iconKey: 'microscope',
      colorKey: 'teal',
      enabled: true,
      setupPending: false,
      revision: 2,
      selectedCapabilities: { connectorIds: ['pubmed'] }
    })
  })

  it('keeps pending imports disabled during ordinary edits and rejects implicit enablement', async () => {
    const repo = new SpecialistRepository(tmpDir)
    await repo.insert({
      id: 'pending-import',
      name: 'PENDING_IMPORT',
      displayName: 'Pending import',
      description: '',
      systemPrompt: '',
      enabled: false,
      setupPending: true,
      capabilityMode: 'selected',
      fullAccess: emptyFullAccessConfig(),
      selectedCapabilities: emptySelectedConfig(),
      revision: 1,
      packageVersion: '0.1.0',
      origin: 'imported',
      ownedSkillIds: []
    })

    const edited = await service.update({
      id: 'pending-import',
      revision: 1,
      description: 'Draft configuration'
    })
    expect(edited).toMatchObject({ enabled: false, setupPending: true, revision: 2 })
    await expect(
      service.update({ id: 'pending-import', revision: 2, enabled: true })
    ).rejects.toThrow(/complete.*setup/i)
    expect(await service.getById('pending-import')).toMatchObject({
      enabled: false,
      setupPending: true,
      revision: 2
    })
  })

  it('persists an explicit package-version bump through optimistic update', async () => {
    const created = await service.create({ name: 'Versioned Bot' })

    const updated = await service.update({
      id: created.id,
      revision: created.revision,
      packageVersion: '1.0.0'
    })

    expect(updated).toMatchObject({ packageVersion: '1.0.0', revision: created.revision + 1 })
    const restarted = new ProfileService(new SpecialistRepository(tmpDir))
    await expect(restarted.getById(created.id)).resolves.toMatchObject({ packageVersion: '1.0.0' })
  })

  it('atomically persists enabled with displayName and bumps revision once', async () => {
    const created = await service.create({ name: 'My Bot' })
    const updated = await service.update({
      id: created.id,
      revision: created.revision,
      displayName: 'My Disabled Bot',
      enabled: false
    })

    expect(updated).toMatchObject({
      id: created.id,
      name: 'My Bot',
      displayName: 'My Disabled Bot',
      enabled: false,
      revision: created.revision + 1
    })

    const restarted = new ProfileService(new SpecialistRepository(tmpDir))
    await expect(restarted.getById(created.id)).resolves.toMatchObject({
      name: 'My Bot',
      displayName: 'My Disabled Bot',
      enabled: false,
      revision: created.revision + 1
    })
  })

  it('updates presentation fields and bumps revision without changing name', async () => {
    const created = await service.create({ name: 'RNA-seq Reviewer' })
    const updated = await service.update({
      id: created.id,
      revision: created.revision,
      displayName: 'RNA-seq Auditor',
      description: 'Updated description.',
      systemPrompt: 'Be rigorous.'
    })
    expect(updated.id).toBe(created.id)
    expect(updated.name).toBe('RNA-seq Reviewer')
    expect(updated.displayName).toBe('RNA-seq Auditor')
    expect(updated.description).toBe('Updated description.')
    expect(updated.systemPrompt).toBe('Be rigorous.')
    expect(updated.revision).toBe(created.revision + 1)
  })

  it('persists changes and leaves unmentioned fields intact', async () => {
    const created = await service.create({ name: 'My Bot' })
    await service.update({
      id: created.id,
      revision: created.revision,
      description: 'New description.'
    })
    const found = await service.getById(created.id)
    // name not provided → unchanged
    expect(found.name).toBe('My Bot')
    expect(found.description).toBe('New description.')
  })

  it('persists connector exclusions and inclusions independently across mode switches', async () => {
    const created = await service.create({ name: 'Connector Bot' })
    const full = await service.update({
      id: created.id,
      revision: created.revision,
      fullAccess: {
        excludedSkillIds: ['skill-a'],
        excludedConnectorIds: ['pubmed'],
        connectorTools: []
      }
    })
    const selected = await service.update({
      id: created.id,
      revision: full.revision,
      capabilityMode: 'selected',
      selectedCapabilities: {
        skillIds: ['skill-b'],
        connectorIds: ['chemistry'],
        connectorTools: []
      }
    })

    expect(selected.capabilityMode).toBe('selected')
    expect(selected.fullAccess.excludedConnectorIds).toEqual(['pubmed'])
    expect(selected.selectedCapabilities.connectorIds).toEqual(['chemistry'])

    const switchedBack = await service.update({
      id: created.id,
      revision: selected.revision,
      capabilityMode: 'full'
    })
    expect(switchedBack.fullAccess.excludedConnectorIds).toEqual(['pubmed'])
    expect(switchedBack.selectedCapabilities.connectorIds).toEqual(['chemistry'])
  })

  it('rejects malformed capability patches before persistence', async () => {
    const created = await service.create({ name: 'Connector Bot' })
    await expect(
      service.update({
        id: created.id,
        revision: created.revision,
        fullAccess: { excludedSkillIds: [], excludedConnectorIds: [42], connectorTools: [] }
      } as never)
    ).rejects.toThrow(/capability configuration/i)
    expect((await service.getById(created.id)).revision).toBe(created.revision)
  })

  it('rejects non-string identity fields without corrupting the stored profile', async () => {
    const created = await service.create({ name: 'Safe Bot' })

    await expect(
      service.update({
        id: created.id,
        revision: created.revision,
        systemPrompt: { injected: true }
      } as never)
    ).rejects.toThrow(/system prompt must be a string/i)

    expect(await service.getById(created.id)).toMatchObject({
      id: created.id,
      name: 'Safe Bot',
      revision: created.revision
    })
  })

  it('rejects a name field smuggled across the update boundary', async () => {
    const created = await service.create({ name: 'My Bot' })
    await expect(
      service.update({
        id: created.id,
        revision: created.revision,
        name: 'Custom Renamed'
      } as never)
    ).rejects.toThrow(/name is immutable/i)
    expect(await service.getById(created.id)).toMatchObject(created)
  })

  it('allows keeping the same display name', async () => {
    const created = await service.create({ name: 'My Bot' })
    const updated = await service.update({
      id: created.id,
      revision: created.revision,
      displayName: created.displayName
    })
    expect(updated.name).toBe(created.name)
  })

  it('allows duplicate display names because they are not references', async () => {
    const first = await service.create({ name: 'Alpha Bot' })
    const second = await service.create({ name: 'Beta Bot' })
    const updated = await service.update({
      id: second.id,
      revision: second.revision,
      displayName: first.displayName
    })
    expect(updated).toMatchObject({ name: 'Beta Bot', displayName: 'Alpha Bot' })
  })

  it('rejects a stale revision (optimistic concurrency conflict)', async () => {
    const created = await service.create({ name: 'My Bot' })
    await expect(
      service.update({
        id: created.id,
        revision: created.revision + 1,
        displayName: 'Valid label'
      })
    ).rejects.toThrow(/revision conflict/i)
  })

  it('notifies listeners after a successful update', async () => {
    const created = await service.create({ name: 'My Bot' })
    const listener = vi.fn()
    service.subscribe(listener)
    await service.update({ id: created.id, revision: created.revision, description: 'new' })
    expect(listener).toHaveBeenCalledOnce()
  })

  it('defaults displayName to name and lets displayName change independently', async () => {
    const created = await service.create({ name: 'Old Name' })
    expect(created.displayName).toBe('Old Name')
    const updated = await service.update({
      id: created.id,
      revision: created.revision,
      displayName: 'New Label'
    })
    expect(updated).toMatchObject({ name: 'Old Name', displayName: 'New Label' })
  })

  it('keeps a custom display name when it is omitted from an update', async () => {
    const created = await service.create({ name: 'Old Name', displayName: 'Friendly Name' })
    const updated = await service.update({
      id: created.id,
      revision: created.revision,
      description: 'Changed'
    })
    expect(updated).toMatchObject({ name: 'Old Name', displayName: 'Friendly Name' })
  })

  it('rejects an update missing revision', async () => {
    const created = await service.create({ name: 'My Bot' })
    await expect(service.update({ id: created.id } as never)).rejects.toThrow(/id and revision/i)
  })
})

describe('ProfileService.listForSettings', () => {
  it('includes custom specialists', async () => {
    await service.create({ name: 'My Bot' })
    const items = await service.listForSettings()
    expect(items.some((i) => i.kind === 'custom')).toBe(true)
  })

  it('always includes built-in Reviewer placeholder', async () => {
    const items = await service.listForSettings()
    const reviewer = items.find((i) => i.kind === 'reviewer')
    expect(reviewer).toBeDefined()
  })

  it('Reviewer id is "reviewer"', async () => {
    const items = await service.listForSettings()
    const reviewer = items.find((i) => i.kind === 'reviewer')
    expect(reviewer?.id).toBe('reviewer')
  })
})

describe('ProfileService.subscribe', () => {
  it('notifies listener after create', async () => {
    const listener = vi.fn()
    service.subscribe(listener)
    await service.create({ name: 'My Bot' })
    expect(listener).toHaveBeenCalledOnce()
  })

  it('notifies listener after setEnabled', async () => {
    const created = await service.create({ name: 'My Bot' })
    const listener = vi.fn()
    service.subscribe(listener)
    await service.setEnabled(created.id, false)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('unsubscribe stops notifications', async () => {
    const listener = vi.fn()
    const unsub = service.subscribe(listener)
    unsub()
    await service.create({ name: 'My Bot' })
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('ProfileService lifecycle mutations', () => {
  it('rejects malformed delete payloads without removing the profile', async () => {
    const created = await service.create({ name: 'Safe Bot' })

    await expect(service.delete(created.id, '1' as never)).rejects.toThrow(
      /expected revision must be a positive integer/i
    )
    await expect(service.delete({ injected: true } as never)).rejects.toThrow(
      /specialist id must be a non-empty string/i
    )

    expect(await service.getById(created.id)).toMatchObject({
      id: created.id,
      revision: created.revision
    })
  })

  it('keeps UUID and name stable across a display-name edit and rejects a stale delete', async () => {
    const created = await service.create({ name: 'RNA Reviewer', displayName: 'RNA reviewer' })
    const updated = await service.update({
      id: created.id,
      revision: created.revision,
      displayName: 'RNA Auditor'
    })
    expect(updated).toMatchObject({
      id: created.id,
      name: 'RNA Reviewer',
      displayName: 'RNA Auditor'
    })
    await expect(service.delete(created.id, created.revision)).rejects.toThrow(/revision conflict/i)
    expect(await service.getById(created.id)).toMatchObject({ name: 'RNA Reviewer' })
  })

  it('duplicates deeply without persisting until the caller creates it', async () => {
    const created = await service.create({
      name: 'Chemist',
      displayName: 'Chemist',
      selectedCapabilities: {
        skillIds: ['chemistry'],
        connectorIds: ['pubmed'],
        connectorTools: []
      }
    })
    const draft = await service.duplicate(created.id)
    // A duplicate receives a new immutable name and matching initial display label.
    expect(draft).toMatchObject({ name: 'Chemist Copy', displayName: 'Chemist Copy' })
    expect(await service.list()).toHaveLength(1)
    draft.selectedCapabilities?.skillIds.push('other')
    expect((await service.getById(created.id)).selectedCapabilities.skillIds).toEqual(['chemistry'])
  })

  it('serializes collection patches through revision checks', async () => {
    const created = await service.create({ name: 'CURATOR', displayName: 'Curator' })
    const attached = await service.attachSkill(created.id, 'skill-a', created.revision)
    expect(attached.selectedCapabilities.skillIds).toEqual(['skill-a'])
    await expect(service.attachConnector(created.id, 'pubmed', created.revision)).rejects.toThrow(
      /revision conflict/i
    )
  })
})

describe('ProfileService restart persistence', () => {
  it('persists enabled=false across a service restart (re-create from same store)', async () => {
    const created = await service.create({ name: 'PERSISTENT_BOT' })
    expect(created.enabled).toBe(true)

    await service.setEnabled(created.id, false)

    // Simulate restart: create a new service instance from the same storage directory.
    const restarted = new ProfileService(new SpecialistRepository(tmpDir))
    const afterRestart = await restarted.getById(created.id)
    expect(afterRestart.enabled).toBe(false)
  })

  it('preserves all specialist data after restart', async () => {
    const created = await service.create({
      name: 'RESTART_BOT',
      displayName: 'Restart Bot',
      description: 'Survives restart',
      capabilityMode: 'selected',
      selectedCapabilities: { skillIds: ['skill-x'], connectorIds: ['conn-y'], connectorTools: [] }
    })

    const restarted = new ProfileService(new SpecialistRepository(tmpDir))
    const found = await restarted.getById(created.id)

    expect(found.id).toBe(created.id)
    expect(found.name).toBe('RESTART_BOT')
    expect(found.displayName).toBe('Restart Bot')
    expect(found.enabled).toBe(true)
    expect(found.capabilityMode).toBe('selected')
    expect(found.selectedCapabilities.skillIds).toEqual(['skill-x'])
  })
})

describe('ProfileService session binding with stable IDs', () => {
  it('keeps the UUID stable after a display-name edit — a stored session binding still resolves', async () => {
    const created = await service.create({ name: 'RNA_REVIEWER' })
    const originalId = created.id

    // Simulate a session binding: record the profile UUID.
    const sessionBinding = { profileId: created.id }

    await service.update({
      id: created.id,
      displayName: 'RNA Auditor',
      revision: created.revision
    })

    // The session binding UUID still resolves to the same immutable profile name.
    const resolved = await service.getById(sessionBinding.profileId)
    expect(resolved.id).toBe(originalId)
    expect(resolved.name).toBe('RNA_REVIEWER')
    expect(resolved.displayName).toBe('RNA Auditor')
  })

  it('reports missing for a deleted profile UUID without erroring the catalog', async () => {
    const created = await service.create({ name: 'TEMP_BOT' })
    await service.delete(created.id)

    // The deleted UUID no longer resolves.
    await expect(service.getById(created.id)).rejects.toThrow(/not found/i)

    // Other profiles are unaffected.
    const other = await service.create({ name: 'OTHER_BOT' })
    const found = await service.getById(other.id)
    expect(found.name).toBe('OTHER_BOT')
  })
})

describe('ProfileService stable Skill/Connector references', () => {
  it('skill attachment tracks by ID — renamed display name does not break the binding', async () => {
    // Attach a skill by stable ID. In a real app the skill catalog has a stable id
    // and a separate display name. Profile stores the id, never the display name.
    const created = await service.create({ name: 'ID_TRACKER', capabilityMode: 'selected' })
    const withSkill = await service.attachSkill(created.id, 'skill-stable-id', created.revision)
    expect(withSkill.selectedCapabilities.skillIds).toContain('skill-stable-id')

    // Renaming a skill's display name is a catalog-layer change; the stored skill id
    // remains unchanged. Profile attachment is independent of display name.
    const fetched = await service.getById(created.id)
    expect(fetched.selectedCapabilities.skillIds).toContain('skill-stable-id')
  })

  it('deleted skill ID stays in the profile — renderer shows it as missing', async () => {
    const created = await service.create({ name: 'MISSING_REF_BOT', capabilityMode: 'selected' })
    const withSkill = await service.attachSkill(created.id, 'soon-deleted-skill', created.revision)
    expect(withSkill.selectedCapabilities.skillIds).toContain('soon-deleted-skill')

    // Deleting the skill from the catalog is a catalog-layer operation.
    // The profile still holds the id — renderer must display it as "missing".
    const fetched = await service.getById(created.id)
    expect(fetched.selectedCapabilities.skillIds).toContain('soon-deleted-skill')
  })

  it('two skills with different IDs but same display name are tracked by ID independently', async () => {
    const created = await service.create({
      name: 'DUAL_SKILL_BOT',
      capabilityMode: 'selected',
      selectedCapabilities: {
        skillIds: ['skill-v1', 'skill-v2'],
        connectorIds: [],
        connectorTools: []
      }
    })

    const fetched = await service.getById(created.id)
    // Both IDs are stored even if they have the same display name in the catalog.
    expect(fetched.selectedCapabilities.skillIds).toContain('skill-v1')
    expect(fetched.selectedCapabilities.skillIds).toContain('skill-v2')

    // Detaching one does not affect the other.
    const detached = await service.detachSkill(created.id, 'skill-v1', fetched.revision)
    expect(detached.selectedCapabilities.skillIds).not.toContain('skill-v1')
    expect(detached.selectedCapabilities.skillIds).toContain('skill-v2')
  })
})
