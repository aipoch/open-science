import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ABOUT_YOU_MEMORY_CATEGORY_ID, MEMORY_SETTINGS_ID } from '../../shared/memory'
import { createProjectDbClient } from '../projects/prisma-client'
import { verifyCurrentRuntimeSchema } from './legacy-baseline-adapter'
import { migrateApplicationDatabase } from './migration-service'
import { MEMORY_AUXILIARY_SCHEMA_OBJECTS } from './migrations/0014-agent-memory'

describe('agent memory migration', () => {
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
          'MemoryEntry_categoryId_updatedAt_idx'
        )
        ORDER BY "name"
      `
    ).resolves.toEqual([
      { name: 'MemoryCategory_nameKey_key' },
      { name: 'MemoryCategory_systemKey_key' },
      { name: 'MemoryEntry_categoryId_updatedAt_idx' }
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
         WHERE "name" IN (${MEMORY_AUXILIARY_SCHEMA_OBJECTS.map(() => '?').join(', ')})
         ORDER BY "type", "name"`,
        ...MEMORY_AUXILIARY_SCHEMA_OBJECTS.map(({ name }) => name)
      )
    ).resolves.toHaveLength(MEMORY_AUXILIARY_SCHEMA_OBJECTS.length)
    await expect(verifyCurrentRuntimeSchema(client)).resolves.toBeUndefined()

    await client.$executeRawUnsafe('DROP TRIGGER "MemoryEntry_fts_update"')
    await expect(verifyCurrentRuntimeSchema(client)).rejects.toThrow(/memory auxiliary schema/i)
  })

  it('replays an unledgered partial memory migration and restores missing triggers', async () => {
    await client.$executeRawUnsafe('DROP TRIGGER "MemoryEntry_fts_update"')
    await client.$executeRawUnsafe(
      `DELETE FROM "_open_science_migrations" WHERE "id" = '0014_agent_memory'`
    )

    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
      applied: ['0014_agent_memory'],
      to: '0014_agent_memory'
    })
    await expect(verifyCurrentRuntimeSchema(client)).resolves.toBeUndefined()
  })

  it('rejects unexpected triggers in the current runtime schema', async () => {
    await client.$executeRawUnsafe(`CREATE TRIGGER "MemoryEntry_unexpected_copy"
      AFTER DELETE ON "MemoryEntry"
      BEGIN
        UPDATE "MemorySettings" SET "revision" = "revision" WHERE "id" = 'memory-settings';
      END`)

    await expect(verifyCurrentRuntimeSchema(client)).rejects.toThrow(/unexpected.*trigger/i)
  })
})
