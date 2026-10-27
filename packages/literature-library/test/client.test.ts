/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test fixtures retain inferred mock types. */
import {
  createLiteratureClient,
  createLiteratureDetailController,
  createLiteratureEntries,
  createLiteratureMetadata,
  createReferenceExporter,
  type LibraryClientApi,
  type LibraryPage
} from '../src/client/index.js'
import { literatureItemInputSchema, type LiteratureItemView } from '../src/contracts.js'
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
