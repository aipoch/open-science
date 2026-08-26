import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { describe, expect, it, vi, type MockedFunction } from 'vitest'

import { DownloadChecksumError, resilientDownload } from './resilient-download'

// Build the destPath with the host's own join/sep (the plan's Windows-safe path rule) rather than a
// hardcoded literal. The memFs doubles key files by this exact string and never touch the real
// filesystem, so the separator the host produces is what round-trips through the download.
const OUT_PATH = join('downloads', 'out.bin')

// Builds a fake fetch honoring Range header; `cutAfter` truncates the body to simulate a drop.
const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

// Builds a fake fetch that honors Range for resume assertions. When `cutAfter` is set, it reports
// the FULL remaining content-length (simulating a real mid-stream drop where the server announced
// the size but closed the socket early) but only delivers `cutAfter` bytes of payload.
// When `opts.status` is explicitly 200, the Range header is ignored and the full body is served
// (simulates a server that does not support Range requests).
const fakeFetch = (
  body: Buffer,
  opts: {
    cutAfter?: number
    status?: number
    etag?: string | null
    lastModified?: string
    contentRangeStart?: number
    contentRangeEnd?: number
    contentRangeTotal?: number
  } = {}
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
        get: (h: string) => {
          const name = h.toLowerCase()
          if (name === 'content-length') return String(slice.length)
          if (name === 'etag') return opts.etag === undefined ? '"file-v1"' : opts.etag
          if (name === 'last-modified') return opts.lastModified ?? null
          if (name === 'content-range' && status === 206) {
            const responseStart = opts.contentRangeStart ?? start
            const responseEnd = opts.contentRangeEnd ?? responseStart + slice.length - 1
            return `bytes ${responseStart}-${responseEnd}/${opts.contentRangeTotal ?? body.length}`
          }
          return null
        }
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
  readTextImpl: (path: string) => Promise<string>
  writeTextImpl: (path: string, text: string) => Promise<void>
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
      Readable.from([
        files.get(path) ?? Buffer.alloc(0)
      ]) as unknown as import('node:fs').ReadStream,
    readTextImpl: async (path: string) => {
      const value = files.get(path)
      if (!value) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return value.toString('utf8')
    },
    writeTextImpl: async (path: string, text: string) => {
      files.set(path, Buffer.from(text))
    }
  }
}

describe('resilientDownload', () => {
  it('downloads and verifies a clean file', async () => {
    const body = Buffer.from('hello world payload')
    const fs = memFs()
    const out = await resilientDownload('https://cdn/file', OUT_PATH, {
      expectedSha256: sha(body),
      deps: { fetchImpl: fakeFetch(body) as unknown as typeof fetch, ...fs, sleep: async () => {} }
    })
    expect(out).toBe(OUT_PATH)
    expect(fs.files.get(OUT_PATH)?.toString()).toBe('hello world payload')
    expect(fs.files.has(`${OUT_PATH}.part`)).toBe(false)
    expect(fs.files.has(`${OUT_PATH}.part.meta`)).toBe(false)
  })

  it('rejects a response declared larger than expectedSize before writing', async () => {
    const body = Buffer.from('too-large-payload')
    const fs = memFs()

    await expect(
      resilientDownload('https://cdn/file', OUT_PATH, {
        expectedSize: 4,
        maxRetries: 0,
        deps: {
          fetchImpl: fakeFetch(body) as unknown as typeof fetch,
          ...fs,
          sleep: async () => {}
        }
      })
    ).rejects.toThrow(/expected size/i)

    expect(fs.files.has(`${OUT_PATH}.part`)).toBe(false)
    expect(fs.files.has(OUT_PATH)).toBe(false)
  })

  it('does not write a body chunk that would exceed expectedSize', async () => {
    const body = Buffer.from('too-large-payload')
    const fs = memFs()
    let written = 0
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: Readable.toWeb(Readable.from([body]))
    }))
    const createWriteStreamImpl = (): import('node:fs').WriteStream =>
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          written += chunk.length
          callback()
        }
      }) as unknown as import('node:fs').WriteStream

    await expect(
      resilientDownload('https://cdn/file', OUT_PATH, {
        expectedSize: 4,
        maxRetries: 0,
        deps: {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          ...fs,
          createWriteStreamImpl,
          sleep: async () => {}
        }
      })
    ).rejects.toThrow(/expected size/i)

    expect(written).toBe(0)
    expect(fs.files.has(OUT_PATH)).toBe(false)
  })

  it('binds a Range retry to the first response ETag', async () => {
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
    const out = await resilientDownload('https://cdn/file', OUT_PATH, {
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
    expect(out).toBe(OUT_PATH)
    expect(fs.files.get(OUT_PATH)?.toString()).toBe(body.toString())
    const secondInit = rest.mock.calls[0][1] as { headers: Record<string, string> }
    expect(secondInit.headers['Range']).toBe('bytes=10-')
    expect(secondInit.headers['If-Range']).toBe('"file-v1"')
    // The 10 already-downloaded bytes stay in the hoisted hash — no .part re-read on resume.
    expect(openReadSpy).not.toHaveBeenCalled()
  })

  it('falls back to Last-Modified when a strong ETag is unavailable', async () => {
    const body = Buffer.from('abcdefghijklmnopqrstuvwxyz')
    const fs = memFs()
    const lastModified = 'Wed, 26 Aug 2026 07:00:00 GMT'
    const first = fakeFetch(body, { cutAfter: 10, etag: null, lastModified })
    const rest = fakeFetch(body, { etag: null, lastModified })
    let call = 0
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      call++
      return call === 1 ? first(input, init) : rest(input, init)
    })

    await resilientDownload('https://cdn/file', OUT_PATH, {
      expectedSha256: sha(body),
      deps: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ...fs,
        sleep: async () => {},
        now: () => 0
      }
    })

    const secondInit = rest.mock.calls[0][1] as { headers: Record<string, string> }
    expect(secondInit.headers['Range']).toBe('bytes=10-')
    expect(secondInit.headers['If-Range']).toBe(lastModified)
  })

  it('retains the response validator for a later downloader call', async () => {
    const body = Buffer.from('abcdefghijklmnopqrstuvwxyz')
    const root = await mkdtemp(join(tmpdir(), 'resilient-download-'))
    const outPath = join(root, 'out.bin')

    try {
      await expect(
        resilientDownload('https://cdn/file', outPath, {
          expectedSha256: sha(body),
          expectedSize: body.length,
          maxRetries: 0,
          deps: {
            fetchImpl: fakeFetch(body, { cutAfter: 10 }) as unknown as typeof fetch,
            sleep: async () => {},
            now: () => 0
          }
        })
      ).rejects.toThrow(/short read/i)

      const rest = fakeFetch(body)
      await resilientDownload('https://cdn/file', outPath, {
        expectedSha256: sha(body),
        expectedSize: body.length,
        deps: {
          fetchImpl: rest as unknown as typeof fetch,
          sleep: async () => {},
          now: () => 0
        }
      })

      const resumeInit = rest.mock.calls[0][1] as { headers: Record<string, string> }
      expect(resumeInit.headers['Range']).toBe('bytes=10-')
      expect(resumeInit.headers['If-Range']).toBe('"file-v1"')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('discards a historical partial that has no validator metadata', async () => {
    const body = Buffer.from('0123456789')
    const fs = memFs()
    fs.files.set(`${OUT_PATH}.part`, Buffer.from('STALE'))
    const fetchImpl = fakeFetch(body)

    await resilientDownload('https://cdn/file', OUT_PATH, {
      expectedSize: body.length,
      deps: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ...fs,
        sleep: async () => {},
        now: () => 0
      }
    })

    const init = fetchImpl.mock.calls[0][1] as { headers: Record<string, string> }
    expect(init.headers['Range']).toBeUndefined()
    expect(fs.files.get(OUT_PATH)?.equals(body)).toBe(true)
  })

  it('does not let orphaned validator metadata authorize a later partial', async () => {
    const url = 'https://cdn/file'
    const firstBody = Buffer.from('version-two-contents')
    const laterBody = Buffer.from('version-one-contents')
    const fs = memFs()
    fs.files.set(
      `${OUT_PATH}.part.meta`,
      Buffer.from(
        JSON.stringify({
          version: 1,
          urlSha256: sha(Buffer.from(url)),
          validator: { kind: 'etag', value: '"version-one"' },
          expectedSize: firstBody.length
        })
      )
    )

    await expect(
      resilientDownload(url, OUT_PATH, {
        expectedSize: firstBody.length,
        maxRetries: 0,
        deps: {
          fetchImpl: fakeFetch(firstBody, { cutAfter: 8, etag: null }) as unknown as typeof fetch,
          ...fs,
          sleep: async () => {},
          now: () => 0
        }
      })
    ).rejects.toThrow(/short read/i)

    const laterFetch = fakeFetch(laterBody, { etag: '"version-one"' })
    await resilientDownload(url, OUT_PATH, {
      expectedSize: laterBody.length,
      deps: {
        fetchImpl: laterFetch as unknown as typeof fetch,
        ...fs,
        sleep: async () => {},
        now: () => 0
      }
    })

    const retryInit = laterFetch.mock.calls[0][1] as { headers: Record<string, string> }
    expect(retryInit.headers['Range']).toBeUndefined()
    expect(fs.files.get(OUT_PATH)?.equals(laterBody)).toBe(true)
  })

  it('restarts from zero rather than resuming without a usable validator', async () => {
    const body = Buffer.from('abcdefghijklmnopqrstuvwxyz')
    const fs = memFs()
    const first = fakeFetch(body, { cutAfter: 10, etag: 'W/"file-v1"' })
    const rest = fakeFetch(body, { etag: 'W/"file-v1"' })
    let call = 0
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      call++
      return call === 1 ? first(input, init) : rest(input, init)
    })

    await resilientDownload('https://cdn/file', OUT_PATH, {
      expectedSha256: sha(body),
      deps: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ...fs,
        sleep: async () => {},
        now: () => 0
      }
    })

    const retryInit = rest.mock.calls[0][1] as { headers: Record<string, string> }
    expect(retryInit.headers['Range']).toBeUndefined()
    expect(retryInit.headers['If-Range']).toBeUndefined()
    expect(fs.files.get(OUT_PATH)?.equals(body)).toBe(true)
  })

  it('surfaces an unresumable partial cleanup failure without retrying it', async () => {
    const body = Buffer.from('abcdefghijklmnopqrstuvwxyz')
    const fs = memFs()
    const fetchImpl = fakeFetch(body, { cutAfter: 8, etag: null })
    const sleep = vi.fn(async () => undefined)
    const removePart = vi.fn()
    const rmImpl = async (path: string): Promise<void> => {
      if (path === `${OUT_PATH}.part`) {
        removePart(path)
        throw new Error('EACCES: cannot delete unresumable partial')
      }
      await fs.rmImpl(path)
    }

    await expect(
      resilientDownload('https://cdn/file', OUT_PATH, {
        expectedSize: body.length,
        maxRetries: 2,
        deps: {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          ...fs,
          rmImpl,
          sleep,
          now: () => 0
        }
      })
    ).rejects.toThrow(/EACCES/)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(removePart).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('rejects a 206 whose Content-Range start differs from the local offset', async () => {
    const body = Buffer.from('abcdefghijklmnopqrstuvwxyz')
    const fs = memFs()
    const first = fakeFetch(body, { cutAfter: 10 })
    const invalidResume = fakeFetch(body, { contentRangeStart: 0 })
    let call = 0
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      call++
      return call === 1 ? first(input, init) : invalidResume(input, init)
    })

    await expect(
      resilientDownload('https://cdn/file', OUT_PATH, {
        expectedSha256: sha(body),
        expectedSize: body.length,
        deps: {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          ...fs,
          sleep: async () => {},
          now: () => 0
        }
      })
    ).rejects.toThrow(/Content-Range/i)

    expect(fs.files.has(OUT_PATH)).toBe(false)
  })

  it('rejects a Content-Range total larger than expectedSize', async () => {
    const body = Buffer.from('abcdefghijklmnopqrstuvwxyz')
    const fs = memFs()
    const first = fakeFetch(body, { cutAfter: 10 })
    const oversizedRange = fakeFetch(body, { contentRangeTotal: 100 })
    let call = 0
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      call++
      return call === 1 ? first(input, init) : oversizedRange(input, init)
    })

    await expect(
      resilientDownload('https://cdn/file', OUT_PATH, {
        expectedSha256: sha(body),
        expectedSize: body.length,
        deps: {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          ...fs,
          sleep: async () => {},
          now: () => 0
        }
      })
    ).rejects.toThrow(/Content-Range|expected size/i)

    expect(fs.files.has(OUT_PATH)).toBe(false)
  })

  it('rejects a Content-Range length inconsistent with Content-Length', async () => {
    const body = Buffer.from('abcdefghijklmnopqrstuvwxyz')
    const fs = memFs()
    const first = fakeFetch(body, { cutAfter: 10 })
    const inconsistentRange = fakeFetch(body, { contentRangeEnd: 20 })
    let call = 0
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      call++
      return call === 1 ? first(input, init) : inconsistentRange(input, init)
    })

    await expect(
      resilientDownload('https://cdn/file', OUT_PATH, {
        expectedSha256: sha(body),
        expectedSize: body.length,
        deps: {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          ...fs,
          sleep: async () => {},
          now: () => 0
        }
      })
    ).rejects.toThrow(/Content-Range|Content-Length/i)

    expect(fs.files.has(OUT_PATH)).toBe(false)
  })

  it('rejects a 206 carrying a different ETag than the bound partial', async () => {
    const firstBody = Buffer.from('0123456789abcdefghij')
    const changedBody = Buffer.from('ABCDEFGHIJ0123456789')
    const fs = memFs()
    const first = fakeFetch(firstBody, { cutAfter: 10, etag: '"file-v1"' })
    const changedResume = fakeFetch(changedBody, { etag: '"file-v2"' })
    let call = 0
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      call++
      return call === 1 ? first(input, init) : changedResume(input, init)
    })

    await expect(
      resilientDownload('https://cdn/file', OUT_PATH, {
        expectedSize: firstBody.length,
        deps: {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          ...fs,
          sleep: async () => {},
          now: () => 0
        }
      })
    ).rejects.toThrow(/validator|ETag/i)

    expect(fs.files.has(OUT_PATH)).toBe(false)
  })

  it('restarts from zero when If-Range detects a changed representation', async () => {
    const firstBody = Buffer.from('0123456789')
    const currentBody = Buffer.from('abcdefghij')
    const fs = memFs()
    const first = fakeFetch(firstBody, { cutAfter: 4, etag: '"file-v1"' })
    const changed = fakeFetch(currentBody, { status: 200, etag: '"file-v2"' })
    let call = 0
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      call++
      return call === 1 ? first(input, init) : changed(input, init)
    })

    const out = await resilientDownload('https://cdn/file', OUT_PATH, {
      expectedSize: currentBody.length,
      deps: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ...fs,
        sleep: async () => {},
        now: () => 0
      }
    })

    const retryInit = changed.mock.calls[0][1] as { headers: Record<string, string> }
    expect(retryInit.headers['Range']).toBe('bytes=4-')
    expect(retryInit.headers['If-Range']).toBe('"file-v1"')
    expect(fs.files.get(OUT_PATH)?.equals(currentBody)).toBe(true)
    expect(out).toBe(OUT_PATH)
  })

  it('throws DownloadChecksumError and deletes .part on mismatch', async () => {
    const body = Buffer.from('payload')
    const fs = memFs()
    await expect(
      resilientDownload('https://cdn/file', OUT_PATH, {
        expectedSha256: 'deadbeef',
        maxRetries: 0,
        deps: {
          fetchImpl: fakeFetch(body) as unknown as typeof fetch,
          ...fs,
          sleep: async () => {}
        }
      })
    ).rejects.toBeInstanceOf(DownloadChecksumError)
    expect(fs.files.has(`${OUT_PATH}.part`)).toBe(false)
  })

  it('keeps .part after exhausting retries on 5xx', async () => {
    const fs = memFs()
    const failing = vi.fn(
      async () =>
        ({
          ok: false,
          status: 503,
          headers: { get: () => null },
          body: Readable.toWeb(Readable.from([Buffer.alloc(0)]))
        }) as unknown as Response
    )
    await expect(
      resilientDownload('https://cdn/file', OUT_PATH, {
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
    await resilientDownload('https://cdn/file', OUT_PATH, {
      expectedSha256: sha(body),
      stallTimeoutMs: 20,
      onProgress: (p) => phases.push(`${p.phase}:${p.attempt}`),
      deps: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ...fs,
        sleep: async () => {},
        now: () => 0
      }
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
      resilientDownload('https://cdn/file', OUT_PATH, {
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
      resilientDownload('https://cdn/file', OUT_PATH, {
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

  it('fails terminally and destroys the stream when a write callback rejects', async () => {
    // The write callback itself rejects (a real disk fault: ENOSPC/EIO), NOT merely a stream 'error'
    // event with a still-succeeding write. A disk fault is terminal — retrying the download cannot fix
    // a full/unwritable disk, and a partial write may already have hit disk. Assert: rejects, exactly
    // one fetch (no retry), and the failed stream was destroyed by the cleanup path.
    const body = Buffer.from('abcdefghijklmnopqrstuvwxyz')
    const fs = memFs()
    const fetchImpl = fakeFetch(body)
    let created: Writable | undefined
    const createWriteStreamImpl = (): import('node:fs').WriteStream => {
      const w = new Writable({
        write(_chunk, _enc, cb) {
          cb(new Error('ENOSPC no space left on device'))
        }
      })
      created = w
      return w as unknown as import('node:fs').WriteStream
    }
    await expect(
      resilientDownload('https://cdn/file', OUT_PATH, {
        expectedSha256: sha(body),
        deps: {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          ...fs,
          createWriteStreamImpl,
          sleep: async () => {},
          now: () => 0
        }
      })
    ).rejects.toThrow(/ENOSPC/)
    expect(fetchImpl.mock.calls.length).toBe(1) // terminal — never retried
    expect(created?.destroyed).toBe(true) // cleanup path destroyed the failed stream
  })

  it('destroys the still-open write stream in the catch path when the body errors mid-stream', async () => {
    // The response body delivers a few bytes then THROWS mid-stream (a dropped socket) — so the file
    // is still open when the error propagates, unlike a clean short read that ends() first. This is
    // the path where the retry catch must proactively destroy() the open handle. Assert the first
    // stream is destroyed before the retry opens the second, then the retry resumes and completes.
    const body = Buffer.from('abcdefghijklmnopqrstuvwxyz')
    const fs = memFs()
    const events: string[] = []
    let idx = 0
    const createWriteStreamImpl = (
      path: string,
      o?: { flags?: string }
    ): import('node:fs').WriteStream => {
      if (!o || o.flags !== 'a') fs.files.set(path, Buffer.alloc(0))
      const id = idx++
      events.push(`create:${id}`)
      const pt = new PassThrough()
      pt.on('data', (c: Buffer) =>
        fs.files.set(path, Buffer.concat([fs.files.get(path) ?? Buffer.alloc(0), c]))
      )
      pt.on('close', () => events.push(`destroy:${id}`))
      return pt as unknown as import('node:fs').WriteStream
    }
    // First response: a body stream that yields the first 8 bytes, then errors (socket drop) while the
    // write stream is still open. Content-length announces the full size so it is not a clean short read.
    const firstFetch = vi.fn(async () => {
      const gen = (async function* () {
        yield body.subarray(0, 8)
        throw new Error('ECONNRESET socket hang up')
      })()
      return {
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h.toLowerCase() === 'content-length' ? '26' : null) },
        body: Readable.toWeb(Readable.from(gen))
      } as unknown as Response
    })
    const rest = fakeFetch(body) // resumes from the persisted 8 bytes via Range
    let call = 0
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      call++
      return call === 1 ? firstFetch() : rest(input, init)
    })
    const out = await resilientDownload('https://cdn/file', OUT_PATH, {
      expectedSha256: sha(body),
      stallTimeoutMs: 50,
      deps: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ...fs,
        createWriteStreamImpl,
        sleep: async () => {},
        now: () => 0
      }
    })
    expect(out).toBe(OUT_PATH)
    expect(fs.files.get(OUT_PATH)?.toString()).toBe(body.toString())
    expect(call).toBe(2) // it did retry after the mid-stream error
    // The open handle from attempt 1 was destroyed (in the catch) before attempt 2 opened its stream.
    expect(events.indexOf('destroy:0')).toBeLessThan(events.indexOf('create:1'))
  })

  it('does not retry when the final rename fails (terminal)', async () => {
    const body = Buffer.from('payload-bytes')
    const fs = memFs()
    const fetchImpl = fakeFetch(body)
    const renameImpl = vi.fn(async () => {
      throw Object.assign(new Error('EXDEV cross-device rename'), { code: 'EXDEV' })
    })
    await expect(
      resilientDownload('https://cdn/file', OUT_PATH, {
        expectedSha256: sha(body),
        deps: {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          ...fs,
          renameImpl,
          sleep: async () => {},
          now: () => 0
        }
      })
    ).rejects.toThrow(/EXDEV/)
    // A rename failure is terminal: exactly one fetch and one rename attempt, no retry spin.
    expect(fetchImpl.mock.calls.length).toBe(1)
    expect(renameImpl.mock.calls.length).toBe(1)
  })
})
