import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { RotateCcw, Shrink, ZoomIn, ZoomOut } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  TransformComponent,
  TransformWrapper,
  type ReactZoomPanPinchRef
} from 'react-zoom-pan-pinch'
import { Button } from '@/components/ui/button'
import type { ImageHistoryNode } from './image-editor-state'

type Point = { x: number; y: number }
type Placement = Point & { node: ImageHistoryNode }
type Connection = {
  from: Point
  to: Point
  path: string
  bends: Point[]
  sourceId: string
  targetId: string
}
const keyOf = (node: ImageHistoryNode): string => node.item.selectedVersionId!

function arrange(
  roots: ImageHistoryNode[],
  horizontal: boolean,
  width: number,
  height: number
): Placement[] {
  const positions: Placement[] = []
  let leaf = 0
  const visit = (node: ImageHistoryNode, depth: number): Point => {
    const children = node.children.map((child) => visit(child, depth + 1))
    const step = horizontal ? height + 38 : width + 22
    const getRow = (p: Point): number => (horizontal ? p.y : p.x)
    const cross = children.length
      ? (getRow(children[0]) + getRow(children[children.length - 1])) / 2
      : leaf++ * step
    const axis = depth * (horizontal ? width + 96 : height + 48)
    const point = horizontal ? { x: axis, y: cross } : { x: cross, y: axis }
    positions.push({ node, ...point })
    return point
  }
  for (const root of roots) visit(root, 0)
  return positions
}

function roundedPath(points: Point[]): string {
  let path = `M${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const [before, at, after] = points.slice(i - 1, i + 2)
    const radius = Math.min(
      14,
      Math.hypot(at.x - before.x, at.y - before.y) / 2,
      Math.hypot(after.x - at.x, after.y - at.y) / 2
    )
    path += ` L${at.x - radius * Math.sign(at.x - before.x)} ${at.y - radius * Math.sign(at.y - before.y)}`
    path += ` Q${at.x} ${at.y} ${at.x + radius * Math.sign(after.x - at.x)} ${at.y + radius * Math.sign(after.y - at.y)}`
  }
  const { x, y } = points[points.length - 1]
  return path + ` L${x} ${y}`
}

function connections(
  positions: Placement[],
  horizontal: boolean,
  width: number,
  height: number
): Connection[] {
  const byId = new Map(positions.map((point) => [keyOf(point.node), point]))
  const orient = (u: number, v: number): Point => (horizontal ? { x: u, y: v } : { x: v, y: u })
  const axisSize = horizontal ? width : height
  const crossSize = horizontal ? height : width
  const boundsU = positions.map((p) => (horizontal ? p.x : p.y))
  const boundsV = positions.map((p) => (horizontal ? p.y : p.x))
  const leftLimit = Math.min(...boundsU) - 22
  const rightLimit = Math.max(...boundsU) + axisSize + 22
  const near = Math.min(...boundsV) - 19
  const far = Math.max(...boundsV) + crossSize + 19
  return positions.flatMap((target) => {
    const source = target.node.parentId && byId.get(target.node.parentId)
    if (!source) return []
    const { x: sourceAxis, y: sourceCross } = orient(source.x, source.y)
    const { x: targetAxis, y: targetCross } = orient(target.x, target.y)
    const u = sourceAxis + axisSize + 5
    const v = sourceCross + (crossSize + (horizontal ? 28 : 0)) / 2
    const endU = targetAxis - 7
    const endV = targetCross + (crossSize + (horizontal ? 28 : 0)) / 2
    const from = orient(u, v)
    const to = orient(endU, endV)
    const gap = endU - u
    let bends: Point[] = []
    let path: string
    if (gap >= 0) {
      const first = orient(u + gap * 0.48, v)
      const last = orient(endU - gap * 0.48, endV)
      path = `M${from.x} ${from.y} C${first.x} ${first.y} ${last.x} ${last.y} ${to.x} ${to.y}`
    } else {
      const upperEnd = Math.min(sourceCross, targetCross) + crossSize
      const lower = Math.max(sourceCross, targetCross)
      const between = lower - upperEnd >= 4
      const lane = between ? (upperEnd + lower) / 2 : v + endV < near + far ? near : far
      const left = between ? endU - 15 : leftLimit
      const right = between ? u + 15 : rightLimit
      bends = [orient(right, v), orient(right, lane), orient(left, lane), orient(left, endV)]
      path = roundedPath([from, ...bends, to])
    }
    return [{ from, to, path, bends, sourceId: keyOf(source.node), targetId: keyOf(target.node) }]
  })
}

export function ImageHistoryCanvas({
  roots,
  selectedId,
  renderTile,
  moreAction,
  relatedAction,
  onEdit
}: {
  roots: ImageHistoryNode[]
  selectedId?: string
  renderTile(
    node: ImageHistoryNode,
    selected: boolean,
    select: () => void,
    edit: () => void
  ): ReactNode
  moreAction?: ReactNode
  relatedAction(node: ImageHistoryNode): ReactNode
  onEdit(node: ImageHistoryNode): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const board = useRef<HTMLDivElement>(null)
  const view = useRef<ReactZoomPanPinchRef>(null)
  const [viewport, setViewport] = useState({ width: 600, height: 500 })
  const [activeId, setActiveId] = useState(selectedId)
  const [offsets, setOffsets] = useState<ReadonlyMap<string, Point>>(() => new Map())
  const drag = useRef<
    { id: string; pointer: number; from: Point; offset: Point; moved: boolean } | undefined
  >(undefined)
  const suppressClick = useRef(false)
  const frame = useRef<number | undefined>(undefined)
  const pendingOffset = useRef<{ id: string; offset: Point } | undefined>(undefined)
  const flushOffset = (): void => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current)
    frame.current = undefined
    const pending = pendingOffset.current
    pendingOffset.current = undefined
    if (pending) setOffsets((values) => new Map(values).set(pending.id, pending.offset))
  }
  useEffect(
    () => () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current)
    },
    []
  )

  useEffect(() => {
    const element = board.current
    if (!element) return
    const measure = (): void => {
      const { clientWidth: width, clientHeight: height } = element
      if (width && height) setViewport({ width, height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const horizontal = viewport.width >= 560
  const width = horizontal
    ? Math.min(224, Math.floor((viewport.width - 136) / 2))
    : Math.max(100, Math.floor((viewport.width - 62) / 2))
  const height = 28 + (width * 9) / 16
  const automatic = useMemo(
    () => arrange(roots, horizontal, width, height),
    [roots, horizontal, width, height]
  )
  const placements = useMemo(
    () =>
      automatic.map((point) => {
        const offset = offsets.get(keyOf(point.node))
        return offset ? { ...point, x: point.x + offset.x, y: point.y + offset.y } : point
      }),
    [automatic, offsets]
  )
  const wires = useMemo(
    () => connections(placements, horizontal, width, height),
    [placements, horizontal, width, height]
  )
  const byId = new Map(placements.map((point) => [keyOf(point.node), point]))
  const active = (activeId && byId.get(activeId)) || placements.at(-1)
  const current = active && keyOf(active.node)

  const fit = (withOffsets = true): void => {
    const positions = withOffsets ? placements : automatic
    if (!positions.length) return
    const bends = (withOffsets ? wires : []).flatMap((wire) => wire.bends)
    const minX = Math.min(...positions.map((p) => p.x), ...bends.map((p) => p.x))
    const minY = Math.min(...positions.map((p) => p.y), ...bends.map((p) => p.y))
    const contentWidth =
      Math.max(...positions.map((p) => p.x + width), ...bends.map((p) => p.x)) - minX
    const contentHeight =
      Math.max(...positions.map((p) => p.y + height), ...bends.map((p) => p.y)) - minY
    // Keep large histories readable. Pan and explicit zoom remain available.
    const scale = Math.max(
      0.42,
      Math.min(1, (viewport.width - 40) / contentWidth, (viewport.height - 40) / contentHeight)
    )
    const activePoint = current ? positions.find(({ node }) => keyOf(node) === current) : undefined
    const centerX =
      contentWidth * scale > viewport.width && activePoint
        ? activePoint.x + width / 2
        : minX + contentWidth / 2
    const centerY =
      contentHeight * scale > viewport.height && activePoint
        ? activePoint.y + height / 2
        : minY + contentHeight / 2
    view.current?.setTransform(
      viewport.width / 2 - centerX * scale,
      viewport.height / 2 - centerY * scale,
      scale,
      0
    )
  }

  useEffect(() => {
    fit()
    // Recenter when the viewport or loaded history changes. Dragging leaves the camera in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, roots])

  const tileList = (nodes: ImageHistoryNode[]): ReactNode => (
    <ul>
      {nodes.map((node) => {
        const id = keyOf(node)
        const point = byId.get(id)!
        return (
          <li key={id}>
            <div
              className="image-history-tile absolute left-0 top-0"
              style={{
                width,
                transform: `translate(${point.x}px, ${point.y}px)`,
                zIndex: current === id ? 1 : undefined
              }}
              onPointerDown={(event) => {
                if (event.button !== 0 || !event.isPrimary) return
                suppressClick.current = false
                drag.current = {
                  id,
                  pointer: event.pointerId,
                  from: { x: event.clientX, y: event.clientY },
                  offset: offsets.get(id) ?? { x: 0, y: 0 },
                  moved: false
                }
              }}
              onPointerMove={(event) => {
                const moving = drag.current
                if (!moving || moving.id !== id || moving.pointer !== event.pointerId) return
                if (!event.buttons) {
                  drag.current = undefined
                  return
                }
                const dx = event.clientX - moving.from.x
                const dy = event.clientY - moving.from.y
                if (!moving.moved && Math.hypot(dx, dy) < 5) return
                if (!moving.moved) {
                  event.currentTarget.setPointerCapture(event.pointerId)
                  setActiveId(id)
                  moving.moved = true
                  suppressClick.current = true
                }
                const scale = view.current?.state.scale ?? 1
                pendingOffset.current = {
                  id,
                  offset: { x: moving.offset.x + dx / scale, y: moving.offset.y + dy / scale }
                }
                frame.current ??= requestAnimationFrame(flushOffset)
              }}
              onLostPointerCapture={() => {
                flushOffset()
                drag.current = undefined
              }}
              onPointerUp={() => {
                flushOffset()
                drag.current = undefined
              }}
              onPointerCancel={() => {
                flushOffset()
                drag.current = undefined
              }}
              onClickCapture={(event) => {
                if (!suppressClick.current || event.detail === 0) return
                suppressClick.current = false
                event.stopPropagation()
              }}
            >
              {renderTile(
                node,
                current === id,
                () => setActiveId(id),
                () => onEdit(node)
              )}
            </div>
            {node.children.length ? tileList(node.children) : null}
          </li>
        )
      })}
    </ul>
  )

  return (
    <>
      <div ref={board} className="relative min-h-0 flex-1 overflow-hidden">
        <TransformWrapper
          ref={view}
          minScale={0.42}
          maxScale={3}
          limitToBounds={false}
          panning={{ excluded: ['image-history-tile'], velocityDisabled: true }}
          pinch={{ excluded: ['image-history-tile'] }}
          doubleClick={{ disabled: true }}
          wheel={{ activationKeys: (keys) => keys.includes('Control') || keys.includes('Meta') }}
        >
          <TransformComponent
            wrapperClass="!size-full cursor-grab active:cursor-grabbing"
            contentClass="!size-full"
          >
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 size-full overflow-visible"
            >
              {wires
                .map((wire) => ({
                  ...wire,
                  related: wire.sourceId === current || wire.targetId === current
                }))
                .sort((a, b) => Number(a.related) - Number(b.related))
                .map(({ from, to, path, sourceId, targetId, related }) => (
                  <g
                    key={targetId}
                    data-lineage-source={sourceId}
                    data-lineage-target={targetId}
                    className={related ? 'text-primary' : 'text-text-300'}
                  >
                    <path
                      d={path}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={related ? 1.8 : 1.5}
                      vectorEffect="non-scaling-stroke"
                    />
                    <rect
                      x={to.x - (horizontal ? 1.5 : 5.5)}
                      y={to.y - (horizontal ? 5.5 : 1.5)}
                      width={horizontal ? 3 : 11}
                      height={horizontal ? 11 : 3}
                      rx="1.5"
                      fill="currentColor"
                    />
                    <circle
                      cx={from.x}
                      cy={from.y}
                      r="3.5"
                      className="fill-background"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                ))}
            </svg>
            {tileList(roots)}
          </TransformComponent>
        </TransformWrapper>
      </div>
      <div className="flex shrink-0 items-center gap-1 border-t border-border-300/40 bg-bg-000 px-2 py-1.5">
        <TooltipProvider delayDuration={0} disableHoverableContent>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-text-100 hover:text-text-000"
                aria-label={t('Zoom out')}
                onClick={() => view.current?.zoomOut(0.2, 0)}
              >
                <ZoomOut aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('Zoom out')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-text-100 hover:text-text-000"
                aria-label={t('Zoom in')}
                onClick={() => view.current?.zoomIn(0.2, 0)}
              >
                <ZoomIn aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('Zoom in')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-text-100 hover:text-text-000"
                aria-label={t('Reset zoom')}
                onClick={() => fit()}
              >
                <Shrink aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('Reset zoom')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-text-100 hover:text-text-000"
                aria-label={t('Reset layout')}
                onClick={() => {
                  setOffsets(new Map())
                  fit(false)
                }}
              >
                <RotateCcw aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('Reset layout')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {moreAction}
        {active ? relatedAction(active.node) : null}
        <Button
          type="button"
          size="sm"
          className="ml-auto whitespace-nowrap"
          disabled={!active}
          onClick={() => active && onEdit(active.node)}
        >
          {t('Edit image')}
        </Button>
      </div>
    </>
  )
}
