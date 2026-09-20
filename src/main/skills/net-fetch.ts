import { net } from 'electron'
import { Readable } from 'node:stream'

import type { FetchLike } from './github-import'

// Routes GitHub skill imports through Electron's Chromium network stack, which honors the system/VPN
// proxy the user's browser uses. Node's global fetch (undici) ignores that proxy and takes a direct
// path, so in proxied environments GitHub returns 403 for the direct requests while net.fetch succeeds.
export const netFetch: FetchLike = (url, init) =>
  net.fetch(url, init) as unknown as ReturnType<FetchLike>

// A `typeof fetch`-shaped view of net.fetch for callers that need the full Response API (`.text()`,
// AbortSignal, arbitrary headers) rather than the narrow FetchLike shape — e.g. the provider-validation
// probe, which reads the error body and aborts on timeout. Same proxy-honoring Chromium stack. A lazy
// arrow wrapper (like netFetch) so `net.fetch` is only read at call time — reading it eagerly at module
// load crashes any test whose electron mock omits `net` — while the method call preserves the receiver.
// The fallback keeps standalone non-Electron consumers and descriptor tests injectable.
export const netFetchStandard = ((input, init) => {
  if (net?.fetch) return net.fetch(input as string, init)
  return globalThis.fetch(input, init)
}) as typeof fetch

// Electron 39 net.fetch does not expose manual redirect responses: its fetch adapter never
// handles ClientRequest's redirect event. This GET-only adapter preserves the Chromium proxy
// while returning the redirect for the caller to validate BEFORE contacting the next host.
// Existing fetch callers keep their original behavior; only Marketplace downloads opt in.
export const netFetchWithManualRedirect: typeof fetch = (input, init) => {
  if (init?.redirect !== 'manual' || !net?.request) return netFetchStandard(input, init)
  const request = new Request(input, init)
  if (request.method !== 'GET' || request.body)
    return Promise.reject(new Error('Only GET is supported'))
  if (request.signal.aborted) return Promise.reject(request.signal.reason)
  return new Promise<Response>((resolve, reject) => {
    const outgoing = net.request({
      url: request.url,
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit'
    })
    const abort = (): void => {
      reject(request.signal.reason)
      outgoing.abort()
    }
    request.signal.addEventListener('abort', abort, { once: true })
    outgoing.once('close', () => request.signal.removeEventListener('abort', abort))
    outgoing.on('error', reject)
    outgoing.on('redirect', (status, _method, location) => {
      resolve(new Response(null, { status, headers: { location } }))
      outgoing.abort()
    })
    outgoing.once('response', (incoming) => {
      try {
        const headers = new Headers()
        for (const [name, values] of Object.entries(incoming.headers)) {
          if (values !== undefined)
            headers.set(name, Array.isArray(values) ? values.join(', ') : values)
        }
        const body = [204, 205, 304].includes(incoming.statusCode)
          ? null
          : (Readable.toWeb(incoming as unknown as Readable) as ReadableStream<Uint8Array>)
        resolve(new Response(body, { status: incoming.statusCode, headers }))
      } catch (error) {
        reject(error)
        outgoing.abort()
      }
    })
    request.headers.forEach((value, name) => outgoing.setHeader(name, value))
    outgoing.end()
  })
}
