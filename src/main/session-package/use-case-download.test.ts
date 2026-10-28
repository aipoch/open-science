import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFile, access } from 'node:fs/promises'
import { downloadUseCase } from './use-case-download'

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
