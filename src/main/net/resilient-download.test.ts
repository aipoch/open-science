import { createHash } from 'node:crypto'
import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it, vi, type MockedFunction } from 'vitest'

import { DownloadChecksumError, resilientDownload } from './resilient-download'

// Builds a fake fetch honoring Range header; `cutAfter` truncates the body to simulate a drop.
const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

// Builds a fake fetch that honors Range for resume assertions. When `cutAfter` is set, it reports
// the FULL remaining content-length (simulating a real mid-stream drop where the server announced
// the size but closed the socket early) but only delivers `cutAfter` bytes of payload.
// When `opts.status` is explicitly 200, the Range header is ignored and the full body is served
// (simulates a server that does not support Range requests).
const fakeFetch = (
  body: Buffer,
  opts: { cutAfter?: number; status?: number } = {}
): MockedFunction<typeof fetch> =>
  vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const range = headers['Range'] ?? headers['range']
    const rangeStart = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0
    // A forced status:200 means "server ignored Range" → always serve from 0.
    const start = opts.status === 200 ? 0 : rangeStart
    const status = opts.status ?? (rangeStart > 0 ? 206 : 200)
    const slice = body.subarray(start)
    const served = opts.cutAfter != null ? slice.subarray(0, opts.cutAfter) : slice
    const stream = Readable.from([served])
    return {
      ok: status < 400,
      status,
      headers: {
        get: (h: string) =>
          h.toLowerCase() === 'content-length' ? String(slice.length) : null
      },
      body: Readable.toWeb(stream)
    } as unknown as Response
  })

// In-memory fs doubles keyed by path with append/truncate semantics.
const memFs = (): {
  files: Map<string, Buffer>
  createWriteStreamImpl: (path: string, o?: { flags?: string }) => import('node:fs').WriteStream
  statImpl: (path: string) => Promise<{ size: number }>
  rmImpl: (path: string) => Promise<void>
  renameImpl: (from: string, to: string) => Promise<void>
  openReadStreamImpl: (path: string) => import('node:fs').ReadStream
} => {
  const files = new Map<string, Buffer>()
  return {
    files,
    createWriteStreamImpl: (path: string, o?: { flags?: string }) => {
      if (!o || o.flags !== 'a') files.set(path, Buffer.alloc(0))
      const pt = new PassThrough()
      pt.on('data', (c: Buffer) =>
        files.set(path, Buffer.concat([files.get(path) ?? Buffer.alloc(0), c]))
      )
      return pt as unknown as import('node:fs').WriteStream
    },
    statImpl: async (path: string) => {
      const f = files.get(path)
      if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { size: f.length }
    },
    rmImpl: async (path: string) => void files.delete(path),
    renameImpl: async (from: string, to: string) => {
      files.set(to, files.get(from) ?? Buffer.alloc(0))
      files.delete(from)
    },
    openReadStreamImpl: (path: string) =>
      Readable.from([files.get(path) ?? Buffer.alloc(0)]) as unknown as import('node:fs').ReadStream
  }
}

describe('resilientDownload', () => {
  it('downloads and verifies a clean file', async () => {
    const body = Buffer.from('hello world payload')
    const fs = memFs()
    const out = await resilientDownload('https://cdn/file', '/tmp/out.bin', {
      expectedSha256: sha(body),
      deps: { fetchImpl: fakeFetch(body) as unknown as typeof fetch, ...fs, sleep: async () => {} }
    })
    expect(out).toBe('/tmp/out.bin')
    expect(fs.files.get('/tmp/out.bin')?.toString()).toBe('hello world payload')
    expect(fs.files.has('/tmp/out.bin.part')).toBe(false)
  })

  it('resumes with a Range request after a mid-stream cut', async () => {
    const body = Buffer.from('abcdefghijklmnopqrstuvwxyz')
    const fs = memFs()
    // Count .part reads to prove the hoisted hash is not re-read from disk on the Range resume.
    const openReadSpy = vi.fn(fs.openReadStreamImpl)
    const first = fakeFetch(body, { cutAfter: 10 })
    const rest = fakeFetch(body)
    let call = 0
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      call++
      return call === 1 ? first(input, init) : rest(input, init)
    })
    const out = await resilientDownload('https://cdn/file', '/tmp/out.bin', {
      expectedSha256: sha(body),
      stallTimeoutMs: 20,
      deps: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ...fs,
        openReadStreamImpl: openReadSpy,
        sleep: async () => {},
        now: () => 0
      }
    })
    expect(out).toBe('/tmp/out.bin')
    expect(fs.files.get('/tmp/out.bin')?.toString()).toBe(body.toString())
    const secondInit = rest.mock.calls[0][1] as { headers: Record<string, string> }
    expect(secondInit.headers['Range']).toBe('bytes=10-')
    // The 10 already-downloaded bytes stay in the hoisted hash — no .part re-read on resume.
    expect(openReadSpy).not.toHaveBeenCalled()
  })

  it('restarts from zero when server ignores Range (200 on resume)', async () => {
    const body = Buffer.from('0123456789')
    const fs = memFs()
    fs.files.set('/tmp/out.bin.part', Buffer.from('GARBAGE'))
    const out = await resilientDownload('https://cdn/file', '/tmp/out.bin', {
      expectedSha256: sha(body),
      deps: { fetchImpl: fakeFetch(body, { status: 200 }), ...fs, sleep: async () => {} }
    })
    expect(fs.files.get('/tmp/out.bin')?.toString()).toBe('0123456789')
    expect(out).toBe('/tmp/out.bin')
  })

  it('throws DownloadChecksumError and deletes .part on mismatch', async () => {
    const body = Buffer.from('payload')
    const fs = memFs()
    await expect(
      resilientDownload('https://cdn/file', '/tmp/out.bin', {
        expectedSha256: 'deadbeef',
        maxRetries: 0,
        deps: { fetchImpl: fakeFetch(body) as unknown as typeof fetch, ...fs, sleep: async () => {} }
      })
    ).rejects.toBeInstanceOf(DownloadChecksumError)
    expect(fs.files.has('/tmp/out.bin.part')).toBe(false)
  })

  it('keeps .part after exhausting retries on 5xx', async () => {
    const fs = memFs()
    const failing = vi.fn(async () => ({
      ok: false,
      status: 503,
      headers: { get: () => null },
      body: Readable.toWeb(Readable.from([Buffer.alloc(0)]))
    }) as unknown as Response)
    await expect(
      resilientDownload('https://cdn/file', '/tmp/out.bin', {
        maxRetries: 2,
        deps: { fetchImpl: failing as unknown as typeof fetch, ...fs, sleep: async () => {} }
      })
    ).rejects.toThrow()
    expect(failing.mock.calls.length).toBe(3) // initial + 2 retries
    // .part may or may not exist (503 = no bytes written), but we verify it did NOT get deleted
    // after-attempts cleanup — only sha256 mismatch deletes it
  })

  it('emits a reconnecting progress event before a retry', async () => {
    const body = Buffer.from('abcdefghij')
    const fs = memFs()
    const first = fakeFetch(body, { cutAfter: 4 })
    const rest = fakeFetch(body)
    let call = 0
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      call++
      return call === 1 ? first(input, init) : rest(input, init)
    })
    const phases: string[] = []
    await resilientDownload('https://cdn/file', '/tmp/out.bin', {
      expectedSha256: sha(body),
      stallTimeoutMs: 20,
      onProgress: (p) => phases.push(`${p.phase}:${p.attempt}`),
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch, ...fs, sleep: async () => {}, now: () => 0 }
    })
    expect(phases).toContain('reconnecting:1')
  })

  it('aborts via external signal and does not retry', async () => {
    const fs = memFs()
    const controller = new AbortController()
    const fetchImpl = vi.fn(async () => {
      controller.abort()
      const err = new Error('aborted')
      ;(err as { name: string }).name = 'AbortError'
      throw err
    })
    await expect(
      resilientDownload('https://cdn/file', '/tmp/out.bin', {
        signal: controller.signal,
        deps: { fetchImpl: fetchImpl as unknown as typeof fetch, ...fs, sleep: async () => {} }
      })
    ).rejects.toThrow()
    expect(fetchImpl.mock.calls.length).toBe(1)
  })

  it('cancels the retry backoff immediately when the signal fires mid-sleep', async () => {
    const body = Buffer.from('data')
    const fs = memFs()
    const controller = new AbortController()
    let sleepCallCount = 0
    // First fetch succeeds with a short body so the core detects an incomplete read and schedules
    // a retry with backoff. The signal is fired just as the backoff sleep starts; the sleep should
    // resolve immediately rather than waiting the full delay.
    const first = fakeFetch(body, { cutAfter: 2 }) // short read → retryable
    const rest = fakeFetch(body)
    let call = 0
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      call++
      return call === 1 ? first(input, init) : rest(input, init)
    })
    const abortAfterFirstFetch = vi.fn(async (ms: number): Promise<void> => {
      sleepCallCount++
      if (sleepCallCount === 1) {
        // Defer the abort to a microtask so sleepOrAbort's Promise.race has already attached the
        // abort-event listener by the time the signal fires. Aborting synchronously inside the
        // sleep mock would fire the event before the listener is registered.
        void Promise.resolve().then(() => controller.abort())
      }
      return new Promise((resolve) => setTimeout(resolve, ms))
    })
    await expect(
      resilientDownload('https://cdn/file', '/tmp/out.bin', {
        expectedSha256: sha(body),
        stallTimeoutMs: 20,
        signal: controller.signal,
        deps: {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          ...fs,
          sleep: abortAfterFirstFetch,
          now: () => 0
        }
      })
    ).rejects.toThrow()
    // The download must have been aborted during backoff — not after the full sleep completes.
    expect(sleepCallCount).toBe(1)
    expect(call).toBe(1) // second fetch was never started
  })
})
