import { LiteraturePublicationChecker } from '@aipoch/literature-discovery'
import type { LiteraturePublicationCheckSnapshot } from '@aipoch/literature-discovery/contracts'
import {
  literatureItemInputSchema,
  type LiteratureItemInput
} from '@aipoch/literature-library/item'
import type { PrismaClient } from '@prisma/client'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { migrateApplicationDatabase } from '../database/migration-service'
import { createProjectDbClient } from '../projects/prisma-client'
import { LiteratureCatalog } from './catalog'
import type { LiteratureScreening } from './screening-adapter'

const doi = '10.1234/original'
const snapshot: LiteraturePublicationCheckSnapshot = {
  doi,
  checkedAt: 123,
  notices: [{ doi: '10.1234/correction', type: 'correction', source: 'publisher' }]
}
const itemInput = (value = doi): LiteratureItemInput =>
  literatureItemInputSchema.parse({
    itemType: 'journalArticle',
    title: 'Original article',
    personalNote: 'Keep manual assessment',
    rating: 4,
    identifiers: [{ scheme: 'doi', value }]
  })

describe('publication check persistence', () => {
  let schemaRoot: string
  let storageRoot: string
  let client: PrismaClient
  beforeAll(async () => {
    schemaRoot = await mkdtemp(join(tmpdir(), 'publication-check-schema-'))
    const schemaClient = createProjectDbClient(schemaRoot)
    try {
      await migrateApplicationDatabase(schemaClient)
    } finally {
      await schemaClient.$disconnect()
    }
  })
  afterEach(async () => {
    await client?.$disconnect()
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  })
  afterAll(async () => {
    if (schemaRoot) await rm(schemaRoot, { recursive: true, force: true })
  })
  const setup = async (): Promise<{
    catalog: LiteratureCatalog
    writer: LiteratureCatalog
    id: string
    changed: ReturnType<typeof vi.fn>
    schedule: ReturnType<typeof vi.fn>
  }> => {
    storageRoot = await mkdtemp(join(tmpdir(), 'publication-check-catalog-'))
    await copyFile(join(schemaRoot, 'open-science.db'), join(storageRoot, 'open-science.db'))
    client = createProjectDbClient(storageRoot)
    const catalog = new LiteratureCatalog(async () => client)
    const { id } = await catalog.transact({ kind: 'create-item', item: itemInput() })
    const changed = vi.fn()
    const schedule = vi.fn()
    const writer = new LiteratureCatalog(
      async () => client,
      undefined,
      undefined,
      undefined,
      changed,
      { schedule } as unknown as LiteratureScreening
    )
    return { catalog, writer, id, changed, schedule }
  }

  it('persists on reopen and replaces the same DOI source without changing metadata or screening', async () => {
    const { catalog, writer, id, changed, schedule } = await setup()
    await client.literatureCollection.create({
      data: {
        id: 'collection',
        name: 'Screened',
        nameKey: 'screened',
        smart: { create: { scopeKind: 'library' } }
      }
    })
    await client.literatureSmartAssessment.create({
      data: {
        collectionId: 'collection',
        itemId: id,
        ruleRevision: 1,
        inputDigest: 'digest',
        policyKey: 'policy',
        verdict: 'match',
        model: 'test'
      }
    })
    await client.literatureSmartOverride.create({
      data: { collectionId: 'collection', itemId: id, decision: 'include' }
    })
    const beforeItem = await client.literatureItem.findUnique({ where: { id } })
    const beforeAssessments = await client.literatureSmartAssessment.findMany()
    const beforeOverrides = await client.literatureSmartOverride.findMany()
    await writer.savePublicationCheck({ itemId: id, expectedMetadataRevision: 1, snapshot })
    const first = (await catalog.sources(id))[0]
    expect(first).toMatchObject({
      provider: 'crossref-publication-check',
      externalId: doi,
      sourceUrl: 'https://api.crossref.org/works/10.1234%2Foriginal',
      rawMetadata: snapshot
    })
    await client.$disconnect()
    client = createProjectDbClient(storageRoot)
    expect((await catalog.sources(id))[0]).toEqual(first)
    const newer = { ...snapshot, checkedAt: 456, notices: [] }
    await writer.savePublicationCheck({ itemId: id, expectedMetadataRevision: 1, snapshot: newer })
    expect(await catalog.sources(id)).toEqual([
      expect.objectContaining({ id: first.id, rawMetadata: newer })
    ])
    expect(await client.literatureItem.findUnique({ where: { id } })).toEqual(beforeItem)
    expect(await client.literatureSmartAssessment.findMany()).toEqual(beforeAssessments)
    expect(await client.literatureSmartOverride.findMany()).toEqual(beforeOverrides)
    expect(schedule).not.toHaveBeenCalled()
    expect(changed).toHaveBeenCalledTimes(2)
    expect(changed).toHaveBeenLastCalledWith({ itemIds: [id], revision: 2 })
  })

  it('rejects stale revisions and DOI changes atomically while preserving the previous check', async () => {
    const { catalog, writer, id, changed } = await setup()
    await writer.savePublicationCheck({ itemId: id, expectedMetadataRevision: 1, snapshot })
    const saved = await catalog.sources(id)
    await catalog.transact({
      kind: 'update-item',
      itemId: id,
      expectedMetadataRevision: 1,
      item: { ...itemInput(), title: 'Changed title' }
    })
    await expect(
      writer.savePublicationCheck({ itemId: id, expectedMetadataRevision: 1, snapshot })
    ).rejects.toThrow('revision conflict')
    expect(await catalog.sources(id)).toEqual(saved)
    await catalog.transact({
      kind: 'update-item',
      itemId: id,
      expectedMetadataRevision: 2,
      item: itemInput('10.1234/changed')
    })
    await expect(
      writer.savePublicationCheck({ itemId: id, expectedMetadataRevision: 3, snapshot })
    ).rejects.toThrow('revision conflict')
    expect(await catalog.sources(id)).toEqual(saved)
    expect(changed).toHaveBeenCalledTimes(1)
    const fetch = vi.fn()
    const checker = new LiteraturePublicationChecker({ catalog, fetch })
    await expect(
      checker.run({ mode: 'get', itemId: id, expectedMetadataRevision: 3 })
    ).resolves.toEqual({ itemId: id, metadataRevision: 3 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['deleted', 'merged', 'missing'] as const)(
    'rejects the original %s item rather than redirecting writes',
    async (state) => {
      const { catalog, writer, id, changed } = await setup()
      await writer.savePublicationCheck({ itemId: id, expectedMetadataRevision: 1, snapshot })
      let targetId = id
      if (state === 'deleted') {
        await catalog.transact({ kind: 'set-item-lifecycle', itemIds: [id], state: 'deleted' })
      } else if (state === 'merged') {
        const survivor = await catalog.transact({
          kind: 'create-item',
          item: { ...itemInput(), identifiers: [], title: 'Survivor' }
        })
        const reviewed = await Promise.all([survivor.id, id].map((itemId) => catalog.get(itemId)))
        await catalog.transact({
          kind: 'merge-items',
          survivorId: survivor.id,
          duplicateIds: [id],
          expectedMetadataRevision: reviewed[0]!.metadataRevision,
          expectedItems: reviewed.map((view) => ({
            id: view!.id,
            metadataRevision: view!.metadataRevision,
            updatedAt: view!.updatedAt
          })),
          item: reviewed[0]!.item
        })
        targetId = survivor.id
        expect((await catalog.get(id))?.id).toBe(survivor.id)
      }
      const sources = await client.literatureSourceRecord.findMany({ where: { itemId: targetId } })
      await expect(
        writer.savePublicationCheck({
          itemId: state === 'missing' ? 'missing' : id,
          expectedMetadataRevision: 1,
          snapshot: { ...snapshot, checkedAt: 999 }
        })
      ).rejects.toThrow('unavailable')
      expect(await client.literatureSourceRecord.findMany({ where: { itemId: targetId } })).toEqual(
        sources
      )
      expect(changed).toHaveBeenCalledTimes(1)
    }
  )

  it('preserves saved data on network failure and rejects invalid snapshots before any write', async () => {
    const { catalog, writer, id, changed } = await setup()
    await writer.savePublicationCheck({ itemId: id, expectedMetadataRevision: 1, snapshot })
    const before = await catalog.sources(id)
    const checker = new LiteraturePublicationChecker({
      catalog,
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 503 }))
    })
    await expect(
      checker.run({ mode: 'check', itemId: id, expectedMetadataRevision: 1 })
    ).resolves.toMatchObject({ issue: 'unavailable', snapshot })
    for (const invalid of [
      { ...snapshot, doi: 'https://doi.org/' + doi },
      { ...snapshot, notices: [{ ...snapshot.notices[0], source: 'untrusted' }] },
      { ...snapshot, url: 'https://example.test' }
    ]) {
      await expect(
        writer.savePublicationCheck({
          itemId: id,
          expectedMetadataRevision: 1,
          snapshot: invalid as LiteraturePublicationCheckSnapshot
        })
      ).rejects.toThrow()
    }
    expect(await catalog.sources(id)).toEqual(before)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('checks cancellation again inside the acquired transaction before writing', async () => {
    const { catalog, id } = await setup()
    const controller = new AbortController()
    const changed = vi.fn()
    const realTransaction = client.$transaction.bind(client)
    const observed = {
      ...client,
      $transaction: vi.fn(async (operation, options) =>
        realTransaction(async (tx) => {
          const findUnique = tx.literatureItem.findUnique.bind(tx.literatureItem)
          const model = new Proxy(tx.literatureItem, {
            get(target, property) {
              if (property !== 'findUnique') return Reflect.get(target, property)
              return async (...args: Parameters<typeof findUnique>) => {
                const row = await findUnique(...args)
                controller.abort(new Error('caller cancelled'))
                return row
              }
            }
          })
          return operation(
            new Proxy(tx, {
              get(target, property) {
                return property === 'literatureItem' ? model : Reflect.get(target, property)
              }
            })
          )
        }, options)
      )
    }
    const writer = new LiteratureCatalog(
      async () => observed as unknown as PrismaClient,
      undefined,
      undefined,
      undefined,
      changed
    )
    await expect(
      writer.savePublicationCheck(
        { itemId: id, expectedMetadataRevision: 1, snapshot },
        controller.signal
      )
    ).rejects.toThrow('caller cancelled')
    expect(await catalog.sources(id)).toEqual([])
    expect(changed).not.toHaveBeenCalled()
  })
})
