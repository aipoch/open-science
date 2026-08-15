/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
/* Hallmark · component: run marks · genre: modern-minimal · theme: project tokens
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: project token contract
 */
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'

import type { GroupedConversationItem } from './workspace-tool-activity-groups'
import {
  createRunMarks,
  findMessageTarget,
  normalizePreviewText,
  resolveCurrentRunMarkIndex,
  runMarkIndicatorClassName,
  type RunMark
} from './workspace-run-marks'

type WorkspaceRunMarksProps = {
  items: readonly GroupedConversationItem[]
  viewportRef: RefObject<HTMLDivElement | null>
}

const RUN_MARK_HOVER_DELAY_MS = 800
const RUN_MARK_TOP_OFFSET_PX = 8
const RUN_MARK_ROW_SIZE_PX = 24
const RUN_MARK_MAX_RAIL_HEIGHT_PX = 480

const WorkspaceRunMarks = ({
  items,
  viewportRef
}: WorkspaceRunMarksProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const marks = useMemo(() => createRunMarks(items), [items])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null)
  const [availableMessageIds, setAvailableMessageIds] = useState<Set<string>>(
    () => new Set(marks.map((mark) => mark.id))
  )
  const animationFrameRef = useRef<number | undefined>(undefined)

  const updateCurrentIndex = useCallback((): void => {
    const viewport = viewportRef.current
    if (!viewport || marks.length === 0) return
    setCurrentIndex(resolveCurrentRunMarkIndex(viewport, marks))
  }, [marks, viewportRef])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const renderedMessageIds = new Set(
      Array.from(viewport.querySelectorAll<HTMLElement>('[data-message-id]')).flatMap((element) =>
        element.dataset.messageId ? [element.dataset.messageId] : []
      )
    )
    setAvailableMessageIds(
      new Set(marks.flatMap((mark) => (renderedMessageIds.has(mark.id) ? [mark.id] : [])))
    )
    updateCurrentIndex()

    const scheduleCurrentIndexUpdate = (): void => {
      if (animationFrameRef.current !== undefined) return
      animationFrameRef.current = window.requestAnimationFrame(() => {
        animationFrameRef.current = undefined
        updateCurrentIndex()
      })
    }
    viewport.addEventListener('scroll', scheduleCurrentIndexUpdate, { passive: true })
    window.addEventListener('resize', scheduleCurrentIndexUpdate)

    return () => {
      viewport.removeEventListener('scroll', scheduleCurrentIndexUpdate)
      window.removeEventListener('resize', scheduleCurrentIndexUpdate)
      if (animationFrameRef.current !== undefined) {
        window.cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = undefined
      }
    }
  }, [marks, updateCurrentIndex, viewportRef])

  const scrollToRun = (mark: RunMark, index: number): void => {
    const viewport = viewportRef.current
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

  if (marks.length < 2) return null

  const railStyle: CSSProperties = {
    height: `min(${Math.min(marks.length * RUN_MARK_ROW_SIZE_PX, RUN_MARK_MAX_RAIL_HEIGHT_PX)}px, 100%)`,
    gridTemplateRows: `repeat(${marks.length}, minmax(0, 1fr))`
  }
  const previewFallback = {
    attachment: t('Attachment'),
    content: t('Content'),
    image: t('Image')
  }

  return (
    <TooltipProvider delayDuration={RUN_MARK_HOVER_DELAY_MS} skipDelayDuration={0}>
      <nav
        aria-label={t('Run marks')}
        className="pointer-events-none absolute inset-y-6 start-0 z-20 hidden w-6 items-center md:flex"
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
                    className="w-[min(24rem,calc(100vw-3rem))] rounded-xl border border-border-200 bg-bg-000 p-0 text-left text-text-000 shadow-dialog"
                  >
                    <div className="grid gap-3 p-3.5">
                      <section className="grid min-w-0 gap-1">
                        <h2 className="text-xs font-semibold text-text-100">{t('You')}</h2>
                        <p className="line-clamp-4 min-w-0 whitespace-pre-wrap break-words text-[13px] leading-5">
                          {userPreview}
                        </p>
                      </section>
                      {agentPreview ? (
                        <section className="grid min-w-0 gap-1 border-t border-border-200 pt-3">
                          <h2 className="text-xs font-semibold text-text-100">{t('Agent')}</h2>
                          <p className="line-clamp-4 min-w-0 whitespace-pre-wrap break-words text-[13px] leading-5 text-text-100">
                            {agentPreview}
                          </p>
                        </section>
                      ) : null}
                    </div>
                  </TooltipContent>
                </Tooltip>
              </li>
            )
          })}
        </ol>
      </nav>
    </TooltipProvider>
  )
}

export { WorkspaceRunMarks }
export type { WorkspaceRunMarksProps }
