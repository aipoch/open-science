import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeCodeFramework, codexFramework, opencodeFramework } from '../agent-framework'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import type { NotebookRpcConnection } from '../notebook/mcp-server'
import { AgentMcpHttpHost } from './mcp-http-host'
import {
  AcpSessionCapabilityOwner,
  CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
  type SessionCapabilityProvision
} from './session-capability-owner'

const paths = [
  { name: 'claude-code', framework: claudeCodeFramework, native: true, bridge: false },
  { name: 'opencode', framework: opencodeFramework, native: true, bridge: false },
  { name: 'codex-response', framework: codexFramework, native: true, bridge: false },
  { name: 'codex-bridge', framework: codexFramework, native: false, bridge: true }
]
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()))
})

const call = async (
  connection: NotebookRpcConnection
): Promise<{ status: number; body: unknown }> => {
  const response = await fetch(connection.endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'capabilitiesCall', params: {} })
  })
  return { status: response.status, body: await response.json() }
}
const expectRevoked = async (connections: NotebookRpcConnection[]): Promise<void> => {
  for (const connection of connections) {
    expect(await call(connection)).toEqual({
      status: 401,
      body: { error: 'Invalid notebook RPC token.' }
    })
  }
}
// The provider process is outside this boundary. Exercise the real capability owners and RPC
// admission used by every tool, including the separate Skill-import/Plan credentials.
type ProvisionedSession = {
  pending: SessionCapabilityProvision
  issued: NotebookRpcConnection[]
  expectUsable: () => Promise<void>
}
type HandoverHarness = {
  rpc: NotebookLocalRpcServer
  createOwner: (beforeSkill?: () => Promise<void>) => AcpSessionCapabilityOwner
  provision: (
    owner: AcpSessionCapabilityOwner,
    sessionId?: string,
    commit?: boolean,
    provisionalAlias?: boolean
  ) => Promise<ProvisionedSession>
  onSessionReleased: ReturnType<typeof vi.fn>
}
const createHarness = (path: (typeof paths)[number]): HandoverHarness => {
  const onSessionReleased = vi.fn()
  const rpc = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
    transport: 'tcp',
    onSessionReleased
  })
  cleanups.push(() => rpc.close())
  const connections: NotebookRpcConnection[] = []
  const capture = async (
    connection: Promise<NotebookRpcConnection>
  ): Promise<NotebookRpcConnection> => {
    const issued = await connection
    connections.push(issued)
    return issued
  }
  const createOwner = (beforeSkill?: () => Promise<void>): AcpSessionCapabilityOwner => {
    const host = new AgentMcpHttpHost()
    cleanups.push(() => host.close())
    const releaseSessionCapabilities = (sessionId: string, tokens: readonly string[]): void =>
      rpc.releaseSessionCapabilitiesIfOwned(sessionId, tokens)
    return new AcpSessionCapabilityOwner({
      mcpHttpHost: host,
      notebook: {
        projectId: 'project',
        mcpEntryPath: '/app/main.js',
        getRpcConnection: ({ sessionId, projectId, memoryTools }) =>
          capture(
            rpc.issueSessionConnection(sessionId, projectId, `root-frame-${sessionId}`, memoryTools)
          ),
        registerSessionAlias: (alias, sessionId) => rpc.registerSessionAlias(alias, sessionId),
        releaseSessionCapabilities
      },
      skillImport: {
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async ({ sessionId }) => {
          await beforeSkill?.()
          return capture(rpc.issueSkillImportConnection(sessionId))
        },
        registerSessionAlias: (alias, sessionId) => rpc.registerSessionAlias(alias, sessionId),
        releaseSessionCapabilities
      },
      plan: {
        mcpEntryPath: '/app/main.js',
        getRpcConnection: ({ sessionId, projectId }) =>
          capture(rpc.issuePlanConnection(sessionId, projectId)),
        registerSessionAlias: (alias, sessionId) => rpc.registerSessionAlias(alias, sessionId)
      }
    })
  }
  const provision = async (
    owner: AcpSessionCapabilityOwner,
    sessionId = 'session',
    commit = true,
    provisionalAlias = false
  ): Promise<ProvisionedSession> => {
    const start = connections.length
    const pending = await owner.provision({
      ...(provisionalAlias ? {} : { stableAppSessionId: sessionId }),
      framework: path.framework,
      nativeMcpEnabled: path.native,
      bridgeMcpAliasesEnabled: path.bridge,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project'
    })
    if (commit) pending.commit(sessionId)
    const issued = connections.slice(start)
    expect(issued).toHaveLength(3)
    const before = await Promise.all(issued.map(call))
    expect(before[0].status).toBe(200)
    // Capability discovery is forbidden for the narrower credentials, but authentication succeeds.
    expect(before[1].status).not.toBe(401)
    expect(before[2].status).not.toBe(401)
    return {
      pending,
      issued,
      expectUsable: async (): Promise<void> => {
        expect(await Promise.all(issued.map(call))).toEqual(before)
      }
    }
  }
  return { rpc, createOwner, provision, onSessionReleased }
}

describe.each(paths)('$name capability handover', (path) => {
  it.each(['retire', 'revoke', 'rollback', 'same-owner', 'alias'] as const)(
    'preserves successor credentials during %s cleanup and revokes the final owner',
    async (cleanup) => {
      const { rpc, createOwner, provision, onSessionReleased } = createHarness(path)
      const outgoing = createOwner()
      const incoming = cleanup === 'same-owner' ? outgoing : createOwner()
      const original = await provision(
        outgoing,
        'session',
        cleanup !== 'rollback',
        cleanup === 'alias'
      )
      const control = await rpc.issueControlConnection('session', 'project', 'root-frame-session')
      const replacement = await provision(incoming)
      await expectRevoked(original.issued)
      if (cleanup === 'rollback') original.pending.release({ ownsStableIdentity: true })
      else if (cleanup === 'revoke') outgoing.revokeSession('session')
      else if (cleanup !== 'same-owner') outgoing.dispose(['session'])
      await replacement.expectUsable()
      expect(onSessionReleased).not.toHaveBeenCalled()
      incoming.dispose(['session'])
      await expectRevoked(replacement.issued)
      expect(onSessionReleased).toHaveBeenCalledExactlyOnceWith('session')
      // Notebook RuntimeSession owns this independent control capability, not the ACP runtime.
      expect((await call(control)).status).toBe(200)
      control.release()
    }
  )

  it('cleans a remaining old Session without touching a transferred Session on delayed retirement', async () => {
    const { createOwner, provision, onSessionReleased } = createHarness(path)
    const outgoing = createOwner()
    await provision(outgoing, 'transferred')
    const remaining = await provision(outgoing, 'remaining')
    const incoming = createOwner()
    const replacement = await provision(incoming, 'transferred')
    outgoing.dispose(['transferred', 'remaining'])
    await replacement.expectUsable()
    await expectRevoked(remaining.issued)
    expect(onSessionReleased).toHaveBeenCalledExactlyOnceWith('remaining')
  })

  it('preserves a published successor when an earlier startup fails after acquiring a credential', async () => {
    const { createOwner, provision, onSessionReleased } = createHarness(path)
    const incoming = createOwner()
    let replacement: Awaited<ReturnType<typeof provision>> | undefined
    const outgoing = createOwner(async () => {
      replacement = await provision(incoming)
      throw new Error('earlier startup failed')
    })
    await expect(provision(outgoing)).rejects.toThrow('earlier startup failed')
    expect(replacement).toBeDefined()
    await replacement!.expectUsable()
    expect(onSessionReleased).not.toHaveBeenCalled()
  })

  it('allows a fresh connection after the previous runtime has already retired', async () => {
    const { createOwner, provision } = createHarness(path)
    const outgoing = createOwner()
    const original = await provision(outgoing)
    outgoing.dispose(['session'])
    await expectRevoked(original.issued)
    const replacement = await provision(createOwner())
    await replacement.expectUsable()
  })
})

it('rejects partial ownership before removing any current capability or invoking Session cleanup', async () => {
  const { rpc, onSessionReleased } = createHarness(paths[3])
  const notebook = await rpc.issueSessionConnection('session', 'project', 'root-frame-session')
  const skill = await rpc.issueSkillImportConnection('session')
  const replacement = await rpc.issueSessionConnection('session', 'project', 'root-frame-session')
  rpc.releaseSessionCapabilitiesIfOwned('session', [notebook.token, skill.token])
  expect((await call(replacement)).status).toBe(200)
  expect((await call(skill)).status).not.toBe(401)
  expect(onSessionReleased).not.toHaveBeenCalled()
  rpc.releaseSessionCapabilitiesIfOwned('session', [])
  rpc.releaseSessionCapabilitiesIfOwned('another-session', [replacement.token, skill.token])
  expect((await call(replacement)).status).toBe(200)
  rpc.releaseSessionCapabilitiesIfOwned('session', [replacement.token, skill.token])
  await expectRevoked([replacement, skill])
  expect(onSessionReleased).toHaveBeenCalledExactlyOnceWith('session')
})
