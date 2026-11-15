import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, expect, it } from 'vitest'
import { createDatabaseAtReleasedManifest } from '../../../test/fixtures/application-database'
import { createProjectDbClient } from '../projects/prisma-client'
import { MIGRATION_MANIFEST, migrateApplicationDatabase } from './migration-service'
import {
  jsonlSessionHistory0055Migration,
  legacySessionHistoryMigration
} from './migrations/0058-session-history'

let root: string | undefined
let client: PrismaClient | undefined
afterEach(async () => {
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})
it('upgrades 0057 with an empty derived history index and preserves existing application data', async () => {
  root = await mkdtemp(join(tmpdir(), 'history-migration-'))
  client = createProjectDbClient(root)
  await migrateApplicationDatabase(client)
  const project = await client.project.create({
    data: { id: 'existing', name: 'Existing project' }
  })
  await client.$executeRawUnsafe('DROP TABLE SessionHistoryItem')
  await client.$executeRawUnsafe('DROP TABLE SessionHistoryIndex')
  await client.$executeRawUnsafe(
    'DELETE FROM _open_science_migrations WHERE id = ?',
    '0058_session_history'
  )
  expect(await migrateApplicationDatabase(client)).toMatchObject({
    from: '0057_project_optimization_prompt',
    to: '0058_session_history',
    applied: ['0058_session_history']
  })
  expect(await client.project.findUnique({ where: { id: project.id } })).toEqual(project)
  expect(await client.sessionHistoryIndex.count()).toBe(0)
  expect(await client.sessionHistoryItem.count()).toBe(0)
  expect(await migrateApplicationDatabase(client)).toMatchObject({ applied: [] })
  const plan = await client.$queryRawUnsafe<Array<{ detail: string }>>(
    'EXPLAIN QUERY PLAN SELECT payloadJson FROM SessionHistoryItem WHERE sessionId = ? AND ordinal < ? ORDER BY ordinal DESC LIMIT 80',
    'session-1',
    100
  )
  expect(
    plan.some(({ detail }) => detail.includes('SessionHistoryItem_sessionId_ordinal_idx'))
  ).toBe(true)
})

// This checksum is from the published fork, not recomputed from the implementation under test.
const releasedForkHistory = {
  ...legacySessionHistoryMigration,
  checksum: '72e7ec8c0f5f48310f586c1d5487e1734db4aab08765614bc5bbb7e184445fcb',
  backupOnApply: 'required',
  backupRetention: 'retain'
} as const

const createForkDatabase = async (): Promise<PrismaClient> => {
  root = await mkdtemp(join(tmpdir(), 'fork-history-migration-'))
  client = createProjectDbClient(root)
  await createDatabaseAtReleasedManifest(client, [
    ...MIGRATION_MANIFEST.filter(({ id }) => id <= '0050_literature_translation'),
    releasedForkHistory
  ])
  await client.$executeRawUnsafe(
    'INSERT INTO "Project" ("id", "name", "createdAt", "updatedAt") VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
    'existing',
    'Existing project'
  )
  await client.sessionHistoryIndex.create({
    data: {
      sessionId: 'existing-session',
      projectId: 'existing',
      revision: 7,
      sourceFingerprint: 'preserved',
      scopeKey: 'linear',
      headerJson: '{}',
      totalItems: 1,
      items: {
        create: {
          kind: 'message',
          itemId: 'message-1',
          ordinal: 0,
          payloadJson: '{"content":"preserved history"}'
        }
      }
    }
  })
  return client
}

// The intermediate JSONL release used 0055 before upstream assigned that number. Its checksum was
// part of the published fork ledger.
const releasedJsonlHistory = {
  ...jsonlSessionHistory0055Migration,
  checksum: 'a4d625e6ca077ee8d31965e9a8bcabdfa1848e748a0334519d3c0a4e7c9db4b7',
  backupOnApply: 'required',
  backupRetention: 'retain'
} as const

const createJsonl0055Database = async (): Promise<PrismaClient> => {
  root = await mkdtemp(join(tmpdir(), 'jsonl-0055-history-migration-'))
  client = createProjectDbClient(root)
  await createDatabaseAtReleasedManifest(client, [
    ...MIGRATION_MANIFEST.filter(({ id }) => id <= '0054_slurm_job_reliability'),
    releasedJsonlHistory
  ])
  await client.$executeRawUnsafe(
    'INSERT INTO "Project" ("id", "name", "createdAt", "updatedAt") VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
    'existing',
    'Existing project'
  )
  await client.sessionHistoryIndex.create({
    data: {
      sessionId: 'existing-session',
      projectId: 'existing',
      revision: 3,
      sourceFingerprint: 'preserved-0055',
      scopeKey: 'linear',
      headerJson: '{}',
      totalItems: 1,
      items: {
        create: {
          kind: 'message',
          itemId: 'message-0055',
          ordinal: 0,
          payloadJson: '{"content":"preserved 0055 history"}'
        }
      }
    }
  })
  return client
}

it('upgrades the released 0055 JSONL ledger after the upstream suffix', async () => {
  const db = await createJsonl0055Database()
  const before = await db.sessionHistoryIndex.findMany({ include: { items: true } })
  const result = await migrateApplicationDatabase(db)
  expect(result).toMatchObject({
    from: '0055_session_history',
    to: '0058_session_history'
  })
  expect(result.applied).toEqual([
    '0055_session_discussion_parent',
    '0056_compute_kubernetes_workspace',
    '0057_project_optimization_prompt',
    '0058_session_history'
  ])
  expect(await db.sessionHistoryIndex.findMany({ include: { items: true } })).toEqual(before)
  expect(await db.$queryRawUnsafe('SELECT id FROM _open_science_migrations ORDER BY id')).toEqual(
    MIGRATION_MANIFEST.map(({ id }) => ({ id }))
  )
  expect(await readdir(root!)).toContain(
    'open-science.db.before-0055_session_discussion_parent.backup'
  )
  expect(await migrateApplicationDatabase(db)).toMatchObject({
    applied: [],
    to: '0058_session_history'
  })
})

it('resumes the released 0055 JSONL upgrade after an interrupted upstream suffix', async () => {
  const db = await createJsonl0055Database()
  const before = await db.sessionHistoryIndex.findMany({ include: { items: true } })
  await expect(
    migrateApplicationDatabase(db, {
      onProgress: (progress) => {
        if (
          progress.phase === 'migrating' &&
          progress.migrationId === '0056_compute_kubernetes_workspace'
        )
          throw new Error('simulated restart after bridge')
      }
    })
  ).rejects.toThrow('simulated restart after bridge')
  // The frozen fork row is gone and the upstream suffix has started, but derived history and
  // authority data must survive the restart unchanged.
  expect(
    await db.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT "id" FROM "_open_science_migrations" WHERE "id" = ?',
      '0055_session_history'
    )
  ).toEqual([])
  expect(await db.sessionHistoryIndex.findMany({ include: { items: true } })).toEqual(before)

  const result = await migrateApplicationDatabase(db)
  expect(result).toMatchObject({
    from: '0055_session_discussion_parent',
    to: '0058_session_history'
  })
  expect(result.applied).toEqual([
    '0056_compute_kubernetes_workspace',
    '0057_project_optimization_prompt',
    '0058_session_history'
  ])
  expect(await db.sessionHistoryIndex.findMany({ include: { items: true } })).toEqual(before)
  expect(await db.$queryRawUnsafe('SELECT id FROM _open_science_migrations ORDER BY id')).toEqual(
    MIGRATION_MANIFEST.map(({ id }) => ({ id }))
  )
})

it.each(['checksum', 'missing-prefix', 'unknown-suffix'] as const)(
  'rejects a tampered released 0055 ledger without rewriting history (%s)',
  async (fault) => {
    const db = await createJsonl0055Database()
    const before = await db.sessionHistoryIndex.findMany({ include: { items: true } })
    if (fault === 'checksum') {
      await db.$executeRawUnsafe(
        'UPDATE "_open_science_migrations" SET "checksum" = ? WHERE "id" = ?',
        '0'.repeat(64),
        '0055_session_history'
      )
    } else if (fault === 'missing-prefix') {
      await db.$executeRawUnsafe(
        'DELETE FROM "_open_science_migrations" WHERE "id" = ?',
        '0054_slurm_job_reliability'
      )
    } else {
      await db.$executeRawUnsafe(
        'INSERT INTO "_open_science_migrations" ("id", "checksum") VALUES (?, ?)',
        '0060_unknown_suffix',
        'a'.repeat(64)
      )
    }
    const tamperedLedger = await db.$queryRawUnsafe<Array<{ id: string; checksum: string }>>(
      'SELECT "id", "checksum" FROM "_open_science_migrations" ORDER BY "id"'
    )
    await expect(migrateApplicationDatabase(db)).rejects.toMatchObject({
      code: 'database_history_invalid',
      migrationId: '0055_session_history'
    })
    expect(
      await db.$queryRawUnsafe<Array<{ id: string; checksum: string }>>(
        'SELECT "id", "checksum" FROM "_open_science_migrations" ORDER BY "id"'
      )
    ).toEqual(tamperedLedger)
    expect(await db.sessionHistoryIndex.findMany({ include: { items: true } })).toEqual(before)
    expect((await readdir(root!)).some((name) => name.includes('.before-'))).toBe(false)
  }
)

it.each([false, true])(
  'upgrades the released fork ledger with a backup and preserves history (interrupted=%s)',
  async (interrupted) => {
    const db = await createForkDatabase()
    const before = await db.sessionHistoryIndex.findMany({ include: { items: true } })
    if (interrupted) {
      await expect(
        migrateApplicationDatabase(db, {
          onProgress: (progress) => {
            if (
              progress.phase === 'migrating' &&
              progress.migrationId === '0052_literature_personal_note_search'
            )
              throw new Error('simulated restart')
          }
        })
      ).rejects.toThrow('simulated restart')
    }
    const result = await migrateApplicationDatabase(db)
    expect(result).toMatchObject({
      from: interrupted ? '0051_literature_reading_status' : '0051_session_history',
      to: '0058_session_history'
    })
    expect(await db.project.findUnique({ where: { id: 'existing' } })).toMatchObject({
      name: 'Existing project'
    })
    expect(await db.sessionHistoryIndex.findMany({ include: { items: true } })).toEqual(before)
    expect(await db.$queryRawUnsafe('SELECT id FROM _open_science_migrations ORDER BY id')).toEqual(
      MIGRATION_MANIFEST.map(({ id }) => ({ id }))
    )
    expect(await readdir(root!)).toContain(
      'open-science.db.before-0051_literature_reading_status.backup'
    )
    expect(await migrateApplicationDatabase(db)).toMatchObject({ applied: [] })
  }
)

it.each(['checksum', 'missing-prefix', 'unknown-suffix'])(
  'rejects a modified fork ledger before touching it (%s)',
  async (damage) => {
    const db = await createForkDatabase()
    if (damage === 'checksum')
      await db.$executeRawUnsafe(
        'UPDATE _open_science_migrations SET checksum = ? WHERE id = ?',
        '0'.repeat(64),
        releasedForkHistory.id
      )
    else if (damage === 'missing-prefix')
      await db.$executeRawUnsafe(
        "DELETE FROM _open_science_migrations WHERE id = '0050_literature_translation'"
      )
    else
      await db.$executeRawUnsafe(
        'INSERT INTO _open_science_migrations (id, checksum) VALUES (?, ?)',
        '0052_unknown_fork_change',
        '0'.repeat(64)
      )
    const before = await db.$queryRawUnsafe('SELECT * FROM _open_science_migrations ORDER BY id')
    await expect(migrateApplicationDatabase(db)).rejects.toMatchObject({
      code: 'database_history_invalid'
    })
    expect(await db.$queryRawUnsafe('SELECT * FROM _open_science_migrations ORDER BY id')).toEqual(
      before
    )
    expect((await readdir(root!)).filter((name) => name.endsWith('.backup'))).toEqual([])
    expect(await db.sessionHistoryItem.count()).toBe(1)
  }
)
