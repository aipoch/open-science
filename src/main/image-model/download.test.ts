import { Readable } from 'node:stream'
import { beforeEach, expect, it, vi } from 'vitest'
import { publicDownloadUrl } from '@aipoch/resilient-download'
import { downloadImageResult } from './download'
import { MAX_IMAGE_BYTES } from './contract'
const get = vi.hoisted(() => vi.fn())
vi.mock('@aipoch/resilient-download', async (original) => ({
  ...(await original<typeof import('@aipoch/resilient-download')>()),
  requestPublicHttps: get
}))
const response = (
  statusCode: number,
  headers: Record<string, string>,
  chunks: Buffer[] = []
): Readable => Object.assign(Readable.from(chunks), { statusCode, headers })
beforeEach(() => {
  get.mockReset()
})
it('revalidates redirect destinations and does not pass credentials to result hosts', async () => {
  get.mockImplementation(async (url) => {
    publicDownloadUrl(url)
    return response(302, { location: 'https://127.0.0.1/private' })
  })
  await expect(
    downloadImageResult('https://cdn.example/image', new AbortController().signal)
  ).rejects.toThrow('public HTTPS')
  expect(get).toHaveBeenCalledTimes(2)
  expect(get.mock.calls[0][2]).toEqual({ accept: 'image/png,image/jpeg,image/webp' })
})
it('bounds declared and streamed bytes, rejects expired URLs, and destroys responses', async () => {
  for (const reply of [
    response(403, {}),
    response(200, { 'content-length': String(MAX_IMAGE_BYTES + 1) }),
    response(200, {}, [Buffer.alloc(33 * 1024 * 1024), Buffer.alloc(32 * 1024 * 1024)])
  ]) {
    get.mockResolvedValue(reply)
    await expect(
      downloadImageResult('https://cdn.example/image', new AbortController().signal)
    ).rejects.toThrow()
    expect(reply.destroyed).toBe(true)
  }
})
it('downloads bounded bytes after a valid redirect and stops redirect loops', async () => {
  get
    .mockResolvedValueOnce(response(302, { location: '/image.png' }))
    .mockResolvedValueOnce(response(200, {}, [Buffer.from('image')]))
  await expect(
    downloadImageResult('https://cdn.example/start', new AbortController().signal)
  ).resolves.toEqual(Buffer.from('image'))
  expect(get.mock.calls[1][0]).toBe('https://cdn.example/image.png')
  get.mockReset().mockImplementation(async () => response(302, { location: '/loop' }))
  await expect(
    downloadImageResult('https://cdn.example/loop', new AbortController().signal)
  ).rejects.toThrow('too many')
  expect(get).toHaveBeenCalledTimes(6)
})
