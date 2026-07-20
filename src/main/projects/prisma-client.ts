import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { PrismaClient } from '@prisma/client'

const PROJECT_DB_FILE = 'open-science.db'

// Exact DDL Prisma generates for the Project model (verified via `prisma migrate diff`). Applying it as
// CREATE TABLE IF NOT EXISTS lets a packaged app create its schema without shipping the migrate engine,
// while staying byte-compatible with what the generated client reads and writes.
const PROJECT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isExample" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);`

// Same runtime-DDL approach for the per-project preview panel state table.
const PREVIEW_STATE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ProjectPreviewState" (
    "projectId" TEXT NOT NULL PRIMARY KEY,
    "panelState" TEXT NOT NULL,
    "activeItemId" TEXT,
    "items" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" DATETIME NOT NULL
);`

// Reviewer results: one Review per audited turn, plus its child checks (stored in Finding table).
// v2 (issue 12): Review no longer has summary/checks JSON columns; all checks are Finding rows.
// v3 (issue 13): reasoning replaced by reviewerLog (captured action stream JSON array).
// Same runtime-DDL approach — applied as CREATE TABLE IF NOT EXISTS so a packaged app stays
// byte-compatible with the generated client.
const REVIEW_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "Review" (
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
);`

// Migration: for existing DBs that still have the old reasoning column, add reviewerLog.
// The reasoning column is simply ignored by the new Prisma client.
const REVIEW_ADD_REVIEWER_LOG_DDL = `ALTER TABLE "Review" ADD COLUMN "reviewerLog" TEXT NOT NULL DEFAULT '[]'`

// Migration: add the `status` column to Finding if it doesn't exist yet (for DBs that have the old
// `severity` column). This is safe to run multiple times (ALTER TABLE ... ADD COLUMN is idempotent
// when guarded by a catch on the DUPLICATE COLUMN error).
const FINDING_ADD_STATUS_COLUMN_DDL = `ALTER TABLE "Finding" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pass'`

// The FOREIGN KEY ... ON DELETE CASCADE matches Prisma's generated DDL; the reviewer repository also
// deletes findings explicitly (deleteReviewsForSession/Project) so cleanup does not depend on the
// SQLite foreign-keys pragma being enabled.
// v2: severity replaced by status ('pass'|'warn'|'fail'); locator is now optional (pass checks omit it).
// v4 (issue 15): added reflagCount column (Phase 3 fix loop re-flag counter).
const FINDING_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "Finding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reviewId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pass',
    "resolution" TEXT NOT NULL DEFAULT 'open',
    "claim" TEXT NOT NULL DEFAULT '',
    "evidence" TEXT NOT NULL DEFAULT '',
    "locator" TEXT NOT NULL DEFAULT '{}',
    "artifactVersionId" TEXT,
    "sortIndex" INTEGER NOT NULL DEFAULT 0,
    "reflagCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Finding_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`

// Migration guard: add the `reflagCount` column to Finding if it doesn't exist yet (for DBs that
// predate issue 15). Idempotent — the catch swallows the duplicate-column error from SQLite (which
// does not support IF NOT EXISTS on ALTER TABLE ADD COLUMN).
const FINDING_ADD_REFLAG_COUNT_DDL = `ALTER TABLE "Finding" ADD COLUMN "reflagCount" INTEGER NOT NULL DEFAULT 0`

// Builds a client bound to the SQLite file under the given storage root. Not a singleton, so tests can
// point separate clients at temp directories. Backslashes are normalized so the file: URL is valid on
// Windows (Prisma's SQLite connector expects forward slashes).
const createProjectDbClient = (storageRoot: string): PrismaClient => {
  const dbPath = join(storageRoot, PROJECT_DB_FILE).replace(/\\/g, '/')

  return new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } })
}

// Creates the schema if missing. Idempotent; no projects are seeded, so a fresh install starts empty.
const ensureProjectSchema = async (client: PrismaClient): Promise<void> => {
  await client.$executeRawUnsafe(PROJECT_TABLE_DDL)
  await client.$executeRawUnsafe(PREVIEW_STATE_TABLE_DDL)
  await client.$executeRawUnsafe(REVIEW_TABLE_DDL)
  await client.$executeRawUnsafe(FINDING_TABLE_DDL)

  // Migration guard: if this is an old DB with `severity` but not `status`, add the status column.
  // Catch ignores the error when the column already exists (no IF NOT EXISTS in SQLite ALTER TABLE).
  await client.$executeRawUnsafe(FINDING_ADD_STATUS_COLUMN_DDL).catch(() => undefined)

  // Migration guard: if this is an old DB with `reasoning` but not `reviewerLog`, add the new column.
  // Catch ignores the error when the column already exists (no IF NOT EXISTS in SQLite ALTER TABLE).
  await client.$executeRawUnsafe(REVIEW_ADD_REVIEWER_LOG_DDL).catch(() => undefined)

  // Migration guard: add reflagCount to Finding for DBs created before issue 15.
  // Catch ignores the error when the column already exists (no IF NOT EXISTS in SQLite ALTER TABLE).
  await client.$executeRawUnsafe(FINDING_ADD_REFLAG_COUNT_DDL).catch(() => undefined)
}

let clientPromise: Promise<PrismaClient> | undefined

// Production singleton: ensures the storage dir exists, connects, and applies the schema.
const getProjectDbClient = (storageRoot: string): Promise<PrismaClient> => {
  if (!clientPromise) {
    const pending = (async () => {
      await mkdir(storageRoot, { recursive: true })

      const client = createProjectDbClient(storageRoot)

      try {
        await ensureProjectSchema(client)
      } catch (error) {
        // Release the connection / query-engine this client opened before the retry cache is cleared,
        // so repeated init failures don't leak a PrismaClient (and its engine subprocess) per attempt.
        await client.$disconnect().catch(() => undefined)
        throw error
      }

      return client
    })()

    clientPromise = pending

    // Do not cache a failed initialization: a transient error (locked db, unwritable dir) would otherwise
    // disable projects for the entire app session. Clearing the cache lets the next call retry. Attaching
    // this handler also keeps an early rejection from becoming an unhandled rejection that could crash the
    // main process at startup — real awaiters still observe it (surfaced via the renderer project store).
    pending.catch(() => {
      if (clientPromise === pending) clientPromise = undefined
    })
  }

  return clientPromise
}

export { createProjectDbClient, ensureProjectSchema, getProjectDbClient }
