import { createRequire } from 'node:module'
import { createServer, request, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import type { Socket } from 'node:net'
import { expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  DifferentialDownloader
} = require('electron-updater/out/differentialDownloader/DifferentialDownloader')
const { CancellationToken } = require('builder-util-runtime')

it.each(
  ['single', 'multipart', 'metadata'].flatMap((mode) =>
    [true, false].map((headersSent) => ({ mode, headersSent }))
  )
)(
  'aborts stalled $mode ranges (headers sent: $headersSent) and releases its files',
  async ({ mode, headersSent }) => {
    const root = await mkdtemp(join(tmpdir(), 'update-range-cancel-'))
    const sockets = new Set<Socket>()
    let received!: () => void
    const started = new Promise<void>((resolve) => {
      received = resolve
    })
    let closed!: () => void
    const responseClosed = new Promise<void>((resolve) => {
      closed = resolve
    })
    const server = createServer((_request, response: ServerResponse) => {
      response.once('close', closed)
      response.writeHead(
        206,
        mode === 'multipart'
          ? { 'Content-Type': 'multipart/byteranges; boundary=cancel-test' }
          : { 'Content-Length': 16, 'Content-Range': 'bytes 0-15/16', 'Accept-Ranges': 'bytes' }
      )
      if (headersSent) response.flushHeaders()
      received()
    })
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing loopback port')
    const oldFile = join(root, 'old'),
      newFile = join(root, 'new')
    await writeFile(oldFile, '')
    const token = new CancellationToken()
    const downloader = new DifferentialDownloader(
      { size: 16, sha512: Buffer.alloc(64).toString('base64') },
      {
        createRequest: request,
        addErrorAndTimeoutHandlers: (
          req: ReturnType<typeof request>,
          reject: (error: Error) => void
        ) => req.on('error', reject)
      },
      {
        oldFile,
        newFile,
        newUrl: new URL(`http://127.0.0.1:${address.port}/setup.exe`),
        cancellationToken: token,
        isUseMultipleRangeRequest: mode === 'multipart',
        logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn() },
        onProgress: vi.fn()
      }
    )
    const downloading: Promise<unknown> =
      mode === 'metadata'
        ? downloader.readRemoteBytes(0, 15)
        : downloader.downloadFile(
            mode === 'multipart'
              ? [
                  { kind: 1, start: 0, end: 8 },
                  { kind: 1, start: 8, end: 16 }
                ]
              : [{ kind: 1, start: 0, end: 16 }]
          )
    const outcome = downloading.then(
      () => 'resolved',
      (error: Error) => error.message
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await started
      token.cancel()
      const result = await Promise.race([
        Promise.all([outcome, responseClosed]).then(([message]) => message),
        new Promise<string>((resolve) => {
          timer = setTimeout(
            () => resolve('cancellation did not settle and close the response'),
            2000
          )
        })
      ])
      expect(result).toBe('cancelled')
      expect(token.listenerCount('cancel')).toBe(0)
      // Windows rejects deletion when the downloader still owns an open file handle.
      await rm(root, { recursive: true })
    } finally {
      clearTimeout(timer)
      for (const socket of sockets) socket.destroy()
      await outcome
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('keeps cancellation attached after Electron closes the request upload side', async () => {
  const { EventEmitter } = await import('node:events')
  const {
    configureRequestCancellation
  } = require('electron-updater/out/differentialDownloader/cancelRequest')
  const token = new CancellationToken()
  let aborted = false
  let failure: Error | undefined
  const req = Object.assign(new EventEmitter(), {
    abort: () => {
      aborted = true
    }
  })
  expect(
    configureRequestCancellation(req, token, (error: Error) => {
      failure = error
    })
  ).toBeTypeOf('function')
  req.emit('close')
  token.cancel()
  expect(aborted).toBe(true)
  expect(failure?.message).toBe('cancelled')
  expect(token.listenerCount('cancel')).toBe(0)
})

it('removes cancellation after the response finishes without aborting a completed request', async () => {
  const { EventEmitter } = await import('node:events')
  const {
    configureRequestCancellation
  } = require('electron-updater/out/differentialDownloader/cancelRequest')
  const token = new CancellationToken()
  let aborted = false
  const req = Object.assign(new EventEmitter(), {
    abort: () => {
      aborted = true
    }
  })
  const response = new EventEmitter()
  configureRequestCancellation(req, token, () => {
    throw new Error('Completed request rejected')
  })
  req.emit('response', response)
  response.emit('end')
  expect(token.listenerCount('cancel')).toBe(0)
  token.cancel()
  expect(aborted).toBe(false)
})

it.each(
  ['single', 'multipart', 'metadata']
    .flatMap((mode) =>
      [
        'success',
        'pre-cancelled',
        'http503',
        'invalid-range',
        'invalid-content-type',
        'interrupted'
      ].map((scenario) => ({ mode, scenario }))
    )
    .filter(({ mode, scenario }) => scenario !== 'invalid-content-type' || mode === 'multipart')
)('settles $mode $scenario and releases request cancellation', async ({ mode, scenario }) => {
  const root = await mkdtemp(join(tmpdir(), 'update-range-result-'))
  const payload = Buffer.from('0123456789abcdef')
  const sockets = new Set<Socket>()
  let responseFinished!: () => void
  const responseClosed = new Promise<void>((resolve) => {
    responseFinished = resolve
  })
  const server = createServer((_request, response) => {
    response.once('close', responseFinished)
    if (scenario === 'http503' || scenario === 'invalid-range') {
      response.writeHead(scenario === 'http503' ? 503 : 200, { 'Content-Length': 5 })
      response.flushHeaders()
      return
    }
    if (scenario === 'invalid-content-type') {
      response.writeHead(206, { 'Content-Type': 'text/plain', 'Content-Length': 5 })
      response.flushHeaders()
      return
    }
    const multipart =
      '--result\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes 0-7/16\r\n\r\n01234567\r\n--result\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes 8-15/16\r\n\r\n89abcdef\r\n--result--\r\n'
    const body = mode === 'multipart' ? Buffer.from(multipart) : payload
    response.writeHead(206, {
      'Content-Type':
        mode === 'multipart' ? 'multipart/byteranges; boundary=result' : 'application/octet-stream',
      'Content-Length': body.length,
      'Accept-Ranges': 'bytes'
    })
    if (scenario === 'interrupted') {
      response.write(body.subarray(0, 3))
      setImmediate(() => response.destroy())
    } else response.end(body)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback port')
  const token = new CancellationToken()
  await writeFile(join(root, 'old'), '')
  const downloader = new DifferentialDownloader(
    { size: payload.length, sha512: createHash('sha512').update(payload).digest('base64') },
    {
      createRequest: request,
      addErrorAndTimeoutHandlers: (
        req: ReturnType<typeof request>,
        reject: (error: Error) => void
      ) => req.on('error', reject)
    },
    {
      oldFile: join(root, 'old'),
      newFile: join(root, 'new'),
      newUrl: new URL(`http://127.0.0.1:${address.port}/update`),
      cancellationToken: token,
      isUseMultipleRangeRequest: mode === 'multipart',
      logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn() },
      onProgress: vi.fn()
    }
  )
  try {
    if (scenario === 'pre-cancelled') token.cancel()
    const operation =
      mode === 'metadata'
        ? downloader.readRemoteBytes(0, 15)
        : downloader.downloadFile(
            mode === 'multipart'
              ? [
                  { kind: 1, start: 0, end: 8 },
                  { kind: 1, start: 8, end: 16 }
                ]
              : [{ kind: 1, start: 0, end: 16 }]
          )
    if (scenario === 'success') {
      const result = await operation
      expect(mode === 'metadata' ? result : await readFile(join(root, 'new'))).toEqual(payload)
    } else
      await expect(operation).rejects.toThrow(
        scenario === 'pre-cancelled' ? 'cancelled' : undefined
      )
    if (scenario !== 'pre-cancelled') await responseClosed
    expect(token.listenerCount('cancel')).toBe(0)
    await rm(root, { recursive: true })
  } finally {
    token.cancel()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
