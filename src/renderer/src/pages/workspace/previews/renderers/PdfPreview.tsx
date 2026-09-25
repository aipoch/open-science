import { useNativePdfVisibility } from '../../pdf-annotations/use-native-pdf-visibility'
import { PdfSearchTextCache } from './pdf-search-text-cache'
import { usePdfExport } from '../../pdf-annotations/use-pdf-export'
import { PdfAnnotationsProvider } from '../../pdf-annotations/PdfAnnotationsProvider'
import type {
  PdfAnnotationSource,
  PdfNativeAnnotationImportProgress
} from '../../../../../../shared/pdf-annotations'
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
import {
  FileText,
  Images,
  NotebookPen,
  ChevronDown,
  ChevronUp,
  Hand,
  LoaderCircle,
  MousePointer2,
  PanelLeft,
  PanelRight,
  Highlighter,
  Underline,
  Waves,
  Strikethrough,
  Scan,
  SquareDashedMousePointer,
  Search,
  Shrink,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { Tabs } from 'radix-ui'
import type { TextLayerBuilder as PdfTextLayerBuilder } from 'pdfjs-dist/web/pdf_viewer.mjs'
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'

import { TagSelection } from '../../../settings/ResourceTagControls'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  pendingPdfContextSelections,
  usePreviewWorkbenchStore,
  type PreviewFileSource
} from '@/stores/preview-workbench-store'
import { createPreviewFileItemForManagedVersion } from '../../preview-file-item'
import { useSessionStore } from '@/stores/session-store'
import {
  ANNOTATION_LIMITS,
  pdfAnnotationSourceIsFixed,
  type Annotation,
  type PdfAnnotation
} from '../../../../../../shared/annotations'
import { parseLiteratureAttachmentVersionReference } from '../../../../../../shared/literature'
import { joinPdfTextItems } from '../../../../../../shared/pdf-text'

import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import {
  annotationRevealScrollBehavior,
  retryPendingAnnotationReveal,
  subscribeAnnotationReveal,
  subscribeAnnotationRevealPreparation,
  subscribeBookmarkReveal,
  subscribeBookmarkRevealPreparation,
  type BookmarkRevealTarget
} from '../../annotations/annotation-reveal'
import {
  PdfTextMarkControls,
  PdfMarkColorControls,
  type PdfTextMarkStyle
} from '../../annotations/TextAnnotationEditors'
import { createAnnotationId } from '../../annotations/annotation-id'
import { createManagedPdfLoadingTask } from '../managed-pdf-document'
import { pdfjsLib } from '../pdfjs'
import { isUnavailableFileError } from '../preview-errors'
import { createPreviewResourceKey } from '../preview-resource-key'
import { usePreviewResourceGeneration } from '../usePreviewResourceGeneration'
import {
  WEB_EVENT_CONNECTION_STATE_EVENT,
  type WebEventConnectionState
} from '../../../../../../shared/web-event-connection'
import { createManagedPreviewRequest } from '../preview-file-reader'
import type { PreviewFileRendererProps } from '../preview-types'
import {
  pdfBookmarkSelectorMatchesPage,
  type PdfMarkColor,
  type PdfBookmarkSelector,
  type PdfMarkKind
} from '../../../../../../shared/pdf-bookmarks'
import { PdfAnnotationHistoryControls } from '../../pdf-annotations/PdfAnnotationHistoryControls'
import { handlePdfAnnotationHistoryKey } from '../../pdf-annotations/pdf-annotation-history-keyboard'
import { PdfAnnotationMarker } from '../../pdf-annotations/PdfAnnotationMarker'
import { usePdfAnnotations } from '../../pdf-annotations/pdf-annotations-context'
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
import { PdfFiguresView } from './PdfFiguresView'
import { PdfNotebookView } from './PdfNotebookView'
import {
  countPdfSearchOccurrences,
  resolvePdfSearchMatch,
  type PdfSearchMatch,
  type PdfSearchPageMatches
} from './pdf-search-matches'

type PdfDocument = Awaited<ReturnType<typeof createManagedPdfLoadingTask>['promise']>
type PdfOutlineNode = Awaited<ReturnType<PdfDocument['getOutline']>>[number]
type DocumentState =
  | { requestKey: string; status: 'ready'; document: PdfDocument; size: number }
  | { requestKey: string; status: 'error'; error: unknown }
type PdfCursorMode = 'select' | 'hand' | 'area' | 'area-annotation' | 'text-annotation'
type PdfRegionIntent = 'agent' | 'annotation'
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
const OUTLINE_DEFAULT_WIDTH = 240
const NOTES_SIDEBAR_MIN_READER_WIDTH = 1120
const NOTES_SIDEBAR_MIN_WIDTH = 300
const NOTES_SIDEBAR_MAX_WIDTH = 420
// Wheel zoom is proportional to accumulated deltaY so one trackpad/pinch gesture (many small
// events) maps to a controlled amount rather than a full step per event. ~100px notch ≈ 0.25.
const ZOOM_WHEEL_SENSITIVITY = 0.0025

const pdfMarkColorValue = (color: PdfMarkColor): string =>
  ({
    yellow: 'var(--color-amber-300)',
    blue: 'var(--color-sky-300)',
    green: 'var(--color-emerald-300)',
    pink: 'var(--color-rose-300)',
    purple: 'var(--color-violet-300)'
  })[color]

const PDF_SQUIGGLY_MASK = `url("data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='8' height='4'><path d='M0 2 Q2 0 4 2 T8 2' fill='none' stroke='white' stroke-width='1.5'/></svg>")}")`

const pdfBookmarkMark = (
  selector: Extract<PdfBookmarkSelector, { kind: 'text' | 'region' }>
): Readonly<{ markKind: PdfMarkKind; color: PdfMarkColor }> => ({
  markKind: selector.markKind ?? (selector.kind === 'region' ? 'area' : 'highlight'),
  color: selector.color ?? 'yellow'
})

const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))

const pageAtViewportTop = (scroll: HTMLElement, viewport: DOMRect): HTMLElement | undefined => {
  const pages = Array.from(scroll.querySelectorAll<HTMLElement>('[data-page-number]'))
  return pages.find((page) => page.getBoundingClientRect().bottom > viewport.top)
}

const pageAtViewportMidpoint = (
  pages: readonly HTMLElement[],
  viewport: DOMRect
): HTMLElement | undefined => {
  const midpoint = viewport.top + viewport.height / 2
  // Page placeholders keep document order and geometry even when their canvases
  // are unmounted. Binary search avoids reading every preceding page on scroll.
  let low = 0
  let high = pages.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const bounds = pages[middle].getBoundingClientRect()
    if (bounds.height <= 0) {
      // A hidden/unlaid-out preview has no monotonic visible geometry yet.
      let current: HTMLElement | undefined
      for (const page of pages) {
        const rect = page.getBoundingClientRect()
        if (rect.height <= 0) continue
        if (rect.top > midpoint) return current ?? page
        current = page
      }
      return current
    }
    if (bounds.top <= midpoint) low = middle + 1
    else high = middle
  }
  return pages[Math.max(0, low - 1)]
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
  // Keep whole-string casing (for example, Greek final sigma). Length-changing lowercase
  // mappings need a base character and its combining marks together (Turkish/Lithuanian I).
  // Unicode mark runs suffice here; full grapheme segmentation would require Intl.Segmenter
  // in older Web browsers without improving these UTF-16 mappings.
  const originalStarts: number[] = []
  const originalEnds: number[] = []
  for (const { 0: segment, index } of text.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    const length = segment.toLocaleLowerCase().length
    for (let offset = 0; offset < length; offset += 1) {
      originalStarts.push(index + (length === segment.length ? offset : 0))
      originalEnds.push(index + (length === segment.length ? offset + 1 : segment.length))
    }
  }
  const ranges: Range[] = []
  let index = 0
  while ((index = normalizedText.indexOf(normalizedQuery, index)) >= 0) {
    const end = index + normalizedQuery.length
    const originalStart = originalStarts[index]
    const originalEnd = originalEnds[end - 1]
    // Inserted word/line gaps have no DOM node: anchor their endpoints to adjacent text.
    const startNodeIndex = starts.findIndex((start, i) => start + nodes[i].length > originalStart)
    const endNodeIndex = starts.findLastIndex((start) => start < originalEnd)
    const startNode = nodes[startNodeIndex]
    const endNode = nodes[endNodeIndex]
    if (startNode && endNode) {
      const range = new Range()
      range.setStart(startNode, Math.max(0, originalStart - starts[startNodeIndex]))
      range.setEnd(endNode, Math.min(endNode.length, originalEnd - starts[endNodeIndex]))
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
): Range | undefined => {
  const registry = (globalThis as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS
    ?.highlights
  const HighlightClass = (globalThis as unknown as { Highlight?: HighlightConstructor }).Highlight
  registry?.delete('pdf-search-results')
  registry?.delete('pdf-search-current')
  if (!scroll || !query) return
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
  if (registry && HighlightClass) {
    if (allRanges.length > 0) registry.set('pdf-search-results', new HighlightClass(...allRanges))
    if (selectedRange) registry.set('pdf-search-current', new HighlightClass(selectedRange))
  }
  return selectedRange
}

const revealPdfSearchRange = (scroll: HTMLElement, range: Range | undefined): boolean => {
  const bounds = range?.getBoundingClientRect()
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return false
  const viewport = scroll.getBoundingClientRect()
  const left = viewport.left + scroll.clientLeft
  const top = viewport.top + scroll.clientTop
  const right = left + scroll.clientWidth
  const bottom = top + scroll.clientHeight
  // Center offscreen matches away from the floating controls; leave visible matches still.
  // An oversized match reveals its beginning.
  if (bounds.top < top || bounds.bottom > bottom) {
    scroll.scrollTop += bounds.top - top - Math.max(0, (scroll.clientHeight - bounds.height) / 2)
  }
  if (bounds.left < left || bounds.right > right) {
    scroll.scrollLeft +=
      bounds.left < left || bounds.width > scroll.clientWidth
        ? bounds.left - left
        : bounds.right - right
  }
  return true
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

const PdfToolbarTooltip = ({
  label,
  description,
  plain = false,
  side
}: {
  label: string
  description?: string
  plain?: boolean
  side?: 'top' | 'right' | 'bottom' | 'left'
}): React.JSX.Element => (
  <TooltipContent
    side={side}
    className={cn('z-[120]', !plain && 'pdf-toolbar-tooltip min-w-32 max-w-64 px-3 py-2')}
  >
    {plain ? (
      (description ?? label)
    ) : (
      <>
        <div className="font-medium leading-4">{label}</div>
        {description ? (
          <div className="mt-1 text-[11px] leading-4 text-bg-000/70">{description}</div>
        ) : null}
      </>
    )}
  </TooltipContent>
)

const PdfInteractionControls = ({
  mode,
  canSelectArea,
  areaAgentUnavailableReason,
  annotationUnavailableReason,
  canAnnotateArea,
  canAnnotateText,
  textMarkStyle,
  onTextMarkStyleChange,
  navigationAvailable,
  navigationOpen,
  searchOpen,
  onNavigationToggle,
  onSearchToggle,
  onModeChange,
  children
}: {
  children?: React.ReactNode
  mode: PdfCursorMode
  canSelectArea: boolean
  areaAgentUnavailableReason: string
  annotationUnavailableReason: string
  canAnnotateArea: boolean
  canAnnotateText: boolean
  textMarkStyle: PdfTextMarkStyle
  onTextMarkStyleChange: (style: PdfTextMarkStyle) => void
  navigationAvailable: boolean
  navigationOpen: boolean
  searchOpen: boolean
  onNavigationToggle: () => void
  onSearchToggle: () => void
  onModeChange: (mode: PdfCursorMode) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [openOptions, setOpenOptions] = useState<'style' | 'area'>()
  const styleOpen = openOptions === 'style'
  const areaOpen = openOptions === 'area'
  const setStyleOpen = (open: boolean): void => setOpenOptions(open ? 'style' : undefined)
  const optionsHoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const optionsOpenedByHover = useRef(false)
  const cancelOptionsHover = (): void => clearTimeout(optionsHoverTimer.current)
  const closeHoveredOptions = (): void => {
    cancelOptionsHover()
    if (optionsOpenedByHover.current)
      optionsHoverTimer.current = setTimeout(() => setOpenOptions(undefined), 180)
  }
  useEffect(() => () => clearTimeout(optionsHoverTimer.current), [])
  if (!canAnnotateText && styleOpen) setStyleOpen(false)
  useEffect(() => {
    if (!canAnnotateText) clearTimeout(optionsHoverTimer.current)
  }, [canAnnotateText])
  const usesAreaAnnotation = mode === 'area-annotation' || !canSelectArea
  const MarkIcon =
    textMarkStyle.kind === 'highlight'
      ? Highlighter
      : textMarkStyle.kind === 'underline'
        ? Underline
        : textMarkStyle.kind === 'squiggly'
          ? Waves
          : Strikethrough
  const actions = [
    { mode: 'select' as const, label: t('Select'), icon: MousePointer2 },
    { mode: 'hand' as const, label: t('Hand'), icon: Hand }
  ]

  return (
    <TooltipProvider skipDelayDuration={300}>
      <div
        data-pdf-controls="interaction"
        role="group"
        aria-label={t('PDF interaction tools')}
        className="pdf-annotation-toolbar absolute top-3 left-3 z-40 max-w-[calc(100%-1.5rem)] rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-menu"
      >
        <div className="flex flex-wrap items-center gap-1">
          {navigationAvailable ? (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant={navigationOpen ? 'secondary' : 'ghost'}
                    size="icon-sm"
                    className="size-8 text-text-100 hover:text-text-000 [@media(pointer:coarse)]:size-11"
                    aria-label={navigationOpen ? t('Hide navigation') : t('Show navigation')}
                    aria-controls="pdf-navigation-sidebar"
                    aria-expanded={navigationOpen}
                    onClick={onNavigationToggle}
                  >
                    <PanelLeft aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <PdfToolbarTooltip
                  label={navigationOpen ? t('Hide navigation') : t('Show navigation')}
                />
              </Tooltip>
              <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
            </>
          ) : null}
          {actions.map(({ mode: actionMode, label, icon: Icon }) => (
            <Tooltip key={actionMode}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant={mode === actionMode ? 'secondary' : 'ghost'}
                  size="icon-sm"
                  className="size-8 text-text-100 hover:text-text-000 [@media(pointer:coarse)]:size-11"
                  aria-label={label}
                  aria-pressed={mode === actionMode}
                  onClick={() => onModeChange(actionMode)}
                >
                  <Icon aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <PdfToolbarTooltip label={label} />
            </Tooltip>
          ))}
          <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
          <div
            className="annotation-style-split flex shrink-0 items-center rounded-md"
            data-open={styleOpen}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant={mode === 'text-annotation' ? 'secondary' : 'ghost'}
                  size="icon-sm"
                  className={cn(
                    'annotation-style-apply size-8 rounded-r-none p-0',
                    !canAnnotateText && 'opacity-50 cursor-not-allowed'
                  )}
                  aria-disabled={!canAnnotateText}
                  aria-label={t('Annotate selected text')}
                  aria-pressed={mode === 'text-annotation'}
                  onClick={() => {
                    if (!canAnnotateText) return
                    cancelOptionsHover()
                    setStyleOpen(false)
                    onModeChange(mode === 'text-annotation' ? 'select' : 'text-annotation')
                  }}
                >
                  <span
                    className="inline-flex size-6 items-center justify-center rounded-sm text-neutral-900"
                    style={{
                      backgroundColor: `var(--color-${textMarkStyle.color === 'yellow' ? 'amber' : textMarkStyle.color === 'pink' ? 'rose' : textMarkStyle.color}-300)`
                    }}
                  >
                    <MarkIcon className="size-4" aria-hidden="true" />
                  </span>
                </Button>
              </TooltipTrigger>
              <PdfToolbarTooltip
                label={t('Annotate')}
                plain={!canAnnotateText}
                description={
                  canAnnotateText
                    ? t('Select text to annotate. Press Esc to exit.')
                    : annotationUnavailableReason
                }
              />
            </Tooltip>
            <Popover
              open={styleOpen}
              onOpenChange={(open) => {
                cancelOptionsHover()
                setStyleOpen(open)
              }}
            >
              <Tooltip>
                <TooltipTrigger
                  asChild
                  onFocus={(event) => {
                    if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
                  }}
                >
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className={cn(
                        'annotation-style-trigger h-8 w-6 rounded-l-none text-muted-foreground',
                        !canAnnotateText && 'opacity-50 cursor-not-allowed'
                      )}
                      aria-disabled={!canAnnotateText}
                      aria-label={t('Mark style')}
                      onPointerEnter={(event) => {
                        cancelOptionsHover()
                        if (event.pointerType === 'touch' || !canAnnotateText || styleOpen) return
                        optionsHoverTimer.current = setTimeout(() => {
                          optionsOpenedByHover.current = true
                          setStyleOpen(true)
                        }, 120)
                      }}
                      onPointerLeave={closeHoveredOptions}
                      onClick={(event) => {
                        if (!canAnnotateText) {
                          event.preventDefault()
                          return
                        }
                        cancelOptionsHover()
                        // Clicking an already hover-open panel pins it for keyboard/touch use.
                        if (styleOpen && optionsOpenedByHover.current) event.preventDefault()
                        optionsOpenedByHover.current = false
                      }}
                    >
                      <ChevronDown className="size-3" aria-hidden="true" />
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <PdfToolbarTooltip
                  label={t('Mark style')}
                  plain={!canAnnotateText}
                  description={canAnnotateText ? undefined : annotationUnavailableReason}
                />
              </Tooltip>
              <PopoverContent
                align="start"
                onPointerEnter={cancelOptionsHover}
                onPointerLeave={closeHoveredOptions}
                onKeyDownCapture={() => {
                  optionsOpenedByHover.current = false
                }}
                onEscapeKeyDown={(event) => event.stopPropagation()}
                onOpenAutoFocus={(event) => {
                  if (optionsOpenedByHover.current) event.preventDefault()
                }}
                onCloseAutoFocus={(event) => {
                  if (optionsOpenedByHover.current) event.preventDefault()
                }}
                sideOffset={8}
                collisionPadding={8}
                className="annotation-popover z-[110] w-fit max-w-[calc(100vw-1rem)] space-y-3 rounded-lg border border-border bg-popover p-2.5 text-popover-foreground shadow-menu"
              >
                <PdfTextMarkControls
                  value={textMarkStyle}
                  onChange={(style) => {
                    onTextMarkStyleChange(style)
                    onModeChange('text-annotation')
                  }}
                />
              </PopoverContent>
            </Popover>
          </div>
          {canSelectArea || canAnnotateArea ? (
            <div
              className="pdf-area-split annotation-style-split flex shrink-0 items-center rounded-md"
              data-open={areaOpen}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant={mode === 'area' || mode === 'area-annotation' ? 'secondary' : 'ghost'}
                    size="icon-sm"
                    className="pdf-area-action annotation-style-apply size-8 rounded-r-none p-0"
                    disabled={!canAnnotateArea && !canSelectArea}
                    aria-pressed={mode === 'area' || mode === 'area-annotation'}
                    aria-label={
                      mode === 'area-annotation' || !canSelectArea
                        ? t('Select area to annotate')
                        : t('Select area for Agent')
                    }
                    onClick={() => {
                      cancelOptionsHover()
                      setOpenOptions(undefined)
                      onModeChange(
                        mode === 'area-annotation' || !canSelectArea ? 'area-annotation' : 'area'
                      )
                    }}
                  >
                    {mode === 'area-annotation' || !canSelectArea ? (
                      <SquareDashedMousePointer className="size-3.5" aria-hidden="true" />
                    ) : (
                      <Scan className="size-3.5" aria-hidden="true" />
                    )}
                  </Button>
                </TooltipTrigger>
                <PdfToolbarTooltip
                  label={
                    mode === 'area-annotation' || !canSelectArea
                      ? t('Select area to annotate')
                      : t('Select area for Agent')
                  }
                  plain={usesAreaAnnotation ? !canAnnotateArea : !canSelectArea}
                  description={
                    mode === 'area-annotation' || !canSelectArea
                      ? t('Drag to annotate an area · Esc to cancel')
                      : t('Drag to send an area to Agent · Esc to cancel')
                  }
                />
              </Tooltip>
              <DropdownMenu
                modal={false}
                open={areaOpen}
                onOpenChange={(open) => {
                  cancelOptionsHover()
                  setOpenOptions(open ? 'area' : undefined)
                }}
              >
                <Tooltip>
                  <TooltipTrigger
                    asChild
                    onFocus={(event) => {
                      if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
                    }}
                  >
                    <DropdownMenuTrigger
                      asChild
                      onPointerDown={(event) => {
                        cancelOptionsHover()
                        if (areaOpen && optionsOpenedByHover.current) event.preventDefault()
                        optionsOpenedByHover.current = false
                      }}
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="pdf-area-menu-trigger annotation-style-trigger h-8 w-6 rounded-l-none text-muted-foreground"
                        aria-label={t('Area selection actions')}
                        onPointerEnter={(event) => {
                          cancelOptionsHover()
                          if (event.pointerType === 'touch' || areaOpen) return
                          optionsHoverTimer.current = setTimeout(() => {
                            optionsOpenedByHover.current = true
                            setOpenOptions('area')
                          }, 120)
                        }}
                        onPointerLeave={closeHoveredOptions}
                      >
                        <ChevronDown className="size-3" aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <PdfToolbarTooltip label={t('Area selection actions')} />
                </Tooltip>
                <DropdownMenuContent
                  align="start"
                  sideOffset={8}
                  collisionPadding={8}
                  className="annotation-popover z-[110]"
                  onPointerEnter={cancelOptionsHover}
                  onPointerLeave={closeHoveredOptions}
                  onKeyDownCapture={() => {
                    optionsOpenedByHover.current = false
                  }}
                  onEscapeKeyDown={(event) => event.stopPropagation()}
                  onInteractOutside={(event) => {
                    if (
                      event.target instanceof Element &&
                      event.target.closest('.pdf-area-menu-trigger')
                    )
                      event.preventDefault()
                  }}
                  onCloseAutoFocus={(event) => {
                    if (optionsOpenedByHover.current) event.preventDefault()
                  }}
                >
                  {[
                    {
                      mode: 'area' as const,
                      available: canSelectArea,
                      label: t('Select area for Agent'),
                      icon: Scan,
                      reason: areaAgentUnavailableReason
                    },
                    {
                      mode: 'area-annotation' as const,
                      available: canAnnotateArea,
                      label: t('Select area to annotate'),
                      icon: SquareDashedMousePointer,
                      reason: annotationUnavailableReason
                    }
                  ].map(({ mode: actionMode, available, label, icon: Icon, reason }) => (
                    <Tooltip key={actionMode}>
                      <TooltipTrigger asChild>
                        <DropdownMenuItem
                          aria-disabled={!available}
                          className={!available ? 'cursor-not-allowed opacity-50' : undefined}
                          onSelect={(event) => {
                            if (!available) event.preventDefault()
                            else onModeChange(actionMode)
                          }}
                        >
                          <Icon className="mr-2 size-4" aria-hidden="true" />
                          {label}
                        </DropdownMenuItem>
                      </TooltipTrigger>
                      {!available ? (
                        <PdfToolbarTooltip
                          label={label}
                          plain={!available}
                          description={reason}
                          side="right"
                        />
                      ) : null}
                    </Tooltip>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null}
          <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant={searchOpen ? 'secondary' : 'ghost'}
                size="icon-sm"
                className="size-8 text-text-100 hover:text-text-000"
                aria-label={t('Search')}
                aria-pressed={searchOpen}
                onClick={onSearchToggle}
              >
                <Search aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <PdfToolbarTooltip label={t('Search')} />
          </Tooltip>
          {children}
        </div>
        {mode === 'area' || mode === 'area-annotation' || mode === 'text-annotation' ? (
          <div
            role="status"
            className="mt-1 border-t border-border/60 px-2 py-1.5 text-xs text-muted-foreground"
          >
            {mode === 'text-annotation'
              ? t('Select text to annotate. Press Esc to exit.')
              : mode === 'area-annotation' || !canSelectArea
                ? t('Drag to annotate an area · Esc to cancel')
                : t('Drag to send an area to Agent · Esc to cancel')}
          </div>
        ) : null}
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
    <TooltipProvider skipDelayDuration={300}>
      <div className="absolute top-3 right-3 z-40 flex h-8 items-center gap-0.5 rounded-md border border-border-300/50 bg-bg-000/95 p-0.5 shadow-sm backdrop-blur">
        <Search className="ml-1 size-3.5 shrink-0 text-text-300" aria-hidden="true" />
        <Input
          autoFocus
          type="search"
          data-preview-escape-boundary
          value={query}
          aria-label={t('Search document')}
          placeholder={t('Search document')}
          className="h-7 w-44 bg-transparent px-1 text-xs text-text-000 outline-none placeholder:text-text-400"
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onFindAgain(event.shiftKey)
            if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              event.stopPropagation()
              onClose()
            }
          }}
        />
        <span className="min-w-10 px-1 text-center text-[11px] tabular-nums text-text-300">
          {query ? `${current}/${total}` : ''}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-text-100 hover:text-text-000"
              aria-label={t('Previous match')}
              disabled={total === 0}
              onClick={() => onFindAgain(true)}
            >
              <ChevronUp aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent className="z-[120]">{t('Previous match')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-text-100 hover:text-text-000"
              aria-label={t('Next match')}
              disabled={total === 0}
              onClick={() => onFindAgain(false)}
            >
              <ChevronDown aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent className="z-[120]">{t('Next match')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-text-100 hover:text-text-000"
              aria-label={t('Close search')}
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent className="z-[120]">{t('Close search')}</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
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
    <TooltipProvider skipDelayDuration={300}>
      <div
        data-pdf-controls="view"
        role="group"
        aria-label={t('PDF view controls')}
        className="absolute right-3 bottom-3 z-10 flex min-h-10 items-center gap-1 rounded-xl border border-border-300/50 bg-bg-000/90 p-1 shadow-sm backdrop-blur"
      >
        <div
          data-pdf-page-control
          className="inline-flex h-8 items-center gap-0.5 border-r border-border-300/60 pr-1 text-[11px] tabular-nums text-text-200"
        >
          {editingPage ? (
            <Input
              autoFocus
              type="number"
              inputMode="numeric"
              data-preview-escape-boundary
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
                if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  event.stopPropagation()
                  finishPageEdit(false)
                }
              }}
            />
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="w-auto min-w-7 cursor-text px-1 text-[11px] text-text-200 hover:text-text-000"
                  aria-label={pageLabel}
                  onClick={() => {
                    setPageDraft(String(currentPage))
                    setEditingPage(true)
                  }}
                >
                  {currentPage}
                </Button>
              </TooltipTrigger>
              <TooltipContent className="z-[120]">
                {t('Click to enter a page number')}
              </TooltipContent>
            </Tooltip>
          )}
          <span aria-hidden="true">/</span>
          <span className="min-w-4 px-0.5 text-center" aria-hidden="true">
            {pageCount}
          </span>
        </div>
        <span className="inline-flex h-8 min-w-[3ch] items-center justify-center px-1 text-center text-[11px] tabular-nums text-text-200">
          {Math.round(zoom * 100)}%
        </span>
        {actions.map(({ label, icon: Icon, onClick, disabled }) => (
          <Tooltip key={label}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="h-8 w-8 text-text-100 hover:text-text-000 [@media(pointer:coarse)]:size-11"
                aria-label={label}
                disabled={disabled}
                onClick={onClick}
              >
                <Icon aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent className="z-[120]">{label}</TooltipContent>
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

const pdfBookmarkSourceMatches = (
  candidate: PdfAnnotationSource,
  expected: PdfAnnotationSource
): boolean =>
  candidate.kind === expected.kind &&
  candidate.projectId === expected.projectId &&
  candidate.sourceFileId === expected.sourceFileId &&
  candidate.versionId === expected.versionId &&
  candidate.checksum === expected.checksum

const PdfEvidenceLayer = ({
  pageNumber,
  pageRotation,
  source,
  bookmarkSource,
  canvas,
  textLayer,
  intent,
  activeAnnotations,
  selectedAnnotationId,
  selectedBookmarkId,
  onAddAnnotation,
  onRemoveAnnotation,
  onSelectAnnotation,
  onSelectBookmark,
  onAnnotationError,
  onSelected
}: {
  pageNumber: number
  pageRotation: number
  source?: PdfAnnotation['source']
  bookmarkSource?: PdfAnnotationSource
  canvas: React.RefObject<HTMLCanvasElement | null>
  textLayer: React.RefObject<HTMLDivElement | null>
  intent?: PdfRegionIntent
  activeAnnotations: readonly Annotation[]
  selectedAnnotationId?: string
  selectedBookmarkId?: string
  onAddAnnotation?: PreviewFileRendererProps['onAddAnnotation']
  onRemoveAnnotation?: PreviewFileRendererProps['onRemoveAnnotation']
  onSelectAnnotation?: (id: string) => void
  onSelectBookmark?: (id?: string) => void
  onAnnotationError?: PreviewFileRendererProps['onAnnotationError']
  onSelected: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const pdfAnnotations = usePdfAnnotations()
  const [start, setStart] = useState<Readonly<{ x: number; y: number }>>()
  const [end, setEnd] = useState<Readonly<{ x: number; y: number }>>()
  const [reveal, setReveal] = useState<Readonly<{ id: string; sequence: number }>>()
  const [preparedAnnotation, setPreparedAnnotation] = useState<PdfAnnotation>()
  const [preparedBookmark, setPreparedBookmark] = useState<BookmarkRevealTarget>()
  const [regionDraft, setRegionDraft] = useState<
    Readonly<{
      id: string
      rect: ReturnType<typeof normalizedPdfRect> & {}
      text?: string
      note: string
      color: PdfMarkColor
      tagIds: string[]
      saving: boolean
      error?: string
    }>
  >()
  const revealSequence = useRef(0)
  const highlightLayer = useRef<HTMLDivElement | null>(null)
  const matching = useMemo(() => {
    const annotations =
      preparedAnnotation &&
      !activeAnnotations.some((annotation) => annotation.id === preparedAnnotation.id)
        ? [...activeAnnotations, preparedAnnotation]
        : activeAnnotations
    if (!source) return []
    return annotations.filter(
      (annotation): annotation is PdfAnnotation =>
        annotation.kind === 'pdf' &&
        annotation.source.projectId === source.projectId &&
        annotation.source.versionId === source.versionId &&
        annotation.source.checksum === source.checksum &&
        annotation.selector.pageNumber === pageNumber
    )
  }, [activeAnnotations, pageNumber, preparedAnnotation, source])
  const pageAnnotations = pdfAnnotations.forPage(bookmarkSource, pageNumber)
  const matchingBookmarks = useMemo(() => {
    if (!bookmarkSource) return []
    const saved = pageAnnotations.flatMap((bookmark) =>
      pdfBookmarkSelectorMatchesPage(bookmark.target.selector, pageNumber, pageRotation)
        ? [
            {
              id: bookmark.id,
              kind: 'pdf',
              source: bookmark.target.source,
              selector:
                bookmark.target.selector.kind === 'text' ||
                bookmark.target.selector.kind === 'region'
                  ? {
                      ...bookmark.target.selector,
                      markKind: bookmark.kind as PdfMarkKind,
                      color: bookmark.color
                    }
                  : bookmark.target.selector
            } satisfies BookmarkRevealTarget
          ]
        : []
    )
    return preparedBookmark &&
      preparedBookmark.kind === 'pdf' &&
      pdfBookmarkSourceMatches(preparedBookmark.source, bookmarkSource) &&
      pdfBookmarkSelectorMatchesPage(preparedBookmark.selector, pageNumber, pageRotation) &&
      !saved.some((bookmark) => bookmark.id === preparedBookmark.id)
      ? [...saved, preparedBookmark]
      : saved
  }, [bookmarkSource, pageAnnotations, pageNumber, pageRotation, preparedBookmark])

  useEffect(
    () =>
      subscribeAnnotationRevealPreparation((annotation) => {
        if (
          !source ||
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
    [pageNumber, source]
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

  useEffect(
    () =>
      subscribeBookmarkRevealPreparation((target) => {
        if (
          highlightLayer.current
            ?.closest('[data-pdf-preview-root]')
            ?.closest('[inert], [aria-hidden="true"]')
        )
          return
        const selector = target.kind === 'pdf' ? target.selector : undefined
        const targetPage =
          selector &&
          (selector.kind === 'text' || selector.kind === 'region' || selector.kind === 'page-note')
            ? selector.pageNumber
            : undefined
        if (
          !bookmarkSource ||
          target.kind !== 'pdf' ||
          !pdfBookmarkSourceMatches(target.source, bookmarkSource) ||
          targetPage !== pageNumber
        ) {
          return
        }
        setPreparedBookmark(target)
      }),
    [bookmarkSource, pageNumber]
  )

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = subscribeBookmarkReveal((target) => {
      if (
        highlightLayer.current
          ?.closest('[data-pdf-preview-root]')
          ?.closest('[inert], [aria-hidden="true"]')
      )
        return
      const selector = target.kind === 'pdf' ? target.selector : undefined
      const targetPage =
        selector &&
        (selector.kind === 'text' || selector.kind === 'region' || selector.kind === 'page-note')
          ? selector.pageNumber
          : undefined
      if (
        !bookmarkSource ||
        target.kind !== 'pdf' ||
        !pdfBookmarkSourceMatches(target.source, bookmarkSource)
      ) {
        return
      }
      if (targetPage !== pageNumber) return
      if (!selector || !pdfBookmarkSelectorMatchesPage(selector, pageNumber, pageRotation)) {
        return 'locator-unsupported'
      }
      const sequence = ++revealSequence.current
      onSelectBookmark?.(target.id)
      setPreparedBookmark(target)
      setReveal({ id: target.id, sequence })
      clearTimeout(timer)
      timer = setTimeout(() => {
        setReveal((current) => (current?.sequence === sequence ? undefined : current))
        setPreparedBookmark((current) => (current?.id === target.id ? undefined : current))
      }, 1_600)
      return true
    })
    return () => {
      unsubscribe()
      clearTimeout(timer)
    }
  }, [bookmarkSource, onSelectBookmark, pageNumber, pageRotation])

  useEffect(() => {
    if (!reveal) return
    const target = Array.from(
      highlightLayer.current?.querySelectorAll<HTMLElement>(
        '[data-pdf-evidence-highlight], [data-pdf-bookmark-highlight]'
      ) ?? []
    ).find(
      (element) =>
        element.dataset.pdfEvidenceHighlight === reveal.id ||
        element.dataset.pdfBookmarkHighlight === reveal.id
    )
    target?.scrollIntoView({
      block: 'center',
      inline: 'center',
      behavior: annotationRevealScrollBehavior()
    })
  }, [reveal])

  const draft = start && end ? normalizedPdfRect(start, end) : regionDraft?.rect
  const addRegion = (element: HTMLDivElement, rect: NonNullable<typeof draft>): void => {
    const page = element.getBoundingClientRect()
    setStart(undefined)
    setEnd(undefined)
    const text = textInPdfRect(textLayer.current, page, rect, ANNOTATION_LIMITS.quote)
    if (intent === 'annotation' && bookmarkSource) {
      setRegionDraft({
        id: createAnnotationId().replace(/^annotation-/u, 'bookmark-'),
        rect,
        ...(text ? { text } : {}),
        note: '',
        color: 'yellow',
        tagIds: [],
        saving: false
      })
      return
    }
    if (intent !== 'agent' || !canvas.current || !onAddAnnotation || !source) return
    const image = cropPdfCanvasRegion(canvas.current, rect)
    if (!image) {
      onAnnotationError?.('payload-too-large')
      return
    }
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

  const saveRegionDraft = async (): Promise<void> => {
    if (!regionDraft) return
    if (!bookmarkSource || !pdfAnnotations.available) return
    setRegionDraft({ ...regionDraft, saving: true, error: undefined })
    try {
      await pdfAnnotations.create(
        regionDraft.id,
        {
          source: bookmarkSource,
          selector: {
            kind: 'region',
            pageNumber,
            rect: regionDraft.rect,
            pageRotation,
            ...(regionDraft.text ? { text: regionDraft.text } : {}),
            coordinateVersion: 1
          }
        },
        'area',
        regionDraft.color,
        regionDraft.tagIds,
        regionDraft.note.trim()
      )
      setRegionDraft(undefined)
      onSelected()
    } catch (error) {
      setRegionDraft((current) =>
        current
          ? {
              ...current,
              saving: false,
              error:
                error instanceof Error
                  ? error.message
                  : t('Annotation could not be saved. Try again.')
            }
          : current
      )
    }
  }

  return (
    <>
      <div ref={highlightLayer} className="pointer-events-none absolute inset-0 z-40">
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
              data-pdf-area-remove={annotation.id}
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
        {matchingBookmarks.flatMap((bookmark) => {
          const selector = bookmark.selector
          if (selector.kind !== 'text' && selector.kind !== 'region') return []
          const boxes = selector.kind === 'text' ? selector.quads : [selector.rect]
          const { markKind, color } = pdfBookmarkMark(selector)
          const colorValue = pdfMarkColorValue(color)
          const isRevealed = reveal?.id === bookmark.id
          const isSelected = selectedBookmarkId === bookmark.id
          return boxes.map((rect, index) => (
            <button
              key={`${bookmark.id}-${index}-${isRevealed ? reveal.sequence : 0}`}
              type="button"
              data-pdf-bookmark-highlight={bookmark.id}
              data-pdf-bookmark-revealed={isRevealed ? 'true' : undefined}
              aria-label={t('Select annotation')}
              aria-pressed={isSelected}
              className={cn(
                'pointer-events-auto absolute appearance-none rounded-[2px] border-0 p-0 text-left transition-[box-shadow,filter] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                markKind === 'area' && 'ring-1 ring-inset',
                isRevealed && 'pdf-evidence-reveal',
                isSelected && 'z-10 brightness-95 ring-2 ring-primary/80'
              )}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onSelectBookmark?.(bookmark.id)
              }}
              style={{
                left: `${rect.x * 100}%`,
                top: `${rect.y * 100}%`,
                width: `${rect.width * 100}%`,
                height: `${rect.height * 100}%`,
                backgroundColor:
                  markKind === 'highlight' || markKind === 'area'
                    ? `color-mix(in oklab, ${colorValue} 42%, transparent)`
                    : 'transparent',
                borderColor: `color-mix(in oklab, ${colorValue} 70%, transparent)`,
                ...(markKind === 'strikethrough'
                  ? {
                      backgroundImage: `linear-gradient(to bottom, transparent 45%, ${colorValue} 45%, ${colorValue} 57%, transparent 57%)`
                    }
                  : markKind === 'squiggly'
                    ? {
                        backgroundColor: colorValue,
                        maskImage: PDF_SQUIGGLY_MASK,
                        maskRepeat: 'repeat-x',
                        maskPosition: 'left bottom',
                        maskSize: '8px 4px'
                      }
                    : markKind === 'underline'
                      ? { borderBottom: `0.12rem solid ${colorValue}` }
                      : {})
              }}
            />
          ))
        })}
        {pageAnnotations.flatMap((annotation) => {
          const selector = annotation.target.selector
          if (!pdfBookmarkSelectorMatchesPage(selector, pageNumber, pageRotation)) return []
          const rect =
            selector.kind === 'text'
              ? selector.quads.at(-1)
              : selector.kind === 'region'
                ? selector.rect
                : undefined
          if (!rect) return []
          return [
            <PdfAnnotationMarker
              key={annotation.id}
              id={annotation.id}
              note={annotation.note}
              left={`${Math.min(0.97, rect.x + rect.width) * 100}%`}
              top={`${rect.y * 100}%`}
            />
          ]
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
        {regionDraft ? (
          <Popover
            open
            onOpenChange={(open) => {
              if (!open && !regionDraft.saving) onSelected()
            }}
          >
            <PopoverAnchor asChild>
              <span
                className="absolute size-px"
                style={{
                  left: `${(regionDraft.rect.x + regionDraft.rect.width) * 100}%`,
                  top: `${(regionDraft.rect.y + regionDraft.rect.height) * 100}%`
                }}
              />
            </PopoverAnchor>
            <PopoverContent
              data-pdf-region-bookmark-editor="true"
              aria-label={t('Area annotation')}
              align="end"
              side="bottom"
              collisionPadding={12}
              onEscapeKeyDown={(event) => {
                if (regionDraft.saving) {
                  event.preventDefault()
                  event.stopPropagation()
                }
              }}
              className="annotation-popover z-[110] w-80 max-w-[calc(100vw-1.5rem)] max-h-[var(--radix-popover-content-available-height)] space-y-2 overflow-y-auto border border-border bg-popover p-3 text-popover-foreground shadow-dialog"
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <SquareDashedMousePointer className="size-4" aria-hidden="true" />
                {t('Area annotation')}
              </div>
              {regionDraft.text ? (
                <blockquote className="line-clamp-2 rounded-md bg-muted/70 px-2 py-1.5 text-xs leading-5 text-muted-foreground">
                  {regionDraft.text}
                </blockquote>
              ) : null}
              <label
                className="block text-xs font-medium"
                htmlFor={`pdf-bookmark-note-${regionDraft.id}`}
              >
                {t('Note (optional)')}
              </label>
              <Textarea
                id={`pdf-bookmark-note-${regionDraft.id}`}
                data-pdf-bookmark-note="true"
                autoFocus
                value={regionDraft.note}
                maxLength={20_000}
                placeholder={t('Annotation note')}
                disabled={regionDraft.saving}
                onChange={(event) =>
                  setRegionDraft({ ...regionDraft, note: event.target.value, error: undefined })
                }
              />
              <PdfMarkColorControls
                value={regionDraft.color}
                onChange={(color) => setRegionDraft({ ...regionDraft, color })}
                disabled={regionDraft.saving}
              />
              <div className="text-xs font-medium">{t('Tags')}</div>
              <TagSelection
                value={regionDraft.tagIds}
                onChange={(tagIds) => setRegionDraft({ ...regionDraft, tagIds })}
                disabled={regionDraft.saving || !pdfAnnotations.available}
              />
              {!bookmarkSource || !pdfAnnotations.available ? (
                <p role="status" className="text-xs text-muted-foreground">
                  {!pdfAnnotations.available
                    ? t('Annotations are available after this conversation is saved.')
                    : t('PDF annotations are unavailable for this source.')}
                </p>
              ) : null}
              {regionDraft.error ? (
                <p role="alert" className="text-xs text-destructive">
                  {regionDraft.error}
                </p>
              ) : null}
              <div className="flex items-center justify-end gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={regionDraft.saving}
                  onClick={() => {
                    setRegionDraft(undefined)
                    onSelected()
                  }}
                >
                  {t('Cancel')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={regionDraft.saving || !bookmarkSource || !pdfAnnotations.available}
                  onClick={() => void saveRegionDraft()}
                >
                  {t('Save annotation')}
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
      {intent ? (
        <div
          data-pdf-region-selection="true"
          className="absolute inset-0 z-30 cursor-crosshair touch-none"
          onPointerDown={(event) => {
            if (regionDraft || event.button !== 0 || !event.isPrimary) return
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
const PdfPageCanvas = memo(function PdfPageCanvas({
  document,
  nativeAnnotationRevision,
  pageNumber,
  pageWidth,
  registerDisposer,
  annotationProps,
  pdfEvidenceSource,
  pdfBookmarkSource,
  pdfRevealSource,
  selectedEvidenceId,
  selectedBookmarkId,
  onSelectEvidence,
  onSelectBookmark,
  onTextLayerRendered,
  regionSelectionIntent,
  quickTextMark,
  onRegionSelected
}: {
  document: PdfDocument
  nativeAnnotationRevision: number
  pageNumber: number
  pageWidth: number
  registerDisposer: (dispose: () => void) => () => void
  annotationProps?: PreviewFileRendererProps
  pdfEvidenceSource?: PdfAnnotation['source']
  pdfBookmarkSource?: PdfAnnotationSource
  pdfRevealSource?: PdfAnnotation['source']
  selectedEvidenceId?: string
  selectedBookmarkId?: string
  onSelectEvidence: (id: string) => void
  onSelectBookmark?: (id?: string) => void
  onTextLayerRendered?: () => void
  regionSelectionIntent?: PdfRegionIntent
  quickTextMark?: PdfTextMarkStyle
  onRegionSelected: () => void
}): React.JSX.Element {
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
    queueMicrotask(() => {
      if (!canceled) setStatus('loading')
    })
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
      const renderTask = page.render({
        canvas,
        canvasContext: context,
        viewport,
        annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE
      })
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
  }, [isNearViewport, pageEpoch, pageNumber, pageWidth, nativeAnnotationRevision])

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
      data-pdf-page-rotation={pageRotation}
    >
      {annotationProps && isNearViewport ? (
        <PreviewTextAnnotationSurface
          {...annotationProps}
          sourcePageNumber={pageNumber}
          pdfEvidenceSource={pdfEvidenceSource}
          pdfBookmarkSource={pdfBookmarkSource}
          pdfPageRotation={pageRotation}
          pdfExtractorVersion={`pdfjs-${pdfjsLib.version}`}
          quickTextMark={quickTextMark}
          onAnnotationAdded={onRegionSelected}
        >
          {pageContent}
        </PreviewTextAnnotationSurface>
      ) : (
        pageContent
      )}
      {isNearViewport &&
      status === 'ready' &&
      (pdfEvidenceSource || pdfBookmarkSource || pdfRevealSource) ? (
        <PdfEvidenceLayer
          key={regionSelectionIntent ?? 'viewing'}
          pageNumber={pageNumber}
          pageRotation={pageRotation}
          source={pdfEvidenceSource ?? pdfRevealSource}
          bookmarkSource={pdfBookmarkSource}
          canvas={canvasRef}
          textLayer={textLayerHostRef}
          intent={regionSelectionIntent}
          activeAnnotations={annotationProps?.activeAnnotations ?? []}
          selectedAnnotationId={selectedEvidenceId}
          selectedBookmarkId={selectedBookmarkId}
          onAddAnnotation={pdfEvidenceSource ? annotationProps?.onAddAnnotation : undefined}
          onRemoveAnnotation={annotationProps?.onRemoveAnnotation}
          onSelectAnnotation={onSelectEvidence}
          onSelectBookmark={onSelectBookmark}
          onAnnotationError={annotationProps?.onAnnotationError}
          onSelected={onRegionSelected}
        />
      ) : null}
    </div>
  )
})

export const PdfPreviewContent = ({
  path,
  name,
  source = 'local',
  projectId,
  sessionId,
  managedFileId,
  selectedVersionId,
  mimeType,
  size,
  mtimeMs,
  onReadingPositionChange,
  annotationProps,
  pdfEvidenceSource,
  pdfBookmarkSource,
  pdfBookmarkSourceUnavailable = false,
  pdfRevealSource,
  nativeImportProgress,
  onCancelNativeImport,
  presentation = 'reader'
}: {
  path: string
  name: string
  source?: PreviewFileSource
  projectId?: string
  sessionId?: string
  managedFileId?: string
  selectedVersionId?: string
  mimeType?: string
  size?: number
  mtimeMs?: number
  onReadingPositionChange?: PreviewFileRendererProps['onPdfReadingPositionChange']
  annotationProps?: PreviewFileRendererProps
  pdfEvidenceSource?: PdfAnnotation['source']
  pdfBookmarkSource?: PdfAnnotationSource
  pdfBookmarkSourceUnavailable?: boolean
  pdfRevealSource?: PdfAnnotation['source']
  nativeImportProgress?: PdfNativeAnnotationImportProgress
  onCancelNativeImport?: () => void
  presentation?: PreviewFileRendererProps['presentation']
}): React.JSX.Element => {
  const { t } = useTranslation()
  const pdfAnnotations = usePdfAnnotations()
  const [historyError, setHistoryError] = useState(false)
  const attachmentVersionId =
    source === 'literature'
      ? (parseLiteratureAttachmentVersionReference(path) ?? undefined)
      : undefined
  const requestKey = createPreviewResourceKey({
    projectId,
    sessionId,
    source,
    path,
    managedFileId,
    selectedVersionId,
    mimeType,
    size,
    mtimeMs
  })
  const generation = usePreviewResourceGeneration()
  const resourceRequestKey = `${requestKey}:${generation}`
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const panGestureRef = useRef<PdfPanGesture | undefined>(undefined)
  const viewportAnchorRef = useRef<PdfViewportAnchor | undefined>(undefined)
  const [documentState, setDocumentState] = useState<DocumentState | null>(null)
  const [zoom, setZoom] = useState(1)
  const [cursorMode, setCursorMode] = useState<PdfCursorMode>('select')
  const [textMarkStyle, setTextMarkStyle] = useState<PdfTextMarkStyle>({
    kind: 'highlight',
    color: 'yellow'
  })
  const [panning, setPanning] = useState(false)
  const [readingMode, setReadingMode] = useState<'original' | 'figures' | 'notes'>('original')
  const [figuresVisited, setFiguresVisited] = useState(false)
  const [figuresBusy, setFiguresBusy] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [outlineWidth, setOutlineWidth] = useState(OUTLINE_DEFAULT_WIDTH)
  const [notesOpen, setNotesOpen] = useState(false)
  const [notesWidth, setNotesWidth] = useState(320)
  const [readerWidth, setReaderWidth] = useState(0)
  const readerRef = useRef<HTMLDivElement>(null)
  const notebookPanelId = useId()
  const notesToggleRef = useRef<HTMLButtonElement>(null)
  const notesTabRef = useRef<HTMLButtonElement>(null)
  const notesResizeRef = useRef<
    { pointerId: number; startX: number; startWidth: number } | undefined
  >(undefined)
  const hasReadingTabs =
    Boolean(attachmentVersionId || pdfBookmarkSource) && presentation !== 'search'
  const canShowNotesSidebar =
    presentation !== 'search' && readerWidth >= NOTES_SIDEBAR_MIN_READER_WIDTH
  const showNotesSidebar = canShowNotesSidebar && notesOpen && readingMode === 'original'
  const maxNotesWidth = Math.min(
    NOTES_SIDEBAR_MAX_WIDTH,
    Math.max(NOTES_SIDEBAR_MIN_WIDTH, readerWidth - 752)
  )
  const effectiveNotesWidth = Math.min(notesWidth, maxNotesWidth)
  const resizeNotes = (width: number): void =>
    setNotesWidth(Math.max(NOTES_SIDEBAR_MIN_WIDTH, Math.min(maxNotesWidth, width)))
  const [currentPage, setCurrentPage] = useState(1)
  const currentPageRef = useRef(1)
  const [pageLabels, setPageLabels] = useState<
    Readonly<{ requestKey: string; labels: readonly string[] | null }> | undefined
  >()
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string>()
  const [selectedBookmarkId, setSelectedBookmarkId] = useState<string>()
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<readonly PdfSearchPageMatches[]>([])
  const [searchResultCount, setSearchResultCount] = useState(0)
  const [selectedSearchIndex, setSelectedSearchIndex] = useState(0)
  const [textLayerEpoch, setTextLayerEpoch] = useState(0)
  const searchTextCacheRef = useRef(new PdfSearchTextCache())
  const pendingSearchRevealRef = useRef<
    | {
        document: PdfDocument
        requestKey: string
        query: string
        match: PdfSearchMatch
      }
    | undefined
  >(undefined)
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
    setReadingMode('original')
    setHistoryError(false)
    setFiguresVisited(false)
    setOutlineOpen(false)
    setOutlineWidth(OUTLINE_DEFAULT_WIDTH)
    setNotesOpen(false)
    setNotesWidth(320)
    setCurrentPage(1)
    setSelectedEvidenceId(undefined)
    setSelectedBookmarkId(undefined)
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
  const canAnnotateArea = Boolean(pdfBookmarkSource && pdfAnnotations.available)
  const canAnnotateText =
    canAnnotateArea && Boolean(annotationProps) && !annotationProps?.annotationVersionPending
  if (
    (!canSelectArea && cursorMode === 'area') ||
    (!canAnnotateArea && cursorMode === 'area-annotation') ||
    (!canAnnotateText && cursorMode === 'text-annotation')
  )
    setCursorMode('select')

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

  useEffect(() => {
    const onConnectionState = (event: Event): void => {
      if ((event as CustomEvent<WebEventConnectionState>).detail.phase === 'reconnecting') {
        captureViewportAnchor()
      }
    }
    window.addEventListener(WEB_EVENT_CONNECTION_STATE_EVENT, onConnectionState)
    return () => window.removeEventListener(WEB_EVENT_CONNECTION_STATE_EVENT, onConnectionState)
  }, [captureViewportAnchor])
  useLayoutEffect(() => {
    searchTextCacheRef.current.clear()
  }, [generation])

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
      const measuredReaderWidth = readerRef.current?.clientWidth ?? 0
      setReaderWidth((current) => (current === measuredReaderWidth ? current : measuredReaderWidth))
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
    if (readerRef.current) observer.observe(readerRef.current)
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
        const resource = await window.api.previewResources.acquire(
          createManagedPreviewRequest({
            source,
            path,
            projectId,
            sessionId,
            managedFileId,
            selectedVersionId,
            mimeType
          })
        )
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

        setDocumentState({
          requestKey: resourceRequestKey,
          status: 'ready',
          document,
          size: resource.size
        })
      } catch (error: unknown) {
        // Closing or switching a preview can reject the PDF.js task while cleanup destroys it.
        if (!canceled) {
          if (!isUnavailableFileError(error)) console.error('Failed to load PDF preview', error)
          setDocumentState({ requestKey: resourceRequestKey, status: 'error', error })
        }
        await dispose()
      }
    })()

    return () => {
      canceled = true
      if (resourceId) void dispose()
    }
  }, [
    managedFileId,
    mimeType,
    path,
    projectId,
    resourceRequestKey,
    selectedVersionId,
    sessionId,
    source
  ])

  const currentDocumentState =
    documentState?.requestKey === resourceRequestKey ? documentState : null
  const hasError = currentDocumentState?.status === 'error'
  const document = currentDocumentState?.status === 'ready' ? currentDocumentState.document : null
  const nativeAnnotationRevision = useNativePdfVisibility(
    document,
    pdfBookmarkSource,
    pdfAnnotations.sessionId,
    nativeImportProgress?.phase === 'completed' ? nativeImportProgress.operationId : undefined,
    pdfAnnotations.available
  )
  const pdfExport = usePdfExport({
    document,
    source: pdfBookmarkSource,
    path,
    name,
    versionId: selectedVersionId,
    size: currentDocumentState?.status === 'ready' ? currentDocumentState.size : undefined
  })
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
  const revealSearchMatch = useCallback(
    (match: PdfSearchMatch): void => {
      const scroll = scrollRef.current
      if (!scroll || !document) return
      const range = updatePdfSearchHighlights(scroll, searchQuery, match)
      pendingSearchRevealRef.current = undefined
      if (revealPdfSearchRange(scroll, range)) return
      pendingSearchRevealRef.current = {
        document,
        requestKey: resourceRequestKey,
        query: searchQuery,
        match
      }
      scrollToPage(match.pageNumber)
    },
    [document, resourceRequestKey, searchQuery, scrollToPage]
  )
  const navigateToPage = scrollToPage
  useEffect(
    () =>
      subscribeBookmarkRevealPreparation((target) => {
        if (
          scrollRef.current
            ?.closest('[data-pdf-preview-root]')
            ?.closest('[inert], [aria-hidden="true"]')
        )
          return
        const selector = target.kind === 'pdf' ? target.selector : undefined
        const targetPage =
          selector &&
          (selector.kind === 'text' || selector.kind === 'region' || selector.kind === 'page-note')
            ? selector.pageNumber
            : undefined
        if (
          !pdfBookmarkSource ||
          target.kind !== 'pdf' ||
          !pdfBookmarkSourceMatches(target.source, pdfBookmarkSource)
        ) {
          return
        }
        if (selector?.kind === 'document-note') {
          setReadingMode('notes')
          return
        }
        if (
          !document ||
          targetPage === undefined ||
          targetPage < 1 ||
          targetPage > document.numPages
        )
          return
        setReadingMode('original')
        scrollToPage(targetPage)
      }),
    [document, pdfBookmarkSource, scrollToPage]
  )
  useEffect(
    () =>
      subscribePdfReadingReveal((target) => {
        if (target.projectId !== projectId || target.path !== path || !document) return false
        setReadingMode('original')
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
          let text: string
          try {
            text = await searchTextCacheRef.current.get(pageNumber, async () => {
              const page = await document.getPage(pageNumber)
              try {
                const content = await page.getTextContent()
                return joinPdfTextItems(content.items.map((item) => ('str' in item ? item : {})))
              } finally {
                page.cleanup()
              }
            })
          } catch {
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
              revealSearchMatch({ pageNumber: matches[0].pageNumber, occurrence: 0 })
            }
          }
        }
        if (canceled) return
        setSearchResults(matches)
        setSearchResultCount(matchCount)
        if (!revealedFirstMatch && matches[0]) {
          setSelectedSearchIndex(0)
          revealSearchMatch({ pageNumber: matches[0].pageNumber, occurrence: 0 })
        }
      })()
    }, 180)
    return () => {
      canceled = true
      clearTimeout(timer)
      pendingSearchRevealRef.current = undefined
    }
  }, [document, searchQuery, revealSearchMatch])

  useEffect(() => {
    const scroll = scrollRef.current
    const selected = resolvePdfSearchMatch(searchResults, selectedSearchIndex)
    const range = updatePdfSearchHighlights(scroll, searchQuery, selected)
    const pending = pendingSearchRevealRef.current
    if (!pending) return
    if (
      pending.document !== document ||
      pending.requestKey !== resourceRequestKey ||
      pending.query !== searchQuery ||
      pending.match.pageNumber !== selected?.pageNumber ||
      pending.match.occurrence !== selected.occurrence
    ) {
      pendingSearchRevealRef.current = undefined
      return
    }
    if (scroll && revealPdfSearchRange(scroll, range)) pendingSearchRevealRef.current = undefined
  }, [
    document,
    resourceRequestKey,
    searchQuery,
    searchResults,
    selectedSearchIndex,
    textLayerEpoch
  ])

  useLayoutEffect(() => {
    const anchor = viewportAnchorRef.current
    const scroll = scrollRef.current
    if (!anchor || !scroll || !document) return
    viewportAnchorRef.current = undefined
    const page = scroll.querySelector<HTMLElement>(`[data-page-number="${anchor.pageNumber}"]`)
    if (!page) return
    const viewport = scroll.getBoundingClientRect()
    const bounds = page.getBoundingClientRect()
    scroll.scrollLeft += bounds.left + anchor.x * bounds.width - viewport.left - anchor.viewportX
    scroll.scrollTop += bounds.top + anchor.y * bounds.height - viewport.top - anchor.viewportY
  }, [document, fitWidth, zoom])

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
    // Page placeholders are stable for the lifetime of this effect. Cache the collection so a
    // scroll burst only measures the binary-search candidates instead of querying the whole PDF
    // subtree every 100ms.
    const pages = Array.from(scroll.querySelectorAll<HTMLElement>('[data-page-number]'))

    let updateTimer: ReturnType<typeof setTimeout> | undefined
    let lastReportedPage: number | undefined
    const nearestPage = (): number => {
      const viewport = scroll.getBoundingClientRect()
      return (
        Number(pageAtViewportMidpoint(pages, viewport)?.dataset.pageNumber) ||
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
      setReadingMode('original')
      scroll
        .querySelector<HTMLElement>(`[data-page-number="${annotation.selector.pageNumber}"]`)
        ?.scrollIntoView({
          block: 'center',
          behavior: annotationRevealScrollBehavior()
        })
    })
  }, [annotationProps?.item])

  const zoomBy = (delta: number): void => updateZoom((current) => clampZoom(current + delta))
  const changeCursorMode = useCallback((mode: PdfCursorMode): void => {
    panGestureRef.current = undefined
    setPanning(false)
    window.getSelection()?.removeAllRanges()
    setCursorMode(mode)
  }, [])
  const findAgain = (previous: boolean): void => {
    if (searchResultCount === 0) return
    const nextIndex = previous
      ? (selectedSearchIndex - 1 + searchResultCount) % searchResultCount
      : (selectedSearchIndex + 1) % searchResultCount
    const nextMatch = resolvePdfSearchMatch(searchResults, nextIndex)
    if (!nextMatch) return
    setSelectedSearchIndex(nextIndex)
    revealSearchMatch(nextMatch)
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
  const focusPdfView = useCallback((): void => {
    const view = scrollRef.current
    view?.focus({ preventScroll: true })
    requestAnimationFrame(() => {
      // A newly opened panel owns focus; a deferred restore must not dismiss it.
      const focused = window.document.activeElement
      if (!focused?.closest('[role="dialog"], [role="menu"], [aria-expanded="true"]'))
        view?.focus({ preventScroll: true })
    })
  }, [])
  const selectEvidence = useCallback(
    (id: string): void => {
      setSelectedBookmarkId(undefined)
      setSelectedEvidenceId(id)
      focusPdfView()
    },
    [focusPdfView]
  )
  const selectBookmark = useCallback(
    (id?: string): void => {
      setSelectedEvidenceId(undefined)
      setSelectedBookmarkId(id)
      if (id) focusPdfView()
    },
    [focusPdfView]
  )
  const finishRegionSelection = useCallback((): void => {
    changeCursorMode('select')
    focusPdfView()
  }, [changeCursorMode, focusPdfView])
  if (hasError) {
    return (
      <PreviewErrorCard
        name={name}
        error={currentDocumentState.error}
        fallbackMessage={t("This PDF couldn't be rendered for preview")}
      />
    )
  }

  const effectiveSelectedEvidenceId = annotationProps?.activeAnnotations?.some(
    (annotation) => annotation.id === selectedEvidenceId
  )
    ? selectedEvidenceId
    : undefined

  return (
    <Tabs.Root
      value={readingMode}
      onValueChange={(value) => {
        setReadingMode(value === 'figures' ? 'figures' : value === 'notes' ? 'notes' : 'original')
        if (value === 'figures') setFiguresVisited(true)
      }}
      asChild
    >
      <div
        className={
          presentation === 'search'
            ? 'flex min-h-64 w-full flex-col'
            : 'flex size-full flex-col overflow-hidden bg-bg-20'
        }
        data-pdf-preview-root
        data-pdf-tool-active={
          readingMode === 'original' &&
          ['area', 'area-annotation', 'text-annotation'].includes(cursorMode)
        }
        onKeyDown={(event) => {
          // Portalled panels remain mounted during exit motion. Let their own
          // dismissal consume Escape before the surrounding PDF tool handles it.
          if (event.target instanceof Node && !event.currentTarget.contains(event.target)) return
          const layer =
            event.target instanceof Element
              ? event.target.closest('[role="dialog"], [role="menu"]')
              : null
          if (layer && !layer.contains(event.currentTarget)) return
          if (
            event.key === 'Escape' &&
            !event.nativeEvent.isComposing &&
            (cursorMode === 'area' ||
              cursorMode === 'area-annotation' ||
              cursorMode === 'text-annotation')
          ) {
            event.preventDefault()
            event.stopPropagation()
            changeCursorMode('select')
            focusPdfView()
          }
        }}
        onKeyDownCapture={(event) => {
          if (presentation === 'search' || readingMode !== 'original') return
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
            (effectiveSelectedEvidenceId || (selectedBookmarkId && pdfBookmarkSource)) &&
            !isEditableTarget(event.target)
          ) {
            if (effectiveSelectedEvidenceId) {
              annotationProps?.onRemoveAnnotation?.(effectiveSelectedEvidenceId)
              setSelectedEvidenceId(undefined)
            } else if (selectedBookmarkId && pdfBookmarkSource) {
              void pdfAnnotations
                .remove(selectedBookmarkId)
                .then(() => setSelectedBookmarkId(undefined))
                .catch(() => setHistoryError(true))
            }
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
          if (
            pdfBookmarkSource &&
            !effectiveSelectedEvidenceId &&
            handlePdfAnnotationHistoryKey(event, pdfAnnotations, pdfBookmarkSource, () =>
              setHistoryError(true)
            )
          )
            return
          const handled = isRedo
            ? annotationProps?.onRedoAnnotation?.()
            : annotationProps?.onUndoAnnotation?.()
          if (handled) {
            event.preventDefault()
            event.stopPropagation()
          }
        }}
      >
        {pdfExport.busy || pdfExport.message ? (
          <div
            role="status"
            className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground"
          >
            <span>
              {pdfExport.saving
                ? t('Saving...')
                : pdfExport.busy
                  ? t('Preparing annotated PDF…')
                  : pdfExport.message}
            </span>
            {pdfExport.busy && !pdfExport.saving ? (
              <Button size="sm" variant="ghost" onClick={pdfExport.cancel}>
                {t('Cancel')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {historyError ? (
          <p role="alert" className="shrink-0 px-3 py-1 text-xs text-destructive">
            {t('Annotation history could not be applied. Reload annotations and try again.')}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                pdfAnnotations.retryLoad()
                setHistoryError(false)
              }}
            >
              {t('Reload')}
            </Button>
          </p>
        ) : null}
        {pdfBookmarkSourceUnavailable ? (
          <p role="status" className="shrink-0 px-3 py-1 text-xs text-status-warning-foreground">
            {t('PDF annotations are unavailable for this source.')}
          </p>
        ) : null}
        {nativeImportProgress ? (
          <div
            role="status"
            className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-1.5 text-xs text-muted-foreground"
          >
            <div className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                {nativeImportProgress.phase === 'parsing' ||
                nativeImportProgress.phase === 'saving' ? (
                  <LoaderCircle
                    className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : null}
                <span>
                  {nativeImportProgress.phase === 'saving'
                    ? t('Saving imported annotations…')
                    : nativeImportProgress.phase === 'completed'
                      ? t('Imported {{count}} native annotations.', {
                          count: nativeImportProgress.importedCount
                        })
                      : nativeImportProgress.phase === 'cancelled'
                        ? t('Native annotation import cancelled.')
                        : nativeImportProgress.phase === 'failed'
                          ? t('Native annotation import failed.')
                          : t('Importing native annotations…')}{' '}
                  {nativeImportProgress.pageCount > 0 &&
                  ['parsing', 'saving'].includes(nativeImportProgress.phase)
                    ? t('{{processed}} / {{total}} pages', {
                        processed: nativeImportProgress.pagesProcessed,
                        total: nativeImportProgress.pageCount
                      })
                    : null}
                  {nativeImportProgress.truncated
                    ? ` · ${t('Native annotation import limit reached. Some annotations were not imported.')}`
                    : null}
                  {nativeImportProgress.unsupportedCount > 0
                    ? ` · ${t('Unsupported native annotations: {{count}}', {
                        count: nativeImportProgress.unsupportedCount
                      })}`
                    : null}
                </span>
              </span>
              {nativeImportProgress.pageCount > 0 &&
              ['parsing', 'saving'].includes(nativeImportProgress.phase) ? (
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out motion-reduce:transition-none"
                    style={{
                      width: `${Math.min(100, Math.max(0, (nativeImportProgress.pagesProcessed / nativeImportProgress.pageCount) * 100))}%`
                    }}
                  />
                </div>
              ) : null}
            </div>
            {nativeImportProgress.phase === 'parsing' && onCancelNativeImport ? (
              <Button size="sm" variant="ghost" onClick={onCancelNativeImport}>
                {t('Cancel')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {hasReadingTabs ? (
          <TooltipProvider>
            <Tabs.List
              aria-label={t('PDF reading mode')}
              className="relative flex h-8 min-w-0 shrink-0 justify-center gap-2 border-b border-border bg-bg-000 px-10"
            >
              {document && readingMode === 'original' && (pageCount > 1 || attachmentVersionId) ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant={outlineOpen ? 'secondary' : 'ghost'}
                      size="icon-sm"
                      className="absolute left-2 top-0.5 size-7"
                      aria-label={outlineOpen ? t('Hide navigation') : t('Show navigation')}
                      aria-controls="pdf-navigation-sidebar"
                      aria-expanded={outlineOpen}
                      onClick={() => setOutlineOpen((open) => !open)}
                    >
                      <PanelLeft className="size-4" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {outlineOpen ? t('Hide navigation') : t('Show navigation')}
                  </TooltipContent>
                </Tooltip>
              ) : null}
              <Tooltip>
                <Tabs.Trigger
                  value="original"
                  className="flex h-full min-w-0 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-1 text-sm text-muted-foreground data-[state=active]:border-primary data-[state=active]:font-semibold data-[state=active]:text-primary focus-visible:outline-ring"
                  asChild
                >
                  <TooltipTrigger>
                    <FileText className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="truncate">{t('Original PDF')}</span>
                  </TooltipTrigger>
                </Tabs.Trigger>
                <PdfToolbarTooltip plain side="bottom" label={t('Original PDF')} />
              </Tooltip>
              {attachmentVersionId ? (
                <Tooltip>
                  <Tabs.Trigger
                    value="figures"
                    className="flex h-full min-w-0 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-1 text-sm text-muted-foreground data-[state=active]:border-primary data-[state=active]:font-semibold data-[state=active]:text-primary focus-visible:outline-ring"
                    asChild
                  >
                    <TooltipTrigger>
                      <Images className="size-3.5 shrink-0" aria-hidden="true" />
                      <span className="truncate">{t('Figures & Tables')}</span>
                      {figuresBusy ? (
                        <span
                          className="shrink-0"
                          role="status"
                          aria-label={t('Analyzing PDF…')}
                          title={t('Analyzing PDF…')}
                        >
                          <LoaderCircle
                            className="size-3.5 animate-spin text-primary motion-reduce:animate-none"
                            aria-hidden="true"
                          />
                        </span>
                      ) : null}
                    </TooltipTrigger>
                  </Tabs.Trigger>
                  <PdfToolbarTooltip plain side="bottom" label={t('Figures & Tables')} />
                </Tooltip>
              ) : null}
              <Tooltip>
                <Tabs.Trigger
                  value="notes"
                  ref={notesTabRef}
                  aria-controls={notebookPanelId}
                  className="flex h-full min-w-0 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-1 text-sm text-muted-foreground data-[state=active]:border-primary data-[state=active]:font-semibold data-[state=active]:text-primary focus-visible:outline-ring"
                  asChild
                >
                  <TooltipTrigger>
                    <NotebookPen className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="truncate">{t('Notes & Annotations')}</span>
                  </TooltipTrigger>
                </Tabs.Trigger>
                <PdfToolbarTooltip plain side="bottom" label={t('Notes & Annotations')} />
              </Tooltip>
              {readingMode === 'original' ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant={showNotesSidebar ? 'secondary' : 'ghost'}
                      size="icon-sm"
                      className="absolute right-2 top-0.5 size-7 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                      aria-label={
                        showNotesSidebar ? t('Hide notes sidebar') : t('Show notes sidebar')
                      }
                      ref={notesToggleRef}
                      aria-expanded={showNotesSidebar}
                      aria-controls={notebookPanelId}
                      aria-disabled={!canShowNotesSidebar}
                      onClick={() => {
                        if (canShowNotesSidebar) setNotesOpen((open) => !open)
                      }}
                    >
                      <PanelRight className="size-4" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {!canShowNotesSidebar
                      ? t('Widen the window to show notes beside the PDF')
                      : showNotesSidebar
                        ? t('Hide notes sidebar')
                        : t('Show notes sidebar')}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </Tabs.List>
          </TooltipProvider>
        ) : null}
        <div ref={readerRef} className="relative min-h-0 flex-1">
          <Tabs.Content value="original" forceMount asChild>
            <div
              className={cn(
                presentation === 'search' ? 'flex' : 'absolute inset-0 flex',
                readingMode !== 'original' && 'invisible pointer-events-none'
              )}
              inert={readingMode !== 'original'}
              aria-hidden={readingMode !== 'original'}
              data-pdf-original-view
              style={showNotesSidebar ? { right: effectiveNotesWidth } : undefined}
            >
              {document && outlineOpen && (pageCount > 1 || attachmentVersionId) ? (
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
              <div
                className={cn(
                  'relative min-w-0 flex-1',
                  presentation !== 'search' && 'overflow-hidden'
                )}
              >
                {/* The inner element is the real scroller (the outer div holds fixed controls), so it must
            be keyboard-focusable or PageUp/Down, Space, and arrows never reach the PDF. */}
                <div
                  ref={scrollRef}
                  data-pdf-cursor-mode={cursorMode}
                  className={cn(
                    'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50',
                    presentation === 'search' ? 'w-full' : 'size-full overflow-auto p-4',
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
                    event.currentTarget.scrollLeft =
                      gesture.scrollLeft - (event.clientX - gesture.clientX)
                    event.currentTarget.scrollTop =
                      gesture.scrollTop - (event.clientY - gesture.clientY)
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
                        'flex min-w-full flex-col',
                        presentation === 'search' ? 'gap-[17px]' : 'gap-3',
                        viewportWidth > 0 && pageWidth > viewportWidth
                          ? 'items-start'
                          : 'items-center'
                      )}
                    >
                      {Array.from({ length: pageCount }, (_, index) => (
                        // Each page mounts its canvas only inside the viewport overscan window.
                        <PdfPageCanvas
                          nativeAnnotationRevision={nativeAnnotationRevision}
                          key={index + 1}
                          document={document}
                          pageNumber={index + 1}
                          pageWidth={pageWidth}
                          registerDisposer={registerPageDisposer}
                          annotationProps={annotationProps}
                          pdfEvidenceSource={pdfEvidenceSource}
                          pdfBookmarkSource={pdfBookmarkSource}
                          pdfRevealSource={pdfRevealSource}
                          selectedEvidenceId={effectiveSelectedEvidenceId}
                          selectedBookmarkId={selectedBookmarkId}
                          onSelectEvidence={selectEvidence}
                          onSelectBookmark={selectBookmark}
                          onTextLayerRendered={handleTextLayerRendered}
                          quickTextMark={
                            cursorMode === 'text-annotation' ? textMarkStyle : undefined
                          }
                          regionSelectionIntent={
                            cursorMode === 'area'
                              ? 'agent'
                              : cursorMode === 'area-annotation'
                                ? 'annotation'
                                : undefined
                          }
                          onRegionSelected={finishRegionSelection}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
                {document && presentation !== 'search' ? (
                  <>
                    <PdfInteractionControls
                      mode={cursorMode}
                      canSelectArea={canSelectArea}
                      areaAgentUnavailableReason={
                        annotationProps?.onAddAnnotation
                          ? t(
                              'PDF source is unavailable for Agent. Reopen the preview and try again.'
                            )
                          : t('Open this PDF in a conversation to send an area to Agent.')
                      }
                      annotationUnavailableReason={
                        pdfAnnotations.scoped && !pdfAnnotations.available
                          ? t('This session is read-only.')
                          : pdfAnnotations.loading || annotationProps?.annotationVersionPending
                            ? t('Loading annotations…')
                            : t('PDF annotations are unavailable for this source.')
                      }
                      canAnnotateArea={canAnnotateArea}
                      canAnnotateText={canAnnotateText}
                      textMarkStyle={textMarkStyle}
                      onTextMarkStyleChange={setTextMarkStyle}
                      navigationAvailable={
                        !hasReadingTabs && (pageCount > 1 || Boolean(attachmentVersionId))
                      }
                      navigationOpen={outlineOpen}
                      searchOpen={searchOpen}
                      onNavigationToggle={() => setOutlineOpen((open) => !open)}
                      onSearchToggle={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
                      onModeChange={changeCursorMode}
                    >
                      {pdfBookmarkSource ? (
                        <PdfAnnotationHistoryControls
                          source={pdfBookmarkSource}
                          onError={() => setHistoryError(true)}
                        />
                      ) : null}
                    </PdfInteractionControls>
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
          </Tabs.Content>
          {attachmentVersionId && figuresVisited && document ? (
            <Tabs.Content value="figures" forceMount asChild>
              <div
                className={cn(
                  'absolute inset-0',
                  readingMode !== 'figures' && 'invisible pointer-events-none'
                )}
                inert={readingMode !== 'figures'}
                aria-hidden={readingMode !== 'figures'}
                data-pdf-figures-view
              >
                <PdfFiguresView
                  key={requestKey}
                  active={readingMode === 'figures'}
                  attachmentVersionId={attachmentVersionId}
                  pageCount={pageCount}
                  onBusyChange={setFiguresBusy}
                  onNavigate={(page) => {
                    setReadingMode('original')
                    requestAnimationFrame(() => navigateToPage(page))
                  }}
                />
              </div>
            </Tabs.Content>
          ) : null}
          {(attachmentVersionId || pdfBookmarkSource) && presentation !== 'search' ? (
            <Tabs.Content
              value="notes"
              forceMount
              asChild
              role={showNotesSidebar ? 'complementary' : 'tabpanel'}
            >
              <div
                className={cn(
                  'absolute inset-y-0 right-0',
                  showNotesSidebar ? 'border-l border-border bg-bg-000' : 'left-0',
                  readingMode !== 'notes' && !showNotesSidebar && 'invisible pointer-events-none'
                )}
                id={notebookPanelId}
                style={showNotesSidebar ? { width: effectiveNotesWidth } : undefined}
                inert={readingMode !== 'notes' && !showNotesSidebar}
                aria-hidden={readingMode !== 'notes' && !showNotesSidebar}
                aria-label={showNotesSidebar ? t('Notes & Annotations') : undefined}
                data-pdf-notebook-view
                data-pdf-notes-sidebar={showNotesSidebar || undefined}
              >
                <PdfNotebookView
                  key={`${pdfBookmarkSource?.projectId}:${pdfBookmarkSource?.versionId}:${pdfBookmarkSource?.checksum}`}
                  source={pdfBookmarkSource}
                  active={readingMode === 'notes' || showNotesSidebar}
                  sidebar={showNotesSidebar}
                  currentPage={currentPage}
                  selectedId={selectedBookmarkId}
                  onCloseSidebar={() => {
                    setNotesOpen(false)
                    notesToggleRef.current?.focus()
                  }}
                  onExpandNotes={() => {
                    setReadingMode('notes')
                    notesTabRef.current?.focus()
                  }}
                  sourceLoading={pdfAnnotations.loading}
                  onOpenPdf={() => setReadingMode('original')}
                  pageCount={pageCount}
                />
                {showNotesSidebar ? (
                  <button
                    type="button"
                    role="separator"
                    aria-label={t('Resize notes sidebar')}
                    aria-orientation="vertical"
                    aria-valuemin={NOTES_SIDEBAR_MIN_WIDTH}
                    aria-valuemax={maxNotesWidth}
                    aria-valuenow={effectiveNotesWidth}
                    className="group absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                      event.preventDefault()
                      event.stopPropagation()
                      resizeNotes(effectiveNotesWidth + (event.key === 'ArrowLeft' ? 16 : -16))
                    }}
                    onPointerDown={(event) => {
                      if (event.button !== 0 || !event.isPrimary) return
                      event.currentTarget.setPointerCapture(event.pointerId)
                      notesResizeRef.current = {
                        pointerId: event.pointerId,
                        startX: event.clientX,
                        startWidth: effectiveNotesWidth
                      }
                    }}
                    onPointerMove={(event) => {
                      const gesture = notesResizeRef.current
                      if (gesture?.pointerId === event.pointerId)
                        resizeNotes(gesture.startWidth + gesture.startX - event.clientX)
                    }}
                    onPointerUp={(event) => {
                      if (notesResizeRef.current?.pointerId !== event.pointerId) return
                      notesResizeRef.current = undefined
                      if (event.currentTarget.hasPointerCapture(event.pointerId))
                        event.currentTarget.releasePointerCapture(event.pointerId)
                    }}
                    onPointerCancel={() => {
                      notesResizeRef.current = undefined
                    }}
                  >
                    <span className="mx-auto block h-full w-px bg-transparent group-hover:bg-primary/50 group-focus-visible:bg-primary/60" />
                  </button>
                ) : null}
              </div>
            </Tabs.Content>
          ) : null}
        </div>
      </div>
    </Tabs.Root>
  )
}

const PdfPreviewRendererContent = (props: PreviewFileRendererProps): React.JSX.Element => {
  const target = resolvePdfContextTarget(props.item)
  const libraryAnnotations = usePdfAnnotations()
  const isLibrary = target?.sourceKind === 'literature-attachment-version'
  const ownerSessionId = useSessionStore((state) => {
    const session = state.sessions.find(
      (candidate) =>
        candidate.id === state.selectedSessionId &&
        candidate.projectId === props.item.projectId &&
        candidate.archivedAt === undefined
    )
    return session?.id
  })
  const isDraftReadingSource = usePreviewWorkbenchStore((state) =>
    Boolean(
      !ownerSessionId &&
      props.onAddAnnotation &&
      props.item.projectId &&
      props.item.projectId === state.activeProjectId &&
      target &&
      pendingPdfContextSelections(state.pendingPdfContextByProject[props.item.projectId]).some(
        (selection) =>
          selection.kind === 'version' &&
          selection.sourceKind === target.sourceKind &&
          selection.sourceVersionId === target.sourceVersionId
      )
    )
  )
  // Drafts have no Session binding yet. Resolve only their selected immutable Version; the
  // first-send owner still creates the Session and links its PDF context.
  const draftSourceKey =
    isDraftReadingSource && target && props.item.projectId
      ? JSON.stringify([props.item.projectId, target.sourceKind, target.sourceVersionId])
      : undefined
  const [draftSource, setDraftSource] = useState<{
    key: string
    source: PdfAnnotation['source']
  }>()
  const sourceKind = target?.sourceKind
  const sourceFileId = target?.sourceFileId
  const sourceVersionId = target?.sourceVersionId
  const {
    id: draftItemId,
    projectId: draftItemProjectId,
    sessionId: draftItemSessionId,
    title: draftItemTitle,
    source: draftItemSource,
    path: draftItemPath,
    format: draftItemFormat,
    name: draftItemName,
    mimeType: draftItemMimeType,
    size: draftItemSize,
    mtimeMs: draftItemMtimeMs,
    artifactId: draftItemArtifactId,
    managedFileId: draftItemManagedFileId,
    selectedVersionId: draftItemSelectedVersionId,
    versionNumber: draftItemVersionNumber,
    originSession: draftItemOriginSession
  } = props.item
  const draftSourceItem = useMemo(
    () => ({
      id: draftItemId,
      projectId: draftItemProjectId,
      sessionId: draftItemSessionId,
      title: draftItemTitle,
      type: 'file' as const,
      source: draftItemSource,
      path: draftItemPath,
      format: draftItemFormat,
      name: draftItemName,
      mimeType: draftItemMimeType,
      size: draftItemSize,
      mtimeMs: draftItemMtimeMs,
      artifactId: draftItemArtifactId,
      managedFileId: draftItemManagedFileId,
      selectedVersionId: draftItemSelectedVersionId,
      versionNumber: draftItemVersionNumber,
      originSession: draftItemOriginSession
    }),
    [
      draftItemId,
      draftItemProjectId,
      draftItemSessionId,
      draftItemTitle,
      draftItemSource,
      draftItemPath,
      draftItemFormat,
      draftItemName,
      draftItemMimeType,
      draftItemSize,
      draftItemMtimeMs,
      draftItemArtifactId,
      draftItemManagedFileId,
      draftItemSelectedVersionId,
      draftItemVersionNumber,
      draftItemOriginSession
    ]
  )
  useEffect(() => {
    if (!draftSourceKey || isLibrary || !sourceFileId || !sourceVersionId) return
    let active = true
    const item = draftSourceItem
    void window.api.managedFileVersions
      .inspect({
        projectId: item.projectId!,
        source: sourceKind === 'artifact-version' ? 'artifact' : 'upload',
        fileId: sourceFileId,
        versionId: sourceVersionId
      })
      .then((result) => {
        if (!active) return
        if (!result.ok) {
          setDraftSource(undefined)
          return
        }
        const version = result.value.selectedVersion
        if (
          !version ||
          version.id !== sourceVersionId ||
          version.fileId !== sourceFileId ||
          version.source !== (sourceKind === 'artifact-version' ? 'artifact' : 'upload')
        )
          return
        const resolved = createPreviewFileItemForManagedVersion({
          item,
          version,
          projectId: item.projectId!,
          sessionId: result.value.sessionId
        })
        setDraftSource({
          key: draftSourceKey,
          source: {
            kind: version.source === 'artifact' ? 'artifact-version' : 'upload-version',
            projectId: item.projectId!,
            sessionId: result.value.sessionId,
            versionId: version.id,
            name: resolved.name,
            path: resolved.path,
            checksum: version.checksum
          }
        })
      })
      .catch(() => {
        // Unavailable versions keep the existing disabled action and reason tooltip.
        if (active) setDraftSource(undefined)
      })
    return () => {
      active = false
    }
  }, [draftSourceKey, draftSourceItem, isLibrary, sourceFileId, sourceVersionId, sourceKind])
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
  const draftEvidenceSource =
    draftSourceKey &&
    isLibrary &&
    libraryAnnotations.source &&
    libraryAnnotations.source.kind === sourceKind &&
    libraryAnnotations.source.versionId === sourceVersionId
      ? { ...libraryAnnotations.source, projectId: props.item.projectId! }
      : draftSourceKey && draftSource?.key === draftSourceKey
        ? draftSource.source
        : undefined
  const candidateSource: PdfAnnotation['source'] | undefined =
    binding && props.item.projectId
      ? {
          kind: binding.sourceKind,
          projectId: props.item.projectId,
          ...(binding.sourceSessionId ? { sessionId: binding.sourceSessionId } : {}),
          versionId: binding.sourceVersionId,
          name: binding.name,
          path: props.item.path,
          checksum: binding.checksum
        }
      : draftEvidenceSource
  const pdfEvidenceSource =
    candidateSource &&
    /^[a-f0-9]{64}$/u.test(candidateSource.checksum) &&
    pdfAnnotationSourceIsFixed(candidateSource)
      ? candidateSource
      : undefined
  const bookmarkSourceKind = target?.sourceKind
  const bookmarkSourceFileId = target?.sourceFileId
  const bookmarkSourceVersionId = target?.sourceVersionId
  const pdfBookmarkResolutionKey =
    !isLibrary &&
    bookmarkSourceKind &&
    bookmarkSourceFileId &&
    bookmarkSourceVersionId &&
    props.item.projectId &&
    ownerSessionId
      ? JSON.stringify({
          projectId: props.item.projectId,
          sessionId: ownerSessionId,
          sourceKind: bookmarkSourceKind,
          sourceFileId: bookmarkSourceFileId,
          versionId: bookmarkSourceVersionId
        })
      : undefined
  const [pdfBookmarkResolution, setPdfBookmarkResolution] = useState<
    Readonly<{
      key: string
      source?: PdfAnnotationSource
      unavailable: boolean
    }>
  >()
  useEffect(() => {
    let active = true
    if (
      !pdfBookmarkResolutionKey ||
      !props.item.projectId ||
      !ownerSessionId ||
      !bookmarkSourceKind ||
      !bookmarkSourceFileId ||
      !bookmarkSourceVersionId
    ) {
      return () => undefined
    }
    void window.api.bookmarks
      .resolvePdfSource({
        projectId: props.item.projectId,
        sessionId: ownerSessionId,
        sourceKind: bookmarkSourceKind,
        sourceFileId: bookmarkSourceFileId,
        versionId: bookmarkSourceVersionId
      })
      .then((result) => {
        if (!active) return
        setPdfBookmarkResolution({
          key: pdfBookmarkResolutionKey,
          ...(result.ok ? { source: result.source } : {}),
          unavailable: !result.ok
        })
      })
      .catch(() => {
        if (active) {
          setPdfBookmarkResolution({ key: pdfBookmarkResolutionKey, unavailable: true })
        }
      })
    return () => {
      active = false
    }
  }, [
    bookmarkSourceFileId,
    bookmarkSourceKind,
    bookmarkSourceVersionId,
    ownerSessionId,
    pdfBookmarkResolutionKey,
    props.item.projectId
  ])
  const currentPdfBookmarkResolution =
    pdfBookmarkResolution?.key === pdfBookmarkResolutionKey ? pdfBookmarkResolution : undefined
  const pdfBookmarkSource = isLibrary
    ? libraryAnnotations.source
    : (currentPdfBookmarkResolution?.source ?? libraryAnnotations.source)
  const pdfBookmarkSourceUnavailable = isLibrary
    ? Boolean(libraryAnnotations.loadError)
    : (currentPdfBookmarkResolution?.unavailable ??
      Boolean(target && props.item.projectId && ownerSessionId && !pdfBookmarkResolutionKey))
  const [nativeImportProgress, setNativeImportProgress] =
    useState<PdfNativeAnnotationImportProgress>()
  const nativeSourceKind = pdfBookmarkSource?.kind
  const nativeSourceFileId = pdfBookmarkSource?.sourceFileId
  const nativeSourceVersionId = pdfBookmarkSource?.versionId
  useEffect(() => {
    if (
      isLibrary ||
      !nativeSourceFileId ||
      !nativeSourceVersionId ||
      !props.item.projectId ||
      !ownerSessionId ||
      (nativeSourceKind !== 'artifact-version' && nativeSourceKind !== 'upload-version')
    ) {
      return () => undefined
    }
    return window.api.pdfAnnotations?.onImportProgress?.((progress) => {
      const source = progress.source
      if (
        source &&
        source.projectId === props.item.projectId &&
        source.sessionId === ownerSessionId &&
        source.sourceKind === nativeSourceKind &&
        source.sourceFileId === nativeSourceFileId &&
        source.versionId === nativeSourceVersionId
      )
        setNativeImportProgress(progress)
    })
  }, [
    isLibrary,
    ownerSessionId,
    nativeSourceKind,
    nativeSourceFileId,
    nativeSourceVersionId,
    props.item.projectId
  ])
  useEffect(
    () =>
      subscribeBookmarkReveal((revealTarget) => {
        if (
          !pdfBookmarkSourceUnavailable ||
          revealTarget.kind !== 'pdf' ||
          revealTarget.source.projectId !== props.item.projectId ||
          revealTarget.source.kind !== bookmarkSourceKind ||
          revealTarget.source.sourceFileId !== bookmarkSourceFileId ||
          revealTarget.source.versionId !== bookmarkSourceVersionId
        ) {
          return
        }
        return 'source-unavailable'
      }),
    [
      bookmarkSourceFileId,
      bookmarkSourceKind,
      bookmarkSourceVersionId,
      pdfBookmarkSourceUnavailable,
      props.item.projectId
    ]
  )
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
      presentation={props.presentation}
      path={props.item.path}
      name={props.item.name}
      source={props.item.source ?? 'artifact'}
      projectId={props.item.projectId}
      sessionId={props.item.sessionId}
      managedFileId={props.item.managedFileId}
      selectedVersionId={props.item.selectedVersionId}
      mimeType={props.item.mimeType}
      size={props.item.size}
      mtimeMs={props.item.mtimeMs}
      onReadingPositionChange={props.onPdfReadingPositionChange}
      annotationProps={props}
      pdfEvidenceSource={pdfEvidenceSource}
      pdfBookmarkSource={pdfBookmarkSource}
      pdfBookmarkSourceUnavailable={pdfBookmarkSourceUnavailable}
      pdfRevealSource={pdfRevealSource}
      nativeImportProgress={
        !isLibrary &&
        nativeImportProgress?.source?.versionId === nativeSourceVersionId &&
        nativeImportProgress?.source?.sessionId === ownerSessionId
          ? nativeImportProgress
          : undefined
      }
      onCancelNativeImport={
        nativeImportProgress && ['parsing', 'saving'].includes(nativeImportProgress.phase)
          ? () => {
              void window.api.pdfAnnotations.cancelImport({
                operationId: nativeImportProgress.operationId
              })
            }
          : undefined
      }
    />
  )
}

export const PdfPreviewRenderer = (props: PreviewFileRendererProps): React.JSX.Element => {
  const parentAnnotations = usePdfAnnotations()
  const target = resolvePdfContextTarget(props.item)
  if (!target || parentAnnotations.document?.versionId === target.sourceVersionId)
    return <PdfPreviewRendererContent {...props} />
  const library = target.sourceKind === 'literature-attachment-version'
  return (
    <PdfAnnotationsProvider
      literatureVersionId={library ? target.sourceVersionId : undefined}
      projectId={library ? undefined : props.item.projectId}
      sessionId={library ? undefined : parentAnnotations.sessionId}
      sourceFileId={target.sourceFileId}
      versionId={target.sourceVersionId}
      writable={!parentAnnotations.scoped || parentAnnotations.available}
    >
      <PdfPreviewRendererContent {...props} />
    </PdfAnnotationsProvider>
  )
}
