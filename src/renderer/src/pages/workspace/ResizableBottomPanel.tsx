import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'

const PANEL_MIN_HEIGHT_PX = 288
const PANEL_MAX_HEIGHT_PX = 704
const PANEL_MAX_VIEWPORT_RATIO = 0.7
const PANEL_RESIZE_STEP_PX = 32

type ResizeBounds = { min: number; max: number }
type DragState = { pointerId: number; startHeight: number; startY: number }

type ResizableBottomPanelProps = Readonly<{
  children: ReactNode
  ariaLabel: string
  testId: string
  scrollTestId: string
  variant?: 'floating' | 'integrated'
  constrainGrowthToOverflow?: boolean
  minimumContentSelector?: string
  minimumContentIndex?: number
}>

const ResizableBottomPanel = ({
  children,
  ariaLabel,
  testId,
  scrollTestId,
  variant = 'floating',
  constrainGrowthToOverflow = false,
  minimumContentSelector,
  minimumContentIndex = 0
}: ResizableBottomPanelProps): React.JSX.Element => {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const dragStateRef = useRef<DragState | undefined>(undefined)
  const [height, setHeight] = useState<number>()

  const resizeBounds = (): ResizeBounds => {
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
  }

  const resizeTo = (nextHeight: number): void => {
    const bounds = resizeBounds()
    setHeight(Math.min(bounds.max, Math.max(bounds.min, Math.round(nextHeight))))
  }

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    if (
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
      startY: event.clientY
    }
  }

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>): void => {
    const dragState = dragStateRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) return
    resizeTo(dragState.startHeight - (event.clientY - dragState.startY))
  }

  const endPointerDrag = (event: PointerEvent<HTMLButtonElement>): void => {
    if (dragStateRef.current?.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    dragStateRef.current = undefined
  }

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const currentHeight = surfaceRef.current?.getBoundingClientRect().height
    if (!currentHeight) return
    resizeTo(
      currentHeight + (event.key === 'ArrowUp' ? PANEL_RESIZE_STEP_PX : -PANEL_RESIZE_STEP_PX)
    )
  }

  return (
    <div
      ref={surfaceRef}
      className={`relative z-10 flex min-h-0 w-full min-w-0 max-h-[min(70dvh,44rem)] flex-col overflow-visible px-px pb-px ${
        variant === 'integrated'
          ? 'h-[min(70dvh,44rem)] pt-0'
          : 'pt-8 [@media(pointer:coarse)]:pt-11'
      }`}
      data-testid={testId}
      style={height === undefined ? undefined : { height }}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        className={`group absolute top-0 z-20 grid cursor-ns-resize touch-none select-none place-items-center focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
          variant === 'integrated'
            ? 'left-1/2 h-8 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-b from-bg-10/0 to-bg-000/95 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-28'
            : 'inset-x-0 h-8 rounded-lg [@media(pointer:coarse)]:h-11'
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
      </button>
      <div
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
