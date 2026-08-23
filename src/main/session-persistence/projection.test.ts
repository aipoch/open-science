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
import { buildSessionProjection, SessionProjectionRepository } from './projection'
import { SessionRepository } from './repository'

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
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
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
