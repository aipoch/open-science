import { describe, expect, it, vi } from 'vitest'

import { claudeCodeFramework, codexFramework, opencodeFramework } from '../agent-framework'
import type { AgentMcpHttpHost } from './mcp-http-host'
import {
  AcpSessionCapabilityOwner,
  CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
  REVIEWER_SESSION_CAPABILITY_POLICY,
  SIDE_CHAT_SESSION_CAPABILITY_POLICY,
  policyAllowsSessionCapability
} from './session-capability-owner'

const createOwner = (
  overrides: ConstructorParameters<typeof AcpSessionCapabilityOwner>[0] = {}
): AcpSessionCapabilityOwner =>
  new AcpSessionCapabilityOwner({
    artifacts: {
      dataRoot: '/data',
      projectId: 'project',
      mcpEntryPath: '/app/main.js'
    },
    notebook: {
      projectId: 'project',
      mcpEntryPath: '/app/main.js',
      getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:1', token: 'notebook' })
    },
    skillImport: {
      mcpEntryPath: '/app/main.js',
      getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:2', token: 'skill' })
    },
    ...overrides
  })

describe('ACP session capability owner', () => {
  it('marks delegated Notebook MCP processes as ineligible for memory tools', async () => {
    const owner = createOwner({
      artifacts: undefined,
      skillImport: undefined,
      notebook: {
        projectId: 'project',
        mcpEntryPath: '/app/main.js',
        memoryTools: false,
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:1', token: 'delegate' })
      }
    })
    const provision = await owner.provision({
      stableAppSessionId: 'delegate-session',
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace/delegate',
      projectId: 'project'
    })
    const notebook = provision.mcpServers.find((server) => server.name === 'open_science_notebook')

    expect(notebook && 'env' in notebook ? notebook.env : []).toContainEqual({
      name: 'OPEN_SCIENCE_NOTEBOOK_MEMORY_TOOLS',
      value: '0'
    })
  })

  it('binds first-turn Literature routing to the provider Session after session/new', async () => {
    const registerLiterature = vi.fn()
    const handlerFor = vi.fn(() => ({ readDocument: vi.fn() }))
    const host = {
      ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:5', token: 'host' })),
      registerLiterature,
      urlFor: vi.fn((kind: string, routingId: string) => `http://127.0.0.1:5/${kind}/${routingId}`),
      unregister: vi.fn(),
      clear: vi.fn(),
      close: vi.fn()
    } as unknown as AgentMcpHttpHost
    const owner = createOwner({
      artifacts: undefined,
      notebook: undefined,
      skillImport: undefined,
      literature: {
        isEnabled: vi.fn(async () => false),
        handlerFor
      },
      mcpHttpHost: host
    })

    const provision = await owner.provision({
      framework: claudeCodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project-1',
      literatureEnabled: true
    })
    provision.commit('session-1')

    expect(provision.descriptor.capabilities).toContain('literature')
    expect(handlerFor).toHaveBeenLastCalledWith('session-1', 'project-1')
    expect(registerLiterature).toHaveBeenCalledTimes(2)
  })

  it('keeps concurrent first-turn Literature routes distinct within one millisecond', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_234)
    const host = {
      ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:5', token: 'host' })),
      registerLiterature: vi.fn(),
      urlFor: vi.fn((kind: string, routingId: string) => `http://127.0.0.1:5/${kind}/${routingId}`),
      unregister: vi.fn(),
      clear: vi.fn(),
      close: vi.fn()
    } as unknown as AgentMcpHttpHost
    const owner = createOwner({
      artifacts: undefined,
      notebook: undefined,
      skillImport: undefined,
      literature: {
        isEnabled: vi.fn(async () => false),
        handlerFor: () => ({ readDocument: vi.fn() })
      },
      mcpHttpHost: host
    })
    const request = {
      framework: claudeCodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project-1',
      literatureEnabled: true
    } as const

    const [first, second] = await Promise.all([owner.provision(request), owner.provision(request)])

    expect(() => first.commit('session-1')).not.toThrow()
    expect(() => second.commit('session-2')).not.toThrow()
  })

  it.each([
    [claudeCodeFramework, 'open-science-literature'],
    [codexFramework, 'open-science-literature'],
    [opencodeFramework, 'open_science_literature']
  ] as const)(
    'mounts Literature once enabled and keeps it in the capability descriptor for %s',
    async (framework, modelFacingName) => {
      const registerLiterature = vi.fn()
      const host = {
        ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:5', token: 'host' })),
        registerLiterature,
        urlFor: vi.fn(
          (kind: string, routingId: string) => `http://127.0.0.1:5/${kind}/${routingId}`
        ),
        unregister: vi.fn(),
        clear: vi.fn(),
        close: vi.fn()
      } as unknown as AgentMcpHttpHost
      const owner = createOwner({
        artifacts: undefined,
        notebook: undefined,
        skillImport: undefined,
        literature: {
          isEnabled: vi.fn(async () => false),
          handlerFor: () => ({ readDocument: vi.fn() })
        },
        mcpHttpHost: host
      })

      const disabled = await owner.provision({
        stableAppSessionId: 'session-1',
        framework,
        nativeMcpEnabled: true,
        bridgeMcpAliasesEnabled: false,
        policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
        sessionCwd: '/workspace',
        projectId: 'project-1'
      })
      expect(disabled.mcpServers).toEqual([])
      expect(owner.enableLiterature('session-1')).toBe(true)

      const enabled = await owner.provision({
        stableAppSessionId: 'session-1',
        framework,
        nativeMcpEnabled: true,
        bridgeMcpAliasesEnabled: false,
        policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
        sessionCwd: '/workspace',
        projectId: 'project-1'
      })

      expect(enabled.descriptor).toMatchObject({
        capabilities: ['literature'],
        canonicalMcpServerNames: ['open-science-literature'],
        modelFacingMcpServerNames: [modelFacingName]
      })
      expect(enabled.mcpServers).toEqual([
        expect.objectContaining({ type: 'http', name: modelFacingName })
      ])
      expect(registerLiterature).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({ readDocument: expect.any(Function) })
      )
    }
  )

  it('removes Literature from the next provider capability projection when disabled', async () => {
    const host = {
      ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:5', token: 'host' })),
      registerLiterature: vi.fn(),
      urlFor: vi.fn((kind: string, routingId: string) => `http://127.0.0.1:5/${kind}/${routingId}`),
      unregister: vi.fn(),
      clear: vi.fn(),
      close: vi.fn()
    } as unknown as AgentMcpHttpHost
    const owner = createOwner({
      artifacts: undefined,
      notebook: undefined,
      skillImport: undefined,
      literature: {
        isEnabled: vi.fn(async () => false),
        handlerFor: () => ({ readDocument: vi.fn() })
      },
      mcpHttpHost: host
    })
    const enabled = await owner.provision({
      stableAppSessionId: 'session-1',
      framework: codexFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project-1',
      literatureEnabled: true
    })
    enabled.commit('session-1')

    expect(owner.disableLiterature('session-1')).toBe(true)
    const disabled = await owner.provision({
      stableAppSessionId: 'session-1',
      framework: codexFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project-1'
    })

    expect(disabled.descriptor.capabilities).not.toContain('literature')
    expect(disabled.mcpServers).toEqual([])
  })

  it('restores the committed Literature route when replacement provisioning is released', async () => {
    const registerLiterature = vi.fn()
    const unregister = vi.fn()
    const handlerFor = vi.fn(() => ({ readDocument: vi.fn() }))
    const host = {
      ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:5', token: 'host' })),
      registerLiterature,
      urlFor: vi.fn((kind: string, routingId: string) => `http://127.0.0.1:5/${kind}/${routingId}`),
      unregister,
      clear: vi.fn(),
      close: vi.fn()
    } as unknown as AgentMcpHttpHost
    const owner = createOwner({
      artifacts: undefined,
      notebook: undefined,
      skillImport: undefined,
      literature: { isEnabled: vi.fn(async () => false), handlerFor },
      mcpHttpHost: host
    })
    const enabled = await owner.provision({
      stableAppSessionId: 'session-1',
      framework: codexFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project-1',
      literatureEnabled: true
    })
    enabled.commit('session-1')
    registerLiterature.mockClear()

    expect(owner.disableLiterature('session-1')).toBe(true)
    const replacement = await owner.provision({
      stableAppSessionId: 'session-1',
      framework: codexFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project-1'
    })
    replacement.release({ ownsStableIdentity: true })

    expect(unregister).toHaveBeenCalledWith('session-1')
    expect(registerLiterature).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ readDocument: expect.any(Function) })
    )
    expect(handlerFor).toHaveBeenLastCalledWith('session-1', 'project-1')
  })

  it('uses an execution-owned Artifact handoff file for a delegated runtime', async () => {
    const owner = createOwner({
      artifacts: {
        dataRoot: '/data',
        projectId: 'project',
        mcpEntryPath: '/app/main.js',
        currentRunFile: '/data/delegated/executions/attempt-1.json'
      },
      notebook: undefined,
      skillImport: undefined
    })

    const provision = await owner.provision({
      stableAppSessionId: 'provider-child-session',
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace/child',
      projectId: 'project-1'
    })
    const artifact = provision.mcpServers.find((server) => server.name === 'open_science_artifacts')

    expect(artifact && 'env' in artifact ? artifact.env : []).toContainEqual({
      name: 'OPEN_SCIENCE_ARTIFACT_CURRENT_RUN_FILE',
      value: '/data/delegated/executions/attempt-1.json'
    })
  })

  it.each([
    [claudeCodeFramework, 'open-science-host-message'],
    [codexFramework, 'open-science-host-message'],
    [opencodeFramework, 'open_science_host_message']
  ] as const)(
    'provisions only the relationship-bound Side chat message tool for %s',
    async (framework, modelFacingName) => {
      const sendMessage = vi.fn()
      const registerHostMessage = vi.fn()
      const host = {
        ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:3', token: 'host' })),
        registerHostMessage,
        urlFor: vi.fn(
          (kind: string, routingId: string) => `http://127.0.0.1:3/${kind}/${routingId}`
        ),
        unregister: vi.fn(),
        clear: vi.fn(),
        close: vi.fn()
      } as unknown as AgentMcpHttpHost
      const owner = createOwner({
        artifacts: undefined,
        notebook: undefined,
        skillImport: undefined,
        sideChat: { sendMessage },
        mcpHttpHost: host
      })

      const provision = await owner.provision({
        stableAppSessionId: 'side-1',
        framework,
        nativeMcpEnabled: true,
        bridgeMcpAliasesEnabled: false,
        policy: SIDE_CHAT_SESSION_CAPABILITY_POLICY,
        sessionCwd: '/empty',
        projectId: 'project-1'
      })

      expect(provision.descriptor).toMatchObject({
        role: 'side-chat',
        transport: 'http',
        capabilities: ['host-message'],
        canonicalMcpServerNames: ['open-science-host-message'],
        modelFacingMcpServerNames: [modelFacingName]
      })
      expect(provision.mcpServers).toEqual([
        expect.objectContaining({ type: 'http', name: modelFacingName })
      ])
      expect(registerHostMessage).toHaveBeenCalledWith(
        'side-1',
        expect.objectContaining({ sendMessage: expect.any(Function) })
      )
      await registerHostMessage.mock.calls[0][1].sendMessage({ target: 'main', text: 'hello' })
      expect(sendMessage).toHaveBeenCalledWith('side-1', { target: 'main', text: 'hello' })
    }
  )

  it.each([
    [claudeCodeFramework, 'open-science-plan'],
    [codexFramework, 'open-science-plan'],
    [opencodeFramework, 'open_science_plan']
  ] as const)('projects the same Session Plan tools for %s', async (framework, modelFacingName) => {
    const release = vi.fn()
    const owner = createOwner({
      artifacts: undefined,
      notebook: undefined,
      skillImport: undefined,
      plan: {
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:4',
          token: 'plan',
          release
        })
      }
    })
    const provision = await owner.provision({
      stableAppSessionId: 'session-1',
      framework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project-1'
    })

    expect(provision.descriptor).toMatchObject({
      transport: 'stdio',
      capabilities: ['plan'],
      canonicalMcpServerNames: ['open-science-plan'],
      modelFacingMcpServerNames: [modelFacingName]
    })
    provision.commit('session-1')
    owner.revokeSession('session-1')
    expect(release).toHaveBeenCalledOnce()
  })

  it('provisions the Session Plan capability over stdio with server-owned identity', async () => {
    const owner = createOwner({
      artifacts: undefined,
      notebook: undefined,
      skillImport: undefined,
      plan: {
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4', token: 'plan' })
      }
    })

    const provision = await owner.provision({
      stableAppSessionId: 'session-1',
      framework: { ...opencodeFramework, acceptsStdioMcp: true },
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project-1'
    })

    expect(provision.descriptor.capabilities).toEqual(['plan'])
    expect(provision.mcpServers).toEqual([
      expect.objectContaining({
        name: 'open_science_plan',
        env: expect.arrayContaining([
          { name: 'OPEN_SCIENCE_PLAN_PROJECT_ID', value: 'project-1' },
          { name: 'OPEN_SCIENCE_PLAN_SESSION_ID', value: 'session-1' }
        ])
      })
    ])
  })

  it('aliases a provisional Plan capability to the stable app Session on commit', async () => {
    const registerSessionAlias = vi.fn()
    const owner = createOwner({
      artifacts: undefined,
      notebook: undefined,
      skillImport: undefined,
      plan: {
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4', token: 'plan' }),
        registerSessionAlias
      }
    })

    const provision = await owner.provision({
      framework: { ...opencodeFramework, acceptsStdioMcp: true },
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project-1'
    })
    const planServer = provision.mcpServers[0]
    expect(planServer && 'env' in planServer).toBe(true)
    const provisionalId = (planServer && 'env' in planServer ? planServer.env : undefined)?.find(
      (entry) => entry.name === 'OPEN_SCIENCE_PLAN_SESSION_ID'
    )?.value
    provision.commit('session-1')

    expect(provisionalId).toMatch(/^plan-session-/u)
    expect(registerSessionAlias).toHaveBeenCalledWith(provisionalId, 'session-1')
  })

  it('commits framework MCP servers as trusted Session identities', async () => {
    const owner = createOwner({ artifacts: undefined, notebook: undefined, skillImport: undefined })
    const provision = await owner.provision({
      stableAppSessionId: 'session-1',
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project-1'
    })
    const built = provision.includeFrameworkMcpServers([
      { name: 'skills', command: '/app/open-science', args: ['skill-runtime-mcp'], env: [] }
    ])

    expect(built.mcpServers).toEqual([
      { name: 'skills', command: '/app/open-science', args: ['skill-runtime-mcp'], env: [] }
    ])
    expect(built.descriptor).toMatchObject({
      transport: 'stdio',
      canonicalMcpServerNames: ['skills'],
      modelFacingMcpServerNames: ['skills']
    })

    provision.commit('session-1')
    expect(owner.mcpServerNamesFor('session-1')).toEqual(['skills'])
    expect(owner.mcpServersFor('session-1')).toEqual(built.mcpServers)

    owner.revokeSession('session-1')
    expect(owner.mcpServersFor('session-1')).toEqual([])
  })

  it('rejects colliding framework MCP server identities', async () => {
    const owner = createOwner({ artifacts: undefined, notebook: undefined, skillImport: undefined })
    const provision = await owner.provision({
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project-1'
    })

    expect(() =>
      provision.includeFrameworkMcpServers([
        { name: 'skills', command: '/app/open-science', args: ['skill-runtime-mcp'], env: [] },
        { name: 'skills', command: '/app/open-science', args: ['other-mcp'], env: [] }
      ])
    ).toThrow('Framework MCP server names must be unique within the Session.')
  })

  it('refreshes preference-backed availability before backend guidance is projected', async () => {
    let skillImportEnabled = false
    const owner = createOwner({
      skillImport: {
        mcpEntryPath: '/app/main.js',
        isEnabled: async () => skillImportEnabled,
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:2', token: 'skill' })
      }
    })
    const input = {
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY
    }

    await owner.refreshDynamicAvailability()
    expect(owner.toolingAvailability(input).skillImport).toBe(false)

    skillImportEnabled = true
    await owner.refreshDynamicAvailability()
    expect(owner.toolingAvailability(input).skillImport).toBe(true)
  })

  it('commits a provision under the stable app identity', async () => {
    const release = vi.fn()
    const registerSessionAlias = vi.fn()
    const releaseSessionCapabilities = vi.fn()
    const owner = createOwner({
      artifacts: undefined,
      skillImport: undefined,
      notebook: {
        projectId: 'project',
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:1',
          token: 'notebook',
          release
        }),
        registerSessionAlias,
        releaseSessionCapabilities
      }
    })

    const provision = await owner.provision({
      stableAppSessionId: 'provider-session',
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project'
    })

    provision.commit('app-session')

    expect(registerSessionAlias).toHaveBeenCalledWith('provider-session', 'app-session')
    expect(owner.mcpServerNamesFor('app-session')).toEqual(['open-science-notebook'])
    expect(release).not.toHaveBeenCalled()

    owner.revokeSession('app-session')
    expect(release).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).toHaveBeenCalledWith('app-session')
  })

  it('releases acquired local RPC leases when a later provision step fails', async () => {
    const notebookRelease = vi.fn()
    const releaseSessionCapabilities = vi.fn()
    const owner = createOwner({
      notebook: {
        projectId: 'project',
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:1',
          token: 'notebook',
          release: notebookRelease
        }),
        releaseSessionCapabilities
      },
      skillImport: {
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => {
          throw new Error('Skill import RPC unavailable')
        }
      }
    })

    await expect(
      owner.provision({
        stableAppSessionId: 'session-1',
        framework: opencodeFramework,
        nativeMcpEnabled: true,
        bridgeMcpAliasesEnabled: false,
        policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
        sessionCwd: '/workspace',
        projectId: 'project'
      })
    ).rejects.toThrow('Skill import RPC unavailable')
    expect(notebookRelease).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).toHaveBeenCalledWith('session-1')
  })

  it('unregisters partial HTTP routes when provision building fails', async () => {
    const unregister = vi.fn()
    const host = {
      ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:3', token: 'host' })),
      registerArtifact: vi.fn(),
      registerNotebook: vi.fn(),
      registerSkillImport: vi.fn(),
      urlFor: vi.fn((kind: string, routingId: string) => `http://127.0.0.1:3/${kind}/${routingId}`),
      unregister,
      clear: vi.fn(),
      close: vi.fn()
    } as unknown as AgentMcpHttpHost
    const owner = createOwner({
      mcpHttpHost: host,
      skillImport: {
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => {
          throw new Error('Skill import RPC unavailable')
        }
      }
    })

    await expect(
      owner.provision({
        stableAppSessionId: 'session-1',
        framework: { ...opencodeFramework, acceptsStdioMcp: false },
        nativeMcpEnabled: true,
        bridgeMcpAliasesEnabled: false,
        policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
        sessionCwd: '/workspace',
        projectId: 'project'
      })
    ).rejects.toThrow('Skill import RPC unavailable')

    expect(unregister).toHaveBeenCalledOnce()
    expect(unregister).toHaveBeenCalledWith('session-1')
  })

  it('revokes a committed same-ID HTTP route when its replacement fails before registration', async () => {
    const startupFailure = new Error('MCP host startup failed')
    const ensureStarted = vi
      .fn()
      .mockResolvedValueOnce({ endpoint: 'http://127.0.0.1:3', token: 'host' })
      .mockRejectedValueOnce(startupFailure)
    const unregister = vi.fn()
    const host = {
      ensureStarted,
      registerNotebook: vi.fn(),
      urlFor: vi.fn((kind: string, routingId: string) => `http://127.0.0.1:3/${kind}/${routingId}`),
      unregister,
      clear: vi.fn(),
      close: vi.fn()
    } as unknown as AgentMcpHttpHost
    const owner = createOwner({
      artifacts: undefined,
      skillImport: undefined,
      mcpHttpHost: host
    })
    const input = {
      stableAppSessionId: 'session-1',
      framework: { ...opencodeFramework, acceptsStdioMcp: false },
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project'
    }
    const committed = await owner.provision(input)
    committed.commit('session-1')

    await expect(owner.provision(input)).rejects.toBe(startupFailure)

    expect(unregister).toHaveBeenCalledOnce()
    expect(unregister).toHaveBeenCalledWith('session-1')
  })

  it('retains provisional cleanup ownership through disposal', async () => {
    let resolveConnection!: (connection: { endpoint: string; token: string }) => void
    const connection = new Promise<{ endpoint: string; token: string }>((resolve) => {
      resolveConnection = resolve
    })
    const getRpcConnection = vi.fn(() => connection)
    const unregister = vi.fn()
    const clear = vi.fn()
    const registerNotebook = vi.fn()
    const host = {
      ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:3', token: 'host' })),
      registerNotebook,
      urlFor: vi.fn((kind: string, routingId: string) => `http://127.0.0.1:3/${kind}/${routingId}`),
      unregister,
      clear,
      close: vi.fn()
    } as unknown as AgentMcpHttpHost
    const owner = createOwner({
      artifacts: undefined,
      skillImport: undefined,
      mcpHttpHost: host,
      notebook: {
        projectId: 'project',
        mcpEntryPath: '/app/main.js',
        getRpcConnection
      }
    })
    const provisionPromise = owner.provision({
      stableAppSessionId: 'session-1',
      framework: { ...opencodeFramework, acceptsStdioMcp: false },
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project'
    })
    await vi.waitFor(() => expect(getRpcConnection).toHaveBeenCalledOnce())

    owner.dispose()
    owner.clearHttpRoutes()
    resolveConnection({ endpoint: 'http://127.0.0.1:1', token: 'notebook' })
    const provision = await provisionPromise
    provision.release({ ownsStableIdentity: true })

    expect(clear).toHaveBeenCalledOnce()
    expect(registerNotebook).not.toHaveBeenCalled()
    expect(unregister).toHaveBeenCalledOnce()
    expect(unregister).toHaveBeenCalledWith('session-1')
  })

  it('prevents a stale HTTP provision from overwriting its same-ID successor', async () => {
    let resolveFirstConnection!: (connection: { endpoint: string; token: string }) => void
    const firstConnection = new Promise<{ endpoint: string; token: string }>((resolve) => {
      resolveFirstConnection = resolve
    })
    let connectionIndex = 0
    const getRpcConnection = vi.fn(() => {
      connectionIndex += 1
      return connectionIndex === 1
        ? firstConnection
        : Promise.resolve({ endpoint: 'http://127.0.0.1:2', token: 'successor' })
    })
    const registerNotebook = vi.fn()
    const unregister = vi.fn()
    const host = {
      ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:3', token: 'host' })),
      registerNotebook,
      urlFor: vi.fn((kind: string, routingId: string) => `http://127.0.0.1:3/${kind}/${routingId}`),
      unregister,
      clear: vi.fn(),
      close: vi.fn()
    } as unknown as AgentMcpHttpHost
    const owner = createOwner({
      artifacts: undefined,
      skillImport: undefined,
      mcpHttpHost: host,
      notebook: {
        projectId: 'project',
        mcpEntryPath: '/app/main.js',
        getRpcConnection
      }
    })
    const input = {
      stableAppSessionId: 'session-1',
      framework: { ...opencodeFramework, acceptsStdioMcp: false },
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project'
    }
    const staleProvisionPromise = owner.provision(input)
    await vi.waitFor(() => expect(getRpcConnection).toHaveBeenCalledOnce())
    owner.dispose()
    owner.clearHttpRoutes()

    const successor = await owner.provision(input)
    successor.commit('session-1')
    resolveFirstConnection({ endpoint: 'http://127.0.0.1:1', token: 'stale' })
    const stale = await staleProvisionPromise
    stale.release({ ownsStableIdentity: true })

    expect(registerNotebook).toHaveBeenCalledOnce()
    expect(registerNotebook).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ token: 'successor' })
    )
    expect(unregister).not.toHaveBeenCalled()
  })

  it('rejects a provision commit from before owner disposal', async () => {
    const owner = createOwner({ artifacts: undefined, skillImport: undefined })
    const provision = await owner.provision({
      stableAppSessionId: 'session-1',
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project'
    })

    owner.dispose()

    expect(() => provision.commit('session-1')).toThrow('provision was superseded')
    expect(owner.mcpServerNamesFor('session-1')).toEqual([])
  })

  it('performs only the first terminal provision action', async () => {
    const release = vi.fn()
    const registerSessionAlias = vi.fn()
    const releaseSessionCapabilities = vi.fn()
    const owner = createOwner({
      artifacts: undefined,
      skillImport: undefined,
      notebook: {
        projectId: 'project',
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:1',
          token: 'notebook',
          release
        }),
        registerSessionAlias,
        releaseSessionCapabilities
      }
    })
    const provision = await owner.provision({
      stableAppSessionId: 'provider-session',
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project'
    })

    provision.release({ ownsStableIdentity: true })
    provision.release({ ownsStableIdentity: true })
    provision.commit('app-session')

    expect(release).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).toHaveBeenCalledWith('provider-session')
    expect(registerSessionAlias).not.toHaveBeenCalled()
    expect(owner.mcpServerNamesFor('app-session')).toEqual([])
  })

  it('does not broadly revoke stable capability state from a superseded provision', async () => {
    const firstRelease = vi.fn()
    const secondRelease = vi.fn()
    const releaseSessionCapabilities = vi.fn()
    let provisionIndex = 0
    const owner = createOwner({
      artifacts: undefined,
      skillImport: undefined,
      notebook: {
        projectId: 'project',
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:1',
          token: 'notebook',
          release: [firstRelease, secondRelease][provisionIndex++]
        }),
        releaseSessionCapabilities
      }
    })
    const input = {
      stableAppSessionId: 'session-1',
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project'
    }
    const first = await owner.provision(input)
    const second = await owner.provision(input)

    first.release({ ownsStableIdentity: true })

    expect(firstRelease).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).not.toHaveBeenCalled()

    second.commit('session-1')
    owner.revokeSession('session-1')
    expect(secondRelease).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).toHaveBeenCalledOnce()
  })

  it('rejects commit from a superseded stable-identity provision', async () => {
    const firstRelease = vi.fn()
    const secondRelease = vi.fn()
    const releaseSessionCapabilities = vi.fn()
    let provisionIndex = 0
    const owner = createOwner({
      artifacts: undefined,
      skillImport: undefined,
      notebook: {
        projectId: 'project',
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:1',
          token: 'notebook',
          release: [firstRelease, secondRelease][provisionIndex++]
        }),
        releaseSessionCapabilities
      }
    })
    const input = {
      stableAppSessionId: 'session-1',
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project'
    }
    const first = await owner.provision(input)
    const second = await owner.provision(input)

    expect(() => first.commit('stale-session')).toThrow('provision was superseded')
    expect(firstRelease).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).not.toHaveBeenCalled()
    expect(owner.mcpServerNamesFor('stale-session')).toEqual([])

    second.commit('session-1')
    owner.revokeSession('session-1')
    expect(secondRelease).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).toHaveBeenCalledOnce()
  })

  it('derives the exact current primary set while reviewer and unknown capabilities fail closed', async () => {
    const owner = createOwner()
    const primary = await owner.provision({
      stableAppSessionId: 'session-1',
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project'
    })
    const reviewer = await owner.provision({
      stableAppSessionId: 'reviewer-session',
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: REVIEWER_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project'
    })

    expect(primary.descriptor.capabilities).toEqual([
      'artifacts',
      'notebook',
      'skill-import',
      'host-agents',
      'host-skills',
      'host-frames',
      'host-sessions',
      'host-llm'
    ])
    expect(primary.descriptor.modelFacingMcpServerNames).toEqual([
      'open_science_artifacts',
      'open_science_notebook',
      'open_science_skills'
    ])
    expect(primary.descriptor.canonicalMcpServerNames).toEqual([
      'open-science-artifacts',
      'open-science-notebook',
      'open-science-skills'
    ])
    expect(primary.descriptor.controlRpcMethods).toEqual([
      'capabilitiesCall',
      'lineageCall',
      'mcpCall',
      'computeCall',
      'agentsCall',
      'skillsCall',
      'framesCall',
      'sessionsCall',
      'currentModelCall',
      'listModelsCall',
      'llmCall',
      'viewImageCall'
    ])
    expect(reviewer.mcpServers).toEqual([])
    expect(reviewer.descriptor.capabilities).toEqual([])
    expect(policyAllowsSessionCapability(REVIEWER_SESSION_CAPABILITY_POLICY, 'notebook')).toBe(
      false
    )
    expect(
      policyAllowsSessionCapability(CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY, 'future-delegation')
    ).toBe(false)
  })

  it.each([
    [
      'claude-code',
      claudeCodeFramework,
      true,
      false,
      'open-science-artifacts',
      'open-science-notebook'
    ],
    ['opencode', opencodeFramework, true, false, 'open_science_artifacts', 'open_science_notebook'],
    [
      'codex-response',
      codexFramework,
      true,
      false,
      'open-science-artifacts',
      'open-science-notebook'
    ],
    ['codex-bridge', codexFramework, false, true, 'open-science-artifacts', 'open-science-notebook']
  ] as const)(
    'publishes the bounded Artifact/Notebook control plane through the %s primary descriptor',
    async (
      _route,
      framework,
      nativeMcpEnabled,
      bridgeMcpAliasesEnabled,
      artifactServerName,
      notebookServerName
    ) => {
      const owner = createOwner()
      const built = await owner.provision({
        stableAppSessionId: 'session-1',
        framework,
        nativeMcpEnabled,
        bridgeMcpAliasesEnabled,
        policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
        sessionCwd: '/workspace',
        projectId: 'project',
        memoryEnabled: false
      })

      expect(built.descriptor.controlRpcMethods).toEqual(
        expect.arrayContaining([
          'capabilitiesCall',
          'lineageCall',
          'skillsCall',
          'framesCall',
          'sessionsCall',
          'currentModelCall',
          'listModelsCall',
          'llmCall'
        ])
      )
      expect(built.descriptor.capabilities).toEqual(
        expect.arrayContaining([
          'notebook',
          'host-skills',
          'host-frames',
          'host-sessions',
          'host-llm'
        ])
      )
      expect(built.descriptor.transport).toBe('stdio')
      expect(built.descriptor.modelFacingMcpServerNames).toContain(artifactServerName)
      expect(built.descriptor.modelFacingMcpServerNames).toContain(notebookServerName)
      const notebook = built.mcpServers.find((server) => server.name === notebookServerName)
      expect(notebook && 'env' in notebook ? notebook.env : []).toContainEqual({
        name: 'OPEN_SCIENCE_NOTEBOOK_MEMORY_TOOLS',
        value: '1'
      })
    }
  )

  it('returns an immutable, credential-free descriptor', async () => {
    const owner = createOwner()
    const built = await owner.provision({
      stableAppSessionId: 'session-1',
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project'
    })

    expect(Object.isFrozen(built.descriptor)).toBe(true)
    expect(Object.isFrozen(built.descriptor.capabilities)).toBe(true)
    expect(JSON.stringify(built.descriptor)).not.toMatch(
      /notebook-token|skill-token|127\.0\.0\.1|workspace|\/data/
    )
  })

  it('publishes replacement ownership before releasing the prior lease and revokes once', async () => {
    const firstRelease = vi.fn()
    const secondRelease = vi.fn()
    const firstSkillImportRelease = vi.fn()
    const secondSkillImportRelease = vi.fn()
    const releaseSessionCapabilities = vi.fn()
    let notebookProvision = 0
    let skillImportProvision = 0
    const owner = createOwner({
      notebook: {
        projectId: 'project',
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:1',
          token: 'notebook',
          release: [firstRelease, secondRelease][notebookProvision++]
        }),
        releaseSessionCapabilities
      },
      skillImport: {
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:2',
          token: 'skill',
          release: [firstSkillImportRelease, secondSkillImportRelease][skillImportProvision++]
        })
      }
    })
    const first = await owner.provision({
      stableAppSessionId: 'session-1',
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project'
    })
    first.commit('session-1')
    const second = await owner.provision({
      stableAppSessionId: 'session-1',
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project'
    })

    second.commit('session-1')

    expect(firstRelease).toHaveBeenCalledOnce()
    expect(firstSkillImportRelease).toHaveBeenCalledOnce()
    expect(secondRelease).not.toHaveBeenCalled()
    expect(secondSkillImportRelease).not.toHaveBeenCalled()

    owner.revokeSession('session-1')
    owner.revokeSession('session-1')

    expect(secondRelease).toHaveBeenCalledOnce()
    expect(secondSkillImportRelease).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).toHaveBeenCalledOnce()
  })

  it('keeps per-session route revocation separate from the HTTP host lifetime', async () => {
    const unregister = vi.fn()
    const close = vi.fn()
    const host = {
      ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:3', token: 'host' })),
      registerArtifact: vi.fn(),
      registerNotebook: vi.fn(),
      registerSkillImport: vi.fn(),
      urlFor: vi.fn((kind: string, routingId: string) => `http://127.0.0.1:3/${kind}/${routingId}`),
      unregister,
      clear: vi.fn(),
      close
    } as unknown as AgentMcpHttpHost
    const owner = createOwner({ mcpHttpHost: host })
    const provision = await owner.provision({
      stableAppSessionId: 'session-1',
      framework: { ...opencodeFramework, acceptsStdioMcp: false },
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project'
    })
    provision.commit('session-1')

    owner.revokeSession('session-1')

    expect(unregister).toHaveBeenCalledTimes(3)
    expect(close).not.toHaveBeenCalled()
  })

  it('finishes bearer and owner cleanup when a committed HTTP route unregister throws', async () => {
    const notebookRelease = vi.fn()
    const releaseSessionCapabilities = vi.fn()
    const unregister = vi.fn(() => {
      throw new Error('route cleanup failed')
    })
    const host = {
      ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:3', token: 'host' })),
      registerNotebook: vi.fn(),
      urlFor: vi.fn((kind: string, routingId: string) => `http://127.0.0.1:3/${kind}/${routingId}`),
      unregister,
      clear: vi.fn(),
      close: vi.fn()
    } as unknown as AgentMcpHttpHost
    const owner = createOwner({
      artifacts: undefined,
      skillImport: undefined,
      mcpHttpHost: host,
      notebook: {
        projectId: 'project',
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:1',
          token: 'notebook',
          release: notebookRelease
        }),
        releaseSessionCapabilities
      }
    })
    const provision = await owner.provision({
      stableAppSessionId: 'session-1',
      framework: { ...opencodeFramework, acceptsStdioMcp: false },
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project'
    })
    provision.commit('session-1')

    expect(() => owner.revokeSession('session-1')).not.toThrow()
    expect(unregister).toHaveBeenCalledOnce()
    expect(notebookRelease).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).toHaveBeenCalledOnce()
    expect(owner.mcpServerNamesFor('session-1')).toEqual([])

    owner.revokeSession('session-1')
    expect(notebookRelease).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).toHaveBeenCalledOnce()
  })
})
