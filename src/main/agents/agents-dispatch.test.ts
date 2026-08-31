import { describe, expect, it, vi } from 'vitest'

import { AgentsService, type AgentsCatalogSource } from './agents-service'
import type { ApprovalGateway, ApprovalResult, SwitchNotifier } from '../../shared/agents-contract'
import type { SpecialistView } from '../../shared/specialist'
import type { SpecialistService } from '../specialist/service'
import type { SessionBindingService } from '../specialist/session-binding'

const noopCatalog = (): AgentsCatalogSource => ({
  listSkillCatalog: vi.fn(async () => []),
  getConnectors: vi.fn(async () => ({ enabledIds: [], autoAllowIds: [] }))
})

const withExplicitResolvers = (service: SpecialistService): SpecialistService => {
  service.resolveRunnableByName = vi.fn(async (name: string) => service.getByName(name))
  service.resolveRunnableById = vi.fn(async (id: string) => service.getById(id))
  service.resolveCustomMutationByName = vi.fn(async (name: string) => service.getByName(name))
  return service
}

const noopSpecialistService = (): SpecialistService =>
  withExplicitResolvers({
    list: vi.fn(async () => []),
    getByName: vi.fn(async () => {
      throw new Error('not found')
    }),
    getById: vi.fn(async () => {
      throw new Error('not found')
    })
  } as unknown as SpecialistService)

describe('AgentsService.dispatch — extensible operation dispatcher', () => {
  it('routes a read op identically to read()', async () => {
    const service = new AgentsService({
      specialistService: {
        list: vi.fn(async () => [
          {
            id: 'sp-1',
            name: 'Bio',
            displayName: 'Bio',
            description: '',
            systemPrompt: '',
            enabled: true,
            capabilityMode: 'selected',
            fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
            selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
            revision: 1
          }
        ]),
        getByName: vi.fn()
      } as unknown as SpecialistService,
      catalog: noopCatalog()
    })
    const viaDispatch = await service.dispatch({ op: 'list' })
    const viaRead = await service.read({ op: 'list' })
    expect(viaDispatch).toEqual(viaRead)
    expect(Object.keys((viaDispatch as Array<{ id: string }>)[0]).sort()).toEqual(
      ['id', 'name', 'displayName', 'description', 'enabled'].sort()
    )
  })

  it('rejects an unknown op with a sanitized host.agents.<op>: error', async () => {
    const service = new AgentsService({
      specialistService: noopSpecialistService(),
      catalog: noopCatalog()
    })
    await expect(service.dispatch({ op: 'rename' })).rejects.toThrow(/host\.agents\.rename:/)
  })

  it('rejects a malformed request (no op) with a host.agents.unknown: error', async () => {
    const service = new AgentsService({
      specialistService: noopSpecialistService(),
      catalog: noopCatalog()
    })
    await expect(service.dispatch({})).rejects.toThrow(/host\.agents\.unknown:/)
    await expect(service.dispatch(null)).rejects.toThrow(/host\.agents\.unknown:/)
  })

  it('strips reserved routing/identity/switch keys before reading params', async () => {
    const getByName = vi.fn(
      async () =>
        ({
          id: 'sp-1',
          name: 'Bio',
          displayName: 'Bio',
          description: '',
          systemPrompt: '',
          enabled: true,
          capabilityMode: 'selected',
          fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
          selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
          revision: 1
        }) as SpecialistView
    )
    const service = new AgentsService({
      specialistService: { list: vi.fn(), getByName } as unknown as SpecialistService,
      catalog: noopCatalog()
    })
    // Sandbox tries to forge a session, a specialist id, a switch target, and a reconfigure flag.
    await service.dispatch({
      op: 'get',
      params: {
        name: 'Bio',
        session_id: 'forged',
        specialist_id: 'forged-sp',
        target_specialist_id: 'forged-target',
        reconfigure: true
      }
    })
    // The service received ONLY { name: 'Bio' } — every reserved key was dropped.
    expect(getByName).toHaveBeenCalledWith('Bio')
    expect(getByName.mock.calls[0]).toEqual(['Bio'])
  })

  it('fail-closes privileged ops when their approval seam is not configured', async () => {
    // Ordinary mutations (create/update/attach/detach) are implemented (issue 03) and need no
    // approval seam; switch fails closed on missing seams (issue 05, asserted below); delete is
    // implemented (issue 04 module) and fails closed when the injected approval gateway is absent.
    // With no gateway wired, delete surfaces a sanitized "not configured" error rather than
    // silently no-op'ing.
    const service = new AgentsService({
      specialistService: noopSpecialistService(),
      catalog: noopCatalog()
    })
    await expect(service.dispatch({ op: 'delete', params: {} })).rejects.toThrow(
      /host\.agents\.delete:.*not configured/
    )
  })

  it('ordinary mutations route to SpecialistService (no longer fail-closed)', async () => {
    const created = vi.fn(async () => ({
      id: 'sp-1',
      name: 'Bio',
      displayName: 'Bio',
      description: '',
      systemPrompt: 'CREATE READ-BACK PROMPT SENTINEL',
      enabled: true,
      capabilityMode: 'full' as const,
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
      revision: 1
    }))
    const service = new AgentsService({
      specialistService: {
        ...noopSpecialistService(),
        create: created
      } as unknown as SpecialistService,
      catalog: noopCatalog()
    })
    const result = (await service.dispatch({ op: 'create', params: { name: 'Bio' } })) as {
      id: string
      capabilityMode: string
      systemPrompt: string
    }
    expect(created).toHaveBeenCalledTimes(1)
    expect(result.id).toBe('sp-1')
    expect(result.capabilityMode).toBe('full')
    expect(result.systemPrompt).toBe('CREATE READ-BACK PROMPT SENTINEL')
    expect(Object.keys(result).sort()).toEqual(
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

  it('switch fails closed when its approval/binding/persistence seams are not configured', async () => {
    const service = new AgentsService({
      specialistService: noopSpecialistService(),
      catalog: noopCatalog()
    })
    await expect(
      service.dispatch({ op: 'switch', params: {} }, { callerRole: 'main' })
    ).rejects.toThrow(/host\.agents\.switch:.*not configured/)
  })

  it('reads unchanged: existing list/get/list_skills behavior preserved', async () => {
    const service = new AgentsService({
      specialistService: noopSpecialistService(),
      catalog: noopCatalog()
    })
    await expect(service.read({ op: 'list' })).resolves.toEqual([])
    await expect(service.read({ op: 'get', params: {} })).rejects.toThrow(/host\.agents\.get:/)
    // list_skills with an empty catalog returns []; list_connectors projects the bundled catalog
    // (covered by the dedicated connector test in agents-service.test.ts) so we only assert skills
    // here to avoid coupling this contract test to the bundled connector set.
    await expect(service.read({ op: 'list_skills', params: {} })).resolves.toEqual([])
  })
})

describe('AgentsService.dispatch — switch op routing (issue 05)', () => {
  const specialist = (overrides: Partial<SpecialistView> = {}): SpecialistView => ({
    id: 'sp-1',
    name: 'BIO_EXPERT',
    displayName: 'Bio Expert',
    description: '',
    systemPrompt: 'SECRET INSTRUCTIONS',
    enabled: true,
    capabilityMode: 'selected',
    fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
    selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
    revision: 2,
    ...overrides
  })

  type BuildServiceResult = {
    service: AgentsService
    specialistService: SpecialistService
    sessionBinding: SessionBindingService
    persist: (sessionId: string, specialistId: string | undefined) => Promise<void>
    notify: SwitchNotifier['notify']
    gateway: ApprovalGateway
  }

  const buildService = (opts: {
    profiles?: SpecialistView[]
    decision?: ApprovalResult
  }): BuildServiceResult => {
    const profiles = opts.profiles ?? [specialist()]
    const specialistService = withExplicitResolvers({
      list: vi.fn(async () => profiles),
      getByName: vi.fn(async (name: string) => {
        const found = profiles.find((p) => p.name === name)
        if (!found) throw new Error(`Specialist "${name}" not found.`)
        return found
      }),
      getById: vi.fn(async (id: string) => {
        const found = profiles.find((p) => p.id === id)
        if (!found) throw new Error(`Specialist ${id} not found.`)
        return found
      })
    } as unknown as SpecialistService)
    const sessionBinding = {
      setBinding: vi.fn(),
      getBinding: vi.fn()
    } as unknown as SessionBindingService
    const persist = vi.fn(async () => undefined)
    const notify = vi.fn(async () => undefined)
    const gateway: ApprovalGateway = {
      decide: vi.fn(async (): Promise<ApprovalResult> => opts.decision ?? { status: 'approved' })
    }
    const notifier: SwitchNotifier = { notify }
    const service = new AgentsService({
      specialistService,
      catalog: noopCatalog(),
      approvalGateway: gateway,
      switchNotifier: notifier,
      sessionBinding,
      persistSessionSpecialist: persist
    })
    return { service, specialistService, sessionBinding, persist, notify, gateway }
  }

  it('routes an approved switch through the dispatcher and persists + broadcasts', async () => {
    const { service, persist, notify, sessionBinding } = buildService({})
    const result = (await service.dispatch(
      { op: 'switch', params: { name: 'BIO_EXPERT' } },
      { sessionId: 'session-trusted', callerRole: 'main' }
    )) as {
      status: string
      binding: { specialistId: string }
      pendingReconfigure: { targetName: string }
    }
    expect(result.status).toBe('approved')
    expect(result.binding.specialistId).toBe('sp-1')
    expect(result.pendingReconfigure.targetName).toBe('BIO_EXPERT')
    expect(persist).toHaveBeenCalledWith('session-trusted', 'sp-1')
    expect(notify).toHaveBeenCalledWith({ sessionId: 'session-trusted', targetName: 'BIO_EXPERT' })
    expect(sessionBinding.setBinding).toHaveBeenCalledWith('session-trusted', 'sp-1')
  })

  it('rejects a switch with a missing or unknown trusted caller role before approval or mutation', async () => {
    for (const callerRole of [undefined, 'unknown'] as const) {
      const { service, persist, notify, sessionBinding, gateway } = buildService({})

      await expect(
        service.dispatch(
          { op: 'switch', params: { name: 'BIO_EXPERT', caller_role: 'main' } },
          {
            sessionId: 'session-trusted',
            ...(callerRole ? { callerRole: callerRole as never } : {})
          }
        )
      ).rejects.toThrow('host.agents.switch: Only Main Agent may switch Specialist profile.')

      expect(gateway.decide).not.toHaveBeenCalled()
      expect(sessionBinding.setBinding).not.toHaveBeenCalled()
      expect(persist).not.toHaveBeenCalled()
      expect(notify).not.toHaveBeenCalled()
    }
  })

  it('a declined switch returns the structured declined shape and changes nothing', async () => {
    const { service, persist, notify, sessionBinding } = buildService({
      decision: { status: 'declined', operation: 'switch' }
    })
    const result = await service.dispatch(
      { op: 'switch', params: { name: 'BIO_EXPERT' } },
      { sessionId: 'session-trusted', callerRole: 'main' }
    )
    expect(result).toEqual({ status: 'declined', operation: 'switch' })
    expect(persist).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(sessionBinding.setBinding).not.toHaveBeenCalled()
  })

  it('null name switches to Main Agent (clears the binding) through the dispatcher', async () => {
    const { service, persist, notify } = buildService({})
    const result = (await service.dispatch(
      { op: 'switch', params: { name: null } },
      { sessionId: 'session-trusted', callerRole: 'main' }
    )) as { binding: { specialistId: string | undefined } }
    expect(result.binding.specialistId).toBeUndefined()
    expect(persist).toHaveBeenCalledWith('session-trusted', undefined)
    expect(notify).toHaveBeenCalledWith({ sessionId: 'session-trusted', targetName: null })
  })

  it('the trusted calling session is the only session the switch may target', async () => {
    const { service, persist } = buildService({})
    // A sandbox forges a session id in params; the dispatcher honors only the server context.
    await service.dispatch(
      { op: 'switch', params: { name: 'BIO_EXPERT', session_id: 'forged', sessionId: 'forged' } },
      { sessionId: 'session-trusted', callerRole: 'main' }
    )
    expect(persist).toHaveBeenCalledWith('session-trusted', 'sp-1')
  })
})

describe('AgentsService.dispatch — mutation routing (privileged delete + ordinary update)', () => {
  const specialist = (overrides: Partial<SpecialistView> = {}): SpecialistView => ({
    id: 'sp-1',
    name: 'Bio',
    displayName: 'Bio',
    description: 'old',
    systemPrompt: 'SECRET INSTRUCTIONS',
    enabled: true,
    capabilityMode: 'selected',
    fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
    selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
    revision: 3,
    ...overrides
  })

  const buildService = (opts: {
    profiles?: SpecialistView[]
    decision?: ApprovalResult
  }): {
    service: AgentsService
    specialistService: SpecialistService
    gateway: ApprovalGateway
    invalidateCatalog: ReturnType<typeof vi.fn>
  } => {
    const profiles = opts.profiles ?? [specialist()]
    const specialistService = withExplicitResolvers({
      list: vi.fn(async () => profiles),
      getByName: vi.fn(async (name: string) => {
        const found = profiles.find((p) => p.name === name)
        if (!found) throw new Error(`Specialist "${name}" not found.`)
        return found
      }),
      update: vi.fn(async () => {
        throw new Error('unexpected')
      }),
      delete: vi.fn(async () => undefined)
    } as unknown as SpecialistService)
    const gateway: ApprovalGateway = {
      decide: vi.fn(async (): Promise<ApprovalResult> => opts.decision ?? { status: 'approved' })
    }
    const invalidateCatalog = vi.fn(async () => undefined)
    const service = new AgentsService({
      specialistService,
      catalog: noopCatalog(),
      approvalGateway: gateway,
      invalidateCatalog
    })
    return { service, specialistService, gateway, invalidateCatalog }
  }

  it('routes a displayName edit through the ordinary mutation path', async () => {
    // The SpecialistService returns the real post-write record; the dispatcher
    // must surface it verbatim, not echo the request patch.
    const updated = specialist({
      displayName: 'Biology',
      description: 'new',
      systemPrompt: 'UPDATE READ-BACK PROMPT SENTINEL',
      revision: 4
    })
    const { service, specialistService, gateway } = buildService({
      profiles: [specialist()]
    })
    ;(specialistService.update as ReturnType<typeof vi.fn>).mockResolvedValue(updated)

    const result = (await service.dispatch({
      op: 'update',
      params: { name: 'Bio', patch: { display_name: 'Biology', description: 'new', revision: 3 } }
    })) as SpecialistView

    // Ordinary path returns a projected SpecialistDetailReadModel (no {status:'updated'} envelope).
    expect(result.name).toBe('Bio')
    expect(result.displayName).toBe('Biology')
    expect(result.revision).toBe(4)
    expect(result.systemPrompt).toBe('UPDATE READ-BACK PROMPT SENTINEL')
    // The ordinary path pinned the re-resolved name -> id and revision before update.
    const updateArgs = (specialistService.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(updateArgs.id).toBe('sp-1')
    expect(updateArgs.revision).toBe(3)
    expect(updateArgs.name).toBeUndefined()
    expect(updateArgs.displayName).toBe('Biology')
    expect(gateway.decide).not.toHaveBeenCalled()
  })

  it('a non-name update stays on the ordinary-mutation path (not the privileged module)', async () => {
    const ordinaryReturn = specialist({ description: 'edited', revision: 4 })
    const specialistService = withExplicitResolvers({
      ...noopSpecialistService(),
      getByName: vi.fn(async () => specialist()),
      update: vi.fn(async () => ordinaryReturn)
    } as unknown as SpecialistService)
    const gateway: ApprovalGateway = {
      decide: vi.fn(async (): Promise<ApprovalResult> => ({ status: 'approved' }))
    }
    const service = new AgentsService({
      specialistService,
      catalog: noopCatalog(),
      approvalGateway: gateway
    })

    const result = (await service.dispatch({
      op: 'update',
      params: { name: 'Bio', patch: { description: 'edited', revision: 3 } }
    })) as { id: string; description: string }

    // Ordinary path returns a projected SpecialistDetailReadModel (no {status:'updated'} envelope).
    expect(result.id).toBe('sp-1')
    expect(result.description).toBe('edited')
    // The privileged gateway was NOT consulted for a non-name update.
    expect(gateway.decide).not.toHaveBeenCalled()
  })

  it('an attach mutation returns detail including the post-write system prompt', async () => {
    const attached = specialist({
      systemPrompt: 'ATTACH READ-BACK PROMPT SENTINEL',
      selectedCapabilities: {
        skillIds: ['skill-1'],
        connectorIds: [],
        connectorTools: []
      },
      revision: 4
    })
    const attachSkill = vi.fn(async () => attached)
    const specialistService = withExplicitResolvers({
      ...noopSpecialistService(),
      getByName: vi.fn(async () => specialist()),
      attachSkill
    } as unknown as SpecialistService)
    const service = new AgentsService({
      specialistService,
      catalog: {
        ...noopCatalog(),
        listSkillCatalog: vi.fn(async () => [
          {
            id: 'skill-1',
            frameworkName: 'skill-one',
            displayName: 'Skill One',
            source: 'personal',
            mainEnabled: true,
            available: true
          }
        ])
      }
    })

    const result = (await service.dispatch({
      op: 'attach_skill',
      params: { name: 'Bio', skill_ref: 'skill-1', revision: 3 }
    })) as SpecialistView

    expect(result.systemPrompt).toBe('ATTACH READ-BACK PROMPT SENTINEL')
    expect(result.selectedCapabilities.skillIds).toEqual(['skill-1'])
    expect(attachSkill).toHaveBeenCalledWith('sp-1', 'skill-1', 3, 'selected')
  })

  it('routes delete through applyDelete and returns { status: deleted, name }', async () => {
    const { service, specialistService, invalidateCatalog } = buildService({
      profiles: [specialist()]
    })
    // getByName throws "not found" after delete -> absence verified.
    ;(specialistService.getByName as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(specialist())
      .mockRejectedValueOnce(new Error('Specialist "Bio" not found.'))

    const result = (await service.dispatch({
      op: 'delete',
      params: { name: 'Bio', revision: 3 }
    })) as { status: string; name: string }

    expect(result).toEqual({ status: 'deleted', name: 'Bio' })
    expect(specialistService.delete as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('sp-1', 3)
    expect(invalidateCatalog).toHaveBeenCalledTimes(1)
  })

  it('a declined delete returns the structured declined shape and mutates nothing', async () => {
    const { service, specialistService, invalidateCatalog } = buildService({
      profiles: [specialist()],
      decision: { status: 'declined', operation: 'delete', reason: 'user cancelled' }
    })

    const result = await service.dispatch({
      op: 'delete',
      params: { name: 'Bio', revision: 3 }
    })

    expect(result).toEqual({ status: 'declined', operation: 'delete', reason: 'user cancelled' })
    expect(specialistService.delete as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    expect(invalidateCatalog).not.toHaveBeenCalled()
  })

  it('a stale revision fails closed with a sanitized error (no mutation, no retry)', async () => {
    const { service, specialistService, invalidateCatalog } = buildService({
      // Live revision drifted to 5 while the reviewed revision was 3.
      profiles: [specialist({ revision: 5 })]
    })

    await expect(
      service.dispatch({ op: 'delete', params: { name: 'Bio', revision: 3 } })
    ).rejects.toThrow(/host\.agents\.delete:.*reviewed revision 3/)
    expect(specialistService.delete as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    expect(invalidateCatalog).not.toHaveBeenCalled()
  })

  it('delete never clears session bindings (no binding sink invoked)', async () => {
    const { service, specialistService } = buildService({ profiles: [specialist()] })
    // getByName resolves the live record pre-delete, then throws "not found" post-delete (absence).
    ;(specialistService.getByName as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(specialist())
      .mockRejectedValueOnce(new Error('Specialist "Bio" not found.'))
    // The result surface and dispatcher carry NO binding-clearance path; the contract is that bound
    // conversations resolve unavailable later. This asserts the dispatcher routes through a module
    // that does not clear bindings — there is no such seam on AgentsServiceDeps.
    const result = await service.dispatch({ op: 'delete', params: { name: 'Bio', revision: 3 } })
    expect(result).toEqual({ status: 'deleted', name: 'Bio' })
  })

  // A display-label patch that also edits capabilities must apply both atomically.
  const skillCatalog = (): AgentsCatalogSource => ({
    listSkillCatalog: vi.fn(async () => [
      {
        id: 'sk-reviewer',
        frameworkName: 'reviewer',
        displayName: 'Reviewer',
        source: 'bundled',
        mainEnabled: true,
        available: true
      }
    ]),
    getConnectors: vi.fn(async () => ({ enabledIds: [], autoAllowIds: [] }))
  })

  const buildServiceWithSkills = (opts: {
    profiles: SpecialistView[]
    decision?: ApprovalResult
  }): {
    service: AgentsService
    specialistService: SpecialistService
    gateway: ApprovalGateway
    invalidateCatalog: ReturnType<typeof vi.fn>
  } => {
    const specialistService = withExplicitResolvers({
      list: vi.fn(async () => opts.profiles),
      getByName: vi.fn(async (name: string) => {
        const found = opts.profiles.find((p) => p.name === name)
        if (!found) throw new Error(`Specialist "${name}" not found.`)
        return found
      }),
      update: vi.fn(async () => {
        throw new Error('unexpected')
      }),
      delete: vi.fn(async () => undefined)
    } as unknown as SpecialistService)
    const gateway: ApprovalGateway = {
      decide: vi.fn(async (): Promise<ApprovalResult> => opts.decision ?? { status: 'approved' })
    }
    const invalidateCatalog = vi.fn(async () => undefined)
    const service = new AgentsService({
      specialistService,
      catalog: skillCatalog(),
      approvalGateway: gateway,
      invalidateCatalog
    })
    return { service, specialistService, gateway, invalidateCatalog }
  }

  it('a displayName patch that also edits skill_names applies both atomically', async () => {
    // The SpecialistService returns the real post-write record (new label, bumped revision, and the new
    // selected capability collection). The dispatcher must surface it verbatim, not echo the request.
    const updated: SpecialistView = {
      ...specialist({ displayName: 'Biology', revision: 4 }),
      capabilityMode: 'selected',
      selectedCapabilities: { skillIds: ['sk-reviewer'], connectorIds: [], connectorTools: [] },
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] }
    }
    const { service, specialistService, gateway } = buildServiceWithSkills({
      profiles: [specialist()]
    })
    ;(specialistService.update as ReturnType<typeof vi.fn>).mockResolvedValue(updated)

    const result = (await service.dispatch({
      op: 'update',
      params: {
        name: 'Bio',
        patch: { display_name: 'Biology', skill_names: ['sk-reviewer'], revision: 3 }
      }
    })) as SpecialistView

    expect(result.name).toBe('Bio')
    expect(result.displayName).toBe('Biology')
    expect(result.capabilityMode).toBe('selected')
    expect(result.selectedCapabilities.skillIds).toEqual(['sk-reviewer'])
    expect(result.revision).toBe(4)

    // The ordinary path received the complete patch: displayName + resolved capability fields. The
    // skill ref was resolved to its stable id and projected onto the patch (not stripped).
    const updateArgs = (specialistService.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(updateArgs.name).toBeUndefined()
    expect(updateArgs.displayName).toBe('Biology')
    expect(updateArgs.capabilityMode).toBe('selected')
    expect(updateArgs.selectedCapabilities).toEqual({
      skillIds: ['sk-reviewer'],
      connectorIds: [],
      connectorTools: []
    })
    expect(gateway.decide).not.toHaveBeenCalled()
  })

  it('a combined displayName+capability patch with a stale revision fails closed', async () => {
    // Live revision drifted to 5 while the reviewed revision was 3.
    const { service, specialistService, invalidateCatalog } = buildServiceWithSkills({
      profiles: [specialist({ revision: 5 })]
    })

    await expect(
      service.dispatch({
        op: 'update',
        params: {
          name: 'Bio',
          patch: { display_name: 'Biology', skill_names: ['sk-reviewer'], revision: 3 }
        }
      })
    ).rejects.toThrow(/host\.agents\.update:.*revision/)
    expect(specialistService.update as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    expect(invalidateCatalog).not.toHaveBeenCalled()
  })

  // A displayName patch that also toggles `enabled` must land both in one CAS-backed update.
  it('a displayName patch that also toggles enabled applies both changes atomically', async () => {
    const updated = specialist({ displayName: 'Biology', revision: 4, enabled: false })
    const { service, specialistService } = buildService({ profiles: [specialist()] })
    ;(specialistService.update as ReturnType<typeof vi.fn>).mockResolvedValue(updated)

    const result = (await service.dispatch({
      op: 'update',
      params: { name: 'Bio', patch: { display_name: 'Biology', enabled: false, revision: 3 } }
    })) as SpecialistView

    expect(result.name).toBe('Bio')
    expect(result.displayName).toBe('Biology')
    expect(result.enabled).toBe(false)
    expect(result.revision).toBe(4)
    expect(specialistService.update as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sp-1', revision: 3, displayName: 'Biology', enabled: false })
    )
  })

  it('rejects a displayName patch carrying an unknown field with a sanitized error', async () => {
    const { service, specialistService, invalidateCatalog } = buildService({
      profiles: [specialist()]
    })

    await expect(
      service.dispatch({
        op: 'update',
        params: {
          name: 'Bio',
          patch: { display_name: 'Biology', malicious_field: 'x', revision: 3 }
        }
      })
    ).rejects.toThrow(/host\.agents\.update:.*Unknown field "malicious_field"/)
    expect(specialistService.update as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    expect(invalidateCatalog).not.toHaveBeenCalled()
  })
})

describe('AgentsService — injected seams are fake-able and routed (composition against fakes)', () => {
  // Simulates a downstream module (issue 04/05) implementing the gateway + notifier as fakes and
  // confirming the service accepts them and the dispatcher's write-op branches are the integration
  // point. Real behavior is deferred; this only proves the contract composes.
  it('accepts an injected ApprovalGateway and SwitchNotifier and they satisfy the dep types', () => {
    const fakeGateway: ApprovalGateway = {
      decide: vi.fn(async (): Promise<ApprovalResult> => ({ status: 'approved' }))
    }
    const fakeNotifier: SwitchNotifier = { notify: vi.fn() }
    const service = new AgentsService({
      specialistService: noopSpecialistService(),
      catalog: noopCatalog(),
      approvalGateway: fakeGateway,
      switchNotifier: fakeNotifier
    })
    expect(service).toBeInstanceOf(AgentsService)
  })

  it('the injected gateway can return the structured declined shape (PRD:137)', async () => {
    const decisions: ApprovalResult[] = [
      { status: 'declined', operation: 'switch' },
      { status: 'declined', operation: 'delete', reason: 'user cancelled' },
      { status: 'approved' }
    ]
    const fakeGateway: ApprovalGateway = {
      decide: vi.fn(
        async (): Promise<ApprovalResult> => decisions.shift() ?? { status: 'approved' }
      )
    }
    expect(
      await fakeGateway.decide({
        operation: 'switch',
        summary: {},
        session: { sessionId: 's' }
      })
    ).toEqual({ status: 'declined', operation: 'switch' })
    expect(
      await fakeGateway.decide({
        operation: 'delete',
        summary: {},
        session: { sessionId: 's' }
      })
    ).toEqual({ status: 'declined', operation: 'delete', reason: 'user cancelled' })
    expect(
      await fakeGateway.decide({
        operation: 'switch',
        summary: {},
        session: { sessionId: 's' }
      })
    ).toEqual({ status: 'approved' })
  })
})
