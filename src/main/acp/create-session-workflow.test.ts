import { describe, expect, it, type Mock, vi } from 'vitest'

import type { AcpCreateSessionRequest, AcpCreateSessionResponse } from '../../shared/acp'
import { createAcpCreateSessionWorkflow } from './create-session-workflow'
import type { ManagedSessionWorkspaceLease } from './managed-session-workspace'

type AcpCreateSessionWorkflowHarness = {
  workflow: ReturnType<typeof createAcpCreateSessionWorkflow>
  createSession: Mock<(request: AcpCreateSessionRequest) => Promise<AcpCreateSessionResponse>>
  lease: ManagedSessionWorkspaceLease
  workspaces: {
    acquire: Mock<() => Promise<ManagedSessionWorkspaceLease>>
  }
  dataRootWriteCalls: () => number
  events: string[]
}

const createHarness = (
  createSessionResult: 'success' | Error = 'success'
): AcpCreateSessionWorkflowHarness => {
  const events: string[] = []
  const createSession = vi.fn<
    (request: AcpCreateSessionRequest) => Promise<AcpCreateSessionResponse>
  >(async (request) => {
    events.push('session')
    if (createSessionResult instanceof Error) throw createSessionResult
    return { sessionId: 'session-1', cwd: request.cwd }
  })
  const lease: ManagedSessionWorkspaceLease = {
    cwd: '/data/workspaces/managed-1',
    commit: vi.fn(() => events.push('commit')),
    release: vi.fn(async () => {
      events.push('release')
    })
  }
  const workspaces: AcpCreateSessionWorkflowHarness['workspaces'] = {
    acquire: vi.fn<() => Promise<ManagedSessionWorkspaceLease>>(async () => {
      events.push('acquire')
      return lease
    })
  }
  let dataRootWriteCalls = 0
  const withDataRootWrite = async <Result>(write: () => Promise<Result>): Promise<Result> => {
    dataRootWriteCalls += 1
    events.push('guard:start')
    try {
      return await write()
    } finally {
      events.push('guard:end')
    }
  }
  const workflow = createAcpCreateSessionWorkflow(
    { createSession },
    { workspaces, withDataRootWrite }
  )
  return {
    workflow,
    createSession,
    lease,
    workspaces,
    dataRootWriteCalls: () => dataRootWriteCalls,
    events
  }
}

describe('ACP create-Session workflow', () => {
  it('trims and uses an explicit workspace without acquiring managed storage', async () => {
    const harness = createHarness()
    const request = {
      cwd: '  /chosen/workspace  ',
      projectName: 'project-1',
      permissionProfile: 'ask' as const
    }

    await expect(harness.workflow.create(request)).resolves.toEqual({
      sessionId: 'session-1',
      cwd: '/chosen/workspace'
    })

    expect(harness.createSession).toHaveBeenCalledWith({
      ...request,
      cwd: '/chosen/workspace'
    })
    expect(harness.workspaces.acquire).not.toHaveBeenCalled()
    expect(harness.dataRootWriteCalls()).toBe(0)
  })

  it.each([{ cwd: undefined }, { cwd: '   ' }])(
    'publishes a Session before committing a managed workspace for $cwd',
    async ({ cwd }) => {
      const harness = createHarness()

      await expect(
        harness.workflow.create({ cwd, projectName: 'project-1', permissionProfile: 'ask' })
      ).resolves.toEqual({
        sessionId: 'session-1',
        cwd: harness.lease.cwd
      })

      expect(harness.createSession).toHaveBeenCalledWith({
        cwd: harness.lease.cwd,
        projectName: 'project-1',
        permissionProfile: 'ask'
      })
      expect(harness.events).toEqual([
        'guard:start',
        'acquire',
        'session',
        'commit',
        'release',
        'guard:end'
      ])
    }
  )

  it.each([new Error('session creation failed'), new Error('ACP session startup was superseded')])(
    'releases a provisional workspace when creation rejects with %s',
    async (failure) => {
      const harness = createHarness(failure)

      await expect(harness.workflow.create({ projectName: 'project-1' })).rejects.toBe(failure)

      expect(harness.lease.commit).not.toHaveBeenCalled()
      expect(harness.events).toEqual(['guard:start', 'acquire', 'session', 'release', 'guard:end'])
    }
  )
})
