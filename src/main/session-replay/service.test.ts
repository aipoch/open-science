import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { SessionReadingBinding } from '../../shared/session-reading'
import type { ReplayViewState, SessionDiscussionSnapshot } from '../../shared/session-replay'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { SessionReplayRepository } from './repository'
import { SessionReplayService, type SessionReplaySessions } from './service'

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
const discussionSnapshot = (): SessionDiscussionSnapshot => ({
  ...identity,
  id: 'selection-snapshot',
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
  let repository: SessionReplayRepository
  let service: SessionReplayService
  let sessions: Map<string, PersistedChatSession>
  let reads: SessionReplaySessions['read']
  let list: ReturnType<typeof vi.fn<SessionReplaySessions['list']>>
  let readCurrent: ReturnType<typeof vi.fn<SessionReplaySessions['readCurrent']>>
  let save: ReturnType<typeof vi.fn>
  let unreadable: Set<string>
  const makeService = (): SessionReplayService =>
    new SessionReplayService(repository, { read: reads, list, readCurrent })

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'session-replay-'))
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
    list = vi.fn(async () =>
      [...sessions.values()].map(
        ({ id, projectId, updatedAt, researchMembership, archivedAt, packageOrigin }) => ({
          id,
          projectId,
          updatedAt,
          researchMembership,
          archivedAt,
          importedResearch: packageOrigin ? { importId: packageOrigin.importId } : undefined
        })
      )
    )
    readCurrent = vi.fn(async (_projectId, sessionId) =>
      unreadable.has(sessionId) ? undefined : structuredClone(sessions.get(sessionId))
    )
    save = vi.fn(async (session: PersistedChatSession) => {
      const saved = { ...structuredClone(session), revision: 1 }
      sessions.set(session.id, saved)
      return saved
    })
    repository = new SessionReplayRepository(async () => client)
    service = makeService()
  })
  afterEach(async () => {
    await client?.$disconnect()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  const binding = (sourceSessionId = identity.sourceSessionId): SessionReadingBinding => ({
    projectId: identity.projectId,
    sessionId: sourceSessionId,
    contextId: 'selection-snapshot',
    title: 'Original research',
    scope: 'session',
    branchId: 'main',
    promptMessageId: 'question'
  })
  const addDiscussion = (id: string, updatedAt: number): PersistedChatSession => {
    const session: PersistedChatSession = {
      ...sourceSession(),
      id,
      updatedAt,
      packageOrigin: undefined,
      researchMembership: {
        sourceProjectId: identity.projectId,
        sourceSessionId: identity.sourceSessionId,
        sourceImportId: 'original',
        sourceTitle: 'Original research'
      },
      runtimeContext: {
        version: 1,
        revision: 1,
        sessionContext: { version: 1, bindings: [binding()] }
      }
    }
    sessions.set(id, session)
    return session
  }

  it('restores the most recent linked discussion after restart without changing either Session', async () => {
    addDiscussion('older-discussion', 2)
    addDiscussion('newer-discussion', 5)
    const before = structuredClone(sessions)
    expect(await makeService().findDiscussion(identity)).toEqual({ sessionId: 'newer-discussion' })
    expect(readCurrent).toHaveBeenCalledTimes(1)
    expect(readCurrent).toHaveBeenCalledWith(identity.projectId, 'newer-discussion')
    expect(sessions).toEqual(before)
    expect(save).not.toHaveBeenCalled()
    expect(await client.sessionReplayProgress.count()).toBe(0)
    expect(await client.sessionDiscussionSnapshot.count()).toBe(0)
  })

  it('skips other projects, imported and archived receivers, missing and unreadable records', async () => {
    addDiscussion('discussion', 2)
    addDiscussion('other-project', 10).projectId = 'other'
    addDiscussion('imported', 9).packageOrigin = sourceSession().packageOrigin
    addDiscussion('archived', 8).archivedAt = 8
    addDiscussion('unreadable', 7)
    unreadable.add('unreadable')
    const missing = addDiscussion('missing', 6)
    const rows = await list()
    sessions.delete(missing.id)
    list.mockResolvedValue(rows)
    expect(await service.findDiscussion(identity)).toEqual({ sessionId: 'discussion' })
    expect(readCurrent).not.toHaveBeenCalledWith(identity.projectId, identity.sourceSessionId)
    expect(readCurrent).not.toHaveBeenCalledWith(identity.projectId, 'other-project')
  })

  it('keeps explicit membership when reading focus is removed or switched, and revalidates stale membership', async () => {
    const linked = addDiscussion('discussion', 5)
    linked.runtimeContext = {
      version: 1,
      revision: 2,
      sessionContext: { version: 1, bindings: [] }
    }
    expect(await service.findDiscussion(identity)).toEqual({ sessionId: linked.id })
    linked.runtimeContext.sessionContext!.bindings = [binding('other-source')]
    expect(await service.findDiscussion(identity)).toEqual({ sessionId: linked.id })
    const stale = await list()
    list.mockResolvedValue(stale)
    linked.researchMembership = undefined
    expect(await service.findDiscussion(identity)).toBeNull()
  })

  it('never scans ordinary sessions or infers membership from legacy reading links', async () => {
    for (let index = 0; index < 100; index += 1)
      addDiscussion(`ordinary-${index}`, index).researchMembership = undefined
    expect(await service.findDiscussion(identity)).toBeNull()
    expect(readCurrent).not.toHaveBeenCalled()
  })

  it('distinguishes repeated imports and rejects sources replaced while opening a candidate', async () => {
    const discussion = addDiscussion('discussion', 3)
    discussion.researchMembership!.sourceImportId = 'other-import'
    expect(await service.findDiscussion(identity)).toBeNull()
    discussion.researchMembership!.sourceImportId = 'original'
    readCurrent.mockImplementation(async () => {
      sessions.get(identity.sourceSessionId)!.packageOrigin!.importId = 'replacement'
      return discussion
    })
    expect(await service.findDiscussion(identity)).toBeNull()
  })

  it.each(['missing', 'unreadable', 'archived', 'deleted-project', 'archived-project'])(
    'does not restore a discussion when its source is %s',
    async (state) => {
      addDiscussion('discussion', 2)
      if (state === 'missing') sessions.delete(identity.sourceSessionId)
      if (state === 'unreadable') unreadable.add(identity.sourceSessionId)
      if (state === 'archived') sessions.get(identity.sourceSessionId)!.archivedAt = 2
      if (state === 'deleted-project' || state === 'archived-project') {
        await client.project.update({
          where: { id: identity.projectId },
          data: state === 'deleted-project' ? { deletedAt: new Date() } : { archivedAt: new Date() }
        })
      }
      expect(await service.findDiscussion(identity)).toBeNull()
      expect(list).not.toHaveBeenCalled()
      expect(readCurrent).not.toHaveBeenCalled()
    }
  )

  it('returns no match without fabricating a Session when no durable discussion exists', async () => {
    expect(await service.findDiscussion(identity)).toBeNull()
    expect(save).not.toHaveBeenCalled()
    expect(readCurrent).not.toHaveBeenCalled()
  })

  it('routes explicit grouping through the Main owner and refuses archived projects before mutation', async () => {
    const discussion = addDiscussion('discussion', 2)
    const setResearchMembership = vi.fn(async () => discussion)
    const mutate = new SessionReplayService(repository, {
      read: reads,
      list,
      readCurrent,
      setResearchMembership
    })
    const request = { projectId: identity.projectId, sessionId: discussion.id, expectedRevision: 0 }
    expect(await mutate.setResearchMembership(request)).toEqual(discussion)
    expect(setResearchMembership).toHaveBeenCalledWith(request)
    setResearchMembership.mockClear()
    await client.project.update({
      where: { id: identity.projectId },
      data: { archivedAt: new Date() }
    })
    await expect(mutate.setResearchMembership(request)).rejects.toThrow('Project is unavailable')
    expect(setResearchMembership).not.toHaveBeenCalled()
  })

  it('browses and saves playback checkpoints without creating or mutating any Session', async () => {
    const before = structuredClone(sessions.get(identity.sourceSessionId))
    expect(await service.get(identity)).toMatchObject({
      sourceStatus: 'available'
    })
    expect(await client.sessionReplayProgress.count()).toBe(0)
    expect(await service.saveView({ ...identity, state: view, expectedRevision: 0 })).toEqual({
      status: 'saved',
      revision: 1
    })
    expect(await service.get(identity)).toMatchObject({
      view: { state: view, revision: 1 }
    })
    expect(save).not.toHaveBeenCalled()
    expect(sessions.get(identity.sourceSessionId)).toEqual(before)
  })

  it.each(['idle', 'running'] as const)(
    'supports ordinary %s Sessions without changing source data',
    async (status) => {
      const source = sourceSession()
      delete source.packageOrigin
      source.status = status
      sessions.set(source.id, source)
      const before = structuredClone(source)
      expect((await service.get(identity)).sourceStatus).toBe('available')
      expect(
        await service.saveView({ ...identity, state: view, expectedRevision: 0 })
      ).toMatchObject({ status: 'saved' })
      const context = { ...discussionSnapshot(), scope: 'session' as const }
      await service.saveSelectionSnapshot({ ...identity, context })
      expect(
        await service.getSelectionSnapshot({ projectId: identity.projectId, id: context.id })
      ).toEqual(context)
      expect(sessions.get(source.id)).toEqual(before)
    }
  )

  it('round-trips inspected run output captured after its original step without changing snapshot rules', async () => {
    const context = {
      ...discussionSnapshot(),
      stepOffsetMs: 50000,
      recordedAt: 55000,
      phase: 'result' as const,
      evidence: [{ ...discussionSnapshot().evidence[0], part: 'record' as const }],
      records: [
        {
          id: 'notebook-run:run-1',
          scope: 'step' as const,
          title: 'Saved run',
          text: 'EXACT SAVED OUTPUT',
          status: 'recorded' as const,
          truncated: false
        }
      ]
    }
    await service.saveSelectionSnapshot({ ...identity, context })
    expect(
      await service.getSelectionSnapshot({ projectId: identity.projectId, id: context.id })
    ).toEqual(context)
  })

  it('admits local replay writes before reading or writing any data-root-owned state', async () => {
    const gated = new SessionReplayService(
      repository,
      { read: reads, list, readCurrent, setResearchMembership: vi.fn() },
      async () => {
        throw new Error('Data root changing')
      }
    )
    await expect(
      gated.setResearchMembership({
        projectId: identity.projectId,
        sessionId: 'discussion',
        expectedRevision: 0
      })
    ).rejects.toThrow('Data root changing')
    await expect(gated.saveView({ ...identity, state: view, expectedRevision: 0 })).rejects.toThrow(
      'Data root changing'
    )
    await expect(
      gated.saveSelectionSnapshot({ ...identity, context: discussionSnapshot() })
    ).rejects.toThrow('Data root changing')
    expect(reads).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    expect(await client.sessionReplayProgress.count()).toBe(0)
    expect(await client.sessionDiscussionSnapshot.count()).toBe(0)
  })

  it('saves immutable bounded question references idempotently without creating a Discussion', async () => {
    const context = discussionSnapshot()
    await Promise.all([
      service.saveSelectionSnapshot({ ...identity, context }),
      service.saveSelectionSnapshot({ ...identity, context })
    ])
    expect(
      await service.getSelectionSnapshot({ projectId: identity.projectId, id: context.id })
    ).toEqual(context)
    expect(await service.listSelectionSnapshots(identity)).toEqual([context])
    expect(await client.sessionDiscussionSnapshot.count()).toBe(1)
    expect(await client.sessionReplayProgress.count()).toBe(0)
    expect(save).not.toHaveBeenCalled()
    await expect(
      service.saveSelectionSnapshot({ ...identity, context: { ...context, excerpt: 'Changed' } })
    ).rejects.toThrow('different context')
    expect(
      (await service.getSelectionSnapshot({ projectId: identity.projectId, id: context.id }))
        ?.excerpt
    ).toBe(context.excerpt)
  })

  it('retains question references after source deletion, scopes reads to the Project and cleans up with it', async () => {
    const context = discussionSnapshot()
    await service.saveSelectionSnapshot({ ...identity, context })
    sessions.delete(identity.sourceSessionId)
    await service.saveSelectionSnapshot({ ...identity, context })
    expect(
      await makeService().getSelectionSnapshot({ projectId: identity.projectId, id: context.id })
    ).toEqual(context)
    expect(
      await service.getSelectionSnapshot({ projectId: 'other', id: context.id })
    ).toBeUndefined()
    expect(await service.listSelectionSnapshots({ ...identity, sourceSessionId: 'other' })).toEqual(
      []
    )
    await expect(
      service.saveSelectionSnapshot({ ...identity, context: { ...context, id: 'new-context' } })
    ).rejects.toThrow('cannot be read')
    await client.project.delete({ where: { id: identity.projectId } })
    expect(await client.sessionDiscussionSnapshot.count()).toBe(0)
  })

  it('rejects question context rewrites across Projects and new references for deleted Projects', async () => {
    const context = discussionSnapshot()
    await service.saveSelectionSnapshot({ ...identity, context })
    await client.project.create({ data: { id: 'other', name: 'Other' } })
    await expect(
      repository.saveSelectionSnapshot({ ...context, projectId: 'other', evidence: [] })
    ).rejects.toThrow('different context')
    await client.project.update({
      where: { id: identity.projectId },
      data: { deletedAt: new Date() }
    })
    expect(
      await service.getSelectionSnapshot({ projectId: identity.projectId, id: context.id })
    ).toBeUndefined()
    expect(await service.listSelectionSnapshots(identity)).toEqual([])
    await expect(service.saveSelectionSnapshot({ ...identity, context })).rejects.toThrow(
      'unavailable'
    )
  })

  it('isolates different sources and rejects simultaneous stale playback writers', async () => {
    const other = { ...identity, sourceSessionId: 'import-other' }
    sessions.set(other.sourceSessionId, { ...sourceSession(), id: other.sourceSessionId })
    const writes = await Promise.all([
      service.saveView({ ...identity, state: view, expectedRevision: 0 }),
      service.saveView({ ...identity, state: { ...view, timeMs: 5000 }, expectedRevision: 0 })
    ])
    expect(writes.filter((result) => result.status === 'saved')).toHaveLength(1)
    expect(writes.filter((result) => result.status === 'conflict')).toHaveLength(1)
    expect((await service.get(other)).view).toBeUndefined()
  })

  it('reports archived identities without unlocking them', async () => {
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
})
