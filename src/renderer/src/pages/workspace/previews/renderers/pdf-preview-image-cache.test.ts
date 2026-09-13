import { afterEach, expect, it, vi } from 'vitest'
import { PdfPreviewImageCache } from './pdf-preview-image-cache'

const request = { attachmentVersionId: 'v1', extractionId: 'e1', page: 1, thumbnailId: 'image' }
const setup = (): {
  cache: PdfPreviewImageCache
  read: ReturnType<typeof vi.fn<() => Promise<string | undefined>>>
} => {
  const read = vi
    .fn<() => Promise<string | undefined>>()
    .mockResolvedValue('data:image/png;base64,a')
  vi.stubGlobal('window', { api: { pdfStructure: { readThumbnail: read } } })
  return { cache: new PdfPreviewImageCache(), read }
}
afterEach(() => vi.unstubAllGlobals())

it('reuses pending reads and loaded URLs for the same extraction identity', async () => {
  const { cache, read } = setup()
  let resolve!: (url: string) => void
  read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const first = cache.load(request),
    second = cache.load({ ...request })
  expect(first).toBe(second)
  expect(read).toHaveBeenCalledOnce()
  resolve('image-url')
  await first
  cache.markReady(request)
  expect(await cache.load(request)).toBe('image-url')
  expect(cache.peek(request)?.ready).toBe(true)
  expect(read).toHaveBeenCalledOnce()
  await cache.load({ ...request, attachmentVersionId: 'v2' })
  await cache.load({ ...request, extractionId: 'e2' })
  expect(read).toHaveBeenCalledTimes(3)
})

it('does not retain failures and explicitly invalidates loaded images', async () => {
  const { cache, read } = setup()
  read.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('unavailable'))
  expect(await cache.load(request)).toBeUndefined()
  expect(cache.peek(request)).toBeUndefined()
  await expect(cache.load(request)).rejects.toThrow('unavailable')
  expect(cache.peek(request)).toBeUndefined()
  await cache.load(request)
  cache.invalidate(request)
  await cache.load(request)
  expect(read).toHaveBeenCalledTimes(4)
})

it('does not restore a cleared or replaced entry when its old read completes', async () => {
  const { cache, read } = setup()
  let resolve!: (url: string) => void
  read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const old = cache.load(request)
  cache.clear()
  await cache.load(request)
  resolve('old-image')
  await old
  expect(cache.peek(request)?.url).toBe('data:image/png;base64,a')
  cache.clear()
  expect(cache.peek(request)).toBeUndefined()
})

it('evicts least recently used entries at the count limit', async () => {
  const { cache } = setup()
  for (let page = 1; page <= 12; page++) await cache.load({ ...request, page })
  await cache.load(request)
  await cache.load({ ...request, page: 13 })
  expect(cache.peek(request)).toBeDefined()
  expect(cache.peek({ ...request, page: 2 })).toBeUndefined()
})

it('does not retain a URL exceeding the memory budget', async () => {
  const { cache, read } = setup()
  read.mockResolvedValueOnce('x'.repeat(33 * 1024 ** 2))
  await cache.load(request)
  expect(cache.peek(request)).toBeUndefined()
})
