import { createHash } from 'node:crypto'

// ACP runtimes currently disagree on which client errors are retryable. Keep the provider-facing
// contract as an explicit allowlist: only status codes that describe an unchanged request as
// invalid or unauthorized are suppressed. Unknown and potentially transient 4xx statuses retain
// the upstream retry behavior.
const DETERMINISTIC_PROVIDER_ERROR_STATUS_CODES = new Set([
  400, 401, 402, 403, 404, 405, 406, 407, 410, 411, 413, 414, 415, 416, 417, 421, 422, 426, 428,
  431, 451
])
const DEFAULT_TTL_MS = 30_000
const DEFAULT_MAX_ENTRIES = 32
const DEFAULT_ERROR_BODY_MAX_BYTES = 256 * 1024
const DEFAULT_ERROR_BODY_TIMEOUT_MS = 10_000

type BoundedProviderErrorBody = Readonly<{
  body: Buffer
  complete: boolean
}>

type BoundedProviderErrorBodyOptions = Readonly<{
  maxBytes?: number
  signal?: AbortSignal
  timeoutMs?: number
}>

const isDeterministicProviderErrorStatus = (status: number): boolean =>
  DETERMINISTIC_PROVIDER_ERROR_STATUS_CODES.has(status)

// Codex, Claude Code, and OpenCode all retry at least some deterministic 4xx statuses. A local 400
// makes the failure terminal sooner; bridge-specific diagnostics retain the real upstream status.
const providerErrorClientStatus = (upstreamStatus: number): number =>
  isDeterministicProviderErrorStatus(upstreamStatus) ? 400 : upstreamStatus

const providerRequestFingerprint = (...parts: readonly string[]): string => {
  const hash = createHash('sha256')
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part, 'utf8')))
    hash.update(':')
    hash.update(part)
  }
  return hash.digest('hex')
}

const providerRequestHeadersFingerprint = (
  source: Headers | Readonly<Record<string, string>>
): string => {
  const entries = source instanceof Headers ? [...source.entries()] : Object.entries(source)
  entries.sort(([left], [right]) => left.toLowerCase().localeCompare(right.toLowerCase()))
  return providerRequestFingerprint(
    ...entries.flatMap(([name, value]) => [name.toLowerCase(), value])
  )
}

const readBoundedProviderErrorBody = async (
  response: Response,
  options: BoundedProviderErrorBodyOptions = {}
): Promise<BoundedProviderErrorBody> => {
  const maxBytes = options.maxBytes ?? DEFAULT_ERROR_BODY_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_ERROR_BODY_TIMEOUT_MS
  const contentLength = response.headers.get('content-length')
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    return { body: Buffer.alloc(0), complete: false }
  }
  if (!response.body) return { body: Buffer.alloc(0), complete: true }
  if (options.signal?.aborted) {
    await response.body.cancel().catch(() => undefined)
    throw options.signal.reason ?? new DOMException('The request was aborted.', 'AbortError')
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  let timeout: ReturnType<typeof setTimeout> | undefined
  let removeAbortListener: (() => void) | undefined
  const stopped = new Promise<'aborted' | 'timeout'>((resolve) => {
    timeout = setTimeout(() => resolve('timeout'), timeoutMs)
    if (options.signal) {
      const onAbort = (): void => resolve('aborted')
      options.signal.addEventListener('abort', onAbort, { once: true })
      removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort)
    }
  })

  try {
    while (true) {
      const result = await Promise.race([
        reader.read().then((value) => ({ kind: 'read' as const, value })),
        stopped.then((kind) => ({ kind }))
      ])
      if (result.kind !== 'read') {
        await reader.cancel().catch(() => undefined)
        if (result.kind === 'aborted') {
          throw options.signal?.reason ?? new DOMException('The request was aborted.', 'AbortError')
        }
        return { body: Buffer.alloc(0), complete: false }
      }
      if (result.value.done) return { body: Buffer.concat(chunks, byteLength), complete: true }
      if (!result.value.value) continue
      byteLength += result.value.value.byteLength
      if (byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return { body: Buffer.alloc(0), complete: false }
      }
      chunks.push(result.value.value)
    }
  } finally {
    if (timeout) clearTimeout(timeout)
    removeAbortListener?.()
    reader.releaseLock()
  }
}

class DeterministicProviderErrorReplay<T> {
  private readonly entries = new Map<string, { expiresAt: number; value: T }>()

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly now: () => number = Date.now
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  remember(key: string, upstreamStatus: number, value: T): boolean {
    if (!isDeterministicProviderErrorStatus(upstreamStatus)) return false
    this.entries.delete(key)
    this.entries.set(key, { expiresAt: this.now() + this.ttlMs, value })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (typeof oldest !== 'string') break
      this.entries.delete(oldest)
    }
    return true
  }

  clear(): void {
    this.entries.clear()
  }
}

export {
  DeterministicProviderErrorReplay,
  isDeterministicProviderErrorStatus,
  providerErrorClientStatus,
  providerRequestFingerprint,
  providerRequestHeadersFingerprint,
  readBoundedProviderErrorBody
}
