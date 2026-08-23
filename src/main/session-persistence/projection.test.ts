import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true }
}))

import type { PersistedChatSession } from '../../shared/session-persistence'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ProjectRepository } from '../projects/repository'
import { buildSessionProjection, SessionProjectionRepository } from './projection'
import { SessionRepository } from './repository'
import type { SessionLoadDiagnostic } from './repository'

const createDeferred = <Value>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
} => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

const session = (id: string, createdAt = 100): PersistedChatSession => ({
  id,
  projectId: 'project-1',
  title: `Session ${id}`,
  cwd: '/workspace',
  status: 'idle',
  messages: [
    {
      id: `${id}-run`,
      role: 'user',
      content: 'Run',
      status: 'complete',
      eventIds: [],
      artifactIds: [`${id}-artifact`],
      createdAt: createdAt + 1,
      updatedAt: createdAt + 1
    },
    {
      id: `${id}-usage`,
      role: 'agent',
      content: 'Done',
      status: 'complete',
      eventIds: [],
      turnUsage: { inputTokens: 10, cacheTokens: 4, outputTokens: 3 },
      createdAt: createdAt + 2,
      updatedAt: createdAt + 3,
      completedAt: createdAt + 4
    }
  ],
  artifacts: [
    {
      id: `${id}-artifact`,
      kind: 'managed-file',
      path: `${id}.md`
    }
  ],
  createdAt,
  updatedAt: createdAt + 5
})

describe('Session projection', () => {
  let client: PrismaClient | undefined
  let storageRoot: string | undefined

  afterEach(async () => {
    await client?.$disconnect()
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
    client = undefined
    storageRoot = undefined
  })

  it('preserves retained turn, run, and artifact timestamp semantics', () => {
    const projected = buildSessionProjection(session('session-1'))

    expect(projected.summary).toMatchObject({
      activeMessageCount: 2,
      artifactCount: 1,
      presentedStatus: 'idle'
    })
    expect(projected.runs).toEqual([{ messageId: 'session-1-run', createdAtMs: 101n }])
    expect(projected.turnUsage).toEqual([
      {
        messageId: 'session-1-usage',
        completedAtMs: 104n,
        inputTokens: 10n,
        cacheTokens: 4n,
        outputTokens: 3n,
        isRootFrame: true
      }
    ])
    expect(projected.artifactRefs).toEqual([
      { artifactId: 'session-1-artifact', artifactCreatedAtMs: 101n }
    ])
  })

  it('allocates a global number and serves summaries and usage without Session JSON', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-projection-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({
      data: { id: 'project-1', name: 'Project', createdAt: new Date(50) }
    })
    const repository = new SessionProjectionRepository(async () => client!)

    const first = await repository.prepareSave(session('session-1', 100))
    const second = await repository.prepareSave(session('session-2', 200))
    expect([first.number, second.number]).toEqual([1, 2])

    await repository.commitSave(first)
    await repository.commitSave(second)
    await repository.replaceAll([first, second])

    await expect(repository.isReady()).resolves.toBe(true)
    await expect(repository.list()).resolves.toMatchObject([
      { id: 'session-2', number: 2, activeMessageCount: 2 },
      { id: 'session-1', number: 1, activeMessageCount: 2 }
    ])
    await expect(repository.usage()).resolves.toMatchObject({
      projectCreatedAt: [50],
      sessionCreatedAt: expect.arrayContaining([100, 200]),
      runsAt: expect.arrayContaining([101, 201]),
      totalArtifacts: 2,
      usageEvents: expect.arrayContaining([
        expect.objectContaining({ timestamp: 104, inputTokens: 10, rootRunUsage: true })
      ])
    })

    const bulk = Array.from({ length: 75 }, (_, index) => ({
      ...session(`bulk-${index}`, 1_000 + index),
      number: index + 1
    }))
    await repository.replaceAll(bulk)
    await expect(client.session.count()).resolves.toBe(75)
    await expect(client.sessionTurnUsage.count()).resolves.toBe(75)
  })

  it('keeps a deleted metadata tombstone, excludes its facts, and never reuses its number', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-number-sequence-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({
      data: { id: 'project-1', name: 'Project', createdAt: new Date(50) }
    })
    const repository = new SessionProjectionRepository(async () => client!)

    const first = await repository.prepareSave(session('session-1'))
    await repository.commitSave(first)
    await repository.commitDelete(first.projectId, first.id)

    await expect(repository.list()).resolves.toEqual([])
    await expect(repository.usage()).resolves.toMatchObject({
      projectCreatedAt: [50],
      sessionCreatedAt: [],
      runsAt: [],
      usageEvents: [],
      totalArtifacts: 0
    })
    await expect(client.session.findUnique({ where: { id: first.id } })).resolves.toMatchObject({
      id: first.id,
      number: 1,
      title: first.title,
      deletedAtMs: expect.any(BigInt)
    })
    await expect(client.sessionTurnUsage.count({ where: { sessionId: first.id } })).resolves.toBe(0)
    await expect(client.sessionRun.count({ where: { sessionId: first.id } })).resolves.toBe(0)
    await expect(client.sessionArtifactRef.count({ where: { sessionId: first.id } })).resolves.toBe(
      0
    )
    await expect(repository.prepareSave({ ...first, title: 'Resurrected' })).rejects.toThrow(
      'deleted Session'
    )
    await expect(repository.commitSave({ ...first, title: 'Resurrected' })).rejects.toThrow(
      'deleted Session'
    )
    await repository.markPending(first.projectId, first.id)
    await expect(repository.commitReconciliation(first)).resolves.toBeUndefined()
    await expect(repository.pending()).resolves.toEqual([])
    const second = await repository.prepareSave(session('session-2'))
    expect(second.number).toBe(2)
    const primaryKey = await client.$queryRaw<Array<{ name: string; pk: bigint }>>`
      PRAGMA table_info("Session")
    `
    expect(primaryKey.find(({ pk }) => Number(pk) === 1)?.name).toBe('id')
    await expect(
      client.sessionNumberSequence.findUnique({ where: { id: 'global' } })
    ).resolves.toMatchObject({ nextNumber: 3 })

    await repository.replaceAll([first, { ...second, number: 2 }])
    await expect(client.session.findUnique({ where: { id: first.id } })).resolves.toMatchObject({
      id: first.id,
      deletedAtMs: expect.any(BigInt)
    })
  })

  it('refuses to tombstone a Session through another Project identity', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-delete-ownership-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.createMany({
      data: [
        { id: 'project-1', name: 'First Project', createdAt: new Date(50) },
        { id: 'project-2', name: 'Second Project', createdAt: new Date(60) }
      ]
    })
    const repository = new SessionProjectionRepository(async () => client!)
    const owned = await repository.prepareSave({
      ...session('session-1'),
      projectId: 'project-2'
    })
    await repository.commitSave(owned)

    await expect(repository.commitDelete('project-1', owned.id)).rejects.toThrow('another Project')
    await expect(client.session.findUnique({ where: { id: owned.id } })).resolves.toMatchObject({
      projectId: 'project-2',
      deletedAtMs: null
    })
    await expect(client.sessionTurnUsage.count({ where: { sessionId: owned.id } })).resolves.toBe(1)
    await expect(client.sessionRun.count({ where: { sessionId: owned.id } })).resolves.toBe(1)
    await expect(client.sessionArtifactRef.count({ where: { sessionId: owned.id } })).resolves.toBe(
      1
    )
  })

  it('retains Project metadata and Session Usage when the whole Project is deleted', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-project-usage-history-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({
      data: { id: 'project-1', name: 'Project', createdAt: new Date(50) }
    })
    const sessions = new SessionProjectionRepository(async () => client!)
    const saved = await sessions.prepareSave(session('session-1'))
    await sessions.commitSave(saved)

    await new ProjectRepository(async () => client!).delete('project-1')

    await expect(client.project.findUnique({ where: { id: 'project-1' } })).resolves.toMatchObject({
      id: 'project-1',
      name: 'Project',
      deletedAt: expect.any(Date)
    })
    await expect(sessions.list()).resolves.toEqual([])
    await expect(sessions.usage()).resolves.toMatchObject({
      projectCreatedAt: [50],
      sessionCreatedAt: [100],
      runsAt: [101],
      totalArtifacts: 1,
      usageEvents: [expect.objectContaining({ inputTokens: 10 })]
    })

    await sessions.clearForRebuild()
    await expect(client.session.findUnique({ where: { id: saved.id } })).resolves.toMatchObject({
      id: saved.id,
      deletedAtMs: null
    })
    await expect(sessions.usage()).resolves.toMatchObject({ totalArtifacts: 1 })
    await expect(sessions.prepareSave(session('late-session'))).rejects.toThrow('deleted Project')
    await expect(client.project.delete({ where: { id: 'project-1' } })).rejects.toThrow()
  })

  it('reconciles pending Usage from a committed Project tombstone before removing it', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-project-pending-history-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({
      data: { id: 'project-1', name: 'Project', createdAt: new Date(50) }
    })
    const files = new SessionRepository(storageRoot)
    await files.saveSession(session('session-1'))
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    await repository.ensureSessionProjection(() => files.loadAll())
    const loaded = (await repository.loadSession('project-1', 'session-1'))!
    const updated = { ...session('session-1'), number: loaded.number, revision: loaded.revision }
    updated.messages[1].turnUsage = { inputTokens: 99, cacheTokens: 8, outputTokens: 7 }

    await projection.markPending('project-1', 'session-1')
    await files.saveSession(updated)
    await files.deleteProjectSessions('project-1')
    await new ProjectRepository(async () => client!).delete('project-1')
    await repository.reconcilePendingSessionProjection()

    await expect(projection.pending()).resolves.toEqual([])
    await expect(projection.usage()).resolves.toMatchObject({
      projectCreatedAt: [50],
      sessionCreatedAt: [100],
      usageEvents: [expect.objectContaining({ inputTokens: 99 })]
    })
    await files.completeProjectSessionDeletion('project-1')
    await expect(projection.usage()).resolves.toMatchObject({
      usageEvents: [expect.objectContaining({ inputTokens: 99 })]
    })
  })

  it('serializes pending replay ahead of a concurrent newer Session save', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-pending-race-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    await repository.saveSession(session('session-1'))
    await repository.ensureSessionProjection(() => repository.loadAll())
    const stale = (await repository.loadSession('project-1', 'session-1'))!
    await projection.markPending('project-1', 'session-1')
    const authorityRead = createDeferred<SessionLoadDiagnostic>()
    const read = vi
      .spyOn(repository, 'loadSessionWithDiagnostics')
      .mockReturnValueOnce(authorityRead.promise)

    const reconciling = repository.reconcilePendingSessionProjection()
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    let newerSaveCompleted = false
    const savingNewer = repository
      .saveSession({ ...stale, title: 'Newer concurrent title' })
      .then((saved) => {
        newerSaveCompleted = true
        return saved
      })
    await Promise.resolve()
    expect(newerSaveCompleted).toBe(false)

    authorityRead.resolve({ status: 'found', session: stale })
    await reconciling
    await savingNewer

    await expect(repository.loadSession('project-1', 'session-1')).resolves.toMatchObject({
      title: 'Newer concurrent title'
    })
  })

  it('resumes an individually deleted Session after a crash before JSON removal', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-delete-intent-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    await repository.saveSession(session('session-1'))
    await repository.ensureSessionProjection(() => repository.loadAll())

    // The durable delete intent is committed before deleteSession removes JSON. Simulate a crash in
    // that cross-store window, then verify startup resumes the delete instead of replaying a save.
    await projection.markPending('project-1', 'session-1', 'delete')
    await repository.reconcilePendingSessionProjection()

    await expect(repository.loadSession('project-1', 'session-1')).resolves.toBeUndefined()
    await expect(client.session.findUnique({ where: { id: 'session-1' } })).resolves.toMatchObject({
      id: 'session-1',
      deletedAtMs: expect.anything()
    })
    await expect(projection.usage()).resolves.toMatchObject({
      sessionCreatedAt: [],
      usageEvents: []
    })
  })

  it('backfills historical JSON numbers by creation time before normal autoincrement', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-backfill-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const files = new SessionRepository(storageRoot)
    await files.saveSession(session('newer', 200))
    await files.saveSession(session('older', 100))

    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    const initialized = await repository.ensureSessionProjection(() => files.loadAll())

    expect(initialized.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'older', number: 1 }),
        expect.objectContaining({ id: 'newer', number: 2 })
      ])
    )
    await expect(repository.loadSession('project-1', 'older')).resolves.toMatchObject({ number: 1 })
    await expect(repository.loadSession('project-1', 'newer')).resolves.toMatchObject({ number: 2 })

    await expect(repository.saveSession(session('latest', 300))).resolves.toMatchObject({
      number: 3
    })
  })

  it('publishes a fresh authority scan when a Session save overlaps initial backfill', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-backfill-race-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const files = new SessionRepository(storageRoot)
    await files.saveSession(session('older', 100))
    const stale = await files.loadAll()

    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    let markAuthorityStarted!: () => void
    const authorityStarted = new Promise<void>((resolve) => {
      markAuthorityStarted = resolve
    })
    let releaseAuthority!: () => void
    const authorityReleased = new Promise<void>((resolve) => {
      releaseAuthority = resolve
    })
    const loadAuthority = vi.fn(async () => {
      markAuthorityStarted()
      await authorityReleased
      return stale
    })

    const first = repository.ensureSessionProjection(loadAuthority)
    const second = repository.ensureSessionProjection(loadAuthority)
    await authorityStarted
    await repository.saveSession(session('concurrent', 200))
    releaseAuthority()

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(loadAuthority).toHaveBeenCalledOnce()
    expect(firstResult.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'older', number: 1 }),
        expect.objectContaining({ id: 'concurrent', number: 2 })
      ])
    )
    expect(secondResult.sessions).toEqual(firstResult.sessions)
    await expect(projection.isReady()).resolves.toBe(true)
  })
})
