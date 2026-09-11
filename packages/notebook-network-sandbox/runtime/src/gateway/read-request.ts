import type { IncomingMessage } from 'node:http'
import { domainToASCII } from 'node:url'

export const MAX_TARGET_BYTES = 8192
export const MAX_HEADER_BYTES = 16384
export type ReadRequestDecision =
  | { kind: 'read'; headers: Record<string, string> }
  | { kind: 'invalid' | 'approval' | 'limit'; reason: string }

// Header bytes include every field's original whitespace and CRLF, plus the final CRLF,
// but not the request line. The TLS ingress measures these before Node normalizes fields.
export function inspectReadRequest(
  request: IncomingMessage,
  host: string,
  headerBytes: number
): ReadRequestDecision {
  const target = request.url ?? ''
  if (Buffer.byteLength(target, 'latin1') > MAX_TARGET_BYTES || headerBytes > MAX_HEADER_BYTES)
    return { kind: 'limit', reason: 'request-limit' }
  // Raw request-target control bytes are forbidden by the HTTP grammar.
  // eslint-disable-next-line no-control-regex
  const invalidTarget = /[#\x00-\x20\x7f]/.test(target)
  if (!target.startsWith('/') || invalidTarget || request.httpVersion !== '1.1')
    return { kind: 'invalid', reason: 'invalid-target' }
  const fields = new Map<string, string>()
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i]!.toLowerCase()
    if (fields.has(name)) return { kind: 'invalid', reason: 'duplicate-header' }
    fields.set(name, request.rawHeaders[i + 1]!)
  }
  const authority = fields.get('host')
  if (!authority || !/^[a-z0-9.-]+(?::443)?$/i.test(authority))
    return { kind: 'invalid', reason: 'invalid-host' }
  if (domainToASCII(authority.replace(/:443$/, '').replace(/\.$/, '').toLowerCase()) !== host)
    return { kind: 'invalid', reason: 'host-mismatch' }
  if (fields.has('content-length') && fields.has('transfer-encoding'))
    return { kind: 'invalid', reason: 'ambiguous-framing' }
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return { kind: 'approval', reason: 'method-needs-approval' }
  const headers: Record<string, string> = { host, 'user-agent': 'Open-Science/1.0' }
  for (const [name, value] of fields) {
    switch (name) {
      case 'host':
      case 'user-agent':
        break
      case 'accept':
        if (
          ![
            '*/*',
            'application/json',
            'application/octet-stream',
            'text/plain',
            'text/csv'
          ].includes(value)
        )
          return { kind: 'approval', reason: 'header-needs-approval' }
        headers[name] = value
        break
      case 'accept-encoding':
        if (
          !/^(?:identity|gzip|deflate|br|zstd)(?:\s*,\s*(?:identity|gzip|deflate|br|zstd))*$/i.test(
            value
          )
        )
          return { kind: 'approval', reason: 'header-needs-approval' }
        headers[name] = value
        break
      case 'range': {
        const range = /^bytes=(\d+)-(\d*)$/.exec(value)
        if (!range || (range[2] && BigInt(range[1]!) > BigInt(range[2])))
          return { kind: 'approval', reason: 'header-needs-approval' }
        headers[name] = value
        break
      }
      case 'content-length':
        if (value !== '0') return { kind: 'approval', reason: 'body-needs-approval' }
        break
      case 'connection':
        if (!/^(close|keep-alive)$/i.test(value))
          return { kind: 'approval', reason: 'header-needs-approval' }
        break
      default:
        return { kind: 'approval', reason: 'header-needs-approval' }
    }
  }
  return { kind: 'read', headers }
}
