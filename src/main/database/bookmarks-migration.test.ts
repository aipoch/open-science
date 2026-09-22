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

it('installs the Bookmark table with durable ownership, JSON, and paging constraints', async () => {
  root = await mkdtemp(join(tmpdir(), 'bookmarks-migration-'))
  client = createProjectDbClient(root)
  await migrateApplicationDatabase(client)
  await client.$executeRawUnsafe('DROP TABLE "bookmarks"')
  await client.$executeRawUnsafe(
    'DELETE FROM "_open_science_migrations" WHERE id >= \'0041_bookmarks\''
  )

  await expect(
    migrateApplicationDatabase(client, { databasePath: join(root, 'open-science.db') })
  ).resolves.toMatchObject({
    applied: [
      '0041_bookmarks',
      '0042_classification_usage',
      '0043_pdf_annotations',
      '0044_literature_smart_collections'
    ]
  })

  const indexes = await client.$queryRawUnsafe<Array<{ name: string }>>(
    'PRAGMA index_list("bookmarks")'
  )
  expect(indexes.map(({ name }) => name)).toEqual(
    expect.arrayContaining([
      'bookmarks_projectId_sessionId_createdAt_id_idx',
      'bookmarks_projectId_sessionId_sourceKind_sourceId_idx'
    ])
  )
  await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
  expect(await client.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([])
})
