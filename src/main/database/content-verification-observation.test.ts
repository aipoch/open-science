import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, expect, it } from 'vitest'
import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase } from './migration-service'

let root: string
let client: PrismaClient | undefined
afterEach(async () => {
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})
it('adds unknown verification observations without changing historical content or state', async () => {
  root = await mkdtemp(join(tmpdir(), 'content-observation-migration-'))
  client = createProjectDbClient(root)
  await migrateApplicationDatabase(client)
  await client.$executeRawUnsafe('ALTER TABLE "ContentBlob" DROP COLUMN "lastVerificationFailure"')
  await client.$executeRawUnsafe(
    'ALTER TABLE "ContentBlob" DROP COLUMN "lastVerificationAttemptAt"'
  )
  await client.$executeRawUnsafe('DROP TABLE "LiteratureMetadataCommitReceipt"')
  await client.$executeRawUnsafe(
    `DELETE FROM "_open_science_migrations" WHERE "id" >= '0036_content_verification_observation'`
  )
  await client.$executeRawUnsafe(
    `INSERT INTO "ContentBlob" ("id", "checksum", "storageKey", "sizeBytes", "state") VALUES ('old', ?, 'content/old', 10, 'available')`,
    'a'.repeat(64)
  )
  await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
    applied: [
      '0036_content_verification_observation',
      '0037_literature_inbox_integrity',
      '0038_literature_search_text',
      '0039_literature_metadata_commit_receipt',
      '0040_literature_collection_revision'
    ]
  })
  expect(await client.contentBlob.findUnique({ where: { id: 'old' } })).toMatchObject({
    state: 'available',
    sizeBytes: 10n,
    storageKey: 'content/old',
    lastVerificationFailure: null,
    lastVerificationAttemptAt: null
  })
  await client.contentBlob.update({
    where: { id: 'old' },
    data: { lastVerificationFailure: 'missing', lastVerificationAttemptAt: new Date() }
  })
  await client.$disconnect()
  client = createProjectDbClient(root)
  await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
  expect(await client.contentBlob.findUnique({ where: { id: 'old' } })).toMatchObject({
    state: 'available',
    lastVerificationFailure: 'missing'
  })
})
