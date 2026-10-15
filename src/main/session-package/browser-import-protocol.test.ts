import { expect, it, vi } from 'vitest'
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

it('routes cold-start arguments and running-app URL events to display only', () => {
  const relay = new BrowserImportLaunchRelay()
  const imported = vi.fn()
  const opened = vi.fn()
  relay.receiveArgv(['app', 'open-science://open', 'open-science://open'])
  relay.bind(imported, opened)
  expect(opened).toHaveBeenCalledTimes(1)
  expect(imported).not.toHaveBeenCalled()
  const event = { preventDefault: vi.fn() }
  relay.receiveOpenUrl(event, 'open-science://open/')
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(opened).toHaveBeenCalledTimes(2)
  // Second-instance arguments use the same dispatcher as cold-start arguments.
  relay.receiveArgv(['app', 'open-science://open'])
  expect(opened).toHaveBeenCalledTimes(3)
  expect(imported).not.toHaveBeenCalled()
  expect(parseBrowserImportUrl('open-science://open')).toBeNull()
})

it.each([
  'open-science://open?url=https://example.com/package.science',
  'open-science://open#secret',
  'open-science://open/import',
  'open-science://user@open',
  'open-science://open:49152',
  'https://open',
  '/tmp/local.science'
])('does not route an invalid pure launch: %s', (url) => {
  const relay = new BrowserImportLaunchRelay()
  const event = { preventDefault: vi.fn() }
  const imported = vi.fn()
  const opened = vi.fn()
  relay.bind(imported, opened)
  relay.receiveOpenUrl(event, url)
  expect(event.preventDefault).not.toHaveBeenCalled()
  expect(imported).not.toHaveBeenCalled()
  expect(opened).not.toHaveBeenCalled()
})
