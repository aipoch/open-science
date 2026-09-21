import { expect, it, vi } from 'vitest'
import { PdfSearchTextCache } from './pdf-search-text-cache'

it('reuses a 1000-page scan on subsequent queries and resets for another document', async () => {
  const cache = new PdfSearchTextCache()
  const load = vi.fn(async () => 'Searchable Text')
  for (let scan = 0; scan < 2; scan++)
    for (let page = 1; page <= 1000; page++)
      expect(await cache.get(page, load)).toBe('searchable text')
  expect(load).toHaveBeenCalledTimes(1000)
  cache.clear()
  await cache.get(1, load)
  expect(load).toHaveBeenCalledTimes(1001)
})

it('respects its text budget without evicting the entire preceding scan', async () => {
  const cache = new PdfSearchTextCache(8)
  const first = vi.fn(async () => 'abcd'),
    other = vi.fn(async () => 'efgh')
  for (let scan = 0; scan < 2; scan++) {
    await cache.get(1, first)
    await cache.get(2, other)
  }
  expect(first).toHaveBeenCalledOnce()
  expect(other).toHaveBeenCalledTimes(2)
})
