import { numericAndNullConstraintsMigration } from './migrations/0028-database-numeric-and-null-constraints'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createProjectDbClient } from '../projects/prisma-client'
import {
  MIGRATION_MANIFEST,
  migrateApplicationDatabase,
  verifyCurrentApplicationSchema
} from './migration-service'
let root: string
let client: ReturnType<typeof createProjectDbClient>
afterEach(async () => {
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})
it('preserves old usage measurements and admits only the new known source after migration', async () => {
  root = await mkdtemp(join(tmpdir(), 'classification-migration-'))
  client = createProjectDbClient(root)
  await migrateApplicationDatabase(client)
  await client.$executeRawUnsafe(
    `DELETE FROM "_open_science_migrations" WHERE "id" >= '0042_classification_usage'`
  )
  // The empty-database fast path uses today's generated schema even with a historical ledger.
  // Reinstall the released 0028 table to exercise a genuine old CHECK, not the current one.
  await client.$executeRawUnsafe('DROP TABLE "SessionAuxiliaryTurnUsage"')
  const historical = numericAndNullConstraintsMigration.operations[0].tables.find(
    (table) => table.tableName === 'SessionAuxiliaryTurnUsage'
  )!
  await client.$executeRawUnsafe(historical.canonicalTableDdl)
  await client.$executeRawUnsafe(
    'CREATE INDEX "SessionAuxiliaryTurnUsage_completedAtMs_idx" ON "SessionAuxiliaryTurnUsage"("completedAtMs")'
  )
  const insert = (event: string, source: string): Promise<number> =>
    client.$executeRawUnsafe(
      `INSERT INTO "SessionAuxiliaryTurnUsage" ("sessionId", "eventId", "source", "frameworkId", "providerId", "model", "completedAtMs", "inputTokens", "cacheTokens", "outputTokens") VALUES ('session', ?, ?, 'codex', 'provider', 'model', 123, 456, 0, 12)`,
      event,
      source
    )
  await insert('old', 'reviewer')
  const before = await client.$queryRawUnsafe('SELECT * FROM "SessionAuxiliaryTurnUsage"')
  await expect(insert('not-yet', 'classification')).rejects.toThrow()
  await expect(
    migrateApplicationDatabase(client, { databasePath: join(root, 'open-science.db') })
  ).resolves.toMatchObject({
    applied: MIGRATION_MANIFEST.filter((entry) => entry.id >= '0042_classification_usage').map(
      (entry) => entry.id
    )
  })
  expect(await client.$queryRawUnsafe('SELECT * FROM "SessionAuxiliaryTurnUsage"')).toEqual(before)
  await insert('new', 'classification')
  await expect(insert('bad', 'unknown')).rejects.toThrow()
  await expect(verifyCurrentApplicationSchema(client)).resolves.toBeUndefined()
  await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
})
