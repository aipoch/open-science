import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase } from './migration-service'

let root: string | undefined
let client: ReturnType<typeof createProjectDbClient> | undefined
afterEach(async () => {
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})
it('backfills collection revisions without changing existing values or hierarchy', async () => {
  root = await mkdtemp(join(tmpdir(), 'collection-revision-'))
  client = createProjectDbClient(root)
  await migrateApplicationDatabase(client)
  await client.literatureCollection.create({
    data: { id: 'parent', name: 'Parent', nameKey: 'parent', description: 'Saved description' }
  })
  await client.literatureCollection.create({
    data: { id: 'child', name: 'Child', nameKey: 'child', parentId: 'parent' }
  })
  const sql =
    'SELECT "id", "name", "description", "parentId", "createdAt", "updatedAt" FROM "LiteratureCollection" ORDER BY "id"'
  const before = await client.$queryRawUnsafe(sql)
  await client.$executeRawUnsafe('ALTER TABLE "LiteratureCollection" DROP COLUMN "revision"')
  await client.$executeRawUnsafe(
    'DELETE FROM "_open_science_migrations" WHERE id = \'0040_literature_collection_revision\''
  )
  await expect(
    migrateApplicationDatabase(client, { databasePath: join(root, 'open-science.db') })
  ).resolves.toMatchObject({ applied: ['0040_literature_collection_revision'] })
  expect(await client.$queryRawUnsafe(sql)).toEqual(before)
  expect(await client.literatureCollection.findMany({ select: { revision: true } })).toEqual([
    { revision: 1 },
    { revision: 1 }
  ])
  await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
  expect(await client.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([])
})
