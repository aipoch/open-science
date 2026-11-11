import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIPv4 } from 'node:net'
import { Readable } from 'node:stream'

export interface RayJobsTarget {
  endpoint: string
  fetch?: typeof fetch
  /** Resolve credentials for this exact canonical Dashboard, including its gateway path. */
  getToken?: (endpoint: string) => Promise<string | undefined>
}

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
  // URL keeps a bare '?' or '#' in href even though its search/hash accessor is empty.
  base.search = ''
  base.hash = ''
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

function allowsBearer(base: URL): boolean {
  return (
    base.protocol === 'https:' ||
    base.hostname === '[::1]' ||
    (isIPv4(base.hostname) && base.hostname.startsWith('127.'))
  )
}

export function isRayBearerEndpoint(endpoint: string): boolean {
  try {
    return allowsBearer(dashboard(endpoint))
  } catch {
    return false
  }
}

/** Preserve a configured gateway path when addressing the Jobs API. */
function rayJobsUrl(base: URL, path: string): URL {
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

/** These failures occur before the request reaches the Dashboard. */
export class RayRequestCredentialError extends Error {}

/** Resolve the token before each request so a rotation takes effect without changing the approved target. */
export async function requestRayDashboard(
  target: RayJobsTarget,
  path: string,
  init: RequestInit & { signal: AbortSignal },
  onDispatch?: () => void
): Promise<Response> {
  const base = dashboard(target.endpoint)
  const endpoint = base.href.replace(/\/+$/, '')
  const url = rayJobsUrl(base, path)
  const { signal } = init
  signal.throwIfAborted()
  const transport = target.fetch ?? rayNodeRequest
  const send = (options: RequestInit): Promise<Response> => {
    onDispatch?.()
    return transport(url, options)
  }
  const options = { ...init, redirect: 'error' } as const
  if (!target.getToken) return send(options)

  let rejectLookup!: () => void
  const interrupted = new Promise<never>((_, reject) => {
    rejectLookup = () => reject(signal.reason)
  })
  signal.addEventListener('abort', rejectLookup, { once: true })
  let token: string | undefined
  try {
    token = await Promise.race([target.getToken(endpoint), interrupted])
  } catch {
    signal.throwIfAborted()
    throw new RayRequestCredentialError('Unable to read the Ray Dashboard access token.')
  } finally {
    signal.removeEventListener('abort', rejectLookup)
  }
  signal.throwIfAborted()
  if (token === undefined) return send(options)
  if (!allowsBearer(url))
    throw new RayRequestCredentialError(
      'Ray Dashboard tokens require HTTPS or a loopback IP address.'
    )
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token))
    throw new RayRequestCredentialError('Invalid Ray Dashboard access token.')
  const headers = new Headers(init.headers)
  headers.set('authorization', 'Bearer ' + token)
  try {
    return await send({ ...options, headers })
  } catch {
    signal.throwIfAborted()
    throw new Error('Authenticated Ray Dashboard request failed.')
  }
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
