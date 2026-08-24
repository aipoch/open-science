import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'

import type { WorkspaceConversationTimelineItem } from './workspace-conversation-timeline'
import { findMessageTarget } from './workspace-run-marks'

const TRANSCRIPT_WINDOW_SIZE = 80

type TranscriptWindowState = {
  scopeId: string | undefined
  itemCount: number
  start: number
  end: number
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
  expandAtScrollEdge: (previousScrollTop: number) => void
} => {
  const [state, setState] = useState<TranscriptWindowState>(() => ({
    scopeId: undefined,
    itemCount: 0,
    start: 0,
    end: 0
  }))
  const initialStart = Math.max(0, items.length - TRANSCRIPT_WINDOW_SIZE)
  const start = state.scopeId === scopeId ? Math.min(state.start, items.length) : initialStart
  const end =
    state.scopeId === scopeId
      ? state.end === state.itemCount
        ? items.length
        : Math.min(state.end, items.length)
      : items.length
  const pendingTargetRef = useRef<string | undefined>(undefined)

  const revealMessage = useCallback(
    (messageId: string): void => {
      const itemIndex = items.findIndex(
        (item) =>
          item.id === messageId || (item.type === 'message' && item.message.id === messageId)
      )
      if (itemIndex < 0) return

      const nextStart = Math.max(0, itemIndex - Math.floor(TRANSCRIPT_WINDOW_SIZE / 4))
      pendingTargetRef.current = messageId
      setState({
        scopeId,
        itemCount: items.length,
        start: nextStart,
        end: Math.min(items.length, nextStart + TRANSCRIPT_WINDOW_SIZE)
      })
    },
    [items, scopeId]
  )

  const revealAll = useCallback((): void => {
    setState({
      scopeId,
      itemCount: items.length,
      start: 0,
      end: items.length
    })
  }, [items.length, scopeId])

  const expandAtScrollEdge = (previousScrollTop: number): void => {
    const viewport = viewportRef.current
    if (!viewport || presentationBarrierIndex >= 0) return

    if (viewport.scrollTop < previousScrollTop && viewport.scrollTop <= 64 && start > 0) {
      setState({
        scopeId,
        itemCount: items.length,
        start: Math.max(0, start - TRANSCRIPT_WINDOW_SIZE),
        end
      })
    } else if (
      viewport.scrollTop > previousScrollTop &&
      viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 64 &&
      end < items.length
    ) {
      setState({
        scopeId,
        itemCount: items.length,
        start,
        end: Math.min(items.length, end + TRANSCRIPT_WINDOW_SIZE)
      })
    }
  }

  useLayoutEffect(() => {
    const messageId = pendingTargetRef.current
    const viewport = viewportRef.current
    if (!messageId || !viewport) return
    const target = findMessageTarget(viewport, messageId)
    if (!target) return

    pendingTargetRef.current = undefined
    const top = Math.max(
      0,
      viewport.scrollTop + target.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    )
    if (typeof viewport.scrollTo === 'function') viewport.scrollTo({ top, behavior: 'auto' })
    else viewport.scrollTop = top
  }, [end, start, viewportRef])

  const entries =
    presentationBarrierIndex >= 0
      ? items.map((item, itemIndex) => ({ item, itemIndex }))
      : items.slice(start, end).map((item, offset) => ({ item, itemIndex: start + offset }))

  return { entries, end, revealMessage, revealAll, expandAtScrollEdge }
}

export { useTranscriptWindow }
