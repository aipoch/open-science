import { describe, expect, it, type Mock, vi } from 'vitest'

import type { AcpCreateSessionRequest, AcpCreateSessionResponse } from '../../shared/acp'
import { createAcpCreateSessionWorkflow } from './create-session-workflow'
import type { ManagedSessionWorkspaceLease } from './managed-session-workspace'

type AcpCreateSessionWorkflowHarness = {
  workflow: ReturnType<typeof createAcpCreateSessionWorkflow>
  createSession: Mock<(request: AcpCreateSessionRequest) => Promise<AcpCreateSessionResponse>>
  deleteSession: Mock<(request: { sessionId: string }) => Promise<unknown>>
  lease: ManagedSessionWorkspaceLease
  workspaces: {
    acquire: Mock<(input: { projectId: string }) => Promise<ManagedSessionWorkspaceLease>>
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
  const deleteSession = vi.fn<(request: { sessionId: string }) => Promise<unknown>>(async () => {
    events.push('delete-session')
    return undefined
  })
  const lease: ManagedSessionWorkspaceLease = {
    cwd: '/data/workspaces/managed-1',
    commit: vi.fn(async () => {
      events.push('commit')
    }),
    release: vi.fn(async () => {
      events.push('release')
    })
  }
  const workspaces: AcpCreateSessionWorkflowHarness['workspaces'] = {
    acquire: vi.fn(async () => {
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
    { createSession, deleteSession },
    { workspaces, withDataRootWrite }
  )
  return {
    workflow,
    createSession,
    deleteSession,
    lease,
    workspaces,
    dataRootWriteCalls: () => dataRootWriteCalls,
    events
  }
}

describe('ACP create-Session workflow', () => {
  it('holds Project admission through Session publication', async () => {
    const created = createDeferred<AcpCreateSessionResponse>()
    let admissionActive = false
    const createSession = vi.fn(async () => {
      expect(admissionActive).toBe(true)
      return created.promise
    })
    const withProjectAvailable = async <Result>(
      projectId: string | undefined,
      operation: () => Promise<Result>
    ): Promise<Result> => {
      expect(projectId).toBe('project-1')
      admissionActive = true
      try {
        return await operation()
      } finally {
        admissionActive = false
      }
    }
    const workflow = createAcpCreateSessionWorkflow(
      { createSession, deleteSession: vi.fn() },
      { withProjectAvailable }
    )

    const pending = workflow.create({
      cwd: '/workspace',
      projectId: 'project-1',
      permissionProfile: 'ask'
    })
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledOnce())
    expect(admissionActive).toBe(true)

    created.resolve({ sessionId: 'session-1', cwd: '/workspace' })
    await pending

    expect(admissionActive).toBe(false)
  })

  it('trims and uses an explicit workspace without acquiring managed storage', async () => {
    const harness = createHarness()
    const request = {
      cwd: '  /chosen/workspace  ',
      projectId: 'project-1',
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
        harness.workflow.create({ cwd, projectId: 'project-1', permissionProfile: 'ask' })
      ).resolves.toEqual({
        sessionId: 'session-1',
        cwd: harness.lease.cwd
      })

      expect(harness.createSession).toHaveBeenCalledWith({
        cwd: harness.lease.cwd,
        projectId: 'project-1',
        permissionProfile: 'ask'
      })
      expect(harness.workspaces.acquire).toHaveBeenCalledWith({ projectId: 'project-1' })
      expect(harness.lease.commit).toHaveBeenCalledWith('session-1')
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

      await expect(harness.workflow.create({ projectId: 'project-1' })).rejects.toBe(failure)

      expect(harness.lease.commit).not.toHaveBeenCalled()
      expect(harness.events).toEqual(['guard:start', 'acquire', 'session', 'release', 'guard:end'])
    }
  )

  it('deletes the published Session when final ownership publication fails', async () => {
    const harness = createHarness()
    const failure = new Error('receipt publication failed')
    vi.mocked(harness.lease.commit).mockImplementationOnce(async () => {
      harness.events.push('commit')
      throw failure
    })

    await expect(harness.workflow.create({ projectId: 'project-1' })).rejects.toBe(failure)

    expect(harness.deleteSession).toHaveBeenCalledWith({ sessionId: 'session-1' })
    expect(harness.events).toEqual([
      'guard:start',
      'acquire',
      'session',
      'commit',
      'delete-session',
      'release',
      'guard:end'
    ])
  })
})

const createDeferred = <Value>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
} => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}
