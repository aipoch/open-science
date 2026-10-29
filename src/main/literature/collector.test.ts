import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LiteratureCollector } from './collector'
import type { CollectedReferenceInspection } from './catalog'
import { literatureCollectorContract } from '../../shared/literature-collector'
import type { CollectedReference } from '../../shared/literature-collector'
import { toCslItem } from '@aipoch/literature-citations/csl'
import { inspectPdfPageCount } from '../uploads/attachment-media'
vi.mock('../uploads/attachment-media', () => ({
  inspectPdfPageCount: vi.fn().mockResolvedValue(1),
  MAX_AUTO_EXTRACT_PDF_BYTES: 50 * 1024 * 1024
}))

const record = {
  key: 'ABCDEFGH',
  data: {
    itemType: 'journalArticle',
    title: 'A reference',
    DOI: '10.1234/example',
    tags: [{ tag: 'Research' }],
    collections: ['COLLECT1'],
    creators: [{ firstName: 'Ada', lastName: 'Lovelace', creatorType: 'author' }]
  }
}
const collection = { key: 'COLLECT1', data: { name: 'Research', parentCollection: false } }
const pdf = {
  key: 'PDFKEY01',
  data: { itemType: 'attachment', parentItem: 'ABCDEFGH', contentType: 'application/pdf' }
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Preserve inferred mock types in this fixture.
function fixture(
  options: {
    items?: unknown[]
    fileUrl?: string
    versionChanged?: boolean
    now?: () => number
  } = {}
) {
  const catalog = {
    inspectCollectedReferences: vi.fn(
      async (references: readonly CollectedReference[]): Promise<CollectedReferenceInspection[]> =>
        references.map((reference) => ({
          status: 'new',
          reason: 'new',
          reviewedTargets: [],
          identifiers: reference.item.identifiers,
          matches: []
        }))
    ),
    collectReferences: vi.fn().mockResolvedValue({ itemIds: ['item-1'], metadataRevisions: [1] }),
    attachContent: vi
      .fn()
      .mockResolvedValue({ attachmentId: 'attachment-1', versionId: 'version-1' })
  }
  const content = {
    withPublishedContent: vi.fn(async (input, use) =>
      use({ id: 'blob-1', path: input.sourcePath, sizeBytes: 10n, checksum: 'checksum' })
    ),
    sweep: vi.fn(),
    verify: vi.fn().mockResolvedValue({ state: 'available' })
  }
  let requests = 0
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
    expect(new URL(url).searchParams.get('sort') ?? 'dateAdded').toBe('dateAdded')
    requests += 1
    if (url.endsWith('/file/view/url'))
      return new Response(options.fileUrl ?? 'https://example.test/private.pdf')
    const entries = url.includes('/collections?') ? [collection] : (options.items ?? [record, pdf])
    return new Response(JSON.stringify(entries), {
      headers: {
        'Last-Modified-Version': options.versionChanged && requests > 1 ? '2' : '1',
        'Zotero-Server-ID': 'server-1'
      }
    })
  })
  const collector = new LiteratureCollector({
    catalog,
    content,
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: options.now
  })
  return { collector, catalog, content, fetch }
}
describe('Zotero collector', () => {
  it('includes descendant references and PDFs once without reading unrelated collections', async () => {
    const f = fixture()
    const child = { key: 'CHILD001', data: { name: 'Child', parentCollection: 'COLLECT1' } }
    const other = { key: 'OTHER001', data: { name: 'Other', parentCollection: false } }
    const nested = {
      ...record,
      key: 'NESTED01',
      data: { ...record.data, collections: ['CHILD001'] }
    }
    f.fetch.mockImplementation(async (url) => {
      const path = new URL(url).pathname
      const items = path.endsWith('/collections')
        ? [collection, child, other]
        : path.endsWith('/COLLECT1/items')
          ? [record]
          : path.endsWith('/CHILD001/items')
            ? [record, nested, pdf]
            : []
      return new Response(JSON.stringify(items), {
        headers: { 'Last-Modified-Version': '1', 'Zotero-Server-ID': 'server-1' }
      })
    })
    const preview = await f.collector.run({ kind: 'zotero-preview', collectionKey: 'COLLECT1' })
    expect(preview.entries.map(({ key, pdfCount }) => ({ key, pdfCount }))).toEqual([
      { key: 'ABCDEFGH', pdfCount: 1 },
      { key: 'NESTED01', pdfCount: 0 }
    ])
    expect(preview.collectionCount).toBe(2)
    expect(f.fetch).toHaveBeenCalledTimes(3)
    expect(f.fetch.mock.calls.some(([url]) => url.includes('/OTHER001/items'))).toBe(false)
    await f.collector.run({
      kind: 'zotero-commit',
      snapshotId: preview.snapshotId!,
      keys: ['NESTED01'],
      includePdfs: false
    })
    expect(f.catalog.collectReferences.mock.calls[0][0][0].collectionPaths).toEqual([
      ['Research', 'Child']
    ])
  })

  it.each([
    [[{ tag: 'x'.repeat(65) }]],
    [Array.from({ length: 101 }, (_, index) => ({ tag: `tag-${index}` }))]
  ])(
    'skips unsupported tags without blocking valid references or losing revision diagnostics',
    async (tags) => {
      const f = fixture({
        items: [{ ...record, key: 'BADTAG01', data: { ...record.data, tags } }, record]
      })
      const preview = await f.collector.run({ kind: 'zotero-preview' })
      expect(preview.failures).toEqual([{ key: 'BADTAG01', message: 'ZOTERO_TAG_LIMIT' }])
      expect(preview.entries.map(({ key }) => key)).toEqual(['ABCDEFGH'])
      const revised = await f.collector.run({
        kind: 'zotero-revise',
        snapshotId: preview.snapshotId!,
        key: 'ABCDEFGH',
        policy: 'reuse'
      })
      expect(revised.failures).toEqual(preview.failures)
      const result = await f.collector.run({
        kind: 'zotero-commit',
        snapshotId: revised.snapshotId!,
        keys: ['ABCDEFGH'],
        includePdfs: false
      })
      expect(f.catalog.collectReferences.mock.calls[0][0]).toHaveLength(1)
      expect(result.failures).toEqual([])
    }
  )

  it.each(['request', 'response body'] as const)(
    'propagates caller cancellation during the Zotero %s without continuing the preview',
    async (phase) => {
      const f = fixture()
      const controller = new AbortController()
      const reason = new Error('Caller stopped Zotero import')
      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const cancel = vi.fn()
      if (phase === 'request') {
        f.fetch.mockImplementationOnce(async (_url, init) => {
          entered()
          await new Promise<void>((_resolve, reject) =>
            init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
              once: true
            })
          )
          throw new Error('Unexpected response')
        })
      } else {
        f.fetch.mockResolvedValueOnce(
          new Response(
            new ReadableStream(
              {
                pull: () => {
                  entered()
                },
                cancel
              },
              { highWaterMark: 0 }
            ),
            {
              headers: { 'Last-Modified-Version': '1', 'Zotero-Server-ID': 'server-1' }
            }
          )
        )
      }
      const pending = f.collector.run({ kind: 'zotero-preview' }, controller.signal)
      const rejected = expect(pending).rejects.toBe(reason)
      await started
      controller.abort(reason)
      await rejected
      expect(f.fetch).toHaveBeenCalledTimes(1)
      expect(f.catalog.inspectCollectedReferences).not.toHaveBeenCalled()
      expect(f.catalog.collectReferences).not.toHaveBeenCalled()
      if (phase === 'response body') expect(cancel).toHaveBeenCalledTimes(1)
    }
  )

  it('rejects a removed browser-save request before reading or writing anything', async () => {
    const f = fixture()
    await expect(
      f.collector.run({
        kind: 'browser-save',
        capture: { title: 'Paper', url: 'https://example.test/paper' }
      } as unknown as Parameters<LiteratureCollector['run']>[0])
    ).rejects.toThrow()
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.catalog.collectReferences).not.toHaveBeenCalled()
    expect(f.catalog.attachContent).not.toHaveBeenCalled()
    expect(f.content.withPublishedContent).not.toHaveBeenCalled()
  })

  it('rejects malformed Zotero metadata before identity inspection or persistence', async () => {
    const f = fixture({ items: [{ ...record, data: { ...record.data, title: '   ' } }] })
    await expect(f.collector.run({ kind: 'zotero-preview' })).rejects.toThrow()
    expect(f.catalog.inspectCollectedReferences).not.toHaveBeenCalled()
    expect(f.catalog.collectReferences).not.toHaveBeenCalled()
    expect(f.catalog.attachContent).not.toHaveBeenCalled()
    expect(f.content.withPublishedContent).not.toHaveBeenCalled()
  })

  it('maps Zotero publisher aliases into the existing citation fields', async () => {
    const f = fixture({
      items: [
        {
          key: 'BOOKKEY1',
          data: { itemType: 'book', title: 'Book', place: 'Cambridge', publisher: 'Press' }
        },
        {
          key: 'THESIS01',
          data: {
            itemType: 'thesis',
            title: 'Thesis',
            university: 'University',
            publisher: 'Fallback'
          }
        },
        {
          key: 'REPORT01',
          data: {
            itemType: 'report',
            title: 'Report',
            institution: 'Institute',
            publisher: 'Fallback'
          }
        }
      ]
    })
    const preview = await f.collector.run({ kind: 'zotero-preview' })
    const items = preview.entries.map(({ key, item }) => toCslItem(key, item))
    expect(items[0]).toMatchObject({ 'publisher-place': 'Cambridge', publisher: 'Press' })
    expect(items[1].publisher).toBe('University')
    expect(items[2].publisher).toBe('Institute')
  })
  it('preserves patent issue dates and primary creators in the existing citation model', async () => {
    const f = fixture({
      items: [
        {
          key: 'PATENT01',
          data: {
            itemType: 'patent',
            title: 'Patent',
            issueDate: '2020-06-01',
            date: '1999',
            creators: [
              { firstName: 'Ada', lastName: 'Lovelace', creatorType: 'inventor' },
              { name: 'Research Institute', creatorType: 'inventor' },
              { name: 'Agent', creatorType: 'attorneyAgent' }
            ]
          }
        }
      ]
    })
    const preview = await f.collector.run({ kind: 'zotero-preview' })
    expect(toCslItem('patent', preview.entries[0].item)).toMatchObject({
      issued: { 'date-parts': [[2020, 6, 1]] },
      author: [{ given: 'Ada', family: 'Lovelace' }, { literal: 'Research Institute' }]
    })
    await f.collector.run({
      kind: 'zotero-commit',
      snapshotId: preview.snapshotId!,
      keys: ['PATENT01'],
      includePdfs: false
    })
    expect(
      f.catalog.collectReferences.mock.calls[0][0][0].source.rawMetadata.creators[0].creatorType
    ).toBe('inventor')
  })
  it('keeps type-specific aliases scoped and falls back only when their native field is empty', async () => {
    const f = fixture({
      items: [
        {
          key: 'JOURNAL1',
          data: {
            itemType: 'journalArticle',
            title: 'Article',
            date: '2024',
            issueDate: '1999',
            publisher: 'Press',
            university: 'Wrong',
            institution: 'Wrong',
            creators: [{ name: 'A role', creatorType: 'inventor' }]
          }
        },
        {
          key: 'PATENT01',
          data: { itemType: 'patent', title: 'Patent', issueDate: '', date: '2024' }
        },
        {
          key: 'THESIS01',
          data: { itemType: 'thesis', title: 'Thesis', university: '', publisher: 'Press' }
        },
        {
          key: 'REPORT01',
          data: { itemType: 'report', title: 'Report', institution: '', publisher: 'Press' }
        }
      ]
    })
    const preview = await f.collector.run({ kind: 'zotero-preview' })
    expect(preview.entries[0].item).toMatchObject({
      issuedYear: 2024,
      typeFields: { publisher: 'Press' },
      creators: [{ creatorType: 'inventor' }]
    })
    expect(preview.entries[1].item.issuedYear).toBe(2024)
    expect(preview.entries.slice(2).map(({ item }) => item.typeFields.publisher)).toEqual([
      'Press',
      'Press'
    ])
  })
  it.each([
    ['2024-02-29T12:34:56Z', Date.UTC(2024, 1, 29, 12, 34, 56)],
    ['2024-03-01T01:00:00+02:00', Date.UTC(2024, 1, 29, 23)],
    ['2024-02-29', Date.UTC(2024, 1, 29)],
    ['', undefined],
    ['not a date', undefined],
    ['2024-02-30T12:00:00Z', undefined]
  ])(
    'maps the Zotero access date without inventing a timestamp: %s',
    async (accessDate, expected) => {
      const f = fixture({
        items: [{ key: 'WEBPAGE1', data: { itemType: 'webpage', title: 'Webpage', accessDate } }]
      })
      const preview = await f.collector.run({ kind: 'zotero-preview' })
      expect(preview.entries[0].item.accessedAt).toBe(expected)
      expect(toCslItem('web', preview.entries[0].item).accessed).toEqual(
        expected === undefined ? undefined : { 'date-parts': [[2024, 2, 29]] }
      )
    }
  )
  it.each([
    [new TypeError('fetch failed'), 'ZOTERO_CONNECTION_FAILED'],
    [new DOMException('expired', 'TimeoutError'), 'ZOTERO_REQUEST_TIMED_OUT'],
    [new DOMException('aborted', 'AbortError'), 'ZOTERO_REQUEST_TIMED_OUT']
  ])(
    'classifies transport failures without leaking raw network errors (%s)',
    async (error, code) => {
      const f = fixture()
      f.fetch.mockRejectedValueOnce(error)
      await expect(f.collector.run({ kind: 'zotero-preview' })).rejects.toThrow(code)
      expect(f.catalog.collectReferences).not.toHaveBeenCalled()
    }
  )
  it('includes catalog conflict evidence in the frozen preview and commits only selected keys', async () => {
    const f = fixture({
      items: [
        record,
        { ...record, key: 'OTHERKEY', data: { ...record.data, title: 'Other reference' } }
      ]
    })
    f.catalog.inspectCollectedReferences.mockResolvedValueOnce([
      {
        status: 'conflict',
        reason: 'conflict',
        reviewedTargets: [],
        identifiers: [],
        matches: [{ title: 'Local reference', identifiers: [] }]
      },
      { status: 'new', reason: 'new', identifiers: [], matches: [], reviewedTargets: [] }
    ])
    const preview = await f.collector.run({ kind: 'zotero-preview' })
    expect(literatureCollectorContract.result.parse(preview)).toEqual(preview)
    expect(preview.entries[0].identity).not.toHaveProperty('reviewedTargets')
    expect(preview.entries[0].identity.status).toBe('conflict')
    expect(preview.entries[0].identity.matches[0].title).toBe('Local reference')
    await f.collector.run({
      kind: 'zotero-commit',
      snapshotId: preview.snapshotId!,
      keys: ['OTHERKEY'],
      includePdfs: false
    })
    expect(f.catalog.collectReferences.mock.calls[0][0]).toMatchObject([
      { item: { title: 'Other reference' } }
    ])
    expect(f.catalog.collectReferences.mock.calls[0][0]).toHaveLength(1)
  })
  it('identifies the disabled local API and permits a fresh preview after it is enabled', async () => {
    const f = fixture()
    f.fetch.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
    await expect(f.collector.run({ kind: 'zotero-preview' })).rejects.toThrow(
      'ZOTERO_LOCAL_API_DISABLED'
    )
    expect((await f.collector.run({ kind: 'zotero-preview' })).entries).toHaveLength(1)
  })
  it('classifies timeouts while reading the response body', async () => {
    const f = fixture()
    f.fetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new DOMException('aborted', 'AbortError'))
          }
        }),
        { headers: { 'Last-Modified-Version': '1', 'Zotero-Server-ID': 'server-1' } }
      )
    )
    await expect(f.collector.run({ kind: 'zotero-preview' })).rejects.toThrow(
      'ZOTERO_REQUEST_TIMED_OUT'
    )
    expect(f.catalog.collectReferences).not.toHaveBeenCalled()
  })
  it('commits the reviewed metadata even if Zotero changes after preview', async () => {
    const f = fixture()
    let title = 'Reviewed title'
    f.fetch.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('/collections?')
              ? [collection]
              : [{ ...record, data: { ...record.data, title } }]
          ),
          {
            headers: {
              'Zotero-Server-ID': 'server-1',
              'Last-Modified-Version': title === 'Reviewed title' ? '1' : '2'
            }
          }
        )
    )
    const preview = await f.collector.run({ kind: 'zotero-preview' })
    title = 'Unreviewed title'
    await f.collector.run({
      kind: 'zotero-commit',
      snapshotId: preview.snapshotId!,
      keys: ['ABCDEFGH'],
      includePdfs: false
    })
    expect(f.catalog.collectReferences).toHaveBeenCalledWith(
      [expect.objectContaining({ item: expect.objectContaining({ title: 'Reviewed title' }) })],
      [['Research']],
      expect.any(Array),
      ['reuse']
    )
    expect(f.fetch).toHaveBeenCalledTimes(2)
  })
  it('rejects legacy synced-version headers rather than claiming a consistent snapshot', async () => {
    const f = fixture()
    f.fetch.mockImplementation(
      async () =>
        new Response(JSON.stringify([collection]), { headers: { 'Last-Modified-Version': '0' } })
    )
    await expect(f.collector.run({ kind: 'zotero-preview' })).rejects.toThrow('Zotero 10 or later')
    expect(f.catalog.collectReferences).not.toHaveBeenCalled()
  })
  it('imports empty collections without requiring a reference', async () => {
    const f = fixture({ items: [] })
    f.catalog.collectReferences.mockResolvedValueOnce({
      itemIds: [],
      metadataRevisions: []
    })
    const preview = await f.collector.run({ kind: 'zotero-preview' })
    expect(preview.collectionCount).toBe(1)
    const result = await f.collector.run({
      kind: 'zotero-commit',
      snapshotId: preview.snapshotId!,
      keys: [],
      includePdfs: false
    })
    expect(result.savedItemIds).toEqual([])
    expect(f.catalog.collectReferences).toHaveBeenCalledWith([], [['Research']], [], [])
  })
  it('keeps standalone Zotero PDF attachments as document references', async () => {
    const f = fixture({
      items: [
        {
          key: 'PDFKEY01',
          data: {
            itemType: 'attachment',
            filename: 'standalone.pdf',
            contentType: 'application/pdf'
          }
        }
      ]
    })
    const preview = await f.collector.run({ kind: 'zotero-preview' })
    expect(preview.entries).toMatchObject([
      { key: 'PDFKEY01', title: 'standalone.pdf', pdfCount: 1 }
    ])
  })
  it('freezes a preview and commits selected metadata, tags, hierarchy and provenance', async () => {
    const { collector, catalog, fetch } = fixture()
    const preview = await collector.run({ kind: 'zotero-preview' })
    expect(preview.entries).toMatchObject([{ key: 'ABCDEFGH', title: 'A reference', pdfCount: 1 }])
    expect(catalog.collectReferences).not.toHaveBeenCalled()
    const result = await collector.run({
      kind: 'zotero-commit',
      snapshotId: preview.snapshotId!,
      keys: ['ABCDEFGH'],
      includePdfs: false
    })
    expect(result.savedItemIds).toEqual(['item-1'])
    expect(catalog.collectReferences).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          tags: ['Research'],
          collectionPaths: [['Research']],
          source: expect.objectContaining({ provider: 'zotero', externalId: 'server-1:ABCDEFGH' }),
          item: expect.objectContaining({
            title: 'A reference',
            identifiers: [expect.objectContaining({ scheme: 'doi', value: '10.1234/example' })]
          })
        })
      ],
      [['Research']],
      expect.any(Array),
      ['reuse']
    )
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('keeps saved references and reports unsafe PDF locations as failures', async () => {
    const { collector, content } = fixture()
    const preview = await collector.run({ kind: 'zotero-preview' })
    const result = await collector.run({
      kind: 'zotero-commit',
      snapshotId: preview.snapshotId!,
      keys: ['ABCDEFGH'],
      includePdfs: true
    })
    expect(result.savedItemIds).toEqual(['item-1'])
    expect(result.failures).toEqual([
      { key: 'PDFKEY01', message: 'Zotero PDF must be a local file.' }
    ])
    expect(content.withPublishedContent).not.toHaveBeenCalled()
  })
  it('keeps the local PDF size limit before publishing through the shared attachment path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zotero-pdf-'))
    try {
      const file = join(root, 'oversized.pdf')
      await writeFile(file, '%PDF-1.4')
      await truncate(file, 200 * 1024 * 1024 + 1)
      const f = fixture({ fileUrl: pathToFileURL(file).href })
      const preview = await f.collector.run({ kind: 'zotero-preview' })
      const result = await f.collector.run({
        kind: 'zotero-commit',
        snapshotId: preview.snapshotId!,
        keys: ['ABCDEFGH'],
        includePdfs: true
      })
      expect(result.savedItemIds).toEqual(['item-1'])
      expect(result.pdfCount).toBe(0)
      expect(result.failures[0].message).toContain('size limit')
      expect(f.content.withPublishedContent).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('copies a real local PDF into managed content before attaching it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zotero-pdf-'))
    try {
      const file = join(root, 'example.pdf')
      await writeFile(file, '%PDF-1.4\n%%EOF')
      const { collector, content, catalog, fetch } = fixture({ fileUrl: pathToFileURL(file).href })
      const preview = await collector.run({ kind: 'zotero-preview' })
      const result = await collector.run({
        kind: 'zotero-commit',
        snapshotId: preview.snapshotId!,
        keys: ['ABCDEFGH'],
        includePdfs: true
      })
      expect(result.pdfCount).toBe(1)
      expect(content.withPublishedContent).toHaveBeenCalledWith(
        { sourcePath: file, contentType: 'application/pdf' },
        expect.any(Function)
      )
      expect(catalog.attachContent).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: 'item-1', checksum: 'checksum', contentBlobId: 'blob-1' })
      )
      expect(fetch).toHaveBeenLastCalledWith(
        'http://127.0.0.1:23119/api/users/0/items/PDFKEY01/file/view/url',
        expect.objectContaining({
          headers: { 'Zotero-API-Version': '3', 'Zotero-Server-ID': 'server-1' }
        })
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('rejects library changes, unknown keys, duplicate selection and expired snapshots', async () => {
    await expect(
      fixture({ versionChanged: true }).collector.run({ kind: 'zotero-preview' })
    ).rejects.toThrow('library changed')
    let now = 0
    const { collector, catalog } = fixture({ now: () => now })
    const preview = await collector.run({ kind: 'zotero-preview' })
    for (const keys of [['UNKNOWN1'], ['ABCDEFGH', 'ABCDEFGH']]) {
      await expect(
        collector.run({
          kind: 'zotero-commit',
          snapshotId: preview.snapshotId!,
          keys,
          includePdfs: false
        })
      ).rejects.toThrow('selection is invalid')
    }
    now = 600_001
    await expect(
      collector.run({
        kind: 'zotero-commit',
        snapshotId: preview.snapshotId!,
        keys: ['ABCDEFGH'],
        includePdfs: false
      })
    ).rejects.toThrow('expired')
    expect(catalog.collectReferences).not.toHaveBeenCalled()
  })
  it('replaces a revised snapshot at capacity without evicting an unrelated preview', async () => {
    const { collector, catalog } = fixture()
    const ids: string[] = []
    for (let index = 0; index < 4; index += 1) {
      ids.push((await collector.run({ kind: 'zotero-preview' })).snapshotId!)
    }
    const revised = await collector.run({
      kind: 'zotero-revise',
      snapshotId: ids[3],
      key: 'ABCDEFGH',
      policy: 'reuse'
    })
    expect(revised.snapshotId).not.toBe(ids[3])
    await expect(
      collector.run({
        kind: 'zotero-commit',
        snapshotId: ids[3],
        keys: ['ABCDEFGH'],
        includePdfs: false
      })
    ).rejects.toThrow('preview expired')
    await expect(
      collector.run({
        kind: 'zotero-commit',
        snapshotId: ids[0],
        keys: ['ABCDEFGH'],
        includePdfs: false
      })
    ).resolves.toMatchObject({ savedItemIds: ['item-1'] })
    expect(catalog.collectReferences).toHaveBeenCalledTimes(1)
  })
  it('rejects cyclic collection hierarchies', async () => {
    const f = fixture()
    f.fetch.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('/collections?')
              ? [{ key: 'COLLECT1', data: { name: 'Cycle', parentCollection: 'COLLECT1' } }]
              : [record]
          ),
          { headers: { 'Last-Modified-Version': '1', 'Zotero-Server-ID': 'server-1' } }
        )
    )
    await expect(f.collector.run({ kind: 'zotero-preview' })).rejects.toThrow(
      'hierarchy is invalid'
    )
  })
  it('reads a complete bounded selection without pagination and maps years', async () => {
    const f = fixture()
    f.fetch.mockImplementation(async (url: string) => {
      const parsed = new URL(url)
      expect(parsed.searchParams.has('limit')).toBe(false)
      expect(parsed.searchParams.has('start')).toBe(false)
      const entries = parsed.pathname.endsWith('/collections')
        ? []
        : Array.from({ length: 101 }, (_, index) => ({
            key: `KEY${String(index).padStart(5, '0')}`,
            data: { title: `Paper ${index}`, itemType: 'journalArticle', date: '2024-01-02' }
          }))
      return new Response(JSON.stringify(entries), {
        headers: { 'Last-Modified-Version': '1', 'Zotero-Server-ID': 'server-1' }
      })
    })
    const preview = await f.collector.run({ kind: 'zotero-preview' })
    expect(preview.entries).toHaveLength(101)
    expect(f.fetch).toHaveBeenCalledTimes(2)
    await f.collector.run({
      kind: 'zotero-commit',
      snapshotId: preview.snapshotId!,
      keys: ['KEY00000'],
      includePdfs: false
    })
    expect(f.catalog.collectReferences).toHaveBeenCalledWith(
      [expect.objectContaining({ item: expect.objectContaining({ issuedYear: 2024 }) })],
      [],
      expect.any(Array),
      ['reuse']
    )
  })
  it.each(['parse', 'verify'])(
    'keeps references and cleans unattached content after PDF %s failure',
    async (failure) => {
      const root = await mkdtemp(join(tmpdir(), 'zotero-pdf-failure-'))
      try {
        const file = join(root, 'failure.pdf')
        await writeFile(file, '%PDF-1.4\n%%EOF')
        const f = fixture({ fileUrl: pathToFileURL(file).href })
        if (failure === 'parse')
          vi.mocked(inspectPdfPageCount).mockRejectedValueOnce(new Error('Invalid PDF'))
        else f.content.verify.mockResolvedValueOnce({ state: 'corrupt' })
        const preview = await f.collector.run({ kind: 'zotero-preview' })
        const result = await f.collector.run({
          kind: 'zotero-commit',
          snapshotId: preview.snapshotId!,
          keys: ['ABCDEFGH'],
          includePdfs: true
        })
        expect(result.savedItemIds).toEqual(['item-1'])
        expect(result.failures).toHaveLength(1)
        expect(f.catalog.attachContent).not.toHaveBeenCalled()
        expect(f.content.sweep).toHaveBeenCalledWith({
          contentIds: ['blob-1'],
          createdBefore: expect.any(Date)
        })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
  it.each(['patent', 'standard'])(
    'preserves the supported Zotero item type %s',
    async (itemType) => {
      const f = fixture({ items: [{ ...record, data: { ...record.data, itemType } }] })
      const preview = await f.collector.run({ kind: 'zotero-preview' })
      await f.collector.run({
        kind: 'zotero-commit',
        snapshotId: preview.snapshotId!,
        keys: ['ABCDEFGH'],
        includePdfs: false
      })
      expect(f.catalog.collectReferences).toHaveBeenCalledWith(
        [expect.objectContaining({ item: expect.objectContaining({ itemType }) })],
        [['Research']],
        expect.any(Array),
        ['reuse']
      )
    }
  )
})
