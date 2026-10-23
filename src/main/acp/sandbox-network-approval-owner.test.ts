import { describe, expect, it, vi, type Mock } from 'vitest'
import type { AcpPermissionRequest } from '../../shared/acp'
import {
  materializeSessionConversationGraph,
  normalizeSessionAfterRestore,
  normalizeSessionFile,
  createSessionFile,
  type PersistedChatSession,
  type SessionRuntimeContext
} from '../../shared/session-persistence'
import { activeSandboxNetworkApprovals } from '../../shared/sandbox-network-approval'
import { sanitizeSessionRuntimeContext } from '../../shared/session-persistence'
import { AcpPermissionBroker, type AppPermissionRequest } from './permission-broker'
import { AcpPermissionWaitOwner, type PermissionWaitSessions } from './permission-wait-owner'
import { SandboxNetworkApprovalOwner } from './sandbox-network-approval-owner'

const fixture = (): {
  sessions: PermissionWaitSessions
  session: PersistedChatSession
  input: AppPermissionRequest
  owner: SandboxNetworkApprovalOwner
  broker: AcpPermissionBroker
  send: (request: AppPermissionRequest) => Promise<string | undefined>
  pending: () => Promise<AcpPermissionRequest>
  allowDomain: Mock<() => Promise<undefined>>
  published: Mock
} => {
  let context: SessionRuntimeContext = { version: 1, revision: 0 }
  const session = materializeSessionConversationGraph({
    id: 'session-fixture',
    projectId: 'project-fixture',
    title: 'Network approval',
    cwd: '',
    status: 'running',
    messages: [
      {
        id: 'prompt-fixture',
        role: 'user',
        content: 'Run the sample client',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ],
    createdAt: 1,
    updatedAt: 1
  } satisfies PersistedChatSession)
  const sessions: PermissionWaitSessions = {
    readSessionRuntimeContext: async () => structuredClone(context),
    loadSessionForContinuation: async () => structuredClone(session),
    containsMessageOnActiveBranch: async () => true,
    patchSessionRuntimeContext: async (command) => {
      if (context.revision !== command.expectedRevision)
        throw Object.assign(new Error('conflict'), { code: 'revision-conflict' })
      await command.beforePersist?.(session)
      const value: Record<string, unknown> = {
        ...context,
        ...command.patch,
        revision: context.revision + 1
      }
      for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key]
      context = sanitizeSessionRuntimeContext(value)!
      if (!context) throw new Error('Invalid context')
      session.runtimeContext = context
      session.status = command.sessionStatus ?? session.status
      return context
    }
  }
  const input: AppPermissionRequest = {
    sessionId: session.id,
    title: 'Network approval',
    rawInput: {},
    options: [],
    networkApproval: {
      projectId: session.projectId,
      executionId: 'execution-fixture',
      commandFingerprint: 'a'.repeat(64),
      hostname: 'service.example.test',
      port: 443,
      runtime: 'bash'
    }
  }
  const allowDomain = vi.fn(async () => undefined)
  const published = vi.fn()
  const owner = new SandboxNetworkApprovalOwner(sessions, published, allowDomain)
  const broker = new AcpPermissionBroker((request) => {
    expect(context.networkApprovals?.some((item) => item.requestId === request.requestId)).toBe(
      true
    )
  })
  const send = (request: AppPermissionRequest): Promise<string | undefined> =>
    broker.requestAppPermission(request)
  const pending = async (): Promise<AcpPermissionRequest> => {
    await vi.waitFor(() => expect(broker.getPendingRequests().length).toBeGreaterThan(0))
    return broker.getPendingRequests()[0]
  }
  return { sessions, session, input, owner, broker, send, pending, allowDomain, published }
}

describe('durable sandbox destination approvals', () => {
  it.each(['provider-first', 'network-first'])(
    'preserves interleaved provider authority when settling %s',
    async (order) => {
      const f = fixture()
      const provider = new AcpPermissionWaitOwner(f.sessions)
      const candidate = {
        projectId: f.session.projectId,
        promptMessageId: 'prompt-fixture',
        fingerprint: 'b'.repeat(64),
        request: {
          requestId: 'provider-fixture',
          sessionId: f.session.id,
          toolCallId: 'tool-fixture',
          title: 'Run sample command',
          providerToolName: 'Bash',
          rawInput: { command: 'sample-client request' },
          options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
        }
      }
      await provider.persist(candidate)
      const result = f.owner.request(f.input, 'prompt-fixture', f.send)
      const request = await f.pending()
      if (order === 'provider-first') {
        await provider.clearLive(candidate)
        expect(f.session.runtimeContext?.networkApprovals).toHaveLength(1)
        expect(f.session.status).toBe('waiting-permission')
      }
      await f.broker.respond({ requestId: request.requestId, optionId: 'deny' })
      await result
      if (order === 'network-first') {
        expect(f.session.runtimeContext?.permission?.request.requestId).toBe('provider-fixture')
        expect(f.session.status).toBe('waiting-permission')
        await provider.clearLive(candidate)
      }
      expect(f.session.runtimeContext?.permission).toBeUndefined()
      expect(f.session.runtimeContext?.networkApprovals).toBeUndefined()
    }
  )

  it('rejects cancellation accepted while admission is waiting in the persistence queue', async () => {
    const f = fixture()
    let current = true
    const patch = f.sessions.patchSessionRuntimeContext
    f.sessions.patchSessionRuntimeContext = async (command) => {
      current = false
      return patch(command)
    }
    const send = vi.fn(f.send)
    await expect(f.owner.request(f.input, 'prompt-fixture', send, () => current)).rejects.toThrow(
      'no longer current'
    )
    expect(send).not.toHaveBeenCalled()
    expect(f.session.runtimeContext?.networkApprovals).toBeUndefined()
  })

  it('round-trips a pending destination without retaining unreviewed request material', async () => {
    const f = fixture()
    const result = f.owner.request(f.input, 'prompt-fixture', f.send)
    const request = await f.pending()
    const context = f.session.runtimeContext!
    const approval = context.networkApprovals![0]
    const clean = sanitizeSessionRuntimeContext({
      ...context,
      networkApprovals: [
        { ...approval, command: 'synthetic-secret', headers: { authorization: 'fixture-only' } }
      ]
    })
    expect(JSON.stringify(clean)).not.toContain('synthetic-secret')
    expect(JSON.stringify(clean)).not.toContain('authorization')
    for (const networkApprovals of [
      [approval, approval],
      Array.from({ length: 33 }, (_, index) => ({ ...approval, requestId: `fixture-${index}` })),
      [{ ...approval, version: 2 }],
      [{ ...approval, port: 0 }],
      [{ ...approval, hostname: 'https://service.example.test/path' }],
      [{ ...approval, commandFingerprint: 'not-a-fingerprint' }],
      [{ ...approval, state: 'unknown' }],
      [{ ...approval, decision: 'always-allow', state: 'pending' }]
    ])
      expect(sanitizeSessionRuntimeContext({ ...context, networkApprovals })).toBeUndefined()
    await f.broker.respond({ requestId: request.requestId, cancelled: true })
    await result
  })

  it('rearms an uncertain global decision after process loss and retries failed settings writes', async () => {
    const f = fixture()
    f.allowDomain.mockRejectedValueOnce(new Error('settings unavailable'))
    const result = f.owner.request(f.input, 'prompt-fixture', f.send)
    const request = await f.pending()
    await expect(
      f.broker.respond({ requestId: request.requestId, optionId: 'always-allow' })
    ).rejects.toThrow('settings unavailable')
    expect(f.session.runtimeContext?.networkApprovals?.[0].state).toBe('pending')
    expect(f.broker.getPendingRequests()).toHaveLength(1)
    const approval = f.session.runtimeContext!.networkApprovals![0]
    const interrupted = normalizeSessionAfterRestore({
      ...f.session,
      runtimeContext: {
        ...f.session.runtimeContext!,
        networkApprovals: [{ ...approval, state: 'continuing', decision: 'always-allow' }]
      }
    })
    expect(interrupted.status).toBe('waiting-permission')
    expect(interrupted.runtimeContext?.networkApprovals?.[0]).toMatchObject({ state: 'pending' })
    expect(interrupted.runtimeContext?.networkApprovals?.[0].decision).toBeUndefined()
    await f.broker.respond({ requestId: request.requestId, optionId: 'always-allow' })
    await expect(result).resolves.toBe('always-allow')
    expect(f.allowDomain).toHaveBeenCalledTimes(2)
    expect(f.session.runtimeContext?.networkApprovals).toBeUndefined()
  })

  it('does not release the socket when the decision cannot be persisted', async () => {
    const f = fixture()
    const result = f.owner.request(f.input, 'prompt-fixture', f.send)
    const request = await f.pending()
    const persist = f.sessions.patchSessionRuntimeContext
    f.sessions.patchSessionRuntimeContext = async () => {
      throw new Error('disk failure')
    }
    let released = false
    void result.then(() => {
      released = true
    })
    await expect(
      f.broker.respond({ requestId: request.requestId, optionId: 'allow-once' })
    ).rejects.toThrow('disk failure')
    expect(released).toBe(false)
    expect(f.broker.getPendingRequests()).toHaveLength(1)
    f.sessions.patchSessionRuntimeContext = persist
    await f.broker.respond({ requestId: request.requestId, cancelled: true })
    await expect(result).resolves.toBeUndefined()
  })

  it('keeps global approval actionable when final Session persistence fails', async () => {
    const f = fixture()
    const result = f.owner.request(f.input, 'prompt-fixture', f.send)
    const request = await f.pending()
    const persist = f.sessions.patchSessionRuntimeContext
    let failCleanup = true
    f.sessions.patchSessionRuntimeContext = async (command) => {
      if (!command.patch.networkApprovals && failCleanup) {
        failCleanup = false
        throw new Error('cleanup write failed')
      }
      return persist(command)
    }
    await expect(
      f.broker.respond({ requestId: request.requestId, optionId: 'always-allow' })
    ).rejects.toThrow('cleanup write failed')
    expect(f.session.runtimeContext?.networkApprovals?.[0].state).toBe('pending')
    expect(f.broker.getPendingRequests()).toHaveLength(1)
    await f.broker.respond({ requestId: request.requestId, optionId: 'always-allow' })
    await expect(result).resolves.toBe('always-allow')
    expect(f.session.runtimeContext?.networkApprovals).toBeUndefined()
  })

  it.each(['allow-once', 'deny'])(
    'persists before presentation and settles %s before releasing the socket',
    async (optionId) => {
      const f = fixture()
      const result = f.owner.request(f.input, 'prompt-fixture', f.send)
      const request = await f.pending()
      expect(f.session.status).toBe('waiting-permission')
      expect(request).toMatchObject({ appOwned: true, durable: true })
      expect(f.broker.hasDurablePendingForSession(f.session.id)).toBe(true)
      await f.broker.respond({ requestId: request.requestId, optionId })
      await expect(result).resolves.toBe(optionId)
      expect(f.session.runtimeContext?.networkApprovals).toBeUndefined()
    }
  )

  it('retains the wait across host loss and consumes approval only on an explicit matching retry', async () => {
    const f = fixture()
    const oldResult = f.owner.request(f.input, 'prompt-fixture', f.send)
    const request = await f.pending()
    f.broker.abandonAllPending()
    await expect(oldResult).resolves.toBeUndefined()
    const restored = normalizeSessionFile(JSON.parse(JSON.stringify(createSessionFile(f.session))))!
    expect(restored.status).toBe('waiting-permission')
    expect(activeSandboxNetworkApprovals(restored)).toHaveLength(1)
    const restarted = new SandboxNetworkApprovalOwner(f.sessions, f.published, f.allowDomain)
    await restarted.respondRestored(
      {
        requestId: request.requestId,
        optionId: 'allow-once',
        restored: { projectId: f.session.projectId, sessionId: f.session.id }
      },
      f.session.projectId
    )
    expect(f.session.runtimeContext?.networkApprovals?.[0].state).toBe('continuing')
    expect(f.broker.getPendingRequests()).toEqual([])
    const send = vi.fn(f.send)
    await expect(restarted.request(f.input, 'prompt-fixture', send)).resolves.toBe('allow-once')
    expect(send).not.toHaveBeenCalled()
    expect(f.session.runtimeContext?.networkApprovals).toBeUndefined()
  })

  it('preserves independent destinations and provider permission authority', async () => {
    const f = fixture()
    const first = f.owner.request(f.input, 'prompt-fixture', f.send)
    await f.pending()
    const second = f.owner.request(
      {
        ...f.input,
        networkApproval: { ...f.input.networkApproval!, hostname: 'other.example.test' }
      },
      'prompt-fixture',
      f.send
    )
    await vi.waitFor(() => expect(f.broker.getPendingRequests()).toHaveLength(2))
    const [a, b] = f.broker.getPendingRequests()
    await f.broker.respond({ requestId: a.requestId, optionId: 'deny' })
    await first
    expect(f.session.runtimeContext?.networkApprovals?.map((item) => item.hostname)).toEqual([
      'other.example.test'
    ])
    expect(f.session.status).toBe('waiting-permission')
    await f.broker.respond({ requestId: b.requestId, optionId: 'allow-once' })
    await second
  })

  it('rejects a late approval after the active branch changes', async () => {
    const f = fixture()
    const result = f.owner.request(f.input, 'prompt-fixture', f.send)
    const request = await f.pending()
    f.session.conversationGraph!.branches.push({
      ...f.session.conversationGraph!.branches[0],
      id: 'different-branch',
      parentBranchId: f.session.conversationGraph!.branches[0].id,
      forkMessageId: 'prompt-fixture'
    })
    f.session.conversationGraph!.frames[0].activeBranchId = 'different-branch'
    await expect(
      f.broker.respond({ requestId: request.requestId, optionId: 'always-allow' })
    ).rejects.toThrow('active Message Branch')
    expect(f.broker.getPendingRequests()).toHaveLength(1)
    expect(f.allowDomain).not.toHaveBeenCalled()
    await f.broker.respond({ requestId: request.requestId, cancelled: true })
    await expect(result).resolves.toBeUndefined()
  })

  it('retains an explicit retry grant if the client exits while the human is deciding', async () => {
    const f = fixture()
    const result = f.owner.request({ ...f.input, canResume: () => false }, 'prompt-fixture', f.send)
    const request = await f.pending()
    await f.broker.respond({ requestId: request.requestId, optionId: 'allow-once' })
    await result
    expect(f.session.runtimeContext?.networkApprovals?.[0].state).toBe('continuing')
  })

  it('fails closed when persistence fails before the card is visible', async () => {
    const f = fixture()
    f.sessions.patchSessionRuntimeContext = async () => {
      throw new Error('disk failure')
    }
    const send = vi.fn(f.send)
    await expect(f.owner.request(f.input, 'prompt-fixture', send)).rejects.toThrow('disk failure')
    expect(send).not.toHaveBeenCalled()
  })
})
