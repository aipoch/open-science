import { expect, it, vi } from 'vitest'
import { PdfSearchTextCache } from './pdf-search-text-cache'

it('qualifies only settled, fully retained small documents for fast type-ahead', async () => {
  const cache = new PdfSearchTextCache(8)
  const pending = Promise.withResolvers<string>()
  const read = cache.get(1, () => pending.promise)
  await cache.get(2, async () => '')
  expect(cache.canScanQuickly(2)).toBe(false)
  pending.resolve('abcd')
  await read
  expect(cache.canScanQuickly(2)).toBe(true)
  await cache.get(3, async () => 'e')
  expect(cache.canScanQuickly(3)).toBe(false)
  cache.clear()
  expect(cache.canScanQuickly(2)).toBe(false)
  await expect(
    cache.get(1, async () => {
      throw new Error('unreadable')
    })
  ).rejects.toThrow()
  expect(cache.canScanQuickly(1)).toBe(false)
})

it('does not shorten the delay for large scans even if all text is cached', async () => {
  const cache = new PdfSearchTextCache()
  await cache.get(1, async () => 'x'.repeat(131073))
  expect(cache.canScanQuickly(1)).toBe(false)
  cache.clear()
  for (let page = 1; page <= 129; page++) await cache.get(page, async () => '')
  expect(cache.canScanQuickly(129)).toBe(false)
})

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
