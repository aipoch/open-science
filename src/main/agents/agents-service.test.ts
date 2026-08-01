import { describe, expect, it, vi } from 'vitest'

import { AgentsService, type AgentsCatalogSource } from './agents-service'
import type { SpecialistProfileView } from '../../shared/specialist'
import type { ProfileService } from '../specialist/service'
import type { StoredConnectors } from '../settings/types'

const profile = (overrides: Partial<SpecialistProfileView> = {}): SpecialistProfileView => ({
  id: 'sp-1',
  name: 'Bio Expert',
  displayName: 'Bio Expert',
  description: 'a specialist',
  systemPrompt: 'SECRET INSTRUCTIONS',
  iconKey: 'beaker',
  colorKey: 'green',
  enabled: true,
  capabilityMode: 'selected',
  fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
  selectedCapabilities: { skillIds: ['demo'], connectorIds: ['chemistry'], connectorTools: [] },
  revision: 3,
  ...overrides
})

const profileService = (profiles: SpecialistProfileView[]): ProfileService =>
  ({
    list: vi.fn(async () => profiles),
    getByName: vi.fn(async (name: string) => {
      const found = profiles.find((p) => p.name === name)
      if (!found) throw new Error(`Specialist "${name}" not found.`)
      return found
    })
  }) as unknown as ProfileService

const catalog = (overrides: Partial<AgentsCatalogSource> = {}): AgentsCatalogSource => ({
  listSkillCatalog: vi.fn(async () => [
    {
      id: 'demo',
      frameworkName: 'demo',
      displayName: 'demo',
      source: 'featured',
      mainEnabled: true,
      available: true
    },
    {
      id: 'personal-foo',
      frameworkName: 'foo',
      displayName: 'foo',
      source: 'personal',
      mainEnabled: false,
      available: true
    }
  ]),
  getConnectors: vi.fn(async () => ({ enabledIds: [], autoAllowIds: [] }) as StoredConnectors),
  ...overrides
})

describe('AgentsService read surface', () => {
  it('list() returns custom profiles and never synthesizes the Reviewer row', async () => {
    const service = new AgentsService({
      profileService: profileService([profile()]),
      catalog: catalog()
    })
    const result = (await service.list()) as Awaited<ReturnType<typeof service.list>>
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('sp-1')
    expect(result[0].revision).toBe(3)
    expect(result.some((item) => item.id === 'reviewer')).toBe(false)
  })

  it('get(name) resolves the public name and returns id + revision', async () => {
    const service = new AgentsService({
      profileService: profileService([profile()]),
      catalog: catalog()
    })
    const got = await service.get({ name: 'Bio Expert' })
    expect(got.id).toBe('sp-1')
    expect(got.revision).toBe(3)
  })

  it('get() rejects a missing name with a host.agents.get-prefixed error', async () => {
    const service = new AgentsService({
      profileService: profileService([]),
      catalog: catalog()
    })
    await expect(service.read({ op: 'get', params: {} })).rejects.toThrow(/host\.agents\.get:/)
  })

  it('list_skills() returns the full catalog including Main-disabled skills', async () => {
    const service = new AgentsService({
      profileService: profileService([]),
      catalog: catalog()
    })
    const skills = await service.listSkills({})
    expect(skills).toHaveLength(2)
    expect(skills.find((s) => s.id === 'personal-foo')?.mainEnabled).toBe(false)
    expect(skills.find((s) => s.id === 'demo')).toEqual({
      id: 'demo',
      name: 'demo',
      displayName: 'demo',
      source: 'featured',
      mainEnabled: true,
      available: true
    })
  })

  it('list_connectors() projects bundled + custom connectors without secrets', async () => {
    const stored: StoredConnectors = {
      enabledIds: [],
      autoAllowIds: [],
      disabledConnectorIds: ['chemistry'],
      customMcpServers: [
        { id: 'cust-1', name: 'My Server', transport: 'stdio', enabled: true, command: 'run' }
      ]
    }
    const service = new AgentsService({
      profileService: profileService([]),
      catalog: catalog({ getConnectors: vi.fn(async () => stored) })
    })
    const connectors = await service.listConnectors({})
    const chemistry = connectors.find((c) => c.id === 'chemistry')
    expect(chemistry?.mainEnabled).toBe(false)
    expect(chemistry?.availability).toBe('available')
    expect(chemistry?.tools.length).toBeGreaterThan(0)
    expect(chemistry).not.toHaveProperty('args')
    const custom = connectors.find((c) => c.id === 'cust-1')
    expect(custom?.source).toBe('custom')
    expect(custom?.mainEnabled).toBe(true)
    expect(custom).not.toHaveProperty('command')
    expect(custom).not.toHaveProperty('headers')
    expect(custom).not.toHaveProperty('env')
  })

  it('filters by exact stable id first', async () => {
    const service = new AgentsService({
      profileService: profileService([]),
      catalog: catalog()
    })
    const result = await service.listSkills({ name_or_id: 'personal-foo' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('personal-foo')
  })

  it('rejects an ambiguous public name with a stable-id instruction', async () => {
    const service = new AgentsService({
      profileService: profileService([]),
      catalog: catalog({
        listSkillCatalog: vi.fn(async () => [
          {
            id: 'a',
            frameworkName: 'dup',
            displayName: 'dup',
            source: 'featured',
            mainEnabled: true,
            available: true
          },
          {
            id: 'b',
            frameworkName: 'dup',
            displayName: 'dup',
            source: 'featured',
            mainEnabled: true,
            available: true
          }
        ])
      })
    })
    await expect(
      service.read({ op: 'list_skills', params: { name_or_id: 'dup' } })
    ).rejects.toThrow(/stable id/)
  })

  it('surfaces internal failures as sanitized host.agents.<method>: errors', async () => {
    const failing = {
      list: vi.fn(async () => {
        throw new Error(
          'request failed at /Users/alice/private/config.json with Authorization: Bearer TOP-SECRET and apiKey=ABCDEF'
        )
      })
    }
    const service = new AgentsService({
      profileService: failing as unknown as ProfileService,
      catalog: catalog()
    })
    let message = ''
    try {
      await service.read({ op: 'list' })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toBe('host.agents.list: Internal operation failed.')
    expect(message).not.toContain('TOP-SECRET')
    expect(message).not.toContain('ABCDEF')
    expect(message).not.toContain('/Users/alice/private/config.json')
  })
})
