import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ProjectRepository } from './repository'
import { createProjectDbClient, ensureProjectSchema } from './prisma-client'
import { ReviewRepository } from '../reviewer/repository'

// Proves the runtime CREATE TABLE IF NOT EXISTS DDL is byte-compatible with the generated Prisma client
// against a real (temp) SQLite database. Requires the query engine, which is present in dev installs.

let storageRoot: string | undefined
let disconnect: (() => Promise<void>) | undefined

afterEach(async () => {
  await disconnect?.()
  disconnect = undefined

  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('project prisma client (integration)', () => {
  it('ensures the schema (no seed) and round-trips CRUD', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-projects-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await ensureProjectSchema(client)

    const repository = new ProjectRepository(() => Promise.resolve(client))

    // A fresh install starts with no projects; the user creates the first one.
    expect(await repository.list()).toEqual([])

    // Ensuring again is idempotent (table already exists, still no seed).
    await ensureProjectSchema(client)
    expect(await repository.list()).toEqual([])

    const indexes = await client.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('ManagedFile', 'ManagedFileSessionSync')`
    )
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        'ManagedFile_projectId_source_sourceFileId_key',
        'ManagedFile_projectId_source_storageKey_key',
        'ManagedFile_projectId_source_deletedAt_sortAtMs_seq_idx',
        'ManagedFile_projectId_sessionId_source_deletedAt_sortAtMs_seq_idx',
        'ManagedFileSessionSync_projectId_deletedAt_groupSortAtMs_sessionId_idx'
      ])
    )

    // Create reads/writes every column type Prisma expects (TEXT, BOOLEAN, DATETIME defaults).
    const created = await repository.create({ name: 'Reproduction', description: 'demo' })
    expect(created.name).toBe('Reproduction')
    expect(created.description).toBe('demo')
    expect(created.isExample).toBe(false)
    expect(created.createdAt).toBeGreaterThan(0)
    expect(created.updatedAt).toBeGreaterThan(0)

    const fetched = await repository.get(created.id)
    expect(fetched?.name).toBe('Reproduction')

    const renamed = await repository.update({ id: created.id, name: 'Renamed' })
    expect(renamed.name).toBe('Renamed')

    // Any project is deletable — there is no protected default.
    await repository.delete(created.id)
    expect(await repository.get(created.id)).toBeNull()
    expect(await repository.list()).toEqual([])
  })

  // Verifies the runtime FINDING_TABLE_DDL + migration guard are byte-compatible with the Prisma
  // generated client for the reflagCount column (issue 15).
  it('Finding.reflagCount DDL column is Prisma-compatible and migration guard is idempotent', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-reflag-parity-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    // Fresh install: FINDING_TABLE_DDL already contains reflagCount; client can read/write it.
    await ensureProjectSchema(client)

    const reviewRepo = new ReviewRepository(() => Promise.resolve(client))

    const review = await reviewRepo.createReview({
      projectId: 'p1',
      sessionId: 's1',
      turnMessageId: 'm1',
      scope: { turnMessageId: 'm1', blocks: [], artifactVersionIds: [] }
    })

    await reviewRepo.addChecks(review.id, [
      { status: 'fail', claim: 'test claim', evidence: 'test evidence', sortIndex: 0 }
    ])

    const [stored] = await reviewRepo.getReviewsForSession('s1')
    // New finding defaults to 0.
    expect(stored.checks[0]!.reflagCount).toBe(0)

    // Increment and verify the Prisma client can read the updated value.
    await reviewRepo.incrementReflagCount(review.id, stored.checks[0]!.id)
    const [updated] = await reviewRepo.getReviewsForSession('s1')
    expect(updated.checks[0]!.reflagCount).toBe(1)

    // Migration guard is idempotent — calling ensureProjectSchema a second time must not throw.
    await expect(ensureProjectSchema(client)).resolves.toBeUndefined()
  })

  // Simulates an old DB that has the Finding table without reflagCount; the migration guard must add
  // the column without error, and existing rows must read back with reflagCount = 0.
  it('migration guard adds reflagCount to an old DB without the column', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-reflag-migrate-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    // Simulate an old DB: create the Finding table WITHOUT reflagCount (pre-issue-15 DDL).
    await client.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Review" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "projectId" TEXT NOT NULL,
      "sessionId" TEXT NOT NULL,
      "turnMessageId" TEXT NOT NULL,
      "scope" TEXT NOT NULL DEFAULT '{}',
      "lifecycle" TEXT NOT NULL DEFAULT 'running',
      "outcome" TEXT,
      "errorMessage" TEXT,
      "model" TEXT NOT NULL DEFAULT '',
      "reviewerLog" TEXT NOT NULL DEFAULT '[]',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)
    await client.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Finding" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "reviewId" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'pass',
      "resolution" TEXT NOT NULL DEFAULT 'open',
      "claim" TEXT NOT NULL DEFAULT '',
      "evidence" TEXT NOT NULL DEFAULT '',
      "locator" TEXT NOT NULL DEFAULT '{}',
      "artifactVersionId" TEXT,
      "sortIndex" INTEGER NOT NULL DEFAULT 0,
      CONSTRAINT "Finding_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`)

    // Insert a row into the old schema (no reflagCount column yet).
    await client.$executeRawUnsafe(
      `INSERT INTO "Review" ("id","projectId","sessionId","turnMessageId","scope","lifecycle","model","reviewerLog","updatedAt") VALUES ('r1','p1','s1','m1','{}','running','','[]',CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "Finding" ("id","reviewId","claim","evidence") VALUES ('f1','r1','old claim','old evidence')`
    )

    // Run ensureProjectSchema — the migration guard must add reflagCount without error.
    await expect(ensureProjectSchema(client)).resolves.toBeUndefined()

    // Running it again is idempotent (guard catches duplicate-column error).
    await expect(ensureProjectSchema(client)).resolves.toBeUndefined()

    // The old row reads back with reflagCount = 0 (the column default).
    const reviewRepo = new ReviewRepository(() => Promise.resolve(client))
    const [stored] = await reviewRepo.getReviewsForSession('s1')
    expect(stored.checks[0]!.reflagCount).toBe(0)
  })
})
