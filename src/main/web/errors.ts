import type { WebErrorCode } from '../../shared/web-tools'

export class WebToolError extends Error {
  constructor(
    readonly code: WebErrorCode,
    readonly retryable = false
  ) {
    // Deliberately omit upstream response bodies, credentials and network diagnostics.
    super(code)
    this.name = 'WebToolError'
  }
}

export const abortable = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  // Callers may already have started a promise before discovering cancellation. Join its rejection
  // even in that case; otherwise aborting SDK background requests leaves an unhandled rejection.
  if (signal.aborted) {
    void promise.catch(() => undefined)
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
