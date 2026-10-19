import { findBrowserImportPort } from './test-helpers/browser-import-port'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { BrowserPackageImport } from './browser-import'
import type { BrowserImportTransfer } from '../../../packages/open-science/browser-import'
// @ts-expect-error The published ESM entry uses a sibling browser-import.d.ts.
import * as browserSdk from '../../../packages/open-science/browser-import.mjs'
const { checkBrowserImportAvailability, prepareBrowserImport } = browserSdk

afterEach(() => vi.unstubAllGlobals())

it('transfers a browser-held Blob over authenticated HTTP without any remote download', async () => {
  const port = await findBrowserImportPort()
  const origin = 'https://research.example'
  const root = await mkdtemp(join(tmpdir(), 'browser-sdk-'))
  let received: string | undefined
  const bridge = new BrowserPackageImport({
    root,
    receive: (path) => {
      received = path
    }
  })
  const realFetch = globalThis.fetch
  const destinations: string[] = []
  // Node does not synthesize the browser's Origin header; all network operations still use HTTP.
  vi.stubGlobal('fetch', (input: string, init: RequestInit) => {
    destinations.push(String(input))
    return realFetch(input, { ...init, headers: { ...init.headers, Origin: origin } })
  })
  try {
    const discoveryPort = await findBrowserImportPort()
    await bridge.startDiscovery(discoveryPort)
    expect(await checkBrowserImportAvailability({ origin, port: discoveryPort })).toEqual({
      status: 'available'
    })
    const bytes = new Uint8Array(4 * 1024 ** 2 + 17).fill(73)
    const transfer: BrowserImportTransfer = prepareBrowserImport(new Blob([bytes]), {
      filename: 'study.science',
      origin,
      port
    })
    await bridge.begin(transfer.url)
    const progress: number[] = []
    const events: string[] = []
    expect(
      await transfer.send({
        readinessMode: 'wait-for-launch',
        onPhase: (phase) => events.push(phase),
        onProgress: ({ sentBytes }) => {
          events.push('progress')
          progress.push(sentBytes)
        }
      })
    ).toEqual({ received: true })
    expect((await readFile(received!)).equals(Buffer.from(bytes))).toBe(true)
    expect(progress.at(-1)).toBe(bytes.length)
    expect(events).toEqual(['waiting-for-receiver', 'transferring', 'progress', 'progress'])
    const count = destinations.length
    await expect(
      transfer.send({
        onPhase: () => {
          throw new Error('Cached receipt must not announce a new transfer')
        }
      })
    ).resolves.toEqual({ received: true })
    expect(destinations).toHaveLength(count)
    expect(
      destinations.every(
        (url) =>
          url.startsWith(`http://127.0.0.1:${port}/`) ||
          url.startsWith(`http://127.0.0.1:${discoveryPort}/`)
      )
    ).toBe(true)
  } finally {
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('resumes a lost chunk acknowledgment with the same transfer and receives exactly once', async () => {
  const port = await findBrowserImportPort()
  const origin = 'https://research.example'
  const root = await mkdtemp(join(tmpdir(), 'browser-sdk-resume-'))
  const received: string[] = []
  const bridge = new BrowserPackageImport({
    root,
    receive: (path) => {
      received.push(path)
    }
  })
  const realFetch = globalThis.fetch
  let loseResponse = true
  const offsets: string[] = []
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    const response = await realFetch(input, {
      ...init,
      headers: { ...init.headers, Origin: origin }
    })
    if (init.method === 'PUT') {
      offsets.push(new URL(input).searchParams.get('offset')!)
      if (loseResponse) {
        loseResponse = false
        await response.arrayBuffer()
        throw new TypeError('Connection lost after the receiver saved this chunk')
      }
    }
    return response
  })
  try {
    const bytes = new Uint8Array(4 * 1024 ** 2 + 17).fill(42)
    const transfer: BrowserImportTransfer = prepareBrowserImport(new Blob([bytes]), {
      filename: 'study.science',
      origin,
      port
    })
    await bridge.begin(transfer.url)
    await expect(transfer.send()).rejects.toMatchObject({ code: 'transfer-failed' })
    expect(received).toEqual([])
    await expect(transfer.send()).resolves.toEqual({ received: true })
    expect(offsets).toEqual(['0', '4194304'])
    expect(received).toHaveLength(1)
    expect(await readFile(received[0])).toEqual(Buffer.from(bytes))
  } finally {
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['waiting', 'receiving'] as const)(
  'delivers authenticated desktop cancellation while %s and never retries it',
  async (stage) => {
    const port = await findBrowserImportPort()
    const origin = 'https://research.example'
    const root = await mkdtemp(join(tmpdir(), 'browser-sdk-cancel-'))
    const received: string[] = []
    const bridge = new BrowserPackageImport({
      root,
      receive: (path) => {
        received.push(path)
      }
    })
    const realFetch = globalThis.fetch
    const destinations: string[] = []
    vi.stubGlobal('fetch', (input: string, init: RequestInit) => {
      destinations.push(input)
      return realFetch(input, { ...init, headers: { ...init.headers, Origin: origin } })
    })
    let cancellation: Promise<void> | undefined
    try {
      const transfer: BrowserImportTransfer = prepareBrowserImport(
        new Blob([new Uint8Array(4194305)]),
        { filename: 'study.science', origin, port }
      )
      await bridge.begin(transfer.url)
      const id = bridge.snapshot[0].id
      if (stage === 'waiting') await bridge.cancel(id)
      await expect(
        transfer.send({
          readinessMode: 'wait-for-launch',
          onProgress: () => {
            cancellation ??= bridge.cancel(id)
          }
        })
      ).rejects.toMatchObject({ code: 'cancelled' })
      await cancellation
      const count = destinations.length
      await expect(transfer.send()).rejects.toMatchObject({ code: 'cancelled' })
      expect(destinations).toHaveLength(count)
      expect(received).toEqual([])
      expect(await (await import('node:fs/promises')).readdir(root)).toEqual([])
    } finally {
      await cancellation
      await bridge.close()
      await rm(root, { recursive: true, force: true })
    }
  }
)
