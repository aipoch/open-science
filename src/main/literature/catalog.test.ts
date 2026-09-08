import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  literatureCatalogSearchRequestSchema,
  literatureCandidateInputSchema,
  literatureItemInputSchema,
  type LiteratureCandidateInput
} from '../../shared/literature'
import { toCslItem } from '../../shared/literature-csl'
import { buildLiteratureMergeItem } from '../../renderer/src/pages/literature/literature-merge'
import { migrateApplicationDatabase } from '../database/migration-service'
import { createProjectDbClient } from '../projects/prisma-client'
import { LiteratureCatalog, normalizeIdentifier } from './catalog'
import { LiteratureCitationFormatter } from './citation-formatter'
import { TagRepository } from '../tags/repository'
import { TagResourceCatalog } from '../tags/resource-catalog'
import { TagService } from '../tags/service'

describe('Literature identifier normalization', () => {
  it('removes text joined to the end of a DOI before provider lookup', () => {
    expect(normalizeIdentifier('doi', '10.1234/exampleCopyright')).toBe('10.1234/example')
  })
})

const candidate = (
  overrides: {
    doi?: string
    externalId?: string
    provider?: string
    title?: string
  } = {}
): LiteratureCandidateInput =>
  literatureCandidateInputSchema.parse({
    item: {
      itemType: 'journalArticle',
      title: overrides.title ?? 'Corrective Retrieval Augmented Generation',
      abstract: 'A retrieval evaluator improves retrieval-augmented generation.',
      issuedYear: 2024,
      creators: [
        {
          nameMode: 'person',
          givenName: 'Shi-Qi',
          familyName: 'Yan',
          creatorType: 'author'
        }
      ],
      identifiers: [
        {
          scheme: 'doi',
          value: overrides.doi ?? 'https://doi.org/10.1234/CRAG',
          isPrimary: true
        }
      ],
      typeFields: { volume: '1' }
    },
    source: {
      provider: overrides.provider ?? 'crossref',
      externalId: overrides.externalId ?? '10.1234/crag',
      sourceUrl: 'https://example.test/paper',
      rawMetadata: { title: 'Corrective Retrieval Augmented Generation' }
    },
    origin: { kind: 'agent', projectId: 'project-1', sessionId: 'session-1' }
  })

describe('LiteratureCatalog', () => {
  let storageRoot: string | undefined
  let client: PrismaClient | undefined

  afterEach(async () => {
    await client?.$disconnect()
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  })

  const setup = async (): Promise<LiteratureCatalog> => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-literature-catalog-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Research' } })
    return new LiteratureCatalog(async () => client!)
  }

  it.each(['merge', 'delete', 'batch', 'rollback', 'preview'] as const)(
    'publishes tag assignments only after committed catalog changes: %s',
    async (operation) => {
      await setup()
      const catalog = new LiteratureCatalog(
        async () => client!,
        () => tags.notifyAssignmentsChanged()
      )
      const survivor = await catalog.transact({ kind: 'create-item', item: candidate().item })
      const duplicate = await catalog.transact({
        kind: 'create-item',
        item: candidate().item,
        duplicatePolicy: 'separate'
      })
      const publish = vi.fn()
      const tags = new TagService(
        new TagRepository(async () => client!),
        new TagResourceCatalog({
          listSkills: async () => [],
          listConnectors: async () => ({ connectors: [], customServers: [] }),
          listSpecialists: async () => [],
          listLiteratureItems: async () => client!.literatureItem.findMany({ select: { id: true } })
        }),
        { publish }
      )
      await tags.snapshot()
      const before = await tags.setAssignment({
        tagId: 'tag-favorite',
        resourceType: 'literature.item',
        resourceId: duplicate.id,
        assigned: true
      })
      publish.mockClear()
      const reviewed = (
        await Promise.all([catalog.get(survivor.id), catalog.get(duplicate.id)])
      ).map((item) => item!)
      if (operation === 'delete') {
        await catalog.transact({
          kind: 'set-item-lifecycle',
          itemIds: [duplicate.id],
          state: 'deleted'
        })
        await catalog.transact({ kind: 'delete-items-permanently', itemIds: [duplicate.id] })
      } else if (operation === 'batch' || operation === 'preview') {
        await catalog.transact({
          kind: 'merge-duplicates',
          mode: operation === 'preview' ? 'preview' : 'commit',
          groups: [
            [survivor.id, duplicate.id],
            ['missing-a', 'missing-b']
          ],
          strategy: 'oldest',
          expectedItems: reviewed.map(({ id, metadataRevision, updatedAt }) => ({
            id,
            metadataRevision,
            updatedAt
          }))
        })
      } else {
        const merging = catalog.transact({
          kind: 'merge-items',
          survivorId: survivor.id,
          duplicateIds: [duplicate.id],
          expectedMetadataRevision: operation === 'rollback' ? 999 : reviewed[0].metadataRevision,
          expectedItems: reviewed.map(({ id, metadataRevision, updatedAt }) => ({
            id,
            metadataRevision,
            updatedAt
          })),
          item: reviewed[0].item
        })
        if (operation === 'rollback') await expect(merging).rejects.toThrow()
        else await merging
      }
      const assignments = await client!.tagAssignment.findMany({
        where: { resourceType: 'literature.item' }
      })
      const expectedIds =
        operation === 'delete'
          ? []
          : [operation === 'rollback' || operation === 'preview' ? duplicate.id : survivor.id]
      expect(assignments.map(({ resourceId }) => resourceId)).toEqual(expectedIds)
      const after = await tags.snapshot()
      expect(after.assignments.map(({ resourceId }) => resourceId)).toEqual(expectedIds)
      if (operation === 'rollback' || operation === 'preview') {
        expect(after.revision).toBe(before.revision)
        expect(publish).not.toHaveBeenCalled()
        return
      }
      expect.soft(after.revision).toBe(before.revision + 1)
      expect.soft(publish).toHaveBeenCalledTimes(1)
      expect.soft(publish).toHaveBeenCalledWith('tags:changed', { revision: after.revision })
    }
  )

  it.each([
    ['deleted', 'missing'],
    ['active', 'missing'],
    ['deleted', 'alias'],
    ['active', 'alias']
  ] as const)(
    'rolls back an unavailable lifecycle batch when setting %s with a %s item',
    async (state, unavailable) => {
      const catalog = await setup()
      const item = await catalog.transact({ kind: 'create-item', item: candidate().item })
      let unavailableId = 'missing-item'
      if (unavailable === 'alias') {
        const alias = await catalog.transact({
          kind: 'create-item',
          item: candidate({ doi: '10.1234/alias', title: 'Alias' }).item
        })
        const reviewed = (await Promise.all([catalog.get(item.id), catalog.get(alias.id)])).map(
          (view) => view!
        )
        await catalog.transact({
          kind: 'merge-items',
          survivorId: item.id,
          duplicateIds: [alias.id],
          expectedMetadataRevision: reviewed[0].metadataRevision,
          expectedItems: reviewed.map(({ id, metadataRevision, updatedAt }) => ({
            id,
            metadataRevision,
            updatedAt
          })),
          item: reviewed[0].item
        })
        unavailableId = alias.id
      }
      if (state === 'active') {
        await catalog.transact({ kind: 'set-item-lifecycle', itemIds: [item.id], state: 'deleted' })
      }
      const before = await client!.literatureItem.findUniqueOrThrow({ where: { id: item.id } })
      await expect(
        catalog.transact({
          kind: 'set-item-lifecycle',
          itemIds: [item.id, unavailableId],
          state
        })
      ).rejects.toThrow('One or more Literature Items are unavailable.')
      const after = await client!.literatureItem.findUniqueOrThrow({ where: { id: item.id } })
      expect(after.deletedAt).toEqual(before.deletedAt)
    }
  )

  it.each(['project', 'collection'] as const)(
    'counts only visible references in %s navigation while preserving restore links',
    async (scope) => {
      const catalog = await setup()
      const item = await catalog.transact({ kind: 'create-item', item: candidate().item })
      const collection = await catalog.transact({ kind: 'create-collection', name: 'Reading' })
      await catalog.transact({
        kind: 'set-project-item',
        projectId: 'project-1',
        itemId: item.id,
        included: true,
        source: 'library'
      })
      await catalog.transact({
        kind: 'set-collection-item',
        collectionId: collection.id,
        itemId: item.id,
        included: true
      })
      for (const state of ['active', 'deleted', 'active'] as const) {
        await catalog.transact({ kind: 'set-item-lifecycle', itemIds: [item.id], state })
        const list = await catalog.search({
          scope: 'library',
          ...(scope === 'project' ? { projectId: 'project-1' } : { collectionId: collection.id })
        })
        expect(list.totalCount).toBe(state === 'deleted' ? 0 : 1)
        const navigation = await catalog.search({
          scope: scope === 'project' ? 'project-counts' : 'collections'
        })
        const row = navigation.entries.find((entry) =>
          scope === 'project'
            ? 'projectId' in entry && entry.projectId === 'project-1'
            : 'id' in entry && entry.id === collection.id
        )
        expect(row && 'itemCount' in row ? row.itemCount : 0).toBe(list.totalCount)
      }
    }
  )

  it.each(['reuse', 'fill-missing'] as const)(
    'does not silently reuse conflicting import identities with %s',
    async (policy) => {
      const catalog = await setup()
      const a = candidate({ doi: '10.1234/one' }).item
      const b = {
        ...candidate().item,
        identifiers: [{ scheme: 'pmid' as const, value: '12345', isPrimary: true }]
      }
      await catalog.importItems([a, b], undefined, 'separate')
      const incoming = { ...a, identifiers: [...a.identifiers, ...b.identifiers] }
      await expect(catalog.importItems([incoming], undefined, policy)).rejects.toThrow(
        'conflicting identifiers'
      )
    }
  )

  it('does not classify identifiers pointing to different records as an ordinary existing import', async () => {
    const catalog = await setup()
    const a = candidate({ doi: '10.1234/one' }).item
    const b = {
      ...candidate().item,
      identifiers: [{ scheme: 'pmid' as const, value: '12345', isPrimary: true }]
    }
    await catalog.importItems([a, b], undefined, 'separate')
    for (const identifiers of [
      [...a.identifiers, ...b.identifiers],
      [...b.identifiers, ...a.identifiers]
    ]) {
      const [preview] = await catalog.inspectImportItems([{ ...a, identifiers }], [])
      expect(preview.status).not.toBe('existing')
    }
  })

  it('does not fill an empty identifier field with an identity owned by another record', async () => {
    const catalog = await setup()
    const a = candidate({ doi: '10.1234/one' }).item
    const b = {
      ...candidate().item,
      identifiers: [{ scheme: 'pmid' as const, value: '12345', isPrimary: true }]
    }
    const { itemIds } = await catalog.importItems([a, b], undefined, 'separate')
    await catalog
      .importItems(
        [{ ...a, identifiers: [...a.identifiers, ...b.identifiers] }],
        undefined,
        'fill-missing'
      )
      .catch(() => undefined)
    expect((await catalog.get(itemIds[0]))!.item.identifiers).toEqual(
      a.identifiers.map((id) => ({ ...id, value: '10.1234/one' }))
    )
  })

  it('projects the survivor DOI after persisting a reviewed merge with a primary PMID', async () => {
    const catalog = await setup()
    const a = candidate({ doi: '10.1234/obsolete', title: 'Old title' }).item
    const b = {
      ...candidate({ title: 'Preferred title' }).item,
      identifiers: [
        { scheme: 'pmid' as const, value: '67890', isPrimary: true },
        { scheme: 'doi' as const, value: '10.1234/preferred', isPrimary: false }
      ]
    }
    const { itemIds } = await catalog.importItems([a, b], undefined, 'separate')
    const views = await Promise.all(itemIds.map(async (id) => (await catalog.get(id))!))
    await catalog.transact({
      kind: 'merge-items',
      survivorId: itemIds[1],
      duplicateIds: [itemIds[0]],
      expectedItems: views.map(({ id, metadataRevision, updatedAt }) => ({
        id,
        metadataRevision,
        updatedAt
      })),
      expectedMetadataRevision: views[1].metadataRevision,
      item: buildLiteratureMergeItem(views, itemIds[1], {})
    })
    const merged = (await catalog.get(itemIds[1]))!
    expect(merged.item.title).toBe('Preferred title')
    expect(toCslItem(merged.id, merged.item).DOI).toBe('10.1234/preferred')
  })

  it.each(['reuse', 'fill-missing', 'separate'] as const)(
    'handles conflicts within one file with %s atomically',
    async (policy) => {
      const catalog = await setup()
      const a = candidate({ doi: '10.1234/one' }).item
      const b = {
        ...a,
        identifiers: [{ scheme: 'pmid' as const, value: '12345', isPrimary: true }]
      }
      const c = { ...a, identifiers: [...a.identifiers, ...b.identifiers] }
      const entries = await catalog.inspectImportItems([a, b, c], [])
      expect(entries[2]).toMatchObject({
        status: 'conflict',
        conflict: { matches: [{ inputIndex: 0 }, { inputIndex: 1 }] }
      })
      if (policy === 'separate') {
        await expect(catalog.importItems([a, b, c], undefined, policy)).resolves.toMatchObject({
          createdCount: 3,
          reusedCount: 0
        })
      } else {
        await expect(catalog.importItems([a, b, c], undefined, policy)).rejects.toThrow(
          'conflicting identifiers'
        )
        expect(await client!.literatureItem.count()).toBe(0)
      }
    }
  )

  it.each([false, true])(
    'rejects contradictory values of one strong scheme with existing target=%s',
    async (existing) => {
      const catalog = await setup()
      const a = candidate({ doi: '10.1234/one' }).item
      const pmid = { scheme: 'pmid' as const, value: '12345', isPrimary: false }
      if (existing) await catalog.importItems([{ ...a, identifiers: [...a.identifiers, pmid] }])
      const incoming = {
        ...a,
        identifiers: [
          ...(!existing ? a.identifiers : []),
          { scheme: 'doi' as const, value: '10.1234/two', isPrimary: true },
          pmid
        ]
      }
      expect((await catalog.inspectImportItems([incoming], []))[0].status).toBe('conflict')
      await expect(catalog.importItems([incoming])).rejects.toThrow('conflicting identifiers')
      await expect(catalog.importItems([incoming], undefined, 'separate')).resolves.toMatchObject({
        createdCount: 1
      })
    }
  )

  it('reuses consistent identifiers and restores a unique Trash match', async () => {
    const catalog = await setup()
    const input = {
      ...candidate().item,
      identifiers: [
        ...candidate().item.identifiers,
        { scheme: 'pmid' as const, value: '12345', isPrimary: true }
      ]
    }
    const {
      itemIds: [id]
    } = await catalog.importItems([input])
    await catalog.transact({ kind: 'set-item-lifecycle', itemIds: [id], state: 'deleted' })
    for (const identifiers of [input.identifiers, [...input.identifiers].reverse()]) {
      expect((await catalog.inspectImportItems([{ ...input, identifiers }], []))[0]).toMatchObject({
        status: 'existing',
        existingItemId: id
      })
      await expect(catalog.importItems([{ ...input, identifiers }])).resolves.toMatchObject({
        itemIds: [id],
        reusedCount: 1
      })
    }
    expect(await client!.literatureItem.findUnique({ where: { id } })).toMatchObject({
      deletedAt: null
    })
  })

  it('rechecks the current database after preview and preserves Trash and collection links on conflict', async () => {
    const catalog = await setup()
    const a = candidate({ doi: '10.1234/one' }).item
    const b = { ...a, identifiers: [{ scheme: 'pmid' as const, value: '12345', isPrimary: true }] }
    const {
      itemIds: [id]
    } = await catalog.importItems([a])
    const incoming = { ...a, identifiers: [...a.identifiers, ...b.identifiers] }
    expect((await catalog.inspectImportItems([incoming], []))[0].status).toBe('existing')
    await catalog.importItems([b])
    await catalog.transact({ kind: 'set-item-lifecycle', itemIds: [id], state: 'deleted' })
    const collection = await catalog.transact({ kind: 'create-collection', name: 'Target' })
    await expect(
      catalog.importItems(
        [candidate({ doi: '10.1234/new' }).item, incoming],
        collection.id,
        'fill-missing'
      )
    ).rejects.toThrow('conflicting identifiers')
    expect(await client!.literatureItem.count()).toBe(2)
    expect(await client!.literatureCollectionItem.count()).toBe(0)
    expect((await client!.literatureItem.findUnique({ where: { id } }))!.deletedAt).not.toBeNull()
  })

  it('does not let a conflicting row create aliases for later import rows', async () => {
    const catalog = await setup()
    const existing = candidate({ doi: '10.1234/one' }).item
    const incoming = candidate({ doi: '10.1234/two' }).item
    const {
      itemIds: [id]
    } = await catalog.importItems([existing])
    const independent = await catalog.inspectImportItems([incoming, existing], [])
    const entries = await catalog.inspectImportItems(
      [
        { ...existing, identifiers: [...existing.identifiers, ...incoming.identifiers] },
        incoming,
        existing
      ],
      []
    )
    expect(entries[0].status).toBe('conflict')
    expect(
      entries.slice(1).map(({ status, existingItemId }) => ({ status, existingItemId }))
    ).toEqual(independent.map(({ status, existingItemId }) => ({ status, existingItemId })))
    expect(entries[2].existingItemId).toBe(id)
    expect(await client!.literatureItem.count()).toBe(1)
  })

  it('keeps preview and commit aligned when later rows use an earlier matching row alias', async () => {
    const catalog = await setup()
    const a = candidate().item
    const {
      itemIds: [id]
    } = await catalog.importItems([a])
    const pmid = { scheme: 'pmid' as const, value: '12345', isPrimary: false }
    const inputs = [
      { ...a, identifiers: [...a.identifiers, pmid] },
      { ...a, identifiers: [pmid] }
    ]
    expect(
      (await catalog.inspectImportItems(inputs, [])).map(({ existingItemId }) => existingItemId)
    ).toEqual([id, id])
    await expect(catalog.importItems(inputs)).resolves.toMatchObject({
      itemIds: [id],
      reusedCount: 2
    })
  })

  it('normalizes multiple primary flags per scheme on explicit writes without discarding history', async () => {
    const catalog = await setup()
    const input = {
      ...candidate().item,
      identifiers: [
        { scheme: 'doi' as const, value: '10.1234/z', isPrimary: true },
        { scheme: 'doi' as const, value: '10.1234/a', isPrimary: true },
        { scheme: 'pmid' as const, value: '12345', isPrimary: true }
      ]
    }
    const {
      itemIds: [id]
    } = await catalog.importItems([input], undefined, 'separate')
    const view = (await catalog.get(id))!
    expect(view.item.identifiers).toHaveLength(3)
    expect(
      view.item.identifiers
        .filter(({ isPrimary }) => isPrimary)
        .map(({ value }) => value)
        .sort()
    ).toEqual(['10.1234/a', '12345'])
  })

  it('preserves NBIB author warnings through preview and ordered creators through SQLite', async () => {
    const catalog = await setup()
    const parsed = await new LiteratureCitationFormatter().parseReferences(
      'PMID- 12345\nTI  - Paper\nAU  - Smith JA\nCN  - Research Consortium\nFAU - Unsplit Name\n'
    )
    const entries = await catalog.inspectImportItems(parsed.items, parsed.errors, parsed.warnings)
    expect(entries[0].warnings).toContain('uncertain-author-name')
    const {
      itemIds: [id]
    } = await catalog.importItems(parsed.items)
    const persisted = (await catalog.get(id))!.item
    expect(persisted.creators).toEqual(parsed.items[0].creators)
    expect(persisted.extra).toBe('FAU - Unsplit Name')
  })

  it('shares duplicate scans across count and page requests and invalidates on metadata mutations', async () => {
    const catalog = await setup()
    const findMany = vi.spyOn(client!.literatureItem, 'findMany')
    await Promise.all([
      catalog.search({ scope: 'duplicates', limit: 1 }),
      catalog.search({ scope: 'duplicates', limit: 20 })
    ])
    expect(findMany).toHaveBeenCalledTimes(1)
    await catalog.search({ scope: 'duplicates', offset: 20 })
    expect(findMany).toHaveBeenCalledTimes(1)
    await catalog.importItems([candidate().item])
    findMany.mockClear()
    await catalog.search({ scope: 'duplicates' })
    expect(findMany).toHaveBeenCalledTimes(1)
    await catalog.search({ scope: 'duplicates', refreshDuplicates: true })
    expect(findMany).toHaveBeenCalledTimes(2)
  })

  it('supports explicit duplicates while default Add and Inbox reuse the oldest active reference', async () => {
    const catalog = await setup()
    const input = candidate().item
    const first = await catalog.transact({ kind: 'create-item', item: input })
    const separate = await catalog.transact({
      kind: 'create-item',
      item: input,
      duplicatePolicy: 'separate'
    })
    expect(separate.id).not.toBe(first.id)
    await expect(catalog.importItems([input])).rejects.toThrow('conflicting identifiers')
    await expect(
      catalog.transact({ kind: 'stage-candidate', candidate: candidate() })
    ).resolves.toMatchObject({ id: first.id, kind: 'item' })
    const current = (await catalog.get(separate.id))!
    await catalog.transact({
      kind: 'update-item',
      itemId: separate.id,
      expectedMetadataRevision: current.metadataRevision,
      item: { ...current.item, personalNote: 'Independent note' }
    })
    await expect(catalog.get(separate.id)).resolves.toMatchObject({
      item: { personalNote: 'Independent note' }
    })
    await catalog.transact({ kind: 'set-item-lifecycle', itemIds: [first.id], state: 'deleted' })
    await expect(catalog.importItems([input])).rejects.toThrow('conflicting identifiers')
  })

  it('fills missing fields without overwriting conflicts and applies the import policy within a file', async () => {
    const catalog = await setup()
    const collection = await catalog.transact({ kind: 'create-collection', name: 'Target' })
    const input = candidate().item
    const receipt = await catalog.importItems([input, input], collection.id, 'reuse')
    expect(receipt.createdCount).toBe(1)
    expect(receipt.reusedCount).toBe(1)
    for (const id of receipt.itemIds)
      await expect(catalog.get(id)).resolves.toMatchObject({ collectionIds: [collection.id] })
    await catalog.importItems(
      [
        {
          ...input,
          title: 'Conflicting title',
          containerTitle: 'New journal',
          rating: 4,
          personalNote: 'Imported note',
          typeFields: { volume: '2', issue: '3' },
          identifiers: [...input.identifiers, { scheme: 'pmid', value: '1234', isPrimary: false }]
        }
      ],
      collection.id,
      'fill-missing'
    )
    await expect(catalog.get(receipt.itemIds[0])).resolves.toMatchObject({
      item: {
        title: input.title,
        containerTitle: 'New journal',
        rating: 4,
        personalNote: 'Imported note',
        typeFields: { volume: '1', issue: '3' },
        identifiers: expect.arrayContaining([
          expect.objectContaining({ scheme: 'pmid', value: '1234' })
        ])
      }
    })
    const next = {
      ...input,
      identifiers: [{ scheme: 'doi' as const, value: '10.1234/new', isPrimary: false }]
    }
    const filled = await catalog.importItems(
      [next, { ...next, containerTitle: 'Later in file' }],
      undefined,
      'fill-missing'
    )
    expect(filled).toMatchObject({ createdCount: 1, reusedCount: 1 })
    await expect(catalog.get(filled.itemIds[0])).resolves.toMatchObject({
      item: { containerTitle: 'Later in file' }
    })
  })

  it('previews batch merges without writes, rechecks conflicts and safely skips already merged groups', async () => {
    const catalog = await setup()
    const input = candidate().item
    const first = await catalog.importItems(
      [input, { ...input, containerTitle: 'Journal' }],
      undefined,
      'separate'
    )
    const secondInput = {
      ...input,
      identifiers: [{ scheme: 'doi' as const, value: '10.1234/second', isPrimary: false }]
    }
    const second = await catalog.importItems([secondInput, secondInput], undefined, 'separate')
    const metadataOnly = await catalog.importItems([
      { ...input, identifiers: [] },
      { ...input, identifiers: [] }
    ])
    const groups = [first.itemIds, second.itemIds, metadataOnly.itemIds]
    await expect(
      catalog.transact({ kind: 'merge-duplicates', mode: 'preview', groups })
    ).resolves.toMatchObject({
      batch: {
        eligible: 2,
        reduced: 2,
        review: 1,
        succeeded: 0,
        details: [
          { groupIndex: 0, status: 'ready' },
          { groupIndex: 1, status: 'ready' },
          { groupIndex: 2, status: 'skipped', reason: 'identity' }
        ]
      }
    })
    expect((await catalog.get(first.itemIds[1]))!.id).toBe(first.itemIds[1])
    const changed = (await catalog.get(second.itemIds[1]))!
    await catalog.transact({
      kind: 'update-item',
      itemId: changed.id,
      expectedMetadataRevision: changed.metadataRevision,
      item: { ...changed.item, title: 'Changed after preview' }
    })
    await expect(
      catalog.transact({ kind: 'merge-duplicates', mode: 'commit', groups })
    ).resolves.toMatchObject({ batch: { succeeded: 1, skipped: 2, failed: 0, reduced: 1 } })
    await expect(catalog.get(first.itemIds[1])).resolves.toMatchObject({
      id: first.itemIds[0],
      item: { containerTitle: 'Journal' }
    })
    await expect(
      catalog.transact({ kind: 'merge-duplicates', mode: 'commit', groups })
    ).resolves.toMatchObject({ batch: { succeeded: 0, skipped: 3 } })
  })

  it('rejects a manual merge if any reviewed reference changed without losing the new metadata', async () => {
    const catalog = await setup()
    const input = candidate().item
    const imported = await catalog.importItems([input, input], undefined, 'separate')
    const reviewed = (await Promise.all(imported.itemIds.map((id) => catalog.get(id)))).map(
      (view) => view!
    )
    const [survivor, duplicate] = reviewed
    await catalog.transact({
      kind: 'update-item',
      itemId: duplicate.id,
      expectedMetadataRevision: duplicate.metadataRevision,
      item: { ...duplicate.item, personalNote: 'Added while merge review was open' }
    })
    await expect(
      catalog.transact({
        kind: 'merge-items',
        survivorId: survivor.id,
        duplicateIds: [duplicate.id],
        expectedMetadataRevision: survivor.metadataRevision,
        expectedItems: reviewed.map(({ id, metadataRevision, updatedAt }) => ({
          id,
          metadataRevision,
          updatedAt
        })),
        item: survivor.item
      })
    ).rejects.toThrow('changed after review')
    await expect(catalog.get(survivor.id)).resolves.toMatchObject({ id: survivor.id })
    await expect(catalog.get(duplicate.id)).resolves.toMatchObject({
      id: duplicate.id,
      item: { personalNote: 'Added while merge review was open' }
    })
  })

  it('previews rule-based survivors, requires review and skips records changed since review', async () => {
    const catalog = await setup()
    const input = candidate().item
    const imported = await catalog.importItems(
      [input, { ...input, title: 'Richer record', containerTitle: 'Journal' }],
      undefined,
      'separate'
    )
    const command = {
      kind: 'merge-duplicates' as const,
      groups: [imported.itemIds],
      strategy: 'most-complete' as const
    }
    await expect(catalog.transact({ ...command, mode: 'commit' })).rejects.toThrow('Preview')
    const preview = await catalog.transact({ ...command, mode: 'preview' })
    expect(preview.batch).toMatchObject({
      eligible: 1,
      groups: [{ survivorId: imported.itemIds[1], conflicts: true }]
    })
    const current = (await catalog.get(imported.itemIds[0]))!
    await catalog.transact({
      kind: 'update-item',
      itemId: current.id,
      expectedMetadataRevision: current.metadataRevision,
      item: { ...current.item, personalNote: 'New note' }
    })
    await expect(
      catalog.transact({
        ...command,
        mode: 'commit',
        expectedItems: preview.batch!.groups!.flatMap((group) => group.items)
      })
    ).resolves.toMatchObject({
      batch: {
        succeeded: 0,
        skipped: 1,
        details: [{ groupIndex: 0, status: 'skipped', reason: 'changed' }]
      }
    })
    const refreshed = await catalog.transact({ ...command, mode: 'preview' })
    await expect(
      catalog.transact({
        ...command,
        mode: 'commit',
        expectedItems: refreshed.batch!.groups!.flatMap((group) => group.items)
      })
    ).resolves.toMatchObject({ batch: { succeeded: 1 } })
    expect(await catalog.get(imported.itemIds[0])).toMatchObject({
      id: imported.itemIds[1],
      item: { title: 'Richer record', personalNote: 'New note' }
    })
  })

  it('retains attachments, sources, tags and destinations during a batch merge and isolates failed groups', async () => {
    const catalog = await setup()
    const first = await catalog.importItems(
      [candidate().item, candidate().item],
      undefined,
      'separate'
    )
    const nextInput = candidate({ doi: '10.1234/next' }).item
    const next = await catalog.importItems([nextInput, nextInput], undefined, 'separate')
    const [survivorId, duplicateId] = next.itemIds
    const collection = await catalog.transact({ kind: 'create-collection', name: 'Keep' })
    await catalog.transact({
      kind: 'set-collection-item',
      collectionId: collection.id,
      itemId: duplicateId,
      included: true
    })
    await catalog.transact({
      kind: 'set-project-item',
      projectId: 'project-1',
      itemId: duplicateId,
      included: true,
      source: 'library'
    })
    await client!.tag.create({
      data: {
        id: 'batch-tag',
        name: 'Keep',
        nameKey: 'keep',
        iconKey: 'tag',
        colorKey: 'blue',
        sortOrder: 99
      }
    })
    await client!.tagAssignment.create({
      data: { tagId: 'batch-tag', resourceType: 'literature.item', resourceId: duplicateId }
    })
    const source = await client!.literatureSourceRecord.create({
      data: {
        itemId: duplicateId,
        provider: 'test',
        rawMetadataJson: '{}',
        metadataChecksum: 'a'.repeat(64)
      }
    })
    await client!.contentBlob.create({
      data: {
        id: 'batch-blob',
        checksum: 'b'.repeat(64),
        storageKey: 'content/batch-blob',
        sizeBytes: 128n,
        contentType: 'application/pdf',
        state: 'available',
        verifiedAt: new Date()
      }
    })
    const attachment = await catalog.attachContent({
      itemId: duplicateId,
      contentBlobId: 'batch-blob',
      filename: 'keep.pdf',
      contentType: 'application/pdf',
      sizeBytes: 128,
      checksum: 'b'.repeat(64)
    })
    // Simulate a storage failure for one group; the other group must still complete.
    await client!.$executeRawUnsafe(
      `CREATE TRIGGER fail_batch_group BEFORE UPDATE ON "LiteratureItem" WHEN OLD.id = '${first.itemIds[0]}' BEGIN SELECT RAISE(ABORT, 'test failure'); END`
    )
    await expect(
      catalog.transact({
        kind: 'merge-duplicates',
        mode: 'commit',
        groups: [first.itemIds, next.itemIds]
      })
    ).resolves.toMatchObject({ batch: { succeeded: 1, failed: 1, skipped: 0 } })
    await expect(catalog.get(first.itemIds[1])).resolves.toMatchObject({
      id: first.itemIds[1],
      item: { identifiers: expect.arrayContaining([expect.objectContaining({ scheme: 'doi' })]) }
    })
    await expect(catalog.get(duplicateId)).resolves.toMatchObject({
      id: survivorId,
      projectIds: ['project-1'],
      collectionIds: [collection.id],
      attachments: [expect.objectContaining({ id: attachment.attachmentId })]
    })
    await expect(
      client!.tagAssignment.findFirst({ where: { tagId: 'batch-tag', resourceId: survivorId } })
    ).resolves.toBeTruthy()
    await expect(
      client!.literatureSourceRecord.findUnique({ where: { id: source.id } })
    ).resolves.toMatchObject({ itemId: survivorId })
  })

  it('paginates duplicate groups across the library and removes resolved or trashed records', async () => {
    const catalog = await setup()
    const input = { ...candidate().item, identifiers: [] }
    const ids: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const receipt = await catalog.transact({
        kind: 'create-item',
        item: { ...input, title: index < 3 ? 'First study' : 'Second study' }
      })
      ids.push(receipt.id)
    }
    await catalog.transact({ kind: 'set-item-lifecycle', itemIds: [ids[2]], state: 'deleted' })
    const first = await catalog.search({ scope: 'duplicates', limit: 1 })
    expect(first).toMatchObject({ totalCount: 2, nextOffset: 1 })
    expect(first.entries).toHaveLength(1)
    const second = await catalog.search({ scope: 'duplicates', offset: 1, limit: 1 })
    expect(second).toMatchObject({ totalCount: 2, nextOffset: undefined })
    const groups = [...first.entries, ...second.entries].filter((entry) => 'itemIds' in entry)
    expect(groups.map((group) => group.itemIds.length)).toEqual([2, 2])
    expect(groups.flatMap((group) => group.itemIds)).not.toContain(ids[2])
    const survivor = await catalog.get(ids[0])
    await catalog.transact({
      kind: 'merge-items',
      survivorId: ids[0],
      duplicateIds: [ids[1]],
      expectedItems: (await Promise.all([ids[0], ids[1]].map((id) => catalog.get(id)))).map(
        (view) => ({
          id: view!.id,
          metadataRevision: view!.metadataRevision,
          updatedAt: view!.updatedAt
        })
      ),
      expectedMetadataRevision: survivor!.metadataRevision,
      item: survivor!.item
    })
    await expect(catalog.search({ scope: 'duplicates' })).resolves.toMatchObject({ totalCount: 1 })
  })

  it('sorts by addition, rating and both year directions with stable pages and undated items last', async () => {
    const catalog = await setup()
    await client!.literatureItem.createMany({
      data: [
        { id: 'a', title: 'Beta', issuedYear: 2020, rating: 2, createdAt: new Date('2024-01-02') },
        { id: 'b', title: 'Alpha', issuedYear: 2024, rating: 5, createdAt: new Date('2024-01-03') },
        { id: 'c', title: 'Alpha', issuedYear: 2024, rating: 5, createdAt: new Date('2024-01-01') },
        {
          id: 'd',
          title: 'No date',
          issuedYear: null,
          rating: 0,
          createdAt: new Date('2024-01-04')
        }
      ].map((item) => ({ ...item, itemType: 'journalArticle' }))
    })
    for (const [sortBy, sortDirection, expected] of [
      ['created', 'desc', ['d', 'b', 'a', 'c']],
      ['created', 'asc', ['c', 'a', 'b', 'd']],
      ['rating', 'desc', ['b', 'c', 'a', 'd']],
      ['year', 'desc', ['b', 'c', 'a', 'd']],
      ['year', 'asc', ['a', 'b', 'c', 'd']],
      ['title', 'asc', ['b', 'c', 'a', 'd']],
      ['title', 'desc', ['d', 'a', 'b', 'c']]
    ] as const) {
      const request = literatureCatalogSearchRequestSchema.parse({
        scope: 'library',
        sortBy,
        sortDirection
      })
      const page = await catalog.search(request)
      expect(page.entries).toEqual(expected.map((id) => expect.objectContaining({ id })))
      const first = await catalog.search({ ...request, limit: 1 })
      const second = await catalog.search({ ...request, limit: 1, offset: first.nextOffset })
      expect([...first.entries, ...second.entries]).toEqual(
        expected.slice(0, 2).map((id) => expect.objectContaining({ id }))
      )
    }
  })

  it('stores and returns canonical identifier values', async () => {
    const catalog = await setup()
    const created = await catalog.transact({
      kind: 'create-item',
      item: candidate({ doi: 'doi:10.1234/exampleCopyright' }).item
    })

    await expect(catalog.get(created.id)).resolves.toMatchObject({
      item: {
        identifiers: [
          expect.objectContaining({ scheme: 'doi', value: '10.1234/example', isPrimary: true })
        ]
      }
    })
  })

  it('reuses and restores an identified Item when it is imported from Trash', async () => {
    const catalog = await setup()
    const item = await catalog.transact({ kind: 'create-item', item: candidate().item })
    await catalog.transact({ kind: 'set-item-lifecycle', itemIds: [item.id], state: 'deleted' })

    await expect(catalog.importItems([candidate().item])).resolves.toEqual({
      itemIds: [item.id],
      createdCount: 0,
      reusedCount: 1
    })
    await expect(catalog.search({ scope: 'library' })).resolves.toMatchObject({
      entries: [expect.objectContaining({ id: item.id })]
    })
  })

  it('keeps acquired PDFs in Inbox until acceptance and reuses an existing library reference', async () => {
    const catalog = await setup()
    const existing = await catalog.transact({ kind: 'create-item', item: candidate().item })
    await client!.contentBlob.create({
      data: {
        id: 'inbox-blob',
        checksum: 'c'.repeat(64),
        storageKey: 'content/inbox-blob',
        sizeBytes: 128n,
        contentType: 'application/pdf',
        state: 'available'
      }
    })
    const pdf = {
      contentBlobId: 'inbox-blob',
      checksum: 'c'.repeat(64),
      sizeBytes: 128,
      contentType: 'application/pdf',
      filename: 'paper.pdf',
      pageCount: 8,
      sourceUrl: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC1/'
    }
    const staged = await catalog.stageAcquiredPdf(candidate(), pdf)
    expect(staged).toMatchObject({ kind: 'candidate', state: 'pending' })
    await expect(catalog.stageAcquiredPdf(candidate(), pdf)).resolves.toEqual(staged)
    expect((await catalog.get(existing.id))!.attachments).toEqual([])
    expect((await catalog.search({ scope: 'inbox' })).entries[0]).toMatchObject({
      pdfs: [{ filename: 'paper.pdf', pageCount: 8 }]
    })
    const accepted = await catalog.transact({ kind: 'accept-candidate', candidateId: staged.id })
    expect(accepted.id).toBe(existing.id)
    expect((await catalog.get(existing.id))!.attachments).toHaveLength(1)
    expect((await catalog.get(existing.id))!.projectIds).toEqual(['project-1'])
    expect(await client!.literatureInboxPdf.count()).toBe(0)
    await catalog.transact({ kind: 'accept-candidate', candidateId: staged.id })
    expect((await catalog.get(existing.id))!.attachments).toHaveLength(1)
  })

  it('rolls back Inbox metadata if its acquired PDF cannot be retained', async () => {
    const catalog = await setup()
    await expect(
      catalog.stageAcquiredPdf(candidate(), {
        contentBlobId: 'missing',
        checksum: 'c'.repeat(64),
        sizeBytes: 128,
        contentType: 'application/pdf',
        filename: 'paper.pdf',
        pageCount: 8,
        sourceUrl: 'https://example.test/paper'
      })
    ).rejects.toThrow('Inbox PDF content')
    expect((await catalog.search({ scope: 'inbox' })).entries).toEqual([])
  })

  it('stages Agent results in Inbox and accepts them into a Project without duplicate identities', async () => {
    const catalog = await setup()

    const staged = await catalog.transact({ kind: 'stage-candidate', candidate: candidate() })
    expect(staged).toMatchObject({ kind: 'candidate', state: 'pending' })
    await expect(
      catalog.transact({
        kind: 'stage-candidate',
        candidate: candidate({ doi: 'doi:10.1234/crag' })
      })
    ).resolves.toEqual(staged)

    const inbox = await catalog.search({ scope: 'inbox' })
    expect(inbox.entries).toHaveLength(1)
    expect(inbox.entries[0]).toMatchObject({ id: staged.id, state: 'pending' })

    const accepted = await catalog.transact({ kind: 'accept-candidate', candidateId: staged.id })
    expect(accepted).toMatchObject({ kind: 'item', state: 'linked' })
    await expect(catalog.get(accepted.id)).resolves.toMatchObject({
      id: accepted.id,
      projectIds: ['project-1'],
      item: {
        title: 'Corrective Retrieval Augmented Generation',
        typeFields: { volume: '1' }
      }
    })
    await expect(
      client!.projectLiterature.findUnique({
        where: { projectId_itemId: { projectId: 'project-1', itemId: accepted.id } }
      })
    ).resolves.toMatchObject({ source: 'agent' })

    const duplicate = await catalog.transact({
      kind: 'stage-candidate',
      candidate: candidate({
        doi: '10.1234/CRAG',
        externalId: 'pubmed-123',
        provider: 'pubmed'
      })
    })
    expect(duplicate).toEqual({ kind: 'item', id: accepted.id, state: 'present' })
    await expect(client!.literatureItem.count()).resolves.toBe(1)
    await expect(
      client!.literatureSourceRecord.count({ where: { itemId: accepted.id } })
    ).resolves.toBe(2)
  })

  it('settles multiple Inbox candidates in one command', async () => {
    const catalog = await setup()
    const first = await catalog.transact({ kind: 'stage-candidate', candidate: candidate() })
    const second = await catalog.transact({
      kind: 'stage-candidate',
      candidate: candidate({
        doi: '10.1234/second',
        externalId: '10.1234/second',
        title: 'Second paper'
      })
    })

    await expect(
      catalog.transact({
        kind: 'settle-candidates',
        candidateIds: [first.id, second.id],
        state: 'accepted'
      })
    ).resolves.toMatchObject({ kind: 'candidate', state: 'accepted', count: 2 })
    await expect(catalog.search({ scope: 'inbox' })).resolves.toMatchObject({ entries: [] })
    await expect(client!.literatureItem.count()).resolves.toBe(2)

    const third = await catalog.transact({
      kind: 'stage-candidate',
      candidate: candidate({
        doi: '10.1234/third',
        externalId: '10.1234/third',
        title: 'Third paper'
      })
    })
    const fourth = await catalog.transact({
      kind: 'stage-candidate',
      candidate: candidate({
        doi: '10.1234/fourth',
        externalId: '10.1234/fourth',
        title: 'Fourth paper'
      })
    })
    await expect(
      catalog.transact({
        kind: 'settle-candidates',
        candidateIds: [third.id, fourth.id],
        state: 'dismissed'
      })
    ).resolves.toMatchObject({ kind: 'candidate', state: 'dismissed', count: 2 })
    await expect(catalog.search({ scope: 'inbox' })).resolves.toMatchObject({ entries: [] })
  })

  it('restores dismissed Inbox candidates to pending', async () => {
    const catalog = await setup()
    const staged = await catalog.transact({ kind: 'stage-candidate', candidate: candidate() })
    await catalog.transact({ kind: 'dismiss-candidate', candidateId: staged.id })

    await expect(
      catalog.transact({ kind: 'restore-candidates', candidateIds: [staged.id] })
    ).resolves.toEqual({ kind: 'candidate', id: staged.id, state: 'pending', count: 1 })
    await expect(catalog.search({ scope: 'inbox' })).resolves.toMatchObject({
      entries: [expect.objectContaining({ id: staged.id, state: 'pending' })]
    })
  })

  it('updates citation metadata atomically with optimistic revision checks', async () => {
    const catalog = await setup()
    const staged = await catalog.transact({ kind: 'stage-candidate', candidate: candidate() })
    const accepted = await catalog.transact({ kind: 'accept-candidate', candidateId: staged.id })
    const current = await catalog.get(accepted.id)

    await expect(
      catalog.transact({
        kind: 'update-item',
        itemId: accepted.id,
        expectedMetadataRevision: current!.metadataRevision,
        item: literatureItemInputSchema.parse({
          ...current!.item,
          title: 'Corrective RAG',
          rating: 5,
          personalNote: 'Discuss in the next lab meeting.',
          issuedYear: 2025,
          containerTitle: 'Journal of Retrieval',
          creators: [
            {
              nameMode: 'person',
              givenName: 'Jane',
              familyName: 'Doe',
              creatorType: 'author'
            }
          ],
          identifiers: [
            { scheme: 'doi', value: 'doi:10.1234/UPDATED', isPrimary: true },
            { scheme: 'pmid', value: '12345678', isPrimary: false }
          ]
        })
      })
    ).resolves.toEqual({ kind: 'item', id: accepted.id, state: 'present' })

    await expect(catalog.get(accepted.id)).resolves.toMatchObject({
      metadataRevision: current!.metadataRevision + 1,
      item: {
        title: 'Corrective RAG',
        rating: 5,
        personalNote: 'Discuss in the next lab meeting.',
        issuedYear: 2025,
        containerTitle: 'Journal of Retrieval',
        creators: [{ givenName: 'Jane', familyName: 'Doe' }],
        identifiers: [
          { scheme: 'doi', value: '10.1234/UPDATED', isPrimary: true },
          { scheme: 'pmid', value: '12345678', isPrimary: false }
        ]
      }
    })
    await expect(client!.literatureCreator.count()).resolves.toBe(1)

    await expect(
      catalog.transact({
        kind: 'update-item',
        itemId: accepted.id,
        expectedMetadataRevision: current!.metadataRevision,
        item: current!.item
      })
    ).rejects.toThrow(/revision conflict.*expected 1, actual 2/iu)
  })

  it('applies completed metadata and source provenance in one revision', async () => {
    const catalog = await setup()
    const staged = await catalog.transact({ kind: 'stage-candidate', candidate: candidate() })
    const accepted = await catalog.transact({ kind: 'accept-candidate', candidateId: staged.id })
    const current = await catalog.get(accepted.id)

    const updated = await catalog.applyMetadata({
      itemId: accepted.id,
      expectedMetadataRevision: current!.metadataRevision,
      item: {
        ...current!.item,
        containerTitle: 'Journal of Retrieval',
        typeFields: { ...current!.item.typeFields, issue: '2', pages: '10-20' }
      },
      source: {
        provider: 'crossref',
        externalId: '10.1234/crag',
        sourceUrl: 'https://api.crossref.org/works/10.1234%2Fcrag',
        rawMetadata: { issue: '2', page: '10-20' }
      }
    })

    expect(updated).toMatchObject({
      metadataRevision: current!.metadataRevision + 1,
      item: {
        containerTitle: 'Journal of Retrieval',
        typeFields: { issue: '2', pages: '10-20' }
      }
    })
    await expect(
      client!.literatureSourceRecord.findUnique({
        where: {
          provider_externalId: { provider: 'crossref', externalId: '10.1234/crag' }
        }
      })
    ).resolves.toMatchObject({
      itemId: accepted.id,
      sourceUrl: 'https://api.crossref.org/works/10.1234%2Fcrag',
      rawMetadataJson: '{"issue":"2","page":"10-20"}'
    })
  })

  it('creates a manual Library item and reuses an existing identifier identity', async () => {
    const catalog = await setup()
    const input = candidate().item

    const created = await catalog.transact({ kind: 'create-item', item: input })
    expect(created).toMatchObject({ kind: 'item', state: 'present' })
    await expect(catalog.get(created.id)).resolves.toMatchObject({
      item: { title: input.title, identifiers: input.identifiers }
    })

    await expect(
      catalog.transact({
        kind: 'create-item',
        item: { ...input, title: 'Duplicate title' }
      })
    ).resolves.toEqual(created)
    await expect(client!.literatureItem.count()).resolves.toBe(1)
  })

  it('imports references atomically, reuses identifiers, and adds them to a collection', async () => {
    const catalog = await setup()
    const collection = await catalog.transact({ kind: 'create-collection', name: 'Imported' })
    await catalog.transact({ kind: 'create-item', item: candidate().item })

    await expect(
      catalog.importItems(
        [
          candidate({ title: 'Duplicate metadata' }).item,
          literatureItemInputSchema.parse({
            itemType: 'book',
            title: 'A new book',
            identifiers: [{ scheme: 'isbn', value: '978-1-4028-9462-6' }]
          })
        ],
        collection.id
      )
    ).resolves.toMatchObject({ createdCount: 1, reusedCount: 1, itemIds: expect.any(Array) })

    const imported = await catalog.search({ scope: 'library', collectionId: collection.id })
    expect(imported.entries.map((entry) => ('item' in entry ? entry.item.title : ''))).toEqual(
      expect.arrayContaining(['Corrective Retrieval Augmented Generation', 'A new book'])
    )
    await expect(client!.literatureItem.count()).resolves.toBe(2)
  })

  it('classifies imported records before committing them', async () => {
    const catalog = await setup()
    await catalog.transact({ kind: 'create-item', item: candidate().item })

    await expect(
      catalog.inspectImportItems(
        [
          candidate({ title: 'Existing identity' }).item,
          literatureItemInputSchema.parse({
            itemType: 'journalArticle',
            title: 'Incomplete paper'
          }),
          literatureItemInputSchema.parse({
            itemType: 'book',
            title: 'Complete book',
            issuedYear: 2024,
            creators: [
              {
                nameMode: 'person',
                givenName: 'Ada',
                familyName: 'Lovelace',
                creatorType: 'author'
              }
            ]
          })
        ],
        [{ preview: '@broken{', error: 'Invalid BibTeX' }]
      )
    ).resolves.toMatchObject([
      { status: 'existing', existingItemId: expect.any(String) },
      {
        status: 'warning',
        warnings: ['missing-authors', 'missing-year', 'missing-container-title']
      },
      { status: 'ready', warnings: [] },
      { status: 'invalid', error: 'Invalid BibTeX' }
    ])
  })

  it('imports a full batch with many authors and reuses identities within the file', async () => {
    const catalog = await setup()
    const items = Array.from({ length: 999 }, (_, index) =>
      literatureItemInputSchema.parse({
        ...candidate({ doi: `10.1234/bulk-${index}`, title: `Reference ${index}` }).item,
        creators: [
          ...Array.from({ length: 9 }, (_, ordinal) => ({
            nameMode: 'person',
            givenName: `Author ${ordinal}`,
            familyName: `Family ${index}`,
            creatorType: 'author'
          })),
          { nameMode: 'organization', literalName: 'Research Consortium', creatorType: 'author' }
        ]
      })
    )
    const receipt = await catalog.importItems([...items, items[0]])
    expect(receipt).toMatchObject({ createdCount: 999, reusedCount: 1 })
    expect(receipt.itemIds).toHaveLength(999)
    expect(await client!.literatureCreator.count()).toBe(9_990)
    expect(await catalog.get(receipt.itemIds[998])).toMatchObject({
      item: { creators: items[998].creators }
    })
    const preview = await catalog.inspectImportItems(items, [])
    expect(preview).toHaveLength(999)
    expect(preview.every((entry) => entry.status === 'existing')).toBe(true)
  }, 120_000)

  it('rolls back references and bulk-created authors if a later write fails', async () => {
    const catalog = await setup()
    await client!.$executeRawUnsafe(`CREATE TRIGGER reject_import_reference
      BEFORE INSERT ON LiteratureItem WHEN NEW.title = 'Rejected reference'
      BEGIN SELECT RAISE(ABORT, 'Simulated storage failure'); END`)
    await expect(
      catalog.importItems([
        candidate().item,
        candidate({ doi: '10.1234/rejected', title: 'Rejected reference' }).item
      ])
    ).rejects.toThrow()
    expect(await client!.literatureItem.count()).toBe(0)
    expect(await client!.literatureCreator.count()).toBe(0)
    expect(await client!.literatureIdentifier.count()).toBe(0)
  })

  it('marks repeated identifiers in the preview without inventing persisted item IDs', async () => {
    const catalog = await setup()
    const entries = await catalog.inspectImportItems([candidate().item, candidate().item], [])
    expect(entries[0].status).not.toBe('existing')
    expect(entries[1].status).toBe('existing')
    expect(entries[1].existingItemId).toBeUndefined()
    expect(await client!.literatureItem.count()).toBe(0)
  })

  it('filters the library by collection and settles dismissed Inbox candidates', async () => {
    const catalog = await setup()
    const staged = await catalog.transact({ kind: 'stage-candidate', candidate: candidate() })
    const accepted = await catalog.transact({ kind: 'accept-candidate', candidateId: staged.id })
    const collection = await catalog.transact({ kind: 'create-collection', name: '  RAG  ' })
    await catalog.transact({
      kind: 'set-collection-item',
      collectionId: collection.id,
      itemId: accepted.id,
      included: true
    })

    await expect(
      catalog.search({ scope: 'library', collectionId: collection.id, query: 'Corrective' })
    ).resolves.toMatchObject({ entries: [{ id: accepted.id }] })
    await expect(catalog.get(accepted.id)).resolves.toMatchObject({
      collectionIds: [collection.id]
    })

    const other = await catalog.transact({
      kind: 'stage-candidate',
      candidate: candidate({
        doi: '10.1234/other',
        externalId: '10.1234/other',
        title: 'Another paper'
      })
    })
    await expect(
      catalog.transact({ kind: 'dismiss-candidate', candidateId: other.id })
    ).resolves.toEqual({ kind: 'candidate', id: other.id, state: 'dismissed' })
    await expect(catalog.search({ scope: 'inbox' })).resolves.toMatchObject({ entries: [] })
    await expect(
      catalog.search({ scope: 'inbox', inboxState: 'dismissed' })
    ).resolves.toMatchObject({
      entries: [{ id: other.id, state: 'dismissed' }]
    })
  })

  it('projects manual Project associations and applies them to Project-scoped searches', async () => {
    const catalog = await setup()
    await client!.project.create({ data: { id: 'project-2', name: 'Second project' } })
    const staged = await catalog.transact({ kind: 'stage-candidate', candidate: candidate() })
    const accepted = await catalog.transact({ kind: 'accept-candidate', candidateId: staged.id })

    await expect(
      catalog.transact({
        kind: 'set-project-item',
        projectId: 'project-2',
        itemId: accepted.id,
        included: true,
        source: 'library'
      })
    ).resolves.toMatchObject({ id: accepted.id, state: 'linked' })
    await expect(catalog.get(accepted.id)).resolves.toMatchObject({
      projectIds: expect.arrayContaining(['project-1', 'project-2'])
    })
    await expect(
      catalog.search({ scope: 'library', projectId: 'project-2' })
    ).resolves.toMatchObject({ entries: [{ id: accepted.id }] })

    await catalog.transact({
      kind: 'set-project-item',
      projectId: 'project-1',
      itemId: accepted.id,
      included: false,
      source: 'library'
    })
    await expect(
      catalog.search({ scope: 'library', projectId: 'project-1' })
    ).resolves.toMatchObject({ entries: [] })
  })

  it('sets Project associations for a bounded batch of Literature Items', async () => {
    const catalog = await setup()
    await client!.project.create({ data: { id: 'project-2', name: 'Second project' } })
    const first = await catalog.transact({ kind: 'create-item', item: candidate().item })
    const second = await catalog.transact({
      kind: 'create-item',
      item: candidate({ doi: '10.1234/second', title: 'Second paper' }).item
    })

    await expect(
      catalog.transact({
        kind: 'set-project-items',
        projectId: 'project-2',
        itemIds: [first.id, second.id],
        included: true,
        source: 'library'
      })
    ).resolves.toMatchObject({ id: first.id, state: 'linked' })
    await expect(
      catalog.search({ scope: 'library', projectId: 'project-2' })
    ).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ id: first.id }),
        expect.objectContaining({ id: second.id })
      ])
    })

    await catalog.transact({
      kind: 'set-project-items',
      projectId: 'project-2',
      itemIds: [first.id, second.id],
      included: false,
      source: 'library'
    })
    await expect(
      catalog.search({ scope: 'library', projectId: 'project-2' })
    ).resolves.toMatchObject({ entries: [] })
  })

  it('returns all Project reference counts with one aggregate search', async () => {
    const catalog = await setup()
    await client!.project.create({ data: { id: 'project-2', name: 'Second project' } })
    const first = await catalog.transact({ kind: 'create-item', item: candidate().item })
    const second = await catalog.transact({
      kind: 'create-item',
      item: candidate({ doi: '10.1234/second', title: 'Second paper' }).item
    })
    for (const [projectId, itemId] of [
      ['project-1', first.id],
      ['project-1', second.id],
      ['project-2', second.id]
    ] as const) {
      await catalog.transact({
        kind: 'set-project-item',
        projectId,
        itemId,
        included: true,
        source: 'library'
      })
    }

    await expect(catalog.search({ scope: 'project-counts' })).resolves.toEqual({
      entries: [
        { projectId: 'project-1', itemCount: 2 },
        { projectId: 'project-2', itemCount: 1 }
      ],
      totalCount: 2
    })
  })

  it('attaches immutable ContentBlob versions and returns them with the Item', async () => {
    const catalog = await setup()
    const staged = await catalog.transact({ kind: 'stage-candidate', candidate: candidate() })
    const accepted = await catalog.transact({ kind: 'accept-candidate', candidateId: staged.id })
    const checksum = 'a'.repeat(64)
    await client!.contentBlob.create({
      data: {
        id: 'literature-blob-1',
        checksum,
        storageKey: 'content/literature/literature-blob-1',
        sizeBytes: 128n,
        contentType: 'application/pdf',
        state: 'available',
        verifiedAt: new Date()
      }
    })

    const attached = await catalog.attachContent({
      itemId: accepted.id,
      contentBlobId: 'literature-blob-1',
      filename: 'paper.pdf',
      contentType: 'application/pdf',
      sizeBytes: 128,
      checksum,
      pageCount: 14
    })
    await expect(
      catalog.attachContent({
        itemId: accepted.id,
        expectedMetadataRevision: 999,
        contentBlobId: 'literature-blob-1',
        filename: 'paper.pdf',
        contentType: 'application/pdf',
        sizeBytes: 128,
        checksum
      })
    ).rejects.toThrow('changed before the PDF')
    await expect(
      catalog.attachContent({
        itemId: accepted.id,
        contentBlobId: 'literature-blob-1',
        filename: 'paper.pdf',
        contentType: 'application/pdf',
        sizeBytes: 128,
        checksum,
        pageCount: 14
      })
    ).resolves.toEqual(attached)
    await expect(
      catalog.attachContent({
        itemId: accepted.id,
        attachmentId: attached.attachmentId,
        contentBlobId: 'literature-blob-1',
        filename: 'paper.pdf',
        contentType: 'application/pdf',
        sizeBytes: 128,
        checksum,
        pageCount: 14
      })
    ).resolves.toEqual(attached)
    await expect(catalog.get(accepted.id)).resolves.toMatchObject({
      attachments: [
        {
          id: attached.attachmentId,
          kind: 'fullText',
          versions: [
            {
              id: attached.versionId,
              versionNumber: 1,
              filename: 'paper.pdf',
              contentType: 'application/pdf',
              sizeBytes: 128,
              checksum,
              pageCount: 14
            }
          ]
        }
      ]
    })
  })

  it.each(['collection', 'project', 'project batch'] as const)(
    'rejects stale merged identities when linking a single reference to a %s',
    async (destination) => {
      const catalog = await setup()
      const survivor = await catalog.transact({ kind: 'create-item', item: candidate().item })
      const alias = await catalog.transact({
        kind: 'create-item',
        item: candidate({ doi: '10.1234/alias', title: 'Alias' }).item
      })
      const reviewed = (await Promise.all([catalog.get(survivor.id), catalog.get(alias.id)])).map(
        (view) => view!
      )
      await catalog.transact({
        kind: 'merge-items',
        survivorId: survivor.id,
        duplicateIds: [alias.id],
        expectedMetadataRevision: reviewed[0].metadataRevision,
        expectedItems: reviewed.map(({ id, metadataRevision, updatedAt }) => ({
          id,
          metadataRevision,
          updatedAt
        })),
        item: reviewed[0].item
      })
      const collection = await catalog.transact({ kind: 'create-collection', name: 'Target' })
      await expect(catalog.get(alias.id)).resolves.toMatchObject({ id: survivor.id })
      await expect(
        catalog.transact(
          destination === 'collection'
            ? {
                kind: 'set-collection-item',
                collectionId: collection.id,
                itemId: alias.id,
                included: true
              }
            : destination === 'project batch'
              ? {
                  kind: 'set-project-items',
                  projectId: 'project-1',
                  itemIds: [alias.id],
                  included: true,
                  source: 'library'
                }
              : {
                  kind: 'set-project-item',
                  projectId: 'project-1',
                  itemId: alias.id,
                  included: true,
                  source: 'library'
                }
        )
      ).rejects.toThrow(/unavailable/i)
      expect(await client!.literatureCollectionItem.count({ where: { itemId: alias.id } })).toBe(0)
      expect(await client!.projectLiterature.count({ where: { itemId: alias.id } })).toBe(0)
    }
  )

  it.each(['collection', 'project', 'project batch'] as const)(
    'rejects deleted identities when linking a single reference to a %s',
    async (destination) => {
      const catalog = await setup()
      const item = await catalog.transact({ kind: 'create-item', item: candidate().item })
      const collection = await catalog.transact({ kind: 'create-collection', name: 'Target' })
      await catalog.transact({ kind: 'set-item-lifecycle', itemIds: [item.id], state: 'deleted' })
      await expect(
        catalog.transact(
          destination === 'collection'
            ? {
                kind: 'set-collection-item',
                collectionId: collection.id,
                itemId: item.id,
                included: true
              }
            : destination === 'project batch'
              ? {
                  kind: 'set-project-items',
                  projectId: 'project-1',
                  itemIds: [item.id],
                  included: true,
                  source: 'library'
                }
              : {
                  kind: 'set-project-item',
                  projectId: 'project-1',
                  itemId: item.id,
                  included: true,
                  source: 'library'
                }
        )
      ).rejects.toThrow(/unavailable/i)
      expect(await client!.literatureCollectionItem.count({ where: { itemId: item.id } })).toBe(0)
      expect(await client!.projectLiterature.count({ where: { itemId: item.id } })).toBe(0)
    }
  )

  it('preserves an earlier committed collection batch when a later command rejects', async () => {
    const catalog = await setup()
    const source = await catalog.transact({ kind: 'create-collection', name: 'Source' })
    const target = await catalog.transact({ kind: 'create-collection', name: 'Target' })
    const ids: string[] = []
    for (let index = 0; index < 201; index++) {
      const item = await catalog.transact({
        kind: 'create-item',
        item: candidate({ doi: `10.1234/batch-${index}`, title: `Reference ${index}` }).item
      })
      ids.push(item.id)
      await catalog.transact({
        kind: 'set-collection-item',
        collectionId: source.id,
        itemId: item.id,
        included: true
      })
    }
    await catalog.transact({
      kind: 'move-collection-items',
      sourceCollectionId: source.id,
      targetCollectionId: target.id,
      itemIds: ids.slice(0, 200)
    })
    await catalog.transact({ kind: 'set-item-lifecycle', itemIds: [ids[200]], state: 'deleted' })
    await expect(
      catalog.transact({
        kind: 'move-collection-items',
        sourceCollectionId: source.id,
        targetCollectionId: target.id,
        itemIds: [ids[200]]
      })
    ).rejects.toThrow(/unavailable/i)
    await expect(
      catalog.search({ scope: 'library', collectionId: target.id })
    ).resolves.toMatchObject({ totalCount: 200 })
    expect(
      await client!.literatureCollectionItem.count({ where: { collectionId: source.id } })
    ).toBe(1)
  })

  it('moves Items between Collections', async () => {
    const catalog = await setup()
    const first = await catalog.transact({ kind: 'create-item', item: candidate().item })
    const second = await catalog.transact({
      kind: 'create-item',
      item: candidate({ doi: '10.1234/second', title: 'Second retrieval study' }).item
    })
    const source = await catalog.transact({ kind: 'create-collection', name: 'Source' })
    const target = await catalog.transact({ kind: 'create-collection', name: 'Target' })
    await catalog.transact({
      kind: 'set-collection-item',
      collectionId: source.id,
      itemId: first.id,
      included: true
    })
    await catalog.transact({
      kind: 'move-collection-items',
      sourceCollectionId: source.id,
      targetCollectionId: target.id,
      itemIds: [first.id, second.id]
    })
    await expect(
      catalog.search({ scope: 'library', collectionId: source.id })
    ).resolves.toMatchObject({
      entries: []
    })
    await expect(
      catalog.search({ scope: 'library', collectionId: target.id })
    ).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ id: first.id }),
        expect.objectContaining({ id: second.id })
      ])
    })
  })

  it('enforces sibling Collection names while allowing the same name under different parents', async () => {
    const catalog = await setup()
    const root = await catalog.transact({ kind: 'create-collection', name: ' Review   queue ' })
    await expect(
      catalog.transact({ kind: 'create-collection', name: 'review queue' })
    ).rejects.toThrow('literature_collection_name_conflict')
    const other = await catalog.transact({ kind: 'create-collection', name: 'Other' })
    const child = await catalog.transact({
      kind: 'create-collection',
      name: 'review queue',
      parentId: root.id
    })
    await expect(
      catalog.transact({ kind: 'create-collection', name: 'REVIEW QUEUE', parentId: root.id })
    ).rejects.toThrow('literature_collection_name_conflict')
    await expect(
      catalog.transact({ kind: 'create-collection', name: 'review queue', parentId: other.id })
    ).resolves.toMatchObject({ kind: 'collection' })
    await expect(
      catalog.transact({
        kind: 'update-collection',
        collectionId: other.id,
        name: 'Review queue',
        description: ''
      })
    ).rejects.toThrow('literature_collection_name_conflict')
    await expect(
      catalog.transact({
        kind: 'update-collection',
        collectionId: child.id,
        name: 'REVIEW QUEUE',
        description: 'Updated'
      })
    ).resolves.toMatchObject({ id: child.id })
    const results = await Promise.allSettled([
      catalog.transact({ kind: 'create-collection', name: 'Concurrent' }),
      catalog.transact({ kind: 'create-collection', name: ' concurrent ' })
    ])
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1)
  })

  it('preserves a parent and its associations when child promotion would duplicate a root name', async () => {
    const catalog = await setup()
    const parent = await catalog.transact({ kind: 'create-collection', name: 'Parent' })
    await catalog.transact({ kind: 'create-collection', name: 'Review' })
    const child = await catalog.transact({
      kind: 'create-collection',
      name: 'Review',
      parentId: parent.id
    })
    const item = await catalog.transact({ kind: 'create-item', item: candidate().item })
    await catalog.transact({
      kind: 'set-collection-item',
      collectionId: parent.id,
      itemId: item.id,
      included: true
    })
    await expect(
      catalog.transact({ kind: 'delete-collection', collectionId: parent.id })
    ).rejects.toThrow('literature_collection_name_conflict')
    await expect(catalog.search({ scope: 'collections' })).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ id: parent.id, itemCount: 1 }),
        expect.objectContaining({ id: child.id, parentId: parent.id })
      ])
    })
    await catalog.transact({
      kind: 'update-collection',
      collectionId: child.id,
      name: 'Child review',
      description: ''
    })
    await expect(
      catalog.transact({ kind: 'delete-collection', collectionId: parent.id })
    ).resolves.toMatchObject({ id: parent.id })
    await expect(catalog.search({ scope: 'collections' })).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ id: child.id, name: 'Child review', parentId: undefined })
      ])
    })
    await expect(catalog.get(item.id)).resolves.toMatchObject({ id: item.id })
  })

  it('creates, edits, and deletes a Collection without deleting its references', async () => {
    const catalog = await setup()
    const item = await catalog.transact({ kind: 'create-item', item: candidate().item })
    const collection = await catalog.transact({
      kind: 'create-collection',
      name: 'Screening',
      description: 'Papers awaiting review.'
    })
    await catalog.transact({
      kind: 'set-collection-item',
      collectionId: collection.id,
      itemId: item.id,
      included: true
    })

    await expect(catalog.search({ scope: 'collections' })).resolves.toMatchObject({
      entries: [
        {
          id: collection.id,
          name: 'Screening',
          description: 'Papers awaiting review.',
          itemCount: 1
        }
      ]
    })

    await catalog.transact({
      kind: 'update-collection',
      collectionId: collection.id,
      name: 'Included studies',
      description: 'Final synthesis set.'
    })
    await expect(catalog.search({ scope: 'collections' })).resolves.toMatchObject({
      entries: [
        {
          id: collection.id,
          name: 'Included studies',
          description: 'Final synthesis set.',
          itemCount: 1
        }
      ]
    })

    await expect(
      catalog.transact({ kind: 'delete-collection', collectionId: collection.id })
    ).resolves.toEqual({ kind: 'collection', id: collection.id })
    await expect(catalog.search({ scope: 'collections' })).resolves.toMatchObject({ entries: [] })
    await expect(catalog.get(item.id)).resolves.toMatchObject({ id: item.id })
  })

  it('permanently deletes only trashed Items and their catalog relationships', async () => {
    const catalog = await setup()
    const item = await catalog.transact({ kind: 'create-item', item: candidate().item })
    const collection = await catalog.transact({ kind: 'create-collection', name: 'Delete me' })
    await catalog.transact({
      kind: 'set-collection-item',
      collectionId: collection.id,
      itemId: item.id,
      included: true
    })
    await client!.tag.create({
      data: {
        id: 'tag-delete-me',
        name: 'Delete me',
        nameKey: 'delete me',
        iconKey: 'tag',
        colorKey: 'blue',
        sortOrder: 1
      }
    })
    await client!.tagAssignment.create({
      data: {
        tagId: 'tag-delete-me',
        resourceType: 'literature.item',
        resourceId: item.id
      }
    })

    await expect(
      catalog.transact({ kind: 'delete-items-permanently', itemIds: [item.id] })
    ).rejects.toThrow('Only Literature Items in Trash can be permanently deleted.')

    await catalog.transact({ kind: 'set-item-lifecycle', itemIds: [item.id], state: 'deleted' })
    await expect(
      catalog.transact({ kind: 'delete-items-permanently', itemIds: [item.id] })
    ).resolves.toEqual({ kind: 'item', id: item.id, state: 'deleted-permanently' })
    await expect(catalog.get(item.id)).resolves.toBeUndefined()
    await expect(
      client!.tagAssignment.count({
        where: { resourceType: 'literature.item', resourceId: item.id }
      })
    ).resolves.toBe(0)
    await expect(
      client!.literatureCollectionItem.count({ where: { itemId: item.id } })
    ).resolves.toBe(0)
  })

  it('merges duplicate relationships into a survivor and redirects the old Item id', async () => {
    const catalog = await setup()
    const survivor = await catalog.transact({ kind: 'create-item', item: candidate().item })
    const duplicate = await catalog.transact({
      kind: 'create-item',
      item: candidate({ doi: '10.1234/duplicate', title: 'Duplicate CRAG record' }).item
    })
    const collection = await catalog.transact({ kind: 'create-collection', name: 'Review' })
    await catalog.transact({
      kind: 'set-collection-item',
      collectionId: collection.id,
      itemId: duplicate.id,
      included: true
    })
    await client!.tag.create({
      data: {
        id: 'tag-rag',
        name: 'RAG',
        nameKey: 'rag',
        iconKey: 'tag',
        colorKey: 'blue',
        sortOrder: 1
      }
    })
    await client!.tagAssignment.create({
      data: { tagId: 'tag-rag', resourceType: 'literature.item', resourceId: duplicate.id }
    })
    const current = await catalog.get(survivor.id)
    expect(current).toBeDefined()
    await expect(
      catalog.transact({
        kind: 'merge-items',
        survivorId: survivor.id,
        duplicateIds: [duplicate.id],
        expectedItems: (
          await Promise.all([survivor.id, duplicate.id].map((id) => catalog.get(id)))
        ).map((view) => ({
          id: view!.id,
          metadataRevision: view!.metadataRevision,
          updatedAt: view!.updatedAt
        })),
        expectedMetadataRevision: current!.metadataRevision,
        item: {
          ...current!.item,
          identifiers: [
            ...current!.item.identifiers,
            { scheme: 'doi', value: '10.1234/duplicate', isPrimary: false }
          ]
        }
      })
    ).resolves.toMatchObject({ id: survivor.id, state: 'merged' })
    await expect(catalog.get(duplicate.id)).resolves.toMatchObject({ id: survivor.id })
    await expect(catalog.getMany([duplicate.id])).resolves.toEqual([
      expect.objectContaining({
        id: duplicate.id,
        item: expect.objectContaining({ title: 'Corrective Retrieval Augmented Generation' })
      })
    ])
    await expect(catalog.get(survivor.id)).resolves.toMatchObject({
      collectionIds: [collection.id],
      item: {
        identifiers: expect.arrayContaining([
          expect.objectContaining({ value: '10.1234/duplicate' })
        ])
      }
    })
    await expect(
      client!.tagAssignment.findUnique({
        where: {
          tagId_resourceType_resourceId: {
            tagId: 'tag-rag',
            resourceType: 'literature.item',
            resourceId: survivor.id
          }
        }
      })
    ).resolves.toBeTruthy()
    await expect(catalog.search({ scope: 'library', lifecycle: 'deleted' })).resolves.toMatchObject(
      {
        entries: [{ id: duplicate.id, mergedIntoItemId: survivor.id }]
      }
    )
  })

  it('keeps old references usable after successive merges and permanently deletes every alias', async () => {
    const catalog = await setup()
    const items: Array<{ id: string }> = []
    for (const name of ['first', 'second', 'third']) {
      items.push(
        await catalog.transact({
          kind: 'create-item',
          item: candidate({ doi: `10.1234/${name}`, title: `${name} record` }).item
        })
      )
    }
    const first = items[0]!
    const second = items[1]!
    const third = items[2]!
    for (const [duplicate, survivor] of [
      [first, second],
      [second, third]
    ] as const) {
      const current = (await catalog.get(survivor.id))!
      await catalog.transact({
        kind: 'merge-items',
        survivorId: survivor.id,
        duplicateIds: [duplicate.id],
        expectedItems: (
          await Promise.all([survivor.id, duplicate.id].map((id) => catalog.get(id)))
        ).map((view) => ({
          id: view!.id,
          metadataRevision: view!.metadataRevision,
          updatedAt: view!.updatedAt
        })),
        expectedMetadataRevision: current.metadataRevision,
        item: current.item
      })
    }

    await expect(catalog.get(first.id)).resolves.toMatchObject({
      id: third.id,
      item: { title: 'third record' }
    })
    await expect(catalog.getMany(items.map(({ id }) => id))).resolves.toEqual(
      items.map(({ id }) =>
        expect.objectContaining({ id, item: expect.objectContaining({ title: 'third record' }) })
      )
    )

    await catalog.transact({
      kind: 'set-item-lifecycle',
      itemIds: [third.id],
      state: 'deleted'
    })
    await expect(
      catalog.transact({ kind: 'delete-items-permanently', itemIds: [third.id] })
    ).resolves.toMatchObject({ id: third.id, state: 'deleted-permanently' })
    await expect(
      client!.literatureItem.count({ where: { id: { in: items.map(({ id }) => id) } } })
    ).resolves.toBe(0)
  })
})
