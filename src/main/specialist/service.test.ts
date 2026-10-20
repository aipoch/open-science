import { createSpecialistService } from './service'
import { SpecialistStorageFixture } from '../../../test/specialist-fixtures'
import { projectConnectorsFromStored } from '../connectors/read-model'
import { builtinConnectorRegistry } from '../connectors/registry'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SpecialistService } from './service'
import { AgentsService } from '../agents/agents-service'
import { ConnectorService } from '../connectors/service'
import { SessionBindingService } from './session-binding'
import type { BuiltinSpecialistRegistryEntry } from '@aipoch/specialists'
import { emptyFullAccessConfig, emptySelectedConfig } from '@aipoch/specialists'

let tmpDir: string
let service: SpecialistService

beforeEach(async () => {
  tmpDir = join(tmpdir(), `profile-service-${randomUUID()}`)
  await mkdir(tmpDir, { recursive: true })
  service = createSpecialistService(tmpDir)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('SpecialistService.list', () => {
  it('fails the whole runnable catalog with structured diagnostics when any builtin is invalid', async () => {
    const diagnostic = {
      severity: 'error' as const,
      code: 'dependency.builtin-skill-missing',
      message: 'A required builtin Skill is unavailable.',
      path: 'manifest.json',
      relatedId: 'missing-skill'
    }
    const guarded = createSpecialistService(tmpDir, {
      load: async () => ({ entries: [], diagnostics: [diagnostic] })
    })

    await expect(guarded.listForSettings()).rejects.toThrow(
      /dependency\.builtin-skill-missing.*required builtin Skill/i
    )
  })

  it('projects custom profiles, builtins and Reviewer into the Settings catalog', async () => {
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
    const withBuiltin = createSpecialistService(tmpDir, {
      load: async () => ({ entries: [builtin], diagnostics: [] })
    })
    await withBuiltin.create({ name: 'CUSTOM_CURATOR' })

    expect((await withBuiltin.listForSettings()).map((item) => item.kind)).toEqual([
      'custom',
      'builtin',
      'reviewer'
    ])
  })

  it('does not include Reviewer', async () => {
    const result = await service.list()
    expect(result.every((r) => r.id !== 'reviewer')).toBe(true)
  })
})

describe('SpecialistService.create', () => {
  it('injects the host Reviewer reservation into domain mutation policy', async () => {
    const error = { code: 'SPECIALIST_READ_ONLY', targetKind: 'reviewer' }
    await expect(service.create({ name: 'Reviewer' })).rejects.toMatchObject(error)
    await expect(service.resolveCustomMutationByName('Reviewer')).rejects.toMatchObject(error)
    await expect(service.delete('reviewer')).rejects.toMatchObject(error)
  })
})

describe('SpecialistService.update', () => {
  it('allows only appearance edits for Marketplace-managed Specialists', async () => {
    const repo = new SpecialistStorageFixture(tmpDir)
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
})

describe('SpecialistService.listForSettings', () => {
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

describe.each(['full', 'selected'] as const)(
  'S03 damaged capability records in %s mode',
  (capabilityMode) => {
    it('blocks Connector dispatch and Session binding until the domain record is repaired', async () => {
      const damaged = { connectorTools: [{ connectorId: 'demo', includedMethods: 'read' }] }

      const source = await service.create({
        name: 'Restricted',
        capabilityMode,
        selectedCapabilities: {
          skillIds: [],
          connectorIds: ['demo'],
          connectorTools: [{ connectorId: 'demo', includedMethods: ['read'] }]
        },
        fullAccess: {
          excludedSkillIds: [],
          excludedConnectorIds: [],
          connectorTools: [{ connectorId: 'demo', includedMethods: ['read'] }]
        }
      })
      const healthy = await service.create({ name: 'Healthy neighbor' })
      const path = join(tmpDir, 'specialists.json')
      const original = await readFile(path, 'utf8')
      const document = JSON.parse(original)
      document.specialists[0].fullAccess =
        damaged === null ? null : { ...document.specialists[0].fullAccess, ...damaged }
      document.specialists.unshift(null) // Dropped records must not shift the validity association.
      const corrupted = JSON.stringify(document)
      await writeFile(path, corrupted)

      expect.soft((await service.listForSettingsSnapshot()).integrity.status).toBe('degraded')
      const dispatch = vi.fn().mockResolvedValue({ ok: true })
      const gate = new ConnectorService({
        registry: builtinConnectorRegistry,
        mcpClientManager: {
          call: dispatch,
          listTools: vi.fn().mockResolvedValue([{ name: 'danger' }])
        },
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          customMcpServers: [
            {
              id: 'demo',
              name: 'demo',
              displayName: 'Demo',
              transport: 'stdio',
              command: 'unused-test-command',
              enabled: true
            }
          ]
        }),
        resolveApiKey: () => undefined,
        resolveSpecialistProfile: (id) => service.resolveRunnableById(id)
      })
      await expect
        .soft(
          gate.call(
            'demo',
            'danger',
            {},
            { origin: 'agent', sessionId: 'damaged-session', specialistId: source.id }
          )
        )
        .rejects.toThrow()
      expect.soft(dispatch).not.toHaveBeenCalled()
      const bindings = new SessionBindingService(service)
      bindings.setBinding('damaged-session', source.id)
      bindings.setBinding('healthy-session', healthy.id)
      expect.soft(await bindings.resolve('damaged-session')).toMatchObject({ kind: 'unavailable' })
      expect(await bindings.resolve('healthy-session')).toMatchObject({
        kind: 'bound',
        profile: { id: healthy.id }
      })
      expect(await readFile(path, 'utf8')).toBe(corrupted)

      await writeFile(path, original)
      expect(await bindings.resolve('damaged-session')).toMatchObject({
        kind: 'bound',
        profile: { id: source.id }
      })
    })
  }
)

describe('Specialist errors through host.agents', () => {
  it('preserves owned domain failures but hides unknown dependencies', async () => {
    const agents = new AgentsService({
      specialistService: service,
      catalog: {
        listSkillCatalog: async () => [],
        getConnectors: async () => projectConnectorsFromStored(undefined)
      }
    })
    await expect(agents.dispatch({ op: 'get', params: { name: 'missing' } })).rejects.toThrow(
      'host.agents.get: Specialist "missing" not found.'
    )
    await expect(agents.dispatch({ op: 'create', params: { name: 'Reviewer' } })).rejects.toThrow(
      'read-only'
    )
    const created = await service.create({ name: 'DOMAIN_TEST' })
    await service.update({ id: created.id, revision: created.revision, description: 'changed' })
    await expect(
      agents.dispatch({
        op: 'update',
        params: {
          name: created.name,
          patch: { revision: created.revision, description: 'new change' }
        }
      })
    ).rejects.toThrow('host.agents.get')
    vi.spyOn(service, 'getByName').mockRejectedValueOnce(new Error('private credential SENTINEL'))
    await expect(agents.dispatch({ op: 'get', params: { name: created.name } })).rejects.toThrow(
      'Internal operation failed.'
    )
  })
})
