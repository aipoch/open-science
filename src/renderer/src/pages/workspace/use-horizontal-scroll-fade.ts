import { useCallback, useRef, type RefCallback } from 'react'

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

export const useHorizontalScrollFade = <T extends HTMLElement>(): RefCallback<T> => {
  const bindingRef = useRef<{ element: T; cleanup: () => void } | null>(null)

  return useCallback((element: T | null): void => {
    const previous = bindingRef.current
    if (previous?.element === element) return

    previous?.cleanup()
    bindingRef.current = null
    if (!element) return

    const update = (): void => updateHorizontalScrollFade(element)
    update()
    element.addEventListener('scroll', update, { passive: true })
    const revealFocus = (event: FocusEvent): void => {
      const target = event.target
      if (target instanceof HTMLElement && target.matches(':focus-visible')) {
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }
    }
    element.addEventListener('focusin', revealFocus)

    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    observer?.observe(element)
    bindingRef.current = {
      element,
      cleanup: () => {
        element.removeEventListener('scroll', update)
        element.removeEventListener('focusin', revealFocus)
        observer?.disconnect()
      }
    }
  }, [])
}
