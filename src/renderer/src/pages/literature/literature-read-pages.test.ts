// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { readLiteratureDisplayPage, readLiteratureJobPages } from './literature-read-pages'
import { downloadLiteratureRecord } from './literature-read-pages'
import type { LiteratureJobView } from '../../../../shared/literature-jobs'

afterEach(() => vi.restoreAllMocks())
const job = (ids: string[], nextRowOffset?: number): LiteratureJobView => ({
  id: '7eb89523-e87c-430b-b3d2-18bef6fda934',
  mode: 'metadata',
  phase: 'search',
  state: 'review',
  createdAt: 1,
  updatedAt: 2,
  rows: ids.map((id) => ({ id, checked: true, status: 'ready' })),
  rowOffset: 0,
  nextRowOffset,
  totalRows: 3
})
it('fills the selected display page across smaller transport pages without skipping a record', async () => {
  const search = vi
    .fn()
    .mockResolvedValueOnce({ entries: [{ id: 'a' }], totalCount: 5, nextOffset: 1 })
    .mockResolvedValueOnce({ entries: [{ id: 'b' }], totalCount: 5, nextOffset: 2 })
    .mockResolvedValueOnce({ entries: [{ id: 'c' }], totalCount: 5, nextOffset: 3 })
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { search } } })
  const request = { scope: 'library' as const, offset: 0, limit: 3 }
  expect(await readLiteratureDisplayPage(request)).toEqual({
    entries: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    totalCount: 5,
    nextOffset: 3
  })
  expect(search).toHaveBeenNthCalledWith(2, { ...request, offset: 1, limit: 2 })
  expect(search).toHaveBeenNthCalledWith(3, { ...request, offset: 2, limit: 1 })
})
it('assembles one review version and retains a deselected row from a later transport page', async () => {
  const last = job(['b', 'c'])
  last.rowOffset = 1
  last.rows[1].checked = false
  const jobs = vi.fn().mockResolvedValue({ jobs: [last] })
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { jobs } } })
  const first = job(['a'], 1)
  const result = await readLiteratureJobPages({ jobs: [first] })
  expect(result.jobs[0].rows.map(({ id, checked }) => [id, checked])).toEqual([
    ['a', true],
    ['b', true],
    ['c', false]
  ])
  expect(jobs).toHaveBeenCalledWith({
    action: 'get',
    jobId: first.id,
    rowOffset: 1,
    expectedUpdatedAt: 2
  })
})
it('rejects changed task pages instead of mixing review versions', async () => {
  const last = { ...job(['b', 'c']), rowOffset: 1, updatedAt: 3 }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { jobs: vi.fn().mockResolvedValue({ jobs: [last] }) } }
  })
  await expect(readLiteratureJobPages({ jobs: [job(['a'], 1)] })).rejects.toThrow('changed')
})
it('does not request a task snapshot for an unchanged poll response', async () => {
  const jobs = vi.fn()
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { jobs } } })
  const result = { jobs: [] }
  expect(await readLiteratureJobPages(result)).toBe(result)
  expect(jobs).not.toHaveBeenCalled()
})
it('joins JSON chunks before encoding Unicode and saves the complete record once', async () => {
  const exportRecord = vi
    .fn()
    .mockResolvedValueOnce({ chunk: '{"title":"\ud83d', digest: 'version', nextOffset: 11 })
    .mockResolvedValueOnce({ chunk: '\ude00"}', digest: 'version' })
  const saveBlobFile = vi.fn().mockResolvedValue({ saved: true })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { exportRecord }, saveBlobFile }
  })
  await downloadLiteratureRecord('reference')
  expect(exportRecord).toHaveBeenLastCalledWith({
    itemId: 'reference',
    offset: 11,
    digest: 'version'
  })
  expect(new TextDecoder().decode(saveBlobFile.mock.calls[0][0].data)).toBe('{"title":"😀"}')
  expect(saveBlobFile).toHaveBeenCalledOnce()
})
it('does not save an incomplete export when the reference changes', async () => {
  const exportRecord = vi
    .fn()
    .mockResolvedValueOnce({ chunk: '{', digest: 'old', nextOffset: 1 })
    .mockResolvedValueOnce({ chunk: '}', digest: 'new' })
  const saveBlobFile = vi.fn()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { exportRecord }, saveBlobFile }
  })
  await expect(downloadLiteratureRecord('reference')).rejects.toThrow('changed')
  expect(saveBlobFile).not.toHaveBeenCalled()
})
