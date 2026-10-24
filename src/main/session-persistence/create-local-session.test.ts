import { describe, expect, it, vi } from 'vitest'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { createLocalSessionWorkflow } from './create-local-session'

const fixture = (): {
  workflow: ReturnType<typeof createLocalSessionWorkflow>
  sessions: {
    readSessionSnapshot: ReturnType<
      typeof vi.fn<(project: string, session: string) => Promise<PersistedChatSession | undefined>>
    >
    saveSession: ReturnType<
      typeof vi.fn<(session: PersistedChatSession) => Promise<PersistedChatSession>>
    >
    deleteSession: ReturnType<typeof vi.fn<(project: string, session: string) => Promise<void>>>
  }
  lease: { cwd: string; commit: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }
  acquire: ReturnType<typeof vi.fn>
  events: string[]
} => {
  const events: string[] = []
  const stored = new Map<string, PersistedChatSession>()
  const sessions = {
    readSessionSnapshot: vi.fn(async (_project: string, session: string) => stored.get(session)),
    saveSession: vi.fn(async (session: PersistedChatSession) => {
      events.push('save')
      const saved = { ...session, number: 1, revision: 1 }
      stored.set(session.id, saved)
      return saved
    }),
    deleteSession: vi.fn(async (_project: string, session: string) => {
      events.push('delete')
      stored.delete(session)
    })
  }
  const lease = {
    cwd: '/data/workspaces/owned',
    commit: vi.fn(async () => {
      events.push('commit')
    }),
    release: vi.fn(async () => {
      events.push('release')
    })
  }
  const acquire = vi.fn(async () => {
    events.push('acquire')
    return lease
  })
  const workflow = createLocalSessionWorkflow({
    sessions,
    workspaces: { acquire },
    createId: () => 'new-session',
    now: () => 123,
    withProjectAvailable: async (_project, operation) => {
      events.push('project:start')
      try {
        return await operation()
      } finally {
        events.push('project:end')
      }
    },
    withDataRootWrite: async (operation) => {
      events.push('write:start')
      try {
        return await operation()
      } finally {
        events.push('write:end')
      }
    }
  })
  return { workflow, sessions, lease, acquire, events }
}

describe('ordinary local Session creation without an Agent runtime', () => {
  it('publishes an empty ordinary Session under the Project and data-root guards', async () => {
    const context = fixture()
    const session = await context.workflow.create({ projectId: 'project', title: 'External work' })
    expect(session).toMatchObject({
      id: 'new-session',
      projectId: 'project',
      cwd: context.lease.cwd,
      status: 'idle',
      messages: [],
      permissionProfile: 'ask',
      number: 1,
      revision: 1
    })
    expect(session).not.toHaveProperty('providerSessionId')
    expect(session).not.toHaveProperty('packageOrigin')
    expect(context.events).toEqual([
      'project:start',
      'write:start',
      'acquire',
      'save',
      'commit',
      'write:end',
      'project:end'
    ])
  })

  it('rejects caller-supplied runtime authority and traversal identities before allocation', async () => {
    const context = fixture()
    await expect(
      context.workflow.create({ projectId: '../project', title: 'Unsafe' })
    ).rejects.toThrow()
    await expect(
      context.workflow.create({ projectId: 'project', title: 'Unsafe', cwd: '/host' } as never)
    ).rejects.toThrow()
    expect(context.acquire).not.toHaveBeenCalled()
  })

  it('does not overwrite a colliding durable Session', async () => {
    const context = fixture()
    await context.workflow.create({ projectId: 'project', title: 'First' })
    await expect(
      context.workflow.create({ projectId: 'project', title: 'Second' })
    ).rejects.toThrow('already exists')
    expect(context.acquire).toHaveBeenCalledTimes(1)
  })

  it('releases an unpublished workspace when persistence fails', async () => {
    const context = fixture()
    context.sessions.saveSession.mockRejectedValueOnce(new Error('write failed'))
    await expect(context.workflow.create({ projectId: 'project', title: 'Work' })).rejects.toThrow(
      'write failed'
    )
    expect(context.lease.release).toHaveBeenCalledOnce()
    expect(context.lease.commit).not.toHaveBeenCalled()
  })

  it('retains and commits a workspace when JSON published before the index failed', async () => {
    const context = fixture()
    const save = context.sessions.saveSession.getMockImplementation()!
    context.sessions.saveSession.mockImplementationOnce(async (session) => {
      await save(session)
      throw new Error('index failed')
    })
    await expect(context.workflow.create({ projectId: 'project', title: 'Work' })).rejects.toThrow(
      'index failed'
    )
    expect(context.lease.commit).toHaveBeenCalledWith('new-session')
    expect(context.lease.release).not.toHaveBeenCalled()
    expect(context.sessions.deleteSession).not.toHaveBeenCalled()
  })

  it('retains uncertain storage when the publication readback fails', async () => {
    const context = fixture()
    context.sessions.readSessionSnapshot
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('read failed'))
    context.sessions.saveSession.mockRejectedValueOnce(new Error('write uncertain'))
    await expect(context.workflow.create({ projectId: 'project', title: 'Work' })).rejects.toThrow(
      'uncertain'
    )
    expect(context.lease.release).not.toHaveBeenCalled()
  })

  it('rolls back a published Session before releasing an uncommitted workspace', async () => {
    const context = fixture()
    context.lease.commit.mockRejectedValueOnce(new Error('commit failed'))
    await expect(context.workflow.create({ projectId: 'project', title: 'Work' })).rejects.toThrow(
      'commit failed'
    )
    expect(context.events.indexOf('delete')).toBeLessThan(context.events.indexOf('release'))
  })

  it('retains the workspace if Session rollback is unconfirmed', async () => {
    const context = fixture()
    context.lease.commit.mockRejectedValueOnce(new Error('commit failed'))
    context.sessions.deleteSession.mockRejectedValueOnce(new Error('delete failed'))
    await expect(context.workflow.create({ projectId: 'project', title: 'Work' })).rejects.toThrow(
      'retained'
    )
    expect(context.lease.release).not.toHaveBeenCalled()
  })
})
