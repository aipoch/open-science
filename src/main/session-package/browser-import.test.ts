/* eslint-disable @typescript-eslint/explicit-function-return-type -- Inferred types for test fixture helpers. */
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import { findBrowserImportPort } from './test-helpers/browser-import-port'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import fs from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserPackageImport, parseBrowserImportUrl } from './browser-import'

const secret = 'ab'.repeat(32)
const origin = 'https://research.example'
const launch = (port: number, size = 5) =>
  `open-science://import?${new URLSearchParams({ version: '1', origin, secret, port: String(port), name: 'study.science', size: String(size) })}`
const checksum = (value: string) => createHash('sha256').update(value).digest('hex')
const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})

async function setup(options: { idleMs?: number; receive?: () => Promise<boolean> } = {}) {
  const port = await findBrowserImportPort()
  const root = await mkdtemp(join(tmpdir(), 'browser-package-'))
  disposers.push(() => rm(root, { recursive: true, force: true }))
  const received: string[] = []
  const releases: (() => void)[] = []
  const bridge = new BrowserPackageImport({
    root,
    receive: (path, consumed) => {
      received.push(path)
      releases.push(consumed)
      return options.receive?.()
    },
    idleMs: options.idleMs
  })
  disposers.push(() => bridge.close())
  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    const signature = createHmac('sha256', Buffer.from(secret, 'hex'))
      .update(`${init.method ?? 'GET'}\n/v1/import${path}\n${headers.get('X-Chunk-SHA256') ?? ''}`)
      .digest('hex')
    if (!headers.has('Origin')) headers.set('Origin', origin)
    if (!headers.has('Authorization')) headers.set('Authorization', `HMAC ${signature}`)
    return fetch(`http://127.0.0.1:${port}/v1/import${path}`, { ...init, headers })
  }
  const chunk = (body: string, offset = 0, digest = checksum(body)) => {
    const iv = randomBytes(12)
    const key = createHash('sha256').update(`open-science-encryption-v1:${secret}`).digest()
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(`offset:${offset}`))
    const encrypted = Buffer.concat([iv, cipher.update(body), cipher.final(), cipher.getAuthTag()])
    return request(`/chunk?offset=${offset}`, {
      method: 'PUT',
      body: encrypted,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': digest }
    })
  }
  return { bridge, port, root, received, releases, request, chunk }
}

describe('browser-held research package handoff', () => {
  it('rejects remote sources, credentials, duplicate parameters, traversal and invalid origins', () => {
    expect(parseBrowserImportUrl(launch(49231))).toMatchObject({
      port: 49231,
      origin,
      name: 'study.science',
      size: 5
    })
    for (const url of [
      launch(49231) + '&url=https://example.com/study.science',
      launch(49231) + '&secret=' + secret,
      launch(49231).replace('study.science', '..%2Fstudy.science'),
      launch(49231).replace('https%3A', 'http%3A'),
      launch(80),
      launch(49231, 0),
      launch(49231).replace('://import', '://user@import'),
      launch(49231) + '#ignored'
    ])
      expect(parseBrowserImportUrl(url)).toBeNull()
  })

  it('proves receiver identity, stages ordered bytes and queues only a complete package once', async () => {
    const f = await setup()
    await f.bridge.begin(launch(f.port))
    const challenge = 'cd'.repeat(32)
    const ready = await f.request(`/ready?challenge=${challenge}`, {
      headers: { Authorization: '' }
    })
    expect(ready.headers.get('access-control-allow-origin')).toBe(origin)
    expect(await ready.json()).toMatchObject({
      proof: createHmac('sha256', Buffer.from(secret, 'hex'))
        .update(`open-science-import-v1:${challenge}:0:0`)
        .digest('hex'),
      offset: 0
    })
    expect((await f.chunk('he')).status).toBe(200)
    expect(f.received).toEqual([])
    expect((await f.request('/complete', { method: 'POST' })).status).toBe(409)
    expect((await f.chunk('llo', 2)).status).toBe(200)
    expect((await f.request('/complete', { method: 'POST' })).status).toBe(202)
    expect(await readFile(f.received[0], 'utf8')).toBe('hello')
    expect((await f.request('/complete', { method: 'POST' })).status).toBe(202)
    expect(f.received).toHaveLength(1)
    await f.bridge.close()
    expect(await readdir(f.root)).toEqual([])
  })

  it.each([true, false])(
    'coordinates cancellation with pending queue admission (accepted: %s)',
    async (accepted) => {
      let finishEnqueue!: (accepted: boolean) => void
      let entered!: () => void
      const enqueueing = new Promise<void>((resolve) => {
        entered = resolve
      })
      const queued = new Promise<boolean>((resolve) => {
        finishEnqueue = resolve
      })
      const f = await setup({
        receive: () => {
          entered()
          return queued
        }
      })
      await f.bridge.begin(launch(f.port))
      await f.chunk('hello')
      const completing = f.request('/complete', { method: 'POST' }).catch(() => null)
      try {
        await enqueueing
        // Cancellation must not delete a source whose queue admission is still undecided.
        expect((await f.request('', { method: 'DELETE' })).status).toBe(409)
        expect(await readFile(f.received[0], 'utf8')).toBe('hello')
        finishEnqueue(accepted)
        expect((await completing)?.status).toBe(accepted ? 202 : 503)
        if (accepted) {
          expect((await f.request('', { method: 'DELETE' })).status).toBe(404)
          expect(await readFile(f.received[0], 'utf8')).toBe('hello')
          f.releases[0]()
        }
        await vi.waitFor(async () => expect(await readdir(f.root)).toEqual([]))
      } finally {
        finishEnqueue(accepted)
        await completing
      }
    }
  )

  it('rejects untrusted origins, invalid credentials, oversized chunks and corrupted bytes', async () => {
    const f = await setup()
    await f.bridge.begin(launch(f.port))
    const wrongOrigin = await f.request('/chunk?offset=0', {
      method: 'PUT',
      body: 'hello',
      headers: { Origin: 'https://other.example' }
    })
    expect(wrongOrigin.status).toBe(403)
    expect(wrongOrigin.headers.get('access-control-allow-origin')).toBeNull()
    expect(
      (await f.request('/complete', { method: 'POST', headers: { Authorization: 'Bearer wrong' } }))
        .status
    ).toBe(403)
    expect((await f.chunk('hello', 0, checksum('wrong'))).status).toBe(422)
    expect((await f.chunk('helloo')).status).toBe(413)
    expect((await f.chunk('hello', 1)).status).toBe(409)
    expect(f.received).toEqual([])
    expect((await f.chunk('hello')).status).toBe(200)
  })

  it('allows scoped CORS preflight without authorizing another website', async () => {
    const f = await setup()
    await f.bridge.begin(launch(f.port))
    expect(
      (
        await f.request('/chunk?offset=0', {
          method: 'OPTIONS',
          headers: {
            Authorization: '',
            'Access-Control-Request-Method': 'PUT',
            'Access-Control-Request-Headers': 'authorization,content-type,x-chunk-sha256'
          }
        })
      ).status
    ).toBe(204)
    expect(
      (await f.request('/chunk?offset=0', { method: 'OPTIONS', headers: { Origin: 'null' } }))
        .status
    ).toBe(403)
  })

  it('discards cancelled partial transfers', async () => {
    const f = await setup({ idleMs: 100 })
    await f.bridge.begin(launch(f.port))
    await f.chunk('he')
    expect((await f.request('', { method: 'DELETE' })).status).toBe(204)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(f.received).toEqual([])
    expect(await readdir(f.root)).toEqual([])
  })

  it('deduplicates repeated protocol launches while resources are acquired', async () => {
    const f = await setup()
    await Promise.all([f.bridge.begin(launch(f.port)), f.bridge.begin(launch(f.port))])
    expect(await readdir(f.root)).toHaveLength(1)
    expect((await f.chunk('hello')).status).toBe(200)
  })
})

it('expires idle partial transfers without publishing them', async () => {
  const f = await setup({ idleMs: 30 })
  await f.bridge.begin(launch(f.port))
  await f.chunk('he')
  await vi.waitFor(async () => expect(await readdir(f.root)).toEqual([]))
  expect(f.received).toEqual([])
  await expect(f.request('/ready')).rejects.toThrow()
})

it('waits for resource acquisition during close and leaves no listener or source behind', async () => {
  const f = await setup()
  const realMkdtemp = fs.mkdtemp
  let release!: () => void
  let acquired!: () => void
  const acquiring = new Promise<void>((resolve) => {
    acquired = resolve
  })
  vi.spyOn(fs, 'mkdtemp').mockImplementationOnce(async (...args) => {
    acquired()
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return realMkdtemp(...args)
  })
  syncBuiltinESMExports()
  const starting = f.bridge.begin(launch(f.port))
  await acquiring
  let closed = false
  const closing = f.bridge.close().then(() => {
    closed = true
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(closed).toBe(false)
  release()
  await Promise.all([starting, closing])
  expect(await readdir(f.root)).toEqual([])
  await expect(f.request('/ready')).rejects.toThrow()
})

it('releases an expired receipt after import and admits another transfer without restarting', async () => {
  const f = await setup({ idleMs: 40 })
  await f.bridge.begin(launch(f.port))
  await f.chunk('hello')
  expect((await f.request('/complete', { method: 'POST' })).status).toBe(202)
  await vi.waitFor(async () => {
    await expect(f.request('/ready')).rejects.toThrow()
  })
  expect(await readFile(f.received[0], 'utf8')).toBe('hello')
  f.releases[0]()
  await vi.waitFor(async () => expect(await readdir(f.root)).toEqual([]))
  await f.bridge.begin(launch(f.port))
  expect((await f.chunk('hello')).status).toBe(200)
})

it('retains the receipt for retry after the source has already been consumed', async () => {
  const f = await setup()
  await f.bridge.begin(launch(f.port))
  await f.chunk('hello')
  expect((await f.request('/complete', { method: 'POST' })).status).toBe(202)
  f.releases[0]()
  await vi.waitFor(async () => expect(await readdir(f.root)).toEqual([]))
  expect((await f.request('/complete', { method: 'POST' })).status).toBe(202)
  expect(f.received).toHaveLength(1)
})

it('automatically receives without a website grant and exposes only capability discovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-auto-'))
  const receiver = new BrowserPackageImport({ root, receive: () => {} })
  const port = await findBrowserImportPort()
  const discovery = await findBrowserImportPort()
  try {
    await receiver.startDiscovery(discovery)
    await receiver.begin(launch(port))
    const capabilities = await fetch(
      `http://127.0.0.1:${discovery}/v1/browser-import/capabilities`,
      { headers: { Origin: origin } }
    )
    expect(await capabilities.json()).toEqual({
      service: 'open-science-browser-import',
      version: 1
    })
    expect(
      (
        await fetch(`http://127.0.0.1:${discovery}/v1/browser-import/authorization`, {
          method: 'DELETE',
          headers: { Origin: origin }
        })
      ).status
    ).toBe(404)
    expect((await readdir(root)).every((name) => name.startsWith('transfer-'))).toBe(true)
  } finally {
    await receiver.close()
    await rm(root, { recursive: true, force: true })
  }
})
