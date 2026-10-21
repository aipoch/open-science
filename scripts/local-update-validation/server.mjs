/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createShutdownFault } from './shutdown-fault.mjs'
import { createReadStream } from 'node:fs'
import { appendFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const SCENARIOS = [
  'boundary',
  'handoff-failure',
  'manual-local',
  'manual-non-standalone',
  'manual-download-failure',
  'cache-corrupt-entry',
  'cache-delete-entry',
  'cache-corrupt-reveal',
  'cache-delete-reveal',
  'same-version',
  'lower-version',
  'download-cancel',
  'network-failure',
  'checksum-failure',
  'corrupt-artifact',
  'active-task',
  'shutdown-failure'
]

export async function startUpdateServer({
  artifact,
  versionA,
  versionB,
  scenario,
  eventsPath,
  host = '127.0.0.1',
  port = 0,
  shutdownFault,
  onFailure = () => {}
}) {
  if (host !== '127.0.0.1') throw new Error('Local update service must bind IPv4 loopback.')
  if (!SCENARIOS.includes(scenario)) throw new Error(`Unknown scenario: ${scenario}`)
  const sockets = new Set()
  const operations = new Set()
  let origin
  let closing = false
  let faultTriggered = false
  let cancellationThrottleUsed = false
  let logFailure
  const record = (event) => {
    const operation = appendFile(
      eventsPath,
      `${JSON.stringify({ schema: 1, at: new Date().toISOString(), ...event })}\n`
    ).catch((error) => {
      logFailure = error
      onFailure(error)
    })
    operations.add(operation)
    void operation.finally(() => operations.delete(operation))
    return operation
  }
  const repairToken = randomUUID()
  const fault =
    scenario === 'shutdown-failure' ? await createShutdownFault(shutdownFault, record) : undefined
  const servedVersion =
    scenario === 'same-version' ? versionA : scenario === 'lower-version' ? '0.0.0' : versionB
  const zip = artifact.files.find((file) => file.name.endsWith('.zip'))
  if (!zip) throw new Error('B ZIP is required for the actual macOS download/verification path.')
  // JSON is a YAML subset: keep the external service independent of installed repository dependencies.
  const feed = {
    version: servedVersion,
    files: [
      {
        url: zip.name,
        sha512: scenario === 'checksum-failure' ? Buffer.alloc(64).toString('base64') : zip.sha512,
        size: zip.size
      }
    ],
    path: zip.name,
    sha512: scenario === 'checksum-failure' ? Buffer.alloc(64).toString('base64') : zip.sha512,
    releaseDate: new Date().toISOString(),
    releaseNotes: `Local update validation ${scenario}; source ${artifact.snapshotId}. Native installation and B startup are not verified.`
  }
  const files = new Map(artifact.files.map((file) => [`/${file.name}`, file]))
  const handler = async (request, response) => {
    const parsed = new URL(request.url, origin)
    await record({
      type: 'request',
      method: request.method,
      path: parsed.pathname,
      range: request.headers.range
    })
    if (
      parsed.pathname === '/diagnostics/shutdown-fault/release' &&
      request.method === 'POST' &&
      fault
    ) {
      if (parsed.searchParams.get('token') !== repairToken || request.headers.origin !== origin) {
        response.writeHead(403).end()
        return
      }
      await fault.release('user-request')
      response.writeHead(303, { location: '/diagnostics/shutdown-fault' }).end()
      return
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405).end()
      return
    }
    const json = (value, type = 'application/json') => {
      const data = Buffer.from(JSON.stringify(value))
      response.writeHead(200, {
        'content-type': type,
        'content-length': data.length,
        'cache-control': 'no-store'
      })
      response.end(request.method === 'HEAD' ? undefined : data)
    }
    if (parsed.pathname === '/diagnostics/shutdown-fault' && fault) {
      const html = Buffer.from(
        `<!doctype html><meta charset="utf-8"><title>Local shutdown fault</title><h1>Local shutdown fault</h1><p>The source owns a temporary hard link to this run's runtime lock. Active: ${fault.active}.</p><p>After A reports that shutdown could not be confirmed, release only this source-owned link, then use A's recovery button. No process is stopped or restarted here.</p><form method="POST" action="/diagnostics/shutdown-fault/release?token=${repairToken}"><button>Release source-owned fault link</button></form>`
      )
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': html.length,
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'"
      })
      response.end(request.method === 'HEAD' ? undefined : html)
      return
    }
    if (parsed.pathname === '/health') {
      json({ ready: true })
      return
    }
    if (parsed.pathname === '/latest-mac.yml') {
      if (fault && request.method === 'GET') {
        await fault.trigger()
        faultTriggered = true
      }
      if (scenario === 'checksum-failure' && request.method === 'GET') {
        faultTriggered = true
        await record({ type: 'fault-triggered', fault: 'checksum-failure' })
      }
      json(feed, 'application/yaml')
      return
    }
    if (parsed.pathname === '/version.json') {
      json({
        version: servedVersion,
        releaseDate: feed.releaseDate,
        notes: feed.releaseNotes,
        downloads: {}
      })
      return
    }
    if (parsed.pathname === '/release-notes.md') {
      const data = Buffer.from(feed.releaseNotes)
      response.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-length': data.length
      })
      response.end(request.method === 'HEAD' ? undefined : data)
      return
    }
    const file = files.get(parsed.pathname)
    if (!file || basename(parsed.pathname) !== file.name) {
      response.writeHead(404).end()
      return
    }
    const isZip = file.name === zip.name && request.method === 'GET'
    if (
      isZip &&
      ((scenario === 'network-failure' && !faultTriggered) ||
        scenario === 'manual-download-failure')
    ) {
      faultTriggered = true
      await record({ type: 'fault-triggered', fault: scenario, response: 503 })
      response.writeHead(503, { 'content-length': 0 }).end()
      return
    }
    const throttleThisRequest = isZip && scenario === 'download-cancel' && !cancellationThrottleUsed
    if (throttleThisRequest) {
      cancellationThrottleUsed = true
      faultTriggered = true
      await record({
        type: 'fault-triggered',
        fault: 'download-cancel',
        mechanism: 'first-transfer-throttle'
      })
    }
    const diskPath = join(artifact.directory, file.name)
    if ((await stat(diskPath)).size !== file.size)
      throw new Error(`Artifact changed after build: ${file.name}`)
    let start = 0
    let end = file.size - 1
    if (request.headers.range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range)
      if (!match) {
        response.writeHead(416, { 'content-range': `bytes */${file.size}` }).end()
        return
      }
      start = Number(match[1])
      end = match[2] ? Number(match[2]) : end
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        end >= file.size
      ) {
        response.writeHead(416, { 'content-range': `bytes */${file.size}` }).end()
        return
      }
    }
    response.writeHead(request.headers.range ? 206 : 200, {
      'content-type': 'application/octet-stream',
      'content-length': end - start + 1,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      ...(request.headers.range ? { 'content-range': `bytes ${start}-${end}/${file.size}` } : {})
    })
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    let firstChunk = true
    const transfer = new Transform({
      transform(chunk, _encoding, callback) {
        if (isZip && scenario === 'corrupt-artifact' && firstChunk) {
          firstChunk = false
          chunk = Buffer.from(chunk)
          chunk[0] ^= 0xff
          faultTriggered = true
          void record({ type: 'fault-triggered', fault: 'corrupt-artifact', byte: start })
        }
        if (throttleThisRequest) setTimeout(() => callback(null, chunk), 100)
        else callback(null, chunk)
      }
    })
    try {
      await pipeline(
        createReadStream(diskPath, { start, end, highWaterMark: 128 * 1024 }),
        transfer,
        response
      )
      await record({
        type: 'response-completed',
        path: parsed.pathname,
        start,
        end,
        throttled: throttleThisRequest
      })
    } catch (error) {
      if (request.aborted || ['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET'].includes(error.code))
        await record({
          type: 'response-interrupted',
          path: parsed.pathname,
          error: error.message,
          throttled: throttleThisRequest
        })
      else throw error
    }
  }
  const server = createServer((request, response) => {
    const operation = handler(request, response).catch(async (error) => {
      await record({ type: 'facility-failure', error: error.stack ?? error.message })
      response.destroy()
      onFailure(error)
    })
    operations.add(operation)
    void operation.finally(() => operations.delete(operation))
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  origin = `http://${host}:${server.address().port}`
  server.on('error', (error) => {
    if (!closing) {
      void record({ type: 'facility-failure', error: error.message })
      onFailure(error)
    }
  })
  await record({ type: 'source-ready', origin, scenario, advertisedVersion: servedVersion })
  if (logFailure) {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
    throw logFailure
  }
  return {
    origin,
    repairUrl: fault ? `${origin}/diagnostics/shutdown-fault` : undefined,
    get faultTriggered() {
      return faultTriggered
    },
    async close() {
      if (closing) return
      closing = true
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
      await Promise.allSettled([...operations])
      if (fault) {
        try {
          await fault.release('source-closed')
        } catch (error) {
          await record({ type: 'facility-failure', error: error.message })
          onFailure(error)
        }
      }
      await record({ type: 'source-closed', origin })
    }
  }
}
