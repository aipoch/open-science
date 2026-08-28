import { describe, expect, it, vi } from 'vitest'

import { AgentsService, type AgentsCatalogSource } from './agents-service'
import type { SpecialistView } from '../../shared/specialist'
import type { SpecialistService } from '../specialist/service'
import type { StoredConnectors } from '../settings/types'

const profile = (overrides: Partial<SpecialistView> = {}): SpecialistView => ({
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

const specialistService = (profiles: SpecialistView[]): SpecialistService =>
  ({
    list: vi.fn(async () => profiles),
    getByName: vi.fn(async (name: string) => {
      const found = profiles.find((p) => p.name === name)
      if (!found) throw new Error(`Specialist "${name}" not found.`)
      return found
    })
  }) as unknown as SpecialistService

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
  it('list() returns summary records without system prompts or a synthetic Reviewer row', async () => {
    const service = new AgentsService({
      specialistService: specialistService([profile()]),
      catalog: catalog()
    })
    const result = (await service.list()) as Awaited<ReturnType<typeof service.list>>
    expect(result).toHaveLength(1)
    expect(Object.keys(result[0]).sort()).toEqual(
      ['id', 'name', 'displayName', 'description', 'enabled'].sort()
    )
    expect(result[0].id).toBe('sp-1')
    expect(JSON.stringify(result)).not.toContain('SECRET INSTRUCTIONS')
    expect(result.some((item) => item.id === 'reviewer')).toBe(false)
  })

  it('get(name) returns detail including the system prompt', async () => {
    const service = new AgentsService({
      specialistService: specialistService([profile()]),
      catalog: catalog()
    })
    const got = await service.get({ name: 'Bio Expert' })
    expect(got.id).toBe('sp-1')
    expect(got.revision).toBe(3)
    expect(got.systemPrompt).toBe('SECRET INSTRUCTIONS')
    expect(Object.keys(got).sort()).toEqual(
      [
        'id',
        'name',
        'displayName',
        'description',
        'enabled',
        'systemPrompt',
        'iconKey',
        'colorKey',
        'capabilityMode',
        'fullAccess',
        'selectedCapabilities',
        'revision'
      ].sort()
    )
  })

  it('get() rejects a missing name with a host.agents.get-prefixed error', async () => {
    const service = new AgentsService({
      specialistService: specialistService([]),
      catalog: catalog()
    })
    await expect(service.read({ op: 'get', params: {} })).rejects.toThrow(/host\.agents\.get:/)
  })

  it('list_skills() returns the full catalog including Main-disabled skills', async () => {
    const service = new AgentsService({
      specialistService: specialistService([]),
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
        {
          id: 'cust-1',
          name: 'my-server',
          displayName: 'My Server',
          transport: 'stdio',
          enabled: true,
          command: 'run'
        },
        {
          id: 'cust-reserved',
          name: 'chemistry',
          displayName: 'Chemistry!',
          transport: 'stdio',
          enabled: true,
          command: 'run'
        },
        {
          id: 'oauth-1',
          name: 'oauth-server',
          displayName: 'OAuth Server',
          transport: 'streamable_http',
          enabled: true,
          url: 'https://mcp.example.test',
          oauth: {}
        }
      ]
    }
    const service = new AgentsService({
      specialistService: specialistService([]),
      catalog: catalog({ getConnectors: vi.fn(async () => stored) })
    })
    const connectors = await service.listConnectors({})
    const chemistry = connectors.find((c) => c.id === 'chemistry')
    expect(chemistry?.mainEnabled).toBe(false)
    expect(chemistry?.availability).toBe('available')
    expect(chemistry?.tools.length).toBeGreaterThan(0)
    expect(chemistry).not.toHaveProperty('args')
    expect(connectors.filter((connector) => connector.id === 'chemistry')).toHaveLength(1)
    expect(connectors.some((connector) => connector.displayName === 'Chemistry!')).toBe(false)
    const custom = connectors.find((c) => c.id === 'cust-1')
    expect(custom?.source).toBe('custom')
    expect(custom?.mainEnabled).toBe(true)
    expect(custom).not.toHaveProperty('command')
    expect(custom).not.toHaveProperty('headers')
    expect(custom).not.toHaveProperty('env')
    const oauth = connectors.find((c) => c.id === 'oauth-1')
    expect(oauth?.availability).toBe('unauthenticated')
    expect(oauth?.mainEnabled).toBe(false)
  })

  it('filters by exact stable id first', async () => {
    const service = new AgentsService({
      specialistService: specialistService([]),
      catalog: catalog()
    })
    const result = await service.listSkills({ name_or_id: 'personal-foo' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('personal-foo')
  })

  it('rejects an ambiguous public name with a stable-id instruction', async () => {
    const service = new AgentsService({
      specialistService: specialistService([]),
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
    const sensitiveMessage =
      'request failed: token=secret-token path=/Users/alice/project params={"prompt":"private"} HOME=/Users/alice'
    const failing = {
      list: vi.fn(async () => {
        throw new Error(sensitiveMessage)
      })
    }
    const service = new AgentsService({
      specialistService: failing as unknown as SpecialistService,
      catalog: catalog()
    })
    await expect(service.read({ op: 'list' })).rejects.toThrow(
      'host.agents.list: Internal operation failed.'
    )
  })
})

// A SpecialistService fake with the mutation surface dispatch needs for privileged ops (update/delete
// + absence verification), so a delete/name-changing-update can complete end-to-end through
// dispatch without a real store.
const mutatingSpecialistService = (profiles: SpecialistView[]): SpecialistService => {
  let store = [...profiles]
  const service = {
    list: vi.fn(async () => [...store]),
    getByName: vi.fn(async (name: string) => {
      const found = store.find((p) => p.name === name)
      if (!found) throw new Error(`Specialist "${name}" not found.`)
      return found
    }),
    getById: vi.fn(async (id: string) => {
      const found = store.find((p) => p.id === id)
      if (!found) throw new Error(`Specialist ${id} not found.`)
      return found
    }),
    update: vi.fn(async (input: Record<string, unknown>) => {
      const id = String(input.id)
      const idx = store.findIndex((p) => p.id === id)
      if (idx < 0) throw new Error('not found')
      store[idx] = { ...store[idx], ...input, revision: store[idx].revision + 1 }
      return store[idx]
    }),
    delete: vi.fn(async (id: string) => {
      const idx = store.findIndex((p) => p.id === id)
      if (idx < 0) throw new Error('not found')
      store = store.filter((p) => p.id !== id)
    })
  } as unknown as SpecialistService
  service.resolveCustomMutationByName = vi.fn(async (name: string) => service.getByName(name))
  return service
}

describe('AgentsService connector runtime availability', () => {
  it('reports a runtime-unavailable custom connector and rejects a new attachment', async () => {
    const stored: StoredConnectors = {
      enabledIds: [],
      autoAllowIds: [],
      customMcpServers: [
        {
          id: 'cust-1',
          name: 'my-server',
          displayName: 'My Server',
          transport: 'stdio',
          enabled: true,
          command: 'run'
        }
      ]
    }
    const profiles = mutatingSpecialistService([profile()])
    const attachConnector = vi.fn(async () => profile())
    profiles.attachConnector = attachConnector
    const service = new AgentsService({
      specialistService: profiles,
      catalog: catalog({ getConnectors: vi.fn(async () => stored) }),
      customServerAvailability: (id) => (id === 'cust-1' ? 'unavailable' : undefined)
    })

    const connector = (await service.listConnectors({})).find((item) => item.id === 'cust-1')
    expect(connector).toMatchObject({ availability: 'unavailable', mainEnabled: true })
    await expect(
      service.dispatch({
        op: 'attach_connector',
        params: { name: 'Bio Expert', connector_ref: 'my-server', revision: 3 }
      })
    ).rejects.toThrow(/host\.agents\.attach_connector:.*unavailable/)
    expect(attachConnector).not.toHaveBeenCalled()
  })
})

describe('AgentsService privileged dispatch — trusted session threading', () => {
  it('threads the trusted calling session into the delete approval request', async () => {
    const seenSessions: unknown[] = []
    const service = new AgentsService({
      specialistService: mutatingSpecialistService([profile()]),
      catalog: catalog(),
      approvalGateway: {
        decide: async (request) => {
          seenSessions.push(request.session)
          return { status: 'approved' }
        }
      }
    })
    const result = await service.dispatch(
      { op: 'delete', params: { name: 'Bio Expert', revision: 3 } },
      { sessionId: 'trusted-session-1' }
    )
    expect(result).toEqual({ status: 'deleted', name: 'Bio Expert' })
    // The ACP-backed gateway parks the delete card on the CALLING session; an empty session would
    // make the bridge report "approval surface is unavailable" and decline.
    expect(seenSessions).toEqual([{ sessionId: 'trusted-session-1' }])
  })

  it('updates displayName without changing immutable name or consulting approval', async () => {
    const decided: unknown[] = []
    const service = new AgentsService({
      specialistService: mutatingSpecialistService([profile()]),
      catalog: catalog(),
      approvalGateway: {
        decide: async (request) => {
          decided.push(request)
          return { status: 'approved' }
        }
      }
    })
    const result = await service.dispatch(
      {
        op: 'update',
        params: {
          name: 'Bio Expert',
          patch: { display_name: 'Chem Expert', revision: 3 }
        }
      },
      { sessionId: 'trusted-session-2' }
    )
    expect(result).toEqual<SpecialistView>(
      expect.objectContaining({ name: 'Bio Expert', displayName: 'Chem Expert' })
    )
    expect(decided).toHaveLength(0)
  })

  it('passes an empty session to the gateway when no trusted context is supplied (test compatibility)', async () => {
    const seenSessions: unknown[] = []
    const service = new AgentsService({
      specialistService: mutatingSpecialistService([profile()]),
      catalog: catalog(),
      approvalGateway: {
        decide: async (request) => {
          seenSessions.push(request.session)
          return { status: 'approved' }
        }
      }
    })
    await service.dispatch({ op: 'delete', params: { name: 'Bio Expert', revision: 3 } })
    expect(seenSessions).toEqual([{}])
  })
})
