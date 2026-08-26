import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ABOUT_YOU_MEMORY_CATEGORY_ID, MEMORY_SETTINGS_ID } from '../../shared/memory'
import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase, verifyCurrentApplicationSchema } from './migration-service'

const CURRENT_AGENT_MEMORY_MIGRATION_ID = '0016_agent_memory_project_scope'
const PRE_RELEASE_AGENT_MEMORY_MIGRATION_ID = '0016_agent_memory'
const PRE_RELEASE_AGENT_MEMORY_CHECKSUM =
  '7cc61c23b294792e4675d0d80968b6365a43e4fc92e8cf27e31668706b453267'
const PRE_RELEASE_PROJECT_SCOPE_CHECKSUM =
  '43bd42fc137a0a88fb513f701db6e3e19ed3bdb5b8ead5691b5fad3fb68fb01a'
const MEMORY_AUXILIARY_SCHEMA_NAMES = [
  'MemoryEntryFts',
  'MemoryEntry_fts_insert',
  'MemoryEntry_fts_delete',
  'MemoryEntry_fts_update',
  'MemoryCategory_custom_limit',
  'MemoryCategory_about_you_delete',
  'MemoryCategory_about_you_update'
] as const

const replaceMemoryEntryWithPreReleaseSchema = async (client: PrismaClient): Promise<void> => {
  // Recreate the exact pre-project-scope table shape while retaining its rows and FTS behavior.
  await client.$executeRawUnsafe('DROP TRIGGER "MemoryEntry_fts_insert"')
  await client.$executeRawUnsafe('DROP TRIGGER "MemoryEntry_fts_delete"')
  await client.$executeRawUnsafe('DROP TRIGGER "MemoryEntry_fts_update"')
  await client.$executeRawUnsafe('DROP TABLE "MemoryEntryFts"')
  await client.$executeRawUnsafe(`CREATE TABLE "MemoryEntry_pre_release" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "categoryId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "contentKey" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "sourceSessionId" TEXT,
    "sourceAgentId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MemoryEntry_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "MemoryCategory" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MemoryEntry_content_check" CHECK (length(trim("content")) BETWEEN 1 AND 4000),
    CONSTRAINT "MemoryEntry_contentKey_check" CHECK (length("contentKey") BETWEEN 1 AND 4000),
    CONSTRAINT "MemoryEntry_origin_check" CHECK ("origin" IN ('user', 'agent')),
    CONSTRAINT "MemoryEntry_source_check" CHECK (("origin" = 'user' AND "sourceSessionId" IS NULL AND "sourceAgentId" IS NULL) OR ("origin" = 'agent' AND "sourceSessionId" IS NOT NULL)),
    CONSTRAINT "MemoryEntry_revision_check" CHECK ("revision" >= 1)
  )`)
  await client.$executeRawUnsafe(`INSERT INTO "MemoryEntry_pre_release" (
    "id", "categoryId", "content", "contentKey", "origin", "sourceSessionId",
    "sourceAgentId", "revision", "createdAt", "updatedAt"
  ) SELECT
    "id", "categoryId", "content", "contentKey", "origin", "sourceSessionId",
    "sourceAgentId", "revision", "createdAt", "updatedAt"
  FROM "MemoryEntry"`)
  await client.$executeRawUnsafe('DROP TABLE "MemoryEntry"')
  await client.$executeRawUnsafe('ALTER TABLE "MemoryEntry_pre_release" RENAME TO "MemoryEntry"')
  await client.$executeRawUnsafe(
    'CREATE INDEX "MemoryEntry_categoryId_updatedAt_idx" ON "MemoryEntry"("categoryId", "updatedAt")'
  )
  await client.$executeRawUnsafe(`CREATE VIRTUAL TABLE "MemoryEntryFts"
    USING fts5("content", content='MemoryEntry', content_rowid='rowid', tokenize='trigram')`)
  await client.$executeRawUnsafe(`CREATE TRIGGER "MemoryEntry_fts_insert"
    AFTER INSERT ON "MemoryEntry"
    BEGIN
      INSERT INTO "MemoryEntryFts"("rowid", "content") VALUES (NEW."rowid", NEW."content");
    END`)
  await client.$executeRawUnsafe(`CREATE TRIGGER "MemoryEntry_fts_delete"
    BEFORE DELETE ON "MemoryEntry"
    BEGIN
      DELETE FROM "MemoryEntryFts" WHERE "rowid" = OLD."rowid";
    END`)
  await client.$executeRawUnsafe(`CREATE TRIGGER "MemoryEntry_fts_update"
    BEFORE UPDATE OF "content" ON "MemoryEntry"
    BEGIN
      DELETE FROM "MemoryEntryFts" WHERE "rowid" = OLD."rowid";
      INSERT INTO "MemoryEntryFts"("rowid", "content") VALUES (NEW."rowid", NEW."content");
    END`)
  await client.$executeRawUnsafe(
    `INSERT INTO "MemoryEntryFts"("MemoryEntryFts", "rank") VALUES('secure-delete', 1)`
  )
  await client.$executeRawUnsafe(`INSERT INTO "MemoryEntryFts"("MemoryEntryFts") VALUES('rebuild')`)
  await client.$executeRawUnsafe(
    `UPDATE "_open_science_migrations" SET "id" = ?, "checksum" = ? WHERE "id" = ?`,
    PRE_RELEASE_AGENT_MEMORY_MIGRATION_ID,
    PRE_RELEASE_AGENT_MEMORY_CHECKSUM,
    CURRENT_AGENT_MEMORY_MIGRATION_ID
  )
}

describe('agent memory project scope migration', () => {
  let storageRoot = ''
  let client: PrismaClient

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-agent-memory-migration-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
  })

  afterEach(async () => {
    await client.$disconnect()
    await rm(storageRoot, { recursive: true, force: true })
  })

  it('upgrades the pre-release memory ledger without losing entries and reopens idempotently', async () => {
    const databasePath = join(storageRoot, 'open-science.db')
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    await client.session.create({
      data: {
        id: 'session-1',
        number: 1,
        projectId: 'project-1',
        title: 'Session one',
        status: 'idle',
        presentedStatus: 'idle',
        createdAtMs: 1n,
        updatedAtMs: 2n
      }
    })
    await client.memoryEntry.createMany({
      data: [
        {
          id: 'user-memory',
          categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
          content: 'Prefers concise answers',
          contentKey: 'prefers concise answers',
          origin: 'user',
          revision: 3,
          createdAt: new Date('2026-08-20T01:02:03.000Z'),
          updatedAt: new Date('2026-08-21T04:05:06.000Z')
        },
        {
          id: 'agent-memory',
          categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
          content: 'Uses isolated migration roots',
          contentKey: 'uses isolated migration roots',
          origin: 'agent',
          projectId: 'project-1',
          sourceSessionId: 'session-1',
          sourceAgentId: 'agent-1',
          revision: 4,
          createdAt: new Date('2026-08-22T01:02:03.000Z'),
          updatedAt: new Date('2026-08-23T04:05:06.000Z')
        }
      ]
    })
    await replaceMemoryEntryWithPreReleaseSchema(client)

    await expect(migrateApplicationDatabase(client, { databasePath })).resolves.toMatchObject({
      applied: [CURRENT_AGENT_MEMORY_MIGRATION_ID],
      from: PRE_RELEASE_AGENT_MEMORY_MIGRATION_ID,
      to: CURRENT_AGENT_MEMORY_MIGRATION_ID
    })
    await expect(
      client.$queryRawUnsafe<
        Array<{
          id: string
          categoryId: string | null
          projectId: string | null
          content: string
          contentKey: string
          origin: string
          sourceSessionId: string | null
          sourceAgentId: string | null
          revision: number
          createdAt: Date
          updatedAt: Date
        }>
      >(`SELECT "id", "categoryId", "projectId", "content", "contentKey", "origin",
                "sourceSessionId", "sourceAgentId", "revision", "createdAt", "updatedAt"
         FROM "MemoryEntry" ORDER BY "id"`)
    ).resolves.toEqual([
      {
        id: 'agent-memory',
        categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
        projectId: 'project-1',
        content: 'Uses isolated migration roots',
        contentKey: 'uses isolated migration roots',
        origin: 'agent',
        sourceSessionId: 'session-1',
        sourceAgentId: 'agent-1',
        revision: 4,
        createdAt: new Date('2026-08-22T01:02:03.000Z'),
        updatedAt: new Date('2026-08-23T04:05:06.000Z')
      },
      {
        id: 'user-memory',
        categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
        projectId: null,
        content: 'Prefers concise answers',
        contentKey: 'prefers concise answers',
        origin: 'user',
        sourceSessionId: null,
        sourceAgentId: null,
        revision: 3,
        createdAt: new Date('2026-08-20T01:02:03.000Z'),
        updatedAt: new Date('2026-08-21T04:05:06.000Z')
      }
    ])
    await expect(
      client.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT e."id" FROM "MemoryEntryFts"
         JOIN "MemoryEntry" e ON e."rowid" = "MemoryEntryFts"."rowid"
         WHERE "MemoryEntryFts" MATCH ? ORDER BY e."id"`,
        'migration'
      )
    ).resolves.toEqual([{ id: 'agent-memory' }])
    await expect(
      client.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "_open_science_migrations"
         WHERE "id" LIKE '0016_%' ORDER BY "id"`
      )
    ).resolves.toEqual([{ id: CURRENT_AGENT_MEMORY_MIGRATION_ID }])
    await expect(
      access(`${databasePath}.before-${CURRENT_AGENT_MEMORY_MIGRATION_ID}.backup`)
    ).resolves.toBeUndefined()

    await client.$disconnect()
    client = createProjectDbClient(storageRoot)
    await expect(migrateApplicationDatabase(client, { databasePath })).resolves.toEqual({
      adoptedLegacy: false,
      applied: [],
      from: CURRENT_AGENT_MEMORY_MIGRATION_ID,
      to: CURRENT_AGENT_MEMORY_MIGRATION_ID
    })
  })

  it('preserves categorized pre-release duplicates while establishing project identity', async () => {
    const databasePath = join(storageRoot, 'open-science.db')
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    await client.session.create({
      data: {
        id: 'session-1',
        number: 1,
        projectId: 'project-1',
        title: 'Session one',
        status: 'idle',
        presentedStatus: 'idle',
        createdAtMs: 1n,
        updatedAtMs: 2n
      }
    })
    await client.memoryCategory.createMany({
      data: [
        {
          id: 'category-a',
          name: 'Category A',
          nameKey: 'category a',
          guidance: '',
          autoRecall: true
        },
        {
          id: 'category-b',
          name: 'Category B',
          nameKey: 'category b',
          guidance: '',
          autoRecall: true
        },
        {
          id: 'category-c',
          name: 'Category C',
          nameKey: 'category c',
          guidance: '',
          autoRecall: true
        }
      ]
    })
    await replaceMemoryEntryWithPreReleaseSchema(client)
    await client.$executeRawUnsafe(
      `INSERT INTO "MemoryEntry" (
         "id", "categoryId", "content", "contentKey", "origin", "sourceSessionId",
         "sourceAgentId", "revision", "createdAt", "updatedAt"
       ) VALUES
         ('duplicate-a', 'category-a', 'Shared project fact', 'shared project fact',
          'agent', 'session-1', 'agent-a', 3, '2026-08-20 01:02:03', '2026-08-21 04:05:06'),
         ('duplicate-b', 'category-b', 'Shared project fact', 'shared project fact',
          'agent', 'session-1', 'agent-b', 5, '2026-08-22 01:02:03', '2026-08-23 04:05:06')`
    )
    const [{ rowid: duplicateRowId }] = await client.$queryRawUnsafe<Array<{ rowid: bigint }>>(
      `SELECT "rowid" FROM "MemoryEntry" WHERE "id" = 'duplicate-b'`
    )
    const occupiedLegacyKey = `shared project fact\u001flegacy:${duplicateRowId
      .toString(16)
      .padStart(16, '0')}`
    await client.$executeRawUnsafe(
      `INSERT INTO "MemoryEntry" (
         "id", "categoryId", "content", "contentKey", "origin", "sourceSessionId",
         "sourceAgentId", "revision", "createdAt", "updatedAt"
       ) VALUES (
         'duplicate-collision', 'category-c', 'Collision sentinel fact', ?,
         'agent', 'session-1', 'agent-c', 7, '2026-08-24 01:02:03', '2026-08-25 04:05:06'
       )`,
      occupiedLegacyKey
    )
    const migratedDuplicateKey = `${occupiedLegacyKey}:1`

    await expect(migrateApplicationDatabase(client, { databasePath })).resolves.toMatchObject({
      applied: [CURRENT_AGENT_MEMORY_MIGRATION_ID],
      from: PRE_RELEASE_AGENT_MEMORY_MIGRATION_ID,
      to: CURRENT_AGENT_MEMORY_MIGRATION_ID
    })
    await expect(
      client.$queryRawUnsafe<
        Array<{
          id: string
          categoryId: string | null
          projectId: string | null
          content: string
          contentKey: string
          origin: string
          sourceSessionId: string | null
          sourceAgentId: string | null
          revision: number
          createdAt: Date
          updatedAt: Date
        }>
      >(`SELECT "id", "categoryId", "projectId", "content", "contentKey", "origin",
                "sourceSessionId", "sourceAgentId", "revision", "createdAt", "updatedAt"
         FROM "MemoryEntry" ORDER BY "id"`)
    ).resolves.toEqual([
      {
        id: 'duplicate-a',
        categoryId: 'category-a',
        projectId: 'project-1',
        content: 'Shared project fact',
        contentKey: 'shared project fact',
        origin: 'agent',
        sourceSessionId: 'session-1',
        sourceAgentId: 'agent-a',
        revision: 3,
        createdAt: new Date('2026-08-20T01:02:03.000Z'),
        updatedAt: new Date('2026-08-21T04:05:06.000Z')
      },
      {
        id: 'duplicate-b',
        categoryId: 'category-b',
        projectId: 'project-1',
        content: 'Shared project fact',
        contentKey: migratedDuplicateKey,
        origin: 'agent',
        sourceSessionId: 'session-1',
        sourceAgentId: 'agent-b',
        revision: 5,
        createdAt: new Date('2026-08-22T01:02:03.000Z'),
        updatedAt: new Date('2026-08-23T04:05:06.000Z')
      },
      {
        id: 'duplicate-collision',
        categoryId: 'category-c',
        projectId: 'project-1',
        content: 'Collision sentinel fact',
        contentKey: occupiedLegacyKey,
        origin: 'agent',
        sourceSessionId: 'session-1',
        sourceAgentId: 'agent-c',
        revision: 7,
        createdAt: new Date('2026-08-24T01:02:03.000Z'),
        updatedAt: new Date('2026-08-25T04:05:06.000Z')
      }
    ])
    await expect(
      client.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT e."id" FROM "MemoryEntryFts"
         JOIN "MemoryEntry" e ON e."rowid" = "MemoryEntryFts"."rowid"
         WHERE "MemoryEntryFts" MATCH ? ORDER BY e."id"`,
        'Shared project fact'
      )
    ).resolves.toEqual([{ id: 'duplicate-a' }, { id: 'duplicate-b' }])
  })

  it('blocks an orphaned pre-release agent memory and leaves the old database recoverable', async () => {
    const databasePath = join(storageRoot, 'open-science.db')
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    await client.session.create({
      data: {
        id: 'session-1',
        number: 1,
        projectId: 'project-1',
        title: 'Session one',
        status: 'idle',
        presentedStatus: 'idle',
        createdAtMs: 1n,
        updatedAtMs: 2n
      }
    })
    await client.memoryEntry.create({
      data: {
        id: 'orphaned-agent-memory',
        categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
        projectId: 'project-1',
        content: 'Must keep this fact',
        contentKey: 'must keep this fact',
        origin: 'agent',
        sourceSessionId: 'session-1'
      }
    })
    await replaceMemoryEntryWithPreReleaseSchema(client)
    await client.session.delete({ where: { id: 'session-1' } })

    await expect(migrateApplicationDatabase(client, { databasePath })).rejects.toMatchObject({
      code: 'database_validation_failed',
      migrationId: CURRENT_AGENT_MEMORY_MIGRATION_ID
    })
    await expect(
      client.$queryRawUnsafe<Array<{ id: string; content: string }>>(
        `SELECT "id", "content" FROM "MemoryEntry"`
      )
    ).resolves.toEqual([{ id: 'orphaned-agent-memory', content: 'Must keep this fact' }])
    await expect(
      client.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT "name" FROM pragma_table_info('MemoryEntry')`
      )
    ).resolves.not.toContainEqual({ name: 'projectId' })
    await expect(
      client.$queryRawUnsafe<Array<{ id: string; checksum: string }>>(
        `SELECT "id", "checksum" FROM "_open_science_migrations" WHERE "id" LIKE '0016_%'`
      )
    ).resolves.toEqual([
      {
        id: PRE_RELEASE_AGENT_MEMORY_MIGRATION_ID,
        checksum: PRE_RELEASE_AGENT_MEMORY_CHECKSUM
      }
    ])
    await expect(
      access(`${databasePath}.before-${CURRENT_AGENT_MEMORY_MIGRATION_ID}.backup`)
    ).resolves.toBeUndefined()
  })

  it('adopts the pre-release project-scope schema by replacing only its ledger identity', async () => {
    const databasePath = join(storageRoot, 'open-science.db')
    await client.memoryEntry.create({
      data: {
        id: 'user-memory',
        categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
        content: 'Keep the final-shape row',
        contentKey: 'keep the final-shape row',
        origin: 'user',
        revision: 5
      }
    })
    await client.$executeRawUnsafe(
      `UPDATE "_open_science_migrations" SET "id" = ?, "checksum" = ? WHERE "id" = ?`,
      PRE_RELEASE_AGENT_MEMORY_MIGRATION_ID,
      PRE_RELEASE_PROJECT_SCOPE_CHECKSUM,
      CURRENT_AGENT_MEMORY_MIGRATION_ID
    )

    await expect(migrateApplicationDatabase(client, { databasePath })).resolves.toMatchObject({
      applied: [CURRENT_AGENT_MEMORY_MIGRATION_ID],
      from: PRE_RELEASE_AGENT_MEMORY_MIGRATION_ID,
      to: CURRENT_AGENT_MEMORY_MIGRATION_ID
    })
    await expect(
      client.memoryEntry.findUniqueOrThrow({
        where: { id: 'user-memory' },
        select: { content: true, projectId: true, revision: true }
      })
    ).resolves.toEqual({
      content: 'Keep the final-shape row',
      projectId: null,
      revision: 5
    })
    await expect(
      client.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "_open_science_migrations" WHERE "id" LIKE '0016_%'`
      )
    ).resolves.toEqual([{ id: CURRENT_AGENT_MEMORY_MIGRATION_ID }])
  })

  it('seeds disabled settings and the immutable About you category', async () => {
    await expect(
      client.memorySettings.findUniqueOrThrow({ where: { id: MEMORY_SETTINGS_ID } })
    ).resolves.toMatchObject({ enabled: false, revision: 0 })
    await expect(
      client.memoryCategory.findUniqueOrThrow({ where: { id: ABOUT_YOU_MEMORY_CATEGORY_ID } })
    ).resolves.toMatchObject({
      systemKey: 'about-you',
      name: null,
      nameKey: null,
      guidance: '',
      autoRecall: true
    })
    await expect(
      client.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT "name" FROM pragma_table_info('MemoryCategory')`
      )
    ).resolves.not.toContainEqual({ name: 'sortIndex' })

    await expect(
      client.$queryRaw<Array<{ name: string }>>`
        SELECT "name" FROM "sqlite_schema"
        WHERE "type" = 'index' AND "name" IN (
          'MemoryCategory_systemKey_key',
          'MemoryCategory_nameKey_key',
          'MemoryEntry_categoryId_updatedAt_idx',
          'MemoryEntry_projectId_updatedAt_idx',
          'MemoryEntry_projectId_contentKey_key'
        )
        ORDER BY "name"
      `
    ).resolves.toEqual([
      { name: 'MemoryCategory_nameKey_key' },
      { name: 'MemoryCategory_systemKey_key' },
      { name: 'MemoryEntry_categoryId_updatedAt_idx' },
      { name: 'MemoryEntry_projectId_contentKey_key' },
      { name: 'MemoryEntry_projectId_updatedAt_idx' }
    ])
    await expect(
      client.$queryRaw<Array<{ name: string }>>`
        SELECT "name" FROM "sqlite_schema"
        WHERE "type" = 'trigger' AND "name" LIKE 'MemoryCategory_%'
        ORDER BY "name"
      `
    ).resolves.toEqual([
      { name: 'MemoryCategory_about_you_delete' },
      { name: 'MemoryCategory_about_you_update' },
      { name: 'MemoryCategory_custom_limit' }
    ])
    const categoryTriggerSql = await client.$queryRaw<Array<{ sql: string }>>`
      SELECT "sql" FROM "sqlite_schema"
      WHERE "type" = 'trigger' AND "name" LIKE 'MemoryCategory_%'
    `
    expect(categoryTriggerSql.map(({ sql }) => sql).join('\n')).not.toContain('sortIndex')
  })

  it('rejects invalid settings, category shapes, and agent provenance at the database boundary', async () => {
    await expect(
      client.$executeRawUnsafe(
        `INSERT INTO "MemorySettings" ("id", "enabled", "revision", "updatedAt") VALUES ('other', false, 0, CURRENT_TIMESTAMP)`
      )
    ).rejects.toThrow()
    await expect(
      client.$executeRawUnsafe(
        `INSERT INTO "MemoryCategory" ("id", "systemKey", "name", "nameKey", "guidance", "autoRecall", "updatedAt") VALUES ('invalid-category', NULL, NULL, NULL, '', false, CURRENT_TIMESTAMP)`
      )
    ).rejects.toThrow()
    await expect(
      client.$executeRawUnsafe(
        `INSERT INTO "MemoryEntry" ("id", "categoryId", "content", "contentKey", "origin", "sourceSessionId", "sourceAgentId", "updatedAt") VALUES ('invalid-entry', ?, 'fact', 'fact', 'agent', NULL, 'agent-1', CURRENT_TIMESTAMP)`,
        ABOUT_YOU_MEMORY_CATEGORY_ID
      )
    ).rejects.toThrow()
  })

  it('supports categorized and uncategorized project memories with project isolation invariants', async () => {
    await client.project.createMany({
      data: [
        { id: 'project-1', name: 'Project one' },
        { id: 'project-2', name: 'Project two' }
      ]
    })
    const category = await client.memoryCategory.create({
      data: {
        id: 'project-category',
        name: 'Project facts',
        nameKey: 'project facts',
        guidance: '',
        autoRecall: true
      }
    })
    await client.$executeRawUnsafe(
      `INSERT INTO "MemoryEntry" ("id", "categoryId", "projectId", "content", "contentKey", "origin", "sourceSessionId", "updatedAt")
       VALUES ('project-memory-1', NULL, 'project-1', 'durable fact', 'durable fact', 'agent', 'session-1', CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "MemoryEntry" ("id", "categoryId", "projectId", "content", "contentKey", "origin", "sourceSessionId", "updatedAt")
       VALUES ('project-memory-2', ?, 'project-2', 'durable fact', 'durable fact', 'agent', 'session-2', CURRENT_TIMESTAMP)`,
      category.id
    )

    await expect(
      client.$queryRawUnsafe<Array<{ id: string; categoryId: string | null; projectId: string }>>(
        `SELECT "id", "categoryId", "projectId" FROM "MemoryEntry" ORDER BY "id"`
      )
    ).resolves.toEqual([
      { id: 'project-memory-1', categoryId: null, projectId: 'project-1' },
      {
        id: 'project-memory-2',
        categoryId: category.id,
        projectId: 'project-2'
      }
    ])

    await client.project.delete({ where: { id: 'project-1' } })
    await expect(client.memoryEntry.count()).resolves.toBe(1)
    await client.memoryCategory.delete({ where: { id: category.id } })
    await expect(client.memoryEntry.count()).resolves.toBe(0)
  })

  it('enforces idempotent content identity within each project only', async () => {
    await client.project.createMany({
      data: [
        { id: 'project-1', name: 'Project one' },
        { id: 'project-2', name: 'Project two' }
      ]
    })
    const insert = (id: string, projectId: string): Promise<number> =>
      client.$executeRawUnsafe(
        `INSERT INTO "MemoryEntry" ("id", "categoryId", "projectId", "content", "contentKey", "origin", "sourceSessionId", "updatedAt")
         VALUES (?, NULL, ?, 'same fact', 'same fact', 'agent', 'session-1', CURRENT_TIMESTAMP)`,
        id,
        projectId
      )

    await expect(insert('entry-1', 'project-1')).resolves.toBe(1)
    await expect(insert('entry-2', 'project-1')).rejects.toThrow()
    await expect(insert('entry-3', 'project-2')).resolves.toBe(1)
  })

  it('enforces the custom category cap and immutable About you category in SQLite', async () => {
    await client.memoryCategory.createMany({
      data: Array.from({ length: 10 }, (_, index) => ({
        name: `Category ${index}`,
        nameKey: `category ${index}`,
        guidance: '',
        autoRecall: false
      }))
    })

    await expect(
      client.memoryCategory.create({
        data: {
          name: 'Eleventh',
          nameKey: 'eleventh',
          guidance: '',
          autoRecall: false
        }
      })
    ).rejects.toThrow()
    await expect(client.memoryCategory.count({ where: { systemKey: null } })).resolves.toBe(10)
    await expect(
      client.memoryCategory.delete({ where: { id: ABOUT_YOU_MEMORY_CATEGORY_ID } })
    ).rejects.toThrow()
    await expect(
      client.memoryCategory.findUniqueOrThrow({ where: { id: ABOUT_YOU_MEMORY_CATEGORY_ID } })
    ).resolves.toMatchObject({ autoRecall: true })
    await expect(
      client.memoryCategory.update({
        where: { id: ABOUT_YOU_MEMORY_CATEGORY_ID },
        data: { autoRecall: false }
      })
    ).rejects.toThrow()
    await expect(
      client.memoryCategory.findUniqueOrThrow({ where: { id: ABOUT_YOU_MEMORY_CATEGORY_ID } })
    ).resolves.toMatchObject({ autoRecall: true })
  })

  it('keeps the external-content search index synchronized and securely deletes its terms', async () => {
    await client.memoryEntry.create({
      data: {
        id: 'entry-1',
        categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
        content: 'microscopy preference',
        contentKey: 'microscopy preference',
        origin: 'user'
      }
    })
    await expect(
      client.$queryRawUnsafe<Array<{ content: string }>>(
        `SELECT "content" FROM "MemoryEntryFts" WHERE "MemoryEntryFts" MATCH ?`,
        'microscopy'
      )
    ).resolves.toEqual([{ content: 'microscopy preference' }])

    await client.memoryEntry.update({
      where: { id: 'entry-1' },
      data: { content: 'spectroscopy preference', contentKey: 'spectroscopy preference' }
    })
    await expect(
      client.$queryRawUnsafe<Array<{ content: string }>>(
        `SELECT "content" FROM "MemoryEntryFts" WHERE "MemoryEntryFts" MATCH ?`,
        'microscopy'
      )
    ).resolves.toEqual([])
    await expect(
      client.$queryRawUnsafe<Array<{ content: string }>>(
        `SELECT "content" FROM "MemoryEntryFts" WHERE "MemoryEntryFts" MATCH ?`,
        'spectroscopy'
      )
    ).resolves.toEqual([{ content: 'spectroscopy preference' }])

    await client.memoryEntry.delete({ where: { id: 'entry-1' } })
    await expect(
      client.$queryRawUnsafe<Array<{ content: string }>>(
        `SELECT "content" FROM "MemoryEntryFts" WHERE "MemoryEntryFts" MATCH ?`,
        'spectroscopy'
      )
    ).resolves.toEqual([])
    await expect(
      client.$executeRawUnsafe(
        `INSERT INTO "MemoryEntryFts"("MemoryEntryFts", "rank") VALUES('integrity-check', 1)`
      )
    ).resolves.toBe(1)
    await expect(
      client.$queryRawUnsafe<Array<{ value: bigint }>>(
        `SELECT CAST("v" AS INTEGER) AS "value" FROM "MemoryEntryFts_config" WHERE "k" = 'secure-delete'`
      )
    ).resolves.toEqual([{ value: 1n }])
  })

  it('verifies every memory auxiliary schema object at application startup', async () => {
    await expect(
      client.$queryRawUnsafe<Array<{ type: string; name: string }>>(
        `SELECT "type", "name" FROM "sqlite_schema"
         WHERE "name" IN (${MEMORY_AUXILIARY_SCHEMA_NAMES.map(() => '?').join(', ')})
         ORDER BY "type", "name"`,
        ...MEMORY_AUXILIARY_SCHEMA_NAMES
      )
    ).resolves.toHaveLength(MEMORY_AUXILIARY_SCHEMA_NAMES.length)
    await expect(verifyCurrentApplicationSchema(client)).resolves.toBeUndefined()

    await client.$executeRawUnsafe('DROP TRIGGER "MemoryEntry_fts_update"')
    await expect(verifyCurrentApplicationSchema(client)).rejects.toThrow(
      /schema object MemoryEntry_fts_update/i
    )
  })

  it('rejects an insecure FTS deletion setting when reopening a complete database', async () => {
    await client.$executeRawUnsafe(
      `INSERT INTO "MemoryEntryFts"("MemoryEntryFts", "rank") VALUES('secure-delete', 0)`
    )

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed',
      migrationId: CURRENT_AGENT_MEMORY_MIGRATION_ID
    })
  })

  it('replays an unledgered partial memory migration and restores missing triggers', async () => {
    await client.$executeRawUnsafe('DROP TRIGGER "MemoryEntry_fts_update"')
    await client.$executeRawUnsafe(
      `DELETE FROM "_open_science_migrations" WHERE "id" = ?`,
      CURRENT_AGENT_MEMORY_MIGRATION_ID
    )

    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
      applied: [CURRENT_AGENT_MEMORY_MIGRATION_ID],
      to: CURRENT_AGENT_MEMORY_MIGRATION_ID
    })
    await expect(verifyCurrentApplicationSchema(client)).resolves.toBeUndefined()
  })

  it('rejects unexpected triggers in the current runtime schema', async () => {
    await client.$executeRawUnsafe(`CREATE TRIGGER "MemoryEntry_unexpected_copy"
      AFTER DELETE ON "MemoryEntry"
      BEGIN
        UPDATE "MemorySettings" SET "revision" = "revision" WHERE "id" = 'memory-settings';
      END`)

    await expect(verifyCurrentApplicationSchema(client)).rejects.toThrow(/unexpected.*trigger/i)
  })
})
