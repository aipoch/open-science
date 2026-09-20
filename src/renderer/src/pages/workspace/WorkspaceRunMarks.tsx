/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
/* Hallmark · component: run marks · genre: modern-minimal · theme: project tokens
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: project token contract
 */
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { createPortal, flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'

import type { WorkspaceConversationTimelineItem } from './workspace-conversation-timeline'
import {
  createRunMarks,
  createRunMarkItemIndex,
  findMessageTarget,
  normalizePreviewText,
  resolveRunMarkPosition,
  RUN_MARK_READING_BOUNDARY_PX,
  runMarkIndicatorClassName,
  type RunMark
} from './workspace-run-marks'

type WorkspaceRunMarksProps = {
  items: readonly WorkspaceConversationTimelineItem[]
  viewport: HTMLDivElement | null
  onRevealMessage?: (messageId: string) => void
}

const RUN_MARK_PREVIEW_WIDTH_PX = 256
const RUN_MARK_PREVIEW_HEIGHT_PX = 88
const RUN_MARK_PREVIEW_MARGIN_PX = 12
const RUN_MARK_INLINE_OFFSET_PX = 8
const RUN_MARK_TOP_OFFSET_PX = 8
const RUN_MARK_ROW_SIZE_PX = 20
const RUN_MARK_MIN_ROW_SIZE_PX = 12
const RUN_MARK_MAX_RAIL_HEIGHT_PX = 480

type RunMarkRailPosition = {
  left?: number
  right?: number
  top: number
}

const WorkspaceRunMarks = ({
  items,
  viewport,
  onRevealMessage
}: WorkspaceRunMarksProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const marks = useMemo(() => createRunMarks(items), [items])
  const markIndexByItemId = useMemo(() => createRunMarkItemIndex(items, marks), [items, marks])
  const [visibleIndices, setVisibleIndices] = useState<number[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [railWindow, setRailWindow] = useState({ start: 0, end: 44, rowSize: 12 })
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null)
  const [availableMessageIds, setAvailableMessageIds] = useState<Set<string>>(
    () => new Set(marks.map((mark) => mark.id))
  )
  const [railPosition, setRailPosition] = useState<RunMarkRailPosition | null>(null)
  const previewId = useId()
  const [preview, setPreview] = useState<{
    id: string
    railPosition: RunMarkRailPosition | null
    left: number
    top: number
    open: boolean
  } | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const cancelPreviewClose = (): void => {
    window.clearTimeout(closeTimerRef.current)
  }
  const closePreview = useCallback((): void => {
    window.clearTimeout(closeTimerRef.current)
    setPreview((current) => (current?.open ? { ...current, open: false } : current))
    setHighlightedIndex(null)
  }, [])
  const schedulePreviewClose = (): void => {
    cancelPreviewClose()
    closeTimerRef.current = setTimeout(closePreview, 120)
  }
  const showPreview = (mark: RunMark, index: number, button: HTMLButtonElement): void => {
    cancelPreviewClose()
    const rect = button.getBoundingClientRect()
    const width = Math.min(RUN_MARK_PREVIEW_WIDTH_PX, window.innerWidth - 24)
    const rtl = window.getComputedStyle(viewport ?? button).direction === 'rtl'
    const preferredLeft = rtl ? rect.left - width - 8 : rect.right + 8
    setHighlightedIndex(index)
    setPreview({
      id: mark.id,
      railPosition,
      left: Math.max(12, Math.min(preferredLeft, window.innerWidth - width - 12)),
      top: Math.max(
        RUN_MARK_PREVIEW_MARGIN_PX,
        Math.min(
          rect.top + rect.height / 2 - RUN_MARK_PREVIEW_HEIGHT_PX / 2,
          window.innerHeight - RUN_MARK_PREVIEW_HEIGHT_PX - RUN_MARK_PREVIEW_MARGIN_PX
        )
      ),
      open: true
    })
  }
  useEffect(() => {
    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closePreview()
    }
    document.addEventListener('keydown', dismissOnEscape)
    window.addEventListener('resize', closePreview)
    viewport?.addEventListener('scroll', closePreview, { passive: true })
    return () => {
      window.clearTimeout(closeTimerRef.current)
      document.removeEventListener('keydown', dismissOnEscape)
      window.removeEventListener('resize', closePreview)
      viewport?.removeEventListener('scroll', closePreview)
    }
  }, [closePreview, viewport])
  const railRef = useRef<HTMLOListElement | null>(null)
  const animationFrameRef = useRef<number | undefined>(undefined)
  const currentPositionRef = useRef(0)

  const updateRailWindow = useCallback((): void => {
    const rail = railRef.current
    if (!rail || rail.clientHeight === 0) return
    const rowSize = Math.max(
      RUN_MARK_MIN_ROW_SIZE_PX,
      Math.min(RUN_MARK_ROW_SIZE_PX, rail.clientHeight / marks.length)
    )
    const start = Math.max(0, Math.floor(rail.scrollTop / rowSize) - 4)
    const end = Math.min(
      marks.length,
      Math.ceil((rail.scrollTop + rail.clientHeight) / rowSize) + 4
    )
    setRailWindow((previous) =>
      previous.start === start && previous.end === end && previous.rowSize === rowSize
        ? previous
        : { start, end, rowSize }
    )
  }, [marks.length])

  const updateRailScroll = useCallback(
    (position: number): void => {
      const rail = railRef.current
      if (!rail || rail.clientHeight === 0) return
      const rowSize = Math.max(
        RUN_MARK_MIN_ROW_SIZE_PX,
        Math.min(RUN_MARK_ROW_SIZE_PX, rail.clientHeight / marks.length)
      )
      const markTop = position * rowSize
      const inset = Math.min(rowSize, rail.clientHeight / 4)
      const nextTop = Math.max(
        markTop + rowSize + inset - rail.clientHeight,
        Math.min(rail.scrollTop, markTop - inset)
      )
      rail.scrollTop = Math.max(0, Math.min(nextTop, marks.length * rowSize - rail.clientHeight))
      updateRailWindow()
    },
    [marks.length, updateRailWindow]
  )

  const updateCurrentIndex = useCallback((): DOMRect | undefined => {
    if (!viewport || marks.length === 0) return
    const bounds = viewport.getBoundingClientRect()
    const visible = new Set<number>()
    const promptTops = new Map<number, number>()
    for (const element of viewport.querySelectorAll<HTMLElement>('[data-message-id]')) {
      const index = markIndexByItemId.get(element.dataset.messageId ?? '')
      if (index === undefined) continue
      const rect = element.getBoundingClientRect()
      if (marks[index]?.id === element.dataset.messageId) promptTops.set(index, rect.top)
      if (rect.bottom > bounds.top && rect.top < bounds.bottom) visible.add(index)
    }
    const nextVisible = [...visible].sort((a, b) => a - b)
    setVisibleIndices((previous) =>
      previous.length === nextVisible.length &&
      previous.every((value, index) => value === nextVisible[index])
        ? previous
        : nextVisible
    )
    const position = Math.max(
      resolveRunMarkPosition(promptTops, bounds.top + RUN_MARK_READING_BOUNDARY_PX),
      nextVisible[0] ?? 0
    )
    currentPositionRef.current = position
    setCurrentIndex(Math.floor(position))
    updateRailScroll(position)
    return bounds
  }, [markIndexByItemId, marks, updateRailScroll, viewport])

  const updateRailPosition = useCallback(
    (viewportRect: DOMRect): void => {
      if (!viewport) return

      const panel = viewport.closest<HTMLElement>('section[data-session-id]')
      const panelRect = panel ? panel.getBoundingClientRect() : viewportRect
      const top = panelRect.top + panelRect.height / 2
      const isRtl = window.getComputedStyle(viewport).direction === 'rtl'
      const nextPosition: RunMarkRailPosition = isRtl
        ? { right: window.innerWidth - viewportRect.right - RUN_MARK_INLINE_OFFSET_PX, top }
        : { left: viewportRect.left - RUN_MARK_INLINE_OFFSET_PX, top }

      setRailPosition((current) => {
        if (
          current?.left === nextPosition.left &&
          current?.right === nextPosition.right &&
          current?.top === nextPosition.top
        ) {
          return current
        }
        return nextPosition
      })
    },
    [viewport]
  )

  useLayoutEffect(() => {
    if (!viewport || marks.length < 4) return

    const renderedMessageIds = new Set(
      Array.from(viewport.querySelectorAll<HTMLElement>('[data-message-id]')).flatMap((element) =>
        element.dataset.messageId ? [element.dataset.messageId] : []
      )
    )
    // The rendered transcript is the source of truth for whether a projected mark is navigable.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAvailableMessageIds(renderedMessageIds)
    const update = (): void => {
      if (window.matchMedia?.('(min-width: 48rem)').matches === false) return
      const bounds = updateCurrentIndex()
      if (bounds) updateRailPosition(bounds)
    }
    update()

    const scheduleLayoutUpdate = (): void => {
      if (animationFrameRef.current !== undefined) return
      animationFrameRef.current = window.requestAnimationFrame(() => {
        animationFrameRef.current = undefined
        update()
      })
    }
    viewport.addEventListener('scroll', scheduleLayoutUpdate, { passive: true })
    window.addEventListener('resize', scheduleLayoutUpdate)

    const panel = viewport.closest<HTMLElement>('section[data-session-id]')
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleLayoutUpdate)
    resizeObserver?.observe(viewport)
    if (viewport.firstElementChild) resizeObserver?.observe(viewport.firstElementChild)
    if (panel && panel !== viewport) resizeObserver?.observe(panel)

    return () => {
      viewport.removeEventListener('scroll', scheduleLayoutUpdate)
      window.removeEventListener('resize', scheduleLayoutUpdate)
      resizeObserver?.disconnect()
      if (animationFrameRef.current !== undefined) {
        window.cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = undefined
      }
    }
  }, [marks, updateCurrentIndex, updateRailPosition, viewport])

  // The portal is mounted after its first measurement; also follow after panel/window resizing.
  useLayoutEffect(() => {
    if (!viewport || marks.length < 4) return
    updateRailScroll(currentPositionRef.current)
  }, [marks, railPosition, updateRailScroll, viewport, visibleIndices])

  const scrollToRun = (mark: RunMark, index: number): void => {
    if (!viewport) return
    const target = findMessageTarget(viewport, mark.id)
    onRevealMessage?.(mark.id)
    if (!target) {
      setCurrentIndex(index)
      return
    }

    const viewportTop = viewport.getBoundingClientRect().top
    const targetTop = target.getBoundingClientRect().top
    const maximumScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    const nextScrollTop = Math.min(
      Math.max(0, viewport.scrollTop + targetTop - viewportTop - RUN_MARK_TOP_OFFSET_PX),
      maximumScrollTop
    )
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    viewport.scrollTo({ top: nextScrollTop, behavior: reduceMotion ? 'auto' : 'smooth' })
    setCurrentIndex(index)
  }

  if (marks.length < 4 || !railPosition || typeof document === 'undefined') return null

  const railStyle: CSSProperties = {
    height: `${Math.min(marks.length * RUN_MARK_ROW_SIZE_PX, RUN_MARK_MAX_RAIL_HEIGHT_PX)}px`,
    maxHeight: 'calc(100vh - 6rem)'
  }
  // Keep both logical tab-entry endpoints and the focused item mounted. All other DOM is
  // bounded by the visible rail window, independently of the history length.
  const renderedIndices = new Set<number>([0, marks.length - 1])
  for (let index = railWindow.start; index < Math.min(railWindow.end, marks.length); index++) {
    renderedIndices.add(index)
  }
  const focusedIndex = focusedId === null ? -1 : (markIndexByItemId.get(focusedId) ?? -1)
  if (focusedIndex >= 0) renderedIndices.add(focusedIndex)
  const previewFallback = {
    attachment: t('Attachment'),
    content: t('Content'),
    image: t('Image')
  }

  const previewMark = marks.find((mark) => mark.id === preview?.id)
  // A measured preview belongs to one rail position. ResizeObserver may move the rail
  // without a window resize; invalidate the old anchor without another state update.
  const previewOpen =
    preview?.open && preview.railPosition === railPosition && previewMark !== undefined

  return createPortal(
    <>
      <nav
        aria-label={t('Run marks')}
        className="pointer-events-none fixed z-20 hidden w-6 -translate-y-1/2 md:block"
        style={railPosition}
      >
        <ol
          ref={railRef}
          className="pointer-events-auto relative w-full overflow-hidden"
          onScroll={updateRailWindow}
          style={railStyle}
        >
          <li
            role="presentation"
            aria-hidden="true"
            style={{ height: marks.length * railWindow.rowSize }}
          />
          {[...renderedIndices]
            .sort((a, b) => a - b)
            .map((index) => {
              const mark = marks[index]!
              const isCurrent = index === currentIndex
              const disabled = !onRevealMessage && !availableMessageIds.has(mark.id)
              const userPreview = normalizePreviewText(mark.userMessage, previewFallback)
              const accessiblePreview =
                userPreview.length > 80 ? `${userPreview.slice(0, 80)}…` : userPreview

              return (
                <li
                  key={mark.id}
                  className="absolute inset-x-0 min-h-0"
                  aria-posinset={index + 1}
                  aria-setsize={marks.length}
                  style={{ top: index * railWindow.rowSize, height: railWindow.rowSize }}
                >
                  <button
                    type="button"
                    data-run-index={index}
                    className="group/run-mark flex size-full min-h-1 items-center rounded-sm ps-1 outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring/60 disabled:cursor-not-allowed disabled:opacity-40"
                    data-visible={visibleIndices.includes(index) || undefined}
                    aria-current={isCurrent ? 'location' : undefined}
                    aria-label={t('Go to run {{index}}: {{preview}}', {
                      index: index + 1,
                      preview: accessiblePreview
                    })}
                    disabled={disabled}
                    aria-describedby={
                      previewOpen && preview?.id === mark.id ? previewId : undefined
                    }
                    onClick={() => {
                      closePreview()
                      scrollToRun(mark, index)
                    }}
                    onBlur={() => {
                      setFocusedId(null)
                      schedulePreviewClose()
                    }}
                    onFocus={(event) => {
                      setFocusedId(mark.id)
                      updateRailScroll(index)
                      showPreview(mark, index, event.currentTarget)
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey)
                        return
                      const step = event.shiftKey ? -1 : 1
                      let next = index + step
                      while (
                        next >= 0 &&
                        next < marks.length &&
                        !onRevealMessage &&
                        !availableMessageIds.has(marks[next]!.id)
                      )
                        next += step
                      if (next < 0 || next >= marks.length) return
                      event.preventDefault()
                      flushSync(() => {
                        setFocusedId(marks[next]!.id)
                        updateRailScroll(next)
                      })
                      railRef.current
                        ?.querySelector<HTMLButtonElement>(`button[data-run-index="${next}"]`)
                        ?.focus({ preventScroll: true })
                    }}
                    onPointerEnter={(event) => {
                      if (event.pointerType !== 'touch')
                        showPreview(mark, index, event.currentTarget)
                    }}
                    onPointerLeave={(event) => {
                      if (document.activeElement !== event.currentTarget) {
                        setHighlightedIndex(null)
                        schedulePreviewClose()
                      }
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className={runMarkIndicatorClassName(
                        previewOpen ? highlightedIndex : null,
                        index,
                        visibleIndices.includes(index)
                      )}
                    />
                  </button>
                </li>
              )
            })}
        </ol>
      </nav>
      {preview && previewMark ? (
        <div
          id={previewId}
          role="tooltip"
          aria-hidden={!previewOpen}
          data-slot="run-mark-preview"
          data-open={previewOpen || undefined}
          onPointerEnter={cancelPreviewClose}
          onPointerLeave={schedulePreviewClose}
          className="fixed left-0 top-0 z-50 hidden h-[88px] w-64 max-w-[calc(100vw-24px)] rounded-xl border border-border-200 bg-bg-000 p-3 text-start text-text-000 shadow-dialog transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] md:block data-[open]:opacity-100 [&:not([data-open])]:pointer-events-none [&:not([data-open])]:opacity-0 starting:opacity-0 motion-reduce:transition-none"
          style={{ transform: `translate3d(${preview.left}px, ${preview.top}px, 0)` }}
        >
          <p className="truncate text-xs font-semibold leading-4 text-text-000">
            {normalizePreviewText(previewMark.userMessage, previewFallback)}
          </p>
          {previewMark.agentMessage ? (
            <p className="mt-1 line-clamp-2 break-words text-xs leading-4 text-text-200">
              {normalizePreviewText(previewMark.agentMessage, previewFallback)}
            </p>
          ) : null}
        </div>
      ) : null}
    </>,
    document.body
  )
}

export { WorkspaceRunMarks }
export type { WorkspaceRunMarksProps }
