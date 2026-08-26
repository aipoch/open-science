import type { ActiveSession, ClientConnection } from '@agentclientprotocol/sdk'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { SessionPermissionProfileState } from '../../shared/permission-profiles'
import {
  claudeCodeFramework,
  codexFramework,
  opencodeFramework,
  type AgentFramework
} from '../agent-framework'
import { SKILL_IMPORT_SYSTEM_PROMPT_APPEND } from '../skills/mcp-server'
import type { AcpBackendGenerationView } from './backend-generation-owner'
import { AcpProviderSessionCreator } from './provider-session-creator'
import {
  CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
  type SessionCapabilityName
} from './session-capability-owner'
import { AcpSessionRegistry } from './session-registry'

const permissionProfile: SessionPermissionProfileState = {
  selectedProfile: 'ask',
  effectiveProfile: 'ask',
  currentModeId: 'default',
  availableModeIds: ['default'],
  fullAccessAvailable: false
}

type CreatorHarness = {
  buildSession: ReturnType<typeof vi.fn>
  commit: ReturnType<typeof vi.fn>
  creator: AcpProviderSessionCreator
  order: string[]
  provision: ReturnType<typeof vi.fn>
  registry: AcpSessionRegistry
  release: ReturnType<typeof vi.fn>
  session: ActiveSession
  sessionSetupAppends: string[][]
}

const createHarness = (options: {
  configure?: () => Promise<{
    permissionProfile: SessionPermissionProfileState
    appliedModel: undefined
    configOptions: undefined
  }>
  registerSessionSpecialist?: () => void
  pushEvent?: () => void
  emitState?: () => void
  order?: string[]
  descriptorCapabilities?: SessionCapabilityName[]
  framework?: AgentFramework
  nativeMcpEnabled?: boolean
  bridgeMcpAliasesEnabled?: boolean
  backendId?: string
  projectAgentContext?: string
  projectAgentContextError?: Error
  specialistIdentity?: { append: string; prefix: string }
}): CreatorHarness => {
  const order = options.order ?? []
  const sessionSetupAppends: string[][] = []
  const session = {
    sessionId: 'provider-session',
    dispose: vi.fn()
  } as unknown as ActiveSession
  const buildSession = vi.fn(() => ({
    start: vi.fn(async () => {
      order.push('session/new')
      return session
    })
  }))
  const connection = {
    agent: {
      buildSession
    }
  } as unknown as ClientConnection
  const registry = new AcpSessionRegistry()
  vi.spyOn(registry, 'publish').mockImplementation((...args) => {
    order.push('registry publish')
    return AcpSessionRegistry.prototype.publish.call(registry, ...args)
  })
  const baseFramework = options.framework ?? claudeCodeFramework
  const backend: AcpBackendGenerationView = {
    framework: {
      ...baseFramework,
      buildSessionSetup: (input) => {
        order.push('presentation preflight')
        sessionSetupAppends.push([...(input.systemPromptAppends ?? [])])
        return baseFramework.buildSessionSetup(input)
      }
    },
    backendId: options.backendId ?? baseFramework.id,
    session: { modelRequired: false },
    prompt: { systemPromptAppends: [] },
    context: { supportsImageInput: false },
    adapter: {
      nativeMcpEnabled: options.nativeMcpEnabled ?? true,
      bridgeMcpAliasesEnabled: options.bridgeMcpAliasesEnabled ?? false
    }
  }
  const commit = vi.fn(() => order.push('capability commit'))
  const release = vi.fn()
  const provision = vi.fn(async () => {
    order.push('capability provision')
    return {
      mcpServers: [],
      descriptor: {
        role: 'primary' as const,
        delegation: 'denied' as const,
        transport: 'none' as const,
        capabilities: options.descriptorCapabilities ?? [],
        canonicalMcpServerNames: [],
        modelFacingMcpServerNames: [],
        controlRpcMethods: []
      },
      commit,
      release
    }
  })
  const creator = new AcpProviderSessionCreator({
    defaultCwd: '/default',
    defaultProjectId: 'default-project',
    currentCwd: () => '/current',
    ensureConnected: vi.fn(async () => {
      order.push('ensure connection')
      return connection
    }),
    assertCurrentConnection: vi.fn(),
    currentBackend: () => backend,
    registry,
    reserveIdentity: (sessionId, startupGeneration) => {
      order.push('identity reservation')
      return registry.reserve({
        sessionIds: [sessionId],
        startupGeneration,
        mayRenewAfterConnectionSetup: true,
        blockStartup: false
      })
    },
    capabilities: { provision },
    capabilityPolicy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
    resolveProjectAgentContext: options.projectAgentContextError
      ? vi.fn(async () => {
          throw options.projectAgentContextError
        })
      : options.projectAgentContext
        ? vi.fn(async () => options.projectAgentContext)
        : undefined,
    resolveSpecialistIdentity: options.specialistIdentity
      ? vi.fn(async () => options.specialistIdentity)
      : undefined,
    configurator: {
      configure:
        options.configure ??
        vi.fn(async () => {
          order.push('configure')
          return { permissionProfile, appliedModel: undefined, configOptions: undefined }
        })
    },
    registerSessionSpecialist: () => {
      order.push('notebook callback')
      options.registerSessionSpecialist?.()
    },
    updateCwd: () => order.push('cwd callback'),
    pushEvent: () => {
      order.push('event callback')
      options.pushEvent?.()
    },
    emitState: () => {
      order.push('state callback')
      options.emitState?.()
    },
    diagnosticContext: () => ({})
  })
  return {
    buildSession,
    commit,
    creator,
    order,
    provision,
    registry,
    release,
    session,
    sessionSetupAppends
  }
}

describe('AcpProviderSessionCreator', () => {
  it('publishes the provider-returned id as the fresh application Session id', async () => {
    const harness = createHarness({ order: [] })

    const result = await harness.creator.create({ cwd: '/workspace', projectId: 'project-a' })

    expect(result).toEqual({
      sessionId: 'provider-session',
      providerSessionId: 'provider-session',
      cwd: resolve('/workspace'),
      frameworkId: 'claude-code',
      backendId: 'claude-code'
    })
    expect(harness.registry.lookup('provider-session')?.attachment?.session).toBe(harness.session)
    expect(harness.commit).toHaveBeenCalledWith('provider-session')
    expect(harness.order).toEqual([
      'ensure connection',
      'capability provision',
      'presentation preflight',
      'session/new',
      'identity reservation',
      'configure',
      'registry publish',
      'capability commit',
      'notebook callback',
      'cwd callback',
      'event callback',
      'state callback'
    ])
  })

  it('disposes the provisional Session and releases capabilities when configuration fails', async () => {
    const failure = new Error('configuration failed')
    const harness = createHarness({ configure: vi.fn().mockRejectedValue(failure) })

    await expect(harness.creator.create({ cwd: '/workspace' })).rejects.toBe(failure)

    expect(harness.session.dispose).toHaveBeenCalledOnce()
    expect(harness.release).toHaveBeenCalledWith({ ownsStableIdentity: true })
    expect(harness.registry.lookup('provider-session')).toBeUndefined()
    expect(harness.commit).not.toHaveBeenCalled()
  })

  it('does not roll back a published Session when observer callbacks fail', async () => {
    const harness = createHarness({
      registerSessionSpecialist: () => {
        throw new Error('notebook observer failed')
      },
      pushEvent: () => {
        throw new Error('event observer failed')
      },
      emitState: () => {
        throw new Error('state observer failed')
      }
    })

    await expect(harness.creator.create({ cwd: '/workspace' })).resolves.toMatchObject({
      sessionId: 'provider-session'
    })
    expect(harness.registry.lookup('provider-session')?.attachment?.session).toBe(harness.session)
    expect(harness.session.dispose).not.toHaveBeenCalled()
    expect(harness.release).not.toHaveBeenCalled()
  })

  it('builds prompt guidance from the effective provisioned capability descriptor', async () => {
    const harness = createHarness({ descriptorCapabilities: [] })
    const enabledHarness = createHarness({ descriptorCapabilities: ['skill-import'] })

    await harness.creator.create({ cwd: '/workspace' })
    await enabledHarness.creator.create({ cwd: '/workspace' })

    expect(harness.sessionSetupAppends.flat()).not.toContain(SKILL_IMPORT_SYSTEM_PROMPT_APPEND)
    expect(enabledHarness.sessionSetupAppends.flat()).toContain(SKILL_IMPORT_SYSTEM_PROMPT_APPEND)
  })

  it('appends Specialist identity after Project Agent Context', async () => {
    const harness = createHarness({
      projectAgentContext: 'Always cite DOIs.',
      specialistIdentity: {
        append: 'specialist identity append',
        prefix: 'specialist turn prefix'
      }
    })

    await harness.creator.create({ projectId: 'project-1', specialistId: 'specialist-1' })

    const appends = harness.sessionSetupAppends.at(-1) ?? []
    expect(appends.at(-2)).toContain('<open_science_project_agent_context>')
    expect(appends.at(-2)).toContain('Always cite DOIs.')
    expect(appends.at(-2)).toContain('</open_science_project_agent_context>')
    expect(appends.at(-1)).toBe('specialist identity append')
  })

  it.each([
    ['claude-code', claudeCodeFramework, true, false, 'claude-code'],
    ['opencode', opencodeFramework, true, false, 'opencode:provider-a'],
    ['codex-response', codexFramework, true, false, 'codex:provider-a'],
    ['codex-bridge', codexFramework, false, true, 'codex:provider-a']
  ] as const)(
    'delivers project Agent Context through the %s launcher boundary',
    async (route, framework, nativeMcpEnabled, bridgeMcpAliasesEnabled, backendId) => {
      const harness = createHarness({
        framework,
        nativeMcpEnabled,
        bridgeMcpAliasesEnabled,
        backendId,
        projectAgentContext: 'Always cite DOIs.'
      })

      await harness.creator.create({ projectId: 'project-1' })

      expect(harness.provision).toHaveBeenCalledWith(
        expect.objectContaining({
          framework: expect.objectContaining({ id: framework.id }),
          nativeMcpEnabled,
          bridgeMcpAliasesEnabled
        })
      )
      if (route === 'claude-code') {
        expect(JSON.stringify(harness.buildSession.mock.calls[0]?.[0]?._meta)).toContain(
          'Always cite DOIs.'
        )
      } else {
        expect(
          harness.registry.lookup('provider-session')?.aggregate.snapshot().sessionSetupPromptPrefix
        ).toContain('Always cite DOIs.')
      }
    }
  )

  it('creates the session without an Agent Context append when no resolver is configured', async () => {
    const harness = createHarness({})

    await harness.creator.create({ projectId: 'project-1' })

    expect(harness.sessionSetupAppends.length).toBeGreaterThan(0)
    expect(harness.sessionSetupAppends.flat()).not.toContain('Always cite DOIs.')
  })

  it('does not start a provider Session when Project Agent Context resolution fails', async () => {
    const failure = new Error('database is locked')
    const harness = createHarness({ projectAgentContextError: failure })

    await expect(harness.creator.create({ projectId: 'project-1' })).rejects.toBe(failure)

    expect(harness.provision).not.toHaveBeenCalled()
    expect(harness.buildSession).not.toHaveBeenCalled()
  })
})
