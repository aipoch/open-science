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
