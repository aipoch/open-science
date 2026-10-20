/* eslint-disable @typescript-eslint/explicit-function-return-type -- Inferred types for test fixture helpers. */
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import { findBrowserImportPort } from './test-helpers/browser-import-port'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { request as httpRequest } from 'node:http'
import { Server } from 'node:net'
import fs from 'node:fs/promises'
import type { BrowserPackageTransfer } from '../../shared/session-package'
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

it.each(['EACCES', 'EADDRINUSE'])('selects another test port after %s', async (code) => {
  const listen = vi.spyOn(Server.prototype, 'listen').mockImplementationOnce(function (
    this: Server
  ) {
    queueMicrotask(() => this.emit('error', Object.assign(new Error('Port unavailable'), { code })))
    return this
  })
  expect(await findBrowserImportPort()).toBeGreaterThanOrEqual(49152)
  expect(listen.mock.calls.length).toBeGreaterThanOrEqual(2)
})

it('bounds test port discovery when every port is denied', async () => {
  const error = Object.assign(new Error('Port unavailable'), { code: 'EACCES' })
  const listen = vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server) {
    queueMicrotask(() => this.emit('error', error))
    return this
  })
  await expect(findBrowserImportPort()).rejects.toBe(error)
  expect(listen).toHaveBeenCalledTimes(32)
})

it('keeps released-source cleanup failures visible and retries without revoking the receipt', async () => {
  const f = await setup({ idleMs: 100 })
  await f.bridge.begin(launch(f.port))
  const id = f.bridge.snapshot[0].id
  await f.chunk('hello')
  expect((await f.request('/complete', { method: 'POST' })).status).toBe(202)
  vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('File locked'))
  syncBuiltinESMExports()
  f.releases[0]()
  await vi.waitFor(() =>
    expect(f.bridge.snapshot).toEqual([expect.objectContaining({ id, cleanupPending: true })])
  )
  expect(f.bridge.active).toBe(true)
  // Polling the receipt must not restart expiry while a cleanup failure needs user attention.
  expect((await f.request('/complete', { method: 'POST' })).status).toBe(202)
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(f.bridge.snapshot[0].cleanupPending).toBe(true)
  expect(await readdir(f.root)).toHaveLength(1)
  await f.bridge.cancel(id) // Existing row action doubles as Retry cleanup.
  expect(f.bridge.active).toBe(false)
  expect(f.bridge.snapshot).toEqual([])
  expect(await readdir(f.root)).toEqual([])
  expect((await f.request('/complete', { method: 'POST' })).status).toBe(202)
  await f.bridge.cancel(id) // A late duplicate cleanup click cannot revoke an accepted receipt.
  expect((await f.request('/complete', { method: 'POST' })).status).toBe(202)
})

async function setup(
  options: {
    idleMs?: number
    receive?: () => Promise<boolean>
    cancelReceived?: (path: string) => Promise<void>
    onChanged?: (transfers: BrowserPackageTransfer[]) => void
  } = {}
) {
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
    cancelReceived: options.cancelReceived,
    onChanged: options.onChanged,
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

function streamingChunk(port: number, body: string, offset = 0, contentLength = true) {
  const digest = checksum(body)
  const path = `/v1/import/chunk?offset=${offset}`
  const iv = randomBytes(12)
  const key = createHash('sha256').update(`open-science-encryption-v1:${secret}`).digest()
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`offset:${offset}`))
  const encrypted = Buffer.concat([iv, cipher.update(body), cipher.final(), cipher.getAuthTag()])
  const incoming = httpRequest(`http://127.0.0.1:${port}${path}`, {
    method: 'PUT',
    headers: {
      Origin: origin,
      Authorization: `HMAC ${createHmac('sha256', Buffer.from(secret, 'hex')).update(`PUT\n${path}\n${digest}`).digest('hex')}`,
      'X-Chunk-SHA256': digest,
      ...(contentLength ? { 'Content-Length': String(encrypted.length) } : {})
    }
  })
  const response = new Promise<{ status?: number; body: string }>((resolve, reject) => {
    incoming.once('error', reject)
    incoming.once('response', (response) => {
      let body = ''
      response.on('data', (data) => {
        body += data
      })
      response.once('end', () => resolve({ status: response.statusCode, body }))
      response.once('error', reject)
    })
  })
  void response.catch(() => undefined)
  disposers.push(async () => {
    incoming.destroy()
    await response.catch(() => undefined)
  })
  return { incoming, encrypted, response }
}

it('publishes payload progress inside each chunk without advancing verified offsets or admitting early', async () => {
  const progress: number[] = []
  const f = await setup({
    onChanged: (transfers) => {
      if (transfers[0]) progress.push(transfers[0].completedBytes)
    }
  })
  await f.bridge.begin(launch(f.port, 100))
  const first = streamingChunk(f.port, 'a'.repeat(60))
  first.incoming.write(first.encrypted.subarray(0, 12))
  await vi.waitFor(() => expect(f.bridge.snapshot[0].state).toBe('receiving'))
  expect(f.bridge.snapshot[0].completedBytes).toBe(0)
  first.incoming.write(first.encrypted.subarray(12, 32))
  await vi.waitFor(() => expect(progress).toContain(20))
  first.incoming.write(first.encrypted.subarray(32, 52))
  await vi.waitFor(() => expect(progress).toContain(40))
  expect(await (await f.request(`/ready?challenge=${'cd'.repeat(32)}`)).json()).toMatchObject({
    offset: 0,
    accepted: false,
    chunkBytes: 4194304
  })
  expect((await f.request('/complete', { method: 'POST' })).status).toBe(409)
  first.incoming.write(first.encrypted.subarray(52, 72))
  await vi.waitFor(() => expect(progress).toContain(60))
  first.incoming.end(first.encrypted.subarray(72))
  expect((await first.response).status).toBe(200)
  const second = streamingChunk(f.port, 'b'.repeat(40), 60)
  second.incoming.write(second.encrypted.subarray(0, 32))
  await vi.waitFor(() => expect(progress).toContain(80))
  second.incoming.write(second.encrypted.subarray(32, 52))
  await vi.waitFor(() => expect(progress).toContain(100))
  // Payload is fully received, but the authentication tag and queue admission are still pending.
  expect(await (await f.request(`/ready?challenge=${'cd'.repeat(32)}`)).json()).toMatchObject({
    offset: 60,
    accepted: false
  })
  expect(f.received).toEqual([])
  expect((await f.request('/complete', { method: 'POST' })).status).toBe(409)
  second.incoming.end(second.encrypted.subarray(52))
  expect((await second.response).status).toBe(200)
  expect(progress).toEqual([...progress].sort((a, b) => a - b))
  expect(Math.max(...progress)).toBe(100)
  expect(f.received).toEqual([])
  expect((await f.request('/complete', { method: 'POST' })).status).toBe(202)
  expect(await readFile(f.received[0], 'utf8')).toBe('a'.repeat(60) + 'b'.repeat(40))
})

it('excludes IV and reserves the trailing authentication tag when the stream has no content length', async () => {
  const f = await setup()
  await f.bridge.begin(launch(f.port, 80))
  const stream = streamingChunk(f.port, 'x'.repeat(80), 0, false)
  stream.incoming.write(stream.encrypted.subarray(0, 48))
  await vi.waitFor(() => expect(f.bridge.snapshot[0].completedBytes).toBe(20))
  stream.incoming.write(stream.encrypted.subarray(48, 88))
  await vi.waitFor(() => expect(f.bridge.snapshot[0].completedBytes).toBe(60))
  stream.incoming.end(stream.encrypted.subarray(88))
  expect((await stream.response).status).toBe(200)
  expect(f.bridge.snapshot[0].completedBytes).toBe(80)
})

it('does not double count or rewind rejected payloads on retry, and still requires authentication', async () => {
  const progress: number[] = []
  const f = await setup({
    onChanged: (transfers) => {
      if (transfers[0]) progress.push(transfers[0].completedBytes)
    }
  })
  await f.bridge.begin(launch(f.port, 80))
  const rejected = streamingChunk(f.port, 'x'.repeat(60))
  rejected.encrypted[rejected.encrypted.length - 1] ^= 1
  rejected.incoming.end(rejected.encrypted)
  expect((await rejected.response).status).toBe(422)
  expect(f.bridge.snapshot[0].completedBytes).toBe(60)
  expect(await (await f.request(`/ready?challenge=${'cd'.repeat(32)}`)).json()).toMatchObject({
    offset: 0,
    accepted: false
  })
  expect((await f.request('/complete', { method: 'POST' })).status).toBe(409)
  expect(f.received).toEqual([])
  expect((await f.chunk('x'.repeat(40))).status).toBe(200)
  expect(f.bridge.snapshot[0].completedBytes).toBe(60)
  expect((await f.chunk('x'.repeat(40), 40)).status).toBe(200)
  expect(f.bridge.snapshot[0].completedBytes).toBe(80)
  expect(progress).toEqual([...progress].sort((a, b) => a - b))
  expect(Math.max(...progress)).toBe(80)
})

it('cancels a partially streamed payload and leaves other transfer progress untouched', async () => {
  const f = await setup()
  await f.bridge.begin(launch(f.port, 100))
  await f.bridge.begin(launch(await findBrowserImportPort()).replace(secret, 'ef'.repeat(32)))
  const id = f.bridge.snapshot[0].id
  const stream = streamingChunk(f.port, 'x'.repeat(100))
  stream.incoming.write(stream.encrypted.subarray(0, 62))
  await vi.waitFor(() => expect(f.bridge.snapshot[0].completedBytes).toBe(50))
  await f.bridge.cancel(id)
  const result = await stream.response
  expect(result.status).toBe(410)
  expect(JSON.parse(result.body)).toMatchObject({ code: 'cancelled' })
  expect(f.bridge.snapshot).toMatchObject([
    { id, state: 'cancelled', completedBytes: 50 },
    { state: 'waiting', completedBytes: 0 }
  ])
  expect(f.received).toEqual([])
  expect(await readdir(f.root)).toHaveLength(1)
  await f.bridge.cancel(f.bridge.snapshot[1].id)
  expect(await readdir(f.root)).toEqual([])
})

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

it('reports real received bytes and cancels only the selected transfer with a signed result', async () => {
  const f = await setup()
  await f.bridge.begin(launch(f.port))
  const id = f.bridge.snapshot[0].id
  expect(f.bridge.snapshot).toEqual([
    { id, filename: 'study.science', state: 'waiting', completedBytes: 0, totalBytes: 5 }
  ])
  await f.chunk('he')
  expect(f.bridge.snapshot[0]).toMatchObject({
    state: 'receiving',
    completedBytes: 2,
    totalBytes: 5
  })
  await f.bridge.cancel(id)
  expect(f.bridge.snapshot[0]).toMatchObject({ state: 'cancelled', completedBytes: 2 })
  expect(await readdir(f.root)).toEqual([])
  const cancelled = await f.request('/ready?challenge=' + 'cd'.repeat(32))
  expect(cancelled.status).toBe(410)
  expect(await cancelled.json()).toEqual({
    code: 'cancelled',
    proof: createHmac('sha256', Buffer.from(secret, 'hex')).update('cancelled').digest('hex')
  })
  expect((await f.chunk('llo', 2)).status).toBe(410)
  expect(f.received).toEqual([])
})

it('joins an in-flight write before removing a desktop-cancelled source', async () => {
  let release!: () => void
  let writing!: () => void
  const started = new Promise<void>((resolve) => {
    writing = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const realOpen = fs.open
  vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
    const handle = await realOpen(...args)
    const write = handle.write.bind(handle)
    vi.spyOn(handle, 'write').mockImplementationOnce(async (...args) => {
      writing()
      await gate
      return write(...args)
    })
    return handle
  })
  syncBuiltinESMExports()
  const f = await setup()
  await f.bridge.begin(launch(f.port))
  const chunk = f.chunk('hello')
  let cancelling: Promise<void> | undefined
  try {
    await started
    expect(f.bridge.snapshot[0].completedBytes).toBe(5)
    expect(await (await f.request(`/ready?challenge=${'cd'.repeat(32)}`)).json()).toMatchObject({
      offset: 0,
      accepted: false
    })
    expect((await f.request('/complete', { method: 'POST' })).status).toBe(409)
    cancelling = f.bridge.cancel(f.bridge.snapshot[0].id)
    expect((await chunk).status).toBe(410)
    expect(f.bridge.active).toBe(true)
    expect(await readdir(f.root)).toHaveLength(1)
    release()
    await cancelling
    expect(await readdir(f.root)).toEqual([])
    expect(f.received).toEqual([])
  } finally {
    release()
    await cancelling
    await chunk
  }
})

it.each([true, false])(
  'coordinates desktop cancellation with asynchronous admission (accepted: %s)',
  async (accepted) => {
    let admit!: (value: boolean) => void
    let entered!: () => void
    const enteredQueue = new Promise<void>((resolve) => {
      entered = resolve
    })
    const admission = new Promise<boolean>((resolve) => {
      admit = resolve
    })
    const queuedCancellation: string[] = []
    const f = await setup({
      receive: () => {
        entered()
        return admission
      },
      cancelReceived: async (path) => {
        expect(await readFile(path, 'utf8')).toBe('hello')
        queuedCancellation.push(path)
        f.releases[0]()
      }
    })
    await f.bridge.begin(launch(f.port))
    const id = f.bridge.snapshot[0].id
    await f.chunk('hello')
    const complete = f.request('/complete', { method: 'POST' })
    let cancelling: Promise<void> | undefined
    try {
      await enteredQueue
      cancelling = f.bridge.cancel(id)
      expect((await complete).status).toBe(410)
      expect(await readFile(f.received[0], 'utf8')).toBe('hello')
      admit(accepted)
      await cancelling
      expect(queuedCancellation).toEqual(accepted ? f.received : [])
      await vi.waitFor(async () => expect(await readdir(f.root)).toEqual([]))
    } finally {
      admit(true)
      await cancelling
      await complete
    }
  }
)

it('does not cancel another waiting transfer or expose protocol secrets in progress', async () => {
  const f = await setup()
  await f.bridge.begin(launch(f.port))
  const first = f.bridge.snapshot[0].id
  const secondPort = await findBrowserImportPort()
  await f.bridge.begin(launch(secondPort).replace(secret, 'ef'.repeat(32)))
  const second = f.bridge.snapshot[1].id
  await f.bridge.cancel(first)
  expect(f.bridge.snapshot).toMatchObject([
    { id: first, state: 'cancelled' },
    { id: second, state: 'waiting' }
  ])
  expect(JSON.stringify(f.bridge.snapshot)).not.toContain(secret)
  expect(JSON.stringify(f.bridge.snapshot)).not.toContain('ef'.repeat(32))
  expect(await readdir(f.root)).toHaveLength(1)
})

it('keeps failed cancellation cleanup visible and retryable without accepting more bytes', async () => {
  const f = await setup()
  await f.bridge.begin(launch(f.port))
  await f.chunk('he')
  const id = f.bridge.snapshot[0].id
  vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('Cleanup blocked'))
  syncBuiltinESMExports()
  await expect(f.bridge.cancel(id)).rejects.toThrow('Cleanup blocked')
  expect(f.bridge.snapshot[0]).toMatchObject({ state: 'cancelled', cleanupPending: true })
  expect(f.bridge.active).toBe(true)
  expect((await f.chunk('llo', 2)).status).toBe(410)
  await f.bridge.cancel(id)
  expect(f.bridge.active).toBe(false)
  expect(await readdir(f.root)).toEqual([])
})

it('returns a signed cancellation without waiting for an unfinished upload body', async () => {
  const { request: httpRequest } = await import('node:http')
  const f = await setup()
  await f.bridge.begin(launch(f.port))
  const id = f.bridge.snapshot[0].id
  const digest = checksum('hello')
  const signature = createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(`PUT\n/v1/import/chunk?offset=0\n${digest}`)
    .digest('hex')
  const incoming = httpRequest(`http://127.0.0.1:${f.port}/v1/import/chunk?offset=0`, {
    method: 'PUT',
    headers: {
      Origin: origin,
      Authorization: `HMAC ${signature}`,
      'X-Chunk-SHA256': digest,
      'Content-Length': '33'
    }
  })
  const response = new Promise<{ status?: number; body: string }>((resolve, reject) => {
    incoming.once('error', reject)
    incoming.once('response', (response) => {
      let body = ''
      response.on('data', (data) => {
        body += data
      })
      response.once('end', () => resolve({ status: response.statusCode, body }))
      response.once('error', reject)
    })
  })
  // Deliberately never finish the advertised request body.
  incoming.write(Buffer.alloc(1))
  try {
    await vi.waitFor(() => expect(f.bridge.snapshot[0].state).toBe('receiving'))
    await f.bridge.cancel(id)
    const result = await response
    expect(result.status).toBe(410)
    expect(JSON.parse(result.body)).toMatchObject({
      code: 'cancelled',
      proof: createHmac('sha256', Buffer.from(secret, 'hex')).update('cancelled').digest('hex')
    })
    expect(await readdir(f.root)).toEqual([])
    expect(f.received).toEqual([])
  } finally {
    incoming.destroy()
    await response.catch(() => undefined)
  }
})

it('honors cancellation recorded during cold startup before accepting any browser bytes', async () => {
  const f = await setup()
  await f.bridge.begin(launch(f.port), true)
  const ready = await f.request(`/ready?challenge=${'cd'.repeat(32)}`, {
    headers: { Authorization: '' }
  })
  expect(ready.status).toBe(410)
  expect(await ready.json()).toEqual({
    code: 'cancelled',
    proof: createHmac('sha256', Buffer.from(secret, 'hex')).update('cancelled').digest('hex')
  })
  expect((await f.chunk('hello')).status).toBe(410)
  expect(f.received).toEqual([])
  expect(await readdir(f.root)).toEqual([])
  expect(f.bridge.snapshot).toEqual([
    expect.objectContaining({ state: 'cancelled', completedBytes: 0 })
  ])
})

it('applies a cold-shell cancel when the same transfer already exists in the backend', async () => {
  const f = await setup()
  await f.bridge.begin(launch(f.port))
  await f.chunk('he')
  await f.bridge.begin(launch(f.port), true)
  expect((await f.chunk('llo', 2)).status).toBe(410)
  expect(f.received).toEqual([])
  expect(await readdir(f.root)).toEqual([])
})
