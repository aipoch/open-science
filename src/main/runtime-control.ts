import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { loadOrCreateWebToken } from './web-service/auth'
import { writeDurableJsonFile } from './storage/durable-json-file'
import type { DesktopEndpoint } from './desktop-connection'

export const RUNTIME_OWNER_FILE = 'runtime-owner.json'
export type RuntimeOwnerRecord = Readonly<{
  schemaVersion: 1
  generation: string
  pid: number
  host: 'node' | 'electron'
  port: number
  desktop?: DesktopEndpoint
}>

// Config-directory ownership must already be held. This endpoint only starts the existing Web
// transport; it never accepts business commands or process-termination requests.
export async function startRuntimeControl(
  configRoot: string,
  host: RuntimeOwnerRecord['host'],
  ensureWeb: (port: number) => Promise<unknown>,
  desktop?: DesktopEndpoint
): Promise<{ close(): Promise<void> }> {
  const token = Buffer.from(await loadOrCreateWebToken(configRoot))
  const generation = randomUUID()
  const path = join(configRoot, RUNTIME_OWNER_FILE)
  const server = createServer((request, response) => {
    const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '')
    if (supplied.length !== token.length || !timingSafeEqual(supplied, token)) {
      response.writeHead(401)
      response.end()
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.headers['x-open-science-runtime-generation'] !== generation) {
      response.writeHead(409)
      response.end()
      return
    }
    if (request.method === 'GET' && url.pathname === '/owner') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ generation, pid: process.pid }))
      return
    }
    const port = Number(url.searchParams.get('port'))
    if (
      request.method !== 'POST' ||
      url.pathname !== '/web/start' ||
      !url.searchParams.has('port') ||
      !Number.isInteger(port) ||
      port < 0 ||
      port > 65535 ||
      (request.headers['content-length'] && request.headers['content-length'] !== '0') ||
      request.headers['transfer-encoding']
    ) {
      response.writeHead(400)
      response.end()
      return
    }
    void ensureWeb(port).then(
      () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ generation, pid: process.pid }))
      },
      () => {
        response.writeHead(503)
        response.end()
      }
    )
  })
  server.headersTimeout = 5_000
  server.requestTimeout = 5_000
  server.maxHeadersCount = 16
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    token.fill(0)
    try {
      const current = JSON.parse(await readFile(path, 'utf8')) as RuntimeOwnerRecord
      if (current.generation === generation) await rm(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  try {
    await writeDurableJsonFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        generation,
        pid: process.pid,
        host,
        port: (server.address() as { port: number }).port,
        ...(desktop ? { desktop } : {})
      } satisfies RuntimeOwnerRecord)
    )
  } catch (error) {
    await close()
    throw error
  }
  return { close }
}
