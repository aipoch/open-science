import { useEffect, useRef, useState } from 'react'

const RESERVE_GRAPHEMES = 18
const PREBUFFER_MS = 500
const RESERVE_HOLD_MS = 120
const SPEED_UP_TO_TWO_GRAPHEMES = 120
const SPEED_UP_TO_THREE_GRAPHEMES = 240
const SPEED_DOWN_TO_TWO_GRAPHEMES = 180
const SPEED_DOWN_TO_ONE_GRAPHEMES = 60
// Real models outpace the 1/2/3-grapheme playback quickly; beyond this backlog the reveal
// rate scales to drain within CATCH_UP_FRAMES frames instead of trailing seconds behind.
const CATCH_UP_GRAPHEMES = 600
const CATCH_UP_FRAMES = 30
// Bound a single frame's reveal so draining a large backlog never flashes a huge block.
const CATCH_UP_MAX_GRAPHEMES_PER_FRAME = 48
const graphemeSegmenter =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : undefined

const splitGraphemes = (value: string): string[] =>
  graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment)
    : Array.from(value)

const shouldAnimateStreamingContent = (): boolean => {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false
  return !(
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

type SmoothStreamingContent = {
  content: string
  isPresenting: boolean
}

type PresentationSpeed = 1 | 2 | 3

const nextPresentationSpeed = (
  current: PresentationSpeed,
  bufferedGraphemes: number
): PresentationSpeed => {
  if (current === 1) return bufferedGraphemes >= SPEED_UP_TO_TWO_GRAPHEMES ? 2 : 1
  if (current === 2) {
    if (bufferedGraphemes >= SPEED_UP_TO_THREE_GRAPHEMES) return 3
    return bufferedGraphemes <= SPEED_DOWN_TO_ONE_GRAPHEMES ? 1 : 2
  }
  if (bufferedGraphemes <= SPEED_DOWN_TO_ONE_GRAPHEMES) return 1
  return bufferedGraphemes <= SPEED_DOWN_TO_TWO_GRAPHEMES ? 2 : 3
}

// Keeps canonical Session content complete while a hysteretic jitter buffer advances the caret.
// Backlog can raise the rate gradually, but separate up/down thresholds prevent speed oscillation.
const useSmoothStreamingContent = (
  content: string,
  sourceOpen: boolean,
  animateOnMount = sourceOpen
): SmoothStreamingContent => {
  const [visibleContent, setVisibleContent] = useState(() => (animateOnMount ? '' : content))
  const [isPresenting, setIsPresenting] = useState(animateOnMount)
  const visibleContentRef = useRef(visibleContent)
  const targetContentRef = useRef(content)
  const pendingGraphemesRef = useRef(animateOnMount ? splitGraphemes(content) : [])
  const pendingIndexRef = useRef(0)
  const playbackStartedRef = useRef(false)
  const presentationSpeedRef = useRef<PresentationSpeed>(1)
  const bufferingStartedAtRef = useRef<number | undefined>(undefined)
  const lastTargetUpdateAtRef = useRef(0)
  const sourceOpenRef = useRef(sourceOpen)
  const isPresentingRef = useRef(animateOnMount)

  useEffect(() => {
    const now = Date.now()
    const previousTarget = targetContentRef.current
    sourceOpenRef.current = sourceOpen
    targetContentRef.current = content
    const commit = (value: string): void => {
      if (visibleContentRef.current === value) return
      visibleContentRef.current = value
      setVisibleContent(value)
    }
    const setPresentationActive = (active: boolean): void => {
      if (isPresentingRef.current === active) return
      isPresentingRef.current = active
      setIsPresenting(active)
    }
    const resetPending = (): void => {
      pendingGraphemesRef.current = []
      pendingIndexRef.current = 0
      playbackStartedRef.current = false
      presentationSpeedRef.current = 1
      bufferingStartedAtRef.current = undefined
    }

    if (!shouldAnimateStreamingContent()) {
      resetPending()
      commit(content)
      setPresentationActive(sourceOpen)
      return
    }
    if (!sourceOpen && !isPresentingRef.current) {
      resetPending()
      commit(content)
      return
    }

    if (content.startsWith(previousTarget)) {
      const appended = splitGraphemes(content.slice(previousTarget.length))
      if (
        bufferingStartedAtRef.current === undefined &&
        pendingGraphemesRef.current.length > pendingIndexRef.current
      ) {
        bufferingStartedAtRef.current = now
        lastTargetUpdateAtRef.current = now
      }
      if (appended.length > 0) {
        if (pendingGraphemesRef.current.length === pendingIndexRef.current) {
          resetPending()
          bufferingStartedAtRef.current = now
        }
        pendingGraphemesRef.current.push(...appended)
        lastTargetUpdateAtRef.current = now
      }
    } else {
      resetPending()
      commit(content)
    }

    const hasPending = pendingGraphemesRef.current.length > pendingIndexRef.current
    if (sourceOpen || hasPending) setPresentationActive(true)
    else setPresentationActive(false)
  }, [content, sourceOpen])

  useEffect(() => {
    if (!isPresenting) return

    let cancelled = false
    let cancelFrame = (): void => undefined
    const commit = (value: string): void => {
      if (visibleContentRef.current === value) return
      visibleContentRef.current = value
      setVisibleContent(value)
    }
    const finishPresentation = (): void => {
      if (sourceOpenRef.current || !isPresentingRef.current) return
      isPresentingRef.current = false
      setIsPresenting(false)
    }
    const resetPending = (): void => {
      pendingGraphemesRef.current = []
      pendingIndexRef.current = 0
      playbackStartedRef.current = false
      presentationSpeedRef.current = 1
      bufferingStartedAtRef.current = undefined
    }
    const scheduleFrame = (callback: () => void): (() => void) => {
      if (typeof requestAnimationFrame === 'function') {
        const frameId = requestAnimationFrame(callback)
        return () => cancelAnimationFrame(frameId)
      }
      const timer = setTimeout(callback, 16)
      return () => clearTimeout(timer)
    }
    const revealNext = (): void => {
      if (cancelled) return
      const current = visibleContentRef.current
      const target = targetContentRef.current
      if (!target.startsWith(current) || !shouldAnimateStreamingContent()) {
        resetPending()
        commit(target)
        finishPresentation()
      } else if (current !== target) {
        const pending = pendingGraphemesRef.current
        const remaining = pending.length - pendingIndexRef.current
        const now = Date.now()
        const bufferedForMs = now - (bufferingStartedAtRef.current ?? now)
        if (
          !playbackStartedRef.current &&
          (!sourceOpenRef.current || bufferedForMs >= PREBUFFER_MS)
        ) {
          playbackStartedRef.current = true
        }
        const sourceIsIdle =
          !sourceOpenRef.current || now - lastTargetUpdateAtRef.current >= RESERVE_HOLD_MS
        const releasable = playbackStartedRef.current
          ? sourceIsIdle
            ? remaining
            : Math.max(0, remaining - RESERVE_GRAPHEMES)
          : 0

        if (releasable > 0) {
          presentationSpeedRef.current = nextPresentationSpeed(
            presentationSpeedRef.current,
            remaining
          )
          const frameReveal =
            remaining > CATCH_UP_GRAPHEMES
              ? Math.min(
                  CATCH_UP_MAX_GRAPHEMES_PER_FRAME,
                  Math.max(presentationSpeedRef.current, Math.ceil(remaining / CATCH_UP_FRAMES))
                )
              : presentationSpeedRef.current
          const revealCount = Math.min(releasable, frameReveal)
          const nextIndex = pendingIndexRef.current + revealCount
          commit(`${current}${pending.slice(pendingIndexRef.current, nextIndex).join('')}`)
          pendingIndexRef.current = nextIndex
          if (nextIndex === pending.length) {
            resetPending()
            finishPresentation()
          }
        }
      } else {
        finishPresentation()
      }

      if (isPresentingRef.current) cancelFrame = scheduleFrame(revealNext)
    }
    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== 'hidden') return
      resetPending()
      commit(targetContentRef.current)
      finishPresentation()
    }

    cancelFrame = scheduleFrame(revealNext)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }

    return () => {
      cancelled = true
      cancelFrame()
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
    }
  }, [isPresenting])

  return { content: visibleContent, isPresenting }
}

export { useSmoothStreamingContent }
