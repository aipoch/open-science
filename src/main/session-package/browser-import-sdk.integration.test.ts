import { createServer } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { BrowserPackageImport } from './browser-import'
import type { BrowserImportTransfer } from '../../../packages/open-science/browser-import'
// @ts-expect-error The published ESM entry uses a sibling browser-import.d.ts.
import { prepareBrowserImport } from '../../../packages/open-science/browser-import.mjs'

afterEach(() => vi.unstubAllGlobals())

it('transfers a browser-held Blob over authenticated HTTP without any remote download', async () => {
  const probe = createServer()
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject)
        probe.listen(49152 + Math.floor(Math.random() * 16384), '127.0.0.1', resolve)
      })
      probe.removeAllListeners('error')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    }
  }
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  const origin = 'https://research.example'
  const root = await mkdtemp(join(tmpdir(), 'browser-sdk-'))
  let received: string | undefined
  const bridge = new BrowserPackageImport({
    root,
    confirm: async () => true,
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
    const bytes = new Uint8Array(4 * 1024 ** 2 + 17).fill(73)
    const transfer: BrowserImportTransfer = prepareBrowserImport(new Blob([bytes]), {
      filename: 'study.science',
      origin,
      port
    })
    await bridge.begin(transfer.url)
    const progress: number[] = []
    expect(
      await transfer.send({ onProgress: ({ sentBytes }) => progress.push(sentBytes) })
    ).toEqual({ received: true })
    expect((await readFile(received!)).equals(Buffer.from(bytes))).toBe(true)
    expect(progress.at(-1)).toBe(bytes.length)
    expect(destinations.every((url) => url.startsWith(`http://127.0.0.1:${port}/`))).toBe(true)
  } finally {
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  }
})
