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
  relay.bind((request) => {
    delivered.push(request)
  })
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

const launchUrl =
  'open-science://import?' +
  new URLSearchParams({
    version: '1',
    origin: 'https://example.com',
    secret: 'cd'.repeat(32),
    port: '49232',
    name: 'early.science',
    size: '100'
  })

it.each(['reject', 'startup'] as const)(
  'reclaims failed %s requests without evicting active launches',
  async (mode) => {
    const relay = new BrowserImportLaunchRelay()
    const active = launchUrl.replace('early.science', 'active.science')
    relay.receive(active)
    if (mode === 'reject')
      relay.bind((url) =>
        url === active ? new Promise<void>(() => undefined) : Promise.reject(new Error('Failed'))
      )
    for (let i = 1; i <= 20; i++) {
      const url = launchUrl.replace('cd'.repeat(32), i.toString(16).padStart(64, '0'))
      relay.receive(url)
      if (mode === 'startup') relay.failPending()
      await Promise.resolve()
    }
    const fresh = launchUrl
      .replace('cd'.repeat(32), 'ef'.repeat(32))
      .replace('early.science', 'fresh.science')
    relay.receive(fresh)
    expect(relay.snapshot?.browserTransfers).toContainEqual(
      expect.objectContaining({ filename: 'fresh.science' })
    )
    if (mode === 'reject')
      expect(relay.snapshot?.browserTransfers).toContainEqual(
        expect.objectContaining({ filename: 'active.science', state: 'preparing' })
      )
  }
)

it('replays safe preparing metadata for cold arguments before a backend exists', () => {
  const relay = new BrowserImportLaunchRelay()
  relay.receiveArgv(['app', launchUrl, launchUrl])
  expect(relay.snapshot?.browserTransfers).toEqual([
    expect.objectContaining({
      filename: 'early.science',
      state: 'preparing',
      completedBytes: 0,
      totalBytes: 100
    })
  ])
  expect(JSON.stringify(relay.snapshot)).not.toContain('cd'.repeat(32))
  expect(JSON.stringify(relay.snapshot)).not.toContain('https://example.com')
  relay.receive('open-science://open')
  expect(relay.snapshot?.browserTransfers).toHaveLength(1)
})

it('hands off once to the latest receiver/validation snapshot even before the UI mounts', async () => {
  const relay = new BrowserImportLaunchRelay()
  let finish!: () => void
  relay.bind(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  relay.receiveOpenUrl({ preventDefault: vi.fn() }, launchUrl)
  const transfer = relay.snapshot!.browserTransfers![0]
  relay.update({
    id: 'receipt',
    kind: 'import',
    state: 'running',
    browserReceiptOnly: true,
    progress: { phase: 'preparing' },
    browserTransfers: [{ ...transfer, state: 'receiving', completedBytes: 60 }]
  })
  expect(relay.snapshot?.browserTransfers).toHaveLength(1)
  relay.update({
    id: 'import',
    kind: 'import',
    state: 'running',
    progress: { phase: 'validating' },
    browserTransfers: []
  })
  finish()
  await Promise.resolve()
  await Promise.resolve()
  expect(relay.snapshot).toMatchObject({
    id: 'import',
    progress: { phase: 'validating' },
    browserTransfers: []
  })
})

it('preserves a visible startup failure and forwards early cancellation when the receiver starts', async () => {
  const relay = new BrowserImportLaunchRelay()
  relay.receive(launchUrl)
  relay.failPending()
  expect(relay.snapshot?.browserTransfers?.[0].state).toBe('failed')
  const id = relay.snapshot!.browserTransfers![0].id
  await relay.cancel(id)
  expect(relay.snapshot?.browserTransfers?.[0].state).toBe('cancelled')
  expect(relay.snapshot?.state).toBe('cancelled')
  const begin = vi.fn(async () => undefined)
  const cancel = vi.fn(async () => undefined)
  relay.bind(begin, undefined, cancel)
  await Promise.resolve()
  await Promise.resolve()
  expect(begin).toHaveBeenCalledWith(launchUrl, true)
  expect(cancel).not.toHaveBeenCalled() // Cancellation is atomic with initial admission.
})

it('keeps early cancellation when an already-running backend reports the same transfer before bind', async () => {
  const relay = new BrowserImportLaunchRelay()
  relay.receive(launchUrl)
  const transfer = relay.snapshot!.browserTransfers![0]
  await relay.cancel(transfer.id)
  relay.update({
    id: 'existing',
    kind: 'import',
    state: 'running',
    browserReceiptOnly: true,
    progress: { phase: 'preparing' },
    browserTransfers: [{ ...transfer, state: 'receiving', completedBytes: 3 }]
  })
  const begin = vi.fn(async () => undefined)
  relay.bind(begin)
  await Promise.resolve()
  expect(begin).toHaveBeenCalledWith(launchUrl, true)
})

it('allows an explicit relaunch after receiver startup failed without duplicating in-flight work', async () => {
  const relay = new BrowserImportLaunchRelay()
  const begin = vi
    .fn()
    .mockRejectedValueOnce(new Error('Receiver unavailable'))
    .mockResolvedValue(undefined)
  relay.bind(begin)
  relay.receive(launchUrl)
  relay.receive(launchUrl)
  expect(begin).toHaveBeenCalledOnce()
  await Promise.resolve()
  expect(relay.snapshot?.browserTransfers?.[0].state).toBe('failed')
  relay.receive(launchUrl)
  expect(begin).toHaveBeenCalledTimes(2)
})
