import { requestPublicHttps, type PublicDownloadTunnel } from '@aipoch/resilient-download'
import { isLoopbackProviderBaseUrl, iterateBoundedResponseBody } from '@aipoch/providers/transport'
import { MAX_IMAGE_BYTES } from './contract'

const accept = 'image/png,image/jpeg,image/webp'
const redirects = [301, 302, 303, 307, 308]
type ReserveDelivery = (bytes: number) => Promise<void> | undefined

async function readDownloadBytes(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  reserveDelivery?: ReserveDelivery
): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of body) {
    signal.throwIfAborted()
    length += chunk.byteLength
    if (length > MAX_IMAGE_BYTES) throw new Error('Image byte limit exceeded.')
    const reservation = reserveDelivery?.(length)
    if (reservation) await reservation
    chunks.push(chunk)
  }
  signal.throwIfAborted()
  return Buffer.concat(chunks, length)
}

export async function downloadImageResult(
  url: string,
  signal: AbortSignal,
  options: {
    providerUrl?: string
    reserveDelivery?: ReserveDelivery
    resolveProxy?: (url: string) => Promise<string | undefined>
    tunnel?: PublicDownloadTunnel
  } = {}
): Promise<Buffer> {
  const { providerUrl, reserveDelivery, ...publicOptions } = options
  if (providerUrl && isLoopbackProviderBaseUrl(providerUrl)) {
    const result = new URL(url, providerUrl)
    if (result.origin === new URL(providerUrl).origin)
      return downloadLoopbackImage(result, signal, reserveDelivery)
  }
  for (let hop = 0; hop <= 5; hop++) {
    const response = await requestPublicHttps(url, signal, {
      ...publicOptions,
      accept
    })
    try {
      if (redirects.includes(response.statusCode ?? 0)) {
        if (!response.headers.location) throw new Error('Image redirect has no destination.')
        url = new URL(response.headers.location, url).href
        continue
      }
      if (response.statusCode !== 200) throw new Error('Image download failed.')
      if (Number(response.headers['content-length']) > MAX_IMAGE_BYTES)
        throw new Error('Image byte limit exceeded.')
      return await readDownloadBytes(response, signal, reserveDelivery)
    } finally {
      response.destroy()
    }
  }
  throw new Error('Image download redirected too many times.')
}

async function downloadLoopbackImage(
  url: URL,
  signal: AbortSignal,
  reserveDelivery?: ReserveDelivery
): Promise<Buffer> {
  const origin = url.origin
  for (let hop = 0; hop <= 5; hop++) {
    if (
      !isLoopbackProviderBaseUrl(url.href) ||
      url.origin !== origin ||
      url.username ||
      url.password
    )
      throw new Error('Image result URL must remain on the configured loopback origin.')
    const response = await fetch(url, {
      redirect: 'manual',
      credentials: 'omit',
      headers: { accept },
      signal
    })
    if (response.status === 200)
      return readDownloadBytes(
        iterateBoundedResponseBody(response, MAX_IMAGE_BYTES, 'Image download', signal),
        signal,
        reserveDelivery
      )
    await response.body?.cancel().catch(() => undefined)
    const redirect = response.headers.get('location')
    if (!redirects.includes(response.status) || !redirect) throw new Error('Image download failed.')
    url = new URL(redirect, url)
  }
  throw new Error('Image download redirected too many times.')
}
