import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Prisma, PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'

describe('BackgroundResultDelivery migration', () => {
  let root: string
  let client: PrismaClient

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'open-science-background-result-delivery-'))
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
  })

  afterEach(async () => {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  })

  const insert = (values: string): Promise<number> =>
    client.$executeRawUnsafe(`
      INSERT INTO "BackgroundResultDelivery" (
        "id", "sourceKind", "sourceId", "projectId", "sessionId", "state",
        "attemptCount", "claimToken", "claimExpiresAt", "continuationMessageId", "updatedAt"
      ) VALUES (${values})
    `)

  it('stores only delivery workflow facts and the final indexes', async () => {
    const columns = await client.$queryRawUnsafe<Array<{ name: string }>>(
      `PRAGMA table_info("BackgroundResultDelivery")`
    )
    expect(columns.map(({ name }) => name)).toEqual([
      'id',
      'sourceKind',
      'sourceId',
      'projectId',
      'sessionId',
      'agentFrameId',
      'state',
      'attemptCount',
      'claimToken',
      'claimExpiresAt',
      'continuationMessageId',
      'createdAt',
      'updatedAt'
    ])

    const indexes = await client.$queryRawUnsafe<Array<{ name: string }>>(`
      SELECT "name" FROM "sqlite_schema"
      WHERE "type" = 'index' AND "tbl_name" = 'BackgroundResultDelivery'
        AND "name" NOT LIKE 'sqlite_autoindex_%'
      ORDER BY "name"
    `)
    expect(indexes.map(({ name }) => name)).toEqual([
      'BackgroundResultDelivery_project_visible_idx',
      'BackgroundResultDelivery_recoverable_claim_idx',
      'BackgroundResultDelivery_sessionId_state_createdAt_id_idx',
      'BackgroundResultDelivery_sourceKind_sourceId_key',
      'BackgroundResultDelivery_sourceKind_state_createdAt_id_idx'
    ])
  })

  it('rejects rows that violate identity, state, claim, or continuation safety', async () => {
    await expect(
      insert(`'valid', 'local-run', 'run-1', 'project-1', 'session-1', 'waiting-result',
        0, NULL, NULL, NULL, CURRENT_TIMESTAMP`)
    ).resolves.toBe(1)

    const invalidRows = [
      `'bad-source', 'other', 'run-2', 'project-1', 'session-1', 'pending', 0, NULL, NULL, NULL, CURRENT_TIMESTAMP`,
      `'bad-state', 'local-run', 'run-3', 'project-1', 'session-1', 'dismissed', 0, NULL, NULL, NULL, CURRENT_TIMESTAMP`,
      `'   ', 'local-run', 'run-4', 'project-1', 'session-1', 'pending', 0, NULL, NULL, NULL, CURRENT_TIMESTAMP`,
      `'negative', 'local-run', 'run-5', 'project-1', 'session-1', 'pending', -1, NULL, NULL, NULL, CURRENT_TIMESTAMP`,
      `'half-claim', 'local-run', 'run-6', 'project-1', 'session-1', 'claimed', 0, 'claim', NULL, NULL, CURRENT_TIMESTAMP`,
      `'claim-on-pending', 'local-run', 'run-7', 'project-1', 'session-1', 'pending', 0, 'claim', CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP`,
      `'dispatch-no-correlation', 'local-run', 'run-8', 'project-1', 'session-1', 'dispatching', 0, 'claim', CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP`,
      `'waiting-correlation', 'local-run', 'run-9', 'project-1', 'session-1', 'waiting-result', 0, NULL, NULL, 'continuation', CURRENT_TIMESTAMP`,
      `'empty-correlation', 'local-run', 'run-10', 'project-1', 'session-1', 'consumed', 0, NULL, NULL, ' ', CURRENT_TIMESTAMP`
    ]

    for (const values of invalidRows) await expect(insert(values)).rejects.toThrow()

    await expect(
      insert(`'duplicate-source', 'local-run', 'run-1', 'project-2', 'session-2', 'pending',
        0, NULL, NULL, NULL, CURRENT_TIMESTAMP`)
    ).rejects.toThrow()
  })

  it('uses the intended indexes without a duplicate full recovery index', async () => {
    const plans = await Promise.all([
      client.$queryRawUnsafe<Array<{ detail: string }>>(`
        EXPLAIN QUERY PLAN SELECT * FROM "BackgroundResultDelivery"
        WHERE "sessionId" = 'session-1' AND "state" = 'pending'
        ORDER BY "createdAt", "id"
      `),
      client.$queryRawUnsafe<Array<{ detail: string }>>(`
        EXPLAIN QUERY PLAN SELECT * FROM "BackgroundResultDelivery"
        WHERE "sourceKind" = 'compute-job' AND "state" = 'pending'
        ORDER BY "createdAt", "id"
      `),
      client.$queryRaw<Array<{ detail: string }>>(Prisma.sql`
        EXPLAIN QUERY PLAN SELECT * FROM "BackgroundResultDelivery"
        WHERE "projectId" = ${'project-1'}
          AND "state" IN ('waiting-result', 'pending', 'claimed', 'dispatching', 'needs-attention')
        ORDER BY "updatedAt" DESC, "id"
      `),
      client.$queryRaw<Array<{ detail: string }>>(Prisma.sql`
        EXPLAIN QUERY PLAN SELECT * FROM "BackgroundResultDelivery"
        WHERE "state" IN ('claimed', 'dispatching') AND "claimExpiresAt" <= ${new Date()}
        ORDER BY "claimExpiresAt", "id"
      `)
    ])

    expect(plans.map((plan) => plan.map(({ detail }) => detail).join('\n'))).toEqual([
      expect.stringContaining('BackgroundResultDelivery_sessionId_state_createdAt_id_idx'),
      expect.stringContaining('BackgroundResultDelivery_sourceKind_state_createdAt_id_idx'),
      expect.stringContaining('BackgroundResultDelivery_project_visible_idx'),
      expect.stringContaining('BackgroundResultDelivery_recoverable_claim_idx')
    ])
  })
})
