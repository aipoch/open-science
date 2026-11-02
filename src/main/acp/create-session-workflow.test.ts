import { describe, expect, it, type Mock, vi } from 'vitest'

import type { AcpCreateSessionRequest, AcpCreateSessionResponse } from '../../shared/acp'
import { createAcpCreateSessionWorkflow } from './create-session-workflow'
import type { ManagedSessionWorkspaceLease } from './managed-session-workspace'
import { retainSessionCreationCleanup } from './session-creation-cleanup'

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
  it('retains explicit-workspace Project admission after reporting a provider creation failure', async () => {
    const failure = new Error('Provider startup failed')
    const cleanup = createDeferred<void>()
    let admitted = false
    const workflow = createAcpCreateSessionWorkflow(
      {
        createSession: async () => {
          retainSessionCreationCleanup(failure, cleanup.promise)
          throw failure
        },
        deleteSession: vi.fn()
      },
      {
        withProjectAvailable: async (_projectId, operation) => {
          admitted = true
          try {
            return await operation()
          } finally {
            admitted = false
          }
        }
      }
    )
    await expect(workflow.create({ cwd: '/workspace', projectId: 'project-1' })).rejects.toBe(
      failure
    )
    expect(admitted).toBe(true)
    cleanup.resolve()
    await vi.waitFor(() => expect(admitted).toBe(false))
  })
  it('returns the creation error while capability and workspace cleanup retain the writer', async () => {
    const failure = new Error('Provider startup failed')
    const capabilityCleanup = createDeferred<void>()
    const workspaceCleanup = createDeferred<void>()
    const harness = createHarness(failure)
    retainSessionCreationCleanup(failure, capabilityCleanup.promise)
    vi.mocked(harness.lease.release).mockImplementation(async () => {
      harness.events.push('release')
      await workspaceCleanup.promise
    })
    await expect(harness.workflow.create({ projectId: 'project-1' })).rejects.toBe(failure)
    expect(harness.events).not.toContain('guard:end')
    expect(harness.lease.release).not.toHaveBeenCalled()
    capabilityCleanup.resolve()
    await vi.waitFor(() => expect(harness.lease.release).toHaveBeenCalledOnce())
    expect(harness.events).not.toContain('guard:end')
    workspaceCleanup.resolve()
    await vi.waitFor(() => expect(harness.events).toContain('guard:end'))
  })

  it('returns publication failure before Session deletion settles without releasing the writer', async () => {
    const failure = new Error('Workspace publication failed')
    const cleanup = createDeferred<void>()
    const harness = createHarness()
    vi.mocked(harness.lease.commit).mockRejectedValueOnce(failure)
    harness.deleteSession.mockImplementationOnce(async () => {
      await cleanup.promise
    })
    await expect(harness.workflow.create({ projectId: 'project-1' })).rejects.toBe(failure)
    expect(harness.events).not.toContain('guard:end')
    expect(harness.lease.release).not.toHaveBeenCalled()
    cleanup.resolve()
    await vi.waitFor(() => expect(harness.events).toContain('guard:end'))
  })

  it('preserves the original error if workspace release also fails', async () => {
    const failure = new Error('Provider startup failed')
    const harness = createHarness(failure)
    vi.mocked(harness.lease.release).mockRejectedValueOnce(new Error('Workspace removal failed'))
    await expect(harness.workflow.create({ projectId: 'project-1' })).rejects.toBe(failure)
    await vi.waitFor(() => expect(harness.events).toContain('guard:end'))
  })
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

  it.each([
    { requestedProjectId: '  project-1  ', expectedProjectId: 'project-1' },
    { requestedProjectId: '   ', expectedProjectId: undefined }
  ])(
    'normalizes "$requestedProjectId" before Project admission',
    async ({ requestedProjectId, expectedProjectId }) => {
      const createSession = vi.fn(async (request: AcpCreateSessionRequest) => ({
        sessionId: 'session-1',
        cwd: request.cwd
      }))
      const admittedProjectIds: (string | undefined)[] = []
      const withProjectAvailable = async <Result>(
        projectId: string | undefined,
        operation: () => Promise<Result>
      ): Promise<Result> => {
        admittedProjectIds.push(projectId)
        return operation()
      }
      const workflow = createAcpCreateSessionWorkflow(
        { createSession, deleteSession: vi.fn() },
        { withProjectAvailable }
      )

      await workflow.create({
        cwd: '/workspace',
        projectId: requestedProjectId,
        permissionProfile: 'ask'
      })

      expect(admittedProjectIds).toEqual([expectedProjectId])
      expect(createSession).toHaveBeenCalledWith({
        cwd: '/workspace',
        projectId: expectedProjectId,
        permissionProfile: 'ask'
      })
    }
  )

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

  it('retains the workspace when ownership publication and Session rollback both fail', async () => {
    const harness = createHarness()
    const publicationFailure = new Error('receipt publication failed')
    const rollbackFailure = new Error('Session rollback failed')
    vi.mocked(harness.lease.commit).mockImplementationOnce(async () => {
      harness.events.push('commit')
      throw publicationFailure
    })
    harness.deleteSession.mockImplementationOnce(async () => {
      harness.events.push('delete-session')
      throw rollbackFailure
    })

    await expect(harness.workflow.create({ projectId: 'project-1' })).rejects.toBe(
      publicationFailure
    )
    await vi.waitFor(() => expect(harness.events).toContain('guard:end'))

    expect(harness.lease.release).not.toHaveBeenCalled()
    expect(harness.events).toEqual([
      'guard:start',
      'acquire',
      'session',
      'commit',
      'delete-session',
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
