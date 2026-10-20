import { afterEach, expect, expectTypeOf, it, vi } from 'vitest'
import {
  createFetchBundleAdapter as environmentAdapter,
  type DownloadProgress as EnvironmentProgress
} from '@aipoch/environment'
import { resilientDownload, type DownloadProgress } from '@aipoch/resilient-download'
import { netFetchStandard } from '../network-fetch'
import { createFetchBundleAdapter } from './environment-download'

vi.mock('@aipoch/environment', () => ({
  createFetchBundleAdapter: vi.fn(() => async () => undefined)
}))
vi.mock('@aipoch/resilient-download', () => ({
  resilientDownload: vi.fn(async (_url, path) => path)
}))
vi.mock('../network-fetch', () => ({ netFetchStandard: vi.fn() }))
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it('injects host network, size/hash, progress and cancellation into the environment download port', async () => {
  expectTypeOf<DownloadProgress>().toEqualTypeOf<EnvironmentProgress>()
  createFetchBundleAdapter('runtime-root', 'https://cdn.example')
  const [root, cdn, ports] = vi.mocked(environmentAdapter).mock.calls[0]
  expect([root, cdn]).toEqual(['runtime-root', 'https://cdn.example'])
  const progress = vi.fn()
  const controller = new AbortController()
  await ports.download(
    'https://cdn.example/pack',
    'pack-path',
    progress,
    { sha256: 'digest', size: 42 },
    controller.signal
  )
  expect(resilientDownload).toHaveBeenCalledExactlyOnceWith(
    'https://cdn.example/pack',
    'pack-path',
    {
      expectedSha256: 'digest',
      expectedSize: 42,
      stallTimeoutMs: 60_000,
      signal: controller.signal,
      onProgress: progress,
      fetchImpl: netFetchStandard
    }
  )
})

it('bounds the manifest separately and combines its timeout with caller cancellation', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout')
  vi.mocked(netFetchStandard).mockResolvedValue(new Response('manifest'))
  createFetchBundleAdapter('runtime-root', 'https://cdn.example')
  const ports = vi.mocked(environmentAdapter).mock.calls[0][2]
  const controller = new AbortController()
  await expect(ports.fetchText('https://cdn.example/manifest', controller.signal)).resolves.toBe(
    'manifest'
  )
  expect(timeout).toHaveBeenCalledWith(30_000)
  const signal = vi.mocked(netFetchStandard).mock.calls[0][1]?.signal
  expect(signal?.aborted).toBe(false)
  const reason = new Error('cancel')
  controller.abort(reason)
  expect(signal?.aborted).toBe(true)
  expect(signal?.reason).toBe(reason)
  vi.mocked(netFetchStandard).mockResolvedValue(new Response(null, { status: 503 }))
  await expect(ports.fetchText('https://cdn.example/manifest')).rejects.toThrow('503')
})
