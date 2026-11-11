import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { beforeEach, expect, it, vi } from 'vitest'
import { readSourceLinkImage, readSourceLinkMetadata } from './source-link-metadata'

const { get, lookup, resolveProxy, tunnelThroughProxy } = vi.hoisted(() => ({
  get: vi.fn(),
  lookup: vi.fn(),
  resolveProxy: vi.fn(),
  tunnelThroughProxy: vi.fn()
}))
vi.mock('../runtime-network', () => ({ runtimeNetwork: () => ({ resolveProxy }) }))
vi.mock('@aipoch/notebook-network-sandbox', () => ({ tunnelThroughProxy }))
vi.mock('node:https', () => ({ get }))
vi.mock('node:dns/promises', () => ({ lookup }))

const page = 'https://paper.example/study'
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
  'base64'
)

function reply(body: string, headers: Record<string, string>, statusCode = 200): void {
  get.mockImplementationOnce((_url, _options, resolve) => {
    resolve(Object.assign(Readable.from([Buffer.from(body)]), { headers, statusCode }))
    return new EventEmitter()
  })
}
beforeEach(() => {
  get.mockReset()
  lookup.mockReset().mockResolvedValue([{ address: '1.1.1.1', family: 4 }])
  resolveProxy.mockReset().mockResolvedValue('DIRECT')
  tunnelThroughProxy.mockReset()
})

it('returns text before fetching artwork and tolerates a failed image redirect', async () => {
  reply(
    '<title>Old title</title><meta content="Study &amp; results" property="og:title"><meta name="description" content="A summary"><meta property="og:image" content="/cover.png">',
    { 'content-type': 'text/html' }
  )
  reply('', { location: 'https://tracking.example/image' }, 302)
  reply('', { 'content-type': 'text/plain' }, 404)
  await expect(readSourceLinkMetadata(page)).resolves.toEqual({
    title: 'Study & results',
    description: 'A summary',
    imageUrl: 'https://paper.example/cover.png'
  })
  expect(get).toHaveBeenCalledTimes(1)
  await expect(readSourceLinkImage('https://paper.example/cover.png')).resolves.toBeUndefined()
  expect(get).toHaveBeenCalledTimes(3)
  expect(get.mock.calls[1][0].href).toBe('https://paper.example/cover.png')
})

it('reads unknown public HTTPS destinations and rejects mixed public/private DNS before connecting', async () => {
  reply('<title>Public page</title>', { 'content-type': 'text/html' })
  await expect(readSourceLinkMetadata('https://tracking.example')).resolves.toEqual({
    title: 'Public page'
  })
  expect(get).toHaveBeenCalledTimes(1)
  get.mockReset()
  lookup.mockResolvedValue([
    { address: '1.1.1.1', family: 4 },
    { address: '127.0.0.1', family: 4 }
  ])
  await expect(readSourceLinkMetadata(page)).resolves.toEqual({})
  expect(get).not.toHaveBeenCalled()
})

it('identifies page and artwork requests to servers that require a User-Agent', async () => {
  reply('<title>Public page</title><meta property="og:image" content="/cover.png">', {
    'content-type': 'text/html'
  })
  get.mockImplementationOnce((_url, options, resolve) => {
    const identified = options.headers['User-Agent'] === 'Open-Science/1.0'
    resolve(
      Object.assign(Readable.from([identified ? png : Buffer.from('Forbidden')]), {
        statusCode: identified ? 200 : 403,
        headers: { 'content-type': identified ? 'image/png' : 'text/html' }
      })
    )
    return new EventEmitter()
  })
  await expect(readSourceLinkMetadata(page)).resolves.toMatchObject({
    title: 'Public page',
    imageUrl: 'https://paper.example/cover.png'
  })
  await expect(readSourceLinkImage('https://paper.example/cover.png')).resolves.toBe(
    `data:image/png;base64,${png.toString('base64')}`
  )
  expect(get.mock.calls[0][1].headers['User-Agent']).toBe('Open-Science/1.0')
})

it('queues metadata and artwork in arrival order and releases slots after success, failure and timeout', async () => {
  const gates = Array.from({ length: 7 }, () => Promise.withResolvers<string>())
  const controllers: AbortController[] = []
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const controller = new AbortController()
    controllers.push(controller)
    return controller.signal
  })
  resolveProxy.mockImplementation(() => gates[resolveProxy.mock.calls.length - 1].promise)
  get.mockImplementation((url, _options, resolve) => {
    const image = url.pathname.endsWith('.png')
    resolve(
      Object.assign(Readable.from([image ? png : Buffer.from('<title>Queued page</title>')]), {
        statusCode: 200,
        headers: { 'content-type': image ? 'image/png' : 'text/html' }
      })
    )
    return new EventEmitter()
  })
  const requests = Array.from({ length: 4 }, (_, index) =>
    readSourceLinkMetadata(`${page}/${index}`)
  )
  const firstImage = readSourceLinkImage('https://paper.example/first.png')
  const queuedPage = readSourceLinkMetadata(`${page}/queued`)
  const lastImage = readSourceLinkImage('https://paper.example/last.png')
  const completed = vi.fn()
  void firstImage.then(completed)
  void queuedPage.then(completed)
  void lastImage.then(completed)
  try {
    await vi.waitFor(() => expect(resolveProxy).toHaveBeenCalledTimes(4))
    expect(completed).not.toHaveBeenCalled()
    expect(timeout).toHaveBeenCalledTimes(4)

    gates[0].resolve('DIRECT')
    await expect(requests[0]).resolves.toMatchObject({ title: 'Queued page' })
    await vi.waitFor(() => expect(resolveProxy).toHaveBeenCalledTimes(5))
    expect(resolveProxy.mock.calls[4][0]).toBe('https://paper.example/first.png')

    gates[1].reject(new Error('Proxy resolution failed'))
    await expect(requests[1]).resolves.toEqual({})
    await vi.waitFor(() => expect(resolveProxy).toHaveBeenCalledTimes(6))
    expect(resolveProxy.mock.calls[5][0]).toBe(`${page}/queued`)

    controllers[2].abort(new DOMException('Timed out', 'TimeoutError'))
    await expect(requests[2]).resolves.toEqual({})
    await vi.waitFor(() => expect(resolveProxy).toHaveBeenCalledTimes(7))
    expect(resolveProxy.mock.calls[6][0]).toBe('https://paper.example/last.png')
    expect(timeout.mock.calls).toEqual(Array.from({ length: 7 }, () => [8000]))

    for (const gate of gates) gate.resolve('DIRECT')
    await expect(queuedPage).resolves.toMatchObject({ title: 'Queued page' })
    for (const request of [firstImage, lastImage]) {
      await expect(request).resolves.toBe(`data:image/png;base64,${png.toString('base64')}`)
    }
  } finally {
    for (const gate of gates) gate.resolve('DIRECT')
    await Promise.all([...requests, firstImage, queuedPage, lastImage])
    timeout.mockRestore()
  }
})

it('delegates page, redirect and artwork DNS to the configured proxy', async () => {
  resolveProxy.mockResolvedValue('PROXY localhost:8123')
  lookup.mockRejectedValue(new Error('Local DNS unavailable'))
  tunnelThroughProxy.mockResolvedValue({ destroy: vi.fn() })
  reply('', { location: 'https://article.example/story' }, 302)
  reply(
    '<title>Public page</title><meta property="og:image" content="https://cdn.example/cover.png">',
    {
      'content-type': 'text/html'
    }
  )
  reply('', { 'content-type': 'text/plain' }, 404)

  await expect(readSourceLinkMetadata(page)).resolves.toMatchObject({ title: 'Public page' })
  await expect(readSourceLinkImage('https://cdn.example/cover.png')).resolves.toBeUndefined()
  expect(lookup).not.toHaveBeenCalled()
  expect(tunnelThroughProxy.mock.calls.map((call) => call[1])).toEqual([
    'paper.example',
    'article.example',
    'cdn.example'
  ])
})

it('rechecks direct destination addresses after a proxied redirect', async () => {
  resolveProxy.mockResolvedValueOnce('PROXY localhost:8123').mockResolvedValue('DIRECT')
  tunnelThroughProxy.mockResolvedValue({ destroy: vi.fn() })
  lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
  reply('', { location: 'https://internal.example/story' }, 302)

  await expect(readSourceLinkMetadata(page)).resolves.toEqual({})
  expect(tunnelThroughProxy).toHaveBeenCalledTimes(1)
  expect(lookup).toHaveBeenCalledExactlyOnceWith('internal.example', { all: true })
  expect(get).toHaveBeenCalledTimes(1)
})

it('retains validated local IPv4 resolution for SOCKS4 proxies', async () => {
  resolveProxy.mockResolvedValue('SOCKS4 localhost:8123')
  tunnelThroughProxy.mockResolvedValue({ destroy: vi.fn() })
  reply('<title>Public page</title>', { 'content-type': 'text/html' })

  await expect(readSourceLinkMetadata(page)).resolves.toMatchObject({ title: 'Public page' })
  expect(lookup).toHaveBeenCalledExactlyOnceWith('paper.example', { all: true })
  expect(tunnelThroughProxy).toHaveBeenCalledWith(
    new URL('socks4://localhost:8123'),
    '1.1.1.1',
    443,
    undefined,
    expect.any(AbortSignal)
  )
})

it('uses the configured proxy hostname and fails closed when the tunnel fails', async () => {
  resolveProxy.mockResolvedValue('PROXY localhost:8123; DIRECT')
  tunnelThroughProxy.mockRejectedValue(new Error('Proxy unavailable'))
  await expect(readSourceLinkMetadata(page)).resolves.toEqual({})
  expect(tunnelThroughProxy).toHaveBeenCalledWith(
    new URL('http://localhost:8123'),
    'paper.example',
    443,
    undefined,
    expect.any(AbortSignal)
  )
  expect(lookup).not.toHaveBeenCalled()
  expect(get).not.toHaveBeenCalled()
})

it.each([
  'http://paper.example/cover.png',
  'https://127.0.0.1/cover.png',
  'https://paper.example:444/cover.png'
])('rejects unsupported artwork destination %s before connecting', async (url) => {
  await expect(readSourceLinkImage(url)).resolves.toBeUndefined()
  expect(get).not.toHaveBeenCalled()
})

it('validates image redirect DNS independently of the metadata request', async () => {
  lookup
    .mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }])
    .mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
  reply('', { location: 'https://internal.example/image.png' }, 302)
  await expect(readSourceLinkImage('https://cdn.example/cover.png')).resolves.toBeUndefined()
  expect(get).toHaveBeenCalledTimes(1)
})
