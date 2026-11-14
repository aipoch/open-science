import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import {
  LiteratureIndex,
  LiteratureReader,
  type DocumentReference
} from '@aipoch/literature-reading'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { LiteratureCatalog } from './catalog'
import { searchCachedLibraryText } from './cached-library-search'
import type { LiteratureDocumentReader } from './document-reader'
import { indexPath, openDatabase } from './full-text-index-sqlite-fixture'
import { openSqliteLiteratureIndex } from './full-text-index-storage'

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type FixtureAttachment = Awaited<ReturnType<LiteratureCatalog['attachContent']>> & {
  reference: DocumentReference
}
type CacheFixture = {
  client: ReturnType<typeof createProjectDbClient>
  catalog: LiteratureCatalog
  core: LiteratureReader<DocumentReference>
  reader: Pick<LiteratureDocumentReader, 'searchCachedAttachments'>
  load: Mock<
    (
      reference: DocumentReference
    ) => Promise<{ text: string; pageCount: number; truncated: boolean }>
  >
  create: (title: string, projectId?: string) => Promise<string>
  attach: (itemId: string, text: string, attachmentId?: string) => Promise<FixtureAttachment>
}
const fixture = async (): Promise<CacheFixture> => {
  const root = await mkdtemp(join(tmpdir(), 'cached-library-search-'))
  const client = createProjectDbClient(root)
  const index = new LiteratureIndex({
    exists: async () => existsSync(indexPath(root)),
    open: async () => openSqliteLiteratureIndex(openDatabase(root), () => {}),
    openExisting: async () => {
      const connection = new DatabaseSync(indexPath(root), { readOnly: true })
      return openSqliteLiteratureIndex(
        {
          query: async <T>(sql: string, ...values: unknown[]) =>
            connection.prepare(sql).all(...(values as SQLInputValue[])) as T,
          execute: async (sql, ...values) =>
            Number(connection.prepare(sql).run(...(values as SQLInputValue[])).changes),
          transaction: async () => {
            throw new Error('Cache discovery must not start a write transaction')
          },
          close: async () => connection.close()
        },
        () => {},
        { existingOnly: true }
      )
    }
  })
  cleanups.push(async () => {
    await index.flushPendingAccesses()
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  })
  await migrateApplicationDatabase(client)
  await client.project.createMany({
    data: [
      { id: 'project-1', name: 'Selected project' },
      { id: 'project-2', name: 'Other project' }
    ]
  })
  const catalog = new LiteratureCatalog(async () => client)
  const texts = new Map<string, string>()
  const load = vi.fn(async (reference: DocumentReference) => ({
    text: texts.get(reference.bindingId)!,
    pageCount: 2,
    truncated: false
  }))
  const core = new LiteratureReader({
    index,
    extractionFingerprint: () => sha('cached-library-search-test'),
    authorize: async (reference) => () => load(reference)
  })
  const create = async (title: string, projectId = 'project-1'): Promise<string> => {
    const item = await catalog.transact({
      kind: 'create-item',
      item: literatureItemInputSchema.parse({
        itemType: 'journalArticle',
        title,
        abstract: 'Controlled methods description.'
      })
    })
    await catalog.transact({
      kind: 'set-project-item',
      projectId,
      itemId: item.id,
      included: true,
      source: 'test'
    })
    return item.id
  }
  const attach = async (
    itemId: string,
    text: string,
    attachmentId?: string
  ): Promise<FixtureAttachment> => {
    const checksum = sha(text)
    const blob = await client.contentBlob.upsert({
      where: { storageKey: checksum + '.pdf' },
      create: {
        id: 'blob-' + checksum,
        checksum,
        storageKey: checksum + '.pdf',
        sizeBytes: BigInt(Buffer.byteLength(text)),
        contentType: 'application/pdf',
        state: 'available',
        verifiedAt: new Date()
      },
      update: {}
    })
    const result = await catalog.attachContent({
      itemId,
      attachmentId,
      contentBlobId: blob.id,
      filename: 'paper.pdf',
      contentType: 'application/pdf',
      sizeBytes: Buffer.byteLength(text),
      checksum,
      pageCount: 2
    })
    const reference = {
      bindingId: result.versionId,
      name: 'paper.pdf',
      checksum,
      sizeBytes: Buffer.byteLength(text)
    }
    texts.set(result.versionId, text)
    return { ...result, reference }
  }
  const reader: Pick<LiteratureDocumentReader, 'searchCachedAttachments'> = {
    // Exercise the production Reader and SQL ranking with an adversarial top-1 budget.
    searchCachedAttachments: vi.fn(
      async (request: Parameters<LiteratureDocumentReader['searchCachedAttachments']>[0]) =>
        core.searchCachedDocuments(
          request.attachments.map((attachment) => ({
            bindingId: attachment.attachmentVersionId,
            name: attachment.filename,
            checksum: attachment.checksum,
            sizeBytes: attachment.sizeBytes
          })),
          request.query,
          1,
          request.signal
        )
    )
  }
  return { client, catalog, core, reader, load, create, attach }
}

describe('searchCachedLibraryText', () => {
  it('rejects an already cancelled request without catalog or Reader work', async () => {
    const controller = new AbortController()
    controller.abort()
    const catalog = { searchForAgent: vi.fn() }
    const reader = { searchCachedAttachments: vi.fn() }
    await expect(
      searchCachedLibraryText(catalog, reader, {
        projectId: 'p',
        query: 'q',
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(catalog.searchForAgent).not.toHaveBeenCalled()
    expect(reader.searchCachedAttachments).not.toHaveBeenCalled()
  })

  it('stops before Reader work when cancelled during catalog lookup', async () => {
    const controller = new AbortController()
    const catalog = {
      searchForAgent: vi.fn(async () => {
        controller.abort()
        return { entries: [], totalCount: 0 }
      })
    }
    const reader = { searchCachedAttachments: vi.fn() }
    await expect(
      searchCachedLibraryText(catalog, reader, {
        projectId: 'p',
        query: 'q',
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(reader.searchCachedAttachments).not.toHaveBeenCalled()
  })

  it('forwards cancellation and rejects a late Reader result', async () => {
    const controller = new AbortController()
    const catalog = { searchForAgent: vi.fn(async () => ({ entries: [], totalCount: 0 })) }
    const reader = {
      searchCachedAttachments: vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
        expect(signal).toBe(controller.signal)
        controller.abort()
        return {
          status: 'available' as const,
          retrievalMode: 'bm25' as const,
          coverage: {
            requestedDocuments: 0,
            cachedDocuments: 0,
            notCachedDocuments: 0,
            unavailableDocuments: 0
          },
          passages: [],
          truncated: false
        }
      })
    }
    await expect(
      searchCachedLibraryText(catalog, reader, {
        projectId: 'p',
        query: 'q',
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(catalog.searchForAgent).toHaveBeenCalledTimes(1)
  })

  it('admits body-only current scoped records before SQL top-K; stale, deleted and foreign hits cannot displace them', async () => {
    const f = await fixture()
    const itemId = await f.create('Body evidence paper')
    const old = await f.attach(itemId, 'mortality '.repeat(40) + 'historical')
    const current = await f.attach(
      itemId,
      'Participants entered. ' + 'background '.repeat(120) + 'Treatment reduced mortality.',
      old.attachmentId
    )
    const outside = await f.attach(
      await f.create('Other project paper', 'project-2'),
      'mortality '.repeat(40) + 'external'
    )
    const deletedId = await f.create('Removed study')
    const deleted = await f.attach(deletedId, 'mortality '.repeat(40) + 'deleted')
    for (const source of [old, current, outside, deleted])
      await f.core.searchDocuments([source.reference], 'mortality')
    await f.catalog.transact({ kind: 'set-item-lifecycle', itemIds: [deletedId], state: 'deleted' })
    expect(
      (
        await f.catalog.searchForAgent({
          scope: 'library',
          projectId: 'project-1',
          query: 'mortality'
        })
      ).entries
    ).toEqual([])
    const before = f.load.mock.calls.length
    const result = await searchCachedLibraryText(f.catalog, f.reader, {
      projectId: 'project-1',
      query: 'mortality'
    })
    expect(result.matches.map((match) => match.attachmentVersionId)).toEqual([current.versionId])
    expect(result.matches[0]).toMatchObject({ itemId, attachmentId: current.attachmentId })
    expect(result).toMatchObject({
      status: 'available',
      scope: 'cached-text-only',
      recordCount: 1,
      resultsRevalidated: true,
      coverage: { requestedDocuments: 1, cachedDocuments: 1 }
    })
    expect(f.load).toHaveBeenCalledTimes(before)
    expect(result.matches[0]).not.toHaveProperty('citationHref')
  })

  it.each([false, true])(
    'counts rejected current PDFs without searching them; available companion: %s',
    async (withCompanion) => {
      const f = await fixture()
      const itemId = await f.create('Unavailable current PDF')
      const old = await f.attach(itemId, 'Old mortality result.')
      const current = await f.attach(itemId, 'Revised mortality result.', old.attachmentId)
      await f.core.searchDocuments([old.reference, current.reference], 'mortality')
      const version = await f.client.literatureAttachmentVersion.findUniqueOrThrow({
        where: { id: current.versionId }
      })
      await f.client.contentBlob.update({
        where: { id: version.contentBlobId },
        data: { state: 'quarantined' }
      })
      const companion = withCompanion
        ? await f.attach(await f.create('Available PDF'), 'Available mortality finding.')
        : undefined
      if (companion) await f.core.searchDocuments([companion.reference], 'mortality')
      const extractions = f.load.mock.calls.length
      const result = await searchCachedLibraryText(f.catalog, f.reader, {
        projectId: 'project-1',
        query: 'mortality'
      })
      expect(result.coverage).toEqual({
        requestedDocuments: withCompanion ? 2 : 1,
        cachedDocuments: withCompanion ? 1 : 0,
        notCachedDocuments: 0,
        unavailableDocuments: 1
      })
      expect(f.reader.searchCachedAttachments).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: companion
            ? [expect.objectContaining({ attachmentVersionId: companion.versionId })]
            : []
        })
      )
      expect(result.matches.map(({ attachmentVersionId }) => attachmentVersionId)).toEqual(
        companion ? [companion.versionId] : []
      )
      expect(f.load).toHaveBeenCalledTimes(extractions)
    }
  )

  it.each(['replacement', 'deletion', 'collection-move', 'project-removal', 'quarantine'] as const)(
    'drops a cached hit after asynchronous %s against authoritative Catalog state',
    async (change) => {
      const f = await fixture()
      const itemId = await f.create('Stable metadata')
      const source = await f.attach(itemId, 'Treatment reduced mortality.')
      const collection = await f.catalog.transact({
        kind: 'create-collection',
        name: 'Selected collection'
      })
      await f.catalog.transact({
        kind: 'set-collection-item',
        collectionId: collection.id,
        itemId,
        included: true
      })
      await f.core.searchDocuments([source.reference], 'mortality')
      const reader: Pick<LiteratureDocumentReader, 'searchCachedAttachments'> = {
        searchCachedAttachments: async (request) => {
          const result = await f.reader.searchCachedAttachments(request)
          if (change === 'quarantine') {
            const version = await f.client.literatureAttachmentVersion.findUniqueOrThrow({
              where: { id: source.versionId }
            })
            await f.client.contentBlob.update({
              where: { id: version.contentBlobId },
              data: { state: 'quarantined' }
            })
          }
          if (change === 'replacement')
            await f.attach(
              itemId,
              'A superseding version with different findings.',
              source.attachmentId
            )
          if (change === 'deletion')
            await f.catalog.transact({
              kind: 'set-item-lifecycle',
              itemIds: [itemId],
              state: 'deleted'
            })
          if (change === 'collection-move')
            await f.catalog.transact({
              kind: 'set-collection-item',
              collectionId: collection.id,
              itemId,
              included: false
            })
          if (change === 'project-removal')
            await f.catalog.transact({
              kind: 'set-project-item',
              projectId: 'project-1',
              itemId,
              included: false,
              source: 'test'
            })
          return result
        }
      }
      const result = await searchCachedLibraryText(f.catalog, reader, {
        projectId: 'project-1',
        query: 'mortality',
        ...(change === 'collection-move'
          ? { scope: 'collection', collectionId: collection.id }
          : {})
      })
      expect(result.matches).toEqual([])
      expect(result.resultsRevalidated).toBe(false)
    }
  )

  it('pages the scoped record set in batches of 20, independently of metadata query matches', async () => {
    const f = await fixture()
    for (let i = 0; i < 21; i++) await f.create(`Methods ${i}`)
    const first = await searchCachedLibraryText(f.catalog, f.reader, {
      projectId: 'project-1',
      query: 'mortality'
    })
    expect(first).toMatchObject({ recordCount: 20, totalRecordCount: 21, nextOffset: 20 })
    const second = await searchCachedLibraryText(f.catalog, f.reader, {
      projectId: 'project-1',
      query: 'mortality',
      offset: first.nextOffset
    })
    expect(second).toMatchObject({ recordCount: 1, totalRecordCount: 21 })
    expect(second.nextOffset).toBeUndefined()
    expect(f.load).not.toHaveBeenCalled()
  })

  it('diagnoses the 100-source selection cap and unavailable cache without claiming complete coverage', async () => {
    const f = await fixture()
    const itemId = await f.create('Many attachments')
    for (let i = 0; i < 101; i++) await f.attach(itemId, `Controlled attachment ${i}.`)
    const result = await searchCachedLibraryText(f.catalog, undefined, {
      projectId: 'project-1',
      query: 'mortality'
    })
    expect(result).toMatchObject({
      status: 'unavailable',
      sourceSelectionTruncated: true,
      recordCount: 1,
      totalRecordCount: 1,
      coverage: {
        requestedDocuments: 100,
        cachedDocuments: 0,
        notCachedDocuments: 0,
        unavailableDocuments: 100
      },
      matches: []
    })
  })

  it.each([
    { label: 'oversized multibyte passages', idLength: 512, contentLength: 5000 },
    { label: 'near-budget multibyte response', idLength: 100, contentLength: 350 }
  ])(
    'bounds discovery previews and complete UTF-8 response: $label',
    async ({ idLength, contentLength }) => {
      const item: LiteratureItemView = {
        id: 'i'.repeat(idLength),
        item: literatureItemInputSchema.parse({
          itemType: 'journalArticle',
          title: '科'.repeat(2_000)
        }),
        attachments: [
          {
            id: 'a'.repeat(idLength),
            kind: 'pdf',
            title: '',
            sortOrder: 0,
            createdAt: 0,
            updatedAt: 0,
            versions: [
              {
                id: 'v'.repeat(idLength),
                versionNumber: 1,
                filename: 'paper.pdf',
                contentType: 'application/pdf',
                sizeBytes: 1,
                checksum: 'a'.repeat(64),
                createdAt: 0
              }
            ]
          }
        ],
        projectIds: ['project-1'],
        collectionIds: [],
        metadataRevision: 1,
        createdAt: 0,
        updatedAt: 0
      }
      const catalog = { searchForAgent: vi.fn(async () => ({ entries: [item], totalCount: 1 })) }
      const reader = {
        searchCachedAttachments: vi.fn(async () => ({
          status: 'available' as const,
          retrievalMode: 'bm25' as const,
          coverage: {
            requestedDocuments: 1,
            cachedDocuments: 1,
            notCachedDocuments: 0,
            unavailableDocuments: 0
          },
          passages: Array.from({ length: 8 }, () => ({
            documentId: 'v'.repeat(idLength),
            documentName: 'paper.pdf',
            pageStart: 1,
            pageEnd: 1,
            textStart: 0,
            textEnd: contentLength,
            content: '科'.repeat(contentLength)
          })),
          truncated: false
        }))
      }
      const result = await searchCachedLibraryText(catalog, reader, {
        projectId: 'project-1',
        query: '科'
      })
      expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(24_000)
      expect(result.matches.length).toBeLessThanOrEqual(8)
      expect(result.truncated).toBe(true)
      expect(
        result.matches.every(
          (match) =>
            match.content.length <= 1_000 && match.contentTruncated === contentLength > 1_000
        )
      ).toBe(true)
    }
  )
})
