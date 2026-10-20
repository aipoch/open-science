const FILE_REPLACEMENT_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const

const isRetryableFileReplacementError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  ['EPERM', 'EACCES', 'EBUSY'].includes(String(error.code))

const retryFileReplacement = async (
  replace: () => Promise<void>,
  wait: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs))
): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await replace()
      return
    } catch (error) {
      const delayMs = FILE_REPLACEMENT_RETRY_DELAYS_MS[attempt]
      if (delayMs === undefined || !isRetryableFileReplacementError(error)) throw error
      await wait(delayMs)
    }
  }
}

export { retryFileReplacement }
