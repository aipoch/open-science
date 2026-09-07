import {
  startTransition,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject
} from 'react'

import { hidesBehindPresentationBarrier } from './workspace-conversation-items'
import type { WorkspaceConversationTimelineItem } from './workspace-conversation-timeline'
import { findMessageTarget } from './workspace-run-marks'

const TRANSCRIPT_WINDOW_SIZE = 80

type TranscriptWindowState = {
  scopeId: string | undefined
  itemCount: number
  start: number
  end: number
  anchorId?: string
  anchorIndexOffset?: number
  followEnd?: boolean
  finding?: boolean
}

type ReadingAnchor = { scopeId: string | undefined; messageId: string; offset: number }
type FindSnapshot = {
  window: TranscriptWindowState
  scrollTop: number
  anchor?: ReadingAnchor
  target?: ReadingAnchor
  followEnd?: boolean
}

// Use the registered transcript nodes, including standalone activities, as the reading boundary.
const captureReadingAnchor = (
  scopeId: string | undefined,
  viewport: HTMLDivElement | null
): ReadingAnchor | undefined => {
  if (!viewport) return undefined
  const bounds = viewport.getBoundingClientRect()
  for (const node of viewport.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const rect = node.getBoundingClientRect()
    if (node.dataset.messageId && rect.bottom > bounds.top && rect.top < bounds.bottom) {
      return { scopeId, messageId: node.dataset.messageId, offset: rect.top - bounds.top }
    }
  }
  return undefined
}

const useTranscriptWindow = (
  scopeId: string | undefined,
  items: readonly WorkspaceConversationTimelineItem[],
  presentationBarrierIndex: number,
  viewportRef: RefObject<HTMLDivElement | null>
): {
  entries: Array<{ item: WorkspaceConversationTimelineItem; itemIndex: number }>
  end: number
  revealMessage: (messageId: string) => void
  revealAll: () => void
  restoreWindow: () => void
  expandAtScrollEdge: (previousScrollTop: number) => void
  followEnd: () => void
  isFollowingEnd: boolean
  recordUserScroll: () => void
} => {
  const [state, setState] = useState<TranscriptWindowState>(() => ({
    scopeId: undefined,
    itemCount: 0,
    start: 0,
    end: 0
  }))
  const pendingTargetRef = useRef<ReadingAnchor | undefined>(undefined)
  const readingAnchorRef = useRef<ReadingAnchor | undefined>(undefined)
  const findRestoreRef = useRef<FindSnapshot | undefined>(undefined)
  const finding = state.scopeId === scopeId && state.finding === true
  const initialStart = Math.max(0, items.length - TRANSCRIPT_WINDOW_SIZE)
  if (state.scopeId !== scopeId) {
    setState({
      scopeId,
      itemCount: items.length,
      start: initialStart,
      end: items.length,
      followEnd: true
    })
  }
  useLayoutEffect(() => {
    readingAnchorRef.current = undefined
    pendingTargetRef.current = undefined
    findRestoreRef.current = undefined
  }, [scopeId])
  const stateMatchesScope = state.scopeId === scopeId && state.itemCount > 0
  const wasPinnedToEnd =
    stateMatchesScope && state.followEnd !== false && state.end === state.itemCount
  const retainedWindowSize = Math.max(
    wasPinnedToEnd ? TRANSCRIPT_WINDOW_SIZE : 0,
    state.end - state.start
  )
  const retainedStart =
    stateMatchesScope && state.anchorId ? items.findIndex((item) => item.id === state.anchorId) : -1
  const start = finding
    ? 0
    : stateMatchesScope
      ? wasPinnedToEnd
        ? Math.max(0, items.length - retainedWindowSize)
        : retainedStart >= 0
          ? Math.max(0, retainedStart - (state.anchorIndexOffset ?? 0))
          : Math.min(state.start, Math.max(0, items.length - retainedWindowSize))
      : initialStart
  const end = finding
    ? items.length
    : stateMatchesScope
      ? wasPinnedToEnd
        ? items.length
        : Math.min(start + retainedWindowSize, items.length)
      : items.length

  const revealMessage = useCallback(
    (messageId: string): void => {
      const itemIndex = items.findIndex(
        (item) =>
          item.id === messageId || (item.type === 'message' && item.message.id === messageId)
      )
      if (itemIndex < 0) return

      const nextStart = Math.max(0, itemIndex - Math.floor(TRANSCRIPT_WINDOW_SIZE / 4))
      const anchor = { scopeId, messageId, offset: 0 }
      readingAnchorRef.current = anchor
      const snapshot = findRestoreRef.current
      if (snapshot && snapshot.window.scopeId === scopeId) {
        snapshot.target = anchor
        snapshot.followEnd = false
        return
      }
      if (viewportRef.current && findMessageTarget(viewportRef.current, messageId)) {
        setState({
          scopeId,
          itemCount: items.length,
          start,
          end,
          anchorId: items[start]?.id,
          followEnd: false
        })
        return
      }
      pendingTargetRef.current = anchor
      setState({
        scopeId,
        itemCount: items.length,
        start: nextStart,
        anchorId: items[nextStart]?.id,
        followEnd: false,
        end: Math.min(items.length, nextStart + TRANSCRIPT_WINDOW_SIZE)
      })
    },
    [end, items, scopeId, start, viewportRef]
  )

  const revealAll = useCallback((): void => {
    if (!findRestoreRef.current || findRestoreRef.current.window.scopeId !== scopeId) {
      findRestoreRef.current = {
        window: {
          scopeId,
          itemCount: items.length,
          start,
          end,
          anchorId: stateMatchesScope ? state.anchorId : items[start]?.id,
          anchorIndexOffset: stateMatchesScope ? state.anchorIndexOffset : 0,
          followEnd: stateMatchesScope ? state.followEnd : true
        },
        scrollTop: viewportRef.current?.scrollTop ?? 0,
        anchor: captureReadingAnchor(scopeId, viewportRef.current)
      }
    }
    setState({ scopeId, itemCount: items.length, start: 0, end: items.length, finding: true })
  }, [
    end,
    items,
    scopeId,
    start,
    state.anchorId,
    state.anchorIndexOffset,
    state.followEnd,
    stateMatchesScope,
    viewportRef
  ])

  const restoreWindow = useCallback((): void => {
    const snapshot = findRestoreRef.current
    findRestoreRef.current = undefined
    if (!snapshot || snapshot.window.scopeId !== scopeId) return
    if (snapshot.followEnd) {
      readingAnchorRef.current = undefined
      pendingTargetRef.current = undefined
      setState({
        scopeId,
        itemCount: items.length,
        start: Math.max(0, items.length - TRANSCRIPT_WINDOW_SIZE),
        end: items.length,
        followEnd: true
      })
      return
    }

    const viewport = viewportRef.current
    const visibleAnchor = captureReadingAnchor(scopeId, viewport)
    // An explicit run selection wins even if its smooth scroll has not reached the target yet.
    const anchor = snapshot.target
      ? visibleAnchor?.messageId === snapshot.target.messageId
        ? visibleAnchor
        : snapshot.target
      : ((viewport && viewport.scrollTop !== snapshot.scrollTop ? visibleAnchor : undefined) ??
        snapshot.anchor)
    const changedReading =
      snapshot.target !== undefined || anchor?.messageId !== snapshot.anchor?.messageId
    const anchorIndex = anchor ? items.findIndex((item) => item.id === anchor.messageId) : -1
    if (changedReading && anchorIndex >= 0) {
      const nextStart = Math.max(0, anchorIndex - Math.floor(TRANSCRIPT_WINDOW_SIZE / 4))
      pendingTargetRef.current = anchor
      readingAnchorRef.current = anchor
      setState({
        scopeId,
        itemCount: items.length,
        start: nextStart,
        end: Math.min(items.length, nextStart + TRANSCRIPT_WINDOW_SIZE),
        anchorId: items[nextStart]?.id,
        followEnd: false
      })
    } else {
      // Keep the original window (including follow intent) when find did not navigate.
      pendingTargetRef.current = anchor
      setState(snapshot.window)
    }
  }, [items, scopeId, viewportRef])

  const recordUserScroll = (): void => {
    const snapshot = findRestoreRef.current
    if (snapshot && snapshot.window.scopeId === scopeId) {
      snapshot.target = undefined
      snapshot.followEnd = false
    }
  }

  const followEnd = (): void => {
    const snapshot = findRestoreRef.current
    if (snapshot && snapshot.window.scopeId === scopeId) {
      snapshot.target = undefined
      snapshot.followEnd = true
    }
    readingAnchorRef.current = undefined
    pendingTargetRef.current = undefined
    setState({
      scopeId,
      itemCount: items.length,
      start: initialStart,
      end: items.length,
      followEnd: true
    })
  }

  const expandAtScrollEdge = (previousScrollTop: number): void => {
    const viewport = viewportRef.current
    if (!viewport || presentationBarrierIndex >= 0) return
    const prefetchDistance = Math.max(64, viewport.clientHeight)
    readingAnchorRef.current = captureReadingAnchor(scopeId, viewport)
    if (finding) return
    const following =
      end === items.length &&
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 0.5
    if (following) readingAnchorRef.current = undefined
    let nextStart = start
    let nextEnd = end

    if (
      viewport.scrollTop < previousScrollTop &&
      viewport.scrollTop <= prefetchDistance &&
      start > 0
    ) {
      nextStart = Math.max(0, start - TRANSCRIPT_WINDOW_SIZE)
    } else if (
      viewport.scrollTop > previousScrollTop &&
      viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - prefetchDistance &&
      end < items.length
    ) {
      nextEnd = Math.min(items.length, end + TRANSCRIPT_WINDOW_SIZE)
    }
    const readingId = readingAnchorRef.current?.messageId
    const readingIndex = readingId ? items.findIndex((item) => item.id === readingId) : -1
    const anchorIndex =
      readingIndex >= nextStart && readingIndex < nextEnd ? readingIndex : nextStart
    const anchorId = items[anchorIndex]?.id
    const anchorIndexOffset = anchorIndex - nextStart
    if (
      nextStart !== start ||
      nextEnd !== end ||
      !stateMatchesScope ||
      state.followEnd !== following ||
      state.itemCount !== items.length ||
      state.anchorId !== anchorId ||
      state.anchorIndexOffset !== anchorIndexOffset
    ) {
      startTransition(() =>
        setState({
          scopeId,
          itemCount: items.length,
          start: nextStart,
          end: nextEnd,
          anchorId,
          anchorIndexOffset,
          followEnd: following
        })
      )
    }
  }

  useLayoutEffect(() => {
    const anchor = pendingTargetRef.current ?? readingAnchorRef.current
    const viewport = viewportRef.current
    if (!anchor || anchor.scopeId !== scopeId || !viewport || finding) return
    const target = findMessageTarget(viewport, anchor.messageId)
    if (!target) return

    pendingTargetRef.current = undefined
    const top = Math.max(
      0,
      viewport.scrollTop +
        target.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top -
        anchor.offset
    )
    if (typeof viewport.scrollTo === 'function') viewport.scrollTo({ top, behavior: 'auto' })
    else viewport.scrollTop = top
  }, [end, finding, items, scopeId, start, viewportRef])

  const presentationStart = Math.max(0, presentationBarrierIndex - TRANSCRIPT_WINDOW_SIZE + 1)
  const entries =
    presentationBarrierIndex >= 0
      ? items.flatMap((item, itemIndex) => {
          const withinPresentationWindow =
            itemIndex >= presentationStart && itemIndex <= presentationBarrierIndex
          const liveActivityAfterBarrier =
            itemIndex > presentationBarrierIndex && !hidesBehindPresentationBarrier(item.type)
          return withinPresentationWindow || liveActivityAfterBarrier ? [{ item, itemIndex }] : []
        })
      : items.slice(start, end).map((item, offset) => ({ item, itemIndex: start + offset }))

  return {
    entries,
    end,
    revealMessage,
    revealAll,
    restoreWindow,
    expandAtScrollEdge,
    followEnd,
    recordUserScroll,
    isFollowingEnd: !finding && (!stateMatchesScope || wasPinnedToEnd)
  }
}

export { useTranscriptWindow }
