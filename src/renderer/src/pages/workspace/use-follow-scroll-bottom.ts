import { useLayoutEffect, useRef, type RefObject } from 'react'

import { followScrollBottomTop, isAtFollowScrollBottom } from './follow-notebook-scroll'

type FollowScrollOptions = {
  onFollowingChange?: (following: boolean) => void
  // Explicit navigation can resume following without replacing the viewport or its observer.
  resetKey?: string | number
}

// Keeps a scroller pinned to the latest content while the caller allows follow. User movement
// away from the bottom pauses; returning to the bottom resumes.
export const useFollowScrollBottom = (
  enabled: boolean,
  options: FollowScrollOptions = {}
): RefObject<HTMLDivElement | null> => {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const followingRef = useRef(true)
  const autoscrollingRef = useRef(false)
  const enabledRef = useRef(enabled)
  const autoscrollFrameRef = useRef<number | undefined>(undefined)
  const followingChangeRef = useRef(options.onFollowingChange)
  const resetKeyRef = useRef(options.resetKey)

  const bindingRef = useRef<
    | {
        viewport: HTMLDivElement
        content: Element | null
        scrollToEnd: () => void
        cleanup: () => void
      }
    | undefined
  >(undefined)

  useLayoutEffect(() => {
    followingChangeRef.current = options.onFollowingChange
    const updateFollowing = (following: boolean): void => {
      if (followingRef.current === following) return
      followingRef.current = following
      followingChangeRef.current?.(following)
    }
    const resetRequested = resetKeyRef.current !== options.resetKey
    resetKeyRef.current = options.resetKey
    if (resetRequested) updateFollowing(true)
    const wasEnabled = enabledRef.current
    const hasResizeObserver = typeof ResizeObserver !== 'undefined'
    enabledRef.current = enabled
    const viewport = viewportRef.current
    const content = viewport?.firstElementChild ?? null
    const previous = bindingRef.current
    if (previous && previous.viewport === viewport && previous.content === content) {
      if (
        enabled &&
        followingRef.current &&
        (resetRequested || !wasEnabled || !hasResizeObserver)
      ) {
        previous.scrollToEnd()
      }
      return
    }
    previous?.cleanup()
    bindingRef.current = undefined
    if (!viewport) return

    let lastScrollTop = viewport.scrollTop

    const clearAutoscroll = (): void => {
      if (autoscrollFrameRef.current === undefined) return
      window.cancelAnimationFrame(autoscrollFrameRef.current)
      autoscrollFrameRef.current = undefined
    }

    const scrollToEnd = (): void => {
      const nextTop = followScrollBottomTop(viewport)
      if (Math.abs(viewport.scrollTop - nextTop) <= 0.5) {
        // Layout can clamp the viewport to a shorter bottom without a programmatic write.
        // Record that offset before its delayed scroll event meets the next content resize.
        lastScrollTop = viewport.scrollTop
        return
      }
      autoscrollingRef.current = true
      viewport.scrollTop = nextTop
      lastScrollTop = viewport.scrollTop
      clearAutoscroll()
      autoscrollFrameRef.current = window.requestAnimationFrame(() => {
        autoscrollFrameRef.current = undefined
        autoscrollingRef.current = false
      })
    }

    const handleScroll = (): void => {
      if (!enabledRef.current) return
      const atBottom = isAtFollowScrollBottom(viewport)
      const movedUp = viewport.scrollTop < lastScrollTop - 0.5
      lastScrollTop = viewport.scrollTop
      // A delayed scroll event can arrive after streamed content grew again. Its unchanged
      // offset is not a user departure; only an actual upward move suspends active follow.
      if (autoscrollingRef.current && !movedUp) return
      // A user move ends the pending programmatic-scroll guard immediately.
      clearAutoscroll()
      autoscrollingRef.current = false
      updateFollowing(atBottom || (followingRef.current && !movedUp))
    }

    const handleContentResize = (): void => {
      if (enabledRef.current && followingRef.current) scrollToEnd()
    }

    if (enabled && followingRef.current) scrollToEnd()

    viewport.addEventListener('scroll', handleScroll, { passive: true })
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(handleContentResize)
    observer?.observe(viewport)
    if (content) observer?.observe(content)

    const cleanup = (): void => {
      viewport.removeEventListener('scroll', handleScroll)
      observer?.disconnect()
      clearAutoscroll()
      autoscrollingRef.current = false
    }
    bindingRef.current = { viewport, content, scrollToEnd, cleanup }
  })

  useLayoutEffect(
    () => () => {
      bindingRef.current?.cleanup()
      bindingRef.current = undefined
    },
    []
  )

  return viewportRef
}
