import { expect, it } from 'vitest'
import { BrowserImportLaunchRelay } from './browser-import-protocol'

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
