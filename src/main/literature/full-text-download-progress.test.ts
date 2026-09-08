import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { LiteratureFullTextProgress } from '../../shared/literature'
import { downloadFullText } from './full-text-download'

const fixture = vi.hoisted(() => ({
  headers: {} as Record<string, string>,
  status: 200,
  requests: 0
}))
vi.mock('node:https', () => ({
  get: (_url: URL, _options: unknown, callback: (response: Readable) => void) => {
    fixture.requests += 1
    queueMicrotask(() =>
      callback(
        Object.assign(Readable.from([Buffer.from('%PDF-'), Buffer.from('12345')]), {
          statusCode: fixture.status,
          headers: fixture.headers
        })
      )
    )
    return { on: vi.fn() }
  }
}))

describe('full-text transfer progress', () => {
  it('honors source throttling without additional size or download requests during Retry-After', async () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    fixture.status = 429
    fixture.headers = { 'retry-after': '120' }
    const before = fixture.requests
    try {
      await expect(
        downloadFullText('https://limited.example/paper.pdf', 100)
      ).rejects.toMatchObject({ retryAt: now + 120_000 })
      await expect(
        downloadFullText('https://limited.example/another.pdf', 100)
      ).rejects.toMatchObject({ retryAt: now + 120_000 })
      expect(fixture.requests - before).toBe(1)
      vi.spyOn(Date, 'now').mockReturnValue(now + 121_000)
      fixture.status = 200
      fixture.headers = {}
      await expect(
        downloadFullText('https://limited.example/paper.pdf', 100)
      ).resolves.toHaveLength(10)
      expect(fixture.requests - before).toBe(2)
    } finally {
      fixture.status = 200
      vi.restoreAllMocks()
    }
  })
  it.each([true, false])(
    'reports received bytes with or without Content-Length: %s',
    async (known) => {
      fixture.headers = known ? { 'content-length': '10' } : {}
      const progress: LiteratureFullTextProgress[] = []
      const bytes = await downloadFullText('https://journal.example/paper.pdf', 100, (value) =>
        progress.push(value)
      )
      expect(bytes.length).toBe(10)
      expect(progress.map((value) => value.receivedBytes)).toEqual([0, 5, 10])
      expect(progress.at(-1)).toMatchObject({
        totalBytes: known ? 10 : undefined,
        phase: 'downloading'
      })
      expect(progress.at(-1)!.bytesPerSecond).toBeGreaterThan(0)
    }
  )
})

it('does not open a request after cancellation while resolving the proxy', async () => {
  const controller = new AbortController()
  const before = fixture.requests
  await expect(
    downloadFullText(
      'https://journal.example/paper.pdf',
      100,
      undefined,
      async () => {
        controller.abort(new Error('cancelled proxy lookup'))
        return undefined
      },
      controller.signal
    )
  ).rejects.toThrow('cancelled proxy lookup')
  expect(fixture.requests).toBe(before)
})

it.each(['request', 'timeout'] as const)(
  'stops reading bytes after the %s signal aborts',
  async (cause) => {
    fixture.headers = {}
    const request = new AbortController()
    const timeout = new AbortController()
    const timeoutFactory = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    const received: number[] = []
    try {
      await expect(
        downloadFullText(
          'https://journal.example/paper.pdf',
          100,
          (progress) => {
            received.push(progress.receivedBytes)
            if (progress.receivedBytes === 5)
              (cause === 'request' ? request : timeout).abort(new Error(cause))
          },
          undefined,
          request.signal
        )
      ).rejects.toThrow(cause)
      expect(timeoutFactory).toHaveBeenCalledWith(60_000)
      expect(received).toEqual([0, 5])
    } finally {
      timeoutFactory.mockRestore()
    }
  }
)
