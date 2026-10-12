/* eslint-disable @typescript-eslint/explicit-function-return-type -- Browser ESM; public types are in browser-import.d.ts. */
// Browser-only entry point: deliberately has no Node imports, daemon token, or remote downloader.
const MAX_BYTES = 2 * 1024 ** 3
const CHUNK_BYTES = 4 * 1024 ** 2
const hex = (bytes) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
const randomHex = () => hex(crypto.getRandomValues(new Uint8Array(32)))
const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })

/** Prepare a transfer from bytes already downloaded by the website. Open url from a user click,
 * then call send(). Its result acknowledges local receipt, not the user's eventual import decision.
 */
export function prepareBrowserImport(file, options = {}) {
  const origin = options.origin ?? globalThis.location?.origin
  const site = new URL(origin)
  const filename = options.filename ?? file?.name
  const port = options.port ?? 49152 + (crypto.getRandomValues(new Uint16Array(1))[0] % 16384)
  if (
    site.origin !== origin ||
    (site.protocol !== 'https:' &&
      !(site.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(site.hostname)))
  )
    throw new Error('Browser import requires an HTTPS website or loopback development origin.')
  if (globalThis.location && globalThis.location.origin !== origin)
    throw new Error('The import origin must match this page.')
  if (!(file instanceof Blob) || file.size <= 0 || file.size > MAX_BYTES)
    throw new Error('Choose a nonempty .science package no larger than 2 GiB.')
  if (
    typeof filename !== 'string' ||
    filename.length > 160 ||
    !/\.science$/i.test(filename) ||
    // eslint-disable-next-line no-control-regex -- Reject control characters in external filenames.
    /[\x00-\x1f\x7f/\\:*?"<>|\u202a-\u202e\u2066-\u2069]/u.test(filename) ||
    filename.startsWith('.') ||
    /[. ]$/.test(filename)
  )
    throw new Error('Invalid .science filename.')
  if (!Number.isInteger(port) || port < 49152 || port > 65535)
    throw new Error('Invalid loopback port.')
  const secret = randomHex()
  const url = `open-science://import?${new URLSearchParams({ version: '1', origin, secret, port: String(port), name: filename, size: String(file.size) })}`
  const base = `http://127.0.0.1:${port}/v1/import`
  const keyBytes = new Uint8Array(secret.match(/../g).map((part) => parseInt(part, 16)))
  const authKey = crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sign = async (message) =>
    hex(await crypto.subtle.sign('HMAC', await authKey, new TextEncoder().encode(message)))
  const authorize = async (method, path, digest = '') => ({
    Authorization: `HMAC ${await sign(`${method}\n/v1/import${path}\n${digest}`)}`
  })
  const cipherKey = crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(`open-science-encryption-v1:${secret}`))
    .then((bytes) => crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt']))
  let sending = false
  let received = false

  return Object.freeze({
    url,
    async send({ signal, onProgress, readyTimeoutMs = 120_000 } = {}) {
      if (!Number.isFinite(readyTimeoutMs) || readyTimeoutMs <= 0)
        throw new Error('Invalid receiver timeout.')
      if (sending) throw new Error('This browser transfer is already running.')
      if (received) return { received: true }
      signal?.throwIfAborted()
      sending = true
      let verified = false
      const request = (path, init = {}) =>
        fetch(base + path, {
          mode: 'cors',
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          targetAddressSpace: 'loopback',
          ...init,
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000)
        })
      try {
        const deadline = Date.now() + Math.max(1, Math.min(readyTimeoutMs, 300_000))
        const challenge = randomHex()
        let response
        while (Date.now() < deadline) {
          signal?.throwIfAborted()
          try {
            response = await request(`/ready?challenge=${challenge}`)
            break
          } catch {
            signal?.throwIfAborted()
            await wait(250, signal)
          }
        }
        if (!response)
          throw new Error(
            'Open-Science did not become ready. Open the app, allow local network access, and retry.'
          )
        let ready
        try {
          ready = await response.json()
        } catch {
          throw new Error('Could not verify the local receiver identity.')
        }
        const expected = await sign(
          `open-science-import-v1:${challenge}:${ready.offset}:${ready.accepted ? 1 : 0}`
        )
        if (!response.ok || ready.proof !== expected)
          throw new Error(
            'Could not verify the local receiver identity. Prepare a new transfer and reopen Open-Science.'
          )
        verified = true
        if (
          !Number.isSafeInteger(ready.offset) ||
          ready.offset < 0 ||
          ready.offset > file.size ||
          ready.chunkBytes !== CHUNK_BYTES
        )
          throw new Error('Invalid local transfer response.')
        if (!ready.accepted) {
          for (let offset = ready.offset; offset < file.size;) {
            signal?.throwIfAborted()
            const bytes = await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer()
            const digest = hex(await crypto.subtle.digest('SHA-256', bytes))
            const iv = crypto.getRandomValues(new Uint8Array(12))
            const encrypted = await crypto.subtle.encrypt(
              { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`offset:${offset}`) },
              await cipherKey,
              bytes
            )
            const body = new Uint8Array(12 + encrypted.byteLength)
            body.set(iv)
            body.set(new Uint8Array(encrypted), 12)
            const chunk = await request(`/chunk?offset=${offset}`, {
              method: 'PUT',
              body,
              headers: {
                ...(await authorize('PUT', `/chunk?offset=${offset}`, digest)),
                'Content-Type': 'application/octet-stream',
                'X-Chunk-SHA256': digest
              }
            })
            if (!chunk.ok) throw new Error(`Local package transfer failed (${chunk.status}).`)
            const result = await chunk.json()
            if (
              result.offset !== offset + bytes.byteLength ||
              result.proof !== (await sign(`offset:${result.offset}`))
            )
              throw new Error('Invalid local transfer offset.')
            offset = result.offset
            onProgress?.({ sentBytes: offset, totalBytes: file.size })
          }
          const complete = await request('/complete', {
            method: 'POST',
            headers: await authorize('POST', '/complete')
          })
          const receipt = await complete.json()
          if (
            complete.status !== 202 ||
            receipt.received !== true ||
            receipt.proof !== (await sign(`received:${file.size}`))
          )
            throw new Error('Open-Science did not acknowledge the complete package.')
        }
        received = true
        return { received: true }
      } catch (error) {
        if (verified && signal?.aborted) {
          await fetch(base, {
            method: 'DELETE',
            mode: 'cors',
            credentials: 'omit',
            redirect: 'error',
            headers: await authorize('DELETE', ''),
            signal: AbortSignal.timeout(2000),
            targetAddressSpace: 'loopback'
          }).catch(() => undefined)
        }
        throw error
      } finally {
        sending = false
      }
    }
  })
}
