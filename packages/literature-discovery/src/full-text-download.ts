import { LiteratureProviderError } from './provider-error.js'
import {
  publicDownloadUrl as fullTextUrl,
  isPublicDownloadAddress as isPublicFullTextAddress,
  requestPublicHttps,
  type PublicDownloadTunnel
} from '@aipoch/resilient-download'
export { fullTextUrl, isPublicFullTextAddress }
export type ProxyTunnel = PublicDownloadTunnel
import type { LiteratureFullTextProgress } from './contracts.js'

export class FullTextRateLimitError extends Error {
  constructor(readonly retryAt: number) {
    super(
      `Full-text source is rate limited. Retry no earlier than ${new Date(retryAt).toISOString()}.`
    )
  }
}
const retryAfterByOrigin = new Map<string, number>()

// Pin public DNS answers, including after redirects. Uniform fake-IP answers delegate
// resolution and final-address policy to the configured proxy. Never send application
// cookies or provider credentials to a PDF host.
export const downloadFullText = async (
  rawUrl: string,
  maxBytes: number,
  onProgress?: (progress: LiteratureFullTextProgress) => void,
  resolveProxy?: (url: string) => Promise<string | undefined>,
  requestSignal?: AbortSignal,
  tunnel?: ProxyTunnel,
  options: { accept?: string; timeoutMs?: number } = {}
): Promise<Buffer> => {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000)
  const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout
  signal.throwIfAborted()
  let url = fullTextUrl(rawUrl)
  const origin = url.origin
  for (const [host, until] of retryAfterByOrigin)
    if (until <= Date.now()) retryAfterByOrigin.delete(host)
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    signal.throwIfAborted()
    // Europe PMC's article route can return a browser challenge. Use its current PDF
    // API directly while retaining the reviewed candidate URL and attachment provenance.
    const europeArticle = /^\/articles\/(PMC\d+)\/?$/u.exec(url.pathname)
    if (
      ['europepmc.org', 'www.europepmc.org'].includes(url.hostname) &&
      europeArticle &&
      url.searchParams.get('pdf') === 'render'
    ) {
      url = new URL(`https://europepmc.org/api/getPdf?pmcid=${europeArticle[1]}`)
    }
    const retryAt = retryAfterByOrigin.get(url.origin) ?? retryAfterByOrigin.get(origin)
    if (retryAt && retryAt > Date.now()) throw new FullTextRateLimitError(retryAt)
    const response = await requestPublicHttps(url.href, signal, {
      accept: options.accept ?? 'application/pdf',
      resolveProxy,
      tunnel,
      allowProxyHostnameResolution: true
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
      throw new LiteratureProviderError(response.statusCode ?? 0)
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
      signal.throwIfAborted()
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += bytes.length
      if (length > maxBytes) {
        response.destroy()
        throw new Error('Full-text PDF exceeds the size limit.')
      }
      chunks.push(bytes)
      report()
    }
    signal.throwIfAborted()
    return Buffer.concat(chunks)
  }
  throw new Error('Full-text download redirected too many times.')
}
