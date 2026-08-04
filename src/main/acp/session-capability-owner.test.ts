import { describe, expect, it, vi } from 'vitest'

import { opencodeFramework } from '../agent-framework'
import type { AgentMcpHttpHost } from './mcp-http-host'
import {
  AcpSessionCapabilityOwner,
  CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
  REVIEWER_SESSION_CAPABILITY_POLICY,
  policyAllowsSessionCapability
} from './session-capability-owner'

const createOwner = (
  overrides: ConstructorParameters<typeof AcpSessionCapabilityOwner>[0] = {}
): AcpSessionCapabilityOwner =>
  new AcpSessionCapabilityOwner({
    artifacts: {
      dataRoot: '/data',
      projectName: 'project',
      mcpEntryPath: '/app/main.js'
    },
    notebook: {
      projectName: 'project',
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

  it('derives the exact current primary set while reviewer and unknown capabilities fail closed', async () => {
    const owner = createOwner()
    const routingIds = owner.createRoutingIds('session-1')
    const primary = await owner.build({
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      routingIds,
      sessionCwd: '/workspace',
      projectName: 'project'
    })
    const reviewer = await owner.build({
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: REVIEWER_SESSION_CAPABILITY_POLICY,
      routingIds,
      sessionCwd: '/workspace',
      projectName: 'project'
    })

    expect(primary.descriptor.capabilities).toEqual([
      'artifacts',
      'notebook',
      'skill-import',
      'host-agents'
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
    expect(primary.descriptor.controlRpcMethods).toEqual(['mcpCall', 'computeCall', 'agentsCall'])
    expect(reviewer.mcpServers).toEqual([])
    expect(reviewer.descriptor.capabilities).toEqual([])
    expect(policyAllowsSessionCapability(REVIEWER_SESSION_CAPABILITY_POLICY, 'notebook')).toBe(
      false
    )
    expect(
      policyAllowsSessionCapability(CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY, 'future-delegation')
    ).toBe(false)
  })

  it('returns an immutable, credential-free descriptor', async () => {
    const owner = createOwner()
    const built = await owner.build({
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      routingIds: owner.createRoutingIds('session-1'),
      sessionCwd: '/workspace',
      projectName: 'project'
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
    const owner = createOwner({
      notebook: {
        projectName: 'project',
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:1', token: 'notebook' }),
        releaseSessionCapabilities
      }
    })
    const routingIds = owner.createRoutingIds('session-1')
    const built = await owner.build({
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      routingIds,
      sessionCwd: '/workspace',
      projectName: 'project'
    })

    owner.commit({
      appSessionId: 'session-1',
      routingIds,
      descriptor: built.descriptor,
      notebookRelease: firstRelease,
      skillImportRelease: firstSkillImportRelease
    })
    owner.commit({
      appSessionId: 'session-1',
      routingIds,
      descriptor: built.descriptor,
      notebookRelease: secondRelease,
      skillImportRelease: secondSkillImportRelease
    })

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
    const routingIds = owner.createRoutingIds('session-1')
    const built = await owner.build({
      framework: { ...opencodeFramework, acceptsStdioMcp: false },
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      routingIds,
      sessionCwd: '/workspace',
      projectName: 'project'
    })
    owner.commit({ appSessionId: 'session-1', routingIds, descriptor: built.descriptor })

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
        projectName: 'project',
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:1', token: 'notebook' }),
        releaseSessionCapabilities
      }
    })
    const routingIds = owner.createRoutingIds('session-1')
    const built = await owner.build({
      framework: { ...opencodeFramework, acceptsStdioMcp: false },
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      routingIds,
      sessionCwd: '/workspace',
      projectName: 'project'
    })
    owner.commit({
      appSessionId: 'session-1',
      routingIds,
      descriptor: built.descriptor,
      notebookRelease
    })

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
