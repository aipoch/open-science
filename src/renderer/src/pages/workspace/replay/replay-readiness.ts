export type ReplayFrameReadiness = {
  ready: boolean
  degraded: boolean
  diagnostics: string[]
}

export type ReplayFramePreparationOptions = {
  signal?: AbortSignal
  timeoutMs?: number
}

// A capture host calls the same barrier as the interactive player. No experiment, media
// playback or provider is started here. Images and fonts must settle before a frame is ready.
export const prepareReplayFrame = (
  root: HTMLElement,
  { signal, timeoutMs = 5000 }: ReplayFramePreparationOptions = {}
): Promise<ReplayFrameReadiness> =>
  new Promise((resolve) => {
    const diagnostics: string[] = []
    const pending = new Set<string>()
    const cleanups: (() => void)[] = []
    let settled = false
    let layoutFrame = 0

    const finish = (aborted = false): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (layoutFrame) cancelAnimationFrame(layoutFrame)
      signal?.removeEventListener('abort', abort)
      cleanups.forEach((cleanup) => cleanup())
      resolve({ ready: !aborted, degraded: diagnostics.length > 0, diagnostics: [...diagnostics] })
    }
    const check = (): void => {
      if (settled || pending.size > 0 || layoutFrame) return
      // Resolve only after layout of the committed React tree; never use this clock for animation.
      layoutFrame = requestAnimationFrame(() => {
        layoutFrame = 0
        if (pending.size === 0) finish()
      })
    }
    const abort = (): void => finish(true)
    const timeout = setTimeout(() => {
      diagnostics.push(...[...pending].map((key) => `timeout:${key}`))
      finish()
    }, timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }

    const fonts = root.ownerDocument.fonts
    if (fonts) {
      pending.add('fonts')
      void Promise.resolve(fonts.ready).then(
        () => {
          pending.delete('fonts')
          check()
        },
        () => {
          diagnostics.push('unavailable:fonts')
          pending.delete('fonts')
          check()
        }
      )
    }

    root.querySelectorAll('img').forEach((img, index) => {
      const key = `image:${img.dataset.replayResourceId ?? index}`
      pending.add(key)
      let done = false
      const complete = (error: boolean): void => {
        if (done || settled) return
        done = true
        if (error) diagnostics.push(`unavailable:${key}`)
        pending.delete(key)
        check()
      }
      const decode = (): void => {
        if (!img.naturalWidth) {
          complete(true)
          return
        }
        if (typeof img.decode === 'function')
          void img.decode().then(
            () => complete(false),
            () => complete(true)
          )
        else complete(false)
      }
      const fail = (): void => complete(true)
      img.addEventListener('load', decode, { once: true })
      img.addEventListener('error', fail, { once: true })
      cleanups.push(() => {
        img.removeEventListener('load', decode)
        img.removeEventListener('error', fail)
      })
      if (img.complete) decode()
    })
    check()
  })
