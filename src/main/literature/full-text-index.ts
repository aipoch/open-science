import { createLogger } from '@aipoch/diagnostics/node'
import { LiteratureIndex, type IndexDatabase } from '@aipoch/literature-reading'
import { PrismaClient, type Prisma } from '@prisma/client'
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { migrationSqlExecutor } from '../database/migration-sql-executor'
import {
  acquireDataRootWriter,
  isMigrationPending,
  withDataRootWrite
} from '../storage/migration-state'
const log = createLogger('literature-reading-context')
export const literatureIndexPath = (storageRoot: string): string =>
  join(storageRoot, 'literature', 'literature-fulltext.sqlite').replace(/\\/g, '/')
const owners = new Map<string, LiteratureIndex>()
const adapt = (
  client: PrismaClient | Prisma.TransactionClient,
  root?: PrismaClient
): IndexDatabase => ({
  execute: (sql, ...values) => migrationSqlExecutor.execute(client, sql, ...values),
  query: (sql, ...values) => migrationSqlExecutor.query(client, sql, ...values),
  transaction: (operation) => {
    if (!root) throw new Error('Nested Literature index transaction.')
    return root.$transaction((tx) => operation(adapt(tx)))
  },
  close: () => (root ? root.$disconnect() : Promise.resolve())
})
export const literatureIndex = (storageRoot: string): LiteratureIndex => {
  const path = literatureIndexPath(storageRoot)
  let owner = owners.get(path)
  if (!owner) {
    owner = new LiteratureIndex({
      open: async () => {
        await mkdir(join(storageRoot, 'literature'), { recursive: true })
        const client = new PrismaClient({
          datasources: { db: { url: `file:${path}?connection_limit=1` } }
        })
        return adapt(client, client)
      },
      exists: async () => {
        try {
          await access(path)
          return true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw error
        }
      },
      maintenance: async (operation) => {
        if (isMigrationPending()) return
        const release = acquireDataRootWriter()
        try {
          await withDataRootWrite(operation)
        } finally {
          release()
        }
      },
      log: (message, fields) => log.info(message, fields)
    })
    owners.set(path, owner)
  }
  return owner
}
