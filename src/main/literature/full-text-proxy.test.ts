import { Readable } from 'node:stream'
import { beforeEach, expect, it, vi } from 'vitest'
import { downloadFullText } from './full-text-download'

const fixture = vi.hoisted(() => ({
  lookup: vi.fn(),
  tunnel: vi.fn(),
  tls: vi.fn(),
  requests: vi.fn(),
  status: 200,
  location: '',
  blockEuropeRender: false
}))
vi.mock('node:dns/promises', () => ({ lookup: fixture.lookup }))
vi.mock('@aipoch/notebook-network-sandbox', () => ({ tunnelThroughProxy: fixture.tunnel }))
vi.mock('node:tls', () => ({ connect: fixture.tls }))
vi.mock('node:https', async (original) => ({
  ...(await original<typeof import('node:https')>()),
  get: (
    url: URL,
    options: { agent?: import('node:https').Agent },
    callback: (response: Readable) => void
  ) => {
    fixture.requests(url.href, options)
    let reject: (error: Error) => void = () => {}
    queueMicrotask(() => {
      options.agent!.createConnection({}, (error) => {
        if (error) return reject(error)
        callback(
          Object.assign(Readable.from([Buffer.from('%PDF-test')]), {
            statusCode:
              fixture.blockEuropeRender && url.pathname.startsWith('/articles/')
                ? 403
                : fixture.status,
            headers: fixture.location ? { location: fixture.location } : {}
          })
        )
      })
    })
    return {
      on: (_event: string, handler: (error: Error) => void) => {
        reject = handler
      }
    }
  }
}))

beforeEach(() => {
  vi.resetAllMocks()
  fixture.status = 200
  fixture.location = ''
  fixture.blockEuropeRender = false
  fixture.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
  fixture.tunnel.mockResolvedValue({ pinned: true })
  fixture.tls.mockReturnValue({ encrypted: true })
})

it.each([
  'https://europepmc.org/articles/PMC2830465?pdf=render',
  'https://www.europepmc.org/articles/PMC2830465/?pdf=render'
])(
  'downloads the official PDF when the Europe PMC article route is challenged: %s',
  async (url) => {
    fixture.blockEuropeRender = true
    const proxy = vi.fn(async () => 'http://127.0.0.1:1086')
    await expect(downloadFullText(url, 100, undefined, proxy)).resolves.toEqual(
      Buffer.from('%PDF-test')
    )
    const pdf = 'https://europepmc.org/api/getPdf?pmcid=PMC2830465'
    expect(proxy).toHaveBeenCalledWith(pdf)
    expect(fixture.requests).toHaveBeenCalledTimes(1)
    expect(fixture.requests.mock.calls[0][0]).toBe(pdf)
    expect(fixture.tls).toHaveBeenCalledWith(
      expect.objectContaining({ servername: 'europepmc.org' })
    )
  }
)

it.each([
  'https://europepmc.org/articles/PMC2830465',
  'https://europepmc.org/articles/PMC2830465?pdf=preview',
  'https://europepmc.org/articles/not-a-pmcid?pdf=render',
  'https://europepmc.org/articles/PMC2830465/supplement?pdf=render',
  'https://europepmc.org/api/getPdf?pmcid=PMC2830465',
  'https://europepmc.org.example/articles/PMC2830465?pdf=render'
])('preserves links outside the legacy Europe PMC PDF route: %s', async (url) => {
  await downloadFullText(url, 100, undefined, async () => 'http://127.0.0.1:1086')
  expect(fixture.requests.mock.calls[0][0]).toBe(url)
})

it('uses the official PDF API after a validated redirect to the legacy article route', async () => {
  fixture.status = 302
  fixture.location = 'https://europepmc.org/articles/PMC2830465?pdf=render'
  fixture.blockEuropeRender = true
  fixture.requests
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      fixture.status = 200
      fixture.location = ''
    })
  await expect(
    downloadFullText(
      'https://journal.example/paper.pdf',
      100,
      undefined,
      async () => 'http://127.0.0.1:1086'
    )
  ).resolves.toEqual(Buffer.from('%PDF-test'))
  expect(fixture.requests.mock.calls.map(([url]) => url)).toEqual([
    'https://journal.example/paper.pdf',
    'https://europepmc.org/api/getPdf?pmcid=PMC2830465'
  ])
  expect(fixture.lookup).toHaveBeenCalledTimes(2)
  expect(fixture.tunnel).toHaveBeenCalledTimes(2)
})

it.each(['http', 'https', 'socks4', 'socks5'])(
  'pins the public destination through a %s proxy while authenticating the publisher',
  async (protocol) => {
    const proxy = vi.fn(async () => `${protocol}://127.0.0.1:1086`)
    await expect(
      downloadFullText('https://journal.example/paper.pdf', 100, undefined, proxy)
    ).resolves.toEqual(Buffer.from('%PDF-test'))
    expect(proxy).toHaveBeenCalledWith('https://journal.example/paper.pdf')
    expect(fixture.tunnel).toHaveBeenCalledWith(
      new URL(`${protocol}://127.0.0.1:1086`),
      '8.8.8.8',
      443,
      undefined,
      expect.any(AbortSignal)
    )
    expect(fixture.tls).toHaveBeenCalledWith(
      expect.objectContaining({ servername: 'journal.example', socket: { pinned: true } })
    )
    expect(fixture.requests.mock.calls[0][1].headers).toEqual({
      Accept: 'application/pdf',
      'User-Agent': 'Open-Science/1.0'
    })
  }
)

it.each([
  'https://journal.example/paper.pdf',
  'https://europepmc.org/articles/PMC2830465?pdf=render'
])('refuses private or mixed DNS answers before opening any proxy tunnel: %s', async (url) => {
  fixture.lookup.mockResolvedValue([
    { address: '8.8.8.8', family: 4 },
    { address: '127.0.0.1', family: 4 }
  ])
  await expect(
    downloadFullText(url, 100, undefined, async () => 'http://127.0.0.1:1086')
  ).rejects.toThrow('public address')
  expect(fixture.tunnel).not.toHaveBeenCalled()
})

it('resolves proxy and validates DNS again after a redirect', async () => {
  fixture.status = 302
  fixture.location = 'https://redirect.example/paper.pdf'
  fixture.lookup
    .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
    .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }])
  const resolve = vi.fn(async () => 'http://127.0.0.1:1086')
  await expect(
    downloadFullText('https://journal.example/paper.pdf', 100, undefined, resolve)
  ).rejects.toThrow('public address')
  expect(resolve.mock.calls).toEqual([
    ['https://journal.example/paper.pdf'],
    ['https://redirect.example/paper.pdf']
  ])
  expect(fixture.tunnel).toHaveBeenCalledTimes(1)
})
