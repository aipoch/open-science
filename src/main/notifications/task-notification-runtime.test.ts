import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import type { SessionDeletionHandlers } from '../session-persistence/coordinator'
import { createUnreadTaskController } from './unread-task-controller'
import { UnreadTaskDbRepository } from './unread-task-repository'
import { bindUnreadTaskDeletionRuntime } from './task-notification-runtime'

let storageRoot: string | undefined
let client: PrismaClient | undefined

afterEach(async () => {
  await client?.$disconnect()
  client = undefined

  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('bindUnreadTaskDeletionRuntime', () => {
  it('connects SQLite unread state to durable Session deletion cleanup', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-task-notification-runtime-'))
    client = createProjectDbClient(storageRoot)
    await ensureProjectSchema(client)

    const repository = new UnreadTaskDbRepository(() => Promise.resolve(client!))
    await repository.save(['deleted-headless-session'])
    const badgeCounts: number[] = []
    const unreadController = createUnreadTaskController({
      headless: false,
      isAppFocused: () => false,
      repository,
      badge: { setCount: (count) => badgeCounts.push(count) }
    })
    let deletionHandlers: SessionDeletionHandlers | undefined

    bindUnreadTaskDeletionRuntime({
      headless: false,
      unreadController,
      unreadTaskRepository: repository,
      sessionPersistenceCoordinator: {
        setSessionDeletionHandlers: (handlers) => {
          deletionHandlers = handlers
        }
      }
    })
    await unreadController.restore()
    await unreadController.markUnread('session-1')

    await expect(repository.load()).resolves.toEqual(['deleted-headless-session', 'session-1'])
    expect(badgeCounts.at(-1)).toBe(2)

    await deletionHandlers?.reconcile(['session-1'])
    await expect(repository.load()).resolves.toEqual(['session-1'])
    expect(badgeCounts.at(-1)).toBe(1)

    await deletionHandlers?.commit(['session-1'])

    await expect(repository.load()).resolves.toEqual([])
    expect(badgeCounts.at(-1)).toBe(0)
  })

  it('does not bind SQLite deletion work in a headless process', () => {
    const setSessionDeletionHandlers = vi.fn()
    const noOp = vi.fn(async () => undefined)

    bindUnreadTaskDeletionRuntime({
      headless: true,
      unreadController: {
        removeUnreadSessions: noOp
      },
      unreadTaskRepository: {
        reconcileSessionCatalog: vi.fn(async () => [])
      },
      sessionPersistenceCoordinator: { setSessionDeletionHandlers }
    })

    expect(setSessionDeletionHandlers).not.toHaveBeenCalled()
  })
})
