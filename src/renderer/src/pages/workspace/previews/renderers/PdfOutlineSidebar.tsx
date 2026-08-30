/* Hallmark · component: PDF navigation · genre: modern-minimal · theme: Open Science tokens */
import { ChevronLeft, ChevronRight, Files, ListTree } from 'lucide-react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent
} from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import { useNearViewport } from '../useNearViewport'

export type PdfOutlineItem = Readonly<{
  id: string
  title: string
  pageNumber?: number
  children: readonly PdfOutlineItem[]
}>

type PdfNavigationMode = 'outline' | 'pages'
type PdfThumbnailDocument = Pick<PDFDocumentProxy, 'getPage'>
type VisibleOutlineItem = Readonly<{
  item: PdfOutlineItem
  level: number
  parentId?: string
}>

const SIDEBAR_MIN_WIDTH = 160
const SIDEBAR_MAX_WIDTH = 360
const SIDEBAR_RESIZE_STEP = 16
const THUMBNAIL_WIDTH = 128
const THUMBNAIL_ROW_HEIGHT = 224
const THUMBNAIL_OVERSCAN = 4
const MAX_RENDERED_THUMBNAILS = 24

type ResizeGesture = Readonly<{ pointerId: number; startX: number; startWidth: number }>

const clampWidth = (width: number): number =>
  Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)))

const collectParents = (
  items: readonly PdfOutlineItem[],
  parents = new Map<string, string | undefined>(),
  parentId?: string
): Map<string, string | undefined> => {
  for (const item of items) {
    parents.set(item.id, parentId)
    collectParents(item.children, parents, item.id)
  }
  return parents
}

const flattenVisible = (
  items: readonly PdfOutlineItem[],
  expanded: ReadonlySet<string>,
  level = 1,
  parentId?: string,
  result: VisibleOutlineItem[] = []
): VisibleOutlineItem[] => {
  for (const item of items) {
    result.push({ item, level, parentId })
    if (item.children.length > 0 && expanded.has(item.id)) {
      flattenVisible(item.children, expanded, level + 1, item.id, result)
    }
  }
  return result
}

const activeOutlineId = (
  items: readonly PdfOutlineItem[],
  currentPage: number
): string | undefined => {
  let active: PdfOutlineItem | undefined
  let activePage = 0
  const visit = (children: readonly PdfOutlineItem[]): void => {
    for (const item of children) {
      if (
        item.pageNumber !== undefined &&
        item.pageNumber <= currentPage &&
        item.pageNumber >= activePage
      ) {
        active = item
        activePage = item.pageNumber
      }
      visit(item.children)
    }
  }
  visit(items)
  return active?.id
}

const PdfThumbnail = ({
  document,
  pageNumber,
  label,
  active,
  onNavigate
}: {
  document: PdfThumbnailDocument
  pageNumber: number
  label: string
  active: boolean
  onNavigate: (pageNumber: number) => void
}): React.JSX.Element => {
  const [setNearViewportRef, isNearViewport] = useNearViewport<HTMLButtonElement>()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (active) buttonRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!isNearViewport || !canvas) return
    let canceled = false
    let page: Awaited<ReturnType<PdfThumbnailDocument['getPage']>> | undefined
    let renderTask: ReturnType<Awaited<ReturnType<PdfThumbnailDocument['getPage']>>['render']>
    void document
      .getPage(pageNumber)
      .then((value) => {
        if (canceled) {
          value.cleanup()
          return
        }
        page = value
        const base = value.getViewport({ scale: 1 })
        const viewport = value.getViewport({ scale: THUMBNAIL_WIDTH / base.width })
        const context = canvas.getContext('2d')
        if (!context) return
        canvas.width = Math.max(1, Math.round(viewport.width))
        canvas.height = Math.max(1, Math.round(viewport.height))
        renderTask = value.render({ canvas, canvasContext: context, viewport })
        void renderTask.promise.catch(() => undefined)
      })
      .catch(() => undefined)
    return () => {
      canceled = true
      renderTask?.cancel()
      page?.cleanup()
      canvas.width = 0
      canvas.height = 0
    }
  }, [document, isNearViewport, pageNumber])

  return (
    <button
      ref={(element) => {
        buttonRef.current = element
        setNearViewportRef(element)
      }}
      type="button"
      className={cn(
        'group flex w-full flex-col items-center gap-1 rounded-md px-2 py-2 text-xs text-text-200',
        'hover:bg-bg-200 hover:text-text-000 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        active && 'bg-primary/8 text-text-000 ring-1 ring-inset ring-primary/35'
      )}
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      onClick={() => onNavigate(pageNumber)}
    >
      <span className="flex min-h-24 w-full items-center justify-center overflow-hidden rounded-sm border border-border-200 bg-bg-000 shadow-sm">
        <canvas ref={canvasRef} className="block max-w-full" aria-hidden="true" />
      </span>
      <span className="max-w-full truncate tabular-nums">{label}</span>
    </button>
  )
}

const PdfThumbnailList = ({
  document,
  pageCount,
  pageLabels,
  currentPage,
  onNavigate
}: {
  document: PdfThumbnailDocument
  pageCount: number
  pageLabels?: readonly string[] | null
  currentPage: number
  onNavigate: (pageNumber: number) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [visibleRange, setVisibleRange] = useState(() => ({
    start: Math.max(0, currentPage - 1 - THUMBNAIL_OVERSCAN),
    end: Math.min(pageCount, MAX_RENDERED_THUMBNAILS)
  }))
  const updateVisibleRange = useCallback((): void => {
    const scroll = scrollRef.current
    if (!scroll) return
    const visibleRows = Math.max(1, Math.ceil(scroll.clientHeight / THUMBNAIL_ROW_HEIGHT))
    const renderedRows = Math.min(MAX_RENDERED_THUMBNAILS, visibleRows + THUMBNAIL_OVERSCAN * 2)
    const start = Math.min(
      Math.max(0, Math.floor(scroll.scrollTop / THUMBNAIL_ROW_HEIGHT) - THUMBNAIL_OVERSCAN),
      Math.max(0, pageCount - renderedRows)
    )
    const end = Math.min(pageCount, start + renderedRows)
    setVisibleRange((current) =>
      current.start === start && current.end === end ? current : { start, end }
    )
  }, [pageCount])

  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    const currentIndex = Math.max(0, Math.min(pageCount - 1, currentPage - 1))
    const rowTop = currentIndex * THUMBNAIL_ROW_HEIGHT
    const rowBottom = rowTop + THUMBNAIL_ROW_HEIGHT
    if (rowTop < scroll.scrollTop) scroll.scrollTop = rowTop
    else if (rowBottom > scroll.scrollTop + scroll.clientHeight) {
      scroll.scrollTop = Math.max(0, rowBottom - scroll.clientHeight)
    }
    updateVisibleRange()
  }, [currentPage, pageCount, updateVisibleRange])

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5"
      onScroll={updateVisibleRange}
    >
      <div
        className="relative"
        style={{ height: `${pageCount * THUMBNAIL_ROW_HEIGHT}px` }}
        aria-label={t('Pages')}
      >
        <div
          className="absolute inset-x-0 top-0"
          style={{ transform: `translateY(${visibleRange.start * THUMBNAIL_ROW_HEIGHT}px)` }}
        >
          {Array.from({ length: visibleRange.end - visibleRange.start }, (_, offset) => {
            const pageNumber = visibleRange.start + offset + 1
            const customLabel = pageLabels?.[pageNumber - 1]
            const label = customLabel
              ? `${t('Page {{page}}', { page: pageNumber })} · ${customLabel}`
              : t('Page {{page}}', { page: pageNumber })
            return (
              <div key={pageNumber} style={{ height: `${THUMBNAIL_ROW_HEIGHT}px` }}>
                <PdfThumbnail
                  document={document}
                  pageNumber={pageNumber}
                  label={label}
                  active={currentPage === pageNumber}
                  onNavigate={onNavigate}
                />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

const PdfOutlineTree = ({
  items,
  currentPage,
  onNavigate
}: {
  items: readonly PdfOutlineItem[]
  currentPage: number
  onNavigate: (pageNumber: number) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const parents = useMemo(() => collectParents(items), [items])
  const activeId = useMemo(() => activeOutlineId(items, currentPage), [currentPage, items])
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(items.filter((item) => item.children.length > 0).map((item) => item.id))
  )
  const [focusedId, setFocusedId] = useState<string | undefined>(activeId ?? items[0]?.id)
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())
  const visibleExpanded = useMemo(() => {
    const next = new Set(expanded)
    let parentId = activeId ? parents.get(activeId) : undefined
    while (parentId) {
      next.add(parentId)
      parentId = parents.get(parentId)
    }
    return next
  }, [activeId, expanded, parents])
  const visible = useMemo(() => flattenVisible(items, visibleExpanded), [items, visibleExpanded])
  const effectiveFocusedId = visible.some(({ item }) => item.id === focusedId)
    ? focusedId
    : (activeId ?? visible[0]?.item.id)
  const toggle = (id: string, force?: boolean): void => {
    setExpanded((current) => {
      const next = new Set(current)
      const shouldExpand = force ?? !next.has(id)
      if (shouldExpand) next.add(id)
      else next.delete(id)
      return next
    })
  }
  const focusItem = (id: string | undefined): void => {
    if (!id) return
    setFocusedId(id)
    requestAnimationFrame(() => itemRefs.current.get(id)?.focus())
  }

  useEffect(() => {
    if (activeId) itemRefs.current.get(activeId)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  return (
    <ul role="tree" aria-label={t('Outline')} className="space-y-0.5">
      {visible.map(({ item, level, parentId }, index) => {
        const hasChildren = item.children.length > 0
        const isExpanded = hasChildren && visibleExpanded.has(item.id)
        const isActive = item.id === activeId
        return (
          <li key={item.id} role="none">
            <div
              className={cn(
                'group relative flex min-h-7 items-center rounded-md text-xs text-text-100 hover:bg-bg-200 hover:text-text-000',
                isActive &&
                  'bg-primary/8 text-text-000 before:absolute before:inset-y-1 before:start-0 before:w-0.5 before:rounded-full before:bg-primary'
              )}
              style={{ paddingInlineStart: `${Math.max(0, level - 1) * 16 + 2}px` }}
            >
              {hasChildren ? (
                <button
                  type="button"
                  tabIndex={-1}
                  className="flex size-6 shrink-0 items-center justify-center rounded text-text-300 hover:bg-bg-300 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  aria-label={isExpanded ? t('Collapse') : t('Expand')}
                  aria-expanded={isExpanded}
                  onClick={() => toggle(item.id)}
                >
                  <ChevronRight className={cn('size-3.5', isExpanded && 'rotate-90')} />
                </button>
              ) : (
                <span className="size-6 shrink-0" />
              )}
              <button
                ref={(element) => {
                  if (element) itemRefs.current.set(item.id, element)
                  else itemRefs.current.delete(item.id)
                }}
                type="button"
                role="treeitem"
                tabIndex={effectiveFocusedId === item.id ? 0 : -1}
                aria-level={level}
                aria-selected={isActive}
                aria-expanded={hasChildren ? isExpanded : undefined}
                className="min-w-0 flex-1 rounded px-1.5 py-1 text-left leading-4 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                title={item.title}
                onFocus={() => setFocusedId(item.id)}
                onClick={() =>
                  item.pageNumber !== undefined
                    ? onNavigate(item.pageNumber)
                    : hasChildren && toggle(item.id)
                }
                onKeyDown={(event) => {
                  if (event.key === 'ArrowUp') focusItem(visible[index - 1]?.item.id)
                  else if (event.key === 'ArrowDown') focusItem(visible[index + 1]?.item.id)
                  else if (event.key === 'ArrowRight' && hasChildren) {
                    if (!isExpanded) toggle(item.id, true)
                    else focusItem(item.children[0]?.id)
                  } else if (event.key === 'ArrowLeft') {
                    if (hasChildren && isExpanded) toggle(item.id, false)
                    else focusItem(parentId)
                  } else if (event.key === 'Enter') {
                    if (item.pageNumber !== undefined) onNavigate(item.pageNumber)
                    else if (hasChildren) toggle(item.id)
                  } else return
                  event.preventDefault()
                }}
              >
                <span className="line-clamp-2 break-words">{item.title}</span>
              </button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export const PdfOutlineSidebar = ({
  document,
  items,
  pageCount,
  pageLabels,
  currentPage,
  width,
  onWidthChange,
  onClose,
  onNavigate
}: {
  document: PdfThumbnailDocument
  items: readonly PdfOutlineItem[]
  pageCount: number
  pageLabels?: readonly string[] | null
  currentPage: number
  width: number
  onWidthChange: (width: number) => void
  onClose: () => void
  onNavigate: (pageNumber: number) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [mode, setMode] = useState<PdfNavigationMode>(items.length > 0 ? 'outline' : 'pages')
  const resizeGestureRef = useRef<ResizeGesture | undefined>(undefined)
  const resizeTo = (nextWidth: number): void => onWidthChange(clampWidth(nextWidth))

  const effectiveMode: PdfNavigationMode = items.length > 0 ? mode : 'pages'

  return (
    <aside
      id="pdf-navigation-sidebar"
      className="relative flex shrink-0 flex-col border-r border-border-200 bg-bg-000 text-text-000"
      style={{ width }}
      aria-label={t('PDF navigation')}
    >
      <div className="grid h-10 shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_1.75rem] gap-1 border-b border-border-200 p-1">
        <button
          type="button"
          className={cn(
            'inline-flex items-center justify-center gap-1 rounded text-xs text-text-200 hover:bg-bg-200 hover:text-text-000',
            effectiveMode === 'outline' && 'bg-bg-200 font-medium text-text-000'
          )}
          disabled={items.length === 0}
          aria-pressed={effectiveMode === 'outline'}
          onClick={() => setMode('outline')}
        >
          <ListTree className="size-3.5" aria-hidden="true" />
          {t('Outline')}
        </button>
        <button
          type="button"
          className={cn(
            'inline-flex items-center justify-center gap-1 rounded text-xs text-text-200 hover:bg-bg-200 hover:text-text-000',
            effectiveMode === 'pages' && 'bg-bg-200 font-medium text-text-000'
          )}
          aria-pressed={effectiveMode === 'pages'}
          onClick={() => setMode('pages')}
        >
          <Files className="size-3.5" aria-hidden="true" />
          {t('Pages')}
        </button>
        <button
          type="button"
          className="inline-flex items-center justify-center rounded text-text-300 hover:bg-bg-200 hover:text-text-000 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-label={t('Hide navigation')}
          title={t('Hide navigation')}
          onClick={onClose}
        >
          <ChevronLeft className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      {effectiveMode === 'outline' ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
          <PdfOutlineTree items={items} currentPage={currentPage} onNavigate={onNavigate} />
        </div>
      ) : (
        <PdfThumbnailList
          document={document}
          pageCount={pageCount}
          pageLabels={pageLabels}
          currentPage={currentPage}
          onNavigate={onNavigate}
        />
      )}
      <button
        type="button"
        role="separator"
        aria-label={t('Resize navigation')}
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={width}
        className="group absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none select-none focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          resizeTo(
            width + (event.key === 'ArrowRight' ? SIDEBAR_RESIZE_STEP : -SIDEBAR_RESIZE_STEP)
          )
        }}
        onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
          if (event.button !== 0 || !event.isPrimary) return
          event.currentTarget.setPointerCapture?.(event.pointerId)
          resizeGestureRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startWidth: width
          }
        }}
        onPointerMove={(event) => {
          const gesture = resizeGestureRef.current
          if (gesture?.pointerId === event.pointerId) {
            resizeTo(gesture.startWidth + event.clientX - gesture.startX)
          }
        }}
        onPointerUp={(event) => {
          const gesture = resizeGestureRef.current
          if (gesture?.pointerId !== event.pointerId) return
          resizeGestureRef.current = undefined
          if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
          if (gesture.startWidth + event.clientX - gesture.startX < SIDEBAR_MIN_WIDTH) onClose()
        }}
        onPointerCancel={() => {
          resizeGestureRef.current = undefined
        }}
      >
        <span className="mx-auto block h-full w-px bg-transparent group-hover:bg-primary/50 group-focus-visible:bg-primary/60" />
      </button>
    </aside>
  )
}
