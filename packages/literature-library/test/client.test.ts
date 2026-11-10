/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test fixtures retain inferred mock types. */
import {
  createLiteratureClient,
  createLiteratureDetailController,
  createLiteratureEntries,
  createLiteratureMetadata,
  createReferenceExporter,
  type ReferenceExportFile,
  type LibraryClientApi,
  type LibraryPage
} from '../src/client/index.js'
import {
  literatureItemInputSchema,
  type LiteratureItemView,
  type LiteratureMetadataCompletionResult
} from '../src/contracts.js'
import { LITERATURE_OVERSIZED_REFERENCE } from '../src/export.js'
import { referenceCsv } from '../src/client/reference-csv.js'
import { expect, it, vi } from 'vitest'
const item = (id = 'paper', revision = 1): LiteratureItemView => ({
  id,
  item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title: id }),
  metadataRevision: revision,
  createdAt: 1,
  updatedAt: revision,
  attachments: [],
  projectIds: [],
  collectionIds: []
})
function api(): LibraryClientApi {
  return {
    search: vi.fn(async () => ({ entries: [] })),
    get: vi.fn(async () => item()),
    exportRecord: vi.fn(async () => ({ chunk: '', digest: 'a'.repeat(64) })),
    jobs: vi.fn(async () => ({ jobs: [] })),
    formatReferences: vi.fn(async () => ({
      references: [],
      exports: { bibtex: '@article{one,}', ris: 'TY  - JOUR\nER  -' }
    }))
  }
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
it('fills display pages across transport boundaries without skipping records', async () => {
  const transport = api()
  vi.mocked(transport.search)
    .mockResolvedValueOnce({ entries: [item('a')], nextOffset: 1, totalCount: 3 })
    .mockResolvedValueOnce({ entries: [item('b')], nextOffset: 2, totalCount: 3 })
  const result = await createLiteratureClient(transport).readLiteratureDisplayPage({
    scope: 'library',
    limit: 2
  })
  expect(result.entries).toHaveLength(2)
  expect(result.nextOffset).toBe(2)
  expect(transport.search).toHaveBeenLastCalledWith({ scope: 'library', offset: 1, limit: 1 })
})
it('rejects a nonadvancing transport cursor', async () => {
  const transport = api()
  vi.mocked(transport.search).mockResolvedValue({ entries: [], nextOffset: 0 })
  await expect(
    createLiteratureClient(transport).readLiteratureDisplayPage({ scope: 'library' })
  ).rejects.toThrow('did not advance')
})
it('reconciles only candidate identities and does not authorize Undo disposal on cancelled reads', async () => {
  const transport = api()
  vi.mocked(transport.search)
    .mockResolvedValueOnce({ entries: [item('wanted')], nextOffset: 1 })
    .mockResolvedValueOnce({ entries: [{ id: 'wanted', candidate: {}, state: 'dismissed' }] })
  const client = createLiteratureClient(transport)
  expect(await client.readMatchingCandidateIds(new Set(['wanted']), 'dismissed')).toEqual(
    new Set(['wanted'])
  )
  await expect(
    client.readMatchingCandidateIds(new Set(['wanted']), 'dismissed', () => false)
  ).rejects.toThrow('cancelled')
})
it('assembles Unicode export chunks and rejects mixed record versions', async () => {
  const transport = api(),
    client = createLiteratureClient(transport)
  vi.mocked(transport.exportRecord)
    .mockResolvedValueOnce({ chunk: '\uD83D', digest: 'a', nextOffset: 1 })
    .mockResolvedValueOnce({ chunk: '\uDE00', digest: 'a' })
  expect(await client.readLiteratureRecord('paper')).toBe('😀')
  vi.mocked(transport.exportRecord)
    .mockResolvedValueOnce({ chunk: 'a', digest: 'a', nextOffset: 1 })
    .mockResolvedValueOnce({ chunk: 'b', digest: 'b' })
  await expect(client.readLiteratureRecord('paper')).rejects.toThrow('changed during export')
})
it.each([{ mergedIntoItemId: 'survivor' }, { deletedAt: 0 }])(
  'rejects a retained record in oversized active selection recovery: %j',
  async (retained) => {
    const transport = api()
    vi.mocked(transport.search)
      .mockRejectedValueOnce(new Error(LITERATURE_OVERSIZED_REFERENCE + 'paper'))
      .mockResolvedValueOnce({ entries: [], totalCount: 1 })
    vi.mocked(transport.exportRecord).mockResolvedValue({
      chunk: JSON.stringify({ ...item(), ...retained }),
      digest: 'a'.repeat(64)
    })
    await expect(
      createLiteratureClient(transport).readLiteratureSelectionPage({
        scope: 'library',
        lifecycle: 'active',
        itemIds: ['paper']
      })
    ).rejects.toThrow('Reference changed')
  }
)
it('recovers a retained oversized record for a Trash selection', async () => {
  const transport = api()
  const retained = { ...item(), deletedAt: 0, mergedIntoItemId: 'survivor' }
  vi.mocked(transport.search)
    .mockRejectedValueOnce(new Error(LITERATURE_OVERSIZED_REFERENCE + 'paper'))
    .mockResolvedValueOnce({ entries: [], totalCount: 1 })
  vi.mocked(transport.exportRecord).mockResolvedValue({
    chunk: JSON.stringify(retained),
    digest: 'a'.repeat(64)
  })
  const page = await createLiteratureClient(transport).readLiteratureSelectionPage({
    scope: 'library',
    lifecycle: 'deleted',
    itemIds: ['paper']
  })
  expect(page.entries).toEqual([retained])
})
it('does not return an older relationship snapshot after a newer detail read', async () => {
  const old = deferred<LiteratureItemView>(),
    newer = { ...item(), collectionIds: ['collection'] },
    get = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(newer)
  const owner = createLiteratureDetailController(get),
    pending = owner.read('paper')
  expect(await owner.read('paper')).toEqual(newer)
  old.resolve(item())
  expect(await pending).toEqual(newer)
})
it('rejects obsolete query results and reuses pages without extra transport work', async () => {
  const transport = api(),
    old = deferred<LibraryPage>()
  vi.mocked(transport.search)
    .mockReturnValueOnce(old.promise)
    .mockResolvedValue({ entries: [item('new')] })
  const owner = createLiteratureEntries(createLiteratureClient(transport), transport.get),
    onPage = vi.fn(),
    onError = vi.fn()
  const bind = (scopeKey: string) =>
    owner.bind({ scopeKey, request: { scope: 'library' }, onPage, onError, onEmptyPage: vi.fn() })
  const first = bind('old').reload()
  owner.invalidate()
  await bind('new').reload()
  old.resolve({ entries: [item('old')] })
  await first
  expect(onPage).toHaveBeenCalledTimes(1)
  expect(onPage.mock.calls[0][0].entries[0].id).toBe('new')
  await bind('new').reload()
  expect(transport.search).toHaveBeenCalledTimes(2)
})
it('retains equal page identity and invalidates equal-revision relationship updates', async () => {
  const transport = api(),
    first = item()
  vi.mocked(transport.search).mockResolvedValue({ entries: [first] })
  const owner = createLiteratureEntries(createLiteratureClient(transport), transport.get),
    onPage = vi.fn(),
    bound = owner.bind({
      scopeKey: 'library',
      request: { scope: 'library' },
      onPage,
      onError: vi.fn(),
      onEmptyPage: vi.fn()
    })
  await bound.reload()
  await bound.reload(true)
  expect(onPage.mock.calls[1][0].entries[0]).toBe(onPage.mock.calls[0][0].entries[0])
  await bound.refreshItems(['paper'], [{ ...first, collectionIds: ['new'] }])
  expect(onPage.mock.calls.at(-1)![0].entries[0].collectionIds).toEqual(['new'])
})
it('resets the publication-check view when closing, reopening or switching references', () => {
  const controller = createLiteratureDetailController(vi.fn())
  controller.open(item())
  const transact = vi.fn()
  const owner = createLiteratureMetadata(controller, {
    transact,
    completeMetadata: vi.fn(),
    onItemChange: vi.fn(),
    messages: () => ({ reload: 'reload', update: 'update', complete: 'complete' })
  })
  const stop = owner.start()
  owner.changeMode('publication-check')
  expect(owner.getSnapshot().mode).toBe('publication-check')
  controller.replace(item('paper', 2))
  expect(owner.getSnapshot().mode).toBe('publication-check')
  controller.open(item('other'))
  expect(owner.getSnapshot().mode).toBe('view')
  owner.changeMode('publication-check')
  controller.close()
  expect(owner.getSnapshot().mode).toBe('view')
  controller.open(item('other'))
  expect(owner.getSnapshot().mode).toBe('view')
  expect(transact).not.toHaveBeenCalled()
  stop()
})
it('recovers a committed metadata save by rereading without resubmitting the write', async () => {
  const get = vi
      .fn()
      .mockRejectedValueOnce(new Error('transport'))
      .mockResolvedValue(item('paper', 2)),
    controller = createLiteratureDetailController(get)
  controller.open(item())
  const transact = vi.fn(async () => ({ kind: 'item' as const, id: 'paper' })),
    owner = createLiteratureMetadata(controller, {
      transact,
      completeMetadata: vi.fn(),
      onItemChange: vi.fn(),
      messages: () => ({
        reload: 'reload failed',
        update: 'update failed',
        complete: 'complete failed'
      })
    }),
    stop = owner.start()
  owner.changeMode('edit')
  await owner.save(item().item)
  expect(owner.getSnapshot()).toMatchObject({ awaitingReload: true, error: 'reload failed' })
  await owner.save(item().item)
  expect(transact).toHaveBeenCalledTimes(1)
  await owner.reloadSaved()
  expect(owner.getSnapshot()).toMatchObject({ mode: 'view', awaitingReload: false })
  expect(transact).toHaveBeenCalledTimes(1)
  stop()
})
it('discards completion previews when a different detail opens', async () => {
  const pending = deferred<never>(),
    controller = createLiteratureDetailController(vi.fn())
  controller.open(item())
  const owner = createLiteratureMetadata(controller, {
      transact: vi.fn(),
      completeMetadata: vi.fn(() => pending.promise),
      onItemChange: vi.fn(),
      messages: () => ({ reload: 'reload', update: 'update', complete: 'complete' })
    }),
    stop = owner.start()
  const result = owner.complete('preview', { scheme: 'doi', value: '10.1234/paper' })
  controller.open(item('other'))
  pending.resolve({ mode: 'preview', reviewToken: 'old' } as never)
  await result
  expect(owner.getSnapshot().completion).toBeUndefined()
  stop()
})
it('rereads a delayed metadata commit without reverting a newer reading status', async () => {
  const saved = { ...item('paper', 2), readingStatus: 'unread' as const }
  const latest = { ...saved, readingStatus: 'read' as const }
  const pending = deferred<LiteratureMetadataCompletionResult>()
  const get = vi.fn(async () => latest)
  const controller = createLiteratureDetailController(get)
  controller.open(item())
  const onItemChange = vi.fn()
  const owner = createLiteratureMetadata(controller, {
    transact: vi.fn(),
    completeMetadata: vi.fn(() => pending.promise),
    onItemChange,
    messages: () => ({ reload: 'reload', update: 'update', complete: 'complete' })
  })
  const stop = owner.start()
  owner.changeMode('complete')
  const writing = owner.complete('commit', { scheme: 'doi', value: '10.1234/paper' })
  owner.changeMode('view')
  controller.replace(latest)
  pending.resolve({
    mode: 'commit',
    provider: 'crossref',
    sourceUrl: 'https://example.test/paper',
    item: saved,
    filled: [],
    conflicts: []
  })
  await writing
  expect(controller.getSnapshot().item).toEqual(latest)
  expect(onItemChange).toHaveBeenCalledExactlyOnceWith(latest)
  expect(get).toHaveBeenCalledExactlyOnceWith('paper')
  expect(owner.getSnapshot().mode).toBe('view')
  stop()
})
it('does not republish a completion after leaving during its authoritative reload', async () => {
  const latest = { ...item('paper', 2), readingStatus: 'read' as const }
  const pendingRead = deferred<LiteratureItemView>()
  const get = vi.fn(() => pendingRead.promise)
  const controller = createLiteratureDetailController(get)
  controller.open(item())
  const owner = createLiteratureMetadata(controller, {
    transact: vi.fn(),
    completeMetadata: vi.fn(async () => ({
      mode: 'commit' as const,
      provider: 'crossref' as const,
      sourceUrl: 'https://example.test/paper',
      item: latest,
      filled: [],
      conflicts: []
    })),
    onItemChange: vi.fn(),
    messages: () => ({ reload: 'reload', update: 'update', complete: 'complete' })
  })
  const stop = owner.start()
  owner.changeMode('complete')
  const writing = owner.complete('commit', { scheme: 'doi', value: '10.1234/paper' })
  await vi.waitFor(() => expect(get).toHaveBeenCalledOnce())
  owner.changeMode('view')
  owner.changeMode('complete')
  pendingRead.resolve(latest)
  await writing
  expect(owner.getSnapshot()).toMatchObject({ mode: 'complete', completing: false })
  expect(owner.getSnapshot().completion).toBeUndefined()
  expect(controller.getSnapshot().item).toEqual(latest)
  stop()
})
it('reports a committed metadata reload failure without publishing its stale snapshot', async () => {
  const saved = { ...item('paper', 2), readingStatus: 'unread' as const }
  const controller = createLiteratureDetailController(
    vi.fn(async () => {
      throw new Error('read failed')
    })
  )
  controller.open(item())
  const onItemChange = vi.fn()
  const owner = createLiteratureMetadata(controller, {
    transact: vi.fn(),
    completeMetadata: vi.fn(async () => ({
      mode: 'commit' as const,
      provider: 'crossref' as const,
      sourceUrl: 'https://example.test/paper',
      item: saved,
      filled: [],
      conflicts: []
    })),
    onItemChange,
    messages: () => ({ reload: 'reload', update: 'update', complete: 'complete' })
  })
  const stop = owner.start()
  owner.changeMode('complete')
  await owner.complete('commit', { scheme: 'doi', value: '10.1234/paper' })
  expect(onItemChange).not.toHaveBeenCalled()
  expect(controller.getSnapshot().item).toEqual(item())
  expect(owner.getSnapshot()).toMatchObject({
    completing: false,
    completionError: { itemId: 'paper', message: 'reload' }
  })
  stop()
})
it('holds export admission until save settles and never saves partial batches', async () => {
  const pending = deferred<{ saved: boolean }>(),
    format = vi.fn(async () => ({
      references: [],
      exports: { bibtex: '@article{one,}', ris: 'TY  - JOUR\nER  -' }
    })),
    save = vi.fn(() => pending.promise),
    exporter = createReferenceExporter({ format, save }),
    request = {
      itemIds: ['one'],
      format: 'bibtex' as const,
      filenameStem: 'refs',
      styleId: 'apa',
      locale: 'en-US' as const
    }
  const first = exporter(request)
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(await exporter(request)).toBe(false)
  pending.resolve({ saved: true })
  expect(await first).toBe(true)
  save.mockClear()
  await expect(
    exporter({ ...request, itemIds: Array.from({ length: 201 }, (_, i) => String(i)) })
  ).rejects.toThrow('duplicate citation keys')
  expect(save).not.toHaveBeenCalled()
})

it.each([
  [undefined, '2024-05-16', '2024'],
  [2023, '2024-05-16', '2023'],
  [undefined, 'in press', '']
] as const)(
  'exports year %s with publication date %s as %s',
  (issuedYear, issuedText, expected) => {
    const record = item()
    Object.assign(record.item, { issuedYear, issuedText })
    expect(referenceCsv([record], false).split(',')[3]).toBe(`"${expected}"`)
  }
)

it('exports bibliographic CSV as UTF-8 spreadsheet data without loading a citation style', async () => {
  const record = item('record-1')
  record.item = literatureItemInputSchema.parse({
    itemType: 'journalArticle',
    title: '中文, "quoted" title',
    abstract: 'First line\nSecond line',
    issuedYear: 2024,
    containerTitle: 'Journal',
    language: 'zh',
    url: 'https://example.org/paper',
    creators: [
      { nameMode: 'person', givenName: 'Ada', familyName: 'Lovelace', creatorType: 'Author' },
      { nameMode: 'organization', literalName: 'Research Group', creatorType: 'AUTHOR' },
      { nameMode: 'person', familyName: 'Editor', creatorType: 'editor' }
    ],
    identifiers: [
      { scheme: 'doi', value: '10.1234/example' },
      { scheme: 'pmid', value: '123456' },
      { scheme: 'pmcid', value: 'PMC123456' },
      { scheme: 'arxiv', value: '1706.03762' }
    ],
    typeFields: { volume: '2', issue: '3', pages: '10–20' }
  })
  const readItems = vi.fn(async () => [record]),
    format = vi.fn().mockRejectedValue(new Error('CSL unavailable')),
    save = vi
      .fn<(file: ReferenceExportFile) => Promise<{ saved: boolean }>>()
      .mockResolvedValue({ saved: true })
  const exporter = createReferenceExporter({ readItems, format, save })
  expect(
    await exporter({
      itemIds: ['record-1'],
      format: 'csv',
      filenameStem: 'A/B',
      styleId: 'unavailable',
      locale: 'en-US'
    })
  ).toBe(true)
  const file = save.mock.calls[0]![0]
  expect(file.suggestedName).toBe('A-B.csv')
  expect(file.mimeType).toBe('text/csv;charset=utf-8')
  expect([...new Uint8Array(file.data).slice(0, 3)]).toEqual([239, 187, 191])
  const csv = new TextDecoder().decode(file.data)
  expect(csv).toBe(
    '"item_id","title","authors","year","item_type","publication","volume","issue","pages","doi","pmid","pmcid","arxiv_id","url","abstract","language"\r\n' +
      '"record-1","中文, ""quoted"" title","Ada Lovelace; Research Group","2024","journalArticle","Journal","2","3","10–20","10.1234/example","123456","PMC123456","1706.03762","https://example.org/paper","First line\r\nSecond line","zh"\r\n'
  )
  expect(format).not.toHaveBeenCalled()
})

it.each([
  '=HYPERLINK("bad")',
  ' +SUM(1,2)',
  '\t@SUM(1)',
  '-2+3',
  '\rplain',
  '＝1+2',
  '＋1+2',
  '＠SUM(1)',
  '－1+2'
])(
  'neutralizes spreadsheet formulas/control prefixes in any bibliographic field: %j',
  async (value) => {
    const record = item('safe')
    record.item.extra = value // Not an exported field.
    record.item.abstract = value
    const save = vi
      .fn<(file: ReferenceExportFile) => Promise<{ saved: boolean }>>()
      .mockResolvedValue({ saved: true })
    await createReferenceExporter({
      readItems: async () => [record],
      format: api().formatReferences,
      save
    })({
      itemIds: ['safe'],
      format: 'csv',
      filenameStem: 'refs',
      styleId: 'apa',
      locale: 'en-US'
    })
    const csv = new TextDecoder().decode(save.mock.calls[0]![0].data)
    const protectedValue = `'${value}`.replace(/\r\n|\r|\n/g, '\r\n').replaceAll('"', '""')
    expect(csv).toContain(`"${protectedValue}"`)
  }
)

it('exports all CSV batches in selection order with one header and blank missing fields', async () => {
  const ids = Array.from({ length: 205 }, (_, i) => `paper-${i}`)
  const readItems = vi.fn(async (batch: readonly string[]) =>
    [...batch].reverse().map((id) => item(id))
  )
  const save = vi
    .fn<(file: ReferenceExportFile) => Promise<{ saved: boolean }>>()
    .mockResolvedValue({ saved: true })
  await createReferenceExporter({ readItems, format: api().formatReferences, save })({
    itemIds: ids,
    format: 'csv',
    filenameStem: 'refs',
    styleId: 'apa',
    locale: 'en-US'
  })
  expect(readItems.mock.calls.map(([batch]) => batch.length)).toEqual([100, 100, 5])
  const lines = new TextDecoder().decode(save.mock.calls[0]![0].data).trimEnd().split('\r\n')
  expect(lines).toHaveLength(206)
  expect(lines.slice(1).map((line) => line.split(',')[0])).toEqual(ids.map((id) => `"${id}"`))
  expect(lines[1]).toBe(
    '"paper-0","paper-0","","","journalArticle","","","","","","","","","","",""'
  )
})

it.each([
  ['missing', ['first']],
  ['duplicate', ['first', 'first']],
  ['unexpected', ['first', 'other']]
] as const)('does not save a CSV with %s metadata records', async (_name, ids) => {
  const save = vi.fn(async () => ({ saved: true }))
  const exporter = createReferenceExporter({
    readItems: async () => ids.map((id) => item(id)),
    format: api().formatReferences,
    save
  })
  await expect(
    exporter({
      itemIds: ['first', 'second'],
      format: 'csv',
      filenameStem: 'refs',
      styleId: 'apa',
      locale: 'en-US'
    })
  ).rejects.toThrow('complete selection')
  expect(save).not.toHaveBeenCalled()
})

it('never saves partial CSV batches, releases failed admission and owns saving through cancellation', async () => {
  const ids = Array.from({ length: 101 }, (_, i) => `paper-${i}`)
  const readItems = vi.fn(async (batch: readonly string[]) => batch.map((id) => item(id)))
  readItems.mockRejectedValueOnce(new Error('Read failed'))
  const saved = deferred<{ saved: boolean }>()
  const save = vi.fn(() => saved.promise)
  const exporter = createReferenceExporter({ readItems, format: api().formatReferences, save })
  const request = {
    itemIds: ids,
    format: 'csv' as const,
    filenameStem: 'refs',
    styleId: 'apa',
    locale: 'en-US' as const
  }
  await expect(exporter(request)).rejects.toThrow('Read failed')
  expect(save).not.toHaveBeenCalled()
  readItems
    .mockImplementationOnce(async (batch) => batch.map((id) => item(id)))
    .mockRejectedValueOnce(new Error('Second batch failed'))
  await expect(exporter(request)).rejects.toThrow('Second batch failed')
  expect(save).not.toHaveBeenCalled()
  const operation = exporter(request)
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(await exporter({ ...request, format: 'ris' })).toBe(false)
  saved.resolve({ saved: false })
  expect(await operation).toBe(false)
  expect(await exporter({ ...request, itemIds: [] })).toBe(false)
})

it('rejects duplicate requested CSV ids before reading or saving', async () => {
  const readItems = vi.fn(async (ids: readonly string[]) => ids.map((id) => item(id)))
  const save = vi.fn(async () => ({ saved: true }))
  const exporter = createReferenceExporter({ readItems, format: api().formatReferences, save })
  await expect(
    exporter({
      itemIds: ['first', 'first'],
      format: 'csv',
      filenameStem: 'refs',
      styleId: 'apa',
      locale: 'en-US'
    })
  ).rejects.toThrow()
  expect(readItems).not.toHaveBeenCalled()
  expect(save).not.toHaveBeenCalled()
})
