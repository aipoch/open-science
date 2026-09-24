import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotebookLocalRpcServer } from './local-rpc-server'
import { AcpPermissionBroker } from '../acp/permission-broker'
import { createAutoPlanApproval } from '../agents/configuration-plan-approval'
import { fetchLocalRpc } from '../local-rpc-transport'
import type { TrustedCallingSession } from '../../shared/agents-contract'
import type { InstallRequest } from './package-manager'
import type { AcpPermissionRequest } from '../../shared/acp'

let server: NotebookLocalRpcServer | undefined
afterEach(async () => {
  await server?.close()
})

async function fixture(permissionPrompts?: 'none') {
  const emitted: AcpPermissionRequest[] = []
  const broker = new AcpPermissionBroker((request) => emitted.push(request))
  const commit = vi.fn()
  const approve = createAutoPlanApproval({
    profile: () => 'auto',
    request: (plan, context) =>
      broker.requestAppApproval({
        sessionId: context.sessionId!,
        title: 'Review configuration changes',
        rawInput: {},
        configurationPlan: plan,
        signal: context.signal,
        permissionPrompts: context.permissionPrompts
      })
  })
  const mutate = async (_request: unknown, context: TrustedCallingSession) => {
    const approved = await approve(
      { kind: 'agent-configuration', target: 'test', changes: {} },
      context
    )
    if (approved && !context.signal?.aborted) commit()
    return { approved }
  }
  server = new NotebookLocalRpcServer(
    {
      shutdown: async () => ({}),
      managePackages: async (request: InstallRequest, signal?: AbortSignal) => {
        const ok = await broker.requestAppApproval({
          sessionId: request.sessionId!,
          signal,
          permissionPrompts: request.permissionPrompts,
          title: 'Review installation plan',
          rawInput: {},
          configurationPlan: { kind: 'package-installation', packages: [] }
        })
        if (ok) commit()
        return { ok, needsRestart: false, log: '' }
      }
    } as never,
    {
      transport: 'tcp',
      agentsService: { read: mutate },
      skillsService: { dispatch: mutate }
    }
  )
  const parent = await server.issueDelegatedNotebookConnection({
    permissionPrompts,
    projectId: 'p',
    sessionId: 's',
    rootFrameId: 'root',
    agentFrameId: 'child',
    attemptId: 'attempt',
    messageBranchId: 'branch',
    runtimeSegmentId: 'segment',
    promptMessageId: 'prompt',
    workspaceCwd: '/tmp',
    isAttemptWritable: () => true
  })
  const control = await server.issueControlConnection('s', 'p', 'child', {
    role: 'delegate',
    attemptId: 'attempt'
  })
  const finish = control.beginControlInvocation({
    turnId: 'turn',
    toolInvocationId: 'invocation',
    controlInvocationGeneration: 1
  })
  const call = (method: string) =>
    fetchLocalRpc(
      control,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${control.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          method,
          params: {
            op: method === 'agentsCall' ? 'create' : 'publish',
            signal: { aborted: false },
            permissionPrompts: permissionPrompts ? undefined : 'none'
          }
        })
      },
      'plan approval regression'
    )
  return { parent, control, finish, call, emitted, broker, commit }
}

describe('trusted RPC plan approval lifecycle', () => {
  it.each(['agentsCall', 'skillsCall'])(
    'revoking a control capability cancels pending %s without disconnecting the client',
    async (method) => {
      const f = await fixture()
      const pending = f.call(method)
      await vi.waitFor(() => expect(f.emitted).toHaveLength(1))
      const stale = f.emitted[0]
      f.control.release()
      const response = await pending
      expect((await response.json()).result).toEqual({ approved: false })
      await f.broker.respond({ requestId: stale.requestId, optionId: stale.options[0].optionId })
      expect(f.commit).not.toHaveBeenCalled()
      await f.parent.revoke()
    }
  )
  it.each(['agentsCall', 'skillsCall'])(
    'revoking the owning Attempt cancels pending control %s and drains',
    async (method) => {
      const f = await fixture()
      const pending = f.call(method)
      await vi.waitFor(() => expect(f.emitted).toHaveLength(1))
      await f.parent.revoke()
      expect((await (await pending).json()).result).toEqual({ approved: false })
      expect(f.commit).not.toHaveBeenCalled()
      f.control.release()
    }
  )
  it.each(['agentsCall', 'skillsCall'])(
    'inherits no-prompt policy for delegated control %s despite forged payload',
    async (method) => {
      const f = await fixture('none')
      expect((await (await f.call(method)).json()).result).toEqual({ approved: false })
      expect(f.emitted).toEqual([])
      expect(f.commit).not.toHaveBeenCalled()
      f.control.release()
      await f.parent.revoke()
    }
  )
  it('ending the control invocation cancels its pending approval', async () => {
    const f = await fixture()
    const pending = f.call('skillsCall')
    await vi.waitFor(() => expect(f.emitted).toHaveLength(1))
    f.finish()
    expect((await (await pending).json()).result).toEqual({ approved: false })
    expect(f.commit).not.toHaveBeenCalled()
    f.control.release()
    await f.parent.revoke()
  })
})

it.each([undefined, 'none'] as const)(
  'binds package approval policy to delegated Notebook capability: %s',
  async (policy) => {
    const f = await fixture(policy)
    const pending = fetchLocalRpc(
      f.parent,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${f.parent.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          method: 'managePackages',
          params: {
            language: 'python',
            packages: ['example'],
            usePip: true,
            sessionId: 'forged',
            workspaceCwd: '/forged',
            permissionPrompts: policy === 'none' ? undefined : 'none'
          }
        })
      },
      'package approval policy regression'
    )
    if (policy === undefined) {
      await vi.waitFor(() => expect(f.emitted).toHaveLength(1))
      await f.broker.respond({
        requestId: f.emitted[0].requestId,
        optionId: f.emitted[0].options[1].optionId
      })
    }
    const response = await pending
    expect(response.status).toBe(200)
    expect((await response.json()).result.ok).toBe(false)
    expect(f.emitted).toHaveLength(policy === 'none' ? 0 : 1)
    expect(f.commit).not.toHaveBeenCalled()
    f.control.release()
    await f.parent.revoke()
  }
)
