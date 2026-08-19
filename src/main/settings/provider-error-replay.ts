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
  providerRequestFingerprint
}
