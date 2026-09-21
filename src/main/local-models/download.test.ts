import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DownloadChecksumError,
  DownloadSourceError,
  resilientDownload
} from '../net/resilient-download'
import { PDF_TABLE_MODEL_REVISIONS } from './catalog'
import { downloadLocalModelAsset } from './download'
import { localModelDownloadSources } from './download-sources'

vi.mock('electron', () => ({ net: {} }))

const body = Buffer.from('verified model bytes')
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const asset = {
  file: 'detection.onnx',
  url: 'https://primary.invalid/model',
  size: body.length,
  sha256: sha(body)
}
const urls = [asset.url, 'https://mirror.invalid/model', 'https://other.invalid/model']
const sources = (): string[] => urls
const roots: string[] = []
const target = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'model-mirror-'))
  roots.push(root)
  return join(root, asset.file)
}
const response = (bytes: Buffer = body): Response =>
  new Response(new Uint8Array(bytes), {
    headers: { 'Content-Length': String(bytes.length), ETag: '"model-v1"' }
  })
const downloadNow: typeof resilientDownload = (url, path, opts) =>
  resilientDownload(url, path, {
    ...opts,
    deps: { ...opts?.deps, sleep: async () => undefined }
  })
const isProbe = (init?: RequestInit): boolean =>
  new Headers(init?.headers).get('Range') === `bytes=0-${body.length - 1}`

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('verified source registry', () => {
  it('covers the complete existing pack without changing its extraction recipe', () => {
    const revision = PDF_TABLE_MODEL_REVISIONS[0]
    const before = JSON.stringify(revision)
    const weights = revision.assets.filter((entry) => entry.file.endsWith('.onnx'))
    for (const entry of revision.assets) {
      const candidates = localModelDownloadSources(entry)
      expect(candidates[0]).toBe(entry.url)
      expect(new Set(candidates).size).toBe(entry.file.endsWith('.onnx') ? 3 : 2)
      expect(candidates.every((url) => new URL(url).protocol === 'https:')).toBe(true)
    }
    expect(localModelDownloadSources(weights[0])[1]).toContain(
      '/resolve/e1f6f6333de70d7567f171aff3ace320f4b95f50/onnx/model.onnx'
    )
    expect(localModelDownloadSources(weights[1])[1]).toContain(
      '/resolve/07b9faf118b854e99a9ec290376f39b118435ff4/onnx/model.onnx'
    )
    expect(JSON.stringify(revision)).toBe(before)
    // Pinned pre-mirror serialized recipe: transport changes must not invalidate PDF caches.
    expect(sha(Buffer.from(before))).toBe(
      'b767d8ea45ff232e9868a27a0fc7f6879e2cfd52c7418e59eab4cb1c4d1f9913'
    )
    expect(localModelDownloadSources(asset)).toEqual([asset.url])
  })
})

describe('bounded candidate probes', () => {
  it('starts probes concurrently, follows redirects and ranks the first actual data', async () => {
    const pending = new Map<string, (response: Response) => void>()
    const fetchImpl = vi.fn<typeof fetch>(
      (url) => new Promise((resolve) => pending.set(String(url), resolve))
    )
    const download = vi.fn<typeof resilientDownload>(async (_url, path) => path)
    let now = 0
    const result = downloadLocalModelAsset(
      asset,
      'unused',
      {},
      {
        sources,
        fetchImpl,
        download,
        now: () => now
      }
    )
    expect([...pending.keys()]).toEqual(urls)
    now = 10
    pending.get(urls[1])!(response())
    await vi.waitFor(() => expect(fetchImpl.mock.calls[1][1]?.signal?.aborted).toBe(true))
    now = 20
    pending.get(urls[0])!(response())
    pending.get(urls[2])!(response())
    await result
    expect(download.mock.calls[0][0]).toBe(urls[1])
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.redirect).not.toBe('manual')
      expect(new Headers(init?.headers).get('Range')).toBe(`bytes=0-${body.length - 1}`)
      expect(init?.signal?.aborted).toBe(true)
    }
  })

  it.each([200, 206])(
    'reads only a bounded sample for HTTP %s and cancels the stream',
    async (status) => {
      let reads = 0
      const cancel = vi.fn()
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            reads++
            controller.enqueue(new Uint8Array(1024))
          },
          cancel
        },
        { highWaterMark: 0 }
      )
      const fetchImpl = vi.fn<typeof fetch>(
        async () =>
          new Response(stream, {
            status,
            headers:
              status === 206
                ? { 'Content-Range': 'bytes 0-1023/1000000', 'Content-Length': '1024' }
                : { 'Content-Length': '1000000' }
          })
      )
      const download = vi.fn<typeof resilientDownload>(async (_url, path) => path)
      await downloadLocalModelAsset(
        { ...asset, size: 1000000 },
        'unused',
        {},
        { fetchImpl, download }
      )
      expect(reads).toBe(1)
      expect(cancel).toHaveBeenCalledOnce()
      expect(download).toHaveBeenCalledOnce()
    }
  )

  it.each<{ status: number; headers: Record<string, string> }>([
    { status: 403, headers: {} },
    { status: 206, headers: { 'Content-Range': 'bytes 1-20/20' } },
    { status: 206, headers: { 'Content-Range': 'bytes 0-19/21' } },
    { status: 206, headers: { 'Content-Range': 'bytes 0-19/20', 'Content-Length': '21' } },
    { status: 200, headers: { 'Content-Length': '999' } },
    { status: 200, headers: { 'Content-Length': 'invalid' } }
  ])('ranks invalid probe metadata behind a reachable source: %j', async ({ status, headers }) => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url) === urls[0] ? new Response(body, { status, headers }) : response()
    )
    const download = vi.fn<typeof resilientDownload>(async (_url, path) => path)
    await downloadLocalModelAsset(
      asset,
      'unused',
      {},
      { fetchImpl, download, sources, now: () => 0 }
    )
    expect(download.mock.calls[0][0]).toBe(urls[1])
  })

  it('does not treat empty or truncated bodies as successful probes', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url) === urls[0] ? new Response(body.subarray(0, 1)) : response()
    )
    const download = vi.fn<typeof resilientDownload>(async (_url, path) => path)
    await downloadLocalModelAsset(
      asset,
      'unused',
      {},
      { fetchImpl, download, sources, now: () => 0 }
    )
    expect(download.mock.calls[0][0]).toBe(urls[1])
  })

  it('times out a stalled response body and still attempts sources if every probe fails', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const signal = init!.signal!
      signals.push(signal)
      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
          }
        })
      )
    })
    const download = vi.fn<typeof resilientDownload>(async (_url, path) => path)
    const pending = downloadLocalModelAsset(asset, 'unused', {}, { fetchImpl, download, sources })
    await vi.advanceTimersByTimeAsync(4000)
    await pending
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(download.mock.calls[0][0]).toBe(urls[0])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels all pending probes without starting a download', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true
          })
        )
    )
    const download = vi.fn<typeof resilientDownload>()
    const pending = downloadLocalModelAsset(
      asset,
      'unused',
      { signal: controller.signal },
      {
        fetchImpl,
        download,
        sources
      }
    )
    controller.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrow('cancelled')
    expect(fetchImpl.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true)
    expect(download).not.toHaveBeenCalled()
  })

  it('does not probe an already cancelled operation', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(
      downloadLocalModelAsset(
        asset,
        'unused',
        { signal: AbortSignal.abort() },
        {
          fetchImpl,
          sources
        }
      )
    ).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('download source failover', () => {
  it.each(['network', 'http', 'integrity', 'range'])(
    'installs verified bytes from the next source after a %s failure',
    async (failure) => {
      const path = await target()
      const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
        if (isProbe(init)) return response()
        if (String(url) !== urls[0]) return response()
        if (failure === 'network') throw new TypeError('fetch failed')
        if (failure === 'http') return new Response(null, { status: 403 })
        if (failure === 'range') return new Response(body, { status: 206 })
        return response(Buffer.alloc(body.length))
      })
      const download = vi.fn(downloadNow)
      await downloadLocalModelAsset(
        asset,
        path,
        {},
        {
          fetchImpl,
          download,
          sources,
          now: () => 0
        }
      )
      expect(await readFile(path)).toEqual(body)
      expect(download.mock.calls.map(([url]) => url)).toEqual(urls.slice(0, 2))
      expect(download.mock.calls[0][2]).toMatchObject({
        maxRetries: 1,
        stallTimeoutMs: 30000,
        expectedSize: asset.size,
        expectedSha256: asset.sha256
      })
      expect(
        fetchImpl.mock.calls.filter(([url, init]) => String(url) === urls[0] && !isProbe(init))
      ).toHaveLength(failure === 'network' ? 2 : 1)
    }
  )

  it('restarts a partial from another source instead of sending its validator or Range', async () => {
    const path = await target()
    await writeFile(path + '.part', body.subarray(0, 5))
    await writeFile(
      path + '.part.meta',
      JSON.stringify({
        version: 1,
        urlSha256: sha(Buffer.from(urls[0])),
        expectedSize: asset.size,
        validator: { kind: 'etag', value: '"primary-version"' }
      })
    )
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (isProbe(init) && String(url) === urls[0]) throw new Error('primary unreachable')
      return response()
    })
    await downloadLocalModelAsset(
      asset,
      path,
      {},
      {
        fetchImpl,
        download: downloadNow,
        sources,
        now: () => 0
      }
    )
    const [url, init] = fetchImpl.mock.calls.find(([, init]) => !isProbe(init))!
    expect(url).toBe(urls[1])
    expect(new Headers(init?.headers).has('Range')).toBe(false)
    expect(new Headers(init?.headers).has('If-Range')).toBe(false)
    expect(await readFile(path)).toEqual(body)
  })

  it('resumes an interrupted source once, then discards its bytes when switching', async () => {
    const path = await target()
    let attempts = 0
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (isProbe(init)) return response()
      const headers = new Headers(init?.headers)
      if (String(url) === urls[0]) {
        attempts++
        if (attempts === 1) {
          // A clean but short stream exercises the real persisted partial and retry lifecycle.
          return new Response(body.subarray(0, 5), {
            headers: { 'Content-Length': String(body.length), ETag: '"primary-version"' }
          })
        }
        expect(headers.get('Range')).toBe('bytes=5-')
        expect(headers.get('If-Range')).toBe('"primary-version"')
        throw new TypeError('connection lost')
      }
      expect(headers.has('Range')).toBe(false)
      expect(headers.has('If-Range')).toBe(false)
      return response()
    })
    await downloadLocalModelAsset(
      asset,
      path,
      {},
      { fetchImpl, download: downloadNow, sources, now: () => 0 }
    )
    expect(attempts).toBe(2)
    expect(await readFile(path)).toEqual(body)
  })

  it('keeps same-source guarded resume for a matching partial', async () => {
    const path = await target()
    await writeFile(path + '.part', body.subarray(0, 5))
    await writeFile(
      path + '.part.meta',
      JSON.stringify({
        version: 1,
        urlSha256: sha(Buffer.from(urls[0])),
        expectedSize: asset.size,
        validator: { kind: 'etag', value: '"model-v1"' }
      })
    )
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      if (isProbe(init)) return response()
      expect(new Headers(init?.headers).get('Range')).toBe('bytes=5-')
      expect(new Headers(init?.headers).get('If-Range')).toBe('"model-v1"')
      return new Response(body.subarray(5), {
        status: 206,
        headers: {
          'Content-Range': `bytes 5-${body.length - 1}/${body.length}`,
          ETag: '"model-v1"'
        }
      })
    })
    await downloadLocalModelAsset(
      asset,
      path,
      {},
      {
        fetchImpl,
        download: downloadNow,
        sources,
        now: () => 0
      }
    )
    expect(await readFile(path)).toEqual(body)
  })

  it('reports actual progress resetting the incomplete file before switching sources', async () => {
    const progress = vi.fn()
    const download = vi.fn<typeof resilientDownload>(async (url, path, options) => {
      if (url === urls[0]) {
        options?.onProgress?.({
          phase: 'reconnecting',
          transferred: 5,
          bytesPerSecond: 0,
          attempt: 1
        })
        throw new DownloadSourceError('unreachable')
      }
      return path
    })
    await downloadLocalModelAsset(
      asset,
      'unused',
      { onProgress: progress },
      {
        fetchImpl: async () => response(),
        download,
        sources,
        now: () => 0
      }
    )
    expect(progress.mock.calls.map(([value]) => [value.phase, value.transferred])).toEqual([
      ['reconnecting', 5],
      ['downloading', 0]
    ])
  })

  it.each(['ENOSPC', 'EACCES', 'EIO'])('does not switch source after %s on disk', async (code) => {
    const path = await target()
    const failure = Object.assign(new Error(code), { code })
    const download = vi.fn<typeof resilientDownload>((url, target, opts) =>
      resilientDownload(url, target, {
        ...opts,
        deps: {
          ...opts?.deps,
          createWriteStreamImpl: () => {
            throw failure
          },
          sleep: async () => undefined
        }
      })
    )
    await expect(
      downloadLocalModelAsset(
        asset,
        path,
        {},
        {
          fetchImpl: async () => response(),
          download,
          sources,
          now: () => 0
        }
      )
    ).rejects.toBe(failure)
    expect(download).toHaveBeenCalledOnce()
  })

  it('does not start another source after cancellation during a download', async () => {
    const controller = new AbortController()
    const download = vi.fn<typeof resilientDownload>(async () => {
      controller.abort(new Error('cancelled'))
      throw new DownloadSourceError('network abort')
    })
    await expect(
      downloadLocalModelAsset(
        asset,
        'unused',
        { signal: controller.signal },
        {
          fetchImpl: async () => response(),
          download,
          sources
        }
      )
    ).rejects.toThrow('cancelled')
    expect(download).toHaveBeenCalledOnce()
  })

  it.each([
    { kind: 'checksum', suffix: '.part' },
    { kind: 'checksum', suffix: '.part.meta' },
    { kind: 'response', suffix: '.part' },
    { kind: 'response', suffix: '.part.meta' },
    { kind: 'http', suffix: '.part.meta' }
  ])(
    'stops on storage failure cleaning up $suffix after a $kind error',
    async ({ kind, suffix }) => {
      const path = await target()
      const failure = Object.assign(new Error('cannot remove partial'), { code: 'EACCES' })
      let downloading = false
      const download = vi.fn<typeof resilientDownload>((url, target, opts) =>
        resilientDownload(url, target, {
          ...opts,
          deps: {
            ...opts?.deps,
            rmImpl: async (file) => {
              if (downloading && file === path + suffix) throw failure
              await rm(file, { force: true })
            },
            sleep: async () => undefined
          }
        })
      )
      await expect(
        downloadLocalModelAsset(
          asset,
          path,
          {},
          {
            sources,
            download,
            fetchImpl: async (_url, init) => {
              if (isProbe(init)) return response()
              downloading = true
              if (kind === 'http') return new Response(null, { status: 403 })
              return kind === 'checksum'
                ? response(Buffer.alloc(body.length))
                : new Response(body, { status: 206 })
            }
          }
        )
      ).rejects.toBe(failure)
      expect(download).toHaveBeenCalledOnce()
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('preserves integrity failure when no source supplies correct bytes', async () => {
    const path = await target()
    const download = vi.fn(downloadNow)
    await expect(
      downloadLocalModelAsset(
        asset,
        path,
        {},
        {
          fetchImpl: async (_url, init) =>
            isProbe(init) ? response() : response(Buffer.alloc(body.length)),
          download,
          sources
        }
      )
    ).rejects.toBeInstanceOf(DownloadChecksumError)
    expect(download).toHaveBeenCalledTimes(urls.length)
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
