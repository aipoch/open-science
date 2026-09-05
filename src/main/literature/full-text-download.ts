import { lookup } from 'node:dns/promises'
import { get } from 'node:https'
import { BlockList, isIP } from 'node:net'
import type { LiteratureFullTextProgress } from '../../shared/literature'

export class FullTextRateLimitError extends Error {
  constructor(readonly retryAt: number) {
    super('Full-text source is rate limited. Try again later.')
  }
}
const retryAfterByOrigin = new Map<string, number>()

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

export const isPublicFullTextAddress = (address: string): boolean =>
  isIP(address) === 4
    ? !privateAddresses.check(address, 'ipv4')
    : isIP(address) === 6 && /^[23][0-9a-f]{3}:/iu.test(address)

export const fullTextUrl = (value: string): URL => {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    isIP(url.hostname.replace(/^\[|\]$/gu, '')) ||
    !url.hostname.includes('.') ||
    /\.(localhost|local|internal)$/iu.test(url.hostname)
  )
    throw new Error('Full-text links must use public HTTPS URLs.')
  return url
}

// Resolve and pin a public address for every connection, including redirects. Never send
// application cookies or provider credentials to a PDF host.
// ponytail: downloads use direct HTTPS; proxy-only networks need a proxy transport that
// preserves destination validation before this can honor the application's proxy settings.
export const downloadFullText = async (
  rawUrl: string,
  maxBytes: number,
  onProgress?: (progress: LiteratureFullTextProgress) => void
): Promise<Buffer> => {
  const signal = AbortSignal.timeout(60_000)
  let url = fullTextUrl(rawUrl)
  const origin = url.origin
  for (const [host, until] of retryAfterByOrigin)
    if (until <= Date.now()) retryAfterByOrigin.delete(host)
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const retryAt = retryAfterByOrigin.get(url.origin) ?? retryAfterByOrigin.get(origin)
    if (retryAt && retryAt > Date.now()) throw new FullTextRateLimitError(retryAt)
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const request = get(
        url,
        {
          signal,
          headers: { Accept: 'application/pdf', 'User-Agent': 'OpenScience/1.0' },
          lookup: (hostname, options, callback) => {
            void lookup(hostname, { all: true }).then(
              (addresses) => {
                const address = addresses.find((entry) => isPublicFullTextAddress(entry.address))
                if (
                  !address ||
                  addresses.some((entry) => !isPublicFullTextAddress(entry.address))
                ) {
                  callback(new Error('Full-text host did not resolve to a public address.'), '', 4)
                } else callback(null, options.all ? addresses : address.address, address.family)
              },
              (error: Error) => callback(error, '', 4)
            )
          }
        },
        resolve
      )
      request.on('error', reject)
    })
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      response.destroy()
      if (!response.headers.location) throw new Error('Full-text redirect has no destination.')
      url = fullTextUrl(new URL(response.headers.location, url).href)
      continue
    }
    if (response.statusCode !== 200) {
      response.destroy()
      if (response.statusCode === 429) {
        const header = response.headers['retry-after']
        const now = Date.now()
        const until = header
          ? /^\d+$/u.test(header)
            ? now + Number(header) * 1000
            : Date.parse(header)
          : NaN
        const retryAt = Number.isFinite(until) && until > now ? until : now + 60_000
        retryAfterByOrigin.set(origin, retryAt)
        retryAfterByOrigin.set(url.origin, retryAt)
        throw new FullTextRateLimitError(retryAt)
      }
      throw new Error(`Full-text download failed with HTTP ${response.statusCode}.`)
    }
    if (Number(response.headers['content-length']) > maxBytes) {
      response.destroy()
      throw new Error('Full-text PDF exceeds the size limit.')
    }
    const chunks: Buffer[] = []
    let length = 0
    const size = Number(response.headers['content-length'])
    const totalBytes = Number.isSafeInteger(size) && size > 0 ? size : undefined
    const started = performance.now()
    const report = (): void =>
      onProgress?.({
        receivedBytes: length,
        totalBytes,
        bytesPerSecond: length / Math.max((performance.now() - started) / 1000, 0.001),
        phase: 'downloading'
      })
    report()
    for await (const chunk of response) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += bytes.length
      if (length > maxBytes) {
        response.destroy()
        throw new Error('Full-text PDF exceeds the size limit.')
      }
      chunks.push(bytes)
      report()
    }
    return Buffer.concat(chunks)
  }
  throw new Error('Full-text download redirected too many times.')
}
