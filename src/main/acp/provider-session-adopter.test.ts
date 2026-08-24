import type { ActiveSession, ClientConnection } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { AcpCreateSessionResponse } from '../../shared/acp'
import type { SessionPermissionProfileState } from '../../shared/permission-profiles'
import type { EffectiveSpecialistSkills } from '../../shared/specialist'
import { claudeCodeFramework, opencodeFramework } from '../agent-framework'
import type { AcpBackendGenerationView } from './backend-generation-owner'
import { AcpProviderSessionAdopter } from './provider-session-adopter'
import {
  CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
  SIDE_CHAT_SESSION_CAPABILITY_POLICY,
  type SessionCapabilityPolicy
} from './session-capability-owner'
import { AcpSessionRegistry, type AcpPrimarySessionIdentityReservation } from './session-registry'

const permissionProfile: SessionPermissionProfileState = {
  selectedProfile: 'ask',
  effectiveProfile: 'ask',
  currentModeId: 'default',
  availableModeIds: ['default'],
  fullAccessAvailable: false
}

type ConfigurationFacts = {
  permissionProfile: SessionPermissionProfileState
  appliedModel: string | undefined
  configOptions: undefined
}

type AdopterHarness = {
  adopt: (
    specialistId?: string,
    specialistBindingPending?: true
  ) => Promise<AcpCreateSessionResponse>
  commit: ReturnType<typeof vi.fn>
  commitClaudeReplay: ReturnType<typeof vi.fn>
  configure: ReturnType<typeof vi.fn>
  connection: ClientConnection
  order: string[]
  providerSession: ActiveSession
  provision: ReturnType<typeof vi.fn>
  registry: AcpSessionRegistry
  release: ReturnType<typeof vi.fn>
  reservation: AcpPrimarySessionIdentityReservation
  sessionSetupAppends: string[][]
  setBackend: (next: AcpBackendGenerationView) => void
}

const createHarness = (
  options: {
    configure?: (
      input: Parameters<
        ConstructorParameters<typeof AcpProviderSessionAdopter>[0]['configurator']['configure']
      >[0]
    ) => Promise<ConfigurationFacts>
    emitState?: () => void
    foreignIdentityCollision?: (sessionIds: readonly string[]) => Error | undefined
    handoffAppend?: string
    initialBackend?: AcpBackendGenerationView
    capabilityPolicy?: SessionCapabilityPolicy
    projectAgentContext?: string
    specialistIdentity?: { append: string; prefix: string }
    specialistSkills?: EffectiveSpecialistSkills
  } = {}
): AdopterHarness => {
  const order: string[] = []
  const sessionSetupAppends: string[][] = []
  const providerSession = {
    sessionId: 'fresh-provider-session',
    dispose: vi.fn()
  } as unknown as ActiveSession
  const connection = {
    agent: {
      buildSession: vi.fn(() => {
        order.push('session/new prepared')
        return {
          start: vi.fn(async () => {
            order.push('session/new')
            return providerSession
          })
        }
      })
    }
  } as unknown as ClientConnection
  const baseBackend: AcpBackendGenerationView = options.initialBackend ?? {
    framework: claudeCodeFramework,
    backendId: 'claude-code',
    session: { modelRequired: false },
    prompt: { systemPromptAppends: [] },
    context: { supportsImageInput: false },
    adapter: { nativeMcpEnabled: true, bridgeMcpAliasesEnabled: false }
  }
  let backend: AcpBackendGenerationView = {
    ...baseBackend,
    framework: {
      ...baseBackend.framework,
      buildSessionSetup: (input) => {
        sessionSetupAppends.push([...(input.systemPromptAppends ?? [])])
        return baseBackend.framework.buildSessionSetup(input)
      }
    }
  }
  const registry = new AcpSessionRegistry({
    foreignIdentityCollision: options.foreignIdentityCollision
  })
  vi.spyOn(registry, 'publish').mockImplementation((...args) => {
    order.push('registry publish')
    return AcpSessionRegistry.prototype.publish.call(registry, ...args)
  })
  const reservation = registry.reserve({
    sessionIds: ['stable-app-session'],
    mayRenewAfterConnectionSetup: true,
    blockStartup: false
  })
  if (reservation.collision) throw reservation.collision
  const commit = vi.fn(() => order.push('capability commit'))
  const release = vi.fn(() => order.push('capability release'))
  const commitClaudeReplay = vi.fn(() => order.push('handoff commit'))
  const configure = vi.fn(
    options.configure ??
      (async () => {
        order.push('configure')
        return { permissionProfile, appliedModel: undefined, configOptions: undefined }
      })
  )
  const provision = vi.fn(async () => {
    order.push('capability provision')
    return {
      mcpServers: [],
      descriptor: {
        role: 'primary' as const,
        delegation: 'denied' as const,
        transport: 'none' as const,
        capabilities: [],
        canonicalMcpServerNames: [],
        modelFacingMcpServerNames: [],
        controlRpcMethods: []
      },
      commit,
      release
    }
  })
  const adopter = new AcpProviderSessionAdopter({
    currentBackend: () => backend,
    registry,
    reserveIdentity: (current, sessionIds) =>
      registry.reserve({ reservation: current, sessionIds }),
    capabilities: { provision },
    capabilityPolicy: options.capabilityPolicy ?? CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
    configurator: { configure },
    resolveSpecialistIdentity: options.specialistIdentity
      ? vi.fn(async () => options.specialistIdentity)
      : undefined,
    resolveSpecialistSkills: options.specialistSkills
      ? vi.fn(async () => options.specialistSkills as EffectiveSpecialistSkills)
      : undefined,
    resolveProjectAgentContext: options.projectAgentContext
      ? vi.fn(async () => options.projectAgentContext)
      : undefined,
    peekClaudeReplay: () => options.handoffAppend,
    commitClaudeReplay,
    updateCwd: () => order.push('cwd callback'),
    emitState: () => {
      order.push('state callback')
      options.emitState?.()
    },
    diagnosticContext: () => ({})
  })
  const adopt = (
    specialistId?: string,
    specialistBindingPending?: true
  ): Promise<AcpCreateSessionResponse> =>
    adopter.adopt('stable-app-session', {
      connection,
      cwd: '/workspace',
      projectId: 'project-a',
      identity: reservation.reservation,
      specialistId,
      specialistBindingPending
    })
  return {
    adopt,
    commit,
    commitClaudeReplay,
    configure,
    connection,
    order,
    providerSession,
    provision,
    registry,
    release,
    reservation: reservation.reservation,
    sessionSetupAppends,
    setBackend: (next: AcpBackendGenerationView) => {
      backend = next
    }
  }
}

describe('AcpProviderSessionAdopter', () => {
  it('preserves the runtime capability policy while adopting a fresh provider Session', async () => {
    const harness = createHarness({ capabilityPolicy: SIDE_CHAT_SESSION_CAPABILITY_POLICY })

    await harness.adopt()

    expect(harness.provision).toHaveBeenCalledWith(
      expect.objectContaining({ policy: SIDE_CHAT_SESSION_CAPABILITY_POLICY })
    )
  })

  it('publishes a fresh provider Session under the stable application Session id', async () => {
    const harness = createHarness()

    const response = await harness.adopt()

    expect(response).toEqual({
      sessionId: 'stable-app-session',
      providerSessionId: 'fresh-provider-session',
      cwd: '/workspace',
      frameworkId: 'claude-code',
      backendId: 'claude-code',
      contextReset: true
    })
    expect(harness.registry.lookup('stable-app-session')?.attachment?.session).toBe(
      harness.providerSession
    )
    expect(harness.registry.resolveAppSessionId('fresh-provider-session')).toBe(
      'stable-app-session'
    )
    expect(harness.commit).toHaveBeenCalledWith('stable-app-session')
    expect(harness.order).toEqual([
      'capability provision',
      'session/new prepared',
      'session/new',
      'configure',
      'registry publish',
      'cwd callback',
      'capability commit',
      'handoff commit',
      'state callback'
    ])
  })

  it('disposes the provisional Session and capability when configuration fails', async () => {
    const failure = new Error('configuration failed')
    const harness = createHarness({ configure: vi.fn().mockRejectedValue(failure) })

    await expect(harness.adopt()).rejects.toBe(failure)

    expect(harness.providerSession.dispose).toHaveBeenCalledOnce()
    expect(harness.release).toHaveBeenCalledWith({ ownsStableIdentity: true })
    expect(harness.registry.lookup('stable-app-session')).toBeUndefined()
    expect(harness.commitClaudeReplay).not.toHaveBeenCalled()
    expect(harness.registry.isIdentityClaimed('stable-app-session')).toBe(false)
  })

  it('cleans provisional ownership when the provider Session id collides', async () => {
    const collision = new Error('provider identity collision')
    const harness = createHarness({
      foreignIdentityCollision: (sessionIds) =>
        sessionIds.includes('fresh-provider-session') ? collision : undefined
    })

    await expect(harness.adopt()).rejects.toBe(collision)

    expect(harness.providerSession.dispose).toHaveBeenCalledOnce()
    expect(harness.release).toHaveBeenCalledWith({ ownsStableIdentity: true })
    expect(harness.registry.lookup('stable-app-session')).toBeUndefined()
    expect(harness.commitClaudeReplay).not.toHaveBeenCalled()
    expect(harness.registry.isIdentityClaimed('stable-app-session')).toBe(false)
  })

  it('does not revoke stable identity state after adoption is superseded', async () => {
    const state = { registry: undefined as AcpSessionRegistry | undefined }
    const harness = createHarness({
      configure: async () => {
        state.registry?.invalidatePending()
        return { permissionProfile, appliedModel: undefined, configOptions: undefined }
      }
    })
    state.registry = harness.registry

    await expect(harness.adopt()).rejects.toThrow('ACP session startup was superseded.')

    expect(harness.providerSession.dispose).toHaveBeenCalledOnce()
    expect(harness.release).toHaveBeenCalledWith({ ownsStableIdentity: false })
    expect(harness.registry.lookup('stable-app-session')).toBeUndefined()
    expect(harness.commitClaudeReplay).not.toHaveBeenCalled()
    expect(harness.registry.isIdentityClaimed('stable-app-session')).toBe(false)
  })

  it('replays Specialist identity and staged handoff before committing continuity', async () => {
    const harness = createHarness({
      handoffAppend: 'staged handoff continuity',
      specialistIdentity: {
        append: 'specialist identity append',
        prefix: 'specialist turn prefix'
      },
      specialistSkills: {
        kind: 'specialist',
        skillIds: ['skill-1'],
        frameworkNames: ['literature-review'],
        missingSkillIds: []
      }
    })

    await harness.adopt('specialist-1')

    expect(harness.sessionSetupAppends.flat()).toEqual(
      expect.arrayContaining(['specialist identity append', 'staged handoff continuity'])
    )
    expect(harness.registry.lookup('stable-app-session')?.aggregate.snapshot()).toMatchObject({
      specialistId: 'specialist-1',
      specialistPrefix: 'specialist turn prefix'
    })
    expect(harness.order.indexOf('handoff commit')).toBeGreaterThan(
      harness.order.indexOf('registry publish')
    )
  })

  it('rejects an authoritative Specialist adoption when its identity cannot be resolved', async () => {
    const harness = createHarness()

    await expect(harness.adopt('specialist-1', true)).rejects.toThrow(
      'The bound specialist is unavailable.'
    )

    expect(harness.registry.lookup('stable-app-session')).toBeUndefined()
    expect(harness.connection.agent.buildSession).not.toHaveBeenCalled()
    expect(harness.commit).not.toHaveBeenCalled()
    expect(harness.release).toHaveBeenCalledWith({ ownsStableIdentity: true })
  })

  it('clears detached Specialist affinity when a pending binding explicitly selects Main', async () => {
    const harness = createHarness()
    harness.registry
      .ensureAffinity('stable-app-session')
      .aggregate.setSpecialistId('specialist-old')

    await harness.adopt(undefined, true)

    expect(
      harness.registry.lookup('stable-app-session')?.aggregate.snapshot().specialistId
    ).toBeUndefined()
  })

  it('reconfigures against a live effort update before publishing the adopted Session', async () => {
    const harness = createHarness()
    let configuration = 0
    harness.configure.mockImplementation(async (input) => {
      configuration += 1
      if (configuration === 1) {
        harness.setBackend({
          ...input.backend,
          session: { ...input.backend.session, effort: 'high' }
        })
      }
      return {
        permissionProfile,
        appliedModel: configuration === 1 ? 'stale-model-fact' : 'current-model-fact',
        configOptions: undefined
      }
    })

    await harness.adopt()

    expect(harness.configure).toHaveBeenCalledTimes(2)
    expect(harness.registry.lookup('stable-app-session')?.aggregate.snapshot().appliedModel).toBe(
      'current-model-fact'
    )
  })

  it('appends the project Agent Context after the specialist and handoff appends', async () => {
    const harness = createHarness({
      initialBackend: {
        framework: opencodeFramework,
        backendId: 'opencode:provider-a',
        modelRoute: 'opencode-openai',
        session: { modelRequired: false },
        prompt: { systemPromptAppends: [], persistentSystemPrompt: 'Baked instructions.' },
        context: { supportsImageInput: false },
        adapter: { nativeMcpEnabled: true, bridgeMcpAliasesEnabled: false }
      },
      handoffAppend: 'staged handoff continuity',
      specialistIdentity: {
        append: 'specialist identity append',
        prefix: 'specialist turn prefix'
      },
      projectAgentContext: 'Always cite DOIs.'
    })

    await harness.adopt('specialist-1')

    const appends = harness.sessionSetupAppends.at(-1) ?? []
    expect(appends.at(-3)).toBe('staged handoff continuity')
    expect(appends.at(-2)).toContain('<open_science_project_agent_context>')
    expect(appends.at(-2)).toContain('Always cite DOIs.')
    expect(appends.at(-2)).toContain('</open_science_project_agent_context>')
    expect(appends.at(-1)).toBe('specialist identity append')
    expect(
      harness.registry.lookup('stable-app-session')?.aggregate.snapshot().sessionSetupPromptPrefix
    ).toContain('Always cite DOIs.')
  })

  it('does not roll back publication when the state observer fails', async () => {
    const harness = createHarness({
      emitState: () => {
        throw new Error('state observer failed')
      }
    })

    await expect(harness.adopt()).resolves.toMatchObject({ sessionId: 'stable-app-session' })

    expect(harness.registry.lookup('stable-app-session')?.attachment?.session).toBe(
      harness.providerSession
    )
    expect(harness.providerSession.dispose).not.toHaveBeenCalled()
    expect(harness.release).not.toHaveBeenCalled()
  })
})
