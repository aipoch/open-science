import { EventEmitter } from 'node:events'
import type { IncomingMessage, RequestOptions } from 'node:http'
import { Readable } from 'node:stream'
import { gzipSync, brotliCompressSync } from 'node:zlib'
import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  createWebTransport,
  isPublicWebAddress,
  parseWebUrl,
  WEB_FETCH_BODY_LIMIT,
  type WebTransportDependencies
} from './transport'
import { WebSemaphore } from './limits'

const resource = (
  body: Buffer | string,
  headers: Record<string, string> = {},
  status = 200
): IncomingMessage => {
  const stream = Readable.from([Buffer.from(body)]) as IncomingMessage
  stream.statusCode = status
  stream.headers = { 'content-type': 'text/plain', ...headers }
  return stream
}
const fixture = (
  responses: IncomingMessage[]
): {
  calls: Array<{ url: URL; options: RequestOptions }>
  lookup: Mock<() => Promise<Array<{ address: string; family: number }>>>
  resolveProxy: Mock<() => Promise<string>>
  transport: ReturnType<typeof createWebTransport>
} => {
  const calls: Array<{ url: URL; options: RequestOptions }> = []
  const request = ((
    url: URL,
    options: RequestOptions,
    done: (response: IncomingMessage) => void
  ) => {
    calls.push({ url, options })
    const emitter = new EventEmitter() as EventEmitter & { end: () => void }
    emitter.end = () => queueMicrotask(() => done(responses.shift()!))
    return emitter
  }) as unknown as NonNullable<WebTransportDependencies['request']>
  const lookup = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }])
  const resolveProxy = vi.fn(async () => 'DIRECT')
  return {
    calls,
    lookup,
    resolveProxy,
    transport: createWebTransport({ request, httpsRequest: request, lookup, resolveProxy })
  }
}

describe('public web destination boundary', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.2',
    '100.64.1.1',
    '169.254.169.254',
    '172.31.0.1',
    '192.168.1.1',
    '192.0.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.1.1.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:8.8.8.8',
    '2001:db8::1',
    '2002:808:808::1',
    '64:ff9b::808:808',
    '3fff::1'
  ])('blocks %s', (address) => {
    expect(isPublicWebAddress(address)).toBe(false)
  })
  it.each(['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888', '2606:4700:4700::1111'])(
    'allows %s',
    (address) => {
      expect(isPublicWebAddress(address)).toBe(true)
    }
  )
  it.each([
    'file:///tmp/private',
    'ftp://example.org/',
    'http://example.org:8080/',
    'https://user:pass@example.org/',
    'https://example.org/?access_token=private',
    'https://example.org/?X-Amz-Signature=private',
    'https://example.org/?x-goog-credential=private',
    'https://example.org/?sv=1&sp=read&se=tomorrow',
    'https://example.org/\nprivate'
  ])('rejects unsafe URL %s', (url) => {
    expect(() => parseWebUrl(url)).toThrow()
  })
  it('normalizes numeric alternate loopback before evaluating the address', async () => {
    const { transport, calls } = fixture([])
    await expect(
      transport('http://2130706433/', new AbortController().signal)
    ).rejects.toMatchObject({ code: 'BLOCKED_TARGET' })
    expect(calls).toHaveLength(0)
  })
  it('validates every DNS address and never connects when one is private', async () => {
    const f = fixture([])
    f.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.2', family: 4 }
    ])
    await expect(
      f.transport('https://public.example/', new AbortController().signal)
    ).rejects.toMatchObject({ code: 'BLOCKED_TARGET' })
    expect(f.calls).toHaveLength(0)
  })
  it('pins the verified IP while retaining the original URL for Host and TLS SNI', async () => {
    const f = fixture([resource('evidence')])
    expect(
      await f.transport('https://public.example/', new AbortController().signal)
    ).toMatchObject({ finalUrl: 'https://public.example/', body: Buffer.from('evidence') })
    expect(f.calls[0].url.hostname).toBe('public.example')
    expect(f.calls[0].options).toMatchObject({ agent: false, family: 4 })
    const callback = vi.fn()
    ;(
      f.calls[0].options.lookup as (
        name: string,
        options: object,
        done: (...args: unknown[]) => void
      ) => void
    )('public.example', {}, callback)
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4)
    expect(f.lookup).toHaveBeenCalledTimes(1)
    expect(f.calls[0].options.headers).not.toHaveProperty('Cookie')
    expect(f.calls[0].options.headers).not.toHaveProperty('Authorization')
  })
  it('rejects redirect to private address before the second connection', async () => {
    const f = fixture([resource('', { location: 'http://169.254.169.254/latest' }, 302)])
    await expect(
      f.transport('https://public.example/', new AbortController().signal)
    ).rejects.toMatchObject({ code: 'BLOCKED_TARGET' })
    expect(f.calls).toHaveLength(1)
  })
  it('rechecks proxy policy and DNS on every redirect and stops after five redirects', async () => {
    const f = fixture(Array.from({ length: 6 }, () => resource('', { location: '/again' }, 302)))
    await expect(
      f.transport('https://public.example/', new AbortController().signal)
    ).rejects.toMatchObject({ code: 'HTTP_ERROR' })
    expect(f.calls).toHaveLength(6)
    expect(f.lookup).toHaveBeenCalledTimes(6)
    expect(f.resolveProxy).toHaveBeenCalledTimes(6)
  })
  it.each([
    'PROXY localhost:8080; DIRECT',
    'SOCKS5 localhost:1080',
    'HTTPS localhost:8080',
    'PROXY user:secret@localhost:8080',
    'PROXY localhost:99999',
    'PROXY localhost:0',
    ''
  ])('fails closed for proxy mode %s', async (rules) => {
    const f = fixture([])
    f.resolveProxy.mockResolvedValue(rules)
    await expect(
      f.transport('https://public.example/', new AbortController().signal)
    ).rejects.toMatchObject({ code: 'NETWORK_MODE_UNSUPPORTED' })
    expect(f.calls).toHaveLength(0)
  })
  it('cancels a pending DNS lookup', async () => {
    const f = fixture([])
    f.lookup.mockImplementation(() => new Promise(() => {}))
    const controller = new AbortController()
    const reading = f.transport('https://public.example/', controller.signal)
    await vi.waitFor(() => expect(f.lookup).toHaveBeenCalledOnce())
    controller.abort(new Error('cancelled'))
    await expect(reading).rejects.toThrow('cancelled')
    expect(f.calls).toHaveLength(0)
  })
})

describe('bounded streaming web transport', () => {
  it.each(['gzip', 'br'] as const)(
    'decodes %s and enforces the decoded limit',
    async (encoding) => {
      const compress = encoding === 'gzip' ? gzipSync : brotliCompressSync
      const f = fixture([
        resource(compress(Buffer.alloc(WEB_FETCH_BODY_LIMIT + 1, 'x')), {
          'content-encoding': encoding
        })
      ])
      await expect(
        f.transport('https://public.example/', new AbortController().signal)
      ).rejects.toMatchObject({ code: 'CONTENT_TOO_LARGE' })
    }
  )
  it('accepts gzip text and rejects unsupported content independently of HTTP success', async () => {
    const good = fixture([resource(gzipSync('plain text'), { 'content-encoding': 'gzip' })])
    expect(
      (
        await good.transport('https://public.example/', new AbortController().signal)
      ).body.toString()
    ).toBe('plain text')
    const pdf = fixture([resource('%PDF', { 'content-type': 'application/pdf' })])
    await expect(
      pdf.transport('https://public.example/', new AbortController().signal)
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT_TYPE' })
    const error = fixture([resource('Login', {}, 403)])
    await expect(
      error.transport('https://public.example/', new AbortController().signal)
    ).rejects.toMatchObject({ code: 'HTTP_ERROR' })
  })
  it('cancels a slow body read', async () => {
    const body = new Readable({
      read() {
        /* Keep the response pending until cancellation. */
      }
    }) as IncomingMessage
    body.statusCode = 200
    body.headers = { 'content-type': 'text/plain' }
    const f = fixture([body])
    const controller = new AbortController()
    const reading = f.transport('https://public.example/', controller.signal)
    await vi.waitFor(() => expect(f.calls).toHaveLength(1))
    controller.abort(new Error('cancel body'))
    await expect(reading).rejects.toThrow('cancel body')
    expect(body.destroyed).toBe(true)
  })
  it('limits a domain to two connections and cancels the queued third request', async () => {
    const responses = Array.from({ length: 2 }, () => {
      const body = new Readable({
        read() {
          /* Keep the response pending until cancellation. */
        }
      }) as IncomingMessage
      body.statusCode = 200
      body.headers = { 'content-type': 'text/plain' }
      return body
    })
    const f = fixture(responses)
    const controllers = Array.from({ length: 3 }, () => new AbortController())
    const work = controllers.map((controller) =>
      f.transport('https://concurrency.example/', controller.signal).catch((error) => error)
    )
    await vi.waitFor(() => expect(f.calls).toHaveLength(2))
    controllers[2].abort(new Error('queue cancelled'))
    expect(await work[2]).toMatchObject({ message: 'queue cancelled' })
    controllers[0].abort()
    controllers[1].abort()
    await Promise.all(work)
    expect(f.calls).toHaveLength(2)
  })
  it('transfers a semaphore slot exactly once when a waiter is cancelled', async () => {
    const slot = new WebSemaphore(1)
    const controller = new AbortController()
    const release = await slot.acquire(new AbortController().signal)
    const waiting = slot.acquire(controller.signal)
    controller.abort()
    await expect(waiting).rejects.toThrow()
    release()
    release()
    const next = await slot.acquire(new AbortController().signal)
    next()
  })
})
