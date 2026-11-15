import { requestPublicHttps, type PublicDownloadTunnel } from '@aipoch/resilient-download'
import { MAX_IMAGE_BYTES } from './contract'

export async function downloadImageResult(
  url: string,
  signal: AbortSignal,
  options: {
    resolveProxy?: (url: string) => Promise<string | undefined>
    tunnel?: PublicDownloadTunnel
  } = {}
): Promise<Buffer> {
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await requestPublicHttps(url, signal, {
      ...options,
      accept: 'image/png,image/jpeg,image/webp'
    })
    try {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        if (!response.headers.location) throw new Error('Image redirect has no destination.')
        url = new URL(response.headers.location, url).href
        continue
      }
      if (response.statusCode !== 200) throw new Error('Image download failed.')
      if (Number(response.headers['content-length']) > MAX_IMAGE_BYTES)
        throw new Error('Image byte limit exceeded.')
      const chunks: Buffer[] = []
      let length = 0
      for await (const chunk of response) {
        signal.throwIfAborted()
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        length += bytes.length
        if (length > MAX_IMAGE_BYTES) throw new Error('Image byte limit exceeded.')
        chunks.push(bytes)
      }
      signal.throwIfAborted()
      return Buffer.concat(chunks, length)
    } finally {
      response.destroy()
    }
  }
  throw new Error('Image download redirected too many times.')
}
