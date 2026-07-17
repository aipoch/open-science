import { useEffect, useState } from 'react'

// Reports visibility with overscan so callers can mount expensive preview work just in time.
const useNearViewport = <Element extends HTMLElement>(): [
  (element: Element | null) => void,
  boolean
] => {
  const [element, setElement] = useState<Element | null>(null)
  const [isNearViewport, setIsNearViewport] = useState(
    () => typeof IntersectionObserver === 'undefined'
  )

  useEffect(() => {
    if (!element || typeof IntersectionObserver === 'undefined') return

    // Start work shortly before entry and stop it after exit so scrolling stays responsive.
    const observer = new IntersectionObserver(
      (entries) => setIsNearViewport(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: '240px' }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])

  return [setElement, isNearViewport]
}

export { useNearViewport }
