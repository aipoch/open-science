import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient } from '../projects/prisma-client'
import { NotificationInboxDbRepository } from '../notifications/notification-inbox-repository'
import { MIGRATION_MANIFEST, migrateApplicationDatabase } from './migration-service'
import { applySqliteMigrationOperations } from './sqlite-schema-migrations'

const createDatabaseAtMigration0006 = async (client: PrismaClient): Promise<void> => {
  const migration0007Index = MIGRATION_MANIFEST.findIndex(
    (migration) => migration.id === '0007_notification_attention_metadata'
  )
  const prefix = MIGRATION_MANIFEST.slice(0, migration0007Index)
  for (const migration of prefix) {
    for (const statement of migration.statements) await client.$executeRawUnsafe(statement)
    if ('operations' in migration) {
      await client.$transaction((transaction) =>
        applySqliteMigrationOperations(transaction, migration.operations)
      )
    }
  }
  await client.$executeRawUnsafe(`CREATE TABLE "_open_science_migrations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "checksum" TEXT NOT NULL,
    "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "_open_science_migrations_checksum_check"
      CHECK (length("checksum") = 64 AND "checksum" NOT GLOB '*[^0-9a-f]*')
  )`)
  for (const migration of prefix) {
    await client.$executeRawUnsafe(
      `INSERT INTO "_open_science_migrations" ("id", "checksum") VALUES (?, ?)`,
      migration.id,
      migration.checksum
    )
  }
}

describe('notification attention metadata migration', () => {
  let storageRoot: string | undefined
  let client: PrismaClient | undefined

  afterEach(async () => {
    await client?.$disconnect()
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  })

  it('preserves inbox identities, sequence boundaries, indexes, and AUTOINCREMENT', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-notification-0007-'))
    const databasePath = join(storageRoot, 'open-science.db')
    client = createProjectDbClient(storageRoot)
    await createDatabaseAtMigration0006(client)
    await client.$executeRawUnsafe(`INSERT INTO "NotificationInboxItem" (
      "sequence", "id", "dedupeKey", "kind", "source", "sessionId", "originId", "title",
      "summary", "createdAt", "readAt"
    ) VALUES
      (7, 'item-7', 'task:7', 'task.completed', NULL, 'session-7', 'origin-7',
       'Task completed', 'A task completed.', CURRENT_TIMESTAMP, NULL),
      (11, 'item-11', 'authorization:connector:11', 'authorization.required', 'connector',
       'session-11', 'origin-11', 'Approval needed', 'A connector request needs your approval.',
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)

    await expect(migrateApplicationDatabase(client, { databasePath })).resolves.toEqual({
      adoptedLegacy: false,
      applied: [
        '0007_notification_attention_metadata',
        '0008_database_json_constraints',
        '0009_vision_evidence',
        '0010_compute_password_auth',
        '0011_cross_resource_tags',
        '0012_tag_ordering',
        '0013_session_projection',
        '0014_review_query_indexes',
        '0015_session_model_call_usage',
        '0016_compute_job_sensitive_data_encryption',
        '0017_agent_memory_project_scope',
        '0018_session_auxiliary_turn_usage',
        '0019_session_usage_attribution',
        '0020_compute_job_analysis_state',
        '0021_compute_job_analysis_constraints',
        '0022_memory_global_content_unique',
        '0023_compute_job_operation',
        '0024_compute_job_file_evidence',
        '0025_managed_file_version_foundation',
        '0026_compute_job_remote_cleanup'
      ],
      from: '0006_database_domain_constraints',
      to: '0026_compute_job_remote_cleanup'
    })
    await expect(
      access(`${databasePath}.before-0007_notification_attention_metadata.backup`)
    ).resolves.toBeUndefined()
    await expect(
      access(`${databasePath}.before-0011_cross_resource_tags.backup`)
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(`${databasePath}.before-0012_tag_ordering.backup`)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(
      access(`${databasePath}.before-0013_session_projection.backup`)
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      access(`${databasePath}.before-0014_review_query_indexes.backup`)
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      access(`${databasePath}.before-0015_session_model_call_usage.backup`)
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      access(`${databasePath}.before-0016_compute_job_sensitive_data_encryption.backup`)
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      access(`${databasePath}.before-0017_agent_memory_project_scope.backup`)
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      access(`${databasePath}.before-0018_session_auxiliary_turn_usage.backup`)
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      access(`${databasePath}.before-0021_compute_job_analysis_constraints.backup`)
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      access(`${databasePath}.before-0022_memory_global_content_unique.backup`)
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      access(`${databasePath}.before-0023_compute_job_operation.backup`)
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      access(`${databasePath}.before-0024_compute_job_file_evidence.backup`)
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      access(`${databasePath}.before-0025_managed_file_version_foundation.backup`)
    ).rejects.toMatchObject({ code: 'ENOENT' })

    await expect(
      client.$queryRaw<
        Array<{
          sequence: number
          id: string
          dedupeKey: string
          attentionReason: string | null
          targetInvalidatedAt: Date | null
        }>
      >`SELECT "sequence", "id", "dedupeKey", "attentionReason", "targetInvalidatedAt"
        FROM "NotificationInboxItem" ORDER BY "sequence"`
    ).resolves.toEqual([
      {
        sequence: 7,
        id: 'item-7',
        dedupeKey: 'task:7',
        attentionReason: null,
        targetInvalidatedAt: null
      },
      {
        sequence: 11,
        id: 'item-11',
        dedupeKey: 'authorization:connector:11',
        attentionReason: null,
        targetInvalidatedAt: null
      }
    ])

    await expect(
      client.$queryRaw<Array<{ name: string }>>`
        SELECT "name" FROM "sqlite_schema"
        WHERE "type" = 'index' AND "tbl_name" = 'NotificationInboxItem'
        ORDER BY "name"`
    ).resolves.toEqual([
      { name: 'NotificationInboxItem_dedupeKey_key' },
      { name: 'NotificationInboxItem_id_key' },
      { name: 'NotificationInboxItem_projectId_idx' },
      { name: 'NotificationInboxItem_readAt_sequence_idx' },
      { name: 'NotificationInboxItem_sessionId_idx' }
    ])

    const repository = new NotificationInboxDbRepository(() => Promise.resolve(client!))
    await repository.record({
      id: 'item-next',
      dedupeKey: 'task:next',
      kind: 'task.completed',
      source: 'agent-runtime',
      sessionId: 'session-next',
      originId: 'origin-next',
      title: 'Task completed',
      summary: 'A task completed.'
    })
    expect((await repository.snapshot()).latestSequence).toBeGreaterThan(11)

    await repository.markAllRead(7, 1_000)
    const snapshot = await repository.snapshot()
    expect(snapshot.items.find((item) => item.sequence === 7)?.readAt).toBe(1_000)
    expect(snapshot.items.find((item) => item.sequence === 11)?.readAt).toBeDefined()
    expect(snapshot.items.find((item) => item.id === 'item-next')?.readAt).toBeUndefined()
  })

  it('rejects unknown persisted source and attention reason values', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-notification-checks-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)

    const insert = (
      id: string,
      source: string | null,
      attentionReason: string | null
    ): Promise<number> =>
      client!.$executeRawUnsafe(
        `INSERT INTO "NotificationInboxItem" (
          "id", "dedupeKey", "kind", "source", "attentionReason", "originId", "title", "summary"
        ) VALUES (?, ?, 'task.needs-attention', ?, ?, ?, 'Task needs attention', 'Summary')`,
        id,
        `task:${id}`,
        source,
        attentionReason,
        id
      )

    await expect(insert('bad-source', 'unknown', null)).rejects.toThrow(/constraint/i)
    await expect(insert('bad-reason', 'agent-runtime', 'raw-provider-reason')).rejects.toThrow(
      /constraint/i
    )
  })

  it('fails closed without rewriting an unknown historical source', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-notification-invalid-source-'))
    const databasePath = join(storageRoot, 'open-science.db')
    client = createProjectDbClient(storageRoot)
    await createDatabaseAtMigration0006(client)
    await client.$executeRawUnsafe(`INSERT INTO "NotificationInboxItem" (
      "id", "dedupeKey", "kind", "source", "originId", "title", "summary"
    ) VALUES (
      'custom-source', 'task:custom-source', 'task.needs-attention', 'custom-build',
      'custom-source', 'Task needs attention', 'Summary'
    )`)

    await expect(migrateApplicationDatabase(client, { databasePath })).rejects.toMatchObject({
      code: 'database_validation_failed',
      migrationId: '0007_notification_attention_metadata'
    })
    await expect(
      client.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "_open_science_migrations" ORDER BY "id" DESC LIMIT 1
      `
    ).resolves.toEqual([{ id: '0006_database_domain_constraints' }])
    await expect(
      client.$queryRaw<Array<{ source: string }>>`
        SELECT "source" FROM "NotificationInboxItem" WHERE "id" = 'custom-source'
      `
    ).resolves.toEqual([{ source: 'custom-build' }])
    await expect(
      access(`${databasePath}.before-0007_notification_attention_metadata.backup`)
    ).resolves.toBeUndefined()
  })
})
