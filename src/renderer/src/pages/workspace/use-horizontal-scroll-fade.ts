import { useLayoutEffect, useRef, type RefObject } from 'react'

type HorizontalScrollFade = 'none' | 'left' | 'right' | 'both'

const EDGE_THRESHOLD_PX = 1

const updateHorizontalScrollFade = (element: HTMLElement): void => {
  const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth)
  let fade: HorizontalScrollFade

  if (maxScrollLeft <= EDGE_THRESHOLD_PX) fade = 'none'
  else if (element.scrollLeft <= EDGE_THRESHOLD_PX) fade = 'right'
  else if (element.scrollLeft >= maxScrollLeft - EDGE_THRESHOLD_PX) fade = 'left'
  else fade = 'both'

  if (element.dataset.scrollFade !== fade) element.dataset.scrollFade = fade
}

export const useHorizontalScrollFade = <T extends HTMLElement>(): RefObject<T | null> => {
  const ref = useRef<T>(null)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return

    const update = (): void => updateHorizontalScrollFade(element)
    update()
    element.addEventListener('scroll', update, { passive: true })

    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => update())
    observer?.observe(element)

    return () => {
      element.removeEventListener('scroll', update)
      observer?.disconnect()
    }
  })

  return ref
}
