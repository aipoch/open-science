import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { createManagedSessionWorkflow } from './create-managed-session'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const request = { projectId: 'project', requestId: 'create-1', title: 'Review and run' }
async function fixture(): Promise<{
  stored: Map<string, PersistedChatSession>
  lease: {
    cwd: string
    commit: ReturnType<typeof vi.fn<() => Promise<void>>>
    release: ReturnType<typeof vi.fn<() => Promise<void>>>
  }
  workflow: ReturnType<typeof createManagedSessionWorkflow>
  dependencies: Parameters<typeof createManagedSessionWorkflow>[0] & {
    sessions: {
      readSessionSnapshot: ReturnType<
        typeof vi.fn<(project: string, id: string) => Promise<PersistedChatSession | undefined>>
      >
      saveSession: ReturnType<
        typeof vi.fn<(session: PersistedChatSession) => Promise<PersistedChatSession>>
      >
      deleteSession: ReturnType<typeof vi.fn<(project: string, id: string) => Promise<void>>>
    }
    workspaces: {
      acquire: ReturnType<
        typeof vi.fn<
          () => Promise<{ cwd: string; commit: () => Promise<void>; release: () => Promise<void> }>
        >
      >
    }
  }
}> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'managed-session-'))
  roots.push(dataRoot)
  const stored = new Map<string, PersistedChatSession>()
  const sessions = {
    readSessionSnapshot: vi.fn(async (_project: string, id: string) => stored.get(id)),
    saveSession: vi.fn(async (session: PersistedChatSession) => {
      stored.set(session.id, session)
      return session
    }),
    deleteSession: vi.fn(async (_project: string, id: string) => {
      stored.delete(id)
    })
  }
  const lease = {
    cwd: join(dataRoot, 'workspace'),
    commit: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined)
  }
  const dependencies = {
    dataRoot,
    sessions,
    workspaces: { acquire: vi.fn(async () => lease) },
    withProjectAvailable: async <T>(_id: string, operation: () => Promise<T>): Promise<T> =>
      operation(),
    withDataRootWrite: async <T>(operation: () => Promise<T>): Promise<T> => operation()
  }
  return { dependencies, stored, lease, workflow: createManagedSessionWorkflow(dependencies) }
}

it('concurrent identical creates and a restarted client return the same ordinary Session', async () => {
  const f = await fixture()
  const [first, retry] = await Promise.all([f.workflow.create(request), f.workflow.create(request)])
  expect(retry).toEqual(first)
  expect(await createManagedSessionWorkflow(f.dependencies).create(request)).toEqual(first)
  expect(f.dependencies.workspaces.acquire).toHaveBeenCalledTimes(1)
  expect(f.stored.get(first.sessionId)).toMatchObject({ status: 'idle', messages: [] })
  expect(f.stored.get(first.sessionId)).not.toHaveProperty('providerSessionId')
})

it('recovers a lost Session publication response without allocating another workspace', async () => {
  const f = await fixture()
  f.dependencies.sessions.saveSession.mockImplementationOnce(async (session) => {
    f.stored.set(session.id, session)
    throw new Error('Index publication response lost')
  })
  await expect(f.workflow.create(request)).rejects.toThrow('response lost')
  const recovered = await createManagedSessionWorkflow(f.dependencies).create(request)
  expect(recovered.sessionId).toBe([...f.stored.keys()][0])
  expect(f.dependencies.workspaces.acquire).toHaveBeenCalledTimes(1)
  expect(f.lease.release).not.toHaveBeenCalled()
})

it('rejects a conflicting reuse, keeps Project request identities separate, and never resurrects a deleted Session', async () => {
  const f = await fixture()
  const first = await f.workflow.create(request)
  await expect(f.workflow.create({ ...request, title: 'different' })).rejects.toThrow('conflicts')
  const other = await f.workflow.create({ ...request, projectId: 'another-project' })
  expect(other.sessionId).not.toBe(first.sessionId)
  f.stored.delete(first.sessionId)
  await expect(f.workflow.create(request)).rejects.toThrow('deleted')
  expect(f.dependencies.workspaces.acquire).toHaveBeenCalledTimes(2)
})

it('does not silently retry an interrupted allocation and rejects caller-supplied path authority', async () => {
  const f = await fixture()
  f.dependencies.workspaces.acquire.mockRejectedValueOnce(new Error('allocation failed'))
  await expect(f.workflow.create(request)).rejects.toThrow('allocation failed')
  await expect(f.workflow.create(request)).rejects.toThrow('interrupted')
  await expect(f.workflow.create({ ...request, cwd: '/private/data' } as never)).rejects.toThrow()
  expect(f.dependencies.workspaces.acquire).toHaveBeenCalledTimes(1)
})

it('Main lookup distinguishes absent intent, committed Session and deleted Session without allocation', async () => {
  const f = await fixture()
  const scope = { projectId: request.projectId, requestId: request.requestId }
  expect(await f.workflow.lookup(scope)).toBeUndefined()
  expect(f.dependencies.workspaces.acquire).not.toHaveBeenCalled()
  f.dependencies.sessions.saveSession.mockImplementationOnce(async (session) => {
    f.stored.set(session.id, session)
    throw new Error('publication reply lost')
  })
  await expect(f.workflow.create(request)).rejects.toThrow('reply lost')
  const sessionId = [...f.stored.keys()][0]
  expect(await f.workflow.lookup(scope)).toEqual({
    projectId: request.projectId,
    sessionId,
    state: 'available'
  })
  f.stored.delete(sessionId)
  expect(await f.workflow.lookup(scope)).toEqual({
    projectId: request.projectId,
    sessionId,
    state: 'missing'
  })
  expect(f.dependencies.workspaces.acquire).toHaveBeenCalledTimes(1)
})
