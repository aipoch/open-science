import { useLayoutEffect, useRef, type RefObject } from 'react'

import { followScrollBottomTop, isAtFollowScrollBottom } from './follow-notebook-scroll'

// Keeps a scroller pinned to the latest content while the caller allows follow. User movement
// away from the bottom pauses; returning to the bottom resumes. There is no jump control.
export const useFollowScrollBottom = (enabled: boolean): RefObject<HTMLDivElement | null> => {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const followingRef = useRef(true)
  const autoscrollingRef = useRef(false)
  const enabledRef = useRef(enabled)
  const autoscrollFrameRef = useRef<number | undefined>(undefined)

  useLayoutEffect(() => {
    enabledRef.current = enabled
    const viewport = viewportRef.current
    if (!viewport) return

    const clearAutoscroll = (): void => {
      if (autoscrollFrameRef.current === undefined) return
      window.cancelAnimationFrame(autoscrollFrameRef.current)
      autoscrollFrameRef.current = undefined
    }

    const scrollToEnd = (): void => {
      const nextTop = followScrollBottomTop(viewport)
      if (Math.abs(viewport.scrollTop - nextTop) <= 0.5) return
      autoscrollingRef.current = true
      viewport.scrollTop = nextTop
      clearAutoscroll()
      autoscrollFrameRef.current = window.requestAnimationFrame(() => {
        autoscrollFrameRef.current = undefined
        autoscrollingRef.current = false
      })
    }

    const handleScroll = (): void => {
      if (!enabledRef.current) return
      const atBottom = isAtFollowScrollBottom(viewport)
      // Programmatic follow lands on the bottom; a user move away from it always pauses.
      if (autoscrollingRef.current && atBottom) return
      followingRef.current = atBottom
    }

    const handleContentResize = (): void => {
      if (enabledRef.current && followingRef.current) scrollToEnd()
    }

    if (enabled && followingRef.current) scrollToEnd()

    viewport.addEventListener('scroll', handleScroll, { passive: true })
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(handleContentResize)
    observer?.observe(viewport)
    const content = viewport.firstElementChild
    if (content) observer?.observe(content)

    return () => {
      viewport.removeEventListener('scroll', handleScroll)
      observer?.disconnect()
      clearAutoscroll()
      autoscrollingRef.current = false
    }
  })

  return viewportRef
}
