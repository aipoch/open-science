export type ComputeRuntimePassResult = Readonly<{
  hasWork: boolean
  nextWakeAfterMs?: number
}>

type RuntimeLoopOptions = Readonly<{
  run(signal: AbortSignal): Promise<boolean | ComputeRuntimePassResult>
  onError(error: unknown): void
  activeIntervalMs: number
}>

export type ComputeRuntimeLoop = Readonly<{
  readonly signal: AbortSignal | undefined
  start(): void
  wake(beforeQueuedPass?: () => void): Promise<void>
  tick(): Promise<void>
  pause(): Promise<void>
  resume(): void
  stop(): Promise<void>
}>

/**
 * Runs a durable reconciliation pass immediately, then keeps a short timer only while the pass
 * observes work. Callers provide a longer shared fallback for out-of-band writes and restart gaps.
 */
export const createComputeRuntimeLoop = (options: RuntimeLoopOptions): ComputeRuntimeLoop => {
  let controller: AbortController | undefined
  let interval: ReturnType<typeof setInterval> | undefined
  let wakeTimer: ReturnType<typeof setTimeout> | undefined
  let wakeDueAt: number | undefined
  let active: Promise<void> | undefined
  let stopped = false
  let paused = false
  let queuedWake: Promise<void> | undefined
  let queuedWakeCallbacks: (() => void)[] = []

  const clearActiveTimer = (): void => {
    if (!interval) return
    clearInterval(interval)
    interval = undefined
  }

  const clearWakeTimer = (): void => {
    if (wakeTimer) clearTimeout(wakeTimer)
    wakeTimer = undefined
    wakeDueAt = undefined
  }

  const scheduleWakeTimer = (delayMs: number | undefined): void => {
    if (delayMs === undefined || !controller || paused || stopped) return
    const dueAt = Date.now() + Math.max(0, delayMs)
    if (wakeTimer && wakeDueAt !== undefined && wakeDueAt <= dueAt) return
    clearWakeTimer()
    wakeDueAt = dueAt
    wakeTimer = setTimeout(
      () => {
        wakeTimer = undefined
        wakeDueAt = undefined
        void tick()
      },
      Math.max(0, dueAt - Date.now())
    )
    wakeTimer.unref?.()
  }

  const scheduleActiveTimer = (): void => {
    if (interval || !controller || paused || stopped) return
    interval = setInterval(() => void tick(), options.activeIntervalMs)
    interval.unref?.()
  }

  const tick = (): Promise<void> => {
    if (!controller || paused || stopped) return Promise.resolve()
    if (active) return active
    const signal = controller.signal
    const task = options
      .run(signal)
      .then((result) => {
        const pass = typeof result === 'boolean' ? { hasWork: result } : result
        if (pass.hasWork) {
          clearWakeTimer()
          scheduleActiveTimer()
        } else {
          clearActiveTimer()
          scheduleWakeTimer(pass.nextWakeAfterMs)
        }
      })
      .catch((error) => {
        options.onError(error)
        // A failed pass may have missed work. Keep the active cadence until the next successful
        // pass, then let that pass return to the idle fallback.
        scheduleActiveTimer()
      })
      .finally(() => {
        if (active === task) active = undefined
      })
    active = task
    return task
  }

  const start = (): void => {
    if (stopped || controller) return
    controller = new AbortController()
    paused = false
    void tick()
  }

  const wake = (beforeQueuedPass?: () => void): Promise<void> => {
    if (!controller || paused || stopped) return Promise.resolve()
    clearWakeTimer()
    if (active || queuedWake) {
      if (beforeQueuedPass) queuedWakeCallbacks.push(beforeQueuedPass)
      if (!queuedWake) {
        queuedWake = (active ?? Promise.resolve()).then(() => {
          const callbacks = queuedWakeCallbacks
          queuedWakeCallbacks = []
          queuedWake = undefined
          for (const callback of callbacks) callback()
          if (!controller || paused || stopped) return
          return tick()
        })
      }
      return queuedWake
    }
    beforeQueuedPass?.()
    return tick()
  }

  const pause = async (): Promise<void> => {
    paused = true
    clearActiveTimer()
    clearWakeTimer()
    controller?.abort()
    await active
    controller = undefined
    queuedWake = undefined
    queuedWakeCallbacks = []
  }

  return {
    get signal() {
      return controller?.signal
    },
    start,
    wake,
    tick,
    pause,
    resume: () => {
      if (stopped) return
      paused = false
      if (!controller) start()
      else void tick()
    },
    stop: async () => {
      stopped = true
      await pause()
    }
  }
}
