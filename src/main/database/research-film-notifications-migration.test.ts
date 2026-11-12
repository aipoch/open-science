import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createProjectDbClient } from '../projects/prisma-client'
import { createDatabaseAtReleasedManifest } from '../../../test/fixtures/application-database'
import { MIGRATION_MANIFEST, migrateApplicationDatabase } from './migration-service'
import { NotificationInboxDbRepository } from '../notifications/notification-inbox-repository'

it('upgrades existing notifications without backfilling films and preserves film branch/read semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'film-notification-upgrade-'))
  const client = createProjectDbClient(root)
  try {
    await createDatabaseAtReleasedManifest(client, MIGRATION_MANIFEST.slice(0, -1))
    await client.$executeRawUnsafe(
      `INSERT INTO "NotificationInboxItem" ("id", "dedupeKey", "kind", "sessionId", "originId", "title", "summary") VALUES ('old', 'old', 'task.completed', 's', 'old', 'Task completed', '')`
    )
    await migrateApplicationDatabase(client, { databasePath: join(root, 'open-science.db') })
    expect(await client.notificationInboxItem.count()).toBe(1)
    const repository = new NotificationInboxDbRepository(async () => client)
    const input = {
      id: 'film',
      dedupeKey: 'research-film:attempt',
      kind: 'task.failed' as const,
      source: 'research-film' as const,
      projectId: 'p',
      sessionId: 's',
      branchId: 'b',
      originId: 'attempt',
      title: 'Research video failed',
      summary: ''
    }
    await repository.record(input)
    await repository.record({ ...input, id: 'duplicate' })
    await repository.markSessionsRead(['s'], 1000)
    await repository.markSessionCompletionsRead(['s'], 1000)
    const snapshot = await repository.snapshot()
    expect(snapshot.items).toHaveLength(2)
    expect(snapshot.items.find((item) => item.id === 'old')).toMatchObject({ readAt: 1000 })
    expect(snapshot.items.find((item) => item.id === 'film')).toMatchObject({ branchId: 'b' })
    expect(snapshot.unreadCount).toBe(1)
    await repository.invalidateSessions(['s'], 2000)
    expect((await repository.snapshot()).unreadCount).toBe(0)
  } finally {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})
