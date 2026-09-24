import { startTransition, useEffect, useRef, useState, type RefObject } from 'react'

const RESERVE_GRAPHEMES = 18
const PREBUFFER_MS = 500
const RESERVE_HOLD_MS = 120
const SPEED_UP_TO_TWO_GRAPHEMES = 120
const SPEED_UP_TO_THREE_GRAPHEMES = 240
const SPEED_DOWN_TO_TWO_GRAPHEMES = 180
const SPEED_DOWN_TO_ONE_GRAPHEMES = 60
// Keep ordinary playback for small backlogs. Large provider bursts need a higher throughput:
// 48 graphemes per frame can leave a multi-megabyte response animating for minutes.
const CATCH_UP_GRAPHEMES = 600
const CATCH_UP_FRAMES = 30
const CATCH_UP_MAX_GRAPHEMES_PER_FRAME = 48
const HIGH_BACKLOG_GRAPHEMES = 4096
// At a 64ms commit cadence this permits up to 128k graphemes/s, enough to keep up with
// common provider bursts, without sending an unbounded block through Markdown in one commit.
const HIGH_BACKLOG_MAX_GRAPHEMES_PER_COMMIT = 8192
const HIGH_BACKLOG_DRAIN_TARGET_MS = 500
// Each commit re-renders the whole Markdown subtree at O(visible length), so per-frame commits
// make a long message cost O(n²) total. Past this target length, commit at a lengthening
// interval (32/48/64ms) with proportionally larger batches: the reveal rate in graphemes per
// millisecond — and therefore the catch-up drain bound — stays identical to per-frame pacing.
const FRAME_MS = 16
const ADAPTIVE_CADENCE_CONTENT_LENGTH = 2000
const MAX_COMMIT_INTERVAL_MS = 64

// Nominal milliseconds between visible-content commits for a target of the given length.
const commitIntervalFor = (targetLength: number): number =>
  targetLength <= ADAPTIVE_CADENCE_CONTENT_LENGTH
    ? FRAME_MS
    : Math.min(
        MAX_COMMIT_INTERVAL_MS,
        FRAME_MS * Math.ceil(targetLength / ADAPTIVE_CADENCE_CONTENT_LENGTH)
      )
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
  // A restored, already-visible message may still have an open source. Keep its presentation
  // gate active from the first render instead of committing the full Markdown once as closed
  // and immediately re-rendering it as streaming in the effect below.
  const [isPresenting, setIsPresenting] = useState(animateOnMount || sourceOpen)
  const visibleContentRef = useRef(visibleContent)
  const targetContentRef = useRef(content)
  // useRef arguments are evaluated on every render. Segment the initial body once, then
  // let the effect enqueue only appended content as the presentation state advances.
  const initialPendingRef = useRef<string[] | null>(null)
  if (initialPendingRef.current === null) {
    initialPendingRef.current = animateOnMount ? splitGraphemes(content) : []
  }
  // Initialization above and all subsequent writes guarantee an array for effect callbacks.
  const pendingGraphemesRef = initialPendingRef as RefObject<string[]>
  const pendingIndexRef = useRef(0)
  const playbackStartedRef = useRef(false)
  const highBacklogRef = useRef(false)
  const presentationSpeedRef = useRef<PresentationSpeed>(1)
  const bufferingStartedAtRef = useRef<number | undefined>(undefined)
  const lastTargetUpdateAtRef = useRef(0)
  const sourceOpenRef = useRef(sourceOpen)
  const isPresentingRef = useRef(animateOnMount || sourceOpen)
  const lastCommitAtRef = useRef(0)
  const completedFirstEffectSetupRef = useRef(false)
  const resumeFromHiddenActivityRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    if (completedFirstEffectSetupRef.current) {
      // Activity re-creates Effects on reveal without remounting the hook. The hidden tab's
      // durable/live snapshot should appear immediately; later chunks still use normal pacing.
      resumeFromHiddenActivityRef.current = true
    } else {
      // StrictMode's initial setup/cleanup replay happens before this microtask. Only a settled
      // first setup may turn a later cleanup/setup cycle into an Activity resume.
      queueMicrotask(() => {
        if (!cancelled) completedFirstEffectSetupRef.current = true
      })
    }
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const now = Date.now()
    const previousTarget = targetContentRef.current
    const sourceWasOpen = sourceOpenRef.current
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
      highBacklogRef.current = false
      presentationSpeedRef.current = 1
      bufferingStartedAtRef.current = undefined
    }

    if (resumeFromHiddenActivityRef.current) {
      resumeFromHiddenActivityRef.current = false
      resetPending()
      commit(content)
      setPresentationActive(sourceOpen)
      return
    }

    if (!shouldAnimateStreamingContent()) {
      resetPending()
      commit(content)
      setPresentationActive(sourceOpen)
      return
    }
    // Preserve ordinary boundary pacing, but do not keep a closed source behind a large
    // catch-up animation. Initial closed-source animation remains an explicit caller choice.
    if (
      sourceWasOpen &&
      !sourceOpen &&
      splitGraphemes(content.slice(visibleContentRef.current.length)).length > CATCH_UP_GRAPHEMES
    ) {
      resetPending()
      commit(content)
      setPresentationActive(false)
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
        // Provider/durable updates can contain hundreds of thousands of graphemes. A
        // spread call exceeds V8's argument limit and escapes the Markdown boundary.
        for (const grapheme of appended) pendingGraphemesRef.current.push(grapheme)
        lastTargetUpdateAtRef.current = now
      }
    } else {
      resetPending()
      commit(content)
    }

    const hasPending = pendingGraphemesRef.current.length > pendingIndexRef.current
    if (sourceOpen || hasPending) setPresentationActive(true)
    else setPresentationActive(false)
  }, [content, sourceOpen, pendingGraphemesRef])

  useEffect(() => {
    if (!isPresenting) return

    let cancelled = false
    let cancelFrame = (): void => undefined
    const commit = (value: string): void => {
      if (visibleContentRef.current === value) return
      visibleContentRef.current = value
      lastCommitAtRef.current = Date.now()
      setVisibleContent(value)
    }
    // Intermediate reveals go through a transition so a long message's Markdown re-render
    // stays interruptible by urgent updates (composer input) and under load React may
    // coalesce several reveals into one paint. The pacing refs advance synchronously, so
    // skipped paints simply reveal a larger batch on the next commit.
    const commitFrame = (value: string): void => {
      if (visibleContentRef.current === value) return
      visibleContentRef.current = value
      lastCommitAtRef.current = Date.now()
      startTransition(() => setVisibleContent(value))
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
      highBacklogRef.current = false
      presentationSpeedRef.current = 1
      bufferingStartedAtRef.current = undefined
      lastCommitAtRef.current = 0
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
          if (remaining > HIGH_BACKLOG_GRAPHEMES) highBacklogRef.current = true
          presentationSpeedRef.current = nextPresentationSpeed(
            presentationSpeedRef.current,
            remaining
          )
          const intervalMs = commitIntervalFor(target.length)
          const revealScale = intervalMs / FRAME_MS
          const revealCount = Math.min(
            releasable,
            highBacklogRef.current
              ? Math.min(
                  HIGH_BACKLOG_MAX_GRAPHEMES_PER_COMMIT,
                  Math.max(
                    CATCH_UP_MAX_GRAPHEMES_PER_FRAME * revealScale,
                    Math.ceil((remaining * intervalMs) / HIGH_BACKLOG_DRAIN_TARGET_MS)
                  )
                )
              : remaining > CATCH_UP_GRAPHEMES
                ? Math.min(
                    CATCH_UP_MAX_GRAPHEMES_PER_FRAME * revealScale,
                    Math.max(presentationSpeedRef.current, Math.ceil(remaining / CATCH_UP_FRAMES)) *
                      revealScale
                  )
                : presentationSpeedRef.current * revealScale
          )
          const nextIndex = pendingIndexRef.current + revealCount
          if (nextIndex === pending.length || now - lastCommitAtRef.current >= intervalMs) {
            const nextContent = `${current}${pending.slice(pendingIndexRef.current, nextIndex).join('')}`
            if (nextIndex === pending.length) {
              // Urgent: pairs with setIsPresenting(false) so the gate releases with final content.
              commit(nextContent)
              pendingIndexRef.current = nextIndex
              resetPending()
              finishPresentation()
            } else {
              commitFrame(nextContent)
              pendingIndexRef.current = nextIndex
            }
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
  }, [isPresenting, pendingGraphemesRef])

  return { content: visibleContent, isPresenting }
}

export { useSmoothStreamingContent }
