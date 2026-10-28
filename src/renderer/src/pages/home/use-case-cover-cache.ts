// Remember decoded URLs for this renderer session so returning cards never flash a placeholder.
export const loadedCovers = new Set<string>()

export const preloadUseCaseCovers = async (urls: string[], signal: AbortSignal): Promise<void> => {
  await Promise.all(
    urls.map(
      (url) =>
        new Promise<void>((resolve) => {
          if (signal.aborted || loadedCovers.has(url)) return resolve()
          const image = new Image()
          if (!image.decode) return resolve()
          let settled = false
          const finish = (): void => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            signal.removeEventListener('abort', finish)
            resolve()
          }
          // A slow or failed cover must not block navigation. The card can finish loading in place.
          const timeout = setTimeout(finish, 1200)
          signal.addEventListener('abort', finish, { once: true })
          image.src = url
          void image.decode().then(() => {
            if (!settled) loadedCovers.add(url)
            finish()
          }, finish)
        })
    )
  )
}
