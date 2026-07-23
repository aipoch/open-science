type RequestReader<Input, Output> = (input: Input) => Promise<Output>

// The returned callable exposes active-key updates so the view can invalidate queued work when files
// are collapsed or filtered out without attempting to cancel IPC reads that have already started.
type KeyedRequestReader<Input, Output> = RequestReader<Input, Output> & {
  setActiveKeys(keys: ReadonlySet<string>): void
}

type KeyedRequestGenerationOptions<Input, Output> = {
  // A generation usually represents the active project. Starting a request in a new generation makes
  // older queued requests stale before they consume an IPC concurrency slot.
  getGenerationKey: (input: Input) => string
  createCanceledResult: (input: Input) => Output
}

/**
 * Creates a bounded, deduplicating request queue with stale-work suppression.
 *
 * Concurrent calls with the same key share one promise. Queued work is skipped when its generation is
 * no longer current or its key left the view's active set. The pump is deliberately iterative: a large
 * collapsed page can cancel thousands of queued previews without recursively growing the call stack.
 */
const createKeyedRequestReader = <Input, Output>(
  read: RequestReader<Input, Output>,
  getKey: (input: Input) => string,
  maxConcurrency: number,
  generationOptions?: KeyedRequestGenerationOptions<Input, Output>
): KeyedRequestReader<Input, Output> => {
  let activeCount = 0
  let currentGenerationKey: string | undefined
  let activeKeys: ReadonlySet<string> | undefined
  const pending: Array<() => void> = []
  const inFlight = new Map<string, Promise<Output>>()

  const pump = (): void => {
    while (activeCount < maxConcurrency) {
      const run = pending.shift()
      if (!run) return
      activeCount += 1
      run()
    }
  }

  const enqueue = (input: Input, key: string, generationKey: string | undefined): Promise<Output> =>
    new Promise((resolve, reject) => {
      pending.push(() => {
        if (
          generationOptions &&
          ((generationKey !== undefined && generationKey !== currentGenerationKey) ||
            (activeKeys !== undefined && !activeKeys.has(key)))
        ) {
          // Do not call pump recursively here. This callback runs inside pump's while loop, which will
          // observe the decremented count and continue with the next canceled item in constant stack.
          resolve(generationOptions.createCanceledResult(input))
          activeCount -= 1
          return
        }

        void read(input)
          .then(resolve, reject)
          .finally(() => {
            activeCount -= 1
            pump()
          })
      })
      pump()
    })

  const reader = ((input: Input) => {
    const generationKey = generationOptions?.getGenerationKey(input)
    if (generationKey !== undefined) currentGenerationKey = generationKey

    const key = getKey(input)
    // Deduplication covers active and queued requests, preventing repeated React effects from reading
    // the same file version more than once.
    const existing = inFlight.get(key)
    if (existing) return existing

    const promise = enqueue(input, key, generationKey)
    inFlight.set(key, promise)
    const clear = (): void => {
      if (inFlight.get(key) === promise) inFlight.delete(key)
    }
    void promise.then(clear, clear)
    return promise
  }) as KeyedRequestReader<Input, Output>
  reader.setActiveKeys = (keys): void => {
    // Copy the caller's set so later renderer mutations cannot change queue policy by aliasing.
    activeKeys = new Set(keys)
  }

  return reader
}

export { createKeyedRequestReader }
export type { KeyedRequestGenerationOptions, KeyedRequestReader, RequestReader }
