import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, expect, it } from 'vitest'
import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase } from './migration-service'

let root: string
let client: PrismaClient
afterEach(async () => {
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})
async function setup(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'translation-migration-'))
  client = createProjectDbClient(root)
  await migrateApplicationDatabase(client)
}
async function dropCurrentTables(): Promise<void> {
  for (const table of ['PdfTranslationBlock', 'PdfTranslation'])
    await client.$executeRawUnsafe(`DROP TABLE "${table}"`)
}
it('upgrades the prior schema with empty unified tables and is idempotent', async () => {
  await setup()
  await dropCurrentTables()
  await client.$executeRawUnsafe('DROP TABLE "PdfTranslationUsage"')
  await client.$executeRawUnsafe(
    'DELETE FROM "_open_science_migrations" WHERE id = ?',
    '0050_literature_translation'
  )
  const item = await client.literatureItem.create({
    data: { itemType: 'journalArticle', title: 'Existing paper' }
  })
  expect(await migrateApplicationDatabase(client)).toMatchObject({
    applied: ['0050_literature_translation']
  })
  expect(await client.literatureItem.findUnique({ where: { id: item.id } })).toEqual(item)
  expect(await client.pdfTranslation.count()).toBe(0)
  expect(
    await client.$queryRawUnsafe(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name='PdfTranslationSource'"
    )
  ).toEqual([])
  expect(await client.pdfTranslationUsage.count()).toBe(0)
  expect(await migrateApplicationDatabase(client)).toMatchObject({ applied: [] })
})
it.each([
  ['unknown', 'a'.repeat(64)],
  ['unreleased development', '87436549f3dd31ca1b104d6c4430c68e8276b1b95b6a6e043aa30bad3ddb51c3']
])(
  'rejects a %s checksum without rewriting history or repairing tables',
  async (_kind, checksum) => {
    await setup()
    await client.$executeRawUnsafe('DROP TABLE "PdfTranslationUsage"')
    await client.$executeRawUnsafe(
      'UPDATE "_open_science_migrations" SET checksum = ? WHERE id = ?',
      checksum,
      '0050_literature_translation'
    )
    const before = await client.$queryRawUnsafe(
      'SELECT * FROM "_open_science_migrations" ORDER BY id'
    )
    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_history_invalid'
    })
    expect(
      await client.$queryRawUnsafe('SELECT * FROM "_open_science_migrations" ORDER BY id')
    ).toEqual(before)
    expect(
      await client.$queryRawUnsafe(
        "SELECT name FROM sqlite_schema WHERE name = 'PdfTranslationUsage'"
      )
    ).toEqual([])
  }
)
