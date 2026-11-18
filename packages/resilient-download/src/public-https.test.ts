import { Readable } from 'node:stream'
import { beforeEach, expect, it, vi } from 'vitest'
import { isPublicDownloadAddress, publicDownloadUrl, requestPublicHttps } from './public-https'

const fixture = vi.hoisted(() => ({ lookup: vi.fn(), get: vi.fn(), tls: vi.fn(), tunnel: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: fixture.lookup }))
vi.mock('node:tls', () => ({ connect: fixture.tls }))
vi.mock('node:https', async (original) => ({
  ...(await original<typeof import('node:https')>()),
  get: fixture.get
}))
beforeEach(() => {
  vi.resetAllMocks()
  fixture.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
  fixture.get.mockImplementation((_url, options, callback) => {
    let reject: (error: Error) => void = () => {}
    queueMicrotask(() => {
      const done = (error: Error | null): void => {
        if (error) reject(error)
        else callback(Object.assign(Readable.from(['image']), { statusCode: 200, headers: {} }))
      }
      if (options.agent) options.agent.createConnection({}, done)
      else options.lookup('cdn.example', {}, done)
    })
    return {
      on: (_name: string, handler: (error: Error) => void): void => {
        reject = handler
      }
    }
  })
})

it('rejects private URL forms before connecting and pins public DNS without credentials', async () => {
  for (const url of [
    'http://cdn.example/x',
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'https://user:pass@cdn.example/x',
    'https://cdn.local/x',
    'https://cdn.internal./x',
    'https://localhost./x',
    'https://cdn.example../x',
    'https://cdn.example:8443/x'
  ]) {
    expect(() => publicDownloadUrl(url)).toThrow()
  }
  const response = await requestPublicHttps('https://cdn.example/x', new AbortController().signal)
  expect(fixture.lookup).toHaveBeenCalledWith('cdn.example', { all: true })
  expect(fixture.get.mock.calls[0][1].headers).toEqual({
    Accept: '*/*',
    'User-Agent': 'Open-Science/1.0'
  })
  response.destroy()
  for (const address of ['127.0.0.1', '10.0.0.1', '::1', '::ffff:127.0.0.1', '169.254.169.254'])
    expect(isPublicDownloadAddress(address)).toBe(false)
})

it('fails closed for mixed or private DNS answers on direct and proxy paths', async () => {
  for (const proxy of [false, true]) {
    for (const addresses of [
      [{ address: '127.0.0.1', family: 4 }],
      [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.1', family: 4 }
      ]
    ]) {
      fixture.lookup.mockResolvedValue(addresses)
      await expect(
        requestPublicHttps(
          'https://cdn.example/x',
          new AbortController().signal,
          proxy ? { resolveProxy: async () => 'http://localhost:1086', tunnel: fixture.tunnel } : {}
        )
      ).rejects.toThrow('public address')
    }
  }
  expect(fixture.tunnel).not.toHaveBeenCalled()
})

it('requires explicit legacy opt-in for fake-IP proxy resolution', async () => {
  fixture.lookup.mockResolvedValue([{ address: '198.18.0.5', family: 4 }])
  const options = {
    resolveProxy: async (): Promise<string> => 'http://localhost:1086',
    tunnel: fixture.tunnel
  }
  await expect(
    requestPublicHttps('https://cdn.example/x', new AbortController().signal, options)
  ).rejects.toThrow('public address')
  expect(fixture.tunnel).not.toHaveBeenCalled()
  fixture.tunnel.mockResolvedValue({ destroy: vi.fn() })
  fixture.tls.mockReturnValue({})
  const response = await requestPublicHttps(
    'https://cdn.example./x',
    new AbortController().signal,
    {
      ...options,
      allowProxyHostnameResolution: true
    }
  )
  expect(fixture.lookup).toHaveBeenLastCalledWith('cdn.example', { all: true })
  expect(fixture.tls).toHaveBeenCalledWith(expect.objectContaining({ servername: 'cdn.example' }))
  expect(fixture.tunnel).toHaveBeenCalledWith(
    new URL('http://localhost:1086'),
    'cdn.example',
    443,
    expect.any(AbortSignal)
  )
  response.destroy()
})
