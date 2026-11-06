/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'

export const FEED_URL = 'http://127.0.0.1:18761/'
export const assertAutomaticUpdate = (observation, expected) => {
  if (
    !observation.process ||
    observation.process.pid === expected.sourcePid ||
    observation.process.startedAt < expected.appliedAt ||
    observation.process.executable !== expected.executable
  )
    throw new Error('Target did not automatically start with the expected process identity')
  if (observation.launchedByHarness !== false)
    throw new Error('Harness launch cannot satisfy automatic update')
  if (observation.version !== expected.version) throw new Error('Wrong target version')
  if (!observation.nativeWindowVisible || !observation.rendererReady || !observation.backendReady)
    throw new Error('Target window and backend are not ready')
  if (
    observation.configRoot !== expected.configRoot ||
    observation.profilePath !== expected.profilePath
  )
    throw new Error('Original profile was not preserved')
  if (
    observation.project?.id !== expected.project.id ||
    observation.project.name !== expected.project.name ||
    observation.session?.id !== expected.session.id ||
    observation.session.messages?.[0]?.content !== expected.session.content
  )
    throw new Error('Saved project/session contents were lost')
  if (observation.sentinelIdentity !== expected.sentinelIdentity)
    throw new Error('Another installation was terminated or replaced')
  if (
    !observation.sentinelBackendReady ||
    !observation.sentinelWindowVisible ||
    !observation.sentinelDataPreserved
  )
    throw new Error('Another installation lost window, backend, or saved data')
  if (!observation.feedRequests || !observation.packageBytes)
    throw new Error('Isolated update feed was not used')
  return { status: 'passed', version: observation.version, automatic: true }
}
export const digest = async (path, algorithm = 'sha256', encoding = 'hex') => {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest(encoding)
}
export const startFeed = async (assets, port = 18761) => {
  const metrics = { feedRequests: 0, packageBytes: 0 }
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url, FEED_URL).pathname
      const file = assets.get(pathname)
      if (!file || !['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(404).end()
        return
      }
      const { size } = await stat(file)
      let start = 0
      let end = size - 1
      const range = request.headers.range
      if (range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range)
        if (!match || +match[1] >= size || (match[2] && +match[2] < +match[1])) {
          response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
          return
        }
        start = +match[1]
        end = match[2] ? Math.min(+match[2], size - 1) : size - 1
      }
      const headers = {
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream'
      }
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
      response.writeHead(range ? 206 : 200, headers)
      if (request.method === 'HEAD') {
        response.end()
        return
      }
      if (pathname.endsWith('.yml')) metrics.feedRequests += 1
      const stream = createReadStream(file, { start, end })
      stream.on('data', (chunk) => {
        if (pathname.endsWith('.zip')) metrics.packageBytes += chunk.length
      })
      stream.on('error', (error) => response.destroy(error))
      response.once('close', () => stream.destroy())
      stream.pipe(response)
    })().catch((error) => response.destroy(error))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    metrics,
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
  }
}
