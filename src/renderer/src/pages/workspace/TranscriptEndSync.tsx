import { useLayoutEffect, useRef } from 'react'
import { useMessageScroller, useMessageScrollerScrollable } from '@/components/ui/message-scroller'

// Replacing a bounded tail can keep the same row count. Tell the existing scroller to follow
// after that replacement commits; its normal resize/streaming behavior remains authoritative.
const TranscriptEndSync = ({
  scopeId,
  itemCount,
  mountedItemCount,
  following
}: {
  scopeId: string | undefined
  itemCount: number
  mountedItemCount: number
  following: boolean
}): null => {
  const { scrollToEnd } = useMessageScroller()
  const { end: readerAwayFromEnd, paused } = useMessageScrollerScrollable()
  const previousRef = useRef<
    { scopeId: string | undefined; itemCount: number; mountedItemCount: number } | undefined
  >(undefined)
  useLayoutEffect(() => {
    const previous = previousRef.current
    previousRef.current = { scopeId, itemCount, mountedItemCount }
    if (
      following &&
      !paused &&
      !readerAwayFromEnd &&
      previous &&
      previous.scopeId === scopeId &&
      itemCount > previous.itemCount &&
      mountedItemCount === previous.mountedItemCount
    ) {
      // Content processes the replaced rows in a MutationObserver, which can select a new
      // prompt anchor. Restore follow intent after that observer, before the next paint.
      let cancelled = false
      queueMicrotask(() => {
        if (!cancelled) scrollToEnd({ behavior: 'auto' })
      })
      return () => {
        cancelled = true
      }
    }
    return undefined
  }, [following, itemCount, mountedItemCount, paused, readerAwayFromEnd, scopeId, scrollToEnd])
  return null
}

const MessageScrollerFollowIntent = ({
  active,
  onChange,
  onPauseChange
}: {
  active: boolean
  onChange?: (following: boolean) => void
  onPauseChange?: (paused: boolean) => void
}): null => {
  const { end, paused = false } = useMessageScrollerScrollable()
  useLayoutEffect(() => {
    // A collapse may clamp onto the bottom without the reader choosing to follow.
    onPauseChange?.(paused)
    if (active) onChange?.(!end && !paused)
  }, [active, end, paused, onChange, onPauseChange])
  return null
}

export { TranscriptEndSync, MessageScrollerFollowIntent }
