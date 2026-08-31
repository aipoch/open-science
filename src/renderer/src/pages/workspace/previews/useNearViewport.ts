import { useEffect, useState } from 'react'

type NearViewportListener = (isNearViewport: boolean) => void

const listeners = new Map<Element, Set<NearViewportListener>>()
let observer: IntersectionObserver | undefined

// Lists and long PDFs can mount hundreds of lightweight placeholders; one observer serves all of
// them so the native observer count stays constant while expensive content remains per-item lazy.
const observeNearViewport = (element: Element, listener: NearViewportListener): (() => void) => {
  let elementListeners = listeners.get(element)
  const firstListener = !elementListeners
  if (!elementListeners) {
    elementListeners = new Set()
    listeners.set(element, elementListeners)
  }
  elementListeners.add(listener)
  if (firstListener) {
    observer ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const entryListeners =
            listeners.get(entry.target) ??
            (listeners.size === 1 ? listeners.values().next().value : undefined)
          for (const notify of entryListeners ?? []) notify(entry.isIntersecting)
        }
      },
      { rootMargin: '240px' }
    )
    observer.observe(element)
  }

  return () => {
    elementListeners.delete(listener)
    if (elementListeners.size > 0) return
    listeners.delete(element)
    observer?.unobserve?.(element)
    if (listeners.size > 0) return
    observer?.disconnect()
    observer = undefined
  }
}

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
    return observeNearViewport(element, setIsNearViewport)
  }, [element])

  return [setElement, isNearViewport]
}

export { useNearViewport }
