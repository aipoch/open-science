import { describe, expect, it, vi } from 'vitest'

import { executeAgentsMutation, type AgentsMutationCatalog } from './agents-mutations'
import type { ConnectorReadModel, SkillCatalogReadModel } from './agents-service'
import type {
  CreateSpecialistInput,
  SpecialistView,
  UpdateSpecialistInput
} from '../../shared/specialist'
import type { SpecialistService } from '../specialist/service'

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const baseProfile = (overrides: Partial<SpecialistView> = {}): SpecialistView => ({
  id: 'sp-1',
  name: 'Bio',
  displayName: 'Bio',
  description: '',
  systemPrompt: '',
  enabled: true,
  capabilityMode: 'selected',
  fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
  selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
  revision: 1,
  ...overrides
})

// A SpecialistService fake that records every mutation call and returns a read-back view built from the
// stored config so we can assert real read-back (not echoed input).
type SpecialistServiceFake = SpecialistService & {
  calls: { method: string; args: unknown[] }[]
  setStored: (next: SpecialistView[]) => void
}

const makeSpecialistService = (initial: SpecialistView[]): SpecialistServiceFake => {
  let stored: SpecialistView[] = initial
  const calls: { method: string; args: unknown[] }[] = []
  const bump = (view: SpecialistView): SpecialistView => ({
    ...view,
    revision: view.revision + 1
  })
  const svc = {
    calls,
    setStored(next: SpecialistView[]) {
      stored = next
    },
    async list() {
      return stored
    },
    async getByName(name: string) {
      const found = stored.find((p) => p.name === name)
      if (!found) throw new Error(`Specialist "${name}" not found.`)
      return found
    },
    async resolveCustomMutationByName(name: string) {
      const found = stored.find((p) => p.name === name)
      if (!found) throw new Error(`Specialist "${name}" not found.`)
      return found
    },
    async create(input: CreateSpecialistInput) {
      calls.push({ method: 'create', args: [input] })
      const view: SpecialistView = {
        id: 'sp-new',
        name: input.name,
        displayName: input.displayName ?? input.name,
        description: input.description ?? '',
        systemPrompt: input.systemPrompt ?? '',
        iconKey: input.iconKey,
        colorKey: input.colorKey,
        enabled: true,
        capabilityMode: input.capabilityMode ?? 'full',
        fullAccess: input.fullAccess ?? {
          excludedSkillIds: [],
          excludedConnectorIds: [],
          connectorTools: []
        },
        selectedCapabilities: input.selectedCapabilities ?? {
          skillIds: [],
          connectorIds: [],
          connectorTools: []
        },
        revision: 1
      }
      stored = [...stored, view]
      return view
    },
    async update(input: UpdateSpecialistInput) {
      calls.push({ method: 'update', args: [input] })
      const idx = stored.findIndex((p) => p.id === input.id)
      if (idx < 0) throw new Error(`Specialist ${input.id} not found after update.`)
      const merged: SpecialistView = { ...stored[idx] }
      if (input.displayName !== undefined) merged.displayName = input.displayName
      if (input.description !== undefined) merged.description = input.description
      if (input.systemPrompt !== undefined) merged.systemPrompt = input.systemPrompt
      if (input.iconKey !== undefined) merged.iconKey = input.iconKey
      if (input.colorKey !== undefined) merged.colorKey = input.colorKey
      if (input.enabled !== undefined) merged.enabled = input.enabled
      if (input.capabilityMode !== undefined) merged.capabilityMode = input.capabilityMode
      if (input.fullAccess !== undefined) merged.fullAccess = input.fullAccess
      if (input.selectedCapabilities !== undefined) {
        merged.selectedCapabilities = input.selectedCapabilities
      }
      const next = bump(merged)
      stored = stored.map((p, i) => (i === idx ? next : p))
      return next
    },
    async attachSkill(id: string, skillId: string, revision: number, mode: 'full' | 'selected') {
      calls.push({ method: 'attachSkill', args: [id, skillId, revision, mode] })
      const idx = stored.findIndex((p) => p.id === id)
      const cur = stored[idx]
      const next =
        mode === 'full'
          ? {
              ...cur,
              fullAccess: {
                ...cur.fullAccess,
                excludedSkillIds: cur.fullAccess.excludedSkillIds.filter((s) => s !== skillId)
              }
            }
          : {
              ...cur,
              selectedCapabilities: {
                ...cur.selectedCapabilities,
                skillIds: [...new Set([...cur.selectedCapabilities.skillIds, skillId])]
              }
            }
      stored = stored.map((p, i) => (i === idx ? bump(next) : p))
      return stored[idx]
    },
    async detachSkill(id: string, skillId: string, revision: number, mode: 'full' | 'selected') {
      calls.push({ method: 'detachSkill', args: [id, skillId, revision, mode] })
      const idx = stored.findIndex((p) => p.id === id)
      const cur = stored[idx]
      const next =
        mode === 'full'
          ? {
              ...cur,
              fullAccess: {
                ...cur.fullAccess,
                excludedSkillIds: [...new Set([...cur.fullAccess.excludedSkillIds, skillId])]
              }
            }
          : {
              ...cur,
              selectedCapabilities: {
                ...cur.selectedCapabilities,
                skillIds: cur.selectedCapabilities.skillIds.filter((s) => s !== skillId)
              }
            }
      stored = stored.map((p, i) => (i === idx ? bump(next) : p))
      return stored[idx]
    },
    async attachConnector(
      id: string,
      connectorId: string,
      revision: number,
      mode: 'full' | 'selected'
    ) {
      calls.push({ method: 'attachConnector', args: [id, connectorId, revision, mode] })
      const idx = stored.findIndex((p) => p.id === id)
      const cur = stored[idx]
      const next =
        mode === 'full'
          ? {
              ...cur,
              fullAccess: {
                ...cur.fullAccess,
                excludedConnectorIds: cur.fullAccess.excludedConnectorIds.filter(
                  (c) => c !== connectorId
                )
              }
            }
          : {
              ...cur,
              selectedCapabilities: {
                ...cur.selectedCapabilities,
                connectorIds: [...new Set([...cur.selectedCapabilities.connectorIds, connectorId])]
              }
            }
      stored = stored.map((p, i) => (i === idx ? bump(next) : p))
      return stored[idx]
    },
    async detachConnector(
      id: string,
      connectorId: string,
      revision: number,
      mode: 'full' | 'selected'
    ) {
      calls.push({ method: 'detachConnector', args: [id, connectorId, revision, mode] })
      const idx = stored.findIndex((p) => p.id === id)
      const cur = stored[idx]
      const next =
        mode === 'full'
          ? {
              ...cur,
              fullAccess: {
                ...cur.fullAccess,
                excludedConnectorIds: [
                  ...new Set([...cur.fullAccess.excludedConnectorIds, connectorId])
                ]
              }
            }
          : {
              ...cur,
              selectedCapabilities: {
                ...cur.selectedCapabilities,
                connectorIds: cur.selectedCapabilities.connectorIds.filter((c) => c !== connectorId)
              }
            }
      stored = stored.map((p, i) => (i === idx ? bump(next) : p))
      return stored[idx]
    },
    async setEnabled(id: string, enabled: boolean) {
      calls.push({ method: 'setEnabled', args: [id, enabled] })
      const idx = stored.findIndex((p) => p.id === id)
      const cur = stored[idx]
      const next = bump({ ...cur, enabled })
      stored = stored.map((p, i) => (i === idx ? next : p))
      return next
    }
  } as unknown as SpecialistServiceFake
  return svc
}

const skills = (...entries: Partial<SkillCatalogReadModel>[]): SkillCatalogReadModel[] =>
  entries.map((e) => ({
    id: 'demo',
    name: 'demo',
    displayName: 'demo',
    source: 'featured',
    mainEnabled: true,
    available: true,
    ...e
  }))

const connectors = (...entries: Partial<ConnectorReadModel>[]): ConnectorReadModel[] =>
  entries.map((e) => ({
    id: 'bundled',
    name: 'bundled',
    displayName: 'Bundled',
    description: '',
    mainEnabled: true,
    availability: 'available',
    source: 'bundled',
    tools: [],
    ...e
  }))

const makeCatalog = (
  skillEntries: SkillCatalogReadModel[],
  connectorEntries: ConnectorReadModel[]
): {
  catalog: AgentsMutationCatalog
  skillSpy: ReturnType<typeof vi.fn>
  connectorSpy: ReturnType<typeof vi.fn>
} => {
  const skillSpy = vi.fn(async () => skillEntries)
  const connectorSpy = vi.fn(async () => connectorEntries)
  return {
    catalog: { listSkills: skillSpy, listConnectors: connectorSpy },
    skillSpy,
    connectorSpy
  }
}

describe('executeAgentsMutation — payload validation (rejects before reaching the repo)', () => {
  it('rejects an unknown create field', async () => {
    const svc = makeSpecialistService([])
    const { catalog } = makeCatalog([], [])
    await expect(
      executeAgentsMutation(
        { op: 'create', params: { name: 'Bio', bogus_field: 'x' } },
        { specialistService: svc, catalog }
      )
    ).rejects.toThrow(/host\.agents\.create:/)
  })

  it('rejects a malformed name type on create', async () => {
    const svc = makeSpecialistService([])
    const { catalog } = makeCatalog([], [])
    await expect(
      executeAgentsMutation(
        { op: 'create', params: { name: 42 } },
        { specialistService: svc, catalog }
      )
    ).rejects.toThrow(/host\.agents\.create:/)
  })

  it('rejects a non-finite revision on update', async () => {
    const svc = makeSpecialistService([baseProfile()])
    const { catalog } = makeCatalog([], [])
    await expect(
      executeAgentsMutation(
        { op: 'update', params: { name: 'Bio', patch: { revision: Number.NaN } } },
        { specialistService: svc, catalog }
      )
    ).rejects.toThrow(/host\.agents\.update:/)
  })

  it('rejects a non-array skill_names on create', async () => {
    const svc = makeSpecialistService([])
    const { catalog } = makeCatalog([], [])
    await expect(
      executeAgentsMutation(
        { op: 'create', params: { name: 'Bio', skill_names: 'demo' } },
        { specialistService: svc, catalog }
      )
    ).rejects.toThrow(/host\.agents\.create:/)
  })

  it('rejects unknown update fields', async () => {
    const svc = makeSpecialistService([baseProfile()])
    const { catalog } = makeCatalog([], [])
    await expect(
      executeAgentsMutation(
        { op: 'update', params: { name: 'Bio', patch: { revision: 1, oops: true } } },
        { specialistService: svc, catalog }
      )
    ).rejects.toThrow(/host\.agents\.update:/)
  })

  it('rejects connector tool-method / include-exclude patterns as out of scope', async () => {
    const svc = makeSpecialistService([])
    const { catalog } = makeCatalog(skills(), connectors())
    // Connector tool scope is a later milestone; the agreed object does not name these fields, so
    // they are rejected as unknown before reaching the repository.
    await expect(
      executeAgentsMutation(
        {
          op: 'create',
          params: { name: 'Bio', connector_tools: [{ connectorId: 'c', includedMethods: ['x'] }] }
        },
        { specialistService: svc, catalog }
      )
    ).rejects.toThrow(/host\.agents\.create:/)
    await expect(
      executeAgentsMutation(
        { op: 'create', params: { name: 'Bio2', include_tools_pattern: 'c.*' } },
        { specialistService: svc, catalog }
      )
    ).rejects.toThrow(/host\.agents\.create:/)
  })
})

describe('executeAgentsMutation — create', () => {
  it('create with neither capability array produces Full access', async () => {
    const svc = makeSpecialistService([])
    const { catalog } = makeCatalog(skills(), connectors())
    const result = (await executeAgentsMutation(
      { op: 'create', params: { name: 'Bio', description: 'd', system_prompt: 'p' } },
      { specialistService: svc, catalog }
    )) as SpecialistView
    expect(svc.calls[0].method).toBe('create')
    const passed = svc.calls[0].args[0] as CreateSpecialistInput
    expect(passed.capabilityMode).toBe('full')
    expect(result.capabilityMode).toBe('full')
  })

  it('create with skill_names produces Selected and stores connector collection empty', async () => {
    const svc = makeSpecialistService([])
    const { catalog } = makeCatalog(skills({ id: 'sk1', name: 'Skill One' }), connectors())
    const result = (await executeAgentsMutation(
      { op: 'create', params: { name: 'Bio', skill_names: ['sk1'] } },
      { specialistService: svc, catalog }
    )) as SpecialistView
    const passed = svc.calls[0].args[0] as CreateSpecialistInput
    expect(passed.capabilityMode).toBe('selected')
    expect(passed.selectedCapabilities?.skillIds).toEqual(['sk1'])
    expect(passed.selectedCapabilities?.connectorIds).toEqual([])
    expect(result.capabilityMode).toBe('selected')
  })

  it('create with connector_names produces Selected and stores skill collection empty', async () => {
    const svc = makeSpecialistService([])
    const { catalog } = makeCatalog(skills(), connectors({ id: 'c1', displayName: 'Conn' }))
    await executeAgentsMutation(
      { op: 'create', params: { name: 'Bio', connector_names: ['c1'] } },
      { specialistService: svc, catalog }
    )
    const passed = svc.calls[0].args[0] as CreateSpecialistInput
    expect(passed.capabilityMode).toBe('selected')
    expect(passed.selectedCapabilities?.connectorIds).toEqual(['c1'])
    expect(passed.selectedCapabilities?.skillIds).toEqual([])
  })

  it('create accepts the full agreed object and returns a real read-back (not echoed input)', async () => {
    const svc = makeSpecialistService([])
    const { catalog } = makeCatalog(
      skills({ id: 'sk1', name: 'Skill One' }),
      connectors({ id: 'c1', displayName: 'Conn' })
    )
    const result = (await executeAgentsMutation(
      {
        op: 'create',
        params: {
          name: 'Bio',
          description: 'desc',
          system_prompt: 'p',
          icon_key: 'beaker',
          color_key: 'green',
          enabled: false,
          unrestricted: false,
          skill_names: ['Skill One'],
          connector_names: ['c1']
        }
      },
      { specialistService: svc, catalog }
    )) as SpecialistView
    // read-back is a real view: it carries id + revision + enabled always true (create default),
    // and capability resolved against the stable IDs, not the echoed public name.
    expect(result.id).toBe('sp-new')
    expect(result.revision).toBe(1)
    // Providing either capability array produces Selected (AC), regardless of unrestricted.
    expect(result.capabilityMode).toBe('selected')
    expect(svc.calls[0].method).toBe('create')
  })

  it('create rejects a missing name', async () => {
    const svc = makeSpecialistService([])
    const { catalog } = makeCatalog([], [])
    await expect(
      executeAgentsMutation({ op: 'create', params: {} }, { specialistService: svc, catalog })
    ).rejects.toThrow(/host\.agents\.create:/)
  })

  it('create resolves a skill public name to its stable id and persists only the id', async () => {
    const svc = makeSpecialistService([])
    const { catalog } = makeCatalog(skills({ id: 'stable-1', name: 'Skill One' }), connectors())
    await executeAgentsMutation(
      { op: 'create', params: { name: 'Bio', skill_names: ['Skill One'] } },
      { specialistService: svc, catalog }
    )
    const passed = svc.calls[0].args[0] as CreateSpecialistInput
    expect(passed.selectedCapabilities?.skillIds).toEqual(['stable-1'])
  })

  it('create resolves a connector immutable name to its stable id', async () => {
    const svc = makeSpecialistService([])
    const { catalog } = makeCatalog(
      skills(),
      connectors({ id: 'stable-c', name: 'my-connector', displayName: 'My Connector' })
    )
    await executeAgentsMutation(
      { op: 'create', params: { name: 'Bio', connector_names: ['my-connector'] } },
      { specialistService: svc, catalog }
    )
    const passed = svc.calls[0].args[0] as CreateSpecialistInput
    expect(passed.selectedCapabilities?.connectorIds).toEqual(['stable-c'])
  })

  it('create rejects an ambiguous skill name and instructs to use the stable id', async () => {
    const svc = makeSpecialistService([])
    const { catalog } = makeCatalog(
      skills({ id: 'a', name: 'Dup' }, { id: 'b', name: 'Dup' }),
      connectors()
    )
    await expect(
      executeAgentsMutation(
        { op: 'create', params: { name: 'Bio', skill_names: ['Dup'] } },
        { specialistService: svc, catalog }
      )
    ).rejects.toThrow(/stable id/)
  })

  it('create allows a Main-disabled installed skill to be assigned', async () => {
    const svc = makeSpecialistService([])
    const { catalog } = makeCatalog(
      skills({ id: 'sk1', name: 'Disabled', mainEnabled: false }),
      connectors()
    )
    const result = (await executeAgentsMutation(
      { op: 'create', params: { name: 'Bio', skill_names: ['sk1'] } },
      { specialistService: svc, catalog }
    )) as SpecialistView
    expect(svc.calls[0].method).toBe('create')
    expect(result.capabilityMode).toBe('selected')
  })
})

describe('executeAgentsMutation — update', () => {
  it('update supports description, system instructions, icon, color, enabled, mode, skills, connectors', async () => {
    const svc = makeSpecialistService([baseProfile({ revision: 1 })])
    const { catalog } = makeCatalog(
      skills({ id: 'sk1', name: 'Skill One' }),
      connectors({ id: 'c1', displayName: 'Conn' })
    )
    const result = (await executeAgentsMutation(
      {
        op: 'update',
        params: {
          name: 'Bio',
          patch: {
            revision: 1,
            description: 'new desc',
            system_prompt: 'new prompt',
            icon_key: 'flask',
            color_key: 'blue',
            enabled: false,
            skill_names: ['sk1'],
            connector_names: ['c1']
          }
        }
      },
      { specialistService: svc, catalog }
    )) as SpecialistView
    expect(svc.calls[0].method).toBe('update')
    const passed = svc.calls[0].args[0] as UpdateSpecialistInput
    expect(passed.description).toBe('new desc')
    expect(passed.systemPrompt).toBe('new prompt')
    expect(passed.iconKey).toBe('flask')
    expect(passed.colorKey).toBe('blue')
    expect(passed.enabled).toBe(false)
    expect(passed.capabilityMode).toBe('selected')
    expect(passed.selectedCapabilities?.skillIds).toEqual(['sk1'])
    expect(passed.selectedCapabilities?.connectorIds).toEqual(['c1'])
    expect(svc.calls.map((call) => call.method)).toEqual(['update'])
    // A single public update is one CAS-backed persistence request and advances one revision.
    expect(result.id).toBe('sp-1')
    expect(result.enabled).toBe(false)
    expect(result.revision).toBe(2)
  })

  it('update({ unrestricted: true }) switches to Full without destroying the stored Selected config', async () => {
    const svc = makeSpecialistService([
      baseProfile({
        revision: 1,
        selectedCapabilities: { skillIds: ['sk1'], connectorIds: ['c1'], connectorTools: [] }
      })
    ])
    const { catalog } = makeCatalog(skills(), connectors())
    await executeAgentsMutation(
      { op: 'update', params: { name: 'Bio', patch: { revision: 1, unrestricted: true } } },
      { specialistService: svc, catalog }
    )
    const passed = svc.calls[0].args[0] as UpdateSpecialistInput
    expect(passed.capabilityMode).toBe('full')
    // Selected config NOT overwritten (no selectedCapabilities in the patch).
    expect(passed.selectedCapabilities).toBeUndefined()
  })

  it('update providing skill_names exactly replaces the collection and switches to Selected', async () => {
    const svc = makeSpecialistService([
      baseProfile({
        revision: 1,
        capabilityMode: 'full',
        selectedCapabilities: { skillIds: ['old'], connectorIds: ['oldc'], connectorTools: [] }
      })
    ])
    const { catalog } = makeCatalog(
      skills({ id: 'new1', name: 'New' }, { id: 'new2', name: 'Newer' }),
      connectors()
    )
    await executeAgentsMutation(
      {
        op: 'update',
        params: { name: 'Bio', patch: { revision: 1, skill_names: ['new1', 'new2'] } }
      },
      { specialistService: svc, catalog }
    )
    const passed = svc.calls[0].args[0] as UpdateSpecialistInput
    expect(passed.capabilityMode).toBe('selected')
    expect(passed.selectedCapabilities?.skillIds).toEqual(['new1', 'new2'])
    // Omitted connector collection is preserved from the stored Selected config.
    expect(passed.selectedCapabilities?.connectorIds).toEqual(['oldc'])
  })

  it('update preserving omitted collections: skill_names omitted keeps existing skills', async () => {
    const svc = makeSpecialistService([
      baseProfile({
        revision: 1,
        capabilityMode: 'selected',
        selectedCapabilities: { skillIds: ['keep'], connectorIds: [], connectorTools: [] }
      })
    ])
    const { catalog } = makeCatalog(skills(), connectors({ id: 'c1', displayName: 'C' }))
    await executeAgentsMutation(
      { op: 'update', params: { name: 'Bio', patch: { revision: 1, connector_names: ['c1'] } } },
      { specialistService: svc, catalog }
    )
    const passed = svc.calls[0].args[0] as UpdateSpecialistInput
    expect(passed.selectedCapabilities?.connectorIds).toEqual(['c1'])
    // Omitted skill collection is preserved from the stored Selected config.
    expect(passed.selectedCapabilities?.skillIds).toEqual(['keep'])
  })

  it('update requires a matching revision; a stale revision fails without merge/retry', async () => {
    const svc = makeSpecialistService([baseProfile({ revision: 5 })])
    const { catalog } = makeCatalog(skills(), connectors())
    await expect(
      executeAgentsMutation(
        { op: 'update', params: { name: 'Bio', patch: { revision: 1, description: 'x' } } },
        { specialistService: svc, catalog }
      )
    ).rejects.toThrow(/host\.agents\.update:/)
    expect(svc.calls).toHaveLength(0)
  })

  it('a non-name update does not request a permission card (no approval gateway call)', async () => {
    const decide = vi.fn(async () => ({ status: 'approved' as const }))
    const svc = makeSpecialistService([baseProfile({ revision: 1 })])
    const { catalog } = makeCatalog(skills(), connectors())
    await executeAgentsMutation(
      { op: 'update', params: { name: 'Bio', patch: { revision: 1, description: 'x' } } },
      { specialistService: svc, catalog, approvalGateway: { decide } }
    )
    expect(decide).not.toHaveBeenCalled()
  })

  it('update reads changes from the nested patch', async () => {
    const svc = makeSpecialistService([baseProfile({ revision: 1 })])
    const { catalog } = makeCatalog(skills(), connectors())
    const result = (await executeAgentsMutation(
      { op: 'update', params: { name: 'Bio', patch: { revision: 1, description: 'nested desc' } } },
      { specialistService: svc, catalog }
    )) as SpecialistView
    const passed = svc.calls[0].args[0] as UpdateSpecialistInput
    expect(passed.description).toBe('nested desc')
    expect(result.revision).toBe(2)
  })

  it('update changes displayName without changing the immutable name', async () => {
    const svc = makeSpecialistService([baseProfile({ revision: 1 })])
    const { catalog } = makeCatalog(skills(), connectors())
    const decide = vi.fn()
    const result = (await executeAgentsMutation(
      {
        op: 'update',
        params: { name: 'Bio', patch: { revision: 1, display_name: 'New label' } }
      },
      { specialistService: svc, catalog, approvalGateway: { decide } }
    )) as SpecialistView
    expect(result).toMatchObject({ name: 'Bio', displayName: 'New label' })
    expect(decide).not.toHaveBeenCalled()
  })

  it('update requires a nested patch object', async () => {
    const svc = makeSpecialistService([baseProfile({ revision: 1 })])
    const { catalog } = makeCatalog(skills(), connectors())
    await expect(
      executeAgentsMutation(
        { op: 'update', params: { name: 'Bio' } },
        { specialistService: svc, catalog }
      )
    ).rejects.toThrow(/host\.agents\.update:/)
    expect(svc.calls).toHaveLength(0)
  })
})

describe('executeAgentsMutation — attach/detach mutate current mode without switching it', () => {
  it('Selected attach_skill adds an inclusion; detach removes it', async () => {
    const svc = makeSpecialistService([baseProfile({ revision: 1, capabilityMode: 'selected' })])
    const { catalog } = makeCatalog(skills({ id: 'sk1', name: 'S' }), connectors())
    await executeAgentsMutation(
      { op: 'attach_skill', params: { name: 'Bio', skill_ref: 'sk1', revision: 1 } },
      { specialistService: svc, catalog }
    )
    expect(svc.calls[0]).toEqual({ method: 'attachSkill', args: ['sp-1', 'sk1', 1, 'selected'] })
    await executeAgentsMutation(
      { op: 'detach_skill', params: { name: 'Bio', skill_ref: 'sk1', revision: 2 } },
      { specialistService: svc, catalog }
    )
    expect(svc.calls[1]).toEqual({ method: 'detachSkill', args: ['sp-1', 'sk1', 2, 'selected'] })
  })

  it('Full attach_skill removes an exclusion; detach adds one', async () => {
    const svc = makeSpecialistService([baseProfile({ revision: 1, capabilityMode: 'full' })])
    const { catalog } = makeCatalog(skills({ id: 'sk1', name: 'S' }), connectors())
    await executeAgentsMutation(
      { op: 'attach_skill', params: { name: 'Bio', skill_ref: 'sk1', revision: 1 } },
      { specialistService: svc, catalog }
    )
    expect(svc.calls[0]).toEqual({ method: 'attachSkill', args: ['sp-1', 'sk1', 1, 'full'] })
    await executeAgentsMutation(
      { op: 'detach_skill', params: { name: 'Bio', skill_ref: 'sk1', revision: 2 } },
      { specialistService: svc, catalog }
    )
    expect(svc.calls[1]).toEqual({ method: 'detachSkill', args: ['sp-1', 'sk1', 2, 'full'] })
  })

  // Regression (sprint review): detach_skill must resolve a public DISPLAY NAME to the stable catalog
  // id. resolveOrPassThrough receives `await catalog.listSkills()`; a missing `await` passes a Promise
  // as the entries, applyNameOrIdFilter throws on the non-iterable, the catch swallows it, and the
  // literal display name reaches detachSkill instead of the resolved stable id. The existing tests
  // above used a ref that equals the stable id, so they passed even with the bug.
  it('detach_skill resolves a public name to the stable catalog id (not the literal ref)', async () => {
    const svc = makeSpecialistService([baseProfile({ revision: 1, capabilityMode: 'selected' })])
    const { catalog } = makeCatalog(
      skills({ id: 'sk-stable', name: 'Skill One', displayName: 'Skill One' }),
      connectors()
    )
    await executeAgentsMutation(
      { op: 'detach_skill', params: { name: 'Bio', skill_ref: 'Skill One', revision: 1 } },
      { specialistService: svc, catalog }
    )
    expect(svc.calls[0]).toEqual({
      method: 'detachSkill',
      args: ['sp-1', 'sk-stable', 1, 'selected']
    })
  })

  it('attach_connector / detach_connector follow the same mode rules', async () => {
    const svc = makeSpecialistService([baseProfile({ revision: 1, capabilityMode: 'selected' })])
    const { catalog } = makeCatalog(skills(), connectors({ id: 'c1', displayName: 'C' }))
    await executeAgentsMutation(
      { op: 'attach_connector', params: { name: 'Bio', connector_ref: 'c1', revision: 1 } },
      { specialistService: svc, catalog }
    )
    expect(svc.calls[0]).toEqual({
      method: 'attachConnector',
      args: ['sp-1', 'c1', 1, 'selected']
    })
    const svc2 = makeSpecialistService([baseProfile({ revision: 1, capabilityMode: 'full' })])
    await executeAgentsMutation(
      { op: 'detach_connector', params: { name: 'Bio', connector_ref: 'c1', revision: 1 } },
      { specialistService: svc2, catalog }
    )
    expect(svc2.calls[0]).toEqual({
      method: 'detachConnector',
      args: ['sp-1', 'c1', 1, 'full']
    })
  })

  it('attach/detach rejects a missing revision', async () => {
    const svc = makeSpecialistService([baseProfile()])
    const { catalog } = makeCatalog(skills({ id: 'sk1', name: 'S' }), connectors())
    await expect(
      executeAgentsMutation(
        { op: 'attach_skill', params: { name: 'Bio', skill_ref: 'sk1' } },
        { specialistService: svc, catalog }
      )
    ).rejects.toThrow(/host\.agents\.attach_skill:/)
  })

  it('attach/detach rejects unknown params', async () => {
    const svc = makeSpecialistService([baseProfile()])
    const { catalog } = makeCatalog(skills({ id: 'sk1', name: 'S' }), connectors())
    await expect(
      executeAgentsMutation(
        { op: 'detach_skill', params: { name: 'Bio', skill_ref: 'sk1', revision: 1, extra: 1 } },
        { specialistService: svc, catalog }
      )
    ).rejects.toThrow(/host\.agents\.detach_skill:/)
  })
})

describe('executeAgentsMutation — Connector availability gate', () => {
  it('cannot newly attach an unavailable custom connector', async () => {
    const svc = makeSpecialistService([baseProfile({ revision: 1, capabilityMode: 'selected' })])
    const { catalog } = makeCatalog(
      skills(),
      connectors({ id: 'dead', source: 'custom', availability: 'unavailable' })
    )
    await expect(
      executeAgentsMutation(
        { op: 'attach_connector', params: { name: 'Bio', connector_ref: 'dead', revision: 1 } },
        { specialistService: svc, catalog }
      )
    ).rejects.toThrow(/host\.agents\.attach_connector:/)
    expect(svc.calls).toHaveLength(0)
  })

  it('cannot newly attach an unauthenticated custom connector', async () => {
    const svc = makeSpecialistService([baseProfile({ revision: 1, capabilityMode: 'selected' })])
    const { catalog } = makeCatalog(
      skills(),
      connectors({ id: 'unauth', source: 'custom', availability: 'unauthenticated' })
    )
    await expect(
      executeAgentsMutation(
        { op: 'attach_connector', params: { name: 'Bio', connector_ref: 'unauth', revision: 1 } },
        { specialistService: svc, catalog }
      )
    ).rejects.toThrow(/host\.agents\.attach_connector:/)
  })

  it('create with an unavailable custom connector in connector_names is rejected', async () => {
    const svc = makeSpecialistService([])
    const { catalog } = makeCatalog(
      skills(),
      connectors({ id: 'dead', source: 'custom', availability: 'unavailable' })
    )
    await expect(
      executeAgentsMutation(
        { op: 'create', params: { name: 'Bio', connector_names: ['dead'] } },
        { specialistService: svc, catalog }
      )
    ).rejects.toThrow(/host\.agents\.create:/)
  })

  it('an available custom connector can be attached', async () => {
    const svc = makeSpecialistService([baseProfile({ revision: 1, capabilityMode: 'selected' })])
    const { catalog } = makeCatalog(
      skills(),
      connectors({ id: 'ok', source: 'custom', availability: 'available' })
    )
    await executeAgentsMutation(
      { op: 'attach_connector', params: { name: 'Bio', connector_ref: 'ok', revision: 1 } },
      { specialistService: svc, catalog }
    )
    expect(svc.calls[0]).toEqual({ method: 'attachConnector', args: ['sp-1', 'ok', 1, 'selected'] })
  })

  it('detach passes through a stale reference no longer in the catalog (still removable)', async () => {
    // An existing stale reference that has since been removed from the catalog must still be
    // detachable. detach falls back to the literal stable id when nothing matches.
    const svc = makeSpecialistService([baseProfile({ revision: 1, capabilityMode: 'selected' })])
    const { catalog } = makeCatalog(
      skills(),
      // 'stale-connector' is NOT in the catalog.
      connectors({ id: 'other', displayName: 'Other' })
    )
    await executeAgentsMutation(
      {
        op: 'detach_connector',
        params: { name: 'Bio', connector_ref: 'stale-connector', revision: 1 }
      },
      { specialistService: svc, catalog }
    )
    expect(svc.calls[0]).toEqual({
      method: 'detachConnector',
      args: ['sp-1', 'stale-connector', 1, 'selected']
    })
  })
})

describe('executeAgentsMutation — no direct repo writes, no duplicated rules', () => {
  it('all mutations delegate to SpecialistService (never write the repository directly)', async () => {
    const svc = makeSpecialistService([baseProfile({ revision: 1, capabilityMode: 'selected' })])
    const { catalog } = makeCatalog(
      skills({ id: 'sk1', name: 'S' }),
      connectors({ id: 'c1', displayName: 'C' })
    )
    await executeAgentsMutation(
      { op: 'update', params: { name: 'Bio', patch: { revision: 1, description: 'd' } } },
      { specialistService: svc, catalog }
    )
    await executeAgentsMutation(
      { op: 'attach_skill', params: { name: 'Bio', skill_ref: 'sk1', revision: 2 } },
      { specialistService: svc, catalog }
    )
    expect(svc.calls.map((c) => c.method)).toEqual(['update', 'attachSkill'])
  })
})

describe('executeAgentsMutation — errors are sanitized', () => {
  it('SpecialistService internal secret never reaches the sandbox', async () => {
    const svc = makeSpecialistService([])
    svc.create = vi.fn(async () => {
      throw new Error('internal secret: apikey=ABCDEF')
    })
    const { catalog } = makeCatalog([], [])
    await expect(
      executeAgentsMutation(
        { op: 'create', params: { name: 'Bio' } },
        { specialistService: svc, catalog }
      )
    ).rejects.toThrow('host.agents.create: Internal operation failed.')
  })

  it('a repo revision-conflict surfaces as a sanitized host.agents.update: error', async () => {
    const svc = makeSpecialistService([baseProfile({ revision: 5 })])
    const { catalog } = makeCatalog(skills(), connectors())
    await expect(
      executeAgentsMutation(
        { op: 'update', params: { name: 'Bio', patch: { revision: 1, description: 'x' } } },
        { specialistService: svc, catalog }
      )
    ).rejects.toThrow(/host\.agents\.update:/)
  })
})
