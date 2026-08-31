/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
import {
  ChevronDown,
  ChevronUp,
  Hand,
  ListTree,
  MousePointer2,
  Scan,
  Search,
  Shrink,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import type { TextLayerBuilder as PdfTextLayerBuilder } from 'pdfjs-dist/web/pdf_viewer.mjs'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { PreviewFileSource } from '@/stores/preview-workbench-store'
import { useSessionStore } from '@/stores/session-store'
import {
  ANNOTATION_LIMITS,
  pdfAnnotationSourceIsFixed,
  type Annotation,
  type PdfAnnotation
} from '../../../../../../shared/annotations'
import { joinPdfTextItems } from '../../../../../../shared/pdf-text'

import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import {
  annotationRevealScrollBehavior,
  retryPendingAnnotationReveal,
  subscribeAnnotationReveal,
  subscribeAnnotationRevealPreparation
} from '../../annotations/annotation-reveal'
import { createAnnotationId } from '../../annotations/annotation-id'
import { createManagedPdfLoadingTask } from '../managed-pdf-document'
import { pdfjsLib } from '../pdfjs'
import { isUnavailableFileError } from '../preview-errors'
import { createPreviewResourceKey } from '../preview-resource-key'
import { createPreviewRequestScope } from '../preview-file-reader'
import type { PreviewFileRendererProps } from '../preview-types'
import { PreviewTextAnnotationSurface } from '../PreviewTextAnnotationSurface'
import { useNearViewport } from '../useNearViewport'
import { resolvePdfContextTarget } from '../../use-pdf-context-action'
import { subscribePdfReadingReveal } from '../../pdf-reading-reveal'
import {
  cropPdfCanvasRegion,
  normalizedPdfRect,
  pointInPage,
  textInPdfRect
} from '../pdf-region-evidence'
import { PdfOutlineSidebar, type PdfOutlineItem } from './PdfOutlineSidebar'
import {
  countPdfSearchOccurrences,
  resolvePdfSearchMatch,
  type PdfSearchMatch,
  type PdfSearchPageMatches
} from './pdf-search-matches'

type PdfDocument = Awaited<ReturnType<typeof createManagedPdfLoadingTask>['promise']>
type PdfOutlineNode = Awaited<ReturnType<PdfDocument['getOutline']>>[number]
type DocumentState =
  | { requestKey: string; status: 'ready'; document: PdfDocument }
  | { requestKey: string; status: 'error'; error: unknown }
type PdfCursorMode = 'select' | 'hand' | 'area'
type PdfPanGesture = Readonly<{
  pointerId: number
  clientX: number
  clientY: number
  scrollLeft: number
  scrollTop: number
}>
type PdfViewportAnchor = Readonly<{
  pageNumber: number
  x: number
  y: number
  viewportX: number
  viewportY: number
}>
type HighlightConstructor = new (...ranges: Range[]) => unknown
type HighlightRegistry = Readonly<{
  set: (name: string, highlight: unknown) => void
  delete: (name: string) => void
}>

// Comfortable reading width a page fills at 100%; zoom scales the displayed page beyond it.
const FIT_PAGE_WIDTH = 768
const MIN_ZOOM = 0.5
const MAX_ZOOM = 3
const ZOOM_BUTTON_STEP = 0.25
const READING_POSITION_UPDATE_MS = 100
const MAX_SEARCH_TEXT_CACHE_PAGES = 256
const OUTLINE_DEFAULT_WIDTH = 240
// Wheel zoom is proportional to accumulated deltaY so one trackpad/pinch gesture (many small
// events) maps to a controlled amount rather than a full step per event. ~100px notch ≈ 0.25.
const ZOOM_WHEEL_SENSITIVITY = 0.0025

const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))

const pageAtViewportTop = (scroll: HTMLElement, viewport: DOMRect): HTMLElement | undefined => {
  const pages = Array.from(scroll.querySelectorAll<HTMLElement>('[data-page-number]'))
  return pages.find((page) => page.getBoundingClientRect().bottom > viewport.top)
}

const pageAtViewportMidpoint = (
  scroll: HTMLElement,
  viewport: DOMRect
): HTMLElement | undefined => {
  const pages = Array.from(scroll.querySelectorAll<HTMLElement>('[data-page-number]'))
  const midpoint = viewport.top + viewport.height / 2
  let current: HTMLElement | undefined
  for (const page of pages) {
    const bounds = page.getBoundingClientRect()
    if (bounds.height <= 0) continue
    if (bounds.top > midpoint) break
    current = page
  }
  return current ?? pages.find((page) => page.getBoundingClientRect().height > 0)
}

const isEditableTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  (target instanceof HTMLElement && target.isContentEditable)

const textRangesForQuery = (root: HTMLElement, query: string): Range[] => {
  const spans = Array.from(root.querySelectorAll('span')).filter(
    (span): span is HTMLSpanElement => span.firstChild instanceof Text && Boolean(span.textContent)
  )
  const nodes = spans.map((span) => span.firstChild as Text)
  const starts: number[] = []
  let text = ''
  for (const [index, node] of nodes.entries()) {
    const previousSpan = spans[index - 1]
    const currentSpan = spans[index]
    if (previousSpan && currentSpan && !/\s$/u.test(text) && !/^\s/u.test(node.data)) {
      const previousBounds = previousSpan.getBoundingClientRect()
      const currentBounds = currentSpan.getBoundingClientRect()
      const height = Math.max(previousBounds.height, currentBounds.height)
      if (height > 0) {
        if (Math.abs(previousBounds.top - currentBounds.top) > height / 2) text += '\n'
        else if (currentBounds.left - previousBounds.right > height * 0.15) text += ' '
      }
    }
    starts.push(text.length)
    text += node.data
  }
  const normalizedText = text.toLocaleLowerCase()
  const normalizedQuery = query.toLocaleLowerCase()
  if (!normalizedQuery) return []
  const ranges: Range[] = []
  let index = 0
  while ((index = normalizedText.indexOf(normalizedQuery, index)) >= 0) {
    const end = index + normalizedQuery.length
    const startNodeIndex = starts.findLastIndex((start) => start <= index)
    const endNodeIndex = starts.findLastIndex((start) => start < end)
    const startNode = nodes[startNodeIndex]
    const endNode = nodes[endNodeIndex]
    if (startNode && endNode) {
      const range = new Range()
      range.setStart(startNode, index - starts[startNodeIndex])
      range.setEnd(endNode, end - starts[endNodeIndex])
      ranges.push(range)
    }
    index = Math.max(end, index + 1)
  }
  return ranges
}

const updatePdfSearchHighlights = (
  scroll: HTMLElement | null,
  query: string,
  selected?: PdfSearchMatch
): void => {
  const registry = (globalThis as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS
    ?.highlights
  const HighlightClass = (globalThis as unknown as { Highlight?: HighlightConstructor }).Highlight
  registry?.delete('pdf-search-results')
  registry?.delete('pdf-search-current')
  if (!registry || !HighlightClass || !scroll || !query) return
  const allRanges: Range[] = []
  let selectedRange: Range | undefined
  for (const page of scroll.querySelectorAll<HTMLElement>('[data-page-number]')) {
    const layer = page.querySelector<HTMLElement>('[data-pdf-text-layer]')
    if (!layer) continue
    const pageRanges = textRangesForQuery(layer, query)
    allRanges.push(...pageRanges)
    if (Number(page.dataset.pageNumber) === selected?.pageNumber) {
      selectedRange = pageRanges[selected.occurrence]
    }
  }
  if (allRanges.length > 0) registry.set('pdf-search-results', new HighlightClass(...allRanges))
  if (selectedRange) registry.set('pdf-search-current', new HighlightClass(selectedRange))
}

const isPdfPageRef = (value: unknown): value is { num: number; gen: number } =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { num?: unknown }).num === 'number' &&
  typeof (value as { gen?: unknown }).gen === 'number'

const resolvePdfOutlinePage = async (
  document: PdfDocument,
  destination: PdfOutlineNode['dest']
): Promise<number | undefined> => {
  const resolved =
    typeof destination === 'string' ? await document.getDestination(destination) : destination
  const page = resolved?.[0]
  if (typeof page === 'number') return page + 1
  if (isPdfPageRef(page)) return (await document.getPageIndex(page)) + 1
  return undefined
}

const resolvePdfOutline = async (
  document: PdfDocument,
  nodes: readonly PdfOutlineNode[],
  parentPath = ''
): Promise<PdfOutlineItem[]> => {
  const items = await Promise.all(
    nodes.map(async (node, index): Promise<PdfOutlineItem | undefined> => {
      const id = parentPath ? `${parentPath}.${index}` : String(index)
      const title = node.title.replaceAll('\0', '').trim()
      const [pageNumber, children] = await Promise.all([
        node.dest
          ? resolvePdfOutlinePage(document, node.dest).catch(() => undefined)
          : Promise.resolve(undefined),
        resolvePdfOutline(document, node.items ?? [], id)
      ])
      if (!title || (pageNumber === undefined && children.length === 0)) return undefined
      return { id, title, pageNumber, children }
    })
  )
  return items.filter((item): item is PdfOutlineItem => item !== undefined)
}

const PdfInteractionControls = ({
  mode,
  canSelectArea,
  navigationAvailable,
  navigationOpen,
  searchOpen,
  onNavigationToggle,
  onSearchToggle,
  onModeChange
}: {
  mode: PdfCursorMode
  canSelectArea: boolean
  navigationAvailable: boolean
  navigationOpen: boolean
  searchOpen: boolean
  onNavigationToggle: () => void
  onSearchToggle: () => void
  onModeChange: (mode: PdfCursorMode) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const actions = [
    { mode: 'select' as const, label: t('Select'), icon: MousePointer2 },
    { mode: 'hand' as const, label: t('Hand'), icon: Hand },
    ...(canSelectArea ? [{ mode: 'area' as const, label: t('Area'), icon: Scan }] : [])
  ]

  return (
    <TooltipProvider delayDuration={800}>
      <div
        data-pdf-controls="interaction"
        role="group"
        aria-label={t('PDF interaction tools')}
        className="absolute top-3 left-3 z-40 flex items-center gap-1 rounded-md border border-border-300/50 bg-bg-000/90 p-0.5 shadow-sm backdrop-blur"
      >
        {navigationAvailable ? (
          <>
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant={navigationOpen ? 'secondary' : 'ghost'}
                  size="icon-sm"
                  className="text-text-100 hover:text-text-000 [@media(pointer:coarse)]:size-11"
                  aria-label={navigationOpen ? t('Hide navigation') : t('Show navigation')}
                  aria-controls="pdf-navigation-sidebar"
                  aria-expanded={navigationOpen}
                  title={t('Navigation')}
                  onClick={onNavigationToggle}
                >
                  <ListTree aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('Navigation')}</TooltipContent>
            </Tooltip>
            <span className="mx-0.5 h-4 w-px bg-border-300/60" aria-hidden="true" />
          </>
        ) : null}
        {actions.map(({ mode: actionMode, label, icon: Icon }) => (
          <Tooltip key={actionMode}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant={mode === actionMode ? 'secondary' : 'ghost'}
                size="icon-sm"
                className="text-text-100 hover:text-text-000 [@media(pointer:coarse)]:size-11"
                aria-label={label}
                aria-pressed={mode === actionMode}
                onClick={() => onModeChange(actionMode)}
              >
                <Icon aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ))}
        <span className="mx-0.5 h-4 w-px bg-border-300/60" aria-hidden="true" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={searchOpen ? 'secondary' : 'ghost'}
              size="icon-sm"
              aria-label={t('Search')}
              aria-pressed={searchOpen}
              onClick={onSearchToggle}
            >
              <Search aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('Search')}</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  )
}

const PdfSearchControls = ({
  query,
  current,
  total,
  onQueryChange,
  onFindAgain,
  onClose
}: {
  query: string
  current: number
  total: number
  onQueryChange: (query: string) => void
  onFindAgain: (previous: boolean) => void
  onClose: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <div className="absolute top-3 right-3 z-40 flex h-8 items-center gap-0.5 rounded-md border border-border-300/50 bg-bg-000/95 p-0.5 shadow-sm backdrop-blur">
      <Search className="ml-1 size-3.5 shrink-0 text-text-300" aria-hidden="true" />
      <input
        autoFocus
        type="search"
        value={query}
        aria-label={t('Search document')}
        placeholder={t('Search document')}
        className="h-7 w-44 bg-transparent px-1 text-xs text-text-000 outline-none placeholder:text-text-400"
        onChange={(event) => onQueryChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onFindAgain(event.shiftKey)
          if (event.key === 'Escape') onClose()
        }}
      />
      <span className="min-w-10 px-1 text-center text-[11px] tabular-nums text-text-300">
        {query ? `${current}/${total}` : ''}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t('Previous match')}
        disabled={total === 0}
        onClick={() => onFindAgain(true)}
      >
        <ChevronUp aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t('Next match')}
        disabled={total === 0}
        onClick={() => onFindAgain(false)}
      >
        <ChevronDown aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t('Close search')}
        onClick={onClose}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  )
}

// Bottom-right overlay is deliberately view-only: interaction modes live at the top-left.
const PdfZoomControls = ({
  zoom,
  currentPage,
  pageCount,
  onNavigate,
  onZoomIn,
  onZoomOut,
  onReset
}: {
  zoom: number
  currentPage: number
  pageCount: number
  onNavigate: (pageNumber: number) => void
  onZoomIn: () => void
  onZoomOut: () => void
  onReset: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [editingPage, setEditingPage] = useState(false)
  const [pageDraft, setPageDraft] = useState(String(currentPage))
  const pageLabel = t('Page {{current}} of {{total}}', { current: currentPage, total: pageCount })
  const actions = [
    { label: t('Zoom in'), icon: ZoomIn, onClick: onZoomIn, disabled: zoom >= MAX_ZOOM },
    { label: t('Zoom out'), icon: ZoomOut, onClick: onZoomOut, disabled: zoom <= MIN_ZOOM },
    { label: t('Reset zoom'), icon: Shrink, onClick: onReset, disabled: zoom === 1 }
  ]
  const finishPageEdit = (navigate: boolean): void => {
    const requestedPage = Number(pageDraft)
    if (navigate && pageDraft.trim() !== '' && Number.isFinite(requestedPage)) {
      onNavigate(Math.min(pageCount, Math.max(1, Math.trunc(requestedPage))))
    }
    setEditingPage(false)
  }

  return (
    <TooltipProvider delayDuration={800}>
      <div
        data-pdf-controls="view"
        role="group"
        aria-label={t('PDF view controls')}
        className="absolute right-3 bottom-3 z-10 flex items-center gap-1 rounded-md border border-border-300/50 bg-bg-000/90 p-0.5 shadow-sm backdrop-blur"
      >
        <div
          data-pdf-page-control
          className="inline-flex h-7 items-center gap-0.5 border-r border-border-300/60 pr-1 text-[11px] tabular-nums text-text-200"
        >
          {editingPage ? (
            <input
              autoFocus
              type="number"
              inputMode="numeric"
              min={1}
              max={pageCount}
              value={pageDraft}
              aria-label={pageLabel}
              className="h-6 w-10 rounded-sm bg-bg-100 px-1 text-center text-text-000 outline-none [appearance:textfield] focus:ring-1 focus:ring-ring/60 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setPageDraft(event.currentTarget.value)}
              onBlur={() => finishPageEdit(true)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') finishPageEdit(true)
                if (event.key === 'Escape') finishPageEdit(false)
              }}
            />
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="w-auto min-w-7 cursor-text px-1 text-[11px] text-text-200 hover:text-text-000"
              aria-label={pageLabel}
              title={pageLabel}
              onClick={() => {
                setPageDraft(String(currentPage))
                setEditingPage(true)
              }}
            >
              {currentPage}
            </Button>
          )}
          <span aria-hidden="true">/</span>
          <span className="min-w-4 px-0.5 text-center" aria-hidden="true">
            {pageCount}
          </span>
        </div>
        <span className="inline-flex h-7 min-w-[3ch] items-center justify-center px-1 text-center text-[11px] tabular-nums text-text-200">
          {Math.round(zoom * 100)}%
        </span>
        {actions.map(({ label, icon: Icon, onClick, disabled }) => (
          <Tooltip key={label}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-text-100 hover:text-text-000 [@media(pointer:coarse)]:size-11"
                aria-label={label}
                disabled={disabled}
                onClick={onClick}
              >
                <Icon aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  )
}
// Keep the backing store within browser canvas limits so a tall/narrow or heavily zoomed page
// cannot render blank: clamp each side and the total area (Chromium caps a dimension at 16384 and
// area near 2^28).
const MAX_CANVAS_DIMENSION = 8192
const MAX_CANVAS_AREA = 16 * 1024 * 1024
// Per-page backing-scale ceiling. Set above the ~4.5 that a full-width page needs at 175% zoom on
// a 2x display, so normal zoom stays crisp, while capping the deepest zoom so a few near-viewport
// pages cannot each allocate the full canvas-area budget and spike renderer memory.
const MAX_RENDER_SCALE = 5

// PDF.js rejects an in-flight render with this when cancel() is called; it is an expected teardown,
// not a page failure, so scroll-out, preview switches, and resize rerenders must not surface it.
const isRenderCancel = (error: unknown): boolean =>
  error instanceof Error && error.name === 'RenderingCancelledException'

const PdfEvidenceLayer = ({
  pageNumber,
  pageRotation,
  source,
  canvas,
  textLayer,
  active,
  activeAnnotations,
  selectedAnnotationId,
  onAddAnnotation,
  onRemoveAnnotation,
  onSelectAnnotation,
  onAnnotationError,
  onSelected
}: {
  pageNumber: number
  pageRotation: number
  source: PdfAnnotation['source']
  canvas: React.RefObject<HTMLCanvasElement | null>
  textLayer: React.RefObject<HTMLDivElement | null>
  active: boolean
  activeAnnotations: readonly Annotation[]
  selectedAnnotationId?: string
  onAddAnnotation?: PreviewFileRendererProps['onAddAnnotation']
  onRemoveAnnotation?: PreviewFileRendererProps['onRemoveAnnotation']
  onSelectAnnotation?: (id: string) => void
  onAnnotationError?: PreviewFileRendererProps['onAnnotationError']
  onSelected: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [start, setStart] = useState<Readonly<{ x: number; y: number }>>()
  const [end, setEnd] = useState<Readonly<{ x: number; y: number }>>()
  const [reveal, setReveal] = useState<Readonly<{ id: string; sequence: number }>>()
  const [preparedAnnotation, setPreparedAnnotation] = useState<PdfAnnotation>()
  const revealSequence = useRef(0)
  const highlightLayer = useRef<HTMLDivElement | null>(null)
  const matching = useMemo(() => {
    const annotations =
      preparedAnnotation &&
      !activeAnnotations.some((annotation) => annotation.id === preparedAnnotation.id)
        ? [...activeAnnotations, preparedAnnotation]
        : activeAnnotations
    return annotations.filter(
      (annotation): annotation is PdfAnnotation =>
        annotation.kind === 'pdf' &&
        annotation.source.projectId === source.projectId &&
        annotation.source.versionId === source.versionId &&
        annotation.source.checksum === source.checksum &&
        annotation.selector.pageNumber === pageNumber
    )
  }, [
    activeAnnotations,
    pageNumber,
    preparedAnnotation,
    source.checksum,
    source.projectId,
    source.versionId
  ])

  useEffect(
    () =>
      subscribeAnnotationRevealPreparation((annotation) => {
        if (
          annotation.kind !== 'pdf' ||
          annotation.source.projectId !== source.projectId ||
          annotation.source.versionId !== source.versionId ||
          annotation.source.checksum !== source.checksum ||
          annotation.selector.pageNumber !== pageNumber
        ) {
          return
        }
        setPreparedAnnotation(annotation)
      }),
    [pageNumber, source.checksum, source.projectId, source.versionId]
  )

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = subscribeAnnotationReveal((annotationId) => {
      if (!matching.some((annotation) => annotation.id === annotationId)) return false
      const sequence = ++revealSequence.current
      setReveal({ id: annotationId, sequence })
      clearTimeout(timer)
      timer = setTimeout(() => {
        setReveal((current) => (current?.sequence === sequence ? undefined : current))
        setPreparedAnnotation((current) => (current?.id === annotationId ? undefined : current))
      }, 1_600)
      return true
    })
    return () => {
      unsubscribe()
      clearTimeout(timer)
    }
  }, [matching])

  useEffect(() => {
    if (!reveal) return
    const target = Array.from(
      highlightLayer.current?.querySelectorAll<HTMLElement>('[data-pdf-evidence-highlight]') ?? []
    ).find((element) => element.dataset.pdfEvidenceHighlight === reveal.id)
    target?.scrollIntoView({
      block: 'center',
      inline: 'center',
      behavior: annotationRevealScrollBehavior()
    })
  }, [reveal])

  const draft = start && end ? normalizedPdfRect(start, end) : undefined
  const addRegion = (element: HTMLDivElement, rect: NonNullable<typeof draft>): void => {
    const page = element.getBoundingClientRect()
    setStart(undefined)
    setEnd(undefined)
    if (!canvas.current || !onAddAnnotation) return
    const image = cropPdfCanvasRegion(canvas.current, rect)
    if (!image) {
      onAnnotationError?.('payload-too-large')
      return
    }
    const text = textInPdfRect(textLayer.current, page, rect, ANNOTATION_LIMITS.quote)
    const error = onAddAnnotation({
      id: createAnnotationId(),
      kind: 'pdf',
      target: 'agent',
      source,
      selector: {
        kind: 'region',
        pageNumber,
        rect,
        pageRotation,
        ...(text ? { text } : {}),
        image
      }
    })
    if (error) {
      onAnnotationError?.(error)
      return
    }
    onSelected()
  }

  return (
    <>
      <div ref={highlightLayer} className="pointer-events-none absolute inset-0 z-20">
        {matching.flatMap((annotation) => {
          const boxes =
            annotation.selector.kind === 'text'
              ? annotation.selector.quads
              : [annotation.selector.rect]
          const isRevealed = reveal?.id === annotation.id
          const isDraft = activeAnnotations.some((candidate) => candidate.id === annotation.id)
          const isSelected = selectedAnnotationId === annotation.id
          return boxes.map((rect, index) => {
            const highlightProps = {
              key: `${annotation.id}-${index}-${isRevealed ? reveal.sequence : 0}`,
              'data-pdf-evidence-highlight': annotation.id,
              'data-pdf-evidence-revealed': isRevealed ? ('true' as const) : undefined,
              className: cn(
                'absolute rounded-[2px] bg-primary/20 ring-1 ring-inset ring-primary/35',
                isRevealed && 'pdf-evidence-reveal',
                isSelected && 'bg-primary/25 ring-2 ring-primary/70'
              ),
              style: {
                left: `${rect.x * 100}%`,
                top: `${rect.y * 100}%`,
                width: `${rect.width * 100}%`,
                height: `${rect.height * 100}%`
              }
            }
            return isDraft && onSelectAnnotation ? (
              <button
                {...highlightProps}
                type="button"
                className={cn(highlightProps.className, 'pointer-events-auto')}
                aria-label={t('Select evidence')}
                aria-pressed={isSelected}
                onClick={(event) => {
                  event.stopPropagation()
                  onSelectAnnotation(annotation.id)
                }}
              />
            ) : (
              <span {...highlightProps} />
            )
          })
        })}
        {matching.map((annotation) => {
          if (
            annotation.selector.kind !== 'region' ||
            !activeAnnotations.some((candidate) => candidate.id === annotation.id) ||
            !onRemoveAnnotation
          ) {
            return null
          }
          const rect = annotation.selector.rect
          return (
            <button
              key={`${annotation.id}-remove`}
              type="button"
              className="pointer-events-auto absolute z-10 flex size-[21px] items-center justify-center rounded-full border border-border-300/60 bg-bg-000/95 text-text-200 shadow-sm hover:bg-bg-100 hover:text-text-000 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              style={{
                left: `${(rect.x + rect.width) * 100}%`,
                top: `${rect.y * 100}%`,
                transform: 'translate(-50%, -50%)'
              }}
              aria-label={t('Remove PDF area')}
              title={t('Remove')}
              onClick={(event) => {
                event.stopPropagation()
                onRemoveAnnotation(annotation.id)
                onSelected()
              }}
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          )
        })}
        {draft ? (
          <span
            data-pdf-region-draft="true"
            className="absolute border-2 border-primary bg-primary/10"
            style={{
              left: `${draft.x * 100}%`,
              top: `${draft.y * 100}%`,
              width: `${draft.width * 100}%`,
              height: `${draft.height * 100}%`
            }}
          />
        ) : null}
      </div>
      {active ? (
        <div
          data-pdf-region-selection="true"
          className="absolute inset-0 z-30 cursor-crosshair touch-none"
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary) return
            event.currentTarget.setPointerCapture(event.pointerId)
            const point = pointInPage(
              event.clientX,
              event.clientY,
              event.currentTarget.getBoundingClientRect()
            )
            setStart(point)
            setEnd(point)
          }}
          onPointerMove={(event) => {
            if (!start || !event.currentTarget.hasPointerCapture(event.pointerId)) return
            setEnd(
              pointInPage(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect())
            )
          }}
          onPointerUp={(event) => {
            if (
              !start ||
              !event.isPrimary ||
              !event.currentTarget.hasPointerCapture(event.pointerId)
            )
              return
            const finished = normalizedPdfRect(
              start,
              pointInPage(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect())
            )
            event.currentTarget.releasePointerCapture(event.pointerId)
            if (finished) addRegion(event.currentTarget, finished)
            else {
              setStart(undefined)
              setEnd(undefined)
            }
          }}
        />
      ) : null}
    </>
  )
}

// Owns one lazy page canvas and releases its decoded bitmap outside the overscan window.
const PdfPageCanvas = ({
  document,
  pageNumber,
  pageWidth,
  registerDisposer,
  annotationProps,
  pdfEvidenceSource,
  pdfRevealSource,
  selectedEvidenceId,
  onSelectEvidence,
  onTextLayerRendered,
  regionSelectionActive,
  onRegionSelected
}: {
  document: PdfDocument
  pageNumber: number
  pageWidth: number
  registerDisposer: (dispose: () => void) => () => void
  annotationProps?: PreviewFileRendererProps
  pdfEvidenceSource?: PdfAnnotation['source']
  pdfRevealSource?: PdfAnnotation['source']
  selectedEvidenceId?: string
  onSelectEvidence: (id: string) => void
  onTextLayerRendered?: () => void
  regionSelectionActive: boolean
  onRegionSelected: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [setNearViewportRef, isNearViewport] = useNearViewport<HTMLDivElement>()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const textLayerHostRef = useRef<HTMLDivElement | null>(null)
  const textLayerRef = useRef<PdfTextLayerBuilder | undefined>(undefined)
  const pageRef = useRef<Awaited<ReturnType<PdfDocument['getPage']>> | undefined>(undefined)
  const renderTaskRef = useRef<
    ReturnType<Awaited<ReturnType<PdfDocument['getPage']>>['render']> | undefined
  >(undefined)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [aspectRatio, setAspectRatio] = useState(3 / 4)
  const [pageRotation, setPageRotation] = useState(0)
  // Bumped when a fresh page proxy is acquired so rasterization re-runs against the new page.
  const [pageEpoch, setPageEpoch] = useState(0)

  // Acquire the page once while it is near the viewport and keep it alive; width changes then
  // re-rasterize this same page rather than reloading it through the range transport.
  useEffect(() => {
    if (!isNearViewport) return

    let canceled = false
    let disposed = false
    // Clear canvas backing storage on exit; removing the DOM node alone may retain its bitmap.
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      canceled = true
      renderTaskRef.current?.cancel()
      renderTaskRef.current = undefined
      textLayerRef.current?.cancel()
      textLayerRef.current = undefined
      pageRef.current?.cleanup()
      pageRef.current = undefined
      const canvas = canvasRef.current
      if (canvas) {
        canvas.width = 0
        canvas.height = 0
      }
    }
    const unregisterDisposer = registerDisposer(dispose)

    void document
      .getPage(pageNumber)
      .then((acquiredPage) => {
        if (canceled) {
          acquiredPage.cleanup()
          return
        }
        pageRef.current = acquiredPage
        setPageRotation(acquiredPage.getViewport({ scale: 1 }).rotation)
        setPageEpoch((epoch) => epoch + 1)
      })
      .catch((error: unknown) => {
        if (!canceled) {
          console.error(`Failed to load PDF page ${pageNumber}`, error)
          setStatus('error')
        }
      })

    return () => {
      unregisterDisposer()
      dispose()
    }
  }, [document, isNearViewport, pageNumber, registerDisposer])

  // Rasterize the live page at the target width; re-runs on width change without reacquiring it.
  // Tied to isNearViewport so a scroll-out flips this effect's canceled flag and stops a rerender.
  useEffect(() => {
    const page = pageRef.current
    const canvas = canvasRef.current
    if (!isNearViewport || !page || !canvas) return

    let canceled = false
    const draw = async (): Promise<void> => {
      // Serialize against the previous render: PDF.js forbids two renders on one canvas, and its
      // cancel() settles asynchronously, so a resize-driven rerun must await the prior task first.
      const previous = renderTaskRef.current
      if (previous) {
        previous.cancel()
        await previous.promise.catch(() => undefined)
      }
      // The await above yields, during which the page can scroll out and dispose() can clear it;
      // bail before touching a disposed page or detached canvas.
      if (canceled || pageRef.current !== page) return

      const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1)
      const baseViewport = page.getViewport({ scale: 1 })
      // Rasterize at the physical pixels the page occupies on screen (never below intrinsic size)
      // so zoom stays crisp at any DPI, capped by MAX_RENDER_SCALE so the deepest zoom cannot
      // allocate the full canvas budget per page.
      const targetCssWidth = pageWidth > 0 ? pageWidth : baseViewport.width
      const desiredScale = Math.max(
        1,
        Math.min(MAX_RENDER_SCALE, (targetCssWidth * devicePixelRatio) / baseViewport.width)
      )
      // Hard cap so neither backing dimension nor total area exceeds browser canvas limits — must
      // win over the intrinsic floor, or a page taller than the limit at scale 1 renders blank.
      const limitScale = Math.min(
        MAX_CANVAS_DIMENSION / baseViewport.width,
        MAX_CANVAS_DIMENSION / baseViewport.height,
        Math.sqrt(MAX_CANVAS_AREA / (baseViewport.width * baseViewport.height))
      )
      const scale = Math.min(desiredScale, limitScale)
      const viewport = page.getViewport({ scale })
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas 2D context unavailable.')

      // Match the actual PDF page geometry so landscape and non-standard pages are not stretched.
      setAspectRatio(viewport.width / viewport.height)
      canvas.width = viewport.width
      canvas.height = viewport.height
      const renderTask = page.render({ canvas, canvasContext: context, viewport })
      renderTaskRef.current = renderTask
      await renderTask.promise
      if (renderTaskRef.current === renderTask) renderTaskRef.current = undefined
      if (!canceled) setStatus('ready')
    }

    void draw().catch((error: unknown) => {
      // A canceled render (scroll-out, preview switch, or superseding resize) is expected teardown.
      if (canceled || isRenderCancel(error)) return
      console.error(`Failed to render PDF page ${pageNumber}`, error)
      setStatus('error')
    })

    return () => {
      canceled = true
      renderTaskRef.current?.cancel()
    }
  }, [isNearViewport, pageEpoch, pageNumber, pageWidth])

  useEffect(() => {
    const page = pageRef.current
    const host = textLayerHostRef.current
    if (!isNearViewport || !page || !host) {
      return
    }

    let canceled = false
    const renderText = async (): Promise<void> => {
      const { TextLayerBuilder } = await import('pdfjs-dist/web/pdf_viewer.mjs')
      if (canceled || pageRef.current !== page) return
      textLayerRef.current?.cancel()
      textLayerRef.current = undefined
      host.replaceChildren()
      const baseViewport = page.getViewport({ scale: 1 })
      const targetWidth = pageWidth > 0 ? pageWidth : baseViewport.width
      const viewport = page.getViewport({ scale: targetWidth / baseViewport.width })
      const textLayer = new TextLayerBuilder({
        pdfPage: page,
        onAppend: (layer: HTMLDivElement) => {
          layer.style.setProperty('--total-scale-factor', String(viewport.scale))
          layer.style.setProperty('--scale-round-x', '1px')
          layer.style.setProperty('--scale-round-y', '1px')
          layer.classList.add('pdf-text-layer')
          layer.dataset.pdfTextLayer = 'true'
          host.replaceChildren(layer)
        }
      })
      textLayerRef.current = textLayer
      await textLayer.render({ viewport })
      if (textLayerRef.current === textLayer) textLayerRef.current = undefined
      if (canceled || pageRef.current !== page) return
      for (const span of textLayer.div.querySelectorAll('span')) {
        if (!span.textContent?.trim()) span.classList.add('pdf-text-layer-whitespace')
      }
      retryPendingAnnotationReveal()
      onTextLayerRendered?.()
    }

    void renderText().catch((error: unknown) => {
      if (!canceled && !isRenderCancel(error)) {
        console.error(`Failed to render PDF text layer for page ${pageNumber}`, error)
      }
    })
    return () => {
      canceled = true
      textLayerRef.current?.cancel()
      textLayerRef.current = undefined
      host.replaceChildren()
    }
  }, [isNearViewport, onTextLayerRendered, pageEpoch, pageNumber, pageWidth])

  const displayedStatus = isNearViewport ? status : 'idle'

  const pageContent = (
    <>
      {displayedStatus === 'loading' || (displayedStatus === 'idle' && isNearViewport) ? (
        <div className="absolute inset-0">
          <PreviewLoadingContent compact />
        </div>
      ) : null}
      {displayedStatus === 'error' ? (
        <div className="absolute inset-0 flex items-center justify-center text-[12px] text-text-300">
          {t('Page {{page}} could not be rendered', { page: pageNumber })}
        </div>
      ) : null}
      {isNearViewport ? (
        <>
          <canvas
            ref={canvasRef}
            width={0}
            height={0}
            className="pointer-events-none block size-full object-contain"
          />
          <div ref={textLayerHostRef} className="absolute inset-0" />
        </>
      ) : null}
    </>
  )

  return (
    <div
      ref={setNearViewportRef}
      className={cn(
        'relative bg-bg-000 shadow-sm',
        // Alignment is owned by the parent column; fall back to a responsive width until it has
        // measured the fit width.
        pageWidth > 0 ? 'max-w-none' : 'w-full max-w-3xl'
      )}
      style={pageWidth > 0 ? { aspectRatio, width: pageWidth } : { aspectRatio }}
      data-page-number={pageNumber}
    >
      {annotationProps && isNearViewport ? (
        <PreviewTextAnnotationSurface
          {...annotationProps}
          sourcePageNumber={pageNumber}
          pdfEvidenceSource={pdfEvidenceSource}
          pdfExtractorVersion={`pdfjs-${pdfjsLib.version}`}
          onAnnotationAdded={onRegionSelected}
        >
          {pageContent}
        </PreviewTextAnnotationSurface>
      ) : (
        pageContent
      )}
      {isNearViewport && (pdfEvidenceSource || pdfRevealSource) ? (
        <PdfEvidenceLayer
          key={regionSelectionActive ? 'selecting' : 'viewing'}
          pageNumber={pageNumber}
          pageRotation={pageRotation}
          source={pdfEvidenceSource ?? pdfRevealSource!}
          canvas={canvasRef}
          textLayer={textLayerHostRef}
          active={regionSelectionActive && Boolean(pdfEvidenceSource)}
          activeAnnotations={annotationProps?.activeAnnotations ?? []}
          selectedAnnotationId={selectedEvidenceId}
          onAddAnnotation={pdfEvidenceSource ? annotationProps?.onAddAnnotation : undefined}
          onRemoveAnnotation={annotationProps?.onRemoveAnnotation}
          onSelectAnnotation={onSelectEvidence}
          onAnnotationError={annotationProps?.onAnnotationError}
          onSelected={onRegionSelected}
        />
      ) : null}
    </div>
  )
}

export const PdfPreviewContent = ({
  path,
  name,
  source = 'artifact',
  projectId,
  sessionId,
  mimeType,
  size,
  mtimeMs,
  onReadingPositionChange,
  annotationProps,
  pdfEvidenceSource,
  pdfRevealSource
}: {
  path: string
  name: string
  source?: PreviewFileSource
  projectId?: string
  sessionId?: string
  mimeType?: string
  size?: number
  mtimeMs?: number
  onReadingPositionChange?: PreviewFileRendererProps['onPdfReadingPositionChange']
  annotationProps?: PreviewFileRendererProps
  pdfEvidenceSource?: PdfAnnotation['source']
  pdfRevealSource?: PdfAnnotation['source']
}): React.JSX.Element => {
  const { t } = useTranslation()
  const requestKey = createPreviewResourceKey({
    projectId,
    sessionId,
    source,
    path,
    mimeType,
    size,
    mtimeMs
  })
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const panGestureRef = useRef<PdfPanGesture | undefined>(undefined)
  const viewportAnchorRef = useRef<PdfViewportAnchor | undefined>(undefined)
  const [documentState, setDocumentState] = useState<DocumentState | null>(null)
  const [zoom, setZoom] = useState(1)
  const [cursorMode, setCursorMode] = useState<PdfCursorMode>('select')
  const [panning, setPanning] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [outlineWidth, setOutlineWidth] = useState(OUTLINE_DEFAULT_WIDTH)
  const [currentPage, setCurrentPage] = useState(1)
  const currentPageRef = useRef(1)
  const [pageLabels, setPageLabels] = useState<
    Readonly<{ requestKey: string; labels: readonly string[] | null }> | undefined
  >()
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string>()
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<readonly PdfSearchPageMatches[]>([])
  const [searchResultCount, setSearchResultCount] = useState(0)
  const [selectedSearchIndex, setSelectedSearchIndex] = useState(0)
  const [textLayerEpoch, setTextLayerEpoch] = useState(0)
  const searchTextCacheRef = useRef(new Map<number, Promise<string>>())
  const [outlineState, setOutlineState] = useState<
    Readonly<{ requestKey: string; items: readonly PdfOutlineItem[] }> | undefined
  >()
  // The PreviewPanel path remounts on a file switch, but the Files-tab dialog updates item in place
  // with no contentKey, so reset view and interaction state whenever the previewed file changes.
  const [zoomedKey, setZoomedKey] = useState(requestKey)
  if (zoomedKey !== requestKey) {
    setZoomedKey(requestKey)
    setZoom(1)
    setCursorMode('select')
    setPanning(false)
    setOutlineOpen(false)
    setOutlineWidth(OUTLINE_DEFAULT_WIDTH)
    setCurrentPage(1)
    setSelectedEvidenceId(undefined)
    setSearchOpen(false)
    setSearchQuery('')
    setSearchResults([])
    setSearchResultCount(0)
    setSelectedSearchIndex(0)
  }
  useLayoutEffect(() => {
    viewportAnchorRef.current = undefined
    currentPageRef.current = 1
    searchTextCacheRef.current.clear()
  }, [requestKey])
  // The width one page fills at 100%: the content box, capped to a comfortable reading width. Owned
  // here so one ResizeObserver serves the whole document instead of one per page.
  const [fitWidth, setFitWidth] = useState(0)
  // The real (uncapped) content-box width, used only to decide when a zoomed page actually
  // overflows the viewport — distinct from the capped fitWidth that sizes a 100% page.
  const [viewportWidth, setViewportWidth] = useState(0)
  const measureRef = useRef<HTMLDivElement | null>(null)
  const pageDisposersRef = useRef(new Set<() => void>())
  const registerPageDisposer = useCallback((dispose: () => void): (() => void) => {
    pageDisposersRef.current.add(dispose)
    return () => pageDisposersRef.current.delete(dispose)
  }, [])
  const handleTextLayerRendered = useCallback(() => {
    setTextLayerEpoch((epoch) => epoch + 1)
  }, [])
  const canSelectArea = Boolean(annotationProps?.onAddAnnotation && pdfEvidenceSource)
  if (!canSelectArea && cursorMode === 'area') setCursorMode('select')

  const captureViewportAnchor = useCallback((): void => {
    const scroll = scrollRef.current
    if (!scroll) return
    const viewport = scroll.getBoundingClientRect()
    const page = pageAtViewportTop(scroll, viewport)
    const bounds = page?.getBoundingClientRect()
    if (!page || !bounds || bounds.width <= 0 || bounds.height <= 0) return
    const anchorLeft = Math.max(viewport.left, bounds.left)
    const anchorTop = Math.max(viewport.top, bounds.top)
    viewportAnchorRef.current = {
      pageNumber: Number(page.dataset.pageNumber) || 1,
      x: (anchorLeft - bounds.left) / bounds.width,
      y: (anchorTop - bounds.top) / bounds.height,
      viewportX: anchorLeft - viewport.left,
      viewportY: anchorTop - viewport.top
    }
  }, [])

  const updateZoom = useCallback(
    (resolve: (current: number) => number): void => {
      captureViewportAnchor()
      setZoom((current) => {
        const next = resolve(current)
        if (next === current) viewportAnchorRef.current = undefined
        return next
      })
    },
    [captureViewportAnchor]
  )

  // Ctrl/Cmd+wheel zooms the document instead of scrolling, matching the image preview gesture.
  // A trackpad/pinch emits many small wheel events per gesture, so accumulate deltaY and apply it
  // proportionally once per frame — one gesture yields a controlled zoom and few rerasterizations.
  // Keyed to requestKey and run as a layout effect so a file switch cancels any queued frame during
  // commit — before the browser's rAF phase — so a stale flush cannot re-apply zoom on top of the
  // new document's reset (a passive-effect cleanup would run after paint, too late to cancel it).
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return

    let pendingDelta = 0
    let frame: number | undefined
    const flush = (): void => {
      frame = undefined
      const delta = pendingDelta
      pendingDelta = 0
      if (delta !== 0) {
        updateZoom((current) => clampZoom(current - delta * ZOOM_WHEEL_SENSITIVITY))
      }
    }
    const handleWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      pendingDelta += event.deltaY
      frame ??= requestAnimationFrame(flush)
    }

    element.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      element.removeEventListener('wheel', handleWheel)
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [requestKey, updateZoom])

  // Measure the content-box width before paint (zero-height probe, unaffected by page overflow) so
  // pages rasterize once at the right width on open. Tracks the current width so pages stay
  // responsive: narrowing the panel (or returning from full screen) shrinks them back to fit.
  useLayoutEffect(() => {
    const element = measureRef.current
    if (!element) return
    let measuredFitWidth = 0

    const measure = (): void => {
      const raw = element.clientWidth
      if (raw <= 0) return
      const width = Math.min(raw, FIT_PAGE_WIDTH)
      if (measuredFitWidth > 0 && width !== measuredFitWidth && !viewportAnchorRef.current) {
        captureViewportAnchor()
      }
      measuredFitWidth = width
      setFitWidth((current) => (width === current ? current : width))
      setViewportWidth((current) => (raw === current ? current : raw))
    }
    measure()

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [captureViewportAnchor])

  useEffect(() => {
    let canceled = false
    let document: PdfDocument | undefined
    let loadingTask: ReturnType<typeof createManagedPdfLoadingTask> | undefined
    let resourceId: string | undefined
    let disposePromise: Promise<void> | undefined
    const dispose = (): Promise<void> => {
      disposePromise ??= (async () => {
        // Cancel page renders before destroying their shared PDF.js document and resource.
        for (const disposePage of pageDisposersRef.current) disposePage()
        pageDisposersRef.current.clear()

        try {
          if (document) await document.destroy()
          else if (loadingTask) await loadingTask.destroy()
        } catch (error) {
          console.error('Failed to destroy PDF preview', error)
        }

        if (resourceId) {
          try {
            await window.api.previewResources.release({ resourceId })
          } catch (error) {
            console.error('Failed to release PDF preview resource', error)
          }
        }
      })()
      return disposePromise
    }

    void (async () => {
      try {
        const resource = await window.api.previewResources.acquire({
          source,
          path,
          ...createPreviewRequestScope({ projectId, sessionId, source, path }),
          ...(mimeType ? { mimeType } : {})
        })
        resourceId = resource.id
        if (canceled) {
          await dispose()
          return
        }

        loadingTask = createManagedPdfLoadingTask(resource)
        document = await loadingTask.promise
        if (canceled) {
          await dispose()
          return
        }

        setDocumentState({ requestKey, status: 'ready', document })
      } catch (error: unknown) {
        if (!isUnavailableFileError(error)) console.error('Failed to load PDF preview', error)
        if (!canceled) setDocumentState({ requestKey, status: 'error', error })
        await dispose()
      }
    })()

    return () => {
      canceled = true
      if (resourceId) void dispose()
    }
  }, [mimeType, path, projectId, requestKey, sessionId, source])

  const currentDocumentState = documentState?.requestKey === requestKey ? documentState : null
  const hasError = currentDocumentState?.status === 'error'
  const document = currentDocumentState?.status === 'ready' ? currentDocumentState.document : null
  const pageCount = document?.numPages ?? 0
  const pageWidth = fitWidth > 0 ? Math.round(fitWidth * zoom) : 0
  const outlineItems = outlineState?.requestKey === requestKey ? outlineState.items : []
  const resolvedPageLabels = pageLabels?.requestKey === requestKey ? pageLabels.labels : null
  const scrollToPage = useCallback((pageNumber: number): void => {
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-page-number="${pageNumber}"]`)
      ?.scrollIntoView({ block: 'start', behavior: 'auto' })
    currentPageRef.current = pageNumber
    setCurrentPage(pageNumber)
  }, [])
  const navigateToPage = scrollToPage
  useEffect(
    () =>
      subscribePdfReadingReveal((target) => {
        if (target.projectId !== projectId || target.path !== path || !document) return false
        scrollToPage(Math.min(document.numPages, Math.max(1, target.pageNumber)))
        return true
      }),
    [document, path, projectId, scrollToPage]
  )
  useEffect(() => {
    if (!document || !searchQuery.trim()) {
      updatePdfSearchHighlights(scrollRef.current, '', undefined)
      return
    }
    let canceled = false
    const timer = setTimeout(() => {
      void (async () => {
        const normalizedQuery = searchQuery.toLocaleLowerCase()
        const matches: PdfSearchPageMatches[] = []
        let matchCount = 0
        let publishedMatchCount = 0
        let revealedFirstMatch = false
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
          if (canceled) return
          let textPromise = searchTextCacheRef.current.get(pageNumber)
          if (!textPromise) {
            textPromise = document.getPage(pageNumber).then(async (page) => {
              try {
                const content = await page.getTextContent()
                return joinPdfTextItems(content.items.map((item) => ('str' in item ? item : {})))
              } finally {
                page.cleanup()
              }
            })
            searchTextCacheRef.current.set(pageNumber, textPromise)
            while (searchTextCacheRef.current.size > MAX_SEARCH_TEXT_CACHE_PAGES) {
              const oldestPage = searchTextCacheRef.current.keys().next().value
              if (oldestPage === undefined) break
              searchTextCacheRef.current.delete(oldestPage)
            }
          } else {
            searchTextCacheRef.current.delete(pageNumber)
            searchTextCacheRef.current.set(pageNumber, textPromise)
          }
          let text: string
          try {
            text = (await textPromise).toLocaleLowerCase()
          } catch {
            searchTextCacheRef.current.delete(pageNumber)
            continue
          }
          if (canceled) return
          const pageMatchCount = countPdfSearchOccurrences(text, normalizedQuery)
          if (pageMatchCount > 0) {
            matches.push({ pageNumber, count: pageMatchCount })
            matchCount += pageMatchCount
          }
          if (matchCount > publishedMatchCount && (!revealedFirstMatch || pageNumber % 16 === 0)) {
            setSearchResults([...matches])
            setSearchResultCount(matchCount)
            publishedMatchCount = matchCount
            if (!revealedFirstMatch && matches[0]) {
              revealedFirstMatch = true
              setSelectedSearchIndex(0)
              scrollToPage(matches[0].pageNumber)
            }
          }
        }
        if (canceled) return
        setSearchResults(matches)
        setSearchResultCount(matchCount)
        if (!revealedFirstMatch && matches[0]) {
          setSelectedSearchIndex(0)
          scrollToPage(matches[0].pageNumber)
        }
      })()
    }, 180)
    return () => {
      canceled = true
      clearTimeout(timer)
    }
  }, [document, searchQuery, scrollToPage])

  useEffect(() => {
    updatePdfSearchHighlights(
      scrollRef.current,
      searchQuery,
      resolvePdfSearchMatch(searchResults, selectedSearchIndex)
    )
  }, [searchQuery, searchResults, selectedSearchIndex, textLayerEpoch])

  useLayoutEffect(() => {
    const anchor = viewportAnchorRef.current
    const scroll = scrollRef.current
    if (!anchor || !scroll) return
    viewportAnchorRef.current = undefined
    const page = scroll.querySelector<HTMLElement>(`[data-page-number="${anchor.pageNumber}"]`)
    if (!page) return
    const viewport = scroll.getBoundingClientRect()
    const bounds = page.getBoundingClientRect()
    scroll.scrollLeft += bounds.left + anchor.x * bounds.width - viewport.left - anchor.viewportX
    scroll.scrollTop += bounds.top + anchor.y * bounds.height - viewport.top - anchor.viewportY
  }, [fitWidth, zoom])

  useEffect(() => {
    if (!document) return
    if (typeof document.getOutline !== 'function') return
    let canceled = false
    void document
      .getOutline()
      .then((outline) => resolvePdfOutline(document, outline ?? []))
      .then((items) => {
        if (!canceled) setOutlineState({ requestKey, items })
      })
      .catch(() => {
        if (!canceled) setOutlineState({ requestKey, items: [] })
      })
    return () => {
      canceled = true
    }
  }, [document, requestKey])

  useEffect(() => {
    if (!document || typeof document.getPageLabels !== 'function') return
    let canceled = false
    void document
      .getPageLabels()
      .then((labels) => {
        if (!canceled) setPageLabels({ requestKey, labels })
      })
      .catch(() => {
        if (!canceled) setPageLabels({ requestKey, labels: null })
      })
    return () => {
      canceled = true
    }
  }, [document, requestKey])

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || pageCount === 0) return

    let updateTimer: ReturnType<typeof setTimeout> | undefined
    let lastReportedPage: number | undefined
    const nearestPage = (): number => {
      const viewport = scroll.getBoundingClientRect()
      return (
        Number(pageAtViewportMidpoint(scroll, viewport)?.dataset.pageNumber) ||
        currentPageRef.current
      )
    }
    const updateReadingPosition = (): void => {
      updateTimer = undefined
      const pageNumber = nearestPage()
      currentPageRef.current = pageNumber
      setCurrentPage((current) => (current === pageNumber ? current : pageNumber))
      if (lastReportedPage === pageNumber) return
      lastReportedPage = pageNumber
      onReadingPositionChange?.({ pageNumber, pageCount })
    }
    const schedule = (): void => {
      updateTimer ??= setTimeout(updateReadingPosition, READING_POSITION_UPDATE_MS)
    }

    scroll.addEventListener('scroll', schedule, { passive: true })
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    resizeObserver?.observe(scroll)
    schedule()
    return () => {
      scroll.removeEventListener('scroll', schedule)
      resizeObserver?.disconnect()
      if (updateTimer !== undefined) clearTimeout(updateTimer)
    }
  }, [onReadingPositionChange, outlineItems.length, pageCount, pageWidth])

  useEffect(() => {
    const item = annotationProps?.item
    const scroll = scrollRef.current
    if (!item || !scroll) return
    return subscribeAnnotationRevealPreparation((annotation) => {
      if (
        annotation.kind !== 'pdf' ||
        annotation.source.projectId !== item.projectId ||
        annotation.source.path !== item.path
      ) {
        return
      }
      scroll
        .querySelector<HTMLElement>(`[data-page-number="${annotation.selector.pageNumber}"]`)
        ?.scrollIntoView({
          block: 'center',
          behavior: annotationRevealScrollBehavior()
        })
    })
  }, [annotationProps?.item])

  if (hasError) {
    return (
      <PreviewErrorCard
        name={name}
        error={currentDocumentState.error}
        fallbackMessage={t("This PDF couldn't be rendered for preview")}
      />
    )
  }

  const zoomBy = (delta: number): void => updateZoom((current) => clampZoom(current + delta))
  const changeCursorMode = (mode: PdfCursorMode): void => {
    panGestureRef.current = undefined
    setPanning(false)
    setCursorMode(mode)
  }
  const findAgain = (previous: boolean): void => {
    if (searchResultCount === 0) return
    const nextIndex = previous
      ? (selectedSearchIndex - 1 + searchResultCount) % searchResultCount
      : (selectedSearchIndex + 1) % searchResultCount
    const nextMatch = resolvePdfSearchMatch(searchResults, nextIndex)
    if (!nextMatch) return
    setSelectedSearchIndex(nextIndex)
    scrollToPage(nextMatch.pageNumber)
  }
  const closeSearch = (): void => {
    setSearchOpen(false)
    setSearchQuery('')
    setSearchResults([])
    setSearchResultCount(0)
    setSelectedSearchIndex(0)
    searchTextCacheRef.current.clear()
    updatePdfSearchHighlights(scrollRef.current, '', undefined)
    scrollRef.current?.focus()
  }
  const focusPdfView = (): void => {
    scrollRef.current?.focus({ preventScroll: true })
    requestAnimationFrame(() => scrollRef.current?.focus({ preventScroll: true }))
  }
  const effectiveSelectedEvidenceId = annotationProps?.activeAnnotations?.some(
    (annotation) => annotation.id === selectedEvidenceId
  )
    ? selectedEvidenceId
    : undefined

  return (
    <div
      className="flex size-full overflow-hidden bg-bg-20"
      data-pdf-preview-root
      onKeyDownCapture={(event) => {
        const primaryModifier = event.metaKey || event.ctrlKey
        if (primaryModifier && event.key.toLowerCase() === 'f') {
          event.preventDefault()
          event.stopPropagation()
          setSearchOpen(true)
          return
        }
        if (
          !primaryModifier &&
          !event.altKey &&
          (event.key === 'Delete' || event.key === 'Backspace') &&
          effectiveSelectedEvidenceId &&
          !isEditableTarget(event.target)
        ) {
          annotationProps?.onRemoveAnnotation?.(effectiveSelectedEvidenceId)
          setSelectedEvidenceId(undefined)
          event.preventDefault()
          event.stopPropagation()
          return
        }
        const key = event.key.toLowerCase()
        const isUndo = primaryModifier && key === 'z' && !event.shiftKey
        const isRedo = primaryModifier && ((key === 'z' && event.shiftKey) || key === 'y')
        if ((!isUndo && !isRedo) || event.altKey || isEditableTarget(event.target)) {
          return
        }
        const handled = isRedo
          ? annotationProps?.onRedoAnnotation?.()
          : annotationProps?.onUndoAnnotation?.()
        if (handled) {
          event.preventDefault()
          event.stopPropagation()
        }
      }}
    >
      {document && outlineOpen && pageCount > 1 ? (
        <PdfOutlineSidebar
          key={requestKey}
          document={document}
          items={outlineItems}
          pageCount={pageCount}
          pageLabels={resolvedPageLabels}
          currentPage={currentPage}
          width={outlineWidth}
          onWidthChange={setOutlineWidth}
          onClose={() => setOutlineOpen(false)}
          onNavigate={navigateToPage}
        />
      ) : null}
      <div className="relative min-w-0 flex-1 overflow-hidden">
        {/* The inner element is the real scroller (the outer div holds fixed controls), so it must
            be keyboard-focusable or PageUp/Down, Space, and arrows never reach the PDF. */}
        <div
          ref={scrollRef}
          data-pdf-cursor-mode={cursorMode}
          className={cn(
            'size-full overflow-auto p-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50',
            cursorMode === 'hand' &&
              `touch-none select-none [&_*]:cursor-inherit [&_*]:select-none ${panning ? 'cursor-grabbing' : 'cursor-grab'}`
          )}
          tabIndex={0}
          role="region"
          aria-label={t('{{name}} scrollable preview', { name })}
          onPointerDown={(event) => {
            if (cursorMode !== 'hand' || event.button !== 0 || !event.isPrimary) return
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            panGestureRef.current = {
              pointerId: event.pointerId,
              clientX: event.clientX,
              clientY: event.clientY,
              scrollLeft: event.currentTarget.scrollLeft,
              scrollTop: event.currentTarget.scrollTop
            }
            setPanning(true)
          }}
          onPointerMove={(event) => {
            const gesture = panGestureRef.current
            if (cursorMode !== 'hand' || gesture?.pointerId !== event.pointerId) return
            event.currentTarget.scrollLeft = gesture.scrollLeft - (event.clientX - gesture.clientX)
            event.currentTarget.scrollTop = gesture.scrollTop - (event.clientY - gesture.clientY)
          }}
          onPointerUp={(event) => {
            if (panGestureRef.current?.pointerId !== event.pointerId) return
            panGestureRef.current = undefined
            setPanning(false)
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
          }}
          onPointerCancel={() => {
            panGestureRef.current = undefined
            setPanning(false)
          }}
          onLostPointerCapture={() => {
            panGestureRef.current = undefined
            setPanning(false)
          }}
        >
          {/* Zero-height probe: reports the content-box width even when pages overflow horizontally. */}
          <div ref={measureRef} className="h-0 w-full" aria-hidden="true" />
          {!document ? (
            <div className="absolute inset-0">
              <PreviewLoadingContent />
            </div>
          ) : null}
          {document ? (
            // Center pages while they fit the real viewport, but left-align once a zoomed page
            // overflows it: a centered overflow puts the left margin before scrollLeft=0, making it
            // unreachable. Compared against the uncapped viewport width, not the reading-width cap,
            // so a page still fitting a wide/full-screen pane stays centered.
            <div
              className={cn(
                'flex min-w-full flex-col gap-3',
                viewportWidth > 0 && pageWidth > viewportWidth ? 'items-start' : 'items-center'
              )}
            >
              {Array.from({ length: pageCount }, (_, index) => (
                // Each page mounts its canvas only inside the viewport overscan window.
                <PdfPageCanvas
                  key={index + 1}
                  document={document}
                  pageNumber={index + 1}
                  pageWidth={pageWidth}
                  registerDisposer={registerPageDisposer}
                  annotationProps={annotationProps}
                  pdfEvidenceSource={pdfEvidenceSource}
                  pdfRevealSource={pdfRevealSource}
                  selectedEvidenceId={effectiveSelectedEvidenceId}
                  onSelectEvidence={(id) => {
                    setSelectedEvidenceId(id)
                    focusPdfView()
                  }}
                  onTextLayerRendered={handleTextLayerRendered}
                  regionSelectionActive={cursorMode === 'area'}
                  onRegionSelected={() => {
                    changeCursorMode('select')
                    focusPdfView()
                  }}
                />
              ))}
            </div>
          ) : null}
        </div>
        {document ? (
          <>
            <PdfInteractionControls
              mode={cursorMode}
              canSelectArea={canSelectArea}
              navigationAvailable={pageCount > 1}
              navigationOpen={outlineOpen}
              searchOpen={searchOpen}
              onNavigationToggle={() => setOutlineOpen((open) => !open)}
              onSearchToggle={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
              onModeChange={changeCursorMode}
            />
            {searchOpen ? (
              <PdfSearchControls
                query={searchQuery}
                current={searchResultCount > 0 ? selectedSearchIndex + 1 : 0}
                total={searchResultCount}
                onQueryChange={(query) => {
                  setSearchQuery(query)
                  setSearchResults([])
                  setSearchResultCount(0)
                  setSelectedSearchIndex(0)
                }}
                onFindAgain={findAgain}
                onClose={closeSearch}
              />
            ) : null}
            <PdfZoomControls
              zoom={zoom}
              currentPage={currentPage}
              pageCount={pageCount}
              onNavigate={navigateToPage}
              onZoomIn={() => zoomBy(ZOOM_BUTTON_STEP)}
              onZoomOut={() => zoomBy(-ZOOM_BUTTON_STEP)}
              onReset={() => updateZoom(() => 1)}
            />
          </>
        ) : null}
      </div>
    </div>
  )
}

export const PdfPreviewRenderer = (props: PreviewFileRendererProps): React.JSX.Element => {
  const target = resolvePdfContextTarget(props.item)
  const binding = useSessionStore((state) => {
    const session = state.sessions.find(
      (candidate) =>
        candidate.id === state.selectedSessionId && candidate.projectId === props.item.projectId
    )
    return target
      ? session?.runtimeContext?.pdfContext?.bindings.find(
          (candidate) =>
            candidate.sourceKind === target.sourceKind &&
            candidate.sourceVersionId === target.sourceVersionId
        )
      : undefined
  })
  const candidateSource: PdfAnnotation['source'] | undefined =
    binding && props.item.projectId
      ? {
          kind: binding.sourceKind,
          projectId: props.item.projectId,
          sessionId: binding.sourceSessionId,
          versionId: binding.sourceVersionId,
          name: binding.name,
          path: props.item.path,
          checksum: binding.checksum
        }
      : undefined
  const pdfEvidenceSource =
    candidateSource && pdfAnnotationSourceIsFixed(candidateSource) ? candidateSource : undefined
  const [preparedReveal, setPreparedReveal] =
    useState<Readonly<{ path: string; source: PdfAnnotation['source'] }>>()
  const pdfRevealSource =
    preparedReveal?.path === props.item.path ? preparedReveal.source : undefined

  useEffect(() => {
    return subscribeAnnotationRevealPreparation((annotation) => {
      if (
        annotation.kind !== 'pdf' ||
        annotation.source.projectId !== props.item.projectId ||
        annotation.source.path !== props.item.path ||
        !pdfAnnotationSourceIsFixed(annotation.source)
      ) {
        return
      }
      setPreparedReveal({ path: props.item.path, source: annotation.source })
    })
  }, [props.item.path, props.item.projectId])

  return (
    <PdfPreviewContent
      path={props.item.path}
      name={props.item.name}
      source={props.item.source}
      projectId={props.item.projectId}
      sessionId={props.item.sessionId}
      mimeType={props.item.mimeType}
      size={props.item.size}
      mtimeMs={props.item.mtimeMs}
      onReadingPositionChange={props.onPdfReadingPositionChange}
      annotationProps={props}
      pdfEvidenceSource={pdfEvidenceSource}
      pdfRevealSource={pdfRevealSource}
    />
  )
}
