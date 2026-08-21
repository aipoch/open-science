/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
/* Hallmark · component: run marks · genre: modern-minimal · theme: project tokens
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: project token contract
 */
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { type CSSProperties, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import type { WorkspaceConversationTimelineItem } from './workspace-conversation-timeline'
import {
  createRunMarks,
  findMessageTarget,
  normalizePreviewText,
  resolveCurrentRunMarkIndex,
  runMarkIndicatorClassName,
  type RunMark
} from './workspace-run-marks'

type WorkspaceRunMarksProps = {
  items: readonly WorkspaceConversationTimelineItem[]
  viewport: HTMLDivElement | null
}

const RUN_MARK_HOVER_DELAY_MS = 200
const RUN_MARK_INLINE_OFFSET_PX = 8
const RUN_MARK_TOP_OFFSET_PX = 8
const RUN_MARK_ROW_SIZE_PX = 10
const RUN_MARK_MAX_RAIL_HEIGHT_PX = 480

type RunMarkRailPosition = {
  left?: number
  right?: number
  top: number
}

const WorkspaceRunMarks = ({
  items,
  viewport
}: WorkspaceRunMarksProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const marks = useMemo(() => createRunMarks(items), [items])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null)
  const [availableMessageIds, setAvailableMessageIds] = useState<Set<string>>(
    () => new Set(marks.map((mark) => mark.id))
  )
  const [railPosition, setRailPosition] = useState<RunMarkRailPosition | null>(null)
  const animationFrameRef = useRef<number | undefined>(undefined)
  const layoutAnimationFrameRef = useRef<number | undefined>(undefined)

  const updateCurrentIndex = useCallback((): void => {
    if (!viewport || marks.length === 0) return
    setCurrentIndex(resolveCurrentRunMarkIndex(viewport, marks))
  }, [marks, viewport])

  const updateRailPosition = useCallback((): void => {
    if (!viewport) return

    const panel = viewport.closest<HTMLElement>('section[data-session-id]')
    const panelRect = (panel ?? viewport).getBoundingClientRect()
    const viewportRect = viewport.getBoundingClientRect()
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
  }, [viewport])

  useLayoutEffect(() => {
    if (!viewport) return

    const renderedMessageIds = new Set(
      Array.from(viewport.querySelectorAll<HTMLElement>('[data-message-id]')).flatMap((element) =>
        element.dataset.messageId ? [element.dataset.messageId] : []
      )
    )
    // The rendered transcript is the source of truth for whether a projected mark is navigable.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAvailableMessageIds(
      new Set(marks.flatMap((mark) => (renderedMessageIds.has(mark.id) ? [mark.id] : [])))
    )
    updateCurrentIndex()
    updateRailPosition()

    const scheduleCurrentIndexUpdate = (): void => {
      if (animationFrameRef.current !== undefined) return
      animationFrameRef.current = window.requestAnimationFrame(() => {
        animationFrameRef.current = undefined
        updateCurrentIndex()
      })
    }
    const scheduleLayoutUpdate = (): void => {
      if (layoutAnimationFrameRef.current !== undefined) return
      layoutAnimationFrameRef.current = window.requestAnimationFrame(() => {
        layoutAnimationFrameRef.current = undefined
        updateCurrentIndex()
        updateRailPosition()
      })
    }
    viewport.addEventListener('scroll', scheduleCurrentIndexUpdate, { passive: true })
    window.addEventListener('resize', scheduleLayoutUpdate)

    const panel = viewport.closest<HTMLElement>('section[data-session-id]')
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleLayoutUpdate)
    resizeObserver?.observe(viewport)
    if (panel && panel !== viewport) resizeObserver?.observe(panel)

    return () => {
      viewport.removeEventListener('scroll', scheduleCurrentIndexUpdate)
      window.removeEventListener('resize', scheduleLayoutUpdate)
      resizeObserver?.disconnect()
      if (animationFrameRef.current !== undefined) {
        window.cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = undefined
      }
      if (layoutAnimationFrameRef.current !== undefined) {
        window.cancelAnimationFrame(layoutAnimationFrameRef.current)
        layoutAnimationFrameRef.current = undefined
      }
    }
  }, [marks, updateCurrentIndex, updateRailPosition, viewport])

  const scrollToRun = (mark: RunMark, index: number): void => {
    if (!viewport) return
    const target = findMessageTarget(viewport, mark.id)
    if (!target) return

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

  if (marks.length < 2 || !railPosition || typeof document === 'undefined') return null

  const railStyle: CSSProperties = {
    gridTemplateRows: `repeat(${marks.length}, minmax(0, 1fr))`,
    height: `${Math.min(marks.length * RUN_MARK_ROW_SIZE_PX, RUN_MARK_MAX_RAIL_HEIGHT_PX)}px`,
    maxHeight: 'calc(100vh - 6rem)'
  }
  const previewFallback = {
    attachment: t('Attachment'),
    content: t('Content'),
    image: t('Image')
  }

  return createPortal(
    <TooltipProvider delayDuration={RUN_MARK_HOVER_DELAY_MS} skipDelayDuration={0}>
      <nav
        aria-label={t('Run marks')}
        className="pointer-events-none fixed z-20 hidden w-6 -translate-y-1/2 md:block"
        style={railPosition}
      >
        <ol className="pointer-events-auto grid w-full" style={railStyle}>
          {marks.map((mark, index) => {
            const isCurrent = index === currentIndex
            const disabled = !availableMessageIds.has(mark.id)
            const userPreview = normalizePreviewText(mark.userMessage, previewFallback)
            const agentPreview = mark.agentMessage
              ? normalizePreviewText(mark.agentMessage, previewFallback)
              : undefined
            const accessiblePreview =
              userPreview.length > 80 ? `${userPreview.slice(0, 80)}…` : userPreview

            return (
              <li key={mark.id} className="min-h-0">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="group/run-mark flex size-full min-h-1 items-center rounded-sm ps-1 outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring/60 disabled:cursor-not-allowed disabled:opacity-40"
                      aria-current={isCurrent ? 'location' : undefined}
                      aria-label={t('Go to run {{index}}: {{preview}}', {
                        index: index + 1,
                        preview: accessiblePreview
                      })}
                      disabled={disabled}
                      onClick={() => scrollToRun(mark, index)}
                      onBlur={() =>
                        setHighlightedIndex((current) => (current === index ? null : current))
                      }
                      onFocus={() => setHighlightedIndex(index)}
                      onPointerEnter={() => setHighlightedIndex(index)}
                      onPointerLeave={() =>
                        setHighlightedIndex((current) => (current === index ? null : current))
                      }
                    >
                      <span
                        aria-hidden="true"
                        className={runMarkIndicatorClassName(highlightedIndex, index)}
                      />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="right"
                    align="center"
                    sideOffset={8}
                    collisionPadding={12}
                    className="w-[min(24rem,calc(100vw-3rem))] rounded-xl border border-border-200 bg-bg-000 p-0 text-left text-text-000 shadow-dialog ease-[cubic-bezier(0.16,1,0.3,1)] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=instant-open]:animate-in data-[state=instant-open]:fade-in-0 data-[state=closed]:duration-100 data-[state=delayed-open]:duration-150 data-[state=instant-open]:duration-100 motion-reduce:animate-none"
                  >
                    <div className="grid gap-1.5 p-3.5">
                      <p className="min-w-0 truncate text-[13px] font-semibold leading-5 text-text-000">
                        {userPreview}
                      </p>
                      {agentPreview ? (
                        <p className="line-clamp-2 min-w-0 break-words text-[13px] leading-5 text-text-200">
                          {agentPreview}
                        </p>
                      ) : null}
                    </div>
                  </TooltipContent>
                </Tooltip>
              </li>
            )
          })}
        </ol>
      </nav>
    </TooltipProvider>,
    document.body
  )
}

export { WorkspaceRunMarks }
export type { WorkspaceRunMarksProps }
