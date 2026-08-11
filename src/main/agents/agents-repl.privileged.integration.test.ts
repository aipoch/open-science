import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import { NotebookRuntimeService } from '../notebook/runtime-service'
import { NotebookRunRepository } from '../notebook/repository'
import {
  framePythonRequest,
  parseLoopResponse,
  type KernelLoopResponse
} from '../notebook/kernel-protocol'
import { AgentsService, type AgentsCatalogSource } from './agents-service'
import { passthroughApprovalGateway } from './passthrough-approval-gateway'
import { createProfileService } from '../specialist/service'
import { SessionBindingService } from '../specialist/session-binding'
import type { StoredConnectors } from '../settings/types'
import type { ApprovalGateway, ApprovalResult } from '../../shared/agents-contract'

// Run with: RUN_KERNEL=1 npx vitest run src/main/agents/agents-repl.privileged.integration.test.ts
//
// Proves the privileged Specialist-management slice end-to-end through the real
// resources/notebook/repl_loop.js + NotebookLocalRpcServer, wired exactly the way production
// (src/main/ipc.ts) composes it: a real ProfileService, the real SessionBindingService, the
// milestone's passthroughApprovalGateway (always-approved), a durable persisted-binding sink, the
// SwitchNotifier broadcast, and the catalog-invalidation callback.
//
// Coverage (design.md §15 / acceptance criteria 1, 4, 6):
//  - a name-changing update committed atomically through host.agents.update, returning real post-write
//    read-back (not echoed input) and BYPASSING the approval gateway (renames are ordinary
//    chat-reviewed mutations, not privileged);
//  - delete through the pass-through gateway: bound conversations are left unavailable (bindings are
//    NOT silently cleared);
//  - switch through the pass-through gateway: the trusted calling session is the only session that
//    may be switched, the binding persists immediately (restart survival), and a pending-reconfigure
//    notification is broadcast;
//  - a structured DECLINE on a configurable approval gateway returns a non-error result for both
//    delete and switch, with no mutation/persist/notify;
//  - optimistic concurrency: a stale revision fails for both an ordinary update and a name-changing
//    update, without merge or retry.
//
// Notes on what this milestone ships vs. what is deferred:
//  - The pass-through approval gateway always approves; it is the milestone substitution seam
//    (design.md §14). The decline cases below use a separately-injected gateway that returns the
//    structured decline shape, proving the dispatcher honors the gateway seam. The pass-through
//    gateway itself never declines by design.
//  - The public `host.agents` SDK exposes first-class `switch()`/`delete()` methods alongside
//    `update` (which routes name-changing patches through the privileged module). Those SDK methods
//    are exercised end-to-end below. The `agentsCall` fetch helper is retained for cases that must
//    drive the transport BELOW the SDK surface — smuggling forged identity keys to prove the
//    dispatcher strips reserved keys, and other transport-level assertions.
//  - Trusted-session capture and forged-identity rejection for ordinary reads are covered end-to-end
//    by agents-repl.integration.test.ts (regression); this suite focuses on the privileged slice.

const gate = process.env.RUN_KERNEL ? describe : describe.skip

const LOOP = join(__dirname, '../../../resources/notebook/repl_loop.js')

const startLoop = (
  env: NodeJS.ProcessEnv
): {
  child: ChildProcessWithoutNullStreams
  send: (code: string) => Promise<KernelLoopResponse>
} => {
  const child = spawn(process.execPath, [LOOP], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env }
  })
  const rl = createInterface({ input: child.stdout })
  const waiters = new Map<string, (v: KernelLoopResponse) => void>()
  rl.on('line', (line) => {
    const msg = parseLoopResponse(line)
    if (!msg) return
    const w = waiters.get(msg.reqId)
    if (w) {
      waiters.delete(msg.reqId)
      w(msg)
    }
  })
  const send = (code: string): Promise<KernelLoopResponse> =>
    new Promise((resolve) => {
      const reqId = randomUUID()
      waiters.set(reqId, resolve)
      child.stdin.write(framePythonRequest(reqId, code))
    })
  return { child, send }
}

// Deterministic, secret-free catalog. Includes a custom runnable connector (cust-1) so connector
// projections stay stable and secret-free across runs.
const stubCatalog: AgentsCatalogSource = {
  listSkillCatalog: async () => [
    {
      id: 'demo',
      frameworkName: 'demo',
      displayName: 'demo',
      source: 'featured',
      mainEnabled: true,
      available: true
    }
  ],
  getConnectors: async (): Promise<StoredConnectors | undefined> => ({
    enabledIds: [],
    autoAllowIds: [],
    disabledConnectorIds: [],
    customMcpServers: [
      { id: 'cust-1', name: 'My Server', transport: 'stdio', enabled: true, command: 'run' }
    ]
  })
}

// Build an AgentsService wired exactly like production (src/main/ipc.ts): passthrough gateway for the
// milestone, real SessionBindingService, a Map-backed durable persist sink (mirrors the persisted
// session-file binding), a recorded notifier, and a recorded catalog invalidation. Optionally inject
// a custom gateway (e.g. a decline gateway) to prove the seam. `invalidateCount` is a getter so the
// counter is read live (not snapshotted at compose time).
const composeService = (opts: {
  profileStorage: string
  gateway?: ApprovalGateway
}): {
  agentsService: AgentsService
  sessionBinding: SessionBindingService
  durableBindings: Map<string, string | undefined>
  notified: Array<{ sessionId: string; targetName: string | null }>
  invalidateCount: () => number
  approvalCount: () => number
} => {
  const profileService = createProfileService(opts.profileStorage)
  const sessionBinding = new SessionBindingService(profileService)
  const durableBindings = new Map<string, string | undefined>()
  const notified: Array<{ sessionId: string; targetName: string | null }> = []
  let invalidated = 0
  let approvals = 0
  const approvalGateway = opts.gateway ?? passthroughApprovalGateway
  const agentsService = new AgentsService({
    profileService,
    catalog: stubCatalog,
    sessionBinding,
    approvalGateway: {
      decide: async (request) => {
        approvals += 1
        return approvalGateway.decide(request)
      }
    },
    switchNotifier: {
      notify: (pending) => {
        notified.push({ sessionId: pending.sessionId, targetName: pending.targetName })
      }
    },
    persistSessionSpecialist: async (sessionId, specialistId) => {
      // Mirrors production: the durable writer persists the UUID so the binding survives restart.
      if (specialistId === undefined) durableBindings.delete(sessionId)
      else durableBindings.set(sessionId, specialistId)
    },
    invalidateCatalog: () => {
      invalidated += 1
    }
  })
  return {
    agentsService,
    sessionBinding,
    durableBindings,
    notified,
    invalidateCount: () => invalidated,
    approvalCount: () => approvals
  }
}

// One-line JS body that calls `agentsCall` over the same transport the SDK uses. The trusted calling
// session (`sessionId`) is forwarded in `params.session_id`, exactly as the loop does for every
// host.agents call (it is captured from the spawn env and forwarded on the wire).
const agentsCallFetch = (
  endpoint: string,
  token: string,
  sessionId: string,
  params: Record<string, unknown>
): string => {
  const payload = JSON.stringify({
    method: 'agentsCall',
    params: { session_id: sessionId, ...params }
  })
  return `const res = await fetch(${JSON.stringify(endpoint)}, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ${JSON.stringify(token)} }, body: ${JSON.stringify(payload)} }); const body = await res.json(); return JSON.stringify({ ok: res.ok, body })`
}

gate('host.agents repl privileged integration', () => {
  let rpcServer: NotebookLocalRpcServer
  let endpoint: string
  let token: string
  let profileStorage: string
  let runtimeStorage: string
  let agentsService: AgentsService
  let sessionBinding: SessionBindingService
  let durableBindings: Map<string, string | undefined>
  let notified: Array<{ sessionId: string; targetName: string | null }>
  let invalidateCount: () => number
  let approvalCount: () => number

  beforeAll(async () => {
    profileStorage = await mkdtemp(join(tmpdir(), 'os-agents-priv-profile-'))
    runtimeStorage = await mkdtemp(join(tmpdir(), 'os-agents-priv-runtime-'))
    const composed = composeService({ profileStorage })
    agentsService = composed.agentsService
    sessionBinding = composed.sessionBinding
    durableBindings = composed.durableBindings
    notified = composed.notified
    invalidateCount = composed.invalidateCount
    approvalCount = composed.approvalCount
    void agentsService
    const notebookService = new NotebookRuntimeService({
      configRoot: runtimeStorage,
      dataRoot: runtimeStorage,
      projectName: 'default-project',
      repository: new NotebookRunRepository(runtimeStorage),
      executorFactory: () => ({
        execute: async () => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: runtimeStorage,
          outputs: [],
          workingFiles: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })
    rpcServer = new NotebookLocalRpcServer(notebookService, {
      token: 'integration-token',
      agentsService
    })
    const connection = await rpcServer.ensureStarted()
    endpoint = connection.endpoint
    token = connection.token
  })

  afterAll(async () => {
    await rpcServer?.close()
    await rm(profileStorage, { recursive: true, force: true })
    await rm(runtimeStorage, { recursive: true, force: true })
  })

  // Loop helper: an isolated loop per case (mirrors the read/ordinary-mutation suites) so captured
  // trusted-session identity and in-memory binding state never bleed across assertions.
  const withLoop = async <T>(
    sessionId: string | undefined,
    run: (send: (code: string) => Promise<KernelLoopResponse>) => Promise<T>
  ): Promise<T> => {
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: token,
      ...(sessionId ? { OPEN_SCIENCE_NOTEBOOK_SESSION_ID: sessionId } : {})
    })
    try {
      return await run(send)
    } finally {
      child.kill()
    }
  }

  it('host.agents exposes first-class switch() and delete() methods on the SDK surface', async () => {
    await withLoop(undefined, async (send) => {
      const r = await send(
        'return JSON.stringify({ sw: typeof host.agents.switch, del: typeof host.agents.delete })'
      )
      expect(r.error).toBeNull()
      const kinds = JSON.parse(r.result ?? '{}')
      expect(kinds.sw).toBe('function')
      expect(kinds.del).toBe('function')
    })
  })

  it('host.agents.switch(name) switches the trusted calling session via the SDK method and persists the binding immediately', async () => {
    await withLoop('sdk-switch', async (send) => {
      const created = JSON.parse(
        (
          await send(
            "return JSON.stringify(await host.agents.create({ name: 'SDK_SWITCH_TARGET' }))"
          )
        ).result ?? '{}'
      )
      const id = created.id
      const r = await send("return JSON.stringify(await host.agents.switch('SDK_SWITCH_TARGET'))")
      expect(r.error).toBeNull()
      const result = JSON.parse(r.result ?? '{}')
      expect(result.status).toBe('approved')
      expect(result.operation).toBe('switch')
      expect(result.binding.specialistId).toBe(id)
      // The durable sink received the trusted session + UUID — binding survives restart.
      expect(durableBindings.get('sdk-switch')).toBe(id)
      // A pending-reconfigure notification was broadcast (consumed at the next message).
      expect(notified).toContainEqual({ sessionId: 'sdk-switch', targetName: 'SDK_SWITCH_TARGET' })
    })
  })

  it('host.agents.switch(null) reverts the trusted calling session to Main Agent via the SDK method', async () => {
    await withLoop('sdk-main', async (send) => {
      const created = JSON.parse(
        (await send("return JSON.stringify(await host.agents.create({ name: 'SDK_TO_MAIN' }))"))
          .result ?? '{}'
      )
      // Bind first via the SDK method.
      await send("return JSON.stringify(await host.agents.switch('SDK_TO_MAIN'))")
      expect(durableBindings.get('sdk-main')).toBe(created.id)
      // Now revert to Main via null — Main is a cleared reference, not a mutable Profile.
      const r = await send('return JSON.stringify(await host.agents.switch(null))')
      expect(r.error).toBeNull()
      const result = JSON.parse(r.result ?? '{}')
      expect(result.status).toBe('approved')
      expect(result.binding.specialistId).toBeUndefined()
      expect(result.binding.targetName).toBeNull()
      expect(durableBindings.has('sdk-main')).toBe(false)
      expect(notified).toContainEqual({ sessionId: 'sdk-main', targetName: null })
    })
  })

  it('rejects Specialist switching through a real delegate capability before approval or mutation despite forged Main fields', async () => {
    await agentsService.dispatch({
      op: 'create',
      params: { name: 'DELEGATE_SWITCH_TARGET' }
    })
    const approvalsBefore = approvalCount()
    const notificationsBefore = notified.length
    const connection = await rpcServer.issueControlConnection(
      'delegate-switch-session',
      'project-1',
      'delegate-frame-1',
      { role: 'delegate', attemptId: 'delegate-attempt-1' }
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'delegate-turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'delegate-tool-1'
    })
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: connection.token,
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'delegate-switch-session'
    })

    try {
      const response = await send(
        agentsCallFetch(connection.endpoint, connection.token, 'forged-session', {
          op: 'switch',
          name: 'DELEGATE_SWITCH_TARGET',
          caller_role: 'main',
          role: 'main',
          is_main: true
        })
      )
      expect(response.error).toBeNull()
      const parsed = JSON.parse(response.result ?? '{}')
      expect(parsed).toEqual({
        ok: false,
        body: { error: 'host.agents.switch: Only Main Agent may switch Specialist profile.' }
      })
      expect(approvalCount()).toBe(approvalsBefore)
      expect(sessionBinding.getBinding('delegate-switch-session')).toBeUndefined()
      expect(durableBindings.has('delegate-switch-session')).toBe(false)
      expect(notified).toHaveLength(notificationsBefore)
    } finally {
      child.kill()
      endInvocation()
      connection.release()
    }
  })

  it('host.agents.delete(name, { revision }) removes the profile via the SDK method and invalidates the catalog', async () => {
    const invalidatedBefore = invalidateCount()
    await withLoop(undefined, async (send) => {
      const created = JSON.parse(
        (await send("return JSON.stringify(await host.agents.create({ name: 'SDK_GONE' }))"))
          .result ?? '{}'
      )
      // The reviewed revision must be carried through the SDK method; a wrong/omitted revision is
      // rejected by the privileged module, so a successful delete proves the wire carried it.
      const r = await send(
        `return JSON.stringify(await host.agents.delete('SDK_GONE', { revision: ${created.revision} }))`
      )
      expect(r.error).toBeNull()
      const result = JSON.parse(r.result ?? '{}')
      expect(result).toEqual({ status: 'deleted', name: 'SDK_GONE' })
    })
    // Catalog invalidation ran after the successful privileged mutation.
    expect(invalidateCount()).toBeGreaterThan(invalidatedBefore)
  })

  it('a name-changing update is an ordinary mutation: no approval gateway, atomic single-profile commit, real read-back', async () => {
    await withLoop(undefined, async (send) => {
      const created = JSON.parse(
        (
          await send(
            "return JSON.stringify(await host.agents.create({ name: 'ATOM_PROBE', description: 'before' }))"
          )
        ).result ?? '{}'
      )
      // A patch that changes the public `name` applies like any other update field (renames are
      // chat-reviewed, not privileged): the SDK returns the real camelCase profile read-back.
      const r = await send(
        `return JSON.stringify(await host.agents.update('ATOM_PROBE', { name: 'ATOM_ANALYZER', description: 'after', revision: ${created.revision} }))`
      )
      expect(r.error).toBeNull()
      const updated = JSON.parse(r.result ?? '{}')
      expect(updated.name).toBe('ATOM_ANALYZER')
      expect(updated.description).toBe('after')
      // Revision was bumped by the authoritative ProfileService, not echoed.
      expect(updated.revision).toBe(created.revision + 1)
    })
  })

  // The raw-RPC switch(name) and switch(null) cases that previously lived here (which exercised the
  // transport only because host.agents.switch did not yet exist) were exact duplicates of the
  // first-class SDK tests above ("host.agents.switch(name) ..." / "host.agents.switch(null) ...").
  // They were removed when 09be0fe shipped the SDK surface. The agentsCall helper is still used below
  // for cases that must drive BELOW the SDK surface: smuggling forged identity keys, and asserting
  // the structured-decline wire envelope / no-retry dispatch over a custom decline gateway.

  it('switch cannot forge a different calling session: reserved identity keys are dropped, only the trusted session is bound', async () => {
    await withLoop('session-real', async (send) => {
      const created = JSON.parse(
        (await send("return JSON.stringify(await host.agents.create({ name: 'GUARD_TARGET' }))"))
          .result ?? '{}'
      )
      // Attempt to smuggle forged identity keys (camelCase sessionId, specialist_id, switch target,
      // reconfigure flag) alongside the trusted session. The dispatcher strips every reserved key;
      // the switch binds ONLY the trusted calling session.
      const r = await send(
        agentsCallFetch(endpoint, token, 'session-real', {
          op: 'switch',
          name: 'GUARD_TARGET',
          sessionId: 'forged-camel',
          specialist_id: 'forged-specialist',
          target_specialist_id: 'forged-target',
          reconfigure: true
        })
      )
      const parsed = JSON.parse(r.result ?? '{}')
      expect(parsed.ok).toBe(true)
      // The durable sink records the TRUSTED captured session, never a forged one.
      expect(durableBindings.get('session-real')).toBe(created.id)
      expect(durableBindings.has('forged-camel')).toBe(false)
      expect(durableBindings.has('forged-specialist')).toBe(false)
    })
  })

  it('delete through the pass-through gateway: the profile is gone, bindings are NOT silently cleared (a bound conversation resolves unavailable)', async () => {
    const invalidatedBefore = invalidateCount()
    await withLoop(undefined, async (send) => {
      const created = JSON.parse(
        (await send("return JSON.stringify(await host.agents.create({ name: 'GONE_BOT' }))"))
          .result ?? '{}'
      )
      // Simulate an existing conversation already bound to this Specialist (durable + in-memory).
      durableBindings.set('session-bound-before-delete', created.id)
      sessionBinding.setBinding('session-bound-before-delete', created.id)

      const r = await send(
        `return JSON.stringify(await host.agents.delete('GONE_BOT', { revision: ${created.revision} }))`
      )
      const result = JSON.parse(r.result ?? '{}')
      expect(result).toEqual({ status: 'deleted', name: 'GONE_BOT' })

      // The pre-existing binding is STILL present — delete does not rewrite history or silently clear.
      expect(durableBindings.get('session-bound-before-delete')).toBe(created.id)
      // The bound conversation now resolves unavailable (the UUID no longer maps to a profile).
      const resolution = await sessionBinding.resolve('session-bound-before-delete')
      expect(resolution.kind).toBe('unavailable')
    })
    // Catalog invalidation ran at least once after the successful privileged mutation.
    expect(invalidateCount()).toBeGreaterThan(invalidatedBefore)
  })

  it('a name-changing update keeps stable conversation bindings: the binding follows the profile (UUID), not the name', async () => {
    // design.md §4/§10: stable conversation bindings are UUID-based. A rename changes the public name
    // but NOT the UUID, so an already-bound conversation keeps resolving the SAME profile under its new
    // name. This is the integration proof of the rename-keeps-binding contract.
    await withLoop(undefined, async (send) => {
      const created = JSON.parse(
        (
          await send(
            "return JSON.stringify(await host.agents.create({ name: 'RENAME_OLD', description: 'x' }))"
          )
        ).result ?? '{}'
      )
      // Simulate an existing conversation bound to this Specialist by its stable UUID.
      durableBindings.set('session-bound-rename', created.id)
      sessionBinding.setBinding('session-bound-rename', created.id)
      // Before the rename, the binding resolves bound under the old name.
      const before = await sessionBinding.resolve('session-bound-rename')
      expect(before.kind).toBe('bound')

      // Name-changing update (ordinary chat-reviewed mutation).
      const r = await send(
        `return JSON.stringify(await host.agents.update('RENAME_OLD', { name: 'RENAME_NEW', revision: ${created.revision} }))`
      )
      const updated = JSON.parse(r.result ?? '{}')
      expect(updated.name).toBe('RENAME_NEW')
      // The UUID is unchanged across the rename.
      expect(updated.id).toBe(created.id)

      // The bound conversation STILL resolves the SAME profile (now under its new name) — the binding
      // follows the profile (UUID), not the public name. No integration code rewrites it.
      const after = await sessionBinding.resolve('session-bound-rename')
      expect(after.kind).toBe('bound')
      if (after.kind === 'bound') {
        expect(after.profile.id).toBe(created.id)
        expect(after.profile.name).toBe('RENAME_NEW')
      }
      // The durable binding record is untouched.
      expect(durableBindings.get('session-bound-rename')).toBe(created.id)
    })
  })

  it('a structured DECLINE on switch returns a non-error result and changes nothing (no persist, no notify)', async () => {
    // A separately-configured service whose gateway always declines, proving the dispatcher honors
    // the approval-gateway seam. (The milestone's passthrough gateway never declines by design.)
    const declineGateway: ApprovalGateway = {
      decide: vi.fn(async (): Promise<ApprovalResult> => ({
        status: 'declined',
        operation: 'switch'
      }))
    }
    const composed = composeService({ profileStorage, gateway: declineGateway })
    const declineRpc = new NotebookLocalRpcServer(
      new NotebookRuntimeService({
        configRoot: runtimeStorage,
        dataRoot: runtimeStorage,
        projectName: 'decline-project',
        repository: new NotebookRunRepository(runtimeStorage),
        executorFactory: () => ({
          execute: async () => ({
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: runtimeStorage,
            outputs: [],
            workingFiles: []
          }),
          shutdown: async () => ({ reaped: true })
        })
      }),
      { token: 'decline-token', agentsService: composed.agentsService }
    )
    const conn = await declineRpc.ensureStarted()
    try {
      const { child, send } = startLoop({
        OPEN_SCIENCE_MCP_RPC_ENDPOINT: conn.endpoint,
        OPEN_SCIENCE_MCP_RPC_TOKEN: conn.token,
        OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-decline'
      })
      try {
        await send("return JSON.stringify(await host.agents.create({ name: 'DECLINE_TARGET' }))")
        const r = await send(
          agentsCallFetch(conn.endpoint, conn.token, 'session-decline', {
            op: 'switch',
            name: 'DECLINE_TARGET'
          })
        )
        const parsed = JSON.parse(r.result ?? '{}')
        // Decline is a STRUCTURED non-error result (HTTP 200), not a thrown error.
        expect(parsed.ok).toBe(true)
        expect(parsed.body.result).toEqual({ status: 'declined', operation: 'switch' })
        // Nothing persisted, nothing notified.
        expect(composed.durableBindings.has('session-decline')).toBe(false)
        expect(composed.notified).toHaveLength(0)
      } finally {
        child.kill()
      }
    } finally {
      await declineRpc.close()
    }
  })

  it('a structured DECLINE on delete returns a non-error result and mutates nothing', async () => {
    const declineGateway: ApprovalGateway = {
      decide: vi.fn(async (): Promise<ApprovalResult> => ({
        status: 'declined',
        operation: 'delete',
        reason: 'user cancelled'
      }))
    }
    const composed = composeService({ profileStorage, gateway: declineGateway })
    const declineRpc = new NotebookLocalRpcServer(
      new NotebookRuntimeService({
        configRoot: runtimeStorage,
        dataRoot: runtimeStorage,
        projectName: 'decline-del-project',
        repository: new NotebookRunRepository(runtimeStorage),
        executorFactory: () => ({
          execute: async () => ({
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: runtimeStorage,
            outputs: [],
            workingFiles: []
          }),
          shutdown: async () => ({ reaped: true })
        })
      }),
      { token: 'decline-del-token', agentsService: composed.agentsService }
    )
    const conn = await declineRpc.ensureStarted()
    try {
      const { child, send } = startLoop({
        OPEN_SCIENCE_MCP_RPC_ENDPOINT: conn.endpoint,
        OPEN_SCIENCE_MCP_RPC_TOKEN: conn.token,
        OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-decline-del'
      })
      try {
        const created = JSON.parse(
          (await send("return JSON.stringify(await host.agents.create({ name: 'DECLINE_DEL' }))"))
            .result ?? '{}'
        )
        const beforeInvalidated = composed.invalidateCount()
        const r = await send(
          agentsCallFetch(conn.endpoint, conn.token, 'session-decline-del', {
            op: 'delete',
            name: 'DECLINE_DEL',
            revision: created.revision
          })
        )
        const parsed = JSON.parse(r.result ?? '{}')
        expect(parsed.ok).toBe(true)
        expect(parsed.body.result).toEqual({
          status: 'declined',
          operation: 'delete',
          reason: 'user cancelled'
        })
        // No mutation, no invalidation.
        expect(composed.invalidateCount()).toBe(beforeInvalidated)
        // The profile is still present.
        const stillThere = await send("return JSON.stringify(await host.agents.get('DECLINE_DEL'))")
        expect(JSON.parse(stillThere.result ?? '{}').name).toBe('DECLINE_DEL')
      } finally {
        child.kill()
      }
    } finally {
      await declineRpc.close()
    }
  })

  it('optimistic concurrency: a stale revision on an ordinary update fails without merge or retry', async () => {
    await withLoop(undefined, async (send) => {
      await send("return JSON.stringify(await host.agents.create({ name: 'STALE_ORD' }))")
      const r = await send(
        "try { await host.agents.update('STALE_ORD', { revision: 999, description: 'x' }); return 'no-throw' } catch (e) { return e.message }"
      )
      expect(r.result).toMatch(/host\.agents\.update:/)
    })
  })

  it('optimistic concurrency: a stale revision on a name-changing update fails without merge or retry', async () => {
    await withLoop(undefined, async (send) => {
      await send("return JSON.stringify(await host.agents.create({ name: 'STALE_PRIV' }))")
      const r = await send(
        "try { await host.agents.update('STALE_PRIV', { name: 'STALE_PRIV_RENAMED', revision: 999 }); return 'no-throw' } catch (e) { return e.message }"
      )
      // The ordinary update path fails closed on revision drift with a sanitized host.agents.update: error.
      expect(r.result).toMatch(/host\.agents\.update:/)
    })
  })

  it('a name-changing update bypasses the approval gateway entirely (renames are not privileged)', async () => {
    const decide = vi.fn(async (): Promise<ApprovalResult> => ({
      status: 'declined',
      operation: 'delete'
    }))
    const composed = composeService({ profileStorage, gateway: { decide } })
    const declineRpc = new NotebookLocalRpcServer(
      new NotebookRuntimeService({
        configRoot: runtimeStorage,
        dataRoot: runtimeStorage,
        projectName: 'no-approval-upd-project',
        repository: new NotebookRunRepository(runtimeStorage),
        executorFactory: () => ({
          execute: async () => ({
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: runtimeStorage,
            outputs: [],
            workingFiles: []
          }),
          shutdown: async () => ({ reaped: true })
        })
      }),
      { token: 'no-approval-upd-token', agentsService: composed.agentsService }
    )
    const conn = await declineRpc.ensureStarted()
    try {
      const { child, send } = startLoop({
        OPEN_SCIENCE_MCP_RPC_ENDPOINT: conn.endpoint,
        OPEN_SCIENCE_MCP_RPC_TOKEN: conn.token,
        OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-no-approval-upd'
      })
      try {
        const created = JSON.parse(
          (
            await send(
              "return JSON.stringify(await host.agents.create({ name: 'ATOMIC_OLD', description: 'keep-me' }))"
            )
          ).result ?? '{}'
        )
        const r = await send(
          `return JSON.stringify(await host.agents.update('ATOMIC_OLD', { name: 'ATOMIC_NEW', description: 'applied', revision: ${created.revision} }))`
        )
        const result = JSON.parse(r.result ?? '{}')
        // Rename applied directly; even a decline-configured gateway is never consulted.
        expect(result.name).toBe('ATOMIC_NEW')
        expect(result.description).toBe('applied')
        expect(decide).not.toHaveBeenCalled()
      } finally {
        child.kill()
      }
    } finally {
      await declineRpc.close()
    }
  })

  it('a denied privileged operation is not retried: the dispatcher returns the decline once', async () => {
    // The decline gateway is called exactly once per privileged op (the Skill/dispatcher do not loop
    // on a declined privileged operation — design.md §8/§11).
    const decide = vi.fn(async (): Promise<ApprovalResult> => ({
      status: 'declined',
      operation: 'switch'
    }))
    const composed = composeService({ profileStorage, gateway: { decide } })
    const declineRpc = new NotebookLocalRpcServer(
      new NotebookRuntimeService({
        configRoot: runtimeStorage,
        dataRoot: runtimeStorage,
        projectName: 'no-retry-project',
        repository: new NotebookRunRepository(runtimeStorage),
        executorFactory: () => ({
          execute: async () => ({
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: runtimeStorage,
            outputs: [],
            workingFiles: []
          }),
          shutdown: async () => ({ reaped: true })
        })
      }),
      { token: 'no-retry-token', agentsService: composed.agentsService }
    )
    const conn = await declineRpc.ensureStarted()
    try {
      const { child, send } = startLoop({
        OPEN_SCIENCE_MCP_RPC_ENDPOINT: conn.endpoint,
        OPEN_SCIENCE_MCP_RPC_TOKEN: conn.token,
        OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-no-retry'
      })
      try {
        await send("return JSON.stringify(await host.agents.create({ name: 'NO_RETRY_T' }))")
        await send(
          agentsCallFetch(conn.endpoint, conn.token, 'session-no-retry', {
            op: 'switch',
            name: 'NO_RETRY_T'
          })
        )
        // Exactly one decision, never retried.
        expect(decide).toHaveBeenCalledTimes(1)
      } finally {
        child.kill()
      }
    } finally {
      await declineRpc.close()
    }
  })
})
