import { createHmac } from 'node:crypto'
import { createServer } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { BrowserPackageImport } from '../../src/main/session-package/browser-import'
import { prepareBrowserImport } from './browser-import.mjs'

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
    const transfer = prepareBrowserImport(new Blob([bytes]), {
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

it('never sends bytes or credentials to an endpoint that cannot prove its identity', async () => {
  const requests: RequestInit[] = []
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    requests.push(init)
    return new Response(JSON.stringify({ proof: '00'.repeat(32), offset: 0, chunkBytes: 4194304 }))
  })
  const transfer = prepareBrowserImport(new Blob(['hello']), {
    filename: 'study.science',
    origin: 'https://research.example',
    port: 49232
  })
  await expect(transfer.send()).rejects.toThrow(/identity/i)
  expect(requests).toHaveLength(1)
  expect(new Headers(requests[0].headers).has('Authorization')).toBe(false)
  expect(requests[0].body).toBeUndefined()
})

it('rejects empty packages, unsafe filenames and insecure public websites before launch', () => {
  for (const [file, options] of [
    [new Blob(), { filename: 'study.science', origin: 'https://research.example' }],
    [new Blob(['hi']), { filename: '../study.science', origin: 'https://research.example' }],
    [new Blob(['hi']), { filename: 'study.science', origin: 'http://research.example' }]
  ] as const)
    expect(() => prepareBrowserImport(file, options)).toThrow()
})

it('keeps bytes and the secret private if the listener is replaced after a valid handshake', async () => {
  const transfer = prepareBrowserImport(new Blob(['private research']), {
    filename: 'study.science',
    origin: 'https://research.example',
    port: 49232
  })
  const secret = new URL(transfer.url).searchParams.get('secret')!
  const requests: RequestInit[] = []
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    requests.push(init)
    if (requests.length === 1) {
      const challenge = new URL(input).searchParams.get('challenge')
      const proof = createHmac('sha256', Buffer.from(secret, 'hex'))
        .update(`open-science-import-v1:${challenge}:0:0`)
        .digest('hex')
      return new Response(
        JSON.stringify({ proof, offset: 0, accepted: false, chunkBytes: 4194304 })
      )
    }
    return new Response(JSON.stringify({ offset: 16, proof: 'forged' }))
  })
  await expect(transfer.send()).rejects.toThrow(/offset/)
  expect(requests).toHaveLength(2)
  expect(new Headers(requests[1].headers).get('Authorization')).not.toContain(secret)
  expect(
    Buffer.from(requests[1].body as Uint8Array).includes(Buffer.from('private research'))
  ).toBe(false)
})
