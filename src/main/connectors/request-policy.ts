export const CONNECTOR_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

export const boundedExponentialBackoff = (attempt: number, baseMs = 400, maxMs = 4_000): number =>
  Math.min(baseMs * 2 ** attempt, maxMs)

export const connectorRetryDelay = (
  attempt: number,
  retryAfter: string | null,
  baseMs = 400
): number => {
  const retryAfterSeconds = retryAfter ? Number(retryAfter) : Number.NaN
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1_000, 5_000)
  }
  return boundedExponentialBackoff(attempt, baseMs) + Math.random() * baseMs
}

export const withTimeoutSignal = async <Result>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  operation: (requestSignal: AbortSignal) => Promise<Result>
): Promise<Result> => {
  signal?.throwIfAborted()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
  try {
    return await operation(requestSignal)
  } finally {
    clearTimeout(timer)
  }
}
