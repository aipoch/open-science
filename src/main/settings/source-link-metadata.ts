import { lookup } from 'node:dns/promises'
import { get } from 'node:https'
import type { Socket } from 'node:net'
import { connect as connectTls } from 'node:tls'
import { aborted } from 'node:util'
import { runtimeNetwork } from '../runtime-network'
import { parseSystemProxyRules } from './system-proxy'
import type { IncomingMessage } from 'node:http'
import ipaddr from 'ipaddr.js'
import { parse, type DefaultTreeAdapterTypes } from 'parse5'
import { parseHttpsSourceUrl, type SourceLinkMetadata } from '../../shared/source-preview'
import {
  exceedsDecodedImagePixelLimit,
  isPixelLimitedRasterMimeType,
  readRasterImageDimensions
} from '../raster-image-safety'

const readResource = async (
  url: URL,
  kind: 'page' | 'image',
  signal: AbortSignal,
  redirects = 0
): Promise<{ bytes: Buffer; mime: string; url: URL }> => {
  if (
    !parseHttpsSourceUrl(url.href) ||
    url.port ||
    ipaddr.isValid(url.hostname.replace(/^\[|\]$/g, ''))
  )
    throw new Error('Destination unavailable')

  const cancellation = aborted(signal, url).then((): never => {
    throw signal.reason
  })
  const rules = await Promise.race([runtimeNetwork().resolveProxy(url.href), cancellation])
  signal.throwIfAborted()
  const environment = parseSystemProxyRules(rules)
  const proxy = environment.HTTPS_PROXY ?? environment.ALL_PROXY
  if (!proxy && !rules.split(';').some((rule) => rule.trim().toUpperCase() === 'DIRECT'))
    throw new Error('Proxy unavailable')
  const proxyUrl = proxy ? new URL(proxy) : undefined
  let address = url.hostname
  // SOCKS4 requires an IPv4 address; retain its existing validated local lookup.
  if (!proxyUrl || proxyUrl.protocol === 'socks4:') {
    const addresses = await Promise.race([lookup(url.hostname, { all: true }), cancellation])
    signal.throwIfAborted()
    const target = addresses[0]
    if (
      !target ||
      addresses.some(({ address }) => {
        const ip = ipaddr.parse(address)
        return (
          ip.range() !== 'unicast' ||
          /^198\.(18|19)\./.test(address) ||
          (ip.kind() === 'ipv6' && !/^[23]/.test(address))
        )
      })
    )
      throw new Error('Destination unavailable')
    address = target.address
  }
  let socket: Socket | undefined
  if (proxyUrl) {
    // Match the runtime transport: HTTP(S)/SOCKS5 proxies own destination DNS.
    const { tunnelThroughProxy } = await import('@aipoch/notebook-network-sandbox')
    socket = await tunnelThroughProxy(proxyUrl, address, 443, undefined, signal)
  }
  // Pin direct connections, retaining the original hostname for TLS in both paths.
  const connection = socket ? { socket } : { host: address, port: 443 }
  let response: IncomingMessage | undefined
  try {
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      get(
        url,
        {
          signal,
          createConnection: () => connectTls({ ...connection, servername: url.hostname }),
          headers: {
            Host: url.host,
            'User-Agent': 'Open-Science/1.0',
            Accept: kind === 'page' ? 'text/html' : 'image/png,image/jpeg,image/webp'
          }
        },
        resolve
      ).on('error', reject)
    })
    const status = response.statusCode ?? 0
    if ([301, 302, 303, 307, 308].includes(status) && redirects < 3 && response.headers.location) {
      return readResource(new URL(response.headers.location, url), kind, signal, redirects + 1)
    }
    const mime = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase() ?? ''
    if (
      status !== 200 ||
      (kind === 'page' ? mime !== 'text/html' : !isPixelLimitedRasterMimeType(mime))
    )
      throw new Error('Resource unavailable')

    const limit = kind === 'page' ? 128 * 1024 : 1024 * 1024
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of response) {
      const bytes = Buffer.from(chunk)
      chunks.push(bytes.subarray(0, limit - size))
      size += bytes.length
      if (kind === 'page' && (size >= limit || bytes.includes('</head>'))) break
      if (size > limit) throw new Error('Resource too large')
    }
    return { bytes: Buffer.concat(chunks), mime, url }
  } finally {
    response?.destroy()
    socket?.destroy()
  }
}

type Element = DefaultTreeAdapterTypes.Element
const children = (node: DefaultTreeAdapterTypes.ParentNode | undefined): Element[] =>
  node?.childNodes.filter((child): child is Element => 'tagName' in child) ?? []

let activeReads = 0
const pendingReads: Array<() => void> = []

async function acquireReadSlot(): Promise<void> {
  if (activeReads < 4) {
    activeReads++
    return
  }
  await new Promise<void>((resolve) => pendingReads.push(resolve))
}

function releaseReadSlot(): void {
  const next = pendingReads.shift()
  // Transfer the occupied slot directly so new arrivals cannot jump the queue.
  if (next) next()
  else activeReads--
}

export async function readSourceLinkMetadata(rawUrl: string): Promise<SourceLinkMetadata> {
  if (typeof rawUrl !== 'string' || rawUrl.length > 8192) return {}
  await acquireReadSlot()
  try {
    const signal = AbortSignal.timeout(8000)
    const page = await readResource(new URL(rawUrl), 'page', signal)
    const html = children(parse(page.bytes.toString('utf8'))).find(
      (node) => node.tagName === 'html'
    )
    const head = children(children(html).find((node) => node.tagName === 'head'))
    const fields = new Map<string, string>()
    for (const node of head) {
      if (node.tagName !== 'meta') continue
      const attrs = Object.fromEntries(node.attrs.map((attr) => [attr.name, attr.value]))
      const key = (attrs.property || attrs.name)?.toLowerCase()
      if (key && attrs.content?.trim() && !fields.has(key)) fields.set(key, attrs.content.trim())
    }
    const titleNode = head.find((node) => node.tagName === 'title')?.childNodes[0]
    const title =
      fields.get('og:title') ||
      (titleNode && 'value' in titleNode ? titleNode.value.trim() : undefined)
    const result: SourceLinkMetadata = {
      title: title?.slice(0, 300),
      description: (fields.get('og:description') || fields.get('description'))?.slice(0, 600)
    }
    const image = fields.get('og:image')
    const imageUrl = image ? URL.parse(image, page.url) : null
    if (imageUrl && parseHttpsSourceUrl(imageUrl.href)) result.imageUrl = imageUrl.href
    return result
  } catch {
    return {}
  } finally {
    releaseReadSlot()
  }
}

export async function readSourceLinkImage(rawUrl: string): Promise<string | undefined> {
  if (typeof rawUrl !== 'string' || rawUrl.length > 8192) return undefined
  await acquireReadSlot()
  try {
    const { bytes, mime } = await readResource(new URL(rawUrl), 'image', AbortSignal.timeout(8000))
    if (!isPixelLimitedRasterMimeType(mime)) return undefined
    const size = readRasterImageDimensions(bytes, mime)
    if (size && !exceedsDecodedImagePixelLimit(size))
      return `data:${mime};base64,${bytes.toString('base64')}`
  } catch {
    /* Artwork is optional. */
  } finally {
    releaseReadSlot()
  }
  return undefined
}
