import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { MAX_UNREAD_TASK_SESSIONS, UnreadTaskDbRepository } from './unread-task-repository'

let storageRoot: string | undefined
let client: PrismaClient | undefined

const createRepository = async (): Promise<UnreadTaskDbRepository> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-unread-task-'))
  client = createProjectDbClient(storageRoot)
  await ensureProjectSchema(client)

  return new UnreadTaskDbRepository(() => Promise.resolve(client!))
}

afterEach(async () => {
  await client?.$disconnect()
  client = undefined

  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('UnreadTaskDbRepository', () => {
  it('returns an empty list when no unread rows exist', async () => {
    const repository = await createRepository()

    await expect(repository.load()).resolves.toEqual([])
  })

  it('persists and restores a snapshot in insertion order', async () => {
    const repository = await createRepository()

    await repository.save(['session-1', 'session-2'])

    await expect(repository.load()).resolves.toEqual(['session-1', 'session-2'])
  })

  it('reconciles snapshots without replacing retained unread rows', async () => {
    const repository = await createRepository()
    await repository.save(['session-1', 'session-2'])
    const retainedBefore = await client!.unreadTaskSession.findUniqueOrThrow({
      where: { sessionId: 'session-2' }
    })

    await repository.save(['session-2', 'session-3'])

    const rows = await client!.unreadTaskSession.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((row) => row.sessionId)).toEqual(['session-2', 'session-3'])
    expect(rows[0].id).toBe(retainedBefore.id)
    expect(rows[1].id).toBeGreaterThan(rows[0].id)
  })

  it('serializes concurrent saves so the last requested snapshot wins', async () => {
    await createRepository()
    let releaseFirstProvider: (() => void) | undefined
    let reportFirstProviderStarted: (() => void) | undefined
    let providerCalls = 0
    const firstProviderStarted = new Promise<void>((resolve) => {
      reportFirstProviderStarted = resolve
    })
    const firstProviderGate = new Promise<void>((resolve) => {
      releaseFirstProvider = resolve
    })
    const repository = new UnreadTaskDbRepository(async () => {
      providerCalls += 1
      if (providerCalls === 1) {
        reportFirstProviderStarted?.()
        await firstProviderGate
      }
      return client!
    })

    const firstSave = repository.save(['session-1'])
    await firstProviderStarted
    const secondSave = repository.save(['session-2'])
    await Promise.resolve()
    releaseFirstProvider?.()
    await Promise.all([firstSave, secondSave])

    await expect(repository.load()).resolves.toEqual(['session-2'])
  })

  it('continues the save queue after a transaction fails', async () => {
    const repository = await createRepository()
    await client!.$executeRawUnsafe(`CREATE TRIGGER "block_unread_session"
      BEFORE INSERT ON "UnreadTaskSession"
      WHEN NEW."sessionId" = 'blocked'
      BEGIN
        SELECT RAISE(ABORT, 'blocked session');
      END;`)

    await expect(repository.save(['blocked'])).rejects.toThrow()
    await client!.$executeRawUnsafe('DROP TRIGGER "block_unread_session"')

    await repository.save(['session-after-failure'])

    await expect(repository.load()).resolves.toEqual(['session-after-failure'])
  })

  it('rolls back every snapshot difference when an insert fails', async () => {
    const repository = await createRepository()
    await repository.save(['session-before-failure'])
    await client!.$executeRawUnsafe(`CREATE TRIGGER "block_unread_session"
      BEFORE INSERT ON "UnreadTaskSession"
      WHEN NEW."sessionId" = 'blocked'
      BEGIN
        SELECT RAISE(ABORT, 'blocked session');
      END;`)

    await expect(repository.save(['session-added-first', 'blocked'])).rejects.toThrow()

    await expect(repository.load()).resolves.toEqual(['session-before-failure'])
  })

  it('deduplicates, drops blank IDs, and retains only the newest bounded entries', async () => {
    const repository = await createRepository()
    const values = Array.from(
      { length: MAX_UNREAD_TASK_SESSIONS + 2 },
      (_, index) => `session-${index}`
    )

    await repository.save(['', values[0], ...values, values.at(-1)!])

    const restored = await repository.load()
    expect(restored).toHaveLength(MAX_UNREAD_TASK_SESSIONS)
    expect(restored[0]).toBe('session-2')
    expect(restored.at(-1)).toBe(`session-${MAX_UNREAD_TASK_SESSIONS + 1}`)
    await expect(client!.unreadTaskSession.count()).resolves.toBe(MAX_UNREAD_TASK_SESSIONS)
  })

  it('clears every unread row for an empty snapshot', async () => {
    const repository = await createRepository()
    await repository.save(['session-1'])

    await repository.save([])

    await expect(repository.load()).resolves.toEqual([])
  })

  it('removes unread rows whose sessions disappeared from the authoritative catalog', async () => {
    const repository = await createRepository()
    await repository.save(['deleted-headless-session', 'active-session'])

    await expect(repository.reconcileSessionCatalog(['active-session'])).resolves.toEqual([
      'deleted-headless-session'
    ])

    await expect(repository.load()).resolves.toEqual(['active-session'])
  })
})
