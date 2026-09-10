import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createLiteratureIdentifierUrl,
  literatureCatalogSearchRequestSchema,
  literatureCatalogCommandSchema,
  type LiteratureCollectionView,
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
import { ProjectRepository } from '../projects/repository'
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

  it('pages global search across collections and literature without duplicates', async () => {
    const catalog = await setup()
    const collection = await catalog.transact({
      kind: 'create-collection',
      name: 'Corrective collection'
    })
    const paper = await catalog.transact({ kind: 'create-item', item: candidate().item })
    await client!.literatureCollection.update({
      where: { id: collection.id },
      data: { updatedAt: new Date(10) }
    })
    await client!.literatureItem.update({
      where: { id: paper.id },
      data: { updatedAt: new Date(20) }
    })
    const first = await catalog.search({ scope: 'global-search', query: 'Corrective', limit: 1 })
    expect(first).toMatchObject({ totalCount: 2, nextOffset: 1, entries: [{ id: paper.id }] })
    const second = await catalog.search({
      scope: 'global-search',
      query: 'Corrective',
      limit: 1,
      offset: first.nextOffset
    })
    expect(second).toMatchObject({ totalCount: 2, entries: [{ id: collection.id, revision: 1 }] })
    expect(second.nextOffset).toBeUndefined()
    expect(
      await catalog.search({ scope: 'global-search', query: 'Corrective', entryKind: 'collection' })
    ).toMatchObject({ totalCount: 1, entries: [{ id: collection.id }] })
    expect(
      await catalog.search({ scope: 'global-search', query: 'Corrective', updatedAfter: 15 })
    ).toMatchObject({ totalCount: 1, entries: [{ id: paper.id }] })
    expect(
      await catalog.search({ scope: 'global-search', query: 'Corrective', entryKind: 'pdf' })
    ).toMatchObject({ totalCount: 0 })
    await catalog.transact({
      kind: 'update-collection',
      collectionId: collection.id,
      expectedRevision: 1,
      name: 'Corrective',
      description: ''
    })
    await client!.literatureCollection.update({
      where: { id: collection.id },
      data: { updatedAt: new Date(10) }
    })
    expect(
      await catalog.search({
        scope: 'global-search',
        query: 'Corrective',
        searchSort: 'relevance',
        limit: 1
      })
    ).toMatchObject({ entries: [{ id: collection.id }] })
    expect(
      await catalog.search({
        scope: 'global-search',
        query: 'Corrective',
        searchSort: 'recent',
        limit: 1
      })
    ).toMatchObject({ entries: [{ id: paper.id }] })
  })

  it('retains normalized matching and mixed-kind counts in global search', async () => {
    const catalog = await setup()
    const paper = await catalog.transact({
      kind: 'create-item',
      item: literatureItemInputSchema.parse({
        itemType: 'book',
        title: 'ÜBERBLICK gene_A',
        creators: [
          { nameMode: 'person', givenName: 'Jane', familyName: 'Smith', creatorType: 'author' }
        ],
        identifiers: [{ scheme: 'doi', value: '10.2468/global-reference' }]
      })
    })
    const collection = await catalog.transact({
      kind: 'create-collection',
      name: 'gene_A collection'
    })
    await catalog.transact({
      kind: 'create-item',
      item: literatureItemInputSchema.parse({ itemType: 'book', title: 'geneXA' })
    })
    for (const query of [
      'überblick',
      'Jane Smith',
      'Smith Jane',
      'https://doi.org/10.2468/GLOBAL-REFERENCE'
    ]) {
      const page = await catalog.search({ scope: 'global-search', query })
      expect(page).toMatchObject({ totalCount: 1, entries: [{ id: paper.id }] })
    }
    const request = literatureCatalogSearchRequestSchema.parse({
      scope: 'global-search',
      query: 'gene_A',
      countOnly: true
    })
    expect(await catalog.search(request)).toEqual({ entries: [], totalCount: 2 })
    const page = await catalog.search({ ...request, countOnly: false })
    expect(new Set(page.entries.map((entry) => 'id' in entry && entry.id))).toEqual(
      new Set([paper.id, collection.id])
    )
  })

  it('excludes deleted project membership from item views and counts', async () => {
    const catalog = await setup()
    const projects = new ProjectRepository(async () => client!)
    const item = await catalog.transact({ kind: 'create-item', item: candidate().item })
    await catalog.transact({
      kind: 'set-project-item',
      projectId: 'project-1',
      itemId: item.id,
      included: true,
      source: 'library'
    })
    await projects.delete('project-1')
    expect(await projects.get('project-1')).toBeNull()
    expect(await client!.projectLiterature.count()).toBe(0)
    expect.soft((await catalog.get(item.id))?.projectIds).toEqual([])
    expect((await catalog.search({ scope: 'project-counts' })).entries).toEqual([])
  })

  it.each(['deleted', 'deleting', 'missing'] as const)(
    'rejects single and bulk membership for a %s project',
    async (state) => {
      const catalog = await setup()
      const projects = new ProjectRepository(async () => client!)
      const item = await catalog.transact({ kind: 'create-item', item: candidate().item })
      if (state === 'deleted') await projects.delete('project-1')
      if (state === 'deleting') await projects.createDeletionIntent('project-1')
      const projectId = state === 'missing' ? 'missing-project' : 'project-1'
      for (const command of [
        { kind: 'set-project-item' as const, itemId: item.id },
        { kind: 'set-project-items' as const, itemIds: [item.id] }
      ]) {
        await expect(
          catalog.transact({ ...command, projectId, included: true, source: 'library' })
        ).rejects.toThrow('Project is unavailable')
      }
      expect(await client!.projectLiterature.count()).toBe(0)
    }
  )

  it.each(['deleted', 'deleting'] as const)(
    'hides retained %s project membership from active reads',
    async (state) => {
      const catalog = await setup()
      const item = await catalog.transact({ kind: 'create-item', item: candidate().item })
      const collection = await catalog.transact({ kind: 'create-collection', name: 'Reading' })
      await catalog.transact({
        kind: 'set-collection-item',
        collectionId: collection.id,
        itemId: item.id,
        included: true
      })
      await client!.projectLiterature.create({
        data: { projectId: 'project-1', itemId: item.id, source: 'library' }
      })
      expect(
        (await catalog.search({ scope: 'global-search', projectId: 'project-1' })).totalCount
      ).toBe(2)
      if (state === 'deleted')
        await client!.project.update({
          where: { id: 'project-1' },
          data: { deletedAt: new Date() }
        })
      else await new ProjectRepository(async () => client!).createDeletionIntent('project-1')
      expect.soft((await catalog.get(item.id))?.projectIds).toEqual([])
      expect.soft((await catalog.getMany([item.id]))[0].projectIds).toEqual([])
      expect
        .soft((await catalog.search({ scope: 'library', projectId: 'project-1' })).totalCount)
        .toBe(0)
      expect.soft((await catalog.search({ scope: 'project-counts' })).entries).toEqual([])
      // Global search retains Library records while hiding their unavailable Project membership.
      expect.soft(await catalog.search({ scope: 'global-search' })).toMatchObject({
        totalCount: 2,
        entries: expect.arrayContaining([expect.objectContaining({ id: item.id, projectIds: [] })])
      })
      expect
        .soft((await catalog.search({ scope: 'global-search', projectId: 'project-1' })).totalCount)
        .toBe(0)
      expect(await client!.projectLiterature.count()).toBe(1)
    }
  )

  it('preserves archived membership and other projects when deleting a project', async () => {
    const catalog = await setup()
    const projects = new ProjectRepository(async () => client!)
    await client!.project.create({
      data: { id: 'archived-project', name: 'Archived', archivedAt: new Date() }
    })
    const staged = await catalog.transact({ kind: 'stage-candidate', candidate: candidate() })
    const accepted = await catalog.transact({ kind: 'accept-candidate', candidateId: staged.id })
    await catalog.transact({
      kind: 'set-project-items',
      itemIds: [accepted.id],
      projectId: 'archived-project',
      included: true,
      source: 'library'
    })
    await projects.delete('project-1')
    expect((await catalog.get(accepted.id))?.projectIds).toEqual(['archived-project'])
    expect(
      await client!.literatureCandidateDiscovery.count({ where: { projectId: 'project-1' } })
    ).toBe(1)
    expect(
      (await catalog.search({ scope: 'library', projectId: 'archived-project' })).totalCount
    ).toBe(1)
  })

  it('accepts a retained candidate without reattaching its deleted source project', async () => {
    const catalog = await setup()
    const projects = new ProjectRepository(async () => client!)
    const staged = await catalog.transact({ kind: 'stage-candidate', candidate: candidate() })
    await projects.delete('project-1')
    const accepted = await catalog.transact({ kind: 'accept-candidate', candidateId: staged.id })
    expect((await catalog.get(accepted.id))?.projectIds).toEqual([])
  })

  it.each(['10.2468/exact-reference', '39876543'])(
    'finds an exact identifier through ordinary search: %s',
    async (query) => {
      const catalog = await setup()
      const created = await catalog.transact({
        kind: 'create-item',
        item: literatureItemInputSchema.parse({
          itemType: 'journalArticle',
          title: 'Identifier control',
          issuedYear: 2024,
          identifiers: [
            { scheme: 'doi', value: '10.2468/exact-reference' },
            { scheme: 'pmid', value: '39876543' }
          ]
        })
      })
      expect((await catalog.get(created.id))!.item.identifiers).toHaveLength(2)
      expect(
        (await catalog.search({ scope: 'library', query: 'Identifier control' })).totalCount
      ).toBe(1)
      const page = await catalog.search(
        literatureCatalogSearchRequestSchema.parse({ scope: 'library', query })
      )
      expect
        .soft(page.entries.flatMap((entry) => ('id' in entry ? [entry.id] : [])))
        .toEqual([created.id])
      expect.soft(page.totalCount).toBe(1)
      expect(
        (await catalog.search({ scope: 'library', query, filter: { yearFrom: 2025 } })).totalCount
      ).toBe(0)
    }
  )

  it.each(['query', 'creator'] as const)(
    'finds a displayed personal name through %s',
    async (surface) => {
      const catalog = await setup()
      const created = await catalog.transact({
        kind: 'create-item',
        item: literatureItemInputSchema.parse({
          itemType: 'journalArticle',
          title: 'Personal author control',
          creators: [
            { nameMode: 'person', givenName: 'Jane', familyName: 'Smith', creatorType: 'author' }
          ]
        })
      })
      await catalog.transact({
        kind: 'create-item',
        item: literatureItemInputSchema.parse({
          itemType: 'journalArticle',
          title: 'Separate authors',
          creators: [
            { nameMode: 'person', givenName: 'Jane', familyName: 'Doe', creatorType: 'author' },
            { nameMode: 'person', givenName: 'John', familyName: 'Smith', creatorType: 'author' }
          ]
        })
      })
      const search = (text: string): ReturnType<LiteratureCatalog['search']> =>
        catalog.search(
          literatureCatalogSearchRequestSchema.parse({
            scope: 'library',
            ...(surface === 'query' ? { query: text } : { filter: { creator: text } })
          })
        )
      expect(
        (await search('Smith Jane')).entries.flatMap((entry) => ('id' in entry ? [entry.id] : []))
      ).toEqual([created.id])
      expect(
        (await search('Jane Smith')).entries.flatMap((entry) => ('id' in entry ? [entry.id] : []))
      ).toEqual([created.id])
    }
  )

  it.each([
    ['Überblick', 'überblick'],
    ['Биология', 'биология'],
    ['ÉTUDE', 'étude']
  ])('matches Unicode case variants of %s', async (title, query) => {
    const catalog = await setup()
    const created = await catalog.transact({
      kind: 'create-item',
      item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title })
    })
    expect((await catalog.search({ scope: 'library', query: title })).totalCount).toBe(1)
    const page = await catalog.search(
      literatureCatalogSearchRequestSchema.parse({ scope: 'library', query })
    )
    expect
      .soft(page.entries.flatMap((entry) => ('id' in entry ? [entry.id] : [])))
      .toEqual([created.id])
    expect.soft(page.totalCount).toBe(1)
  })

  it.each([
    ['95%', '95% confidence'],
    ['gene_A', 'gene_A'],
    ['%', '95% confidence']
  ])('treats ordinary search input literally: %s', async (query, expectedTitle) => {
    const catalog = await setup()
    const ids = new Map<string, string>()
    for (const title of ['95% confidence', '95X confidence', 'gene_A', 'geneXA']) {
      const receipt = await catalog.transact({
        kind: 'create-item',
        item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title })
      })
      ids.set(title, receipt.id)
    }
    const request = literatureCatalogSearchRequestSchema.parse({ scope: 'library', query })
    const page = await catalog.search(request)
    expect
      .soft(page.entries.flatMap((entry) => ('id' in entry ? [entry.id] : [])))
      .toEqual([ids.get(expectedTitle)])
    expect.soft(page.totalCount).toBe(1)
    expect
      .soft((await catalog.search({ ...request, allItemIds: true })).itemIds)
      .toEqual([ids.get(expectedTitle)])
  })

  it('keeps a mixed Trash restore atomic and permits restoring its ordinary item alone', async () => {
    const catalog = await setup()
    const survivor = await catalog.transact({
      kind: 'create-item',
      item: candidate({ doi: '10.2468/retained' }).item
    })
    const alias = await catalog.transact({
      kind: 'create-item',
      item: candidate({ doi: '10.2468/alias', title: 'Alias' }).item
    })
    const ordinary = await catalog.transact({
      kind: 'create-item',
      item: candidate({ doi: '10.2468/ordinary', title: 'Ordinary' }).item
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
    await catalog.transact({ kind: 'set-item-lifecycle', itemIds: [ordinary.id], state: 'deleted' })
    const request = literatureCatalogSearchRequestSchema.parse({
      scope: 'library',
      lifecycle: 'deleted'
    })
    const trash = await catalog.search(request)
    expect(trash.totalCount).toBe(2)
    expect(trash.entries.find((entry) => 'id' in entry && entry.id === alias.id)).toMatchObject({
      mergedIntoItemId: survivor.id
    })
    await expect(
      catalog.transact({
        kind: 'set-item-lifecycle',
        itemIds: trash.entries.flatMap((entry) => ('id' in entry ? [entry.id] : [])),
        state: 'active'
      })
    ).rejects.toThrow('One or more Literature Items are unavailable.')
    expect((await catalog.search(request)).totalCount).toBe(2)
    await catalog.transact({ kind: 'set-item-lifecycle', itemIds: [ordinary.id], state: 'active' })
    expect(
      (await catalog.search(request)).entries.flatMap((entry) => ('id' in entry ? [entry.id] : []))
    ).toEqual([alias.id])
    expect((await catalog.get(ordinary.id))!.id).toBe(ordinary.id)
  })

  it('preserves scope, deduplication and both text conditions for normalized identifiers', async () => {
    const catalog = await setup()
    const item = literatureItemInputSchema.parse({
      itemType: 'book',
      title: '10.2468/scoped control',
      issuedYear: 2024,
      identifiers: [{ scheme: 'doi', value: '10.2468/scoped' }]
    })
    const receipt = await catalog.transact({ kind: 'create-item', item })
    await catalog.transact({
      kind: 'set-project-items',
      projectId: 'project-1',
      itemIds: [receipt.id],
      included: true,
      source: 'library'
    })
    const request = literatureCatalogSearchRequestSchema.parse({
      scope: 'library',
      query: 'https://doi.org/10.2468/SCOPED',
      projectId: 'project-1',
      filter: { query: 'control', itemTypes: ['book'], yearFrom: 2024, yearTo: 2024 }
    })
    expect
      .soft(
        (await catalog.search(request)).entries.flatMap((entry) =>
          'id' in entry ? [entry.id] : []
        )
      )
      .toEqual([receipt.id])
    expect.soft((await catalog.search({ ...request, query: '10.2468/scoped' })).totalCount).toBe(1)
    expect((await catalog.search({ ...request, projectId: 'missing' })).totalCount).toBe(0)
    expect((await catalog.search({ ...request, filter: { query: 'absent' } })).totalCount).toBe(0)
    expect(
      (await catalog.search({ ...request, filter: { itemTypes: ['dataset'] } })).totalCount
    ).toBe(0)
  })

  it('normalizes imported and edited text without losing accents or organization phrase order', async () => {
    const catalog = await setup()
    const {
      itemIds: [id]
    } = await catalog.importItems([
      literatureItemInputSchema.parse({
        itemType: 'book',
        title: 'Imported control',
        abstract: 'ÉTUDE gene_A',
        containerTitle: 'Биология',
        creators: [
          { nameMode: 'organization', literalName: 'Jane Smith Institute', creatorType: 'author' }
        ]
      })
    ])
    expect
      .soft(
        (
          await catalog.search({
            scope: 'library',
            query: 'étude gene_A',
            filter: { containerTitle: 'биология' }
          })
        ).totalCount
      )
      .toBe(1)
    expect((await catalog.search({ scope: 'library', query: 'etude' })).totalCount).toBe(0)
    expect(
      (await catalog.search({ scope: 'library', filter: { creator: 'Smith Jane Institute' } }))
        .totalCount
    ).toBe(0)
    expect(
      (await catalog.search({ scope: 'library', filter: { creator: 'Jane Smith Institute' } }))
        .totalCount
    ).toBe(1)
    const view = (await catalog.get(id!))!
    await catalog.transact({
      kind: 'update-item',
      itemId: id!,
      expectedMetadataRevision: view.metadataRevision,
      item: { ...view.item, title: 'U\u0308berblick', abstract: 'Updated', containerTitle: 'ÉTUDE' }
    })
    expect
      .soft(
        (
          await catalog.search({
            scope: 'library',
            query: 'überblick',
            filter: { containerTitle: 'étude' }
          })
        ).totalCount
      )
      .toBe(1)
    expect((await catalog.search({ scope: 'library', query: 'étude gene_A' })).totalCount).toBe(0)
  })

  it('matches numeric publication identifiers without extracting numbers from unrelated prose', async () => {
    const catalog = await setup()
    const receipt = await catalog.transact({
      kind: 'create-item',
      item: literatureItemInputSchema.parse({
        itemType: 'book',
        title: 'Numeric identifier control',
        identifiers: [
          { scheme: 'isbn', value: '978-0-306-40615-7' },
          { scheme: 'issn', value: '2049-3630' }
        ]
      })
    })
    for (const query of ['9780306406157', '978-0-306-40615-7', '2049-3630']) {
      expect
        .soft(
          (await catalog.search({ scope: 'library', query })).entries.flatMap((entry) =>
            'id' in entry ? [entry.id] : []
          )
        )
        .toEqual([receipt.id])
    }
    expect(
      (await catalog.search({ scope: 'library', query: 'unrelated 9780306406157 prose' }))
        .totalCount
    ).toBe(0)
  })

  it('keeps filtered pages, counts and all IDs complete beyond a scan batch with tied and null years', async () => {
    const catalog = await setup()
    const { itemIds } = await catalog.importItems(
      Array.from({ length: 503 }, (_, index) =>
        literatureItemInputSchema.parse({
          itemType: 'book',
          title: index % 2 ? 'Control' : 'ÉTUDE',
          issuedYear: index < 501 ? 2024 : undefined
        })
      )
    )
    const expected = itemIds.filter((_, index) => index % 2 === 0)
    for (const sortDirection of ['asc', 'desc'] as const) {
      const request = literatureCatalogSearchRequestSchema.parse({
        scope: 'library',
        query: 'étude',
        sortBy: 'year',
        sortDirection,
        limit: 100
      })
      const all = await catalog.search({ ...request, allItemIds: true })
      expect(all.totalCount).toBe(expected.length)
      expect(new Set(all.itemIds)).toEqual(new Set(expected))
      const pages: string[] = []
      let offset = 0
      for (;;) {
        const page = await catalog.search({ ...request, offset })
        expect(page.totalCount).toBe(expected.length)
        pages.push(...page.entries.flatMap((entry) => ('id' in entry ? [entry.id] : [])))
        if (page.nextOffset === undefined) break
        offset = page.nextOffset
      }
      expect(pages).toEqual(all.itemIds)
      expect((await catalog.search({ ...request, offset: 999 })).entries).toEqual([])
    }
  })

  it('does not reinterpret a bare PMID as a different PMCID identity', async () => {
    const catalog = await setup()
    const receipts = []
    for (const scheme of ['pmid', 'pmcid'] as const) {
      receipts.push(
        await catalog.transact({
          kind: 'create-item',
          item: literatureItemInputSchema.parse({
            itemType: 'journalArticle',
            title: `${scheme} control`,
            identifiers: [{ scheme, value: scheme === 'pmid' ? '39876543' : 'PMC39876543' }]
          })
        })
      )
    }
    expect(
      (await catalog.search({ scope: 'library', query: '39876543' })).entries.flatMap((entry) =>
        'id' in entry ? [entry.id] : []
      )
    ).toEqual([receipts[0].id])
    expect(
      (await catalog.search({ scope: 'library', query: 'PMCID: 39876543' })).entries.flatMap(
        (entry) => ('id' in entry ? [entry.id] : [])
      )
    ).toEqual([receipts[1].id])
  })

  it.each(['cond-mat.stat-mech/9901001', 'math.algebra.geometry/9901001'])(
    'recognizes old-style arXiv forms accepted by the shared link contract: %s',
    async (value) => {
      expect(createLiteratureIdentifierUrl('arxiv', value)).toBeDefined()
      const catalog = await setup()
      const receipt = await catalog.transact({
        kind: 'create-item',
        item: literatureItemInputSchema.parse({
          itemType: 'preprint',
          title: 'Archive category control',
          identifiers: [{ scheme: 'arxiv', value }]
        })
      })
      expect(
        (await catalog.search({ scope: 'library', query: value })).entries.flatMap((entry) =>
          'id' in entry ? [entry.id] : []
        )
      ).toEqual([receipt.id])
    }
  )

  describe('source provenance', () => {
    it.each([false, true])(
      'retains independent evidence across item ownership and deletion: %s',
      async (removeFirst) => {
        const catalog = await setup()
        const input = candidate()
        const a = await catalog.transact({ kind: 'create-item', item: input.item })
        const b = await catalog.transact({
          kind: 'create-item',
          item: input.item,
          duplicatePolicy: 'separate'
        })
        for (const [receipt, title] of [
          [a, 'First'],
          [b, 'Second']
        ] as const) {
          const view = (await catalog.get(receipt.id))!
          await catalog.applyMetadata({
            itemId: receipt.id,
            expectedMetadataRevision: view.metadataRevision,
            item: { ...view.item, title },
            source: { ...input.source, rawMetadata: { title } }
          })
        }
        if (removeFirst) {
          await catalog.transact({ kind: 'set-item-lifecycle', itemIds: [a.id], state: 'deleted' })
          await catalog.transact({ kind: 'delete-items-permanently', itemIds: [a.id] })
        }
        expect((await catalog.get(b.id))!.item.title).toBe('Second')
        const rows = await client!.literatureSourceRecord.findMany()
        expect
          .soft(rows.filter((r) => r.itemId === b.id).map((r) => JSON.parse(r.rawMetadataJson)))
          .toEqual([{ title: 'Second' }])
        if (!removeFirst)
          expect
            .soft(rows.filter((r) => r.itemId === a.id).map((r) => JSON.parse(r.rawMetadataJson)))
            .toEqual([{ title: 'First' }])
      }
    )

    it('retains sources for distinct candidates sharing an external identity', async () => {
      const catalog = await setup()
      const a = await catalog.transact({
        kind: 'stage-candidate',
        candidate: candidate({ doi: '10.1234/first' })
      })
      const b = await catalog.transact({
        kind: 'stage-candidate',
        candidate: candidate({ doi: '10.1234/second' })
      })
      expect(b.id).not.toBe(a.id)
      expect
        .soft(await client!.literatureSourceRecord.count({ where: { inboxCandidateId: b.id } }))
        .toBe(1)
      const accepted = await catalog.transact({ kind: 'accept-candidate', candidateId: b.id })
      expect(await catalog.get(accepted.id)).not.toBeNull()
      expect
        .soft(await client!.literatureSourceRecord.count({ where: { itemId: accepted.id } }))
        .toBe(1)
    })

    it('keeps the frozen candidate and accepted evidence at the same version', async () => {
      const catalog = await setup()
      const input = candidate({ title: 'Old title' })
      const old = { ...input, source: { ...input.source, rawMetadata: { title: 'Old title' } } }
      const a = await catalog.transact({ kind: 'stage-candidate', candidate: old })
      const frozen = await client!.literatureSourceRecord.findMany({
        where: { inboxCandidateId: a.id }
      })
      const b = await catalog.transact({
        kind: 'stage-candidate',
        candidate: {
          ...old,
          item: { ...old.item, title: 'New title' },
          source: { ...old.source, rawMetadata: { title: 'New title' } }
        }
      })
      expect(b.id).toBe(a.id)
      expect(
        await client!.literatureSourceRecord.findMany({ where: { inboxCandidateId: a.id } })
      ).toEqual(frozen)
      const pending = await client!.literatureInboxCandidate.findUniqueOrThrow({
        where: { id: a.id }
      })
      expect(JSON.parse(pending.candidateJson).item.title).toBe('Old title')
      const sources = await client!.literatureSourceRecord.findMany({
        where: { inboxCandidateId: a.id }
      })
      expect
        .soft(sources.map((r) => JSON.parse(r.rawMetadataJson)))
        .toContainEqual({ title: 'Old title' })
      const accepted = await catalog.transact({ kind: 'accept-candidate', candidateId: a.id })
      expect((await catalog.get(accepted.id))!.item.title).toBe('Old title')
      const rows = await client!.literatureSourceRecord.findMany({ where: { itemId: accepted.id } })
      expect
        .soft(rows.map((r) => JSON.parse(r.rawMetadataJson)))
        .toContainEqual({ title: 'Old title' })
    })

    it('reads empty, missing and deleted source ownership distinctly', async () => {
      const catalog = await setup()
      const created = await catalog.transact({ kind: 'create-item', item: candidate().item })
      await expect(catalog.sources(created.id)).resolves.toEqual([])
      await expect(catalog.sources('missing')).rejects.toThrow('unavailable')
      await catalog.transact({
        kind: 'set-item-lifecycle',
        itemIds: [created.id],
        state: 'deleted'
      })
      await expect(catalog.sources(created.id)).rejects.toThrow('unavailable')
    })

    it('reads the consolidated sources through the survivor and merged alias', async () => {
      const catalog = await setup()
      const a = await catalog.transact({ kind: 'create-item', item: candidate().item })
      const b = await catalog.transact({
        kind: 'create-item',
        item: candidate().item,
        duplicatePolicy: 'separate'
      })
      for (const [receipt, provider] of [
        [a, 'crossref'],
        [b, 'pubmed']
      ] as const) {
        const view = (await catalog.get(receipt.id))!
        await catalog.applyMetadata({
          itemId: receipt.id,
          expectedMetadataRevision: view.metadataRevision,
          item: view.item,
          source: { ...candidate().source, provider }
        })
      }
      const reviewed = await Promise.all([catalog.get(a.id), catalog.get(b.id)])
      await catalog.transact({
        kind: 'merge-items',
        survivorId: a.id,
        duplicateIds: [b.id],
        item: reviewed[0]!.item,
        expectedMetadataRevision: reviewed[0]!.metadataRevision,
        expectedItems: reviewed.map((view) => ({
          id: view!.id,
          metadataRevision: view!.metadataRevision,
          updatedAt: view!.updatedAt
        }))
      })
      const sources = await catalog.sources(a.id)
      expect(sources.map((source) => source.provider).sort()).toEqual(['crossref', 'pubmed'])
      await expect(catalog.sources(b.id)).resolves.toEqual(sources)
    })

    it('exposes accepted source identity and URL through the item read boundary', async () => {
      const catalog = await setup()
      const input = candidate()
      const staged = await catalog.transact({ kind: 'stage-candidate', candidate: input })
      expect(JSON.stringify(await catalog.search({ scope: 'inbox' }))).toContain(
        input.source.sourceUrl
      )
      const accepted = await catalog.transact({ kind: 'accept-candidate', candidateId: staged.id })
      expect(await client!.literatureSourceRecord.count({ where: { itemId: accepted.id } })).toBe(1)
      expect(await catalog.sources(accepted.id)).toEqual([
        expect.objectContaining({ ...input.source, savedAt: expect.any(Number) })
      ])
    })
  })

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

  it('reads all matching member IDs independently of page limits and later title changes', async () => {
    const catalog = await setup()
    const { itemIds } = await catalog.importItems(
      Array.from({ length: 101 }, (_, index) =>
        literatureItemInputSchema.parse({
          itemType: 'book',
          title: `Paper ${String(index).padStart(3, '0')}`
        })
      )
    )
    await catalog.transact({
      kind: 'set-project-items',
      projectId: 'project-1',
      itemIds,
      included: true,
      source: 'library'
    })
    const page = await catalog.search({
      scope: 'library',
      projectId: 'project-1',
      sortBy: 'title',
      allItemIds: true,
      limit: 1,
      offset: 100
    })
    expect(page).toEqual({ entries: [], itemIds, totalCount: 101 })
    const view = (await catalog.get(itemIds[100]!))!
    await catalog.transact({
      kind: 'update-item',
      itemId: view.id,
      expectedMetadataRevision: view.metadataRevision,
      item: { ...view.item, title: 'A moved reference' }
    })
    expect(page.itemIds).toEqual(itemIds)
    const filtered = await catalog.search({
      scope: 'library',
      projectId: 'project-1',
      filter: { query: 'A moved' },
      allItemIds: true
    })
    expect(filtered.itemIds).toEqual([view.id])
    expect(
      (await catalog.search({ scope: 'library', projectId: 'missing', allItemIds: true })).itemIds
    ).toEqual([])
  })

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
        if (scope === 'collection') {
          const search = await catalog.search({
            scope: 'global-search',
            entryKind: 'collection',
            query: 'Reading'
          })
          expect(search.entries).toMatchObject([
            { id: collection.id, itemCount: state === 'deleted' ? 0 : 1 }
          ])
        }
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

  it('keeps a rediscovered trashed reference pending until explicit acceptance', async () => {
    const catalog = await setup()
    const item = await catalog.transact({ kind: 'create-item', item: candidate().item })
    await catalog.transact({ kind: 'set-item-lifecycle', itemIds: [item.id], state: 'deleted' })
    const staged = await catalog.transact({ kind: 'stage-candidate', candidate: candidate() })
    expect.soft(staged).toMatchObject({ kind: 'candidate', state: 'pending' })
    expect.soft((await catalog.search({ scope: 'inbox' })).entries).toHaveLength(1)
    expect
      .soft(
        (await catalog.search({ scope: 'library', lifecycle: 'deleted' })).entries.map((entry) =>
          'id' in entry ? entry.id : undefined
        )
      )
      .toContain(item.id)
    expect.soft((await catalog.get(item.id))?.projectIds ?? []).toEqual([])
    expect.soft(await client!.literatureSourceRecord.count({ where: { itemId: item.id } })).toBe(0)
    if (staged.kind !== 'candidate') return
    const accepted = await catalog.transact({ kind: 'accept-candidate', candidateId: staged.id })
    expect(accepted.id).toBe(item.id)
    expect((await catalog.get(item.id))!.projectIds).toEqual(['project-1'])
  })

  it('retains provenance when accepting the second PDF from the same provider record', async () => {
    const catalog = await setup()
    const staged = []
    for (const letter of ['a', 'b']) {
      const checksum = letter.repeat(64)
      const blob = await client!.contentBlob.create({
        data: {
          id: `inbox-${letter}`,
          checksum,
          storageKey: `content/${letter}`,
          sizeBytes: 128n,
          contentType: 'application/pdf',
          state: 'available'
        }
      })
      staged.push(
        await catalog.stageAcquiredPdf(candidate(), {
          contentBlobId: blob.id,
          checksum,
          sizeBytes: 128,
          contentType: 'application/pdf',
          filename: `${letter}.pdf`,
          pageCount: 8,
          sourceUrl: 'https://example.test/paper'
        })
      )
    }
    expect(staged[0].id).not.toBe(staged[1].id)
    const accepted = await catalog.transact({ kind: 'accept-candidate', candidateId: staged[1].id })
    expect((await catalog.get(accepted.id))!.attachments).toHaveLength(1)
    expect
      .soft(await client!.literatureSourceRecord.count({ where: { itemId: accepted.id } }))
      .toBe(1)
    expect
      .soft(
        await client!.literatureSourceRecord.count({ where: { inboxCandidateId: staged[0].id } })
      )
      .toBe(1)
    await catalog.transact({ kind: 'dismiss-candidate', candidateId: staged[0].id })
    expect
      .soft(await client!.literatureSourceRecord.count({ where: { itemId: accepted.id } }))
      .toBe(1)
    await catalog.transact({ kind: 'restore-candidates', candidateIds: [staged[0].id] })
    expect(
      (await catalog.transact({ kind: 'accept-candidate', candidateId: staged[0].id })).id
    ).toBe(accepted.id)
    expect((await catalog.get(accepted.id))!.attachments).toHaveLength(2)
    expect(await client!.literatureSourceRecord.count({ where: { itemId: accepted.id } })).toBe(1)
  })

  it('preserves both discovery projects when accepting a globally deduplicated candidate', async () => {
    const catalog = await setup()
    await client!.project.create({ data: { id: 'project-2', name: 'Second research project' } })
    const first = await catalog.transact({ kind: 'stage-candidate', candidate: candidate() })
    const second = await catalog.transact({
      kind: 'stage-candidate',
      candidate: {
        ...candidate(),
        origin: { kind: 'agent', projectId: 'project-2', sessionId: 'session-2' }
      }
    })
    expect(second.id).toBe(first.id)
    const accepted = await catalog.transact({ kind: 'accept-candidate', candidateId: second.id })
    expect([...(await catalog.get(accepted.id))!.projectIds].sort()).toEqual([
      'project-1',
      'project-2'
    ])
  })

  it('stages a fresh review when a previously accepted reference is rediscovered in Trash', async () => {
    const catalog = await setup()
    const first = await catalog.transact({ kind: 'stage-candidate', candidate: candidate() })
    const accepted = await catalog.transact({ kind: 'accept-candidate', candidateId: first.id })
    await catalog.transact({ kind: 'set-item-lifecycle', itemIds: [accepted.id], state: 'deleted' })
    const next = await catalog.transact({ kind: 'stage-candidate', candidate: candidate() })
    expect(next).toMatchObject({ kind: 'candidate', state: 'pending' })
    expect(next.id).not.toBe(first.id)
    expect(
      (await catalog.search({ scope: 'inbox', inboxState: 'accepted' })).entries
    ).toMatchObject([{ id: first.id }])
    expect(
      (await catalog.search({ scope: 'library', lifecycle: 'deleted' })).entries
    ).toMatchObject([{ id: accepted.id }])
    expect((await catalog.transact({ kind: 'accept-candidate', candidateId: next.id })).id).toBe(
      accepted.id
    )
  })

  it('keeps distinct sessions idempotently while preserving a dismissed candidate and skipping deleted projects on acceptance', async () => {
    const catalog = await setup()
    await client!.project.create({ data: { id: 'project-2', name: 'Second project' } })
    const first = await catalog.transact({ kind: 'stage-candidate', candidate: candidate() })
    await catalog.transact({ kind: 'dismiss-candidate', candidateId: first.id })
    const incoming = {
      ...candidate(),
      origin: { kind: 'agent', projectId: 'project-2', sessionId: 'session-2' }
    }
    for (let index = 0; index < 2; index++) {
      expect(
        await catalog.transact({ kind: 'stage-candidate', candidate: incoming })
      ).toMatchObject({ id: first.id, state: 'dismissed' })
    }
    const page = await catalog.search({ scope: 'inbox', inboxState: 'dismissed' })
    expect(page.entries).toMatchObject([
      {
        discoveries: [
          { origin: candidate().origin, createdAt: expect.any(Number) },
          { origin: incoming.origin, createdAt: expect.any(Number) }
        ]
      }
    ])
    expect(await client!.projectLiterature.count()).toBe(0)
    await client!.project.delete({ where: { id: 'project-2' } })
    await catalog.transact({ kind: 'restore-candidates', candidateIds: [first.id] })
    const accepted = await catalog.transact({ kind: 'accept-candidate', candidateId: first.id })
    expect((await catalog.get(accepted.id))!.projectIds).toEqual(['project-1'])
    expect(
      (await catalog.search({ scope: 'inbox', inboxState: 'accepted' })).entries
    ).toMatchObject([
      {
        discoveries: [{ origin: candidate().origin }, { origin: incoming.origin }]
      }
    ])
  })

  it.each([true, false])(
    'merges repeated owner-scoped source snapshots into the survivor (external id: %s)',
    async (identified) => {
      const catalog = await setup()
      const itemIds: string[] = []
      const source = { ...candidate().source, externalId: identified ? 'shared-source' : undefined }
      for (const title of ['First', 'Second']) {
        const created = await catalog.transact({
          kind: 'create-item',
          item: candidate({ title, doi: `10.1234/${title.toLowerCase()}` }).item
        })
        const view = (await catalog.get(created.id))!
        await catalog.applyMetadata({
          itemId: created.id,
          expectedMetadataRevision: view.metadataRevision,
          item: view.item,
          source
        })
        itemIds.push(created.id)
      }
      const current = await Promise.all(itemIds.map(async (id) => (await catalog.get(id))!))
      await catalog.transact({
        kind: 'merge-items',
        survivorId: itemIds[0],
        duplicateIds: [itemIds[1]],
        expectedMetadataRevision: current[0].metadataRevision,
        expectedItems: current.map(({ id, metadataRevision, updatedAt }) => ({
          id,
          metadataRevision,
          updatedAt
        })),
        item: current[0].item
      })
      expect(await client!.literatureSourceRecord.count({ where: { itemId: itemIds[0] } })).toBe(1)
      expect(await client!.literatureSourceRecord.count({ where: { itemId: itemIds[1] } })).toBe(0)
    }
  )

  it('preserves dismissal across service recreation and supports explicit restoration', async () => {
    const catalog = await setup()
    const staged = await catalog.transact({ kind: 'stage-candidate', candidate: candidate() })
    await catalog.transact({ kind: 'dismiss-candidate', candidateId: staged.id })
    const restarted = new LiteratureCatalog(async () => client!)
    expect(await restarted.transact({ kind: 'stage-candidate', candidate: candidate() })).toEqual({
      kind: 'candidate',
      id: staged.id,
      state: 'dismissed'
    })
    expect((await restarted.search({ scope: 'inbox' })).entries).toEqual([])
    expect(
      (await restarted.search({ scope: 'inbox', inboxState: 'dismissed' })).entries
    ).toHaveLength(1)
    await restarted.transact({ kind: 'restore-candidates', candidateIds: [staged.id] })
    expect((await restarted.search({ scope: 'inbox' })).entries).toHaveLength(1)
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
      sourceUrl: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC1/',
      provenance: {
        provider: 'pmc',
        source: 'PMC',
        sourceUrl: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC1/',
        acquiredAt: 123,
        version: 'accepted' as const,
        license: 'cc-by'
      }
    }
    const staged = await catalog.stageAcquiredPdf(candidate(), pdf)
    expect(staged).toMatchObject({ kind: 'candidate', state: 'pending' })
    await expect(catalog.stageAcquiredPdf(candidate(), pdf)).resolves.toEqual(staged)
    expect((await catalog.get(existing.id))!.attachments).toEqual([])
    expect((await catalog.search({ scope: 'inbox' })).entries[0]).toMatchObject({
      pdfs: [{ filename: 'paper.pdf', pageCount: 8 }]
    })
    expect(
      JSON.parse((await client!.literatureInboxPdf.findFirstOrThrow()).provenanceJson!)
    ).toEqual(pdf.provenance)
    const accepted = await catalog.transact({ kind: 'accept-candidate', candidateId: staged.id })
    expect(accepted.id).toBe(existing.id)
    expect((await catalog.get(existing.id))!.attachments[0].versions[0].provenance).toEqual(
      pdf.provenance
    )
    expect((await catalog.get(existing.id))!.attachments).toHaveLength(1)
    expect((await catalog.get(existing.id))!.projectIds).toEqual(['project-1'])
    expect(await client!.literatureInboxPdf.count()).toBe(0)
    await catalog.transact({ kind: 'accept-candidate', candidateId: staged.id })
    expect((await catalog.get(existing.id))!.attachments).toHaveLength(1)
  })

  it('rejects a cancelled acquisition while waiting for the database client before any Inbox write', async () => {
    await setup()
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const catalog = new LiteratureCatalog(async () => {
      await waiting
      return client!
    })
    const controller = new AbortController()
    const pending = catalog.stageAcquiredPdf(
      candidate(),
      {
        contentBlobId: 'unused',
        checksum: 'c'.repeat(64),
        sizeBytes: 128,
        contentType: 'application/pdf',
        filename: 'paper.pdf',
        pageCount: 8,
        sourceUrl: 'https://example.test/paper'
      },
      controller.signal
    )
    controller.abort(new Error('cancelled before transaction'))
    release()
    await expect(pending).rejects.toThrow('cancelled before transaction')
    expect(await client!.literatureInboxCandidate.count()).toBe(0)
    expect(await client!.literatureInboxPdf.count()).toBe(0)
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

  it('rolls back a stale restore batch and allows its still-dismissed subset', async () => {
    const catalog = await setup()
    const first = await catalog.transact({ kind: 'stage-candidate', candidate: candidate() })
    const second = await catalog.transact({
      kind: 'stage-candidate',
      candidate: candidate({ doi: '10.1234/second', externalId: 'second' })
    })
    await catalog.transact({
      kind: 'settle-candidates',
      candidateIds: [first.id, second.id],
      state: 'dismissed'
    })
    // A second caller uses the same public transaction boundary before the stale Undo arrives.
    await catalog.transact({ kind: 'restore-candidates', candidateIds: [first.id] })
    await expect(
      catalog.transact({ kind: 'restore-candidates', candidateIds: [first.id, second.id] })
    ).rejects.toThrow('One or more Literature Inbox candidates are not dismissed.')
    await expect(
      catalog.search({ scope: 'inbox', inboxState: 'dismissed' })
    ).resolves.toMatchObject({
      entries: [expect.objectContaining({ id: second.id, state: 'dismissed' })]
    })
    await catalog.transact({ kind: 'accept-candidate', candidateId: first.id })
    await catalog.transact({ kind: 'restore-candidates', candidateIds: [second.id] })
    await expect(catalog.search({ scope: 'inbox', inboxState: 'pending' })).resolves.toMatchObject({
      entries: [expect.objectContaining({ id: second.id, state: 'pending' })]
    })
    await expect(catalog.search({ scope: 'inbox', inboxState: 'accepted' })).resolves.toMatchObject(
      {
        entries: [expect.objectContaining({ id: first.id, state: 'accepted' })]
      }
    )
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
          itemId_provider_externalId: {
            itemId: accepted.id,
            provider: 'crossref',
            externalId: '10.1234/crag'
          }
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
    const { itemIds: ids } = await catalog.importItems(
      Array.from(
        { length: 201 },
        (_, index) => candidate({ doi: `10.1234/batch-${index}`, title: `Reference ${index}` }).item
      ),
      source.id
    )
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

  it('publishes committed literature writes, excluding no-ops, previews and rollbacks', async () => {
    await setup()
    const events = vi.fn()
    const catalog = new LiteratureCatalog(
      async () => client!,
      undefined,
      undefined,
      undefined,
      events
    )
    const created = await catalog.transact({ kind: 'create-item', item: candidate().item })
    expect(events).toHaveBeenLastCalledWith({
      revision: 1,
      itemIds: [created.id],
      collectionIds: undefined
    })
    expect((await catalog.get(created.id))!.item.title).toBe(candidate().item.title)
    events.mockClear()
    await catalog.importItems([])
    await catalog.inspectImportItems([candidate().item], [])
    await expect(
      catalog.transact({
        kind: 'set-item-lifecycle',
        itemIds: [created.id, 'missing'],
        state: 'deleted'
      })
    ).rejects.toThrow()
    await expect(
      catalog.transact({
        kind: 'update-item',
        itemId: created.id,
        expectedMetadataRevision: 999,
        item: candidate().item
      })
    ).rejects.toThrow()
    expect(events).not.toHaveBeenCalled()
    expect(await catalog.get(created.id)).toBeDefined()
    const collection = await catalog.transact({ kind: 'create-collection', name: 'Shared' })
    const linking = {
      kind: 'set-collection-item' as const,
      collectionId: collection.id,
      itemId: created.id,
      included: true
    }
    await catalog.transact(linking)
    expect(events).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemIds: [created.id], collectionIds: [collection.id] })
    )
    events.mockClear()
    await catalog.transact(linking)
    expect(events).not.toHaveBeenCalled()
    const input = { ...candidate().item, title: 'Saved despite failed delivery' }
    events.mockImplementation(() => {
      throw new Error('Disconnected renderer')
    })
    await expect(
      catalog.transact({
        kind: 'update-item',
        itemId: created.id,
        expectedMetadataRevision: 1,
        item: input
      })
    ).resolves.toMatchObject({ id: created.id })
    expect((await catalog.get(created.id))!.item.title).toBe(input.title)
  })

  it('rejects stale collection edits after promotion, deletion and request retry', async () => {
    const catalog = await setup()
    const parent = await catalog.transact({ kind: 'create-collection', name: 'Parent' })
    const child = await catalog.transact({
      kind: 'create-collection',
      name: 'Child',
      parentId: parent.id
    })
    const command = {
      kind: 'update-collection' as const,
      collectionId: child.id,
      expectedRevision: 1,
      name: 'Changed',
      description: ''
    }
    await catalog.transact({ kind: 'delete-collection', collectionId: parent.id })
    await expect(catalog.transact(command)).rejects.toThrow(
      'literature_collection_revision_conflict'
    )
    await catalog.transact({ ...command, expectedRevision: 2 })
    await expect(catalog.transact({ ...command, expectedRevision: 2 })).rejects.toThrow(
      'literature_collection_revision_conflict'
    )
    await catalog.transact({ kind: 'delete-collection', collectionId: child.id })
    const recreated = await catalog.transact({ kind: 'create-collection', name: 'Changed' })
    expect(recreated.id).not.toBe(child.id)
    await expect(catalog.transact({ ...command, expectedRevision: 3 })).rejects.toThrow(
      'literature_collection_revision_conflict'
    )
  })

  it.each(['name', 'description'] as const)(
    'does not silently overwrite a prior collection edit when a stale editor changes %s',
    async (field) => {
      const first = await setup()
      const second = new LiteratureCatalog(async () => client!)
      const created = await first.transact({
        kind: 'create-collection',
        name: 'Original',
        description: 'Original description'
      })
      const read = async (catalog: LiteratureCatalog): Promise<LiteratureCollectionView> =>
        (await catalog.search({ scope: 'collections' })).entries.find(
          (entry) => 'id' in entry && entry.id === created.id
        ) as LiteratureCollectionView
      const snapshotA = await read(first)
      const snapshotB = await read(second)
      expect(snapshotB).toEqual(snapshotA)
      await first.transact(
        literatureCatalogCommandSchema.parse({
          kind: 'update-collection',
          expectedRevision: 1,
          collectionId: created.id,
          name: 'Renamed by A',
          description: snapshotA.description
        })
      )
      expect((await read(first)).name).toBe('Renamed by A')
      const [saveB] = await Promise.allSettled([
        second.transact(
          literatureCatalogCommandSchema.parse({
            kind: 'update-collection',
            expectedRevision: snapshotA.revision,
            collectionId: created.id,
            name: field === 'name' ? 'Renamed by B' : snapshotB.name,
            description: field === 'description' ? 'Description from B' : snapshotB.description
          })
        )
      ])
      const final = await read(first)
      // A visible conflict or an explicit disjoint-field merge are both safe policies.
      expect.soft(saveB.status).toBe('rejected')
      expect(final.name).toBe('Renamed by A')
      expect(final.description).toBe(
        saveB.status === 'fulfilled' && field === 'description'
          ? 'Description from B'
          : snapshotA.description
      )
    }
  )

  it('reads new attachments and relationships without a metadata or parent timestamp change', async () => {
    const catalog = await setup()
    const created = await catalog.transact({ kind: 'create-item', item: candidate().item })
    const before = (await catalog.get(created.id))!
    const collection = await catalog.transact({ kind: 'create-collection', name: 'Related' })
    await catalog.transact({
      kind: 'set-collection-item',
      collectionId: collection.id,
      itemId: created.id,
      included: true
    })
    await catalog.transact({
      kind: 'set-project-item',
      projectId: 'project-1',
      itemId: created.id,
      included: true,
      source: 'user'
    })
    const checksum = 'a'.repeat(64)
    await client!.contentBlob.create({
      data: {
        id: 'relation-blob',
        checksum,
        storageKey: 'content/relation-blob',
        sizeBytes: 128n,
        contentType: 'application/pdf',
        state: 'available',
        verifiedAt: new Date()
      }
    })
    await catalog.attachContent({
      itemId: created.id,
      contentBlobId: 'relation-blob',
      filename: 'new.pdf',
      contentType: 'application/pdf',
      sizeBytes: 128,
      checksum
    })
    const after = (await catalog.get(created.id))!
    expect(after.attachments).toHaveLength(1)
    expect(after.collectionIds).toEqual([collection.id])
    expect(after.projectIds).toEqual(['project-1'])
    expect(after.metadataRevision).toBe(before.metadataRevision)
    expect(after.updatedAt).toBe(before.updatedAt)
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
        expectedRevision: 1,
        collectionId: other.id,
        name: 'Review queue',
        description: ''
      })
    ).rejects.toThrow('literature_collection_name_conflict')
    await expect(
      catalog.transact({
        kind: 'update-collection',
        expectedRevision: 1,
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
      expectedRevision: 1,
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
    await expect(catalog.search({ scope: 'collections', itemId: item.id })).resolves.toMatchObject({
      entries: [{ id: collection.id }]
    })
    await expect(
      catalog.search({ scope: 'collections', itemId: 'missing-item' })
    ).resolves.toMatchObject({ entries: [], totalCount: 0 })

    await catalog.transact({
      kind: 'update-collection',
      expectedRevision: 1,
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

  it('retains metadata commit proof across edits and soft deletion, and removes it with the reference', async () => {
    const catalog = await setup()
    const created = await catalog.transact({ kind: 'create-item', item: candidate().item })
    const before = (await catalog.get(created.id))!
    const input = {
      operationId: 'review-operation',
      itemId: before.id,
      expectedMetadataRevision: before.metadataRevision,
      item: { ...before.item, containerTitle: 'Committed journal' },
      source: candidate().source
    }
    const committed = await catalog.applyMetadata(input)
    expect(await catalog.getMetadataCommitReceipt(input.operationId)).toEqual({
      operationId: input.operationId,
      itemId: before.id,
      expectedMetadataRevision: before.metadataRevision,
      committedMetadataRevision: committed.metadataRevision
    })
    await catalog.transact({
      kind: 'update-item',
      itemId: before.id,
      expectedMetadataRevision: committed.metadataRevision,
      item: { ...committed.item, title: 'Later edit' }
    })
    const later = (await catalog.get(before.id))!
    expect(await catalog.applyMetadata(input)).toEqual(later)
    await expect(
      catalog.applyMetadata({ ...input, operationId: 'different-operation' })
    ).rejects.toThrow('revision conflict')
    expect(await catalog.getMetadataCommitReceipt('different-operation')).toBeNull()
    await catalog.transact({ kind: 'set-item-lifecycle', itemIds: [before.id], state: 'deleted' })
    expect(await catalog.getMetadataCommitReceipt(input.operationId)).not.toBeNull()
    await catalog.transact({ kind: 'delete-items-permanently', itemIds: [before.id] })
    expect(await catalog.getMetadataCommitReceipt(input.operationId)).toBeNull()
  })

  it('rolls back metadata when its commit receipt cannot be written', async () => {
    const catalog = await setup()
    const created = await catalog.transact({ kind: 'create-item', item: candidate().item })
    const before = (await catalog.get(created.id))!
    const failing = client!.$extends({
      query: {
        literatureMetadataCommitReceipt: {
          async create() {
            throw new Error('Receipt storage unavailable')
          }
        }
      }
    })
    const failingCatalog = new LiteratureCatalog(async () => failing as unknown as PrismaClient)
    await expect(
      failingCatalog.applyMetadata({
        operationId: 'interrupted',
        itemId: before.id,
        expectedMetadataRevision: before.metadataRevision,
        item: { ...before.item, containerTitle: 'Must roll back' },
        source: candidate().source
      })
    ).rejects.toThrow('Receipt storage unavailable')
    expect(await catalog.get(before.id)).toEqual(before)
    expect(await catalog.getMetadataCommitReceipt('interrupted')).toBeNull()
    expect(await client!.literatureSourceRecord.count()).toBe(0)
  })

  it('keeps commit receipts bound to their original reference when references merge', async () => {
    const catalog = await setup()
    const first = await catalog.transact({ kind: 'create-item', item: candidate().item })
    const second = await catalog.transact({
      kind: 'create-item',
      item: candidate({ doi: '10.1234/other' }).item
    })
    const before = (await catalog.get(first.id))!
    await catalog.applyMetadata({
      operationId: 'original-reference-operation',
      itemId: first.id,
      expectedMetadataRevision: before.metadataRevision,
      item: before.item,
      source: candidate().source
    })
    const originalReceipt = await catalog.getMetadataCommitReceipt('original-reference-operation')
    const reviewed = (await Promise.all([catalog.get(first.id), catalog.get(second.id)])).map(
      (item) => item!
    )
    await catalog.transact({
      kind: 'merge-items',
      survivorId: second.id,
      duplicateIds: [first.id],
      item: reviewed[1].item,
      expectedMetadataRevision: reviewed[1].metadataRevision,
      expectedItems: reviewed.map(({ id, metadataRevision, updatedAt }) => ({
        id,
        metadataRevision,
        updatedAt
      }))
    })
    expect(await catalog.getMetadataCommitReceipt('original-reference-operation')).toEqual(
      originalReceipt
    )
    const survivor = (await catalog.get(second.id))!
    await expect(
      catalog.applyMetadata({
        operationId: 'original-reference-operation',
        itemId: second.id,
        expectedMetadataRevision: survivor.metadataRevision,
        item: survivor.item,
        source: candidate().source
      })
    ).rejects.toThrow('operation identity')
    expect(await catalog.get(second.id)).toEqual(survivor)
  })
})
