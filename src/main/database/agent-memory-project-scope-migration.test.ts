import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ABOUT_YOU_MEMORY_CATEGORY_ID, MEMORY_SETTINGS_ID } from '../../shared/memory'
import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase, verifyCurrentApplicationSchema } from './migration-service'

const CURRENT_AGENT_MEMORY_MIGRATION_ID = '0017_agent_memory_project_scope'
const SESSION_AUXILIARY_USAGE_MIGRATION_ID = '0018_session_auxiliary_turn_usage'
const SESSION_USAGE_ATTRIBUTION_MIGRATION_ID = '0019_session_usage_attribution'
const COMPUTE_ANALYSIS_STATE_MIGRATION_ID = '0020_compute_job_analysis_state'
const COMPUTE_ANALYSIS_CONSTRAINTS_MIGRATION_ID = '0021_compute_job_analysis_constraints'
const MEMORY_GLOBAL_CONTENT_UNIQUE_MIGRATION_ID = '0022_memory_global_content_unique'
const COMPUTE_JOB_OPERATION_MIGRATION_ID = '0023_compute_job_operation'
const COMPUTE_JOB_FILE_EVIDENCE_MIGRATION_ID = '0024_compute_job_file_evidence'
const CURRENT_MIGRATION_ID = '0028_database_numeric_and_null_constraints'
const MEMORY_AUXILIARY_SCHEMA_NAMES = [
  'MemoryEntryFts',
  'MemoryEntry_fts_insert',
  'MemoryEntry_fts_delete',
  'MemoryEntry_fts_update',
  'MemoryCategory_custom_limit',
  'MemoryCategory_about_you_delete',
  'MemoryCategory_about_you_update'
] as const

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
      migrationId: CURRENT_MIGRATION_ID
    })
  })

  it('replays an unledgered partial memory migration and restores missing triggers', async () => {
    await client.$executeRawUnsafe('DROP TRIGGER "MemoryEntry_fts_update"')
    await client.$executeRawUnsafe('ALTER TABLE "ComputeJob" DROP COLUMN "fileEvidence"')
    await client.$executeRawUnsafe('ALTER TABLE "ComputeJob" DROP COLUMN "producerRunId"')
    await client.$executeRawUnsafe(
      `DELETE FROM "_open_science_migrations" WHERE "id" IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      CURRENT_AGENT_MEMORY_MIGRATION_ID,
      SESSION_AUXILIARY_USAGE_MIGRATION_ID,
      SESSION_USAGE_ATTRIBUTION_MIGRATION_ID,
      COMPUTE_ANALYSIS_STATE_MIGRATION_ID,
      COMPUTE_ANALYSIS_CONSTRAINTS_MIGRATION_ID,
      MEMORY_GLOBAL_CONTENT_UNIQUE_MIGRATION_ID,
      COMPUTE_JOB_OPERATION_MIGRATION_ID,
      COMPUTE_JOB_FILE_EVIDENCE_MIGRATION_ID,
      '0025_managed_file_version_foundation',
      '0026_compute_job_remote_cleanup',
      '0027_project_session_defaults',
      CURRENT_MIGRATION_ID
    )

    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
      applied: [
        CURRENT_AGENT_MEMORY_MIGRATION_ID,
        SESSION_AUXILIARY_USAGE_MIGRATION_ID,
        SESSION_USAGE_ATTRIBUTION_MIGRATION_ID,
        COMPUTE_ANALYSIS_STATE_MIGRATION_ID,
        COMPUTE_ANALYSIS_CONSTRAINTS_MIGRATION_ID,
        MEMORY_GLOBAL_CONTENT_UNIQUE_MIGRATION_ID,
        COMPUTE_JOB_OPERATION_MIGRATION_ID,
        COMPUTE_JOB_FILE_EVIDENCE_MIGRATION_ID,
        '0025_managed_file_version_foundation',
        '0026_compute_job_remote_cleanup',
        '0027_project_session_defaults',
        CURRENT_MIGRATION_ID
      ],
      to: CURRENT_MIGRATION_ID
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
