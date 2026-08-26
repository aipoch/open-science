import { useEffect, useState } from 'react'

// Reactive viewport query shared by responsive shells. The guarded fallback keeps jsdom and any
// non-browser render deterministic without requiring every test to polyfill matchMedia.
const useMediaQuery = (query: string): boolean => {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    const media = window.matchMedia(query)
    return media.media === query && media.matches === true
  })

  useEffect(() => {
    if (!window.matchMedia) return

    const media = window.matchMedia(query)
    const update = (): void => setMatches(media.media === query && media.matches)
    media.addEventListener?.('change', update)
    update()

    return () => media.removeEventListener?.('change', update)
  }, [query])

  return matches
}

export { useMediaQuery }
