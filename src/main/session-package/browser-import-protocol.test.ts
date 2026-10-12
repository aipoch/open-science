import { expect, it } from 'vitest'
import { BrowserImportLaunchRelay, parseBrowserImportUrl } from './browser-import-protocol'

it.each([
  ['研'.repeat(100) + '.science', false],
  ['研'.repeat(82) + '.science', true],
  ['研'.repeat(83) + '.science', false],
  ['CON.science', false],
  ['aux.notes.science', false],
  ['COM1.science', false],
  ['COM¹.science', false],
  ['lpt9.science', false],
  ['com10.science', true],
  ['研究.science', true]
])('checks portable storage for filename %s', (name, accepted) => {
  const url =
    'open-science://import?' +
    new URLSearchParams({
      version: '1',
      origin: 'https://example.com',
      secret: 'ab'.repeat(32),
      port: '49231',
      name: String(name),
      size: '5'
    })
  expect(parseBrowserImportUrl(url) !== null).toBe(accepted)
})

it('keeps bounded cold-launch requests and forwards warm launches without treating files as URLs', () => {
  const relay = new BrowserImportLaunchRelay()
  const url =
    'open-science://import?' +
    new URLSearchParams({
      version: '1',
      origin: 'https://example.com',
      secret: 'ab'.repeat(32),
      port: '49231',
      name: 'study.science',
      size: '5'
    })
  const delivered: string[] = []
  expect(relay.receive('/tmp/local.science')).toBe(false)
  expect(relay.receive(url)).toBe(true)
  relay.receive(url)
  relay.bind((request) => delivered.push(request))
  expect(delivered).toEqual([url])
  relay.receive(url)
  expect(delivered).toEqual([url, url])
})
