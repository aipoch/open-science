import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import type { ImageEditRegion } from '../../../../../shared/image-edit-contract'
import {
  IMAGE_EDIT_LASSO_POINT_LIMIT,
  imageEditRegionSchema
} from '../../../../../shared/image-edit-contract'
import {
  fitContainedImageRect,
  viewportPointToNormalized,
  type ImageAnnotationPoint as Point
} from '../annotations/image-annotation-geometry'
import type { ImageEditorTool } from './image-editor-state'

type Geometry = ImageEditRegion['geometry']
function appendLassoPoint(points: Point[], point: Point): void {
  const last = points.at(-1)
  if (last?.x === point.x && last.y === point.y) return
  points.push(point)
  if (points.length <= IMAGE_EDIT_LASSO_POINT_LIMIT) return

  // Keep both ends and drop the interior point whose neighbors form the smallest triangle.
  let smallest = Infinity
  let remove = 1
  for (let index = 1; index < points.length - 1; index++) {
    const a = points[index - 1]
    const b = points[index]
    const c = points[index + 1]
    const area = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))
    if (area < smallest) {
      smallest = area
      remove = index
    }
  }
  points.splice(remove, 1)
}

function geometryFor(tool: ImageEditorTool, points: Point[]): Geometry | undefined {
  const start = points[0],
    end = points.at(-1)
  if (!start || !end || tool === 'pan') return undefined
  if (tool === 'point') return { kind: 'point', point: start }
  if (tool === 'polygon') return points.length >= 3 ? { kind: 'polygon', points } : undefined
  if (tool === 'arrow') return { kind: 'arrow', start, end }
  return {
    kind: 'rectangle',
    start: { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y) },
    end: { x: Math.max(start.x, end.x), y: Math.max(start.y, end.y) }
  }
}

export function ImageEditCanvas({
  url,
  name,
  naturalSize,
  regions,
  popupBoundary,
  instructionEditor,
  tool,
  selected,
  locked,
  onAdd,
  onCloseInstruction,
  onSelect,
  onError,
  busyLabel
}: {
  url: string
  name: string
  naturalSize: { width: number; height: number }
  regions: ImageEditRegion[]
  popupBoundary?: Element
  instructionEditor?: ReactNode
  tool: ImageEditorTool
  selected?: string
  locked: boolean
  onAdd(geometry: Geometry): void
  onCloseInstruction(): void
  onSelect(id: string): void
  onError(): void
  busyLabel?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const markerId = useId()
  const surface = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 1, height: 1 })
  const [points, setPoints] = useState<Point[]>([])
  const [cursor, setCursor] = useState<Point>({ x: 0.5, y: 0.5 })
  const [keyboard, setKeyboard] = useState(false)
  const activeTool = locked ? 'pan' : tool
  const [gestureTool, setGestureTool] = useState(activeTool)
  const drawing = useRef<{ pointerId: number; points: Point[] } | undefined>(undefined)
  if (gestureTool !== activeTool) {
    setGestureTool(activeTool)
    setPoints([])
    setKeyboard(false)
  }
  useLayoutEffect(() => {
    drawing.current = undefined
  }, [activeTool])
  useEffect(() => {
    const node = surface.current
    if (!node) return
    const observer = new ResizeObserver(() =>
      setSize({ width: node.clientWidth, height: node.clientHeight })
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const rect = fitContainedImageRect({ left: 0, top: 0, ...size }, naturalSize)
  const pointAt = (x: number, y: number): Point | undefined => {
    if (!surface.current) return undefined
    const fit = fitContainedImageRect(surface.current.getBoundingClientRect(), naturalSize)
    return fit ? viewportPointToNormalized({ x, y }, fit) : undefined
  }
  const finish = (path: Point[]): void => {
    const geometry = geometryFor(tool, path)
    if (
      geometry &&
      imageEditRegionSchema.safeParse({ id: 'draft', number: 1, instruction: 'draft', geometry })
        .success
    )
      onAdd(geometry)
    drawing.current = undefined
    setPoints([])
  }
  const preview = geometryFor(tool, points)
  const shapes = [
    ...regions.map((region) => ({ ...region, draft: false })),
    ...(preview
      ? [{ id: 'draft', number: 0, instruction: '', geometry: preview, draft: true }]
      : [])
  ]
  const renderShape = (geometry: Geometry): React.JSX.Element => {
    const xy = (p: Point): string => `${p.x * 1000},${p.y * 1000}`
    if (geometry.kind === 'point') return <g />
    if (geometry.kind === 'polygon') return <polygon points={geometry.points.map(xy).join(' ')} />
    if (geometry.kind === 'rectangle')
      return (
        <rect
          x={geometry.start.x * 1000}
          y={geometry.start.y * 1000}
          width={(geometry.end.x - geometry.start.x) * 1000}
          height={(geometry.end.y - geometry.start.y) * 1000}
        />
      )
    return (
      <path d={`M ${xy(geometry.start)} L ${xy(geometry.end)}`} markerEnd={`url(#${markerId})`} />
    )
  }
  return (
    <div
      ref={surface}
      className="relative size-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      tabIndex={locked ? -1 : 0}
      role="group"
      aria-label={t('Image editing canvas')}
      data-preview-escape-boundary={points.length > 0 || undefined}
      onKeyDown={(event) => {
        if (
          activeTool === 'pan' ||
          event.target !== event.currentTarget ||
          event.nativeEvent.isComposing
        )
          return
        if (event.key === 'Escape' && points.length > 0) {
          event.preventDefault()
          event.stopPropagation()
          drawing.current = undefined
          setPoints([])
          return
        }
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
          event.preventDefault()
          setKeyboard(true)
          const step = event.shiftKey ? 0.1 : 0.01
          setCursor((p) => ({
            x: Math.max(
              0,
              Math.min(
                1,
                p.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0)
              )
            ),
            y: Math.max(
              0,
              Math.min(
                1,
                p.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0)
              )
            )
          }))
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          if (drawing.current) return
          setKeyboard(true)
          const path = [...points]
          if (tool === 'polygon') appendLassoPoint(path, cursor)
          else path.push(cursor)
          if (
            tool === 'point' ||
            (tool === 'polygon' ? event.key === 'Enter' && path.length >= 3 : path.length >= 2)
          )
            finish(path)
          else setPoints(path)
        }
      }}
      onPointerDown={(event) => {
        if (
          activeTool === 'pan' ||
          !event.isPrimary ||
          event.button !== 0 ||
          (event.target instanceof Element && event.target.closest('button'))
        )
          return
        const point = pointAt(event.clientX, event.clientY)
        if (!point) return
        event.stopPropagation()
        event.preventDefault()
        event.currentTarget.focus()
        event.currentTarget.setPointerCapture(event.pointerId)
        setKeyboard(false)
        drawing.current = { pointerId: event.pointerId, points: [point] }
        setPoints([point])
      }}
      onPointerMove={(event) => {
        const gesture = drawing.current
        if (!gesture || gesture.pointerId !== event.pointerId) return
        const point = pointAt(event.clientX, event.clientY)
        if (!point) return
        const path = gesture.points
        if (tool === 'polygon') {
          const last = path.at(-1)!
          if (Math.hypot(last.x - point.x, last.y - point.y) > 0.004) appendLassoPoint(path, point)
        } else gesture.points = [path[0], point]
        setPoints([...gesture.points])
      }}
      onPointerUp={(event) => {
        const gesture = drawing.current
        if (gesture?.pointerId === event.pointerId) {
          const end = pointAt(event.clientX, event.clientY)
          if (end && tool === 'polygon') appendLassoPoint(gesture.points, end)
          else if (end && (tool === 'rectangle' || tool === 'arrow'))
            gesture.points = [gesture.points[0], end]
          finish(gesture.points)
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
      onLostPointerCapture={(event) => {
        if (drawing.current?.pointerId !== event.pointerId) return
        drawing.current = undefined
        setPoints([])
      }}
    >
      <img
        src={url}
        alt={name}
        draggable={false}
        onError={onError}
        className="size-full select-none object-contain"
      />
      {rect ? (
        <div
          className="pointer-events-none absolute"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        >
          <svg
            viewBox="0 0 1000 1000"
            preserveAspectRatio="none"
            className="absolute size-full overflow-visible text-primary"
            aria-hidden="true"
          >
            <defs>
              <marker
                id={markerId}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10" fill="none" stroke="currentColor" />
              </marker>
            </defs>
            {shapes.map(({ id, geometry, draft }) => (
              <g
                key={id}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeDasharray={draft ? '5 4' : undefined}
                className="[&>*]:[vector-effect:non-scaling-stroke]"
              >
                {renderShape(geometry)}
              </g>
            ))}
            {keyboard && !locked ? (
              <path
                d={`M ${cursor.x * 1000 - 10} ${cursor.y * 1000} h 20 M ${cursor.x * 1000} ${cursor.y * 1000 - 10} v 20`}
                stroke="currentColor"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </svg>
          {regions.map((region) => {
            const g = region.geometry,
              point = g.kind === 'point' ? g.point : g.kind === 'polygon' ? g.points[0] : g.start
            const active = selected === region.id
            const marker = (
              <button
                key={region.id}
                type="button"
                disabled={locked}
                className={`pointer-events-auto absolute grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border bg-bg-000 text-xs font-semibold text-text-000 shadow-sm ${active ? 'z-[1] border-primary ring-2 ring-primary/30' : 'border-border-300'}`}
                style={{
                  left: `${point.x * 100}%`,
                  top: `${point.y * 100}%`
                }}
                aria-label={t('Edit region {{number}}', { number: region.number })}
                aria-haspopup="dialog"
                aria-expanded={active && Boolean(instructionEditor)}
                data-edit-region={region.id}
                onClick={() => onSelect(region.id)}
              >
                {region.number}
              </button>
            )
            if (!active || !instructionEditor) return marker
            return (
              <Popover key={region.id} open onOpenChange={(open) => !open && onCloseInstruction()}>
                <PopoverAnchor asChild>{marker}</PopoverAnchor>
                <PopoverContent
                  side="top"
                  sideOffset={8}
                  collisionBoundary={popupBoundary}
                  hideWhenDetached
                  updatePositionStrategy="always"
                  aria-label={t('Edit region {{number}}', { number: region.number })}
                  className="z-[80] flex w-60 max-w-[var(--radix-popover-content-available-width)] flex-col gap-1 px-0 py-1.5"
                  data-preview-escape-boundary
                  onPointerDown={(event) => event.stopPropagation()}
                  onInteractOutside={(event) => event.preventDefault()}
                  onEscapeKeyDown={(event) => {
                    if (event.isComposing) event.preventDefault()
                  }}
                  onCloseAutoFocus={(event) => {
                    event.preventDefault()
                    if (document.activeElement === document.body)
                      surface.current?.focus({ preventScroll: true })
                  }}
                >
                  {instructionEditor}
                </PopoverContent>
              </Popover>
            )
          })}
          {busyLabel ? (
            <div className="absolute inset-0 overflow-hidden bg-bg-000/10">
              <div className="absolute inset-y-0 w-1/3 animate-pulse bg-bg-000/10 motion-reduce:animate-none" />
            </div>
          ) : null}
        </div>
      ) : null}
      <span className="sr-only">
        {t(
          'Use arrow keys to position the cursor. Enter sets a point or completes a shape. Space adds a lasso point. Escape clears the pending shape.'
        )}
      </span>
    </div>
  )
}
