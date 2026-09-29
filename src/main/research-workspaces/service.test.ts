import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ReplayViewState, ReplayQuestionContext } from '../../shared/research-workspace'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ResearchWorkspaceRepository } from './repository'
import { ResearchWorkspaceService, type ResearchWorkspaceSessions } from './service'

const identity = { projectId: 'project', sourceSessionId: 'import-source' }
const view: ReplayViewState = {
  fingerprint: 'original',
  generatorVersion: 1,
  presentationVersion: 1,
  branchId: 'main',
  stepId: 'message:1',
  timeMs: 1000,
  stepOffsetMs: 50,
  rate: 1
}
const questionContext = (): ReplayQuestionContext => ({
  ...identity,
  id: 'question-context',
  sourceTitle: 'Original research',
  fingerprint: 'original',
  branchId: 'main',
  stepId: 'run:1',
  stepOffsetMs: 50,
  recordedAt: 1,
  evidence: [
    {
      kind: 'notebook-run',
      id: 'run-1',
      projectId: identity.projectId,
      sessionId: identity.sourceSessionId,
      part: 'input'
    }
  ],
  excerpt: 'Captured question context'
})
const sourceSession = (): PersistedChatSession => ({
  id: identity.sourceSessionId,
  projectId: identity.projectId,
  title: 'Original research',
  cwd: '/foreign',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  agentModel: 'foreign-model',
  providerSessionId: 'foreign-provider',
  packageOrigin: {
    importId: 'original',
    sourceProjectId: 'foreign',
    sourceSessionId: 'foreign-session',
    importedAt: 1,
    manifestChecksum: 'a'.repeat(64)
  }
})

describe('local research workspace ownership', () => {
  let directory: string
  let client: PrismaClient
  let repository: ResearchWorkspaceRepository
  let service: ResearchWorkspaceService
  let sessions: Map<string, PersistedChatSession>
  let reads: ResearchWorkspaceSessions['read']
  let save: ReturnType<typeof vi.fn<ResearchWorkspaceSessions['save']>>
  let unreadable: Set<string>
  const makeService = (): ResearchWorkspaceService =>
    new ResearchWorkspaceService(
      repository,
      { read: reads, save },
      async (projectId, operation) => {
        const project = await client.project.findFirst({
          where: { id: projectId, deletedAt: null, archivedAt: null }
        })
        if (!project) throw new Error('Project unavailable')
        return operation()
      }
    )

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'research-workspaces-'))
    client = createProjectDbClient(directory)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project', name: 'Project' } })
    sessions = new Map([[identity.sourceSessionId, sourceSession()]])
    unreadable = new Set()
    reads = vi.fn(async (_projectId, sessionId) =>
      unreadable.has(sessionId)
        ? { status: 'unreadable' as const }
        : sessions.has(sessionId)
          ? { status: 'found' as const, session: structuredClone(sessions.get(sessionId)!) }
          : { status: 'missing' as const }
    )
    save = vi.fn(async (session) => {
      const saved = { ...structuredClone(session), revision: 1 }
      sessions.set(session.id, saved)
      return saved
    })
    repository = new ResearchWorkspaceRepository(async () => client)
    service = makeService()
  })
  afterEach(async () => {
    await client?.$disconnect()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('browses and saves playback checkpoints without creating or mutating any Session', async () => {
    const before = structuredClone(sessions.get(identity.sourceSessionId))
    expect(await service.get(identity)).toMatchObject({
      sourceStatus: 'available',
      discussionStatus: 'none',
      linkRevision: 0
    })
    expect(await client.researchWorkspace.count()).toBe(0)
    expect(await service.saveView({ ...identity, state: view, expectedRevision: 0 })).toEqual({
      status: 'saved',
      revision: 1
    })
    expect(await service.get(identity)).toMatchObject({
      discussionStatus: 'none',
      view: { state: view, revision: 1 }
    })
    expect(save).not.toHaveBeenCalled()
    expect(sessions.get(identity.sourceSessionId)).toEqual(before)
  })

  it('admits local replay writes before reading or writing any data-root-owned state', async () => {
    const gated = new ResearchWorkspaceService(
      repository,
      { read: reads, save },
      async (_id, operation) => operation(),
      async () => {
        throw new Error('Data root changing')
      }
    )
    await expect(gated.saveView({ ...identity, state: view, expectedRevision: 0 })).rejects.toThrow(
      'Data root changing'
    )
    await expect(
      gated.saveQuestionContext({ ...identity, context: questionContext() })
    ).rejects.toThrow('Data root changing')
    expect(reads).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    expect(await client.researchWorkspace.count()).toBe(0)
    expect(await client.replayQuestionContext.count()).toBe(0)
  })

  it('saves immutable bounded question references idempotently without creating a Discussion', async () => {
    const context = questionContext()
    await Promise.all([
      service.saveQuestionContext({ ...identity, context }),
      service.saveQuestionContext({ ...identity, context })
    ])
    expect(
      await service.getQuestionContext({ projectId: identity.projectId, id: context.id })
    ).toEqual(context)
    expect(await service.listQuestionContexts(identity)).toEqual([context])
    expect(await client.replayQuestionContext.count()).toBe(1)
    expect(await client.researchWorkspace.count()).toBe(0)
    expect(save).not.toHaveBeenCalled()
    await expect(
      service.saveQuestionContext({ ...identity, context: { ...context, excerpt: 'Changed' } })
    ).rejects.toThrow('different context')
    expect(
      (await service.getQuestionContext({ projectId: identity.projectId, id: context.id }))?.excerpt
    ).toBe(context.excerpt)
  })

  it('retains question references after source deletion, scopes reads to the Project and cleans up with it', async () => {
    const context = questionContext()
    await service.saveQuestionContext({ ...identity, context })
    sessions.delete(identity.sourceSessionId)
    await repository.sessionsDeleted([identity.sourceSessionId])
    await service.saveQuestionContext({ ...identity, context })
    expect(
      await makeService().getQuestionContext({ projectId: identity.projectId, id: context.id })
    ).toEqual(context)
    expect(await service.getQuestionContext({ projectId: 'other', id: context.id })).toBeUndefined()
    expect(await service.listQuestionContexts({ ...identity, sourceSessionId: 'other' })).toEqual(
      []
    )
    await expect(
      service.saveQuestionContext({ ...identity, context: { ...context, id: 'new-context' } })
    ).rejects.toThrow('cannot be read')
    await client.project.delete({ where: { id: identity.projectId } })
    expect(await client.replayQuestionContext.count()).toBe(0)
  })

  it('rejects question context rewrites across Projects and new references for deleted Projects', async () => {
    const context = questionContext()
    await service.saveQuestionContext({ ...identity, context })
    await client.project.create({ data: { id: 'other', name: 'Other' } })
    await expect(
      repository.saveQuestionContext({ ...context, projectId: 'other', evidence: [] })
    ).rejects.toThrow('different context')
    await client.project.update({
      where: { id: identity.projectId },
      data: { deletedAt: new Date() }
    })
    expect(
      await service.getQuestionContext({ projectId: identity.projectId, id: context.id })
    ).toBeUndefined()
    expect(await service.listQuestionContexts(identity)).toEqual([])
    await expect(service.saveQuestionContext({ ...identity, context })).rejects.toThrow(
      'unavailable'
    )
  })

  it('reserves one ordinary Discussion for simultaneous first sends and recovers it after reopen', async () => {
    const [first, second] = await Promise.all([
      service.ensureDiscussion({ ...identity, title: 'My discussion' }),
      service.ensureDiscussion(identity)
    ])
    expect(first.discussionSessionId).toBe(second.discussionSessionId)
    expect(save).toHaveBeenCalledTimes(1)
    expect(first.discussionSession).toMatchObject({
      title: 'My discussion',
      cwd: '',
      status: 'idle',
      messages: []
    })
    expect(first.discussionSession).not.toHaveProperty('packageOrigin')
    expect(first.discussionSession).not.toHaveProperty('agentModel')
    expect(first.discussionSession).not.toHaveProperty('providerSessionId')
    expect(await makeService().get(identity)).toEqual(first)
    expect(sessions.get(identity.sourceSessionId)).toEqual(sourceSession())
  })

  it('resumes a durable creation intent with the same identity when JSON creation failed', async () => {
    save.mockRejectedValueOnce(new Error('disk busy'))
    await expect(service.ensureDiscussion(identity)).rejects.toThrow('disk busy')
    const pending = await service.get(identity)
    expect(pending.discussionStatus).toBe('creating')
    const recovered = await makeService().ensureDiscussion(identity)
    expect(recovered.discussionSessionId).toBe(pending.discussionSessionId)
    expect(recovered.discussionStatus).toBe('available')
  })

  it('does not overwrite durable JSON when a save succeeded before its response failed', async () => {
    save.mockImplementationOnce(async (session) => {
      sessions.set(session.id, {
        ...session,
        messages: [
          {
            id: 'existing',
            role: 'user',
            content: 'Keep me',
            status: 'complete',
            eventIds: [],
            createdAt: 2,
            updatedAt: 2
          }
        ]
      })
      throw new Error('projection failure after JSON save')
    })
    await expect(service.ensureDiscussion(identity)).rejects.toThrow('projection failure')
    const recovered = await makeService().ensureDiscussion(identity)
    expect(recovered.discussionSession?.messages[0]?.content).toBe('Keep me')
    expect(save).toHaveBeenCalledTimes(1)
    expect((await repository.get(identity))?.discussionState).toBe('ready')
  })

  it('retains deleted Discussion identity and requires a matching explicit replacement request', async () => {
    const original = await service.ensureDiscussion(identity)
    sessions.delete(original.discussionSessionId!)
    await repository.sessionsDeleted([original.discussionSessionId!])
    const deleted = await service.get(identity)
    expect(deleted.discussionStatus).toBe('missing')
    expect(deleted.discussionSessionId).toBe(original.discussionSessionId)
    await expect(service.ensureDiscussion(identity)).rejects.toThrow('deleted')
    await expect(
      service.ensureDiscussion({
        ...identity,
        recreateMissing: {
          expectedDiscussionSessionId: original.discussionSessionId!,
          expectedRevision: original.linkRevision
        }
      })
    ).rejects.toThrow('changed')
    const replacement = await service.ensureDiscussion({
      ...identity,
      recreateMissing: {
        expectedDiscussionSessionId: deleted.discussionSessionId!,
        expectedRevision: deleted.linkRevision
      }
    })
    expect(replacement.discussionSessionId).not.toBe(original.discussionSessionId)
    expect(sessions.get(identity.sourceSessionId)).toEqual(sourceSession())
  })

  it('does not resurrect a pending Discussion deliberately deleted after an interrupted create', async () => {
    save.mockRejectedValueOnce(new Error('interrupted'))
    await expect(service.ensureDiscussion(identity)).rejects.toThrow('interrupted')
    const pending = await service.get(identity)
    await repository.sessionsDeleted([pending.discussionSessionId!])
    expect((await service.get(identity)).discussionStatus).toBe('missing')
    await expect(makeService().ensureDiscussion(identity)).rejects.toThrow('deleted')
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('keeps Discussion history when its source disappears, and forbids creating from unreadable or ordinary Sessions', async () => {
    const linked = await service.ensureDiscussion(identity)
    sessions.delete(identity.sourceSessionId)
    expect(await service.get(identity)).toMatchObject({
      sourceStatus: 'missing',
      discussionStatus: 'available',
      discussionSessionId: linked.discussionSessionId
    })
    expect((await service.ensureDiscussion(identity)).discussionSessionId).toBe(
      linked.discussionSessionId
    )
    sessions.set(identity.sourceSessionId, { ...sourceSession(), packageOrigin: undefined })
    expect((await service.get(identity)).sourceStatus).toBe('not-imported')
    expect((await service.ensureDiscussion(identity)).discussionSessionId).toBe(
      linked.discussionSessionId
    )
    unreadable.add(identity.sourceSessionId)
    expect((await service.get(identity)).sourceStatus).toBe('unreadable')
    expect(sessions.has(linked.discussionSessionId!)).toBe(true)
  })

  it('does not create new Discussions from unavailable sources', async () => {
    unreadable.add(identity.sourceSessionId)
    await expect(service.ensureDiscussion(identity)).rejects.toThrow('unavailable')
    unreadable.clear()
    sessions.set(identity.sourceSessionId, { ...sourceSession(), packageOrigin: undefined })
    await expect(service.ensureDiscussion(identity)).rejects.toThrow('unavailable')
    sessions.set(identity.sourceSessionId, { ...sourceSession(), archivedAt: 5 })
    await expect(service.ensureDiscussion(identity)).rejects.toThrow('archived')
    expect(save).not.toHaveBeenCalled()
  })

  it('preserves writable Discussion admission when only its source is archived', async () => {
    const linked = await service.ensureDiscussion(identity)
    sessions.get(identity.sourceSessionId)!.archivedAt = 5
    const reopened = await service.ensureDiscussion(identity)
    expect(reopened).toMatchObject({
      sourceStatus: 'archived',
      discussionStatus: 'available',
      discussionSessionId: linked.discussionSessionId
    })
    expect(save).toHaveBeenCalledTimes(1)
  })

  it.each(['intent', 'tombstone'] as const)(
    'never resurrects missing JSON while a durable deletion %s exists',
    async (kind) => {
      save.mockRejectedValueOnce(new Error('interrupted'))
      await expect(service.ensureDiscussion(identity)).rejects.toThrow('interrupted')
      const pending = await service.get(identity)
      if (kind === 'intent') {
        await client.pendingSessionReconciliation.create({
          data: {
            projectId: identity.projectId,
            sessionId: pending.discussionSessionId!,
            operation: 'delete'
          }
        })
      } else {
        await client.session.create({
          data: {
            id: pending.discussionSessionId!,
            number: 1,
            projectId: identity.projectId,
            title: 'Deleted',
            status: 'idle',
            presentedStatus: 'idle',
            createdAtMs: 1n,
            updatedAtMs: 1n,
            deletedAtMs: 2n
          }
        })
      }
      expect((await makeService().get(identity)).discussionStatus).toBe('missing')
      await expect(makeService().ensureDiscussion(identity)).rejects.toThrow('deleted')
      expect(save).toHaveBeenCalledTimes(1)
    }
  )

  it('isolates different sources and rejects simultaneous stale playback writers', async () => {
    const other = { ...identity, sourceSessionId: 'import-other' }
    sessions.set(other.sourceSessionId, { ...sourceSession(), id: other.sourceSessionId })
    const [first, second] = await Promise.all([
      service.ensureDiscussion(identity),
      service.ensureDiscussion(other)
    ])
    expect(first.discussionSessionId).not.toBe(second.discussionSessionId)
    const writes = await Promise.all([
      service.saveView({ ...identity, state: view, expectedRevision: 0 }),
      service.saveView({ ...identity, state: { ...view, timeMs: 5000 }, expectedRevision: 0 })
    ])
    expect(writes.filter((result) => result.status === 'saved')).toHaveLength(1)
    expect(writes.filter((result) => result.status === 'conflict')).toHaveLength(1)
    expect((await service.get(other)).view).toBeUndefined()
  })

  it('reports archived identities without unlocking them', async () => {
    const linked = await service.ensureDiscussion(identity)
    sessions.get(linked.discussionSessionId!)!.archivedAt = 5
    expect((await service.get(identity)).discussionStatus).toBe('archived')
    await expect(service.ensureDiscussion(identity)).rejects.toThrow('archived')
    sessions.get(identity.sourceSessionId)!.archivedAt = 6
    expect((await service.get(identity)).sourceStatus).toBe('archived')
    expect(await service.saveView({ ...identity, state: view, expectedRevision: 0 })).toEqual({
      status: 'saved',
      revision: 1
    })
  })

  it('uses compare-and-set checkpoints so stale windows cannot overwrite a newer position', async () => {
    const first = await service.saveView({ ...identity, state: view, expectedRevision: 0 })
    const stale = await service.saveView({
      ...identity,
      state: { ...view, timeMs: 5000 },
      expectedRevision: 0
    })
    expect(first).toEqual({ status: 'saved', revision: 1 })
    expect(stale).toEqual({ status: 'conflict', snapshot: { state: view, revision: 1 } })
    expect(
      await service.saveView({ ...identity, state: { ...view, timeMs: 2000 }, expectedRevision: 1 })
    ).toEqual({ status: 'saved', revision: 2 })
    await expect(
      service.saveView({ ...identity, state: { ...view, timeMs: Infinity }, expectedRevision: 2 })
    ).rejects.toThrow()
  })

  it('lists metadata without loading transcripts and survives Session projection deletion', async () => {
    const linked = await service.ensureDiscussion(identity)
    const readCalls = vi.mocked(reads).mock.calls.length
    const list = await service.list({ projectId: identity.projectId })
    expect(list).toHaveLength(1)
    expect(list[0]).not.toHaveProperty('discussionSession')
    expect(vi.mocked(reads).mock.calls.length).toBe(readCalls)
    await client.session.deleteMany()
    expect(await repository.get(identity)).toMatchObject({
      discussionSessionId: linked.discussionSessionId
    })
    expect((await service.get(identity)).discussionStatus).toBe('available')
    await client.project.delete({ where: { id: identity.projectId } })
    expect(await client.researchWorkspace.count()).toBe(0)
    expect(sessions.has(linked.discussionSessionId!)).toBe(true)
  })
})
