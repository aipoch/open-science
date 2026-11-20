import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { readFile, access } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as storageUsage from '../storage/usage'
import { downloadUseCase, UseCaseDownloadError } from './use-case-download'

const bytes = Buffer.from('example archive')
const entry = {
  name: 'research',
  title: 'Research',
  cover: { file_name: 'cover.png' },
  case: {
    file_name: 'Research.science',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
}
afterEach(() => vi.unstubAllGlobals())

it('does not request the archive if the staging volume lacks capacity', async () => {
  const available = vi.spyOn(storageUsage, 'availableBytes').mockResolvedValue(0)
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json([entry]))
  vi.stubGlobal('fetch', fetcher)
  try {
    await expect(
      downloadUseCase('research', new AbortController().signal, () => {})
    ).rejects.toMatchObject({ freeBytes: 0, message: expect.stringContaining('disk space') })
    expect(fetcher).toHaveBeenCalledOnce()
  } finally {
    available.mockRestore()
  }
})

it('streams a verified archive to a native path and releases it after use', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json([entry]))
      .mockResolvedValueOnce(new Response(bytes))
  )
  const source = await downloadUseCase('research', new AbortController().signal, () => {})
  expect(await readFile(source.path)).toEqual(bytes)
  await source.release()
  await expect(access(source.path)).rejects.toThrow()
})

it('classifies a truncated archive as a verification failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json([entry]))
      .mockResolvedValueOnce(new Response(bytes.subarray(0, -1)))
  )
  await expect(
    downloadUseCase('research', new AbortController().signal, () => {})
  ).rejects.toMatchObject({ name: 'UseCaseDownloadError', reason: 'verification' })
})

it.each([
  { framing: 'Content-Length', connection: 'close' },
  { framing: 'Content-Length', connection: 'keep-alive' },
  { framing: 'chunked', connection: 'close' },
  { framing: 'chunked', connection: 'keep-alive' }
])(
  'classifies a truncated $framing HTTP response with Connection: $connection as a verification failure',
  async ({ framing, connection }) => {
    const server = createServer((_request, response) => {
      const socket = response.socket
      response.writeHead(
        200,
        framing === 'chunked'
          ? { 'Transfer-Encoding': 'chunked', Connection: connection }
          : { 'Content-Length': bytes.length, Connection: connection }
      )
      response.write(bytes.subarray(0, -1), () => socket?.end())
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const { port } = server.address() as AddressInfo
      const fetchHttp = globalThis.fetch
      vi.stubGlobal(
        'fetch',
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(Response.json([entry]))
          .mockImplementationOnce((_url, options) => fetchHttp(`http://127.0.0.1:${port}`, options))
      )
      await expect(
        downloadUseCase('research', new AbortController().signal, () => {})
      ).rejects.toMatchObject({ name: 'UseCaseDownloadError', reason: 'verification' })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
)

it('cancels a failed manifest response before opening an archive', async () => {
  const cancel = vi.fn()
  const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 503 }))
  vi.stubGlobal('fetch', fetcher)
  await expect(downloadUseCase('research', new AbortController().signal, () => {})).rejects.toThrow(
    'Could not load use cases.'
  )
  expect(fetcher).toHaveBeenCalledOnce()
  expect(cancel).toHaveBeenCalledOnce()
})

it('reports a timeout if the catalog body stalls after the headers arrive', async () => {
  const deadline = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal)
  const body = new ReadableStream(
    {
      pull(controller) {
        deadline.abort(new DOMException('The operation timed out.', 'TimeoutError'))
        controller.error(new DOMException('The operation was aborted.', 'AbortError'))
      }
    },
    { highWaterMark: 0 }
  )
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(body))
  vi.stubGlobal('fetch', fetcher)
  try {
    await expect(
      downloadUseCase('research', new AbortController().signal, () => {})
    ).rejects.toMatchObject({ name: 'UseCaseDownloadError', reason: 'timeout' })
    expect(fetcher).toHaveBeenCalledOnce()
  } finally {
    timeout.mockRestore()
  }
})

it('keeps malformed JSON classified as a catalog failure', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('redirect')))
  await expect(
    downloadUseCase('research', new AbortController().signal, () => {})
  ).rejects.toMatchObject({ name: 'UseCaseDownloadError', reason: 'manifest' })
})

it.each(['checksum', 'size', 'unknown', 'http'])(
  'rejects %s failures before import',
  async (failure) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json([entry]))
        .mockResolvedValueOnce(
          failure === 'http'
            ? new Response(null, { status: 503 })
            : new Response(
                failure === 'size' ? Buffer.concat([bytes, bytes]) : Buffer.alloc(bytes.length)
              )
        )
    )
    await expect(
      downloadUseCase(
        failure === 'unknown' ? 'missing' : 'research',
        new AbortController().signal,
        () => {}
      )
    ).rejects.toThrow()
  }
)

it('stops an in-flight download on cancellation', async () => {
  const controller = new AbortController()
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(bytes)
      stream.close()
    }
  })
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json([entry]))
      .mockResolvedValueOnce(new Response(body))
  )
  await expect(
    downloadUseCase('research', controller.signal, () => controller.abort())
  ).rejects.toThrow()
})

it('allows a healthy download to continue beyond ten minutes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('Timed out')), milliseconds)
    return controller.signal
  })
  const contents = Buffer.alloc(40, 7)
  let stream!: ReadableStreamDefaultController<Uint8Array>
  let downloadSignal!: AbortSignal
  let received = 0
  let settled = false
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json([
        {
          ...entry,
          case: {
            ...entry.case,
            bytes: contents.length,
            sha256: createHash('sha256').update(contents).digest('hex')
          }
        }
      ])
    )
    .mockImplementationOnce(
      async (_url, options) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              downloadSignal = options.signal
              stream = controller
              options.signal.addEventListener(
                'abort',
                () => controller.error(options.signal.reason),
                { once: true }
              )
            }
          })
        )
    )
  vi.stubGlobal('fetch', fetcher)
  const work = downloadUseCase('research', new AbortController().signal, (bytes) => {
    received = bytes
  })
    .then(
      (source) => ({ source, error: undefined }),
      (error) => ({ source: undefined, error })
    )
    .finally(() => {
      settled = true
    })
  try {
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    for (let index = 0; index < contents.length && !settled; index++) {
      await vi.advanceTimersByTimeAsync(20_000)
      expect(downloadSignal.aborted).toBe(false)
      if (settled) break
      stream.enqueue(contents.subarray(index, index + 1))
      await vi.waitFor(() => expect(received > index || settled).toBe(true))
    }
    if (!settled) stream.close()
    const result = await work
    expect(result.error).toBeUndefined()
    if (result.source) {
      expect(await readFile(result.source.path)).toEqual(contents)
      await result.source.release()
    }
  } finally {
    timeout.mockRestore()
    vi.useRealTimers()
  }
})

it('classifies manifest, network, timeout, server, unavailable, and verification download failures', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'))
  )
  await expect(
    downloadUseCase('research', new AbortController().signal, () => {})
  ).rejects.toMatchObject({ name: 'UseCaseDownloadError', reason: 'timeout' })

  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValueOnce(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' })
      })
    )
  )
  await expect(
    downloadUseCase('research', new AbortController().signal, () => {})
  ).rejects.toMatchObject({ name: 'UseCaseDownloadError', reason: 'network' })

  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json([entry]))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
  )
  await expect(
    downloadUseCase('research', new AbortController().signal, () => {})
  ).rejects.toMatchObject({ name: 'UseCaseDownloadError', reason: 'unavailable' })

  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json([entry]))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
  )
  await expect(
    downloadUseCase('research', new AbortController().signal, () => {})
  ).rejects.toMatchObject({ name: 'UseCaseDownloadError', reason: 'server' })

  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json([entry]))
      .mockResolvedValueOnce(new Response(Buffer.alloc(bytes.length)))
  )
  await expect(
    downloadUseCase('research', new AbortController().signal, () => {})
  ).rejects.toBeInstanceOf(UseCaseDownloadError)

  vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('unexpected internal failure')))
  const unknown = await downloadUseCase('research', new AbortController().signal, () => {}).catch(
    (error) => error
  )
  expect(unknown).toBeInstanceOf(Error)
  expect(unknown).not.toBeInstanceOf(UseCaseDownloadError)
  expect((unknown as Error).message).toBe('unexpected internal failure')
})
