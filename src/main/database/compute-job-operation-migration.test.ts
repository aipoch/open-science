import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'

let storageRoot: string | undefined
let disconnect: (() => Promise<void>) | undefined

afterEach(async () => {
  await disconnect?.()
  disconnect = undefined
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

describe('Compute Job operation migration', () => {
  it('replays an unledgered operation suffix without rewriting ComputeJob', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-job-operation-upgrade-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    await client.$executeRawUnsafe(`DROP TABLE "ComputeJobOperation"`)
    await client.$executeRawUnsafe(
      `DELETE FROM "_open_science_migrations" WHERE "id" IN ('0023_compute_job_operation', '0024_compute_job_file_evidence', '0025_managed_file_version_foundation', '0026_compute_job_remote_cleanup', '0027_project_session_defaults', '0028_database_numeric_and_null_constraints')`
    )
    const [{ sql: computeJobSqlBefore }] = await client.$queryRawUnsafe<Array<{ sql: string }>>(
      `SELECT "sql" FROM "sqlite_schema" WHERE "type" = 'table' AND "name" = 'ComputeJob'`
    )

    await migrateApplicationDatabase(client)

    const [{ sql: computeJobSqlAfter }] = await client.$queryRawUnsafe<Array<{ sql: string }>>(
      `SELECT "sql" FROM "sqlite_schema" WHERE "type" = 'table' AND "name" = 'ComputeJob'`
    )
    expect(computeJobSqlAfter).toBe(computeJobSqlBefore)
    await expect(
      client.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "_open_science_migrations" ORDER BY "id" DESC LIMIT 1`
      )
    ).resolves.toEqual([{ id: '0028_database_numeric_and_null_constraints' }])
  })

  it('adds a constrained operation sidecar without rebuilding historical ComputeJob rows', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-job-operation-migration-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    await client.$executeRawUnsafe(`INSERT INTO "ComputeJob" (
      "id", "providerId", "shape", "sessionId", "projectId", "intent", "command", "commandHash", "status"
    ) VALUES ('historical-job', 'ssh:test', 'direct_ssh', 'session-1', 'project-1', 'old work', 'true', 'hash', 'success')`)
    await client.$executeRawUnsafe(`INSERT INTO "ComputeJobOperation" (
      "id", "jobId", "kind", "phase", "revision", "attemptCount", "createdAt", "updatedAt"
    ) VALUES ('cancel:historical-job', 'historical-job', 'cancel', 'active', 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)

    const columns = await client.$queryRawUnsafe<Array<{ name: string }>>(
      `PRAGMA table_info("ComputeJobOperation")`
    )
    // No attentionCode is persisted until the domain has a real closed blocker vocabulary.
    expect(columns.map(({ name }) => name)).toEqual([
      'id',
      'jobId',
      'kind',
      'phase',
      'outcome',
      'revision',
      'attemptCount',
      'eligibleAt',
      'claimToken',
      'claimExpiresAt',
      'createdAt',
      'settledAt',
      'updatedAt'
    ])

    const rejectedUpdates = [
      { label: 'invalid kind', update: `"kind" = 'invalid'` },
      { label: 'settled phase without outcome', update: `"phase" = 'settled'` },
      { label: 'negative attempt count', update: `"attemptCount" = -1` },
      { label: 'non-positive revision', update: `"revision" = 0` },
      { label: 'active outcome', update: `"outcome" = 'fulfilled'` },
      { label: 'unpaired claim token', update: `"claimToken" = 'unpaired'` }
    ]
    for (const { label, update } of rejectedUpdates) {
      await expect(
        client.$executeRawUnsafe(
          `UPDATE "ComputeJobOperation" SET ${update} WHERE "jobId" = 'historical-job'`
        ),
        label
      ).rejects.toThrow(/constraint/i)
    }
    await expect(
      client.$executeRawUnsafe(
        `UPDATE "ComputeJobOperation" SET "phase" = 'settled', "outcome" = 'fulfilled', "settledAt" = CURRENT_TIMESTAMP, "eligibleAt" = CURRENT_TIMESTAMP WHERE "jobId" = 'historical-job'`
      )
    ).rejects.toThrow(/constraint/i)

    const indexes = await client.$queryRawUnsafe<Array<{ name: string; unique: bigint }>>(
      `PRAGMA index_list("ComputeJobOperation")`
    )
    expect(indexes.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'ComputeJobOperation_jobId_kind_key',
        'ComputeJobOperation_kind_phase_eligibleAt_createdAt_idx',
        'ComputeJobOperation_kind_phase_claimExpiresAt_idx'
      ])
    )
    expect(indexes.find(({ name }) => name === 'ComputeJobOperation_jobId_kind_key')?.unique).toBe(
      1n
    )
    const indexColumns = async (name: string): Promise<string[]> =>
      (await client.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA index_info("${name}")`)).map(
        ({ name: column }) => column
      )
    await expect(indexColumns('ComputeJobOperation_jobId_kind_key')).resolves.toEqual([
      'jobId',
      'kind'
    ])
    await expect(
      indexColumns('ComputeJobOperation_kind_phase_eligibleAt_createdAt_idx')
    ).resolves.toEqual(['kind', 'phase', 'eligibleAt', 'createdAt'])
    await expect(
      indexColumns('ComputeJobOperation_kind_phase_claimExpiresAt_idx')
    ).resolves.toEqual(['kind', 'phase', 'claimExpiresAt'])

    const foreignKeys = await client.$queryRawUnsafe<
      Array<{
        from: string
        table: string
        to: string
        on_delete: string
        on_update: string
      }>
    >(`PRAGMA foreign_key_list("ComputeJobOperation")`)
    expect(foreignKeys).toEqual([
      expect.objectContaining({
        from: 'jobId',
        table: 'ComputeJob',
        to: 'id',
        on_delete: 'CASCADE',
        on_update: 'CASCADE'
      })
    ])

    const oldTables = await client.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT "name" FROM "sqlite_schema" WHERE "type" = 'table' AND "name" = 'ComputeJobCancellation'`
    )
    expect(oldTables).toEqual([])

    const computeJobColumns = await client.$queryRawUnsafe<Array<{ name: string }>>(
      `PRAGMA table_info("ComputeJob")`
    )
    expect(computeJobColumns.some(({ name }) => name.toLowerCase().includes('operation'))).toBe(
      false
    )

    await client.$executeRawUnsafe(`DELETE FROM "ComputeJob" WHERE "id" = 'historical-job'`)
    const [{ count }] = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*) AS "count" FROM "ComputeJobOperation"`
    )
    expect(Number(count)).toBe(0)
  })
})
