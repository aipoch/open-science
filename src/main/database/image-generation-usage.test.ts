import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createDatabaseAtReleasedManifest } from '../../../test/fixtures/application-database'
import { createProjectDbClient } from '../projects/prisma-client'
import {
  MIGRATION_MANIFEST,
  migrateApplicationDatabase,
  migrateApplicationDatabaseWithManifest,
  verifyCurrentApplicationSchema
} from './migration-service'

const historical = MIGRATION_MANIFEST.filter(({ id }) => id < '0060_image_models')
let root: string
let client: ReturnType<typeof createProjectDbClient>
afterEach(async () => {
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})
async function setup(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'image-usage-migration-'))
  client = createProjectDbClient(root)
  await createDatabaseAtReleasedManifest(client, historical)
}
const insert = (source: string, event = source): Promise<number> =>
  client.$executeRawUnsafe(
    `INSERT INTO "SessionAuxiliaryTurnUsage" ("sessionId", "eventId", "source", "frameworkId", "providerId", "model", "completedAtMs", "inputTokens", "cacheTokens", "cachedReadTokens", "cachedWriteTokens", "outputTokens", "modelCallCount") VALUES ('session', ?, ?, 'test', 'provider', 'model', 123, 456, 3, 2, 1, 12, 1)`,
    event,
    source
  )

it('preserves released usage, constraints and indexes, backs up, and rejects older manifests after upgrade', async () => {
  await setup()
  for (const source of [
    'reviewer',
    'side-chat',
    'vision',
    'session-details',
    'host-llm',
    'artifact-code-reconstruction',
    'context-compaction',
    'classification'
  ])
    await insert(source)
  const before = await client.$queryRawUnsafe(
    'SELECT * FROM "SessionAuxiliaryTurnUsage" ORDER BY "eventId"'
  )
  const indexes = await client.$queryRawUnsafe('PRAGMA index_list("SessionAuxiliaryTurnUsage")')
  const foreignKeys = await client.$queryRawUnsafe(
    'PRAGMA foreign_key_list("SessionAuxiliaryTurnUsage")'
  )
  await expect(insert('image-generation')).rejects.toThrow('CHECK')
  let backup: string | undefined
  await expect(
    migrateApplicationDatabase(client, {
      databasePath: join(root, 'open-science.db'),
      onBackupReady: (value) => {
        backup = value.path
      }
    })
  ).resolves.toMatchObject({
    applied: ['0060_image_models']
  })
  expect(backup).toBeTruthy()
  expect((await stat(backup!)).size).toBeGreaterThan(0)
  expect(
    await client.$queryRawUnsafe('SELECT * FROM "SessionAuxiliaryTurnUsage" ORDER BY "eventId"')
  ).toEqual(before)
  expect(await client.$queryRawUnsafe('PRAGMA index_list("SessionAuxiliaryTurnUsage")')).toEqual(
    indexes
  )
  expect(
    await client.$queryRawUnsafe('PRAGMA foreign_key_list("SessionAuxiliaryTurnUsage")')
  ).toEqual(foreignKeys)
  await insert('image-generation')
  await expect(insert('image-generation')).rejects.toThrow()
  await expect(insert('unknown')).rejects.toThrow('CHECK')
  await expect(verifyCurrentApplicationSchema(client)).resolves.toBeUndefined()
  await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
  await expect(migrateApplicationDatabaseWithManifest(client, historical)).rejects.toMatchObject({
    code: 'database_newer_than_app'
  })
})

it('rolls back without dropping unknown historical columns or committing the new ledger entry', async () => {
  await setup()
  await insert('reviewer')
  await client.$executeRawUnsafe(
    'ALTER TABLE "SessionAuxiliaryTurnUsage" ADD COLUMN "unexpected" TEXT'
  )
  await client.$executeRawUnsafe(`UPDATE "SessionAuxiliaryTurnUsage" SET "unexpected" = 'keep-me'`)
  const before = await client.$queryRawUnsafe('SELECT * FROM "SessionAuxiliaryTurnUsage"')
  await expect(
    migrateApplicationDatabase(client, { databasePath: join(root, 'open-science.db') })
  ).rejects.toThrow()
  expect(await client.$queryRawUnsafe('SELECT * FROM "SessionAuxiliaryTurnUsage"')).toEqual(before)
  expect(
    await client.$queryRawUnsafe(
      `SELECT id FROM "_open_science_migrations" WHERE id='0060_image_models'`
    )
  ).toEqual([])
  await expect(insert('image-generation')).rejects.toThrow('CHECK')
})
