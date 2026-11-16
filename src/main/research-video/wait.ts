/** Stop waiting without abandoning ownership of any work started by the callback. */
export async function waitForFilmStep<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => aborted.reject(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([
      aborted.promise,
      Promise.resolve().then(() => {
        signal.throwIfAborted()
        return work()
      })
    ])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
