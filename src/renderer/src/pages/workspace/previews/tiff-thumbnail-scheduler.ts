type TiffThumbnailScheduler = {
  schedule: <Result>(signal: AbortSignal, task: () => Promise<Result>) => Promise<Result>
}

const createAbortError = (): Error =>
  new DOMException('TIFF thumbnail decoding was cancelled', 'AbortError')

const createTiffThumbnailScheduler = (maxConcurrent: number): TiffThumbnailScheduler => {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new Error('TIFF thumbnail concurrency must be a positive integer')
  }

  let active = 0
  const queue: Array<() => void> = []

  const drain = (): void => {
    while (active < maxConcurrent) {
      const start = queue.shift()
      if (!start) return
      start()
    }
  }

  const schedule = <Result>(signal: AbortSignal, task: () => Promise<Result>): Promise<Result> =>
    new Promise<Result>((resolve, reject) => {
      if (signal.aborted) {
        reject(createAbortError())
        return
      }

      let started = false
      const start = (): void => {
        started = true
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) {
          reject(createAbortError())
          drain()
          return
        }

        active += 1
        void Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active -= 1
            drain()
          })
      }
      const onAbort = (): void => {
        if (started) return
        const index = queue.indexOf(start)
        if (index >= 0) queue.splice(index, 1)
        reject(createAbortError())
      }

      signal.addEventListener('abort', onAbort, { once: true })
      queue.push(start)
      drain()
    })

  return { schedule }
}

const tiffThumbnailScheduler = createTiffThumbnailScheduler(2)

export { createTiffThumbnailScheduler, tiffThumbnailScheduler }
export type { TiffThumbnailScheduler }
