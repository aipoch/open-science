import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { migrateApplicationDatabase } from '../database/migration-service'
import { createProjectDbClient } from '../projects/prisma-client'
import { BookmarkRepository } from './repository'
import { SessionProjectionRepository } from '../session-persistence/projection'

describe('BookmarkRepository', () => {
  let root: string
  let client: PrismaClient

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'open-science-bookmarks-'))
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
  })

  afterEach(async () => {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  })

  it('persists a Bookmark across repository restarts and returns its session total', async () => {
    const target = {
      kind: 'text' as const,
      source: { kind: 'agent-message' as const, sessionId: 'session-1', messageId: 'message-1' },
      quote: 'Frozen source text'
    }
    const first = new BookmarkRepository(async () => client)

    await expect(
      first.create({
        id: 'bookmark-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        target,
        note: 'Read again'
      })
    ).resolves.toMatchObject({ id: 'bookmark-1', target, note: 'Read again' })

    const restarted = new BookmarkRepository(async () => client)
    await expect(
      restarted.list({ projectId: 'project-1', sessionId: 'session-1' })
    ).resolves.toEqual({
      items: [expect.objectContaining({ id: 'bookmark-1', target })],
      total: 1
    })
  })

  it('treats a semantically identical create ID retry as idempotent', async () => {
    const repository = new BookmarkRepository(async () => client)
    const first = {
      id: 'bookmark-retry',
      projectId: 'project-1',
      sessionId: 'session-1',
      target: {
        kind: 'text' as const,
        source: {
          kind: 'project-file' as const,
          projectId: 'project-1',
          path: '/project/notes.md',
          name: 'notes.md'
        },
        quote: 'Same source'
      },
      note: 'same note'
    }
    const created = await repository.create(first)
    const retry = {
      ...first,
      target: {
        ...first.target,
        source: {
          name: 'notes.md',
          path: '/project/notes.md',
          projectId: 'project-1',
          kind: 'project-file' as const
        }
      }
    }

    await expect(repository.create(retry)).resolves.toEqual(created)
    await expect(
      repository.list({ projectId: 'project-1', sessionId: 'session-1' })
    ).resolves.toMatchObject({
      total: 1
    })
    await expect(repository.create({ ...retry, note: 'changed' })).rejects.toThrow(
      'Bookmark identity already exists with different content.'
    )
  })

  it('treats omitted and explicit undefined optional fields as the same create retry', async () => {
    const repository = new BookmarkRepository(async () => client)
    const source = {
      kind: 'agent-message' as const,
      sessionId: 'session-1',
      messageId: 'message-1'
    }
    const created = await repository.create({
      id: 'bookmark-undefined-retry',
      projectId: 'project-1',
      sessionId: 'session-1',
      target: {
        kind: 'text',
        source,
        quote: 'Same source'
      },
      note: ''
    })

    await expect(
      repository.create({
        id: 'bookmark-undefined-retry',
        projectId: 'project-1',
        sessionId: 'session-1',
        target: { kind: 'text', source, quote: 'Same source', anchor: undefined },
        note: ''
      })
    ).resolves.toEqual(created)
  })

  it('keeps Bookmarks across Session projection rebuilds and cleans only committed authority loss', async () => {
    const repository = new BookmarkRepository(async () => client)
    const make = (id: string, sessionId: string): Parameters<BookmarkRepository['create']>[0] => ({
      id,
      projectId: 'project-1',
      sessionId,
      target: {
        kind: 'text' as const,
        source: { kind: 'agent-message' as const, sessionId, messageId: `${id}-message` },
        quote: `quote ${id}`
      },
      note: ''
    })
    await repository.create(make('bookmark-1', 'session-1'))
    await repository.create(make('bookmark-2', 'session-2'))

    // Session is a rebuildable projection and deliberately has no Bookmark foreign key.
    await client.session.deleteMany()
    await expect(
      repository.list({ projectId: 'project-1', sessionId: 'session-1' })
    ).resolves.toMatchObject({ total: 1 })

    // A failed/uncommitted authority deletion never invokes cleanup.
    await expect(
      repository.list({ projectId: 'project-1', sessionId: 'session-1' })
    ).resolves.toMatchObject({ total: 1 })
    await repository.deleteSessions(['session-1'])
    await expect(
      repository.list({ projectId: 'project-1', sessionId: 'session-1' })
    ).resolves.toMatchObject({ total: 0 })

    const projection = new SessionProjectionRepository(async () => client)
    await projection.replaceAll([])
    await projection.markPending('project-1', 'session-2', 'save')
    await projection.commitDelete('project-1', 'session-2')
    await expect(
      repository.list({ projectId: 'project-1', sessionId: 'session-2' })
    ).resolves.toMatchObject({ total: 1 })

    await projection.markPending('project-1', 'session-2', 'delete')
    await projection.commitDelete('project-1', 'session-2')
    await expect(
      repository.list({ projectId: 'project-1', sessionId: 'session-2' })
    ).resolves.toMatchObject({ total: 0 })
  })

  it('pages one Session by creation time and stable ID while retaining the full total', async () => {
    const repository = new BookmarkRepository(async () => client)
    for (const id of ['bookmark-c', 'bookmark-a', 'bookmark-b']) {
      await repository.create({
        id,
        projectId: 'project-1',
        sessionId: 'session-1',
        target: {
          kind: 'text',
          source: { kind: 'agent-message', sessionId: 'session-1', messageId: `${id}-message` },
          quote: id
        },
        note: ''
      })
    }
    await client.bookmark.updateMany({ data: { createdAt: new Date('2026-09-14T00:00:00.000Z') } })

    const first = await repository.list({
      projectId: 'project-1',
      sessionId: 'session-1',
      limit: 2
    })
    expect(first).toMatchObject({
      items: [{ id: 'bookmark-a' }, { id: 'bookmark-b' }],
      total: 3,
      nextCursor: { createdAt: '2026-09-14T00:00:00.000Z', id: 'bookmark-b' }
    })
    await expect(
      repository.list({
        projectId: 'project-1',
        sessionId: 'session-1',
        limit: 2,
        cursor: first.nextCursor
      })
    ).resolves.toMatchObject({ items: [{ id: 'bookmark-c' }], total: 3 })
  })

  it('does not edit or delete a Bookmark through another Session scope', async () => {
    const repository = new BookmarkRepository(async () => client)
    await repository.create({
      id: 'bookmark-owned',
      projectId: 'project-1',
      sessionId: 'session-1',
      target: {
        kind: 'text',
        source: { kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' },
        quote: 'quote'
      },
      note: ''
    })

    await expect(
      repository.updateNote({
        id: 'bookmark-owned',
        projectId: 'project-1',
        sessionId: 'session-2',
        note: 'unauthorized'
      })
    ).rejects.toThrow('Bookmark not found.')
    await expect(
      repository.delete({ id: 'bookmark-owned', projectId: 'project-1', sessionId: 'session-2' })
    ).resolves.toBe(false)
    await expect(
      repository.list({ projectId: 'project-1', sessionId: 'session-1' })
    ).resolves.toMatchObject({
      items: [{ id: 'bookmark-owned', note: '' }],
      total: 1
    })
  })
})
