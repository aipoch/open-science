import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { PrismaClient } from '@prisma/client'

import type { SchemaMigrationOptions } from '../database/migration-service.js'

const PROJECT_DB_FILE = 'open-science.db'
// SQLite PRAGMAs used by migrations are connection-scoped. Keeping a single connection also avoids
// unnecessary SQLITE_BUSY contention for the local application database.
const PROJECT_DB_CONNECTION_LIMIT = 1
const projectDatabasePath = (configRoot: string): string =>
  join(configRoot, PROJECT_DB_FILE).replace(/\\/g, '/')

// Builds a client bound to the SQLite file under the given config root. Not a singleton, so tests can
// point separate clients at temp directories. Backslashes are normalized so the file: URL is valid on
// Windows (Prisma's SQLite connector expects forward slashes).
const createProjectDbClient = (configRoot: string): PrismaClient => {
  const dbPath = projectDatabasePath(configRoot)

  return new PrismaClient({
    datasources: {
      db: { url: `file:${dbPath}?connection_limit=${PROJECT_DB_CONNECTION_LIMIT}` }
    }
  })
}

let clientPromise: Promise<PrismaClient> | undefined

// The migration manifest is evaluated only when a client is opened, not when this module loads.
const loadMigrationService = (): Promise<typeof import('../database/migration-service.js')> =>
  import('../database/migration-service.js')

// Production singleton: ensures the storage directory exists and resolves only after schema verification.
const getProjectDbClient = (
  configRoot: string,
  migrationOptions: SchemaMigrationOptions = {}
): Promise<PrismaClient> => {
  if (!clientPromise) {
    const pending = (async () => {
      let client: PrismaClient | undefined
      let migrationService: Awaited<ReturnType<typeof loadMigrationService>> | undefined

      try {
        migrationService = await loadMigrationService()
        await mkdir(configRoot, { recursive: true })
        client = createProjectDbClient(configRoot)
        await migrationService.migrateApplicationDatabase(client, {
          ...migrationOptions,
          databasePath: projectDatabasePath(configRoot)
        })
      } catch (error) {
        await client?.$disconnect().catch(() => undefined)
        throw migrationService?.classifyDatabaseFailure(error, 'open') ?? error
      }

      return client
    })()

    clientPromise = pending
    pending.catch(() => {
      if (clientPromise === pending) clientPromise = undefined
    })
  }

  return clientPromise
}

// Releases the process-wide authority-store connection before operations that require an exclusive
// SQLite checkpoint. The next repository read lazily creates a fresh client.
const disconnectProjectDbClient = async (): Promise<void> => {
  const pending = clientPromise
  if (!pending) return

  clientPromise = undefined
  const client = await pending.catch(() => undefined)
  await client?.$disconnect()
}

const migrateApplicationDatabase = (
  client: PrismaClient,
  options?: SchemaMigrationOptions
): ReturnType<(typeof import('../database/migration-service.js'))['migrateApplicationDatabase']> =>
  loadMigrationService().then(({ migrateApplicationDatabase }) =>
    migrateApplicationDatabase(client, options)
  )

export {
  createProjectDbClient,
  disconnectProjectDbClient,
  getProjectDbClient,
  migrateApplicationDatabase
}
