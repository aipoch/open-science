import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase } from '../database/migration-service'
import { LiteratureCatalog } from './catalog'
import { literatureItemInputSchema } from '../../shared/literature'

it('allows a small catalog write while a large library search is running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'literature-capacity-'))
  const client = createProjectDbClient(root)
  try {
    await migrateApplicationDatabase(client)
    const catalog = new LiteratureCatalog(async () => client)
    const receipt = await catalog.transact({
      kind: 'create-item',
      item: literatureItemInputSchema.parse({
        itemType: 'journalArticle',
        title: 'Capacity reference',
        abstract:
          'A scientific abstract with detailed methods and observations. '.repeat(80) + ' ÉTUDE',
        creators: [
          { nameMode: 'person', givenName: 'Jane', familyName: 'Smith', creatorType: 'author' }
        ]
      })
    })
    if (receipt.kind !== 'item') throw new Error('Expected a reference')
    const { creators, ...template } = await client.literatureItem.findUniqueOrThrow({
      where: { id: receipt.id },
      include: { creators: true }
    })
    // Clone a public-command record to seed scale without tying this regression to derived columns.
    const n = 50000
    for (let offset = 0; offset < n; offset += 500) {
      const ids = Array.from({ length: 500 }, (_, i) => `row-${offset + i}`)
      await client.literatureItem.createMany({ data: ids.map((id) => ({ ...template, id })) })
      await client.literatureItemCreator.createMany({
        data: ids.map((itemId) => ({
          itemId,
          creatorId: creators[0]!.creatorId,
          creatorType: 'author',
          ordinal: 0
        }))
      })
    }
    await client.literatureItem.delete({ where: { id: receipt.id } })
    const start = performance.now()
    const search = catalog.search({ scope: 'library', query: 'ÉTUDE', limit: 25 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const write = catalog.transact({
      kind: 'create-item',
      item: literatureItemInputSchema.parse({ itemType: 'book', title: 'Concurrent new reference' })
    })
    const results = await Promise.allSettled([search, write])
    console.info(
      JSON.stringify({
        records: n,
        durationMs: performance.now() - start,
        outcomes: results.map((result) =>
          result.status === 'rejected'
            ? { status: result.status, error: String(result.reason) }
            : { status: result.status }
        )
      })
    )
    expect(results.filter(({ status }) => status === 'rejected')).toEqual([])
    expect(await search).toMatchObject({ totalCount: n })
  } finally {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
}, 120000)
