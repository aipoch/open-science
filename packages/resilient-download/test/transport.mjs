/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Shared by source tests and the installed-tarball consumer. The API is supplied by each caller;
// this fixture never resolves a workspace implementation or uses a private downloader seam.
export async function verifyTransport(api, scenario) {
  const directory = await mkdtemp(join(tmpdir(), 'resilient-transport-'))
  const destination = join(directory, 'file.bin')
  const bytes = Buffer.from('verified download bytes')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const requests = []
  const sockets = new Set()
  let released
  const responseReleased = new Promise((resolve) => {
    released = resolve
  })
  const server = createServer((request, response) => {
    requests.push({ range: request.headers.range, validator: request.headers['if-range'] })
    response.on('close', () => released())
    const offset = Number(request.headers.range?.match(/^bytes=(\d+)-$/)?.[1] ?? 0)
    response.writeHead(offset ? 206 : 200, {
      ETag: '"fixture-v1"',
      'Content-Length': bytes.length - offset,
      ...(offset ? { 'Content-Range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {})
    })
    if (['resume', 'cancel', 'stall'].includes(scenario) && !offset) {
      response.write(bytes.subarray(0, 4))
    } else response.end(bytes.subarray(offset))
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = `http://127.0.0.1:${server.address().port}`
    const url = origin + '/file'
    const options = {
      expectedSize: bytes.length,
      expectedSha256: sha256,
      expectedOrigin: origin,
      maxRetries: 0
    }
    if (scenario === 'resume' || scenario === 'cancel') {
      const controller = new AbortController()
      const reason = new Error('caller cancelled')
      await assert.rejects(
        api.resilientDownload(url, destination, {
          ...options,
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress.transferred >= 4) controller.abort(reason)
          }
        }),
        (error) => error === reason
      )
      await responseReleased
      assert.deepEqual(await readFile(destination + '.part'), bytes.subarray(0, 4))
      await assert.rejects(readFile(destination), { code: 'ENOENT' })
      const metadata = JSON.parse(await readFile(destination + '.part.meta', 'utf8'))
      assert.equal(metadata.version, 1)
      assert.deepEqual(metadata.validator, { kind: 'etag', value: '"fixture-v1"' })
      assert.equal(metadata.urlSha256, createHash('sha256').update(url).digest('hex'))
      assert.equal(metadata.expectedSize, bytes.length)
      if (scenario === 'cancel') {
        assert.equal(requests.length, 1)
        return
      }
      assert.equal(await api.resilientDownload(url, destination, options), destination)
      assert.deepEqual(requests, [
        { range: undefined, validator: undefined },
        { range: 'bytes=4-', validator: '"fixture-v1"' }
      ])
    } else if (scenario === 'checksum') {
      await assert.rejects(
        api.resilientDownload(url, destination, {
          ...options,
          expectedSha256: '0'.repeat(64)
        }),
        (error) =>
          error instanceof api.DownloadChecksumError && error instanceof api.DownloadSourceError
      )
      for (const suffix of ['', '.part', '.part.meta'])
        await assert.rejects(readFile(destination + suffix), { code: 'ENOENT' })
      return
    } else if (scenario === 'origin') {
      await assert.rejects(
        api.resilientDownload(url, destination, {
          ...options,
          expectedOrigin: 'https://different.invalid'
        }),
        api.DownloadSourceError
      )
      await responseReleased
      await assert.rejects(readFile(destination), { code: 'ENOENT' })
      return
    } else if (scenario === 'stall') {
      await assert.rejects(
        api.resilientDownload(url, destination, {
          ...options,
          stallTimeoutMs: 100
        }),
        api.DownloadSourceError
      )
      await responseReleased
      assert.equal(requests.length, 1)
      await assert.rejects(readFile(destination), { code: 'ENOENT' })
      return
    } else {
      // Exercise replacement of an existing ordinary file, including on Windows.
      await writeFile(destination, 'older bytes')
      const progress = []
      assert.equal(
        await api.resilientDownload(url, destination, {
          ...options,
          onProgress: (value) => progress.push(value)
        }),
        destination
      )
      assert.equal(progress.at(-1).percent, 100)
      assert.equal(progress.at(-1).transferred, bytes.length)
    }
    assert.deepEqual(await readFile(destination), bytes)
    for (const suffix of ['.part', '.part.meta'])
      await assert.rejects(readFile(destination + suffix), { code: 'ENOENT' })
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
}
