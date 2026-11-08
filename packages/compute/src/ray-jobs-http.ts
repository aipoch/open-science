import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'

function dashboard(endpoint: string): URL {
  let base: URL
  try {
    base = new URL(endpoint)
  } catch {
    throw new Error('Invalid Ray Dashboard endpoint.')
  }
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error('Invalid Ray Dashboard endpoint.')
  return base
}

/** Resolve once for approval; use the pinned endpoint for subsequent requests. */
export function resolveRayJobsEndpoint(explicit?: string, saved?: string): string {
  const address =
    explicit?.trim() ||
    saved?.trim() ||
    process.env.RAY_DASHBOARD_URL?.trim() ||
    'http://127.0.0.1:8265'
  return dashboard(address).href.replace(/\/+$/, '')
}

/** Preserve a configured gateway path when addressing the Jobs API. */
export function rayJobsUrl(endpoint: string, path: string): URL {
  const base = dashboard(endpoint)
  if (
    !path.startsWith('/api/') ||
    /[?#\\]/.test(path) ||
    path
      .split('/')
      .some((part) => !/^([a-zA-Z0-9._~-]*)$/.test(part) || part === '.' || part === '..')
  )
    throw new Error('Invalid Ray Dashboard endpoint or API path.')
  base.pathname = base.pathname.replace(/\/+$/, '') + path
  return base
}

/** Ray refuses browser-tagged writes. Use a server-side HTTP client; never follow redirects. */
export async function rayNodeRequest(url: URL, init: RequestInit = {}): Promise<Response> {
  init.signal?.throwIfAborted()
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Invalid Ray request URL.')
  const body = init.body instanceof Blob ? new Uint8Array(await init.body.arrayBuffer()) : init.body
  if (body != null && typeof body !== 'string' && !(body instanceof Uint8Array))
    throw new Error('Unsupported Ray request body.')
  const headers: Record<string, string> = {}
  new Headers(init.headers).forEach((v, k) => {
    headers[k] = v
  })
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest
    const request = send(
      url,
      { method: init.method ?? 'GET', headers, signal: init.signal ?? AbortSignal.timeout(30_000) },
      (res) => {
        const status = res.statusCode ?? 0
        if (status < 200 || status >= 600 || (status >= 300 && status < 400)) {
          res.destroy()
          reject(new Error(`Unexpected Ray Dashboard response (HTTP ${status}).`))
          return
        }
        const headers = new Headers()
        for (let i = 0; i < res.rawHeaders.length; i += 2)
          headers.append(res.rawHeaders[i], res.rawHeaders[i + 1])
        const empty = status === 204 || status === 205 || init.method === 'HEAD'
        if (empty) res.resume()
        resolve(
          new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
            status,
            headers
          })
        )
      }
    )
    request.once('error', reject)
    request.end(body)
  })
}
