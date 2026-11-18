import { lookup } from 'node:dns/promises'
import { Agent, get } from 'node:https'
import { connect as connectTls } from 'node:tls'
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { BlockList, isIP } from 'node:net'

export type PublicDownloadTunnel = (
  proxy: URL,
  address: string,
  port: number,
  signal: AbortSignal
) => Promise<Duplex>

const privateAddresses = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const)
  privateAddresses.addSubnet(address, prefix, 'ipv4')

export const isPublicDownloadAddress = (address: string): boolean =>
  isIP(address) === 4
    ? !privateAddresses.check(address, 'ipv4')
    : isIP(address) === 6 && /^[23][0-9a-f]{3}:/iu.test(address)

const fakeIpPlaceholderAddresses = new BlockList()
fakeIpPlaceholderAddresses.addSubnet('198.18.0.0', 15, 'ipv4')

// Mihomo/Clash commonly allocates placeholders here. A separate upstream proxy may
// not share the local hostname mapping, so it needs the hostname instead.
const isFakeIpPlaceholder = (address: string): boolean =>
  isIP(address) === 4 && fakeIpPlaceholderAddresses.check(address, 'ipv4')

export const publicDownloadUrl = (value: string): URL => {
  const url = new URL(value)
  const hostname = url.hostname.replace(/\.$/u, '')
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    isIP(hostname.replace(/^\[|\]$/gu, '')) ||
    !hostname.includes('.') ||
    hostname.split('.').includes('') ||
    /\.(localhost|local|internal)$/iu.test(hostname)
  )
    throw new Error('Download links must use public HTTPS URLs.')
  url.hostname = hostname
  return url
}

// No application credentials or cookies. Callers own redirects and bounded body consumption.
export async function requestPublicHttps(
  rawUrl: string,
  signal: AbortSignal,
  options: {
    accept?: string
    resolveProxy?: (url: string) => Promise<string | undefined>
    tunnel?: PublicDownloadTunnel
    allowProxyHostnameResolution?: boolean
  } = {}
): Promise<IncomingMessage> {
  signal.throwIfAborted()
  const url = publicDownloadUrl(rawUrl)
  const proxy = await options.resolveProxy?.(url.href)
  signal.throwIfAborted()
  const agent = proxy ? new Agent({ keepAlive: false }) : undefined
  if (agent && proxy) {
    const target = url
    agent.createConnection = (_options, callback) => {
      void lookup(target.hostname, { all: true })
        .then(async (addresses) => {
          signal.throwIfAborted()
          if (!addresses.length)
            throw new Error('Download host did not resolve to a public address.')
          const publicAddresses = addresses.filter(
            ({ address }) => isPublicDownloadAddress(address) && !isFakeIpPlaceholder(address)
          )
          if (publicAddresses.length) {
            if (publicAddresses.length !== addresses.length)
              throw new Error('Download host did not resolve to a public address.')
          } else if (
            !options.allowProxyHostnameResolution ||
            !addresses.every(({ address }) => isFakeIpPlaceholder(address))
          ) {
            // A mixed or private answer must not enable proxy-side resolution.
            throw new Error('Download host did not resolve to a public address.')
          }
          if (!options.tunnel)
            throw new Error('A proxy tunnel adapter is required for proxied downloads.')
          // A uniform fake-ip answer carries no routable address, so CONNECT to the
          // publisher hostname and let the upstream proxy resolve it remotely.
          const destination = publicAddresses[0]?.address ?? target.hostname
          const socket = await options.tunnel(new URL(proxy), destination, 443, signal)
          if (signal.aborted) {
            socket.destroy()
            signal.throwIfAborted()
          }
          // TLS authenticates the publisher hostname, not whether its final IP is public.
          return connectTls({ socket, servername: target.hostname })
        })
        .then(
          (socket) => callback?.(null, socket),
          (error: Error) => callback?.(error, undefined!)
        )
      return undefined
    }
  }
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = get(
      url,
      {
        signal,
        ...(agent ? { agent } : {}),
        headers: {
          Accept: options.accept ?? '*/*',
          'User-Agent': 'Open-Science/1.0'
        },
        lookup: (hostname, options, callback) => {
          void lookup(hostname, { all: true }).then(
            (addresses) => {
              const address = addresses.find((entry) => isPublicDownloadAddress(entry.address))
              if (!address || addresses.some((entry) => !isPublicDownloadAddress(entry.address))) {
                callback(new Error('Download host did not resolve to a public address.'), '', 4)
              } else callback(null, options.all ? addresses : address.address, address.family)
            },
            (error: Error) => callback(error, '', 4)
          )
        }
      },
      resolve
    )
    request.on('error', reject)
  }).catch((error: unknown) => {
    agent?.destroy()
    throw error
  })
  response.once('close', () => agent?.destroy())
  return response
}
