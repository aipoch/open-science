import { lookup } from 'node:dns/promises'
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { isIP, type Socket } from 'node:net'
import { checkServerIdentity, connect as connectTls } from 'node:tls'
import { tunnelThroughProxy } from '@aipoch/notebook-network-sandbox'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import type { Readable } from 'node:stream'
import ipaddr from 'ipaddr.js'
import { runtimeNetwork } from '../runtime-network'
import { abortable, WebToolError } from './errors'
import { WebSemaphore } from './limits'

export const WEB_FETCH_BODY_LIMIT = 5 * 1024 * 1024
export type WebResource = { body: Buffer; contentType: string; finalUrl: string }
export type WebTransport = (url: string, signal: AbortSignal) => Promise<WebResource>
type Address = { address: string; family: number }
export type WebTransportDependencies = {
  resolveProxy?: (url: string) => Promise<string>
  lookup?: (hostname: string) => Promise<Address[]>
  request?: typeof httpRequest
  httpsRequest?: typeof httpsRequest
  openProxyTunnel?: (
    proxy: URL,
    address: string,
    port: number,
    signal: AbortSignal,
    onSocket: (socket: Socket) => void
  ) => Promise<Socket>
}

// Consume one resolved route, never retry a proxy failure through DIRECT. Other protocols and
// fallback chains need their own destination-binding and authentication verification.
const httpProxyRoute = (directive: string): URL | undefined => {
  const value = directive.trim()
  if (value.toUpperCase() === 'DIRECT') return undefined
  const endpoint = /^PROXY\s+((?:\[[a-f\d:]+\]|[a-z\d._-]+):[1-9]\d{0,4})$/i.exec(value)?.[1]
  if (!endpoint) throw new WebToolError('NETWORK_MODE_UNSUPPORTED')
  try {
    return new URL(`http://${endpoint}`)
  } catch {
    throw new WebToolError('NETWORK_MODE_UNSUPPORTED')
  }
}

export const parseWebUrl = (value: string): URL => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new WebToolError('INVALID_INPUT')
  }
  if (
    value.length > 2048 ||
    [...value].some((point) => point.charCodeAt(0) <= 32 || point.charCodeAt(0) === 127)
  )
    throw new WebToolError('INVALID_INPUT')
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    /^https?:\/\/[^/?#]*@/i.test(value) ||
    url.username ||
    url.password ||
    (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80'))
  ) {
    throw new WebToolError('BLOCKED_TARGET')
  }
  for (const name of url.searchParams.keys()) {
    if (
      /^(?:x-amz-|x-goog-)|^(?:access[_-]?token|token|api[_-]?key|key|authorization|auth|password|passwd|secret|credential|signature|sig)$/i.test(
        name
      )
    ) {
      throw new WebToolError('BLOCKED_TARGET')
    }
  }
  if (url.searchParams.has('sv') && url.searchParams.has('sp') && url.searchParams.has('se')) {
    throw new WebToolError('BLOCKED_TARGET')
  }
  url.hash = ''
  if (url.href.length > 2048) throw new WebToolError('INVALID_INPUT')
  return url
}

const blockedV4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4'
].map((range) => ipaddr.IPv4.parseCIDR(range))

export const isPublicWebAddress = (value: string): boolean => {
  try {
    const address = ipaddr.parse(value)
    if (address.range() !== 'unicast') return false
    if (address.kind() === 'ipv4') {
      return !blockedV4.some(([network, bits]) => (address as ipaddr.IPv4).match(network, bits))
    }
    const ipv6 = address as ipaddr.IPv6
    // IPv4-mapped, transition, documentation and special-purpose allocations are disallowed.
    return (
      ipv6.match(ipaddr.IPv6.parse('2000::'), 3) &&
      !ipv6.match(ipaddr.IPv6.parse('2001::'), 23) &&
      !ipv6.match(ipaddr.IPv6.parse('2001:db8::'), 32) &&
      !ipv6.match(ipaddr.IPv6.parse('2002::'), 16) &&
      !ipv6.match(ipaddr.IPv6.parse('3fff::'), 20)
    )
  } catch {
    return false
  }
}

const domains = new Map<string, WebSemaphore>()
const domainSlot = (hostname: string): WebSemaphore => {
  let slot = domains.get(hostname)
  if (!slot) {
    slot = new WebSemaphore(2)
    domains.set(hostname, slot)
  }
  return slot
}

const readBody = async (response: IncomingMessage, signal: AbortSignal): Promise<Buffer> => {
  const encoding = response.headers['content-encoding']?.trim().toLowerCase()
  let stream: Readable = response
  if (encoding && encoding !== 'identity') {
    const decoder =
      encoding === 'gzip'
        ? createGunzip()
        : encoding === 'deflate'
          ? createInflate()
          : encoding === 'br'
            ? createBrotliDecompress()
            : undefined
    if (!decoder) throw new WebToolError('UNSUPPORTED_CONTENT_TYPE')
    response.on('error', (error) => decoder.destroy(error))
    stream = response.pipe(decoder)
  }
  const abort = (): void => {
    response.destroy()
    stream.destroy(signal.reason)
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const chunks: Buffer[] = []
    let size = 0
    for await (const part of stream) {
      signal.throwIfAborted()
      const chunk = Buffer.from(part)
      size += chunk.byteLength
      if (size > WEB_FETCH_BODY_LIMIT) throw new WebToolError('CONTENT_TOO_LARGE')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, size)
  } catch (error) {
    signal.throwIfAborted()
    throw error
  } finally {
    signal.removeEventListener('abort', abort)
    stream.destroy()
    response.destroy()
  }
}

export const createWebTransport = (dependencies: WebTransportDependencies = {}): WebTransport => {
  const resolveProxy =
    dependencies.resolveProxy ?? ((url: string) => runtimeNetwork().resolveProxy(url))
  const resolveAddresses =
    dependencies.lookup ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true }))
  return async (input, signal) => {
    let url = parseWebUrl(input)
    for (let hop = 0; hop <= 5; hop++) {
      signal.throwIfAborted()
      const release = await domainSlot(url.hostname).acquire(signal)
      let response: IncomingMessage | undefined
      let tunnel: Socket | undefined
      let agent: HttpAgent | HttpsAgent | undefined
      const abortTunnel = (): void => {
        tunnel?.destroy()
      }
      signal.addEventListener('abort', abortTunnel, { once: true })
      try {
        let proxy: string
        try {
          proxy = await abortable(resolveProxy(url.href), signal)
        } catch (error) {
          signal.throwIfAborted()
          throw error instanceof WebToolError ? error : new WebToolError('NETWORK_MODE_UNSUPPORTED')
        }
        const proxyUrl = httpProxyRoute(proxy)
        const hostname = url.hostname.replace(/^\[|\]$/g, '')
        const addresses = isIP(hostname)
          ? [{ address: hostname, family: isIP(hostname) }]
          : await abortable(resolveAddresses(hostname), signal)
        if (!addresses.length || addresses.some(({ address }) => !isPublicWebAddress(address))) {
          throw new WebToolError('BLOCKED_TARGET')
        }
        signal.throwIfAborted()
        const target = addresses[0]
        if (proxyUrl) {
          try {
            const openTunnel =
              dependencies.openProxyTunnel ??
              ((proxy, address, port, signal, onSocket) =>
                tunnelThroughProxy(proxy, address, port, undefined, signal, onSocket))
            tunnel = await openTunnel(
              proxyUrl,
              target.address,
              url.protocol === 'https:' ? 443 : 80,
              signal,
              (socket) => {
                tunnel = socket
                if (signal.aborted) socket.destroy()
              }
            )
            signal.throwIfAborted()
            if (url.protocol === 'https:') {
              const secure = connectTls({
                socket: tunnel,
                host: hostname,
                ...(isIP(hostname) ? {} : { servername: hostname }),
                rejectUnauthorized: true,
                checkServerIdentity: (_name, certificate) =>
                  checkServerIdentity(hostname, certificate),
                ALPNProtocols: ['http/1.1']
              })
              tunnel = secure
              await new Promise<void>((resolve, reject) => {
                secure.once('secureConnect', resolve)
                secure.once('error', reject)
                secure.once('close', () =>
                  reject(signal.aborted ? signal.reason : new WebToolError('NETWORK_ERROR', true))
                )
              })
            }
            signal.throwIfAborted()
            agent = url.protocol === 'https:' ? new HttpsAgent() : new HttpAgent()
            // One request, one preconnected tunnel. No pool or second DNS lookup may replace it.
            agent.createConnection = () => tunnel!
          } catch (error) {
            signal.throwIfAborted()
            if (
              error instanceof Error &&
              error.message === 'Parent proxy rejected the tunnel with status 407.'
            ) {
              throw new WebToolError('AUTH_REQUIRED')
            }
            throw error
          }
        }
        response = await new Promise<IncomingMessage>((resolve, reject) => {
          const request = (
            url.protocol === 'https:'
              ? (dependencies.httpsRequest ?? httpsRequest)
              : (dependencies.request ?? httpRequest)
          )(
            url,
            {
              agent: agent ?? false,
              family: target.family,
              signal,
              // Node connects only to the validated address, while URL retains Host and TLS SNI.
              lookup: (_hostname, _options, callback) =>
                callback(null, target.address, target.family),
              headers: {
                'User-Agent': 'Open-Science/1.0',
                Accept: 'text/html,application/xhtml+xml,text/plain,text/markdown',
                'Accept-Encoding': 'gzip,deflate,br'
              },
              maxHeaderSize: 16 * 1024
            },
            resolve
          )
          request.once('error', reject)
          request.end()
        })
        const status = response.statusCode ?? 0
        if ([301, 302, 303, 307, 308].includes(status)) {
          if (hop === 5 || !response.headers.location) throw new WebToolError('HTTP_ERROR')
          url = parseWebUrl(new URL(response.headers.location, url).href)
          continue
        }
        if (status < 200 || status >= 300)
          throw new WebToolError('HTTP_ERROR', status >= 500 || status === 429)
        const contentType = response.headers['content-type']?.toLowerCase() ?? ''
        const mime = contentType.split(';')[0].trim()
        if (
          ![
            'text/html',
            'application/xhtml+xml',
            'text/plain',
            'text/markdown',
            'text/x-markdown'
          ].includes(mime)
        ) {
          throw new WebToolError('UNSUPPORTED_CONTENT_TYPE')
        }
        return { body: await readBody(response, signal), contentType, finalUrl: url.href }
      } finally {
        signal.removeEventListener('abort', abortTunnel)
        response?.destroy()
        agent?.destroy()
        tunnel?.destroy()
        release()
      }
    }
    throw new WebToolError('HTTP_ERROR')
  }
}
