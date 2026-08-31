import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase } from './migration-service'

describe('database domain constraints', () => {
  let client: PrismaClient | undefined
  let storageRoot: string | undefined

  afterEach(async () => {
    await client?.$disconnect()
    if (storageRoot) await rm(storageRoot, { force: true, recursive: true })
  })

  it('rejects domain values that bypass the TypeScript write boundaries', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-domain-constraints-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)

    await client.$executeRawUnsafe(
      `INSERT INTO "Review" ("id","projectId","sessionId","turnMessageId","lifecycle","updatedAt") VALUES ('base-review','p','s','m','running',CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "Finding" ("id","reviewId","status") VALUES ('base-finding','base-review','warn')`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ReviewFindingDisposition" ("id","sourceFindingId","sequence","trigger","outcome") VALUES ('base-disposition','base-finding',1,'aborted','unaddressed')`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ComputeJob" ("id","providerId","shape","sessionId","projectId","status","intent","command","commandHash") VALUES ('base-job','ssh:h','direct_ssh','s','p','submitted','i','c','h')`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ComputeHost" ("id","providerId","displayName","sshAlias","updatedAt") VALUES ('base-host','ssh:h','h','h',CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "GrantedLocalRoot" ("id","path","name","access","updatedAt") VALUES ('base-root','/tmp/base','base','ro',CURRENT_TIMESTAMP)`
    )

    const invalidWrites = [
      {
        name: 'Review.lifecycle',
        sql: `UPDATE "Review" SET "lifecycle" = 'unknown' WHERE "id" = 'base-review'`
      },
      {
        name: 'Review.outcome',
        sql: `UPDATE "Review" SET "outcome" = 'unknown' WHERE "id" = 'base-review'`
      },
      {
        name: 'Review running state',
        sql: `UPDATE "Review" SET "outcome" = 'pass' WHERE "id" = 'base-review'`
      },
      {
        name: 'Review complete state',
        sql: `UPDATE "Review" SET "lifecycle" = 'complete' WHERE "id" = 'base-review'`
      },
      {
        name: 'Review error state',
        sql: `UPDATE "Review" SET "lifecycle" = 'error' WHERE "id" = 'base-review'`
      },
      {
        name: 'Finding.status',
        sql: `UPDATE "Finding" SET "status" = 'unknown' WHERE "id" = 'base-finding'`
      },
      {
        name: 'Finding.resolution',
        sql: `UPDATE "Finding" SET "resolution" = 'unknown' WHERE "id" = 'base-finding'`
      },
      {
        name: 'Finding.artifactBindingState',
        sql: `UPDATE "Finding" SET "artifactBindingState" = 'unknown' WHERE "id" = 'base-finding'`
      },
      {
        name: 'Finding.sortIndex',
        sql: `UPDATE "Finding" SET "sortIndex" = -1 WHERE "id" = 'base-finding'`
      },
      {
        name: 'Finding.reflagCount',
        sql: `UPDATE "Finding" SET "reflagCount" = -1 WHERE "id" = 'base-finding'`
      },
      {
        name: 'Finding pass resolution',
        sql: `UPDATE "Finding" SET "status" = 'pass', "resolution" = 'resolved' WHERE "id" = 'base-finding'`
      },
      {
        name: 'Finding validated artifact binding',
        sql: `UPDATE "Finding" SET "artifactBindingState" = 'scope_validated' WHERE "id" = 'base-finding'`
      },
      {
        name: 'ReviewFindingDisposition.sequence',
        sql: `UPDATE "ReviewFindingDisposition" SET "sequence" = 0 WHERE "id" = 'base-disposition'`
      },
      {
        name: 'ReviewFindingDisposition.trigger',
        sql: `UPDATE "ReviewFindingDisposition" SET "trigger" = 'unknown' WHERE "id" = 'base-disposition'`
      },
      {
        name: 'ReviewFindingDisposition.outcome',
        sql: `UPDATE "ReviewFindingDisposition" SET "outcome" = 'unknown' WHERE "id" = 'base-disposition'`
      },
      {
        name: 'ReviewFindingDisposition review submission cause',
        sql: `UPDATE "ReviewFindingDisposition" SET "trigger" = 'review_submission', "outcome" = 'resolved' WHERE "id" = 'base-disposition'`
      },
      {
        name: 'ReviewFindingDisposition review submission outcome',
        sql: `UPDATE "ReviewFindingDisposition" SET "trigger" = 'review_submission', "causeReviewId" = 'base-review' WHERE "id" = 'base-disposition'`
      },
      {
        name: 'ReviewFindingDisposition terminal cause',
        sql: `UPDATE "ReviewFindingDisposition" SET "causeReviewId" = 'base-review' WHERE "id" = 'base-disposition'`
      },
      {
        name: 'ReviewFindingDisposition terminal outcome',
        sql: `UPDATE "ReviewFindingDisposition" SET "outcome" = 'resolved' WHERE "id" = 'base-disposition'`
      },
      {
        name: 'ComputeJob.shape',
        sql: `UPDATE "ComputeJob" SET "shape" = 'unknown' WHERE "id" = 'base-job'`
      },
      {
        name: 'ComputeJob.status',
        sql: `UPDATE "ComputeJob" SET "status" = 'unknown' WHERE "id" = 'base-job'`
      },
      {
        name: 'ComputeJob.errorCode',
        sql: `UPDATE "ComputeJob" SET "errorCode" = 'unknown' WHERE "id" = 'base-job'`
      },
      {
        name: 'ComputeJob.timeoutSeconds lower bound',
        sql: `UPDATE "ComputeJob" SET "timeoutSeconds" = 0 WHERE "id" = 'base-job'`
      },
      {
        name: 'ComputeJob.timeoutSeconds upper bound',
        sql: `UPDATE "ComputeJob" SET "timeoutSeconds" = 604801 WHERE "id" = 'base-job'`
      },
      {
        name: 'ComputeJob notification state',
        sql: `UPDATE "ComputeJob" SET "notificationConsumedAt" = CURRENT_TIMESTAMP WHERE "id" = 'base-job'`
      },
      {
        name: 'ComputeJob analysis state',
        sql: `UPDATE "ComputeJob" SET "analysisState" = 'unknown' WHERE "id" = 'base-job'`
      },
      {
        name: 'ComputeJob partial analysis identity',
        sql: `UPDATE "ComputeJob" SET "analysisState" = 'dispatched' WHERE "id" = 'base-job'`
      },
      {
        name: 'ComputeJob blank analysis Message identity',
        sql: `UPDATE "ComputeJob" SET "analysisState" = 'dispatched', "analysisMessageId" = ' ', "analysisUpdatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'base-job'`
      },
      {
        name: 'ComputeJob succeeded analysis consumption',
        sql: `UPDATE "ComputeJob" SET "notifiedAt" = CURRENT_TIMESTAMP, "analysisState" = 'succeeded', "analysisMessageId" = 'analysis-message', "analysisUpdatedAt" = CURRENT_TIMESTAMP, "notificationConsumedAt" = NULL WHERE "id" = 'base-job'`
      },
      {
        name: 'ComputeJob harvest payload',
        sql: `UPDATE "ComputeJob" SET "harvestError" = 'failed' WHERE "id" = 'base-job'`
      },
      {
        name: 'ComputeJob harvest state',
        sql: `UPDATE "ComputeJob" SET "harvestedAt" = CURRENT_TIMESTAMP WHERE "id" = 'base-job'`
      },
      {
        name: 'ComputeJob error code state',
        sql: `UPDATE "ComputeJob" SET "errorCode" = 'dispatch_failed' WHERE "id" = 'base-job'`
      },
      {
        name: 'ComputeJob error status state',
        sql: `UPDATE "ComputeJob" SET "status" = 'error' WHERE "id" = 'base-job'`
      },
      {
        name: 'ComputeHost.shape',
        sql: `UPDATE "ComputeHost" SET "shape" = 'unknown' WHERE "id" = 'base-host'`
      },
      {
        name: 'ComputeHost.scratchPinned',
        sql: `UPDATE "ComputeHost" SET "scratchPinned" = 2 WHERE "id" = 'base-host'`
      },
      {
        name: 'ComputeHost.concurrencyLimit',
        sql: `UPDATE "ComputeHost" SET "concurrencyLimit" = 0 WHERE "id" = 'base-host'`
      },
      {
        name: 'ComputeHost.concurrencyLimit upper bound',
        sql: `UPDATE "ComputeHost" SET "concurrencyLimit" = 501 WHERE "id" = 'base-host'`
      },
      {
        name: 'ComputeHost.detailsUpdatedBy',
        sql: `UPDATE "ComputeHost" SET "detailsUpdatedBy" = 'unknown' WHERE "id" = 'base-host'`
      },
      {
        name: 'ComputeHost details author without time',
        sql: `UPDATE "ComputeHost" SET "detailsUpdatedBy" = 'agent' WHERE "id" = 'base-host'`
      },
      {
        name: 'ComputeHost details time without author',
        sql: `UPDATE "ComputeHost" SET "detailsUpdatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'base-host'`
      },
      {
        name: 'ComputeHost pinned scratch root',
        sql: `UPDATE "ComputeHost" SET "scratchPinned" = true WHERE "id" = 'base-host'`
      },
      {
        name: 'GrantedLocalRoot.access',
        sql: `UPDATE "GrantedLocalRoot" SET "access" = 'admin' WHERE "id" = 'base-root'`
      }
    ]

    const accepted: string[] = []
    for (const invalidWrite of invalidWrites) {
      try {
        await client.$executeRawUnsafe(invalidWrite.sql)
        accepted.push(invalidWrite.name)
      } catch {
        // Expected: the SQLite CHECK contract rejects the write.
      }
    }
    expect(accepted).toEqual([])
  })
})
