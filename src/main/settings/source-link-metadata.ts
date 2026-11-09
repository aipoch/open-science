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
import { notebookNetworkSettingsAllowDomain } from '../../shared/notebook-network'
import type { NotebookNetworkSettings } from '../../shared/notebook-network-settings'
import { parseHttpsSourceUrl, type SourceLinkMetadata } from '../../shared/source-preview'
import {
  exceedsDecodedImagePixelLimit,
  isPixelLimitedRasterMimeType,
  readRasterImageDimensions
} from '../raster-image-safety'

const readResource = async (
  url: URL,
  settings: NotebookNetworkSettings,
  kind: 'page' | 'image',
  signal: AbortSignal,
  redirects = 0
): Promise<{ bytes: Buffer; mime: string; url: URL }> => {
  if (
    !parseHttpsSourceUrl(url.href) ||
    url.port ||
    ipaddr.isValid(url.hostname.replace(/^\[|\]$/g, '')) ||
    !notebookNetworkSettingsAllowDomain(settings, url.hostname)
  )
    throw new Error('Destination unavailable')

  // Pin the address for both direct connections and proxy CONNECT. Preserve the
  // original hostname for certificate verification and TLS server selection.
  const [rules, addresses] = await Promise.race([
    Promise.all([runtimeNetwork().resolveProxy(url.href), lookup(url.hostname, { all: true })]),
    aborted(signal, url).then((): never => {
      throw signal.reason
    })
  ])
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
  const environment = parseSystemProxyRules(rules)
  const proxy = environment.HTTPS_PROXY ?? environment.ALL_PROXY
  if (!proxy && !rules.split(';').some((rule) => rule.trim().toUpperCase() === 'DIRECT'))
    throw new Error('Proxy unavailable')
  let socket: Socket | undefined
  if (proxy) {
    const { tunnelThroughProxy } = await import('@aipoch/notebook-network-sandbox')
    socket = await tunnelThroughProxy(new URL(proxy), target.address, 443, undefined, signal)
  }
  const connection = socket ? { socket } : { host: target.address, port: 443 }
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
            Accept: kind === 'page' ? 'text/html' : 'image/png,image/jpeg,image/webp'
          }
        },
        resolve
      ).on('error', reject)
    })
    const status = response.statusCode ?? 0
    if ([301, 302, 303, 307, 308].includes(status) && redirects < 3 && response.headers.location) {
      return readResource(
        new URL(response.headers.location, url),
        settings,
        kind,
        signal,
        redirects + 1
      )
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
export async function readSourceLinkMetadata(
  rawUrl: string,
  settings: NotebookNetworkSettings
): Promise<SourceLinkMetadata> {
  if (typeof rawUrl !== 'string' || rawUrl.length > 8192 || activeReads >= 4) return {}
  activeReads++
  try {
    const signal = AbortSignal.timeout(8000)
    const page = await readResource(new URL(rawUrl), settings, 'page', signal)
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
    if (image) {
      try {
        const { bytes, mime } = await readResource(
          new URL(image, page.url),
          settings,
          'image',
          signal
        )
        if (isPixelLimitedRasterMimeType(mime)) {
          const size = readRasterImageDimensions(bytes, mime)
          if (size && !exceedsDecodedImagePixelLimit(size))
            result.image = `data:${mime};base64,${bytes.toString('base64')}`
        }
      } catch {
        /* Artwork is optional. */
      }
    }
    return result
  } catch {
    return {}
  } finally {
    activeReads--
  }
}
