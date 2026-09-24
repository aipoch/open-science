import { ChevronDown, ChevronUp } from 'lucide-react'
import {
  useCallback,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode
} from 'react'

const PANEL_MIN_HEIGHT_PX = 288
const PANEL_MAX_HEIGHT_PX = 704
const PANEL_MAX_VIEWPORT_RATIO = 0.7
const PANEL_RESIZE_STEP_PX = 32

type ResizeBounds = { min: number; max: number }
type DragState = {
  pointerId: number
  startHeight: number
  startX: number
  startY: number
  moved: boolean
}

type ResizableBottomPanelProps = Readonly<{
  children: ReactNode
  ariaLabel: string
  testId: string
  scrollTestId: string
  variant?: 'floating' | 'integrated'
  constrainGrowthToOverflow?: boolean
  minimumContentSelector?: string
  minimumContentIndex?: number
  collapseControl?: Readonly<{ label: string; onToggle: () => void }>
  collapsed?: boolean
}>

const ResizableBottomPanel = ({
  children,
  ariaLabel,
  testId,
  scrollTestId,
  variant = 'floating',
  constrainGrowthToOverflow = false,
  minimumContentSelector,
  minimumContentIndex = 0,
  collapsed = false,
  collapseControl
}: ResizableBottomPanelProps): React.JSX.Element => {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const dragStateRef = useRef<DragState | undefined>(undefined)
  const suppressClickRef = useRef(false)
  const [height, setHeight] = useState<number>()
  const observerRef = useRef<ResizeObserver | undefined>(undefined)
  const observedTargetsRef = useRef(new Set<Element>())
  const panelId = useId()
  const [size, setSize] = useState({ now: 0, min: 0, max: 0 })

  const resizeBounds = useCallback((): ResizeBounds => {
    const viewportMax = Math.round(
      Math.min(window.innerHeight * PANEL_MAX_VIEWPORT_RATIO, PANEL_MAX_HEIGHT_PX)
    )
    const surfaceHeight = surfaceRef.current?.getBoundingClientRect().height ?? 0
    const scrollSurface = surfaceRef.current?.querySelector<HTMLElement>(
      `[data-testid="${scrollTestId}"]`
    )
    const minimumContent = minimumContentSelector
      ? surfaceRef.current?.querySelectorAll<HTMLElement>(minimumContentSelector)[
          minimumContentIndex
        ]
      : undefined
    const measuredMinimum =
      scrollSurface && minimumContent
        ? Math.ceil(
            minimumContent.getBoundingClientRect().bottom -
              scrollSurface.getBoundingClientRect().top +
              PANEL_RESIZE_STEP_PX
          )
        : 0
    const contentMax =
      constrainGrowthToOverflow && scrollSurface && surfaceHeight > 0
        ? Math.ceil(
            surfaceHeight + Math.max(0, scrollSurface.scrollHeight - scrollSurface.clientHeight)
          )
        : viewportMax
    const max = Math.min(viewportMax, contentMax)
    const defaultMin = Math.min(viewportMax, Math.max(PANEL_MIN_HEIGHT_PX, measuredMinimum))
    const min =
      constrainGrowthToOverflow && surfaceHeight > 0 ? Math.min(defaultMin, max) : defaultMin
    return {
      min,
      max
    }
  }, [scrollTestId, constrainGrowthToOverflow, minimumContentSelector, minimumContentIndex])

  const measure = useCallback((): void => {
    const surface = surfaceRef.current
    if (!surface) return
    const bounds = resizeBounds()
    const actual = Math.round(surface.getBoundingClientRect().height)
    // Natural content may be shorter than the preferred drag minimum.
    const next = {
      now: actual,
      min: Math.min(bounds.min, actual),
      max: Math.max(bounds.max, actual)
    }
    setSize((current) =>
      current.now === next.now && current.min === next.min && current.max === next.max
        ? current
        : next
    )
    if (!collapsed && height !== undefined && height > bounds.max) setHeight(bounds.max)
  }, [collapsed, height, resizeBounds])
  const measureObservedResize = useEffectEvent(measure)

  useLayoutEffect(() => {
    const update = (): void => measureObservedResize()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    observerRef.current = observer
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      observerRef.current = undefined
      observedTargetsRef.current.clear()
      window.removeEventListener('resize', update)
    }
  }, [])

  useLayoutEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const scroll = surface.querySelector<HTMLElement>(`[data-testid="${scrollTestId}"]`)
    const targets = new Set<Element>([surface, ...(scroll ? [scroll, ...scroll.children] : [])])
    // React children change during streaming; only actual DOM replacements need re-observing.
    for (const target of observedTargetsRef.current) {
      if (!targets.has(target)) observerRef.current?.unobserve(target)
    }
    for (const target of targets) {
      if (!observedTargetsRef.current.has(target)) observerRef.current?.observe(target)
    }
    observedTargetsRef.current = targets
    measure()
  }, [measure, scrollTestId, children])

  const resizeTo = (nextHeight: number): void => {
    const bounds = resizeBounds()
    setHeight(Math.min(bounds.max, Math.max(bounds.min, Math.round(nextHeight))))
  }

  const handlePointerDown = (event: PointerEvent<HTMLElement>): void => {
    suppressClickRef.current = false
    if (
      collapsed ||
      !surfaceRef.current ||
      event.isPrimary === false ||
      (event.button !== 0 && event.pointerType === 'mouse')
    ) {
      return
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragStateRef.current = {
      pointerId: event.pointerId,
      startHeight: surfaceRef.current.getBoundingClientRect().height,
      startX: event.clientX,
      startY: event.clientY,
      moved: false
    }
  }

  const handlePointerMove = (event: PointerEvent<HTMLElement>): void => {
    const dragState = dragStateRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) return
    if (Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY) >= 4) {
      dragState.moved = true
      suppressClickRef.current = true
    }
    if (collapseControl && !dragState.moved) return
    resizeTo(dragState.startHeight - (event.clientY - dragState.startY))
  }

  const endPointerDrag = (event: PointerEvent<HTMLElement>): void => {
    if (dragStateRef.current?.pointerId !== event.pointerId) return
    if (event.type === 'pointercancel' || event.type === 'lostpointercapture') {
      suppressClickRef.current = true
    }
    dragStateRef.current = undefined
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (collapsed) return
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const currentHeight = surfaceRef.current?.getBoundingClientRect().height
    if (!currentHeight) return
    resizeTo(
      currentHeight + (event.key === 'ArrowUp' ? PANEL_RESIZE_STEP_PX : -PANEL_RESIZE_STEP_PX)
    )
  }

  const resizeHandle = !collapsed ? (
    <div
      role="separator"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      aria-valuenow={size.now}
      aria-valuetext={`${size.now}px`}
      aria-valuemin={size.min}
      aria-valuemax={size.max}
      aria-controls={panelId}
      className={`group z-20 grid cursor-ns-resize touch-none select-none place-items-center focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
        variant === 'integrated'
          ? 'absolute top-0 left-1/2 h-8 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-b from-bg-10/0 to-bg-000/95 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-28'
          : 'absolute top-0 inset-x-0 h-8 rounded-lg [@media(pointer:coarse)]:h-11'
      }`}
      onKeyDown={handleResizeKeyDown}
      onLostPointerCapture={endPointerDrag}
      onPointerCancel={endPointerDrag}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPointerDrag}
    >
      <span
        aria-hidden="true"
        className="relative z-10 h-1 w-12 rounded-full bg-text-300/70 transition-colors duration-200 group-hover:bg-text-100 group-focus-visible:bg-text-100 group-active:bg-text-000"
      />
    </div>
  ) : null

  return (
    <div
      ref={surfaceRef}
      className={`relative z-10 flex min-h-0 w-full min-w-0 max-h-[min(70dvh,44rem)] flex-col overflow-visible px-px pb-px ${
        collapsed && !collapseControl
          ? 'pt-0'
          : variant === 'integrated'
            ? 'h-[min(70dvh,44rem)] pt-0'
            : 'pt-8 [@media(pointer:coarse)]:pt-11'
      }`}
      data-testid={testId}
      style={collapsed || height === undefined ? undefined : { height }}
    >
      {collapseControl ? (
        <button
          type="button"
          aria-label={collapseControl.label}
          title={collapseControl.label}
          aria-expanded={!collapsed}
          aria-controls={panelId}
          onClick={(event) => {
            const suppress = suppressClickRef.current && event.detail !== 0
            suppressClickRef.current = false
            if (!suppress) collapseControl.onToggle()
          }}
          onKeyDown={handleResizeKeyDown}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endPointerDrag}
          onPointerCancel={endPointerDrag}
          onLostPointerCapture={endPointerDrag}
          className="group absolute left-1/2 top-0 z-20 grid h-8 w-20 -translate-x-1/2 cursor-pointer touch-none select-none place-items-center rounded-full text-text-300 transition-colors hover:text-text-100 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:cursor-ns-resize [@media(pointer:coarse)]:h-11"
        >
          {collapsed ? (
            <ChevronUp className="size-4" aria-hidden="true" />
          ) : (
            <>
              <span
                aria-hidden="true"
                className="col-start-1 row-start-1 h-1 w-12 rounded-full bg-text-300/70 group-hover:opacity-0 group-focus-visible:opacity-0"
              />
              <ChevronDown
                aria-hidden="true"
                className="col-start-1 row-start-1 size-4 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
              />
            </>
          )}
        </button>
      ) : (
        resizeHandle
      )}
      <div
        id={panelId}
        className={`min-h-0 flex-1 overscroll-contain rounded-2xl border border-border-200 bg-bg-000 ${
          variant === 'integrated' ? 'overflow-hidden shadow-none' : 'overflow-y-auto shadow-sm'
        }`}
        data-testid={scrollTestId}
      >
        {children}
      </div>
    </div>
  )
}

export { ResizableBottomPanel }
