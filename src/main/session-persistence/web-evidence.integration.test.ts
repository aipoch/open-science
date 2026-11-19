import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatSession, PersistedToolActivity } from '../../shared/session-persistence'
import { WebEvidenceLifecycle, webEvidenceScope } from '../web/evidence-lifecycle'
import { WebService } from '../web/service'
import { WebSnapshotStore } from '../web/snapshot-store'
import { initDataRoot } from '../storage-root'
import { SessionRepository } from './repository'
import { SessionPersistenceCoordinator, type SessionFileIndex } from './coordinator'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const createIndex = (): SessionFileIndex => ({
  syncSession: vi.fn(async () => []),
  softDeleteSession: vi.fn(async () => 'session-delete'),
  restoreSession: vi.fn(async () => undefined),
  softDeleteProject: vi.fn(async () => 'project-delete'),
  reconcileProjectSessions: vi.fn(async () => undefined),
  reconcileActiveSessions: vi.fn(async () => undefined),
  markReconciliationIncomplete: vi.fn()
})

it('uses canonical conversation commands for same-session ownership and preserves child evidence through durable parent deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-web-evidence-'))
  roots.push(root)
  initDataRoot(root)
  const repository = new SessionRepository(root)
  const store = new WebSnapshotStore(join(root, 'web-evidence'))
  const deleteInvocations = vi.fn(async () => undefined)
  const lifecycle = new WebEvidenceLifecycle(
    store,
    (projectId, sessionId) => repository.loadSession(projectId, sessionId),
    deleteInvocations
  )
  const index = createIndex()
  const args: ConstructorParameters<typeof SessionPersistenceCoordinator> = [repository, index]
  args[14] = lifecycle
  const coordinator = new SessionPersistenceCoordinator(...args)
  const network = vi.fn(async (url: string) => ({
    body: Buffer.from('Saved immutable evidence with more text.'),
    finalUrl: url,
    contentType: 'text/plain'
  }))
  const service = new WebService({ store, transport: network })
  const parent: PersistedChatSession = {
    id: 'parent',
    projectId: 'project',
    title: 'Evidence',
    cwd: '',
    status: 'idle',
    createdAt: 1,
    updatedAt: 150,
    messages: [
      {
        id: 'u1',
        role: 'user',
        content: 'First',
        status: 'complete',
        eventIds: [],
        createdAt: 10,
        updatedAt: 10
      },
      {
        id: 'a1',
        role: 'agent',
        content: 'First answer',
        status: 'complete',
        eventIds: [],
        createdAt: 50,
        updatedAt: 50,
        completedAt: 50
      },
      {
        id: 'u2',
        role: 'user',
        content: 'Later',
        status: 'complete',
        eventIds: [],
        createdAt: 100,
        updatedAt: 100
      },
      {
        id: 'a2',
        role: 'agent',
        content: 'Later answer',
        status: 'complete',
        eventIds: [],
        createdAt: 150,
        updatedAt: 150,
        completedAt: 150
      }
    ]
  }
  const graph = createLinearConversationGraph({
    sessionId: parent.id,
    messages: parent.messages,
    createdAt: 1,
    updatedAt: 150
  })
  const branch = graph.frames[0].activeBranchId
  const scope = webEvidenceScope(parent.projectId, parent.id, branch)
  const first = await service.fetch(
    scope,
    { url: 'https://example.org/first', max_chars: 5 },
    { invocationId: 'first-invocation' }
  )
  const later = await service.fetch(
    scope,
    { url: 'https://example.org/later', max_chars: 5 },
    { invocationId: 'later-invocation' }
  )
  await service.commitSnapshot(scope, first.document!.snapshot_id)
  await service.commitSnapshot(scope, later.document!.snapshot_id)
  const activity = (
    result: typeof first,
    id: string,
    prompt: string,
    at: number
  ): PersistedToolActivity => ({
    id,
    kind: 'tool',
    title: 'web_fetch',
    status: 'completed',
    appOwned: true,
    executionInvocationId: result.invocation_id,
    providerToolName: 'mcp__open_science_web__web_fetch',
    promptMessageId: prompt,
    eventIds: [],
    sortIndex: 1,
    createdAt: at,
    updatedAt: at + 5,
    rawOutput: result,
    webInvocation: {
      attempt: 1,
      configGeneration: 'generation',
      branchId: branch,
      retryEligible: true
    }
  })
  graph.activities = [activity(first, 'first', 'u1', 20), activity(later, 'later', 'u2', 110)].map(
    (item) => ({
      ...item,
      agentFrameId: graph.rootFrameId,
      messageBranchId: branch,
      promptMessageId: item.promptMessageId!,
      runtimeSegmentId: graph.runtimeSegments[0].id
    })
  )
  parent.conversationGraph = graph
  parent.activities = graph.activities
  await repository.saveSession(parent)
  await coordinator.loadAll()
  const current = (await repository.loadSession(parent.projectId, parent.id))!
  const edited = await coordinator.saveSession(current, {
    conversationCommands: [
      {
        kind: 'fork-message',
        id: 'fork-edited-command',
        parentBranchId: branch,
        branchId: 'edited',
        messageId: 'u2',
        timestamp: 180
      }
    ]
  })
  const editedScope = webEvidenceScope(parent.projectId, parent.id, 'edited')
  expect(
    (
      await service.fetch(editedScope, {
        snapshot_id: first.document!.snapshot_id,
        cursor: first.document!.next_cursor!
      })
    ).status
  ).toBe('ok')
  expect(
    (
      await service.fetch(editedScope, {
        snapshot_id: later.document!.snapshot_id,
        cursor: later.document!.next_cursor!
      })
    ).error?.code
  ).toBe('INVALID_CURSOR')
  const child = structuredClone(edited)
  child.id = 'child'
  delete child.conversationGraph
  delete child.revision
  child.branchSource = {
    sessionId: parent.id,
    agentFrameId: graph.rootFrameId,
    messageBranchId: 'edited',
    headMessageId: 'a1'
  }
  const saved = await coordinator.saveSession(child)
  const childBranch = saved.conversationGraph!.frames[0].activeBranchId
  const childScope = webEvidenceScope(child.projectId, child.id, childBranch)
  expect(saved.activities?.[0].webInvocation?.retryEligible).toBeUndefined()
  expect(edited.activities?.[0].webInvocation?.retryEligible).toBe(true)
  await coordinator.deleteSession(parent.projectId, parent.id)
  expect(await repository.loadSession(parent.projectId, parent.id)).toBeUndefined()
  const offline = new WebService({
    store: new WebSnapshotStore(join(root, 'web-evidence')),
    transport: async () => {
      throw new Error('offline')
    }
  })
  expect(
    (
      await offline.fetch(childScope, {
        snapshot_id: first.document!.snapshot_id,
        cursor: first.document!.next_cursor!
      })
    ).status
  ).toBe('ok')
  expect(deleteInvocations).toHaveBeenCalledWith({
    projectId: parent.projectId,
    sessionId: parent.id
  })
  await coordinator.deleteSession(child.projectId, child.id)
  expect(
    (
      await offline.fetch(childScope, {
        snapshot_id: first.document!.snapshot_id,
        cursor: first.document!.next_cursor!
      })
    ).status
  ).toBe('error')
  expect(network).toHaveBeenCalledTimes(2)
})

it('completes Project terminal participants and retries Web cleanup from the prepared tombstone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-web-cleanup-'))
  roots.push(root)
  initDataRoot(root)
  const repo = new SessionRepository(root)
  const index = createIndex(),
    filesChanged = vi.fn(),
    commit = vi.fn()
  const args: ConstructorParameters<typeof SessionPersistenceCoordinator> = [
    repo,
    index,
    filesChanged
  ]
  const lifecycle = new WebEvidenceLifecycle(new WebSnapshotStore(join(root, 'web')), (p, s) =>
    repo.loadSession(p, s)
  )
  const release = vi
    .spyOn(lifecycle, 'releaseSession')
    .mockRejectedValueOnce(new Error('interrupted Web cleanup'))
    .mockResolvedValue(undefined)
  args[14] = lifecycle
  const compute = {
    prepareProjectJobDeletion: vi.fn(),
    commitProjectJobDeletion: vi.fn(),
    prepareSessionJobDeletion: vi.fn(),
    commitSessionJobDeletion: vi.fn(),
    abortProjectJobDeletion: vi.fn()
  }
  args[8] = compute
  const coordinator = new SessionPersistenceCoordinator(...args)
  for (const id of ['one', 'two'])
    await repo.saveSession({
      id,
      projectId: 'project',
      title: id,
      cwd: '',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
      messages: []
    })
  await coordinator.loadAll()
  coordinator.setSessionDeletionHandlers({ commit, reconcile: vi.fn() })
  await expect(coordinator.deleteProjectSessions('project')).rejects.toThrow(
    'Web evidence cleanup is incomplete'
  )
  expect(await repo.getProjectSessionDeletionState('project')).toBe('prepared')
  expect((await coordinator.sessionMetadataSnapshot()).sessions).toEqual([])
  expect(compute.commitProjectJobDeletion).toHaveBeenCalledWith('project')
  expect(compute.abortProjectJobDeletion).not.toHaveBeenCalled()
  expect(index.softDeleteProject).toHaveBeenCalledWith('project')
  expect(filesChanged).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: 'project', kind: 'reset' })
  )
  expect(commit).toHaveBeenCalledWith(expect.arrayContaining(['one', 'two']))
  expect(release).toHaveBeenCalledTimes(2)
  await expect(coordinator.deleteProjectSessions('project')).resolves.toEqual({
    status: 'completed'
  })
  expect(release.mock.calls.slice(2).sort()).toEqual([
    ['project', 'one'],
    ['project', 'two']
  ])
  await coordinator.completeProjectSessionDeletion('project')
  expect(await repo.getProjectSessionDeletionState('project')).toBe('absent')
})
