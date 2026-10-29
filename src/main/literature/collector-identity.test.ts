import { persistentContentReferences } from '../storage/prisma-content-references'
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { migrateApplicationDatabase } from '../database/migration-service'
import { createProjectDbClient } from '../projects/prisma-client'
import { LiteratureCatalog } from './catalog'
import { LiteratureCollector } from './collector'
import {
  collectedReferenceSchema,
  type CollectedReference,
  type CollectorRequest,
  type CollectorResult
} from '../../shared/literature-collector'
import { ContentRepository } from '../storage/content-repository'
import { createTestPdf } from '../../../test/fixtures/literature-pdf'
import { toCslItem } from '@aipoch/literature-citations/csl'
import { type LiteratureItemInput } from '@aipoch/literature-library/item'

const row = (
  key = 'ABCDEFGH',
  title = 'Reviewed paper',
  doi = '10.1234/review'
): { key: string; data: Record<string, unknown> } => ({
  key,
  data: { itemType: 'journalArticle', title, DOI: doi, creators: [], tags: [], collections: [] }
})

const detailedRow = (): ReturnType<typeof row> => ({
  ...row(),
  data: {
    ...row().data,
    creators: [{ firstName: 'Ada', lastName: 'Lovelace', creatorType: 'author' }],
    date: '2024',
    publicationTitle: 'Reviewed Journal'
  }
})

const commitReview = (
  collector: LiteratureCollector,
  preview: CollectorResult,
  keys = ['ABCDEFGH']
): Promise<CollectorResult> =>
  collector.run({
    kind: 'zotero-commit',
    snapshotId: preview.snapshotId!,
    keys,
    includePdfs: false
  })

describe('collector reviewed identity transaction', () => {
  let root: string | undefined
  let client: PrismaClient | undefined
  afterEach(async () => {
    await client?.$disconnect()
    if (root) await rm(root, { recursive: true, force: true })
  })
  const setup = async (
    items: unknown[] = [row()],
    collections: unknown[] = [],
    fileView?: (key: string, defaultPath: string) => Promise<string>
  ): Promise<{
    catalog: LiteratureCatalog
    collector: LiteratureCollector
    pdfPath: string
    content: ContentRepository
  }> => {
    root = await mkdtemp(join(tmpdir(), 'collector-identity-review-'))
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    const content = new ContentRepository({
      references: persistentContentReferences,
      storageRoot: root,
      getClient: async () => client!
    })
    const catalog = new LiteratureCatalog(async () => client!, undefined, content)
    const pdfPath = join(root, 'retry.pdf')
    const collector = new LiteratureCollector({
      catalog,
      content,
      fetch: vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input)
        const key = url.endsWith('/file/view/url') ? url.split('/items/')[1].split('/')[0] : ''
        const path = key && fileView ? await fileView(key, pdfPath) : pdfPath
        return new Response(
          url.endsWith('/file/view/url')
            ? pathToFileURL(path).href
            : JSON.stringify(url.includes('/collections?') ? collections : items),
          { headers: { 'Last-Modified-Version': '1', 'Zotero-Server-ID': 'independent-review' } }
        )
      })
    })
    return { catalog, collector, pdfPath, content }
  }
  const localReference = (title: string): CollectedReference =>
    collectedReferenceSchema.parse({
      item: {
        itemType: 'document',
        title,
        identifiers: [{ scheme: 'doi', value: '10.1234/review' }]
      },
      source: {
        provider: 'zotero',
        externalId: 'local-fixture:ABCDEFGH',
        sourceUrl: 'zotero://select/library/items/ABCDEFGH',
        rawMetadata: {}
      },
      tags: [],
      collectionPaths: []
    })
  const detailedReference = (overrides: Partial<LiteratureItemInput> = {}): CollectedReference =>
    collectedReferenceSchema.parse({
      ...localReference('Reviewed paper'),
      item: {
        itemType: 'journalArticle',
        title: 'Reviewed paper',
        identifiers: [{ scheme: 'doi', value: '10.1234/review' }],
        creators: [
          { nameMode: 'person', givenName: 'Ada', familyName: 'Lovelace', creatorType: 'author' }
        ],
        issuedText: '2024',
        issuedYear: 2024,
        containerTitle: 'Reviewed Journal',
        ...overrides
      }
    })

  it.each(['metadata', 'publication', 'association'] as const)(
    'cancels Zotero during %s, releases unfinished content and retries its committed receipt',
    async (phase) => {
      const fileViews = vi.fn(async (_key: string, path: string) => path)
      const { catalog, collector, pdfPath, content } = await setup(
        [
          row(),
          ...['PDFKEY01', 'PDFKEY02'].map((key) => ({
            key,
            data: { itemType: 'attachment', parentItem: 'ABCDEFGH', contentType: 'application/pdf' }
          }))
        ],
        [],
        fileViews
      )
      await writeFile(pdfPath, createTestPdf('cancelled-zotero'))
      const controller = new AbortController()
      const reason = new Error('Zotero import cancelled')
      const collect = catalog.collectReferences.bind(catalog)
      const writes = vi.spyOn(catalog, 'collectReferences')
      if (phase === 'metadata') {
        writes.mockImplementationOnce(async (...args) => {
          const receipt = await collect(...args)
          controller.abort(reason)
          return receipt
        })
      } else if (phase === 'publication') {
        const publish = content.withPublishedContent.bind(content)
        vi.spyOn(content, 'withPublishedContent').mockImplementationOnce((input, use) =>
          publish(input, async (published) => {
            controller.abort(reason)
            return use(published)
          })
        )
      } else {
        const attach = catalog.attachContent.bind(catalog)
        vi.spyOn(catalog, 'attachContent').mockImplementationOnce((input, onAttached, newItem) =>
          attach(
            input,
            async (tx, result) => {
              controller.abort(reason)
              await onAttached?.(tx, result)
            },
            newItem
          )
        )
      }
      const preview = await collector.run({ kind: 'zotero-preview' })
      const request = {
        kind: 'zotero-commit' as const,
        snapshotId: preview.snapshotId!,
        keys: ['ABCDEFGH'],
        includePdfs: true
      }
      await expect(collector.run(request, controller.signal)).rejects.toBe(reason)
      expect(fileViews).toHaveBeenCalledTimes(phase === 'metadata' ? 0 : 1)
      expect(writes).toHaveBeenCalledTimes(1)
      expect(await client!.literatureItem.count()).toBe(1)
      expect(await client!.literatureSourceRecord.count()).toBe(1)
      expect(await client!.literatureAttachmentVersion.count()).toBe(0)
      expect(await client!.contentBlob.count({ where: { state: 'available' } })).toBe(0)
      const retried = await collector.run(request)
      expect(retried.failures).toEqual([])
      expect(retried.pdfCount).toBe(2)
      expect(writes).toHaveBeenCalledTimes(1)
      expect(await client!.literatureAttachmentVersion.count()).toBe(1)
    }
  )

  it.each([
    {
      name: 'Unicode accented case remains distinct',
      localDoi: '10.26321/Á.GUTIÉRREZ.ZARZA.02.2018.03',
      incomingDoi: '10.26321/á.gutiérrez.zarza.02.2018.03',
      reuse: false
    },
    {
      name: 'Unicode width remains distinct',
      localDoi: '10.1234/Ａ',
      incomingDoi: '10.1234/A',
      reuse: false
    },
    {
      name: 'Unicode composition remains distinct',
      localDoi: '10.1234/é',
      incomingDoi: '10.1234/é',
      reuse: false
    },
    {
      name: 'ASCII case remains equivalent',
      localDoi: '10.1234/ABC',
      incomingDoi: '10.1234/abc',
      reuse: true
    },
    {
      name: 'a legal terminal period remains part of the identifier',
      localDoi: '10.1234/term.',
      incomingDoi: '10.1234/term',
      reuse: false
    },
    {
      name: 'the Crossref encoded resolver URL denotes the same DOI',
      localDoi: '10.1002/(SICI)1521-3951(199911)216:1<135::AID-PSSB135>3.0.CO;2-#',
      incomingDoi:
        'https://doi.org/10.1002/(SICI)1521-3951(199911)216:1<135::AID-PSSB135>3.0.CO;2-%23',
      reuse: true
    },
    {
      name: 'a raw literal percent sequence differs from a hash',
      localDoi: '10.1234/literal%23',
      incomingDoi: '10.1234/literal#',
      reuse: false
    },
    {
      name: 'the encoded percent sign is decoded only from the resolver URL',
      localDoi: '10.1234/literal%23',
      incomingDoi: 'https://doi.org/10.1234/literal%2523',
      reuse: true
    }
  ])(
    'preserves opaque DOI identity across collector imports: $name',
    async ({ localDoi, incomingDoi, reuse }) => {
      // Matching bibliographic fields isolate DOI identity from the explicit metadata-review policy.
      const { catalog, collector } = await setup([row('ABCDEFGH', 'Reviewed paper', incomingDoi)])
      const existing = collectedReferenceSchema.parse({
        item: {
          itemType: 'journalArticle',
          title: 'Reviewed paper',
          url: 'https://example.test/existing-doi',
          identifiers: localDoi ? [{ scheme: 'doi', value: localDoi }] : []
        },
        source: {
          provider: 'zotero',
          externalId: 'https://example.test/existing-doi',
          sourceUrl: 'https://example.test/existing-doi',
          rawMetadata: {}
        },
        tags: [],
        collectionPaths: []
      })
      const [originalId] = (await catalog.collectReferences([existing])).itemIds
      const preview = await collector.run({ kind: 'zotero-preview' })
      expect(preview.entries[0].identity.status).toBe(reuse ? 'reuse' : 'new')
      expect(preview.entries[0].policy).toBe('reuse')
      const [savedId] = (await commitReview(collector, preview)).savedItemIds
      expect(savedId === originalId).toBe(reuse)
      expect(await client!.literatureItem.count()).toBe(reuse ? 1 : 2)
      expect(await client!.literatureSourceRecord.count()).toBe(2)
      const retained = (await catalog.get(originalId))!
      expect(retained.item.identifiers.find(({ scheme }) => scheme === 'doi')?.value).toBe(localDoi)
    }
  )

  it.each([
    ['same name', 'Research', 'Research'],
    ['NFKC', 'Research', 'Ｒｅｓｅａｒｃｈ'],
    ['case', 'Research', 'rEsEaRcH'],
    ['whitespace', 'Research team', '  Research   team  ']
  ])('rejects colliding Zotero collection paths: %s', async (_kind, firstName, secondName) => {
    const first = row()
    const second = row('OTHERKEY', 'Another paper', '10.1234/another')
    const { catalog, collector } = await setup(
      [
        { ...first, data: { ...first.data, collections: ['COLLECT1'] } },
        { ...second, data: { ...second.data, collections: ['COLLECT2'] } }
      ],
      [
        { key: 'COLLECT1', data: { name: firstName, parentCollection: false } },
        { key: 'COLLECT2', data: { name: secondName, parentCollection: false } }
      ]
    )
    const writes = vi.spyOn(catalog, 'collectReferences')
    await expect(collector.run({ kind: 'zotero-preview' })).rejects.toThrow(
      'ZOTERO_COLLECTION_CONFLICT'
    )
    expect(writes).not.toHaveBeenCalled()
    expect(await client!.literatureItem.count()).toBe(0)
    expect(await client!.literatureCollection.count()).toBe(0)
  })

  it('preserves same-named Zotero child collections under different parent paths', async () => {
    const first = row()
    const second = row('OTHERKEY', 'Another paper', '10.1234/another')
    const { collector } = await setup(
      [
        { ...first, data: { ...first.data, collections: ['COLLECT1'] } },
        { ...second, data: { ...second.data, collections: ['COLLECT2'] } }
      ],
      [
        { key: 'ROOTKEY1', data: { name: 'First parent', parentCollection: false } },
        { key: 'ROOTKEY2', data: { name: 'Second parent', parentCollection: false } },
        { key: 'COLLECT1', data: { name: 'Research', parentCollection: 'ROOTKEY1' } },
        { key: 'COLLECT2', data: { name: 'Research', parentCollection: 'ROOTKEY2' } }
      ]
    )
    const preview = await collector.run({ kind: 'zotero-preview' })
    expect(preview.collectionCount).toBe(4)
    await commitReview(collector, preview, ['ABCDEFGH', 'OTHERKEY'])
    const children = await client!.literatureCollection.findMany({
      where: { name: 'Research' },
      include: { parent: true }
    })
    expect(children).toHaveLength(2)
    expect(children.map(({ parent }) => parent!.name).sort()).toEqual([
      'First parent',
      'Second parent'
    ])
    const memberships = await client!.literatureCollectionItem.findMany()
    expect(memberships).toHaveLength(2)
    expect(new Set(memberships.map(({ collectionId }) => collectionId)).size).toBe(2)
  })

  it('rejects colliding ancestor prefixes from a selected item external collection membership', async () => {
    const paper = row()
    const { catalog, collector } = await setup(
      [{ ...paper, data: { ...paper.data, collections: ['COLLECT1', 'COLLECT2'] } }],
      [
        { key: 'ROOTKEY1', data: { name: 'Research', parentCollection: false } },
        { key: 'ROOTKEY2', data: { name: 'ｒｅｓｅａｒｃｈ', parentCollection: false } },
        { key: 'COLLECT1', data: { name: 'Included', parentCollection: 'ROOTKEY1' } },
        { key: 'COLLECT2', data: { name: 'Outside', parentCollection: 'ROOTKEY2' } }
      ]
    )
    const writes = vi.spyOn(catalog, 'collectReferences')
    await expect(
      collector.run({ kind: 'zotero-preview', collectionKey: 'COLLECT1' })
    ).rejects.toThrow('ZOTERO_COLLECTION_CONFLICT')
    expect(writes).not.toHaveBeenCalled()
    expect(await client!.literatureItem.count()).toBe(0)
    expect(await client!.literatureCollection.count()).toBe(0)
  })

  it('requires renewed review when a previously safe reuse is moved to Trash', async () => {
    const { catalog, collector } = await setup()
    const [id] = (await catalog.collectReferences([localReference('Reviewed paper')])).itemIds
    const preview = await collector.run({ kind: 'zotero-preview' })
    expect(preview.entries[0].identity.status).toBe('reuse')
    await client!.literatureItem.update({ where: { id }, data: { deletedAt: new Date() } })
    const commit = collector.run({
      kind: 'zotero-commit',
      snapshotId: preview.snapshotId!,
      keys: ['ABCDEFGH'],
      includePdfs: false
    })
    await commit.catch(() => undefined)
    expect((await client!.literatureItem.findUnique({ where: { id } }))!.deletedAt).not.toBeNull()
    await expect(commit).rejects.toThrow('ZOTERO_PREVIEW_CHANGED')
    const renewed = await collector.run({ kind: 'zotero-preview' })
    expect(renewed.entries[0].identity).toMatchObject({ status: 'review', reason: 'trash' })
    expect(
      (
        await collector.run({
          kind: 'zotero-commit',
          snapshotId: renewed.snapshotId!,
          keys: ['ABCDEFGH'],
          includePdfs: false
        })
      ).savedItemIds
    ).toEqual([id])
    expect((await client!.literatureItem.findUnique({ where: { id } }))!.deletedAt).toBeNull()
  })

  it('requires renewed review when a new row gains a different-title DOI match', async () => {
    const { catalog, collector } = await setup()
    const preview = await collector.run({ kind: 'zotero-preview' })
    expect(preview.entries[0].identity.status).toBe('new')
    const [id] = (await catalog.collectReferences([localReference('A different work')])).itemIds
    const commit = collector.run({
      kind: 'zotero-commit',
      snapshotId: preview.snapshotId!,
      keys: ['ABCDEFGH'],
      includePdfs: false
    })
    await commit.catch(() => undefined)
    expect(await client!.literatureSourceRecord.count({ where: { itemId: id } })).toBe(1)
    await expect(commit).rejects.toThrow('ZOTERO_PREVIEW_CHANGED')
  })

  it('creates a later virtual duplicate when its earlier source row is not selected', async () => {
    const { collector } = await setup([row(), row('OTHERKEY')])
    const preview = await collector.run({ kind: 'zotero-preview' })
    expect(preview.entries.map(({ identity }) => identity.status)).toEqual(['new', 'reuse'])
    const result = await collector.run({
      kind: 'zotero-commit',
      snapshotId: preview.snapshotId!,
      keys: ['OTHERKEY'],
      includePdfs: false
    })
    expect(result.savedItemIds).toHaveLength(1)
    expect(await client!.literatureItem.count()).toBe(1)
    expect(await client!.literatureSourceRecord.findMany()).toMatchObject([
      { externalId: 'independent-review:OTHERKEY' }
    ])
  })

  it('requires renewed review when an identical-looking local match is replaced by another item', async () => {
    const { catalog, collector } = await setup()
    const [originalId] = (await catalog.collectReferences([localReference('Reviewed paper')]))
      .itemIds
    const preview = await collector.run({ kind: 'zotero-preview' })
    expect(preview.entries[0].identity.status).toBe('reuse')
    await client!.literatureSourceRecord.deleteMany({ where: { itemId: originalId } })
    await client!.literatureItem.delete({ where: { id: originalId } })
    const [replacementId] = (await catalog.collectReferences([localReference('Reviewed paper')]))
      .itemIds
    expect(replacementId).not.toBe(originalId)
    await expect(
      collector.run({
        kind: 'zotero-commit',
        snapshotId: preview.snapshotId!,
        keys: ['ABCDEFGH'],
        includePdfs: false
      })
    ).rejects.toThrow('ZOTERO_PREVIEW_CHANGED')
    expect(await client!.literatureSourceRecord.count({ where: { itemId: replacementId } })).toBe(1)
  })

  it('keeps same-batch virtual DOI reuse when both sources are selected', async () => {
    const { collector } = await setup([row(), row('OTHERKEY')])
    const preview = await collector.run({ kind: 'zotero-preview' })
    const result = await collector.run({
      kind: 'zotero-commit',
      snapshotId: preview.snapshotId!,
      keys: ['ABCDEFGH', 'OTHERKEY'],
      includePdfs: false
    })
    expect(result.savedItemIds).toHaveLength(2)
    expect(result.savedItemIds[0]).toBe(result.savedItemIds[1])
    expect(await client!.literatureItem.count()).toBe(1)
    expect(await client!.literatureSourceRecord.count()).toBe(2)
  })

  it('restores a reviewed Trash target shared by two selected sources within the same transaction', async () => {
    const { catalog, collector } = await setup([row(), row('OTHERKEY')])
    const [id] = (await catalog.collectReferences([localReference('Reviewed paper')])).itemIds
    await client!.literatureItem.update({ where: { id }, data: { deletedAt: new Date() } })
    const preview = await collector.run({ kind: 'zotero-preview' })
    expect(preview.entries.map(({ identity }) => identity.reason)).toEqual(['trash', 'trash'])
    const result = await collector.run({
      kind: 'zotero-commit',
      snapshotId: preview.snapshotId!,
      keys: ['ABCDEFGH', 'OTHERKEY'],
      includePdfs: false
    })
    expect(result.savedItemIds).toEqual([id, id])
    expect((await client!.literatureItem.findUnique({ where: { id } }))!.deletedAt).toBeNull()
  })

  it('rolls back earlier references, tags and collections when a later row changed since preview', async () => {
    const first = row('FIRSTKEY', 'New paper', '10.1234/new')
    const { catalog, collector } = await setup(
      [
        {
          ...first,
          data: { ...first.data, tags: [{ tag: 'New tag' }], collections: ['COLLECT1'] }
        },
        row()
      ],
      [{ key: 'COLLECT1', data: { name: 'New collection', parentCollection: false } }]
    )
    const preview = await collector.run({ kind: 'zotero-preview' })
    await catalog.collectReferences([localReference('Changed target')])
    const tagCount = await client!.tag.count()
    const collectionCount = await client!.literatureCollection.count()
    await expect(
      collector.run({
        kind: 'zotero-commit',
        snapshotId: preview.snapshotId!,
        keys: ['FIRSTKEY', 'ABCDEFGH'],
        includePdfs: false
      })
    ).rejects.toThrow('ZOTERO_PREVIEW_CHANGED')
    expect(await client!.literatureItem.count()).toBe(1)
    expect(await client!.literatureSourceRecord.count()).toBe(1)
    expect(await client!.tag.count()).toBe(tagCount)
    expect(await client!.tag.findFirst({ where: { name: 'New tag' } })).toBeNull()
    expect(await client!.literatureCollection.count()).toBe(collectionCount)
  })

  it('retries a repaired PDF without repeating the successful metadata write', async () => {
    const { catalog, collector, pdfPath } = await setup([
      row(),
      {
        key: 'PDFKEY01',
        data: { itemType: 'attachment', parentItem: 'ABCDEFGH', contentType: 'application/pdf' }
      }
    ])
    const writes = vi.spyOn(catalog, 'collectReferences')
    const preview = await collector.run({ kind: 'zotero-preview' })
    const request = {
      kind: 'zotero-commit' as const,
      snapshotId: preview.snapshotId!,
      keys: ['ABCDEFGH'],
      includePdfs: true
    }
    const first = await collector.run(request)
    expect(first.failures).toHaveLength(1)
    expect(first.savedItemIds).toHaveLength(1)
    await writeFile(pdfPath, createTestPdf())
    const retried = await collector.run(request)
    expect(retried.failures).toEqual([])
    expect(retried.pdfCount).toBe(1)
    expect(retried.savedItemIds).toEqual(first.savedItemIds)
    expect(writes).toHaveBeenCalledTimes(1)
    expect(await client!.literatureItem.count()).toBe(1)
    expect(await client!.literatureAttachment.count()).toBe(1)
  })
  it('requires a new preview before changing the selection after metadata was committed', async () => {
    const { catalog, collector } = await setup([
      row(),
      row('OTHERKEY', 'Other paper', '10.1234/other')
    ])
    const writes = vi.spyOn(catalog, 'collectReferences')
    const preview = await collector.run({ kind: 'zotero-preview' })
    await collector.run({
      kind: 'zotero-commit',
      snapshotId: preview.snapshotId!,
      keys: ['ABCDEFGH'],
      includePdfs: false
    })
    await expect(
      collector.run({
        kind: 'zotero-commit',
        snapshotId: preview.snapshotId!,
        keys: ['OTHERKEY'],
        includePdfs: false
      })
    ).rejects.toThrow('ZOTERO_PREVIEW_CHANGED')
    expect(writes).toHaveBeenCalledTimes(1)
    expect(await client!.literatureItem.count()).toBe(1)
  })

  it('retries only failed PDFs and preserves completed copies after their source files disappear', async () => {
    const { catalog, collector, pdfPath } = await setup(
      [
        row(),
        ...['PDFKEY01', 'PDFKEY02'].map((key) => ({
          key,
          data: { itemType: 'attachment', parentItem: 'ABCDEFGH', contentType: 'application/pdf' }
        }))
      ],
      [],
      async (key, defaultPath) => (key === 'PDFKEY01' ? defaultPath + '.first' : defaultPath)
    )
    const firstPath = pdfPath + '.first'
    await writeFile(firstPath, createTestPdf('first-completed'))
    const writes = vi.spyOn(catalog, 'collectReferences')
    const preview = await collector.run({ kind: 'zotero-preview' })
    const request = {
      kind: 'zotero-commit' as const,
      snapshotId: preview.snapshotId!,
      keys: ['ABCDEFGH'],
      includePdfs: true
    }
    const first = await collector.run(request)
    expect(first.pdfCount).toBe(1)
    expect(first.failures).toMatchObject([{ key: 'PDFKEY02' }])
    expect(await client!.literatureAttachment.count()).toBe(1)
    await unlink(firstPath)
    await writeFile(pdfPath, createTestPdf('second-repaired'))
    const retried = await collector.run(request)
    expect(retried.failures).toEqual([])
    expect(retried.pdfCount).toBe(2)
    expect(retried.savedItemIds).toEqual(first.savedItemIds)
    expect(writes).toHaveBeenCalledTimes(1)
    expect(await client!.literatureAttachment.count()).toBe(2)
    expect(await client!.literatureAttachmentVersion.count()).toBe(2)
  })

  it.each(['retry', 'first transfer'] as const)(
    'rejects an outdated PDF target edited during %s without undoing the edit',
    async (phase) => {
      let release!: () => void
      let entered!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const { catalog, collector, pdfPath } = await setup(
        [
          row(),
          {
            key: 'PDFKEY01',
            data: { itemType: 'attachment', parentItem: 'ABCDEFGH', contentType: 'application/pdf' }
          }
        ],
        [],
        async (_key, path) => {
          if (phase === 'first transfer') {
            entered()
            await gate
          }
          return path
        }
      )
      const preview = await collector.run({ kind: 'zotero-preview' })
      const request = {
        kind: 'zotero-commit' as const,
        snapshotId: preview.snapshotId!,
        keys: ['ABCDEFGH'],
        includePdfs: true
      }
      let pending: Promise<CollectorResult> | undefined
      let id: string
      if (phase === 'first transfer') {
        await writeFile(pdfPath, createTestPdf('reviewed-original-work'))
        pending = collector.run(request)
        await started
        id = (await client!.literatureItem.findFirstOrThrow()).id
      } else {
        const first = await collector.run(request)
        expect(first.failures).toHaveLength(1)
        id = first.savedItemIds[0]
      }
      const before = (await catalog.get(id))!
      try {
        await catalog.transact({
          kind: 'update-item',
          itemId: id,
          expectedMetadataRevision: before.metadataRevision,
          item: {
            ...before.item,
            title: 'Changed to a different work',
            identifiers: [{ scheme: 'doi', value: '10.1234/different-work', isPrimary: true }]
          }
        })
        await writeFile(pdfPath, createTestPdf('reviewed-original-work'))
      } finally {
        release()
      }
      const result = await (pending ?? collector.run(request))
      expect(result.failures).toHaveLength(1)
      expect(result.pdfCount).toBe(0)
      expect(await client!.literatureAttachment.count()).toBe(0)
      const edited = (await catalog.get(id))!
      expect(edited.item).toMatchObject({
        title: 'Changed to a different work',
        identifiers: [{ scheme: 'doi', value: '10.1234/different-work' }]
      })
      expect(edited.metadataRevision).toBeGreaterThan(before.metadataRevision)
    }
  )

  it.each([
    [
      'authors',
      {
        creators: [
          {
            nameMode: 'person' as const,
            givenName: 'Grace',
            familyName: 'Hopper',
            creatorType: 'author'
          }
        ]
      }
    ],
    ['year', { issuedText: '2023', issuedYear: 2023 }],
    ['journal', { containerTitle: 'A different journal' }]
  ])(
    'requires review for %s differences even when title and DOI agree',
    async (_field, changes) => {
      const { catalog, collector } = await setup([detailedRow()])
      await catalog.collectReferences([detailedReference(changes)])
      const preview = await collector.run({ kind: 'zotero-preview' })
      expect(preview.entries[0].identity).toMatchObject({
        status: 'review',
        reason: 'metadata',
        matches: [
          {
            creators: expect.any(Array),
            issuedYear: expect.any(Number),
            containerTitle: expect.any(String)
          }
        ]
      })
      expect(preview.entries[0].item.creators[0]).toMatchObject({ givenName: 'Ada' })
      expect(preview.entries[0].item.issuedYear).toBe(2024)
      expect(preview.entries[0].item.containerTitle).toBe('Reviewed Journal')
      expect(await client!.literatureItem.count()).toBe(1)
    }
  )

  it.each(['author', 'year', 'journal', 'revision'] as const)(
    'rejects a changed local %s after review without relying only on DOI',
    async (field) => {
      const { catalog, collector } = await setup([detailedRow()])
      const [id] = (await catalog.collectReferences([detailedReference()])).itemIds
      let preview = await collector.run({ kind: 'zotero-preview' })
      expect(preview.entries[0].identity.status).toBe('reuse')
      if (field === 'revision') {
        preview = await collector.run({
          kind: 'zotero-revise',
          snapshotId: preview.snapshotId!,
          key: 'ABCDEFGH',
          policy: 'fill-missing'
        })
      }
      if (field === 'author') {
        const link = await client!.literatureItemCreator.findFirstOrThrow({ where: { itemId: id } })
        await client!.literatureCreator.update({
          where: { id: link.creatorId },
          data: { givenName: 'Changed' }
        })
      } else {
        await client!.literatureItem.update({
          where: { id },
          data:
            field === 'year'
              ? { issuedYear: 2025 }
              : field === 'journal'
                ? { containerTitle: 'Changed Journal' }
                : { metadataRevision: { increment: 1 }, personalNote: 'Concurrent local note' }
        })
      }
      await expect(commitReview(collector, preview)).rejects.toThrow('ZOTERO_PREVIEW_CHANGED')
      expect(await client!.literatureSourceRecord.count()).toBe(1)
    }
  )

  it('revises only frozen metadata while preserving source, tags, collection and PDF identity', async () => {
    const original: ReturnType<typeof row> = {
      ...row(),
      data: { ...row().data, tags: [{ tag: 'Original tag' }], collections: ['COLLECT1'] }
    }
    const { collector } = await setup(
      [
        original,
        {
          key: 'PDFKEY01',
          data: { itemType: 'attachment', parentItem: 'ABCDEFGH', contentType: 'application/pdf' }
        }
      ],
      [{ key: 'COLLECT1', data: { name: 'Original collection', parentCollection: false } }]
    )
    const preview = await collector.run({ kind: 'zotero-preview' })
    original.data.title = 'Changed upstream after preview'
    const edited = {
      ...preview.entries[0].item,
      title: 'User corrected title',
      url: 'https://example.test/edited-link'
    }
    const revised = await collector.run({
      kind: 'zotero-revise',
      snapshotId: preview.snapshotId!,
      key: 'ABCDEFGH',
      item: edited
    })
    expect(revised.snapshotId).not.toBe(preview.snapshotId)
    expect(revised.entries[0]).toMatchObject({
      title: 'User corrected title',
      pdfCount: 1,
      policy: 'reuse'
    })
    await expect(commitReview(collector, preview)).rejects.toThrow('preview expired')
    const result = await commitReview(collector, revised)
    const source = await client!.literatureSourceRecord.findFirstOrThrow({
      where: { itemId: result.savedItemIds[0] }
    })
    expect(source).toMatchObject({
      provider: 'zotero',
      externalId: 'independent-review:ABCDEFGH',
      sourceUrl: 'zotero://select/library/items/ABCDEFGH'
    })
    expect(JSON.parse(source.rawMetadataJson)).toMatchObject({ title: 'Reviewed paper' })
    expect(await client!.tag.findFirst({ where: { name: 'Original tag' } })).not.toBeNull()
    expect(await client!.literatureCollectionItem.count()).toBe(1)
    expect(
      (await client!.literatureItem.findUniqueOrThrow({ where: { id: result.savedItemIds[0] } }))
        .url
    ).toBe(edited.url)
  })

  it('preserves the old snapshot when input validation or identity inspection rejects an edit', async () => {
    const { catalog, collector } = await setup()
    const preview = await collector.run({ kind: 'zotero-preview' })
    await expect(
      collector.run({
        kind: 'zotero-revise',
        snapshotId: preview.snapshotId!,
        key: 'ABCDEFGH',
        item: { ...preview.entries[0].item, title: '' }
      })
    ).rejects.toThrow()
    const inspect = vi
      .spyOn(catalog, 'inspectCollectedReferences')
      .mockRejectedValueOnce(new Error('Temporary inspection failure'))
    await expect(
      collector.run({
        kind: 'zotero-revise',
        snapshotId: preview.snapshotId!,
        key: 'ABCDEFGH',
        item: { ...preview.entries[0].item, title: 'Failed edit' }
      })
    ).rejects.toThrow('Temporary inspection failure')
    inspect.mockRestore()
    const result = await commitReview(collector, preview)
    expect((await catalog.get(result.savedItemIds[0]))!.item.title).toBe('Reviewed paper')
  })

  it('rejects revisions and commits while a snapshot revision is in flight', async () => {
    const { catalog, collector } = await setup()
    const preview = await collector.run({ kind: 'zotero-preview' })
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const originalInspect = catalog.inspectCollectedReferences.bind(catalog)
    vi.spyOn(catalog, 'inspectCollectedReferences').mockImplementationOnce(async (references) => {
      entered()
      await gate
      return originalInspect(references)
    })
    const pending = collector.run({
      kind: 'zotero-revise',
      snapshotId: preview.snapshotId!,
      key: 'ABCDEFGH',
      policy: 'separate'
    })
    await started
    try {
      await expect(
        collector.run({
          kind: 'zotero-revise',
          snapshotId: preview.snapshotId!,
          key: 'ABCDEFGH',
          policy: 'fill-missing'
        })
      ).rejects.toThrow('ZOTERO_PREVIEW_CHANGED')
      await expect(commitReview(collector, preview)).rejects.toThrow('ZOTERO_PREVIEW_CHANGED')
    } finally {
      release()
    }
    const revised = await pending
    expect(revised.entries[0].policy).toBe('separate')
    expect(await client!.literatureItem.count()).toBe(0)
  })

  it('freezes policy server-side and rejects forged commit or revision source fields', async () => {
    const { collector } = await setup()
    const preview = await collector.run({ kind: 'zotero-preview' })
    await expect(
      collector.run({
        kind: 'zotero-commit',
        snapshotId: preview.snapshotId!,
        keys: ['ABCDEFGH'],
        includePdfs: false,
        policy: 'separate'
      } as unknown as CollectorRequest)
    ).rejects.toThrow()
    await expect(
      collector.run({
        kind: 'zotero-revise',
        snapshotId: preview.snapshotId!,
        key: 'ABCDEFGH',
        policy: 'separate',
        source: { externalId: 'Forged source' }
      } as unknown as CollectorRequest)
    ).rejects.toThrow()
    await commitReview(collector, preview)
    await expect(
      collector.run({
        kind: 'zotero-revise',
        snapshotId: preview.snapshotId!,
        key: 'ABCDEFGH',
        policy: 'separate'
      })
    ).rejects.toThrow('ZOTERO_PREVIEW_CHANGED')
    expect(await client!.literatureItem.count()).toBe(1)
    expect((await client!.literatureSourceRecord.findFirstOrThrow()).externalId).toBe(
      'independent-review:ABCDEFGH'
    )
  })

  it('fills empty fields without replacing local metadata, identifiers or notes', async () => {
    const incoming = detailedRow()
    Object.assign(incoming.data, { abstractNote: 'Incoming abstract', volume: '99', issue: '2' })
    const { catalog, collector } = await setup([incoming])
    const reference = localReference('Locally edited title')
    const [id] = (
      await catalog.collectReferences([
        {
          ...reference,
          item: {
            ...reference.item,
            itemType: 'journalArticle',
            abstract: 'Local abstract',
            personalNote: 'Local note',
            rating: 4,
            typeFields: { volume: '7' }
          }
        }
      ])
    ).itemIds
    const before = (await catalog.get(id))!
    const preview = await collector.run({ kind: 'zotero-preview' })
    const revised = await collector.run({
      kind: 'zotero-revise',
      snapshotId: preview.snapshotId!,
      key: 'ABCDEFGH',
      policy: 'fill-missing'
    })
    expect((await commitReview(collector, revised)).savedItemIds).toEqual([id])
    const after = (await catalog.get(id))!
    expect(after.item).toMatchObject({
      title: 'Locally edited title',
      abstract: 'Local abstract',
      personalNote: 'Local note',
      rating: 4,
      issuedYear: 2024,
      containerTitle: 'Reviewed Journal',
      creators: [{ givenName: 'Ada', familyName: 'Lovelace' }],
      typeFields: { volume: '7', issue: '2' }
    })
    expect(after.item.identifiers).toEqual(before.item.identifiers)
    expect(after.metadataRevision).toBeGreaterThan(before.metadataRevision)
    expect(await client!.literatureItem.count()).toBe(1)
  })

  it('rejects fill-missing across item types without restoring or changing the local item', async () => {
    const { catalog, collector } = await setup([row()])
    const [id] = (await catalog.collectReferences([localReference('Reviewed paper')])).itemIds
    await client!.literatureItem.update({ where: { id }, data: { deletedAt: new Date() } })
    const preview = await collector.run({ kind: 'zotero-preview' })
    const revised = await collector.run({
      kind: 'zotero-revise',
      snapshotId: preview.snapshotId!,
      key: 'ABCDEFGH',
      policy: 'fill-missing'
    })
    await expect(commitReview(collector, revised)).rejects.toThrow('ZOTERO_FILL_TYPE_CONFLICT')
    expect(
      (await client!.literatureItem.findUniqueOrThrow({ where: { id } })).deletedAt
    ).not.toBeNull()
    expect(await client!.literatureSourceRecord.count()).toBe(1)
  })

  it.each([
    { name: 'local year only', year: 2020, date: '' },
    { name: 'local date only', year: undefined, date: '2020-04-05' }
  ])(
    'preserves local citation year during date-conflicting fill-missing: $name',
    async ({ year, date }) => {
      const incoming = row()
      Object.assign(incoming.data, { date: '2021-02-01', abstractNote: 'An added abstract' })
      const { catalog, collector } = await setup([incoming])
      const reference = localReference('Reviewed paper')
      const [id] = (
        await catalog.collectReferences([
          {
            ...reference,
            item: {
              ...reference.item,
              itemType: 'journalArticle',
              issuedYear: year,
              issuedText: date
            }
          }
        ])
      ).itemIds
      const before = (await catalog.get(id))!
      expect(toCslItem(id, before.item).issued?.['date-parts'][0][0]).toBe(2020)
      const preview = await collector.run({ kind: 'zotero-preview' })
      const revised = await collector.run({
        kind: 'zotero-revise',
        snapshotId: preview.snapshotId!,
        key: 'ABCDEFGH',
        policy: 'fill-missing'
      })
      expect((await commitReview(collector, revised)).savedItemIds).toEqual([id])
      const after = (await catalog.get(id))!
      expect(toCslItem(id, after.item).issued).toEqual(toCslItem(id, before.item).issued)
      expect(after.item.issuedYear).toBe(year)
      expect(after.item.issuedText).toBe(date)
      expect(after.item.abstract).toBe('An added abstract')
      expect(await client!.literatureItem.count()).toBe(1)
    }
  )

  it('keeps a separate copy of a corrected conflicting source without mutating its original owner', async () => {
    const { catalog, collector } = await setup()
    const original = await collector.run({ kind: 'zotero-preview' })
    const [originalId] = (await commitReview(collector, original)).savedItemIds
    const before = await catalog.get(originalId)
    const preview = await collector.run({ kind: 'zotero-preview' })
    const revised = await collector.run({
      kind: 'zotero-revise',
      snapshotId: preview.snapshotId!,
      key: 'ABCDEFGH',
      policy: 'separate',
      item: {
        ...preview.entries[0].item,
        title: 'Corrected distinct work',
        identifiers: [{ scheme: 'doi', value: '10.1234/different', isPrimary: false }]
      }
    })
    expect(revised.entries[0].identity.status).toBe('conflict')
    const [copyId] = (await commitReview(collector, revised)).savedItemIds
    expect(copyId).not.toBe(originalId)
    expect((await catalog.get(originalId))!.item).toEqual(before!.item)
    expect((await catalog.get(copyId))!.item.title).toBe('Corrected distinct work')
    expect(await client!.literatureItem.count()).toBe(2)
    expect(await client!.literatureSourceRecord.count()).toBe(2)
  })

  it('checks every DOI-less source owner before separating again and never chooses one arbitrarily', async () => {
    const { collector } = await setup([row('ABCDEFGH', 'Reviewed paper', '')])
    const first = await collector.run({ kind: 'zotero-preview' })
    const [firstId] = (await commitReview(collector, first)).savedItemIds
    const second = await collector.run({ kind: 'zotero-preview' })
    const separate = await collector.run({
      kind: 'zotero-revise',
      snapshotId: second.snapshotId!,
      key: 'ABCDEFGH',
      policy: 'separate'
    })
    const [secondId] = (await commitReview(collector, separate)).savedItemIds
    expect(secondId).not.toBe(firstId)
    const conflict = await collector.run({ kind: 'zotero-preview' })
    expect(conflict.entries[0].identity).toMatchObject({
      status: 'conflict',
      matches: [{ title: 'Reviewed paper' }, { title: 'Reviewed paper' }]
    })
    await expect(commitReview(collector, conflict)).rejects.toThrow('ZOTERO_PREVIEW_CHANGED')
    const separateAgain = await collector.run({
      kind: 'zotero-revise',
      snapshotId: conflict.snapshotId!,
      key: 'ABCDEFGH',
      policy: 'separate'
    })
    await client!.literatureItem.update({
      where: { id: firstId },
      data: { metadataRevision: { increment: 1 } }
    })
    await expect(commitReview(collector, separateAgain)).rejects.toThrow('ZOTERO_PREVIEW_CHANGED')
    expect(await client!.literatureItem.count()).toBe(2)
    const renewed = await collector.run({ kind: 'zotero-preview' })
    const approved = await collector.run({
      kind: 'zotero-revise',
      snapshotId: renewed.snapshotId!,
      key: 'ABCDEFGH',
      policy: 'separate'
    })
    const [thirdId] = (await commitReview(collector, approved)).savedItemIds
    expect([firstId, secondId]).not.toContain(thirdId)
    expect(await client!.literatureItem.count()).toBe(3)
  })

  it('rolls back a separate-then-reuse batch when the first policy makes later identity ambiguous', async () => {
    const { catalog, collector } = await setup([row(), row('OTHERKEY')])
    const [id] = (await catalog.collectReferences([localReference('Reviewed paper')])).itemIds
    const preview = await collector.run({ kind: 'zotero-preview' })
    const revised = await collector.run({
      kind: 'zotero-revise',
      snapshotId: preview.snapshotId!,
      key: 'ABCDEFGH',
      policy: 'separate'
    })
    await expect(commitReview(collector, revised, ['ABCDEFGH', 'OTHERKEY'])).rejects.toThrow(
      'ZOTERO_BATCH_POLICY_CONFLICT'
    )
    expect(await client!.literatureItem.count()).toBe(1)
    expect(await client!.literatureSourceRecord.count()).toBe(1)
    expect((await catalog.get(id))!.item.title).toBe('Reviewed paper')
  })

  it('uses the selected row policy when an earlier row is deselected', async () => {
    const { catalog, collector } = await setup([
      row('FIRSTKEY', 'Unselected paper', '10.1234/unselected'),
      row('OTHERKEY')
    ])
    const [originalId] = (await catalog.collectReferences([localReference('Reviewed paper')]))
      .itemIds
    const preview = await collector.run({ kind: 'zotero-preview' })
    const revised = await collector.run({
      kind: 'zotero-revise',
      snapshotId: preview.snapshotId!,
      key: 'OTHERKEY',
      policy: 'separate'
    })
    const [copyId] = (await commitReview(collector, revised, ['OTHERKEY'])).savedItemIds
    expect(copyId).not.toBe(originalId)
    expect(await client!.literatureItem.count()).toBe(2)
    expect(await client!.literatureItem.count({ where: { title: 'Unselected paper' } })).toBe(0)
    expect(
      await client!.literatureSourceRecord.count({
        where: { externalId: 'independent-review:OTHERKEY' }
      })
    ).toBe(1)
  })

  it('allows fill-then-reuse of one reviewed target when no new identity ambiguity is introduced', async () => {
    const first = row()
    first.data.abstractNote = 'An added abstract'
    const { catalog, collector } = await setup([first, row('OTHERKEY')])
    const reference = localReference('Reviewed paper')
    const [id] = (
      await catalog.collectReferences([
        { ...reference, item: { ...reference.item, itemType: 'journalArticle' } }
      ])
    ).itemIds
    const before = (await catalog.get(id))!
    const preview = await collector.run({ kind: 'zotero-preview' })
    const revised = await collector.run({
      kind: 'zotero-revise',
      snapshotId: preview.snapshotId!,
      key: 'ABCDEFGH',
      policy: 'fill-missing'
    })
    expect((await commitReview(collector, revised, ['ABCDEFGH', 'OTHERKEY'])).savedItemIds).toEqual(
      [id, id]
    )
    const after = (await catalog.get(id))!
    expect(after.item.abstract).toBe('An added abstract')
    expect(after.metadataRevision).toBeGreaterThan(before.metadataRevision)
    expect(await client!.literatureItem.count()).toBe(1)
    expect(await client!.literatureSourceRecord.count()).toBe(3)
  })

  it('rolls back a fill-then-new batch when a filled identifier changes a later target', async () => {
    const { catalog, collector } = await setup([row(), row('OTHERKEY', 'A new paper', '')])
    const reference = localReference('Reviewed paper')
    const [id] = (
      await catalog.collectReferences([
        { ...reference, item: { ...reference.item, itemType: 'journalArticle' } }
      ])
    ).itemIds
    const before = (await catalog.get(id))!
    const preview = await collector.run({ kind: 'zotero-preview' })
    const withFill = await collector.run({
      kind: 'zotero-revise',
      snapshotId: preview.snapshotId!,
      key: 'ABCDEFGH',
      policy: 'fill-missing',
      item: {
        ...preview.entries[0].item,
        identifiers: [
          ...preview.entries[0].item.identifiers,
          { scheme: 'pmid', value: '12345678', isPrimary: false }
        ]
      }
    })
    const withLater = await collector.run({
      kind: 'zotero-revise',
      snapshotId: withFill.snapshotId!,
      key: 'OTHERKEY',
      item: {
        ...withFill.entries[1].item,
        identifiers: [{ scheme: 'pmid', value: '12345678', isPrimary: false }]
      }
    })
    expect(withLater.entries[1].identity.status).toBe('new')
    await expect(commitReview(collector, withLater, ['ABCDEFGH', 'OTHERKEY'])).rejects.toThrow(
      'ZOTERO_BATCH_POLICY_CONFLICT'
    )
    const after = (await catalog.get(id))!
    expect(after.item).toEqual(before.item)
    expect(after.metadataRevision).toBe(before.metadataRevision)
    expect(await client!.literatureItem.count()).toBe(1)
    expect(await client!.literatureSourceRecord.count()).toBe(1)
  })
})
