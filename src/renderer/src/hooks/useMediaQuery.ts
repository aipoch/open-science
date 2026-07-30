import { useEffect, useState } from 'react'

// Reactive viewport query shared by responsive shells. The guarded fallback keeps jsdom and any
// non-browser render deterministic without requiring every test to polyfill matchMedia.
const useMediaQuery = (query: string): boolean => {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true
  )

  useEffect(() => {
    if (!window.matchMedia) return

    const media = window.matchMedia(query)
    const update = (): void => setMatches(media.matches)
    media.addEventListener?.('change', update)

    return () => media.removeEventListener?.('change', update)
  }, [query])

  return matches
}

export { useMediaQuery }
