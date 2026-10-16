/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test fixtures retain inferred mock types. */
import {
  LibraryImporter,
  LibraryTransaction,
  normalizeIdentifier,
  normalizedIdentifiers,
  type LibraryImportStore
} from '../src/index.js'
import { literatureItemInputSchema, type LiteratureCatalogCommand } from '../src/contracts.js'
import { describe, expect, it, vi } from 'vitest'
import { memoryLibrary as createMemoryLibrary } from './memory-store.js'
const memoryLibrary = () =>
  createMemoryLibrary({ LibraryTransaction, normalizedIdentifiers, literatureItemInputSchema })
const paper = (doi = '10.1234/paper', title = 'Paper') =>
  literatureItemInputSchema.parse({
    itemType: 'journalArticle',
    title,
    identifiers: [{ scheme: 'doi', value: doi }]
  })
const candidate = (doi = '10.1234/paper') => ({
  item: paper(doi),
  source: { provider: 'test', externalId: doi, rawMetadata: {} },
  origin: { kind: 'agent', projectId: 'project' }
})
const imported = async (db: ReturnType<typeof memoryLibrary>) =>
  (await db.run((tx) => tx.importItems([paper()]))).itemIds[0]!
describe('import-only storage', () => {
  it('previews, deduplicates and supplements without project, screening or Inbox capabilities', async () => {
    const db = memoryLibrary()
    const store: LibraryImportStore = {
      importIdentityRecords: db.store.importIdentityRecords,
      collection: db.store.collection,
      lastCollectionOrder: db.store.lastCollectionOrder,
      linkCollection: db.store.linkCollection,
      createItem: db.store.createItem,
      restoreItem: db.store.restoreItem,
      item: db.store.item,
      replaceMetadata: db.store.replaceMetadata
    }
    const importer = new LibraryImporter(store)
    const inputs = [paper(), paper()]
    const preview = await importer.inspectImportItems(inputs, [])
    expect(preview.map(({ status }) => status)).toEqual(['warning', 'existing'])
    const receipt = await db.run(() => importer.importItems(inputs))
    expect(receipt).toMatchObject({ createdCount: 1, reusedCount: 1 })
    await db.run(() =>
      importer.importItems([{ ...paper(), abstract: 'New abstract' }], undefined, 'fill-missing')
    )
    expect(db.state.items.get(receipt.itemIds[0])?.item.abstract).toBe('New abstract')
    expect(db.state.projects).toEqual(new Set(['project']))
    expect(db.state.candidates.size).toBe(0)
    expect(db.state.invalidated).toEqual([])
  })

  it('retains the transaction rollback requirement for a partially written import', async () => {
    const db = memoryLibrary()
    const store = { ...db.store, createItem: vi.fn(db.store.createItem) }
    store.createItem
      .mockImplementationOnce(db.store.createItem)
      .mockRejectedValueOnce(new Error('disk full'))
    const importer = new LibraryImporter(store)
    await expect(
      db.run(() => importer.importItems([paper(), paper('10.1234/another')]))
    ).rejects.toThrow('disk full')
    expect(db.state.items.size).toBe(0)
  })
})

describe('independent library transactions', () => {
  it('removes text joined to a DOI without requiring a host provider', () =>
    expect(normalizeIdentifier('doi', '10.1234/exampleCopyright')).toBe('10.1234/example'))
  it('previews repeated identities using virtual targets and commits one reference', async () => {
    const db = memoryLibrary(),
      inputs = [paper(), paper()]
    const preview = await db.run((tx) => tx.inspectImportItems(inputs, []))
    expect(preview.map((p) => p.status)).toEqual(['warning', 'existing'])
    expect(preview[1].existingItemId).toBeUndefined()
    expect(db.state.items.size).toBe(0)
    expect(await db.run((tx) => tx.importItems(inputs))).toMatchObject({
      createdCount: 1,
      reusedCount: 1
    })
    expect(db.state.items.size).toBe(1)
  })
  it('plans conflicting batches before any item writes and permits explicit separate copies', async () => {
    const db = memoryLibrary()
    await imported(db)
    const conflict = paper()
    conflict.identifiers.push({ scheme: 'doi', value: '10.1234/other', isPrimary: false })
    const create = vi.spyOn(db.store, 'createItem')
    await expect(db.run((tx) => tx.importItems([paper('10.1234/new'), conflict]))).rejects.toThrow(
      'conflicting identifiers'
    )
    expect(create).not.toHaveBeenCalled()
    expect(db.state.items.size).toBe(1)
    expect(await db.run((tx) => tx.importItems([conflict], undefined, 'separate'))).toMatchObject({
      createdCount: 1
    })
  })
  it('fills missing metadata while preserving conflicting reviewed fields', async () => {
    const db = memoryLibrary(),
      id = await imported(db),
      incoming = { ...paper('10.1234/paper', 'Conflicting title'), abstract: 'new abstract' }
    await db.run((tx) => tx.importItems([incoming], undefined, 'fill-missing'))
    expect(db.state.items.get(id)!.item).toMatchObject({ title: 'Paper', abstract: 'new abstract' })
  })
  it('restores an imported identity from Trash', async () => {
    const db = memoryLibrary(),
      id = await imported(db)
    await db.run((tx) =>
      tx.setItemLifecycle({ kind: 'set-item-lifecycle', itemIds: [id], state: 'deleted' })
    )
    expect(await db.run((tx) => tx.importItems([paper()]))).toMatchObject({
      itemIds: [id],
      reusedCount: 1
    })
    expect(db.state.items.get(id)!.deletedAt).toBeUndefined()
  })
  it('classifies incomplete and invalid import records without persistence', async () => {
    const db = memoryLibrary()
    const result = await db.run((tx) =>
      tx.inspectImportItems(
        [paper()],
        [{ preview: 'broken', error: 'invalid input' }],
        [['missing-year']]
      )
    )
    expect(result[0]).toMatchObject({
      status: 'warning',
      warnings: expect.arrayContaining([
        'missing-authors',
        'missing-year',
        'missing-container-title'
      ])
    })
    expect(result[1]).toMatchObject({ status: 'invalid', index: 1 })
    expect(db.state.items.size).toBe(0)
  })
  it('rejects missing and smart import destinations', async () => {
    const db = memoryLibrary()
    await expect(db.run((tx) => tx.importItems([paper()], 'absent'))).rejects.toThrow('unavailable')
    const { id } = await db.run((tx) => tx.createCollection('smart'))
    db.state.collections.get(id)!.smart = true
    await expect(db.run((tx) => tx.importItems([paper()], id))).rejects.toThrow(
      'ordinary collection'
    )
    expect(db.state.items.size).toBe(0)
  })
  it('keeps accepted Inbox requests idempotent and transfers evidence exactly once', async () => {
    const db = memoryLibrary(),
      { id } = await db.run((tx) => tx.stageCandidate(candidate()))
    const first = await db.run((tx) => tx.acceptCandidate(id))
    await db.run((tx) => tx.acceptCandidate(id))
    expect(db.state.items.size).toBe(1)
    expect(db.state.attachmentTransfers).toHaveLength(1)
    expect(db.state.sources[0].itemId).toBe(first.id)
    expect(db.state.items.get(first.id)!.projectIds).toEqual(['project'])
  })
  it('does not replace a dismissed reviewed candidate on rediscovery', async () => {
    const db = memoryLibrary(),
      { id } = await db.run((tx) => tx.stageCandidate(candidate()))
    await db.run((tx) => tx.settleCandidates([id], 'dismissed'))
    await db.run((tx) =>
      tx.stageCandidate({ ...candidate(), item: paper('10.1234/paper', 'New title') })
    )
    expect(db.state.candidates.get(id)!.state).toBe('dismissed')
    expect(JSON.parse(db.state.candidates.get(id)!.candidateJson).item.title).toBe('Paper')
    await db.run((tx) => tx.restoreCandidates([id]))
    expect(db.state.candidates.get(id)!.state).toBe('pending')
  })
  it('preserves accepted history when its trashed item is rediscovered', async () => {
    const db = memoryLibrary(),
      first = await db.run((tx) => tx.stageCandidate(candidate()))
    const accepted = await db.run((tx) => tx.acceptCandidate(first.id))
    await db.run((tx) =>
      tx.setItemLifecycle({ kind: 'set-item-lifecycle', itemIds: [accepted.id], state: 'deleted' })
    )
    const next = await db.run((tx) => tx.stageCandidate(candidate()))
    expect(next.id).not.toBe(first.id)
    expect(db.state.candidates.get(first.id)!.state).toBe('accepted')
    expect(next.state).toBe('pending')
  })
  it('rolls back a partial settlement or restoration when any candidate is stale', async () => {
    const db = memoryLibrary(),
      { id } = await db.run((tx) => tx.stageCandidate(candidate()))
    await expect(db.run((tx) => tx.settleCandidates([id, 'missing'], 'dismissed'))).rejects.toThrow(
      'not pending'
    )
    expect(db.state.candidates.get(id)!.state).toBe('pending')
    await db.run((tx) => tx.settleCandidates([id], 'dismissed'))
    await expect(db.run((tx) => tx.restoreCandidates([id, 'missing']))).rejects.toThrow(
      'not dismissed'
    )
    expect(db.state.candidates.get(id)!.state).toBe('dismissed')
  })
  it('checks cancellation before the first Inbox write', async () => {
    const db = memoryLibrary(),
      abort = new AbortController()
    abort.abort()
    await expect(
      db.run((tx) => tx.stageCandidate(candidate(), undefined, abort.signal))
    ).rejects.toThrow()
    expect(db.state.candidates.size).toBe(0)
  })
  it('replays metadata receipts without saving sources or metadata again', async () => {
    const db = memoryLibrary(),
      id = await imported(db),
      command = {
        kind: 'update-item' as const,
        itemId: id,
        expectedMetadataRevision: 1,
        item: paper('10.1234/paper', 'Updated')
      }
    const sources = [candidate().source]
    await db.run((tx) => tx.updateItem(command, sources, 'operation'))
    await db.run((tx) => tx.updateItem(command, sources, 'operation'))
    expect(db.state.items.get(id)!.metadataRevision).toBe(2)
    expect(db.state.sources).toHaveLength(1)
    await expect(
      db.run((tx) =>
        tx.updateItem({ ...command, expectedMetadataRevision: 2 }, sources, 'operation')
      )
    ).rejects.toThrow('identity does not match')
  })
  it('rolls back metadata when saving its proof fails', async () => {
    const db = memoryLibrary(),
      id = await imported(db)
    vi.spyOn(db.store, 'saveMetadataReceipt').mockRejectedValueOnce(new Error('receipt write'))
    await expect(
      db.run((tx) =>
        tx.updateItem(
          {
            kind: 'update-item',
            itemId: id,
            expectedMetadataRevision: 1,
            item: paper('10.1234/paper', 'Updated')
          },
          [candidate().source],
          'operation'
        )
      )
    ).rejects.toThrow('receipt write')
    expect(db.state.items.get(id)!.metadataRevision).toBe(1)
    expect(db.state.sources).toEqual([])
  })
  it('rejects stale metadata without rebasing the caller draft', async () => {
    const db = memoryLibrary(),
      id = await imported(db)
    await expect(
      db.run((tx) =>
        tx.updateItem({
          kind: 'update-item',
          itemId: id,
          expectedMetadataRevision: 9,
          item: paper()
        })
      )
    ).rejects.toThrow('revision conflict')
    expect(db.state.items.get(id)!.metadataRevision).toBe(1)
  })
  it('normalizes collection names and rejects stale edits', async () => {
    const db = memoryLibrary(),
      { id } = await db.run((tx) => tx.createCollection('  My   papers  ', ' description '))
    expect(db.state.collections.get(id)).toMatchObject({
      name: 'My papers',
      description: 'description'
    })
    const command = {
      kind: 'update-collection' as const,
      collectionId: id,
      expectedRevision: 1,
      name: 'Changed',
      description: ''
    }
    await db.run((tx) => tx.updateCollection(command))
    await expect(db.run((tx) => tx.updateCollection(command))).rejects.toThrow('revision_conflict')
  })
  it('moves memberships without duplicating existing destination entries', async () => {
    const db = memoryLibrary(),
      id = await imported(db),
      from = await db.run((tx) => tx.createCollection('From')),
      to = await db.run((tx) => tx.createCollection('To'))
    await db.run((tx) =>
      tx.setCollectionItem({
        kind: 'set-collection-item',
        collectionId: from.id,
        itemId: id,
        included: true
      })
    )
    const command = {
      kind: 'move-collection-items' as const,
      itemIds: [id, id],
      sourceCollectionId: from.id,
      targetCollectionId: to.id
    }
    await db.run((tx) => tx.moveCollectionItems(command))
    await db.run((tx) => tx.moveCollectionItems(command))
    expect(db.state.collections.get(from.id)!.members.size).toBe(0)
    expect(db.state.collections.get(to.id)!.members.size).toBe(1)
  })
  it('validates all references before linking a project and rolls back lifecycle batches', async () => {
    const db = memoryLibrary(),
      id = await imported(db)
    await expect(
      db.run((tx) =>
        tx.setProjectItems({
          kind: 'set-project-items',
          projectId: 'project',
          itemIds: [id, 'missing'],
          included: true,
          source: 'library'
        })
      )
    ).rejects.toThrow('unavailable')
    expect(db.state.items.get(id)!.projectIds).toEqual([])
    await expect(
      db.run((tx) =>
        tx.setItemLifecycle({
          kind: 'set-item-lifecycle',
          itemIds: [id, 'missing'],
          state: 'deleted'
        })
      )
    ).rejects.toThrow('unavailable')
    expect(db.state.items.get(id)!.deletedAt).toBeUndefined()
    expect(db.state.invalidated).toEqual([])
  })
  it('rejects permanent deletion of live items and deletes merged aliases with their survivor', async () => {
    const db = memoryLibrary(),
      id = await imported(db)
    await expect(db.run((tx) => tx.deleteItemsPermanently([id]))).rejects.toThrow('Trash')
    const alias = (await db.run((tx) => tx.importItems([paper()], undefined, 'separate')))
      .itemIds[0]!
    db.state.items.get(alias)!.mergedIntoItemId = id
    await db.run((tx) =>
      tx.setItemLifecycle({ kind: 'set-item-lifecycle', itemIds: [id], state: 'deleted' })
    )
    await db.run((tx) => tx.deleteItemsPermanently([id]))
    expect(db.state.items.size).toBe(0)
  })
  it('keeps reviewed snapshots and conflicting screening overrides as merge preconditions', async () => {
    const db = memoryLibrary(),
      ids = (await db.run((tx) => tx.importItems([paper(), paper()], undefined, 'separate')))
        .itemIds
    const command: Extract<LiteratureCatalogCommand, { kind: 'merge-items' }> = {
      kind: 'merge-items',
      survivorId: ids[0],
      duplicateIds: [ids[1]],
      expectedMetadataRevision: 1,
      expectedItems: ids.map((id) => {
        const r = db.state.items.get(id)!
        return { id, metadataRevision: 1, updatedAt: r.updatedAt }
      }),
      item: paper()
    }
    db.state.overrides = [
      { itemId: ids[0], collectionId: 'smart', decision: 'include' },
      { itemId: ids[1], collectionId: 'smart', decision: 'exclude' }
    ]
    await expect(db.run((tx) => tx.mergeItems(command))).rejects.toThrow(
      'conflicting smart collection'
    )
    expect(db.state.invalidated).toEqual([])
    db.state.overrides = []
    await expect(db.run((tx) => tx.mergeItems({ ...command, expectedItems: [] }))).rejects.toThrow(
      'changed after review'
    )
    await db.run((tx) => tx.mergeItems(command))
    expect(db.state.items.get(ids[1])!.mergedIntoItemId).toBe(ids[0])
    expect(db.state.items.get(ids[0])!.metadataRevision).toBe(2)
  })
})
