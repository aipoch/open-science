export const abortableDelay = (ms: number, signal?: AbortSignal): Promise<void> => {
  signal?.throwIfAborted()
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))

  return new Promise((resolve, reject) => {
    const finish = (): void => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    const abort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}
