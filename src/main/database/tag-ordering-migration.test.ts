import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createProjectDbClient } from '../projects/prisma-client'
import { tagOrderingMigration } from './migrations/0012-tag-ordering'

describe('Tag ordering migration', () => {
  let root: string
  let client: PrismaClient

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'open-science-tag-ordering-'))
    client = createProjectDbClient(root)
  })

  afterEach(async () => {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  })

  it('backfills the previous visible order and keeps Favorites first', async () => {
    await client.$executeRawUnsafe(`CREATE TABLE "Tag" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "systemKey" TEXT,
      "name" TEXT,
      "nameKey" TEXT,
      "iconKey" TEXT,
      "colorKey" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)
    await client.$executeRawUnsafe(`INSERT INTO "Tag"
      ("id", "systemKey", "updatedAt") VALUES
      ('tag-favorite', 'favorite', CURRENT_TIMESTAMP)`)
    await client.$executeRawUnsafe(`INSERT INTO "Tag"
      ("id", "name", "nameKey", "iconKey", "colorKey", "updatedAt") VALUES
      ('tag-zeta', 'Zeta', 'zeta', 'tag', 'blue', CURRENT_TIMESTAMP),
      ('tag-alpha-b', 'Alpha B', 'alpha-b', 'tag', 'blue', CURRENT_TIMESTAMP),
      ('tag-alpha-a', 'Alpha A', 'alpha-a', 'tag', 'green', CURRENT_TIMESTAMP)`)

    for (const statement of tagOrderingMigration.statements) {
      await client.$executeRawUnsafe(statement)
    }
    const rows = await client.$queryRawUnsafe<Array<{ id: string; sortOrder: number }>>(
      `SELECT "id", "sortOrder" FROM "Tag" ORDER BY "sortOrder" ASC`
    )
    expect(rows).toEqual([
      { id: 'tag-favorite', sortOrder: 0 },
      { id: 'tag-alpha-a', sortOrder: 1 },
      { id: 'tag-alpha-b', sortOrder: 2 },
      { id: 'tag-zeta', sortOrder: 3 }
    ])
  })
})
