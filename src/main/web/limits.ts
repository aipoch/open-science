/** A slot is transferred directly to the next waiter; abort never consumes a slot. */
export class WebSemaphore {
  private active = 0
  private readonly waiting: Array<() => void> = []
  constructor(private readonly limit: number) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const grant = (): void => {
          signal.removeEventListener('abort', abort)
          resolve()
        }
        const abort = (): void => {
          const index = this.waiting.indexOf(grant)
          if (index >= 0) this.waiting.splice(index, 1)
          reject(signal.reason)
        }
        this.waiting.push(grant)
        signal.addEventListener('abort', abort, { once: true })
      })
    } else this.active++
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
    }
    if (signal.aborted) {
      release()
      signal.throwIfAborted()
    }
    return release
  }
}

/** Shared across search and fetch: a session has at most three executing Web calls. */
export class WebSessionSlots {
  private readonly sessions = new Map<string, { semaphore: WebSemaphore; users: number }>()

  async acquire(sessionId: string, signal: AbortSignal): Promise<() => void> {
    let entry = this.sessions.get(sessionId)
    if (!entry) {
      entry = { semaphore: new WebSemaphore(3), users: 0 }
      this.sessions.set(sessionId, entry)
    }
    const captured = entry
    captured.users++
    const finish = (): void => {
      captured.users--
      if (captured.users === 0 && this.sessions.get(sessionId) === captured)
        this.sessions.delete(sessionId)
    }
    let release: () => void
    try {
      release = await captured.semaphore.acquire(signal)
    } catch (error) {
      finish()
      throw error
    }
    let released = false
    return () => {
      if (released) return
      released = true
      release()
      finish()
    }
  }
}
