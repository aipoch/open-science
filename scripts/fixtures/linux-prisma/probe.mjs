// No engine override or platform mock: Prisma must choose and load the bundled native engine.
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'

const client = new PrismaClient({ datasources: { db: { url: 'file:/tmp/linux-prisma-smoke.db' } } })
try {
  assert.deepEqual(await client.$queryRaw`SELECT 1 AS ready`, [{ ready: 1n }])
  console.log('Prisma SQLite query passed')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  await client.$disconnect()
}
