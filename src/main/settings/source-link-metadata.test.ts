import { EventEmitter } from 'node:events'
import type { LookupFunction } from 'node:net'
import { Readable } from 'node:stream'
import { beforeEach, expect, it, vi } from 'vitest'
import { readSourceLinkMetadata } from './source-link-metadata'

const { get, lookup } = vi.hoisted(() => ({ get: vi.fn(), lookup: vi.fn() }))
vi.mock('node:https', () => ({ get }))
vi.mock('node:dns/promises', () => ({ lookup }))

const settings = {
  allowedDomains: ['paper.example'],
  disabledOpenScienceDomains: [],
  disabledOpenScienceDomainGroups: []
}
const page = 'https://paper.example/study'

function reply(body: string, headers: Record<string, string>, statusCode = 200): void {
  get.mockImplementationOnce((_url, _options, resolve) => {
    resolve(Object.assign(Readable.from([Buffer.from(body)]), { headers, statusCode }))
    return new EventEmitter()
  })
}
beforeEach(() => {
  get.mockReset()
  lookup.mockReset()
})

it('extracts head metadata and keeps text when artwork redirects outside policy', async () => {
  reply(
    '<title>Old title</title><meta content="Study &amp; results" property="og:title"><meta name="description" content="A summary"><meta property="og:image" content="/cover.png">',
    { 'content-type': 'text/html' }
  )
  reply('', { location: 'https://tracking.example/image' }, 302)
  await expect(readSourceLinkMetadata(page, settings)).resolves.toEqual({
    title: 'Study & results',
    description: 'A summary'
  })
  expect(get).toHaveBeenCalledTimes(2)
  expect(get.mock.calls[1][0].href).toBe('https://paper.example/cover.png')
})

it('rejects disallowed destinations and mixed public/private DNS before connecting', async () => {
  await expect(readSourceLinkMetadata('https://tracking.example', settings)).resolves.toEqual({})
  expect(get).not.toHaveBeenCalled()
  lookup.mockResolvedValue([
    { address: '1.1.1.1', family: 4 },
    { address: '127.0.0.1', family: 4 }
  ])
  const resolved = vi.fn()
  get.mockImplementationOnce((_url, options: { lookup: LookupFunction }) => {
    const request = new EventEmitter()
    options.lookup('paper.example', {}, (error, address) => {
      resolved(error, address)
      request.emit('error', error)
    })
    return request
  })
  await expect(readSourceLinkMetadata(page, settings)).resolves.toEqual({})
  expect(resolved).toHaveBeenCalledWith(expect.any(Error), '')
})
