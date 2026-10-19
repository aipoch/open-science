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

/** Stable codes let websites show recovery guidance without parsing English messages. */
export class BrowserImportError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BrowserImportError'
    this.code = code
  }
}

/** Request app launch synchronously from a user click; return does not prove OS delivery. */
export function launchOpenScience() {
  if (typeof globalThis.location?.assign !== 'function')
    throw new BrowserImportError(
      'unsupported-browser',
      'This environment cannot open Open-Science.'
    )
  try {
    globalThis.location.assign('open-science://open')
  } catch {
    throw new BrowserImportError('launch-failed', 'Could not request opening Open-Science.')
  }
}

const supported = () =>
  typeof Blob === 'function' &&
  typeof fetch === 'function' &&
  !!globalThis.crypto?.subtle &&
  typeof globalThis.AbortSignal?.any === 'function'
const validOrigin = (origin) => {
  const site = new URL(origin)
  if (
    site.origin !== origin ||
    (site.protocol !== 'https:' &&
      !(site.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(site.hostname)))
  )
    throw new Error('Browser import requires an HTTPS website or loopback development origin.')
  if (globalThis.location && globalThis.location.origin !== origin)
    throw new Error('The import origin must match this page.')
  return origin
}
// Explicitly dispose timers after every request/deadline; response body reads share the budget.
const bounded = async (signal, timeoutMs, work) => {
  const controller = new AbortController()
  const timer = setTimeout(
    () =>
      controller.abort(
        new BrowserImportError('timeout', 'Open-Science did not become ready in time.')
      ),
    timeoutMs
  )
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  try {
    combined.throwIfAborted()
    return await work(combined)
  } finally {
    clearTimeout(timer)
  }
}
const discoveryRequest = async (options) => {
  validOrigin(options.origin ?? globalThis.location?.origin)
  const port = options.port ?? 49151
  const timeoutMs = options.timeoutMs ?? 2000
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 300_000
  )
    throw new Error('Invalid discovery options.')
  return bounded(options.signal, timeoutMs, async (signal) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/browser-import/capabilities`, {
      method: 'GET',
      signal,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      targetAddressSpace: 'loopback'
    })
    const value = await response.json()
    if (
      !response.ok ||
      !value ||
      value.service !== 'open-science-browser-import' ||
      value.version !== 1
    )
      return { status: 'incompatible' }
    return { status: 'available' }
  })
}
const discover = async (options) => {
  if (!supported()) return { status: 'unsupported-browser' }
  try {
    return await discoveryRequest(options)
  } catch (error) {
    if (options.signal?.aborted) return { status: 'aborted' }
    if (error.code === 'timeout' || error.name === 'TimeoutError') return { status: 'timeout' }
    if (error.name === 'NotAllowedError') return { status: 'unavailable' }
    if (error instanceof SyntaxError) return { status: 'incompatible' }
    // Browsers deliberately conflate connection refusal, CORS and local-network denial.
    if (error instanceof TypeError) return { status: 'unavailable' }
    throw error
  }
}
/** Advisory discovery only; the secret-bound handshake still authenticates every transfer. */
export const checkBrowserImportAvailability = (options = {}) => discover(options)
/** Prepare a transfer from bytes already downloaded by the website. Open url from a user click,
 * then call send(). Its result acknowledges local receipt, not the user's eventual import decision.
 */
export function prepareBrowserImport(file, options = {}) {
  const origin = options.origin ?? globalThis.location?.origin
  if (!supported())
    throw new BrowserImportError(
      'unsupported-browser',
      'This browser cannot transfer packages to Open-Science.'
    )
  validOrigin(origin)
  const filename = options.filename ?? file?.name
  const port = options.port ?? 49152 + (crypto.getRandomValues(new Uint16Array(1))[0] % 16384)
  if (!(file instanceof Blob) || file.size <= 0 || file.size > MAX_BYTES)
    throw new Error('Choose a nonempty .science package no larger than 2 GiB.')
  if (
    typeof filename !== 'string' ||
    filename.length > 160 ||
    new TextEncoder().encode(filename).byteLength > 255 ||
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(filename) ||
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
  let cancelled

  return Object.freeze({
    url,
    async send({
      signal,
      onProgress,
      onPhase,
      readinessMode = 'attempts',
      readyTimeoutMs = 120_000,
      readinessAttempts = 5,
      attemptTimeoutMs = 2000
    } = {}) {
      if (!['attempts', 'wait-for-launch'].includes(readinessMode))
        throw new Error('Invalid readiness mode.')
      const waitingForLaunch = readinessMode === 'wait-for-launch'
      if (!Number.isFinite(readyTimeoutMs) || readyTimeoutMs <= 0)
        throw new Error('Invalid receiver timeout.')
      if (
        (!waitingForLaunch &&
          (!Number.isInteger(readinessAttempts) ||
            readinessAttempts < 1 ||
            readinessAttempts > 5)) ||
        !Number.isFinite(attemptTimeoutMs) ||
        attemptTimeoutMs <= 0 ||
        attemptTimeoutMs > 30_000
      )
        throw new Error('Invalid readiness retry options.')
      if (sending) throw new Error('This browser transfer is already running.')
      if (cancelled) throw cancelled
      if (received) return { received: true }
      signal?.throwIfAborted()
      sending = true
      let verified = false
      const request = async (path, init = {}) => {
        const response = await fetch(base + path, {
          mode: 'cors',
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          targetAddressSpace: 'loopback',
          ...init,
          signal: AbortSignal.any(
            [signal, init.signal ?? AbortSignal.timeout(30_000)].filter(Boolean)
          )
        })
        if (response.status === 410) {
          const value = await response.json().catch(() => {
            throw new BrowserImportError(
              'incompatible',
              'Could not verify the local receiver identity.'
            )
          })
          if (value?.code !== 'cancelled' || value.proof !== (await sign('cancelled')))
            throw new BrowserImportError(
              'incompatible',
              'Could not verify the local receiver identity.'
            )
          cancelled = new BrowserImportError(
            'cancelled',
            'The transfer was cancelled in Open-Science. Prepare a new transfer to try again.'
          )
          throw cancelled
        }
        return response
      }
      try {
        onPhase?.('waiting-for-receiver')
        // Browser protocol prompts have no observable completion event. Only this secret's proof
        // ends launch waiting; the bounded deadline covers requests, body reads and retry gaps.
        const budget = Math.min(readyTimeoutMs, waitingForLaunch ? 120_000 : 300_000)
        const attemptBudget = waitingForLaunch ? Math.min(attemptTimeoutMs, 2000) : attemptTimeoutMs
        const deadline = Date.now() + budget
        const ready = await bounded(signal, budget, async (readySignal) => {
          for (let attempt = 0; waitingForLaunch || attempt < readinessAttempts; attempt++) {
            readySignal.throwIfAborted()
            try {
              return await bounded(readySignal, attemptBudget, async (attemptSignal) => {
                const challenge = randomHex()
                const response = await request(`/ready?challenge=${challenge}`, {
                  signal: attemptSignal
                })
                const value = await response.json()
                if (
                  !value ||
                  typeof value !== 'object' ||
                  typeof value.accepted !== 'boolean' ||
                  !Number.isSafeInteger(value.offset) ||
                  value.offset < 0 ||
                  value.offset > file.size ||
                  value.chunkBytes !== CHUNK_BYTES
                )
                  throw new BrowserImportError(
                    'incompatible',
                    'Could not verify the local receiver identity.'
                  )
                const expected = await sign(
                  `open-science-import-v1:${challenge}:${value.offset}:${value.accepted ? 1 : 0}`
                )
                attemptSignal.throwIfAborted()
                if (Date.now() >= deadline)
                  throw new BrowserImportError(
                    'timeout',
                    'Open-Science did not become ready in time.'
                  )
                if (!response.ok || value.proof !== expected)
                  throw new BrowserImportError(
                    'incompatible',
                    'Could not verify the local receiver identity. Prepare a new transfer and reopen Open-Science.'
                  )
                return value
              })
            } catch (error) {
              readySignal.throwIfAborted()
              if (error.code === 'incompatible' || error.code === 'cancelled') throw error
              if (error instanceof SyntaxError)
                throw new BrowserImportError(
                  'incompatible',
                  'Could not verify the local receiver identity.'
                )
              if (waitingForLaunch || attempt + 1 < readinessAttempts) await wait(1000, readySignal)
            }
          }
          throw new BrowserImportError(
            'readiness-exhausted',
            'Open-Science did not become ready. Open the app, allow local network access, and retry.'
          )
        })
        verified = true
        if (
          !Number.isSafeInteger(ready.offset) ||
          ready.offset < 0 ||
          ready.offset > file.size ||
          ready.chunkBytes !== CHUNK_BYTES
        )
          throw new Error('Invalid local transfer response.')
        if (!ready.accepted) {
          onPhase?.('transferring')
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
        signal?.throwIfAborted()
        if (error.code === 'cancelled' || error.code === 'incompatible') throw error
        if (verified)
          throw new BrowserImportError(
            'transfer-failed',
            'The local package transfer failed. Retry while the receiver is available.'
          )
        throw error
      } finally {
        sending = false
      }
    }
  })
}
