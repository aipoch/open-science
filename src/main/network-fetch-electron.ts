import { net } from 'electron'
import { Readable } from 'node:stream'

// Use Chromium's proxy-aware network stack for host requests.
export const netFetch: typeof fetch = (input, init) => net.fetch(input as string, init)

// Keep resolution lazy for host composition; standalone consumers can inject global fetch.
export const netFetchStandard = ((input, init) => {
  if (net?.fetch) return net.fetch(input as string, init)
  return globalThis.fetch(input, init)
}) as typeof fetch

// Electron 39 net.fetch does not expose manual redirect responses: its fetch adapter never
// handles ClientRequest's redirect event. This GET-only adapter preserves the Chromium proxy
// while returning the redirect for the caller to validate BEFORE contacting the next host.
// Existing fetch callers keep their original behavior; validated download callers opt in.
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
    let incomingBody: Readable | undefined
    const cleanup = (): void => request.signal.removeEventListener('abort', abort)
    const abort = (): void => {
      cleanup()
      reject(request.signal.reason)
      // Reject body readers as well as requests still awaiting headers.
      incomingBody?.destroy(
        request.signal.reason instanceof Error
          ? request.signal.reason
          : new Error(String(request.signal.reason))
      )
      outgoing.abort()
    }
    request.signal.addEventListener('abort', abort, { once: true })
    // ClientRequest can close before its response body finishes. Keep cancellation
    // attached until the response ends, rather than using the outgoing close event.
    outgoing.on('error', (error) => {
      cleanup()
      incomingBody?.destroy(error)
      reject(error)
    })
    outgoing.on('redirect', (status, _method, location) => {
      cleanup()
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
        if (![204, 205, 304].includes(incoming.statusCode)) {
          incomingBody = incoming as unknown as Readable
          incomingBody.once('end', cleanup)
          incomingBody.once('close', cleanup)
        } else cleanup()
        const body = incomingBody
          ? (Readable.toWeb(incomingBody) as ReadableStream<Uint8Array>)
          : null
        resolve(new Response(body, { status: incoming.statusCode, headers }))
      } catch (error) {
        cleanup()
        reject(error)
        outgoing.abort()
      }
    })
    request.headers.forEach((value, name) => outgoing.setHeader(name, value))
    outgoing.end()
  })
}
