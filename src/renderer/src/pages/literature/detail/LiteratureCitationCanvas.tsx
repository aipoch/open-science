import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PanelRightClose, PanelRightOpen, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ZoomControls } from '@/components/ui/zoom-controls'
import { fullCreatorLabel } from '../literature-item-display'
import {
  assignCitationGraphSlots,
  citationGraphPosition,
  fitCitationGraph,
  citationGraphNodeRadius,
  citationGraphEdgeGeometry,
  citationGraphEdgeBend,
  citationGraphCompactLabel,
  nearestCitationGraphNode,
  placeCitationGraphLabels,
  type CitationGraphCamera,
  type CitationGraph
} from './citation-graph'
import type { CitationGraphController } from './useCitationGraphController'

export type CitationCanvasModel = Pick<
  CitationGraphController,
  'graph' | 'unfilteredGraph' | 'selectedNode' | 'busy' | 'filter'
> & {
  setSelected(id: string): void
  additionalPages: number
  initialSearchSettled: boolean
  centerTitle: string
  sourceName: string
}

/** Kept mounted per cached frame so camera, pan and keyboard interaction survive navigation. */
export function LiteratureCitationCanvas({
  model,
  marker,
  visible,
  onViewSelected,
  sidebarExpanded,
  sidebarToggle,
  onToggleSidebar
}: {
  model: CitationCanvasModel
  marker: string
  visible: boolean
  onViewSelected(): void
  sidebarExpanded: boolean
  sidebarToggle: React.RefObject<HTMLButtonElement | null>
  onToggleSidebar(): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const {
    graph,
    unfilteredGraph,
    selectedNode,
    setSelected,
    busy,
    additionalPages,
    initialSearchSettled,
    centerTitle,
    sourceName
  } = model
  const [inspected, setInspected] = useState<string>()
  const titleLeaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const titleTooltip = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const drag = useRef<
    | {
        pointerId: number
        x: number
        y: number
        panX: number
        panY: number
        moved: boolean
        element: HTMLDivElement
      }
    | undefined
  >(undefined)
  const ignoreClickUntil = useRef(0)
  const [camera, setCamera] = useState<CitationGraphCamera>()
  const [viewportSize, setViewportSize] = useState({ width: 900, height: 500 })
  const [hintGraph, setHintGraph] = useState<CitationGraph>()
  const [layout, setLayout] = useState<{
    graph?: CitationGraph
    slots: Map<string, number>
    additionalPages: number
  }>({
    additionalPages: 0,
    slots: new Map()
  })
  const viewport = useRef<HTMLDivElement>(null)
  const plot = useRef<HTMLDivElement>(null)
  // Adjust only this component's state when its input snapshot changes. React retries this
  // render before committing children, so slots and camera never commit a stale graph frame.
  const currentSlots =
    layout.graph === unfilteredGraph
      ? layout.slots
      : assignCitationGraphSlots(unfilteredGraph?.nodes ?? [], layout.slots)
  const allPositions = useMemo(
    () =>
      new Map(
        (unfilteredGraph?.nodes ?? []).map((node) => [
          node.id,
          citationGraphPosition(currentSlots.get(node.id)!)
        ])
      ),
    [unfilteredGraph, currentSlots]
  )
  const positions = useMemo(
    () => new Map((graph?.nodes ?? []).map((node) => [node.id, allPositions.get(node.id)!])),
    [graph, allPositions]
  )
  const hasGraph = graph !== undefined
  const centerPosition = useMemo(
    () => positions.get(graph?.nodes.find((node) => node.center)?.id ?? ''),
    [graph, positions]
  )
  const fittedCamera = useMemo(
    () => fitCitationGraph(positions.values(), centerPosition, 120),
    [positions, centerPosition]
  )
  const initialCamera = useMemo(
    () => fitCitationGraph(allPositions.values(), centerPosition, 120),
    [allPositions, centerPosition]
  )
  const baseView = camera ?? initialCamera
  const view = {
    x: baseView.x + baseView.width / 2 - baseView.width / zoom / 2,
    y: baseView.y + baseView.height / 2 - baseView.height / zoom / 2,
    width: baseView.width / zoom,
    height: baseView.height / zoom
  }
  const scale = Math.min(viewportSize.width / view.width, viewportSize.height / view.height)
  const labelSize = 12 / scale
  const narrow = viewportSize.width <= 420
  const offset = {
    x: (viewportSize.width - view.width * scale) / 2,
    y: (viewportSize.height - view.height * scale) / 2
  }
  const labels = useMemo(
    () =>
      new Map(
        (graph?.nodes ?? []).map((node) => [
          node.id,
          citationGraphCompactLabel(node.record.item, narrow ? 80 : 135)
        ])
      ),
    [graph, narrow]
  )
  const edges = useMemo(() => {
    if (!graph) return []
    const center = graph.nodes.find((node) => node.center)?.id
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
    return graph.edges.map((edge) => {
      const outgoing = edge.source === center
      const direction = outgoing ? ('references' as const) : ('citations' as const)
      const neighbor = nodes.get(outgoing ? edge.target : edge.source)!
      const bend = citationGraphEdgeBend(direction, neighbor.relation)
      const radius =
        citationGraphNodeRadius(false) * (neighbor.relation === 'citations' ? 1.2 : 1.1)
      const { start, control, end } = citationGraphEdgeGeometry(
        positions.get(edge.source)!,
        positions.get(edge.target)!,
        outgoing ? citationGraphNodeRadius(true) : radius,
        outgoing ? radius : citationGraphNodeRadius(true),
        scale,
        bend
      )
      return {
        ...edge,
        direction,
        neighbor,
        bend,
        path: `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`
      }
    })
  }, [graph, positions, scale])
  const labelPositions = placeCitationGraphLabels(
    (graph?.nodes ?? []).map((node) => {
      const point = positions.get(node.id)!
      return {
        id: node.id,
        x: (point.x - view.x) * scale + offset.x + pan.x,
        y: (point.y - view.y) * scale + offset.y + pan.y,
        radius: citationGraphNodeRadius(node.center) * scale,
        label: labels.get(node.id)!,
        relation: node.relation,
        priority: selectedNode?.id === node.id ? 4 : inspected === node.id ? 3 : node.center ? 2 : 0
      }
    }),
    viewportSize,
    narrow ? 5 : 16
  )
  if (layout.graph !== unfilteredGraph || layout.additionalPages !== additionalPages) {
    setLayout({ graph: unfilteredGraph, slots: currentSlots, additionalPages })
    const newPaperOutside =
      visible &&
      camera &&
      additionalPages > layout.additionalPages &&
      graph?.nodes.some((node) => {
        if (node.center || node.paperIds.some((id) => layout.slots.has(id))) return false
        const point = positions.get(node.id)!
        const x = (point.x - view.x) * scale + offset.x + pan.x
        const y = (point.y - view.y) * scale + offset.y + pan.y
        return x < 0 || x > viewportSize.width || y < 0 || y > viewportSize.height
      })
    setHintGraph(newPaperOutside ? graph : undefined)
    if (!unfilteredGraph) {
      setZoom(1)
      setPan({ x: 0, y: 0 })
      setCamera(undefined)
    }
  }
  useEffect(() => {
    if (!hintGraph) return
    const timer = setTimeout(() => setHintGraph(undefined), 4000)
    return () => clearTimeout(timer)
  }, [hintGraph])
  useEffect(() => {
    if (camera || busy || !graph || !initialSearchSettled) return
    let current = true
    queueMicrotask(() => {
      if (current) setCamera((previous) => previous ?? initialCamera)
    })
    return () => {
      current = false
    }
  }, [camera, busy, graph, initialSearchSettled, initialCamera])
  useLayoutEffect(() => {
    const element = plot.current
    if (!visible || !element) return
    let observing = true
    const measure = (): void => {
      if (!observing || !element.clientWidth || !element.clientHeight) return
      const next = { width: element.clientWidth, height: element.clientHeight }
      setViewportSize((previous) =>
        previous.width === next.width && previous.height === next.height ? previous : next
      )
    }
    queueMicrotask(measure)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    return () => {
      observing = false
      observer?.disconnect()
    }
  }, [visible, hasGraph])
  const releasePan = useCallback((suppressCompatibilityClick = false): void => {
    const pending = drag.current
    drag.current = undefined
    ignoreClickUntil.current = suppressCompatibilityClick && pending?.moved ? Date.now() + 250 : 0
    if (!pending) return
    if (pending.element.hasPointerCapture?.(pending.pointerId))
      pending.element.releasePointerCapture(pending.pointerId)
  }, [])
  useEffect(() => () => releasePan(), [visible, releasePan])
  useEffect(() => {
    const element = viewport.current
    if (!visible || !element) return
    const wheel = (event: WheelEvent): void => {
      if (event.target instanceof Element && event.target.closest('[data-no-pan]')) return
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1
      const nextZoom = Math.max(0.5, Math.min(3, zoom * Math.exp(-event.deltaY * unit * 0.002)))
      const bounds = plot.current?.getBoundingClientRect()
      if (!bounds || nextZoom === zoom) return
      const ratio = nextZoom / zoom
      const x = event.clientX - bounds.left - bounds.width / 2
      const y = event.clientY - bounds.top - bounds.height / 2
      // Keep the point under the pointer fixed, including after dragging the graph.
      setPan({ x: x - (x - pan.x) * ratio, y: y - (y - pan.y) * ratio })
      setZoom(nextZoom)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => {
      element.removeEventListener('wheel', wheel)
    }
  }, [visible, zoom, pan])
  const hitPoints = useMemo(
    () => [...positions].map(([id, point]) => ({ id, ...point })),
    [positions]
  )
  const paperAtPointer = (event: React.MouseEvent<SVGRectElement>, fallback: string): string => {
    const scene = event.currentTarget.parentElement?.closest<SVGGElement>('[data-citation-scene]')
    const matrix = scene?.getScreenCTM?.()
    // The scene only translates and scales uniformly, so nearest distances are preserved.
    if (!matrix?.a || !matrix.d) return fallback
    return (
      nearestCitationGraphNode(
        hitPoints,
        (event.clientX - matrix.e) / matrix.a,
        (event.clientY - matrix.f) / matrix.d
      ) ?? fallback
    )
  }
  const inspectedNode = graph?.nodes.find((node) => node.id === inspected)
  useLayoutEffect(() => {
    const canvas = viewport.current
    const title = titleTooltip.current
    const mark = canvas?.querySelector<SVGCircleElement>(
      `[data-paper-id="${inspectedNode?.id}"] [data-node-mark]`
    )
    if (!canvas || !title || !mark) return
    const bounds = canvas.getBoundingClientRect()
    const anchor = mark.getBoundingClientRect()
    const gap = 8
    const above = Math.max(0, anchor.top - bounds.top - gap * 2)
    const below = Math.max(0, bounds.bottom - anchor.bottom - gap * 2)
    // Focus opens this hint between pointerdown and pointerup. Keep it clear of its
    // inspected mark so it cannot steal pointerup and cancel the node's click.
    // Constrain long titles to the available side and scroll instead of covering the mark.
    const placeAbove = above >= below
    title.style.maxHeight = `${Math.max(1, placeAbove ? above : below)}px`
    const tooltip = title.getBoundingClientRect()
    title.style.top = `${
      placeAbove ? anchor.top - bounds.top - gap - tooltip.height : anchor.bottom - bounds.top + gap
    }px`
    title.style.left = `${Math.max(
      gap,
      Math.min(
        bounds.width - tooltip.width - gap,
        anchor.left - bounds.left + anchor.width / 2 - tooltip.width / 2
      )
    )}px`
  }, [inspectedNode, viewportSize, view.x, view.y, view.width, view.height, pan.x, pan.y])
  const keepTitle = (): void => clearTimeout(titleLeaveTimer.current)
  const inspectTitle = (id: string): void => {
    keepTitle()
    setInspected(id)
  }
  const leaveTitle = (): void => {
    keepTitle()
    titleLeaveTimer.current = setTimeout(() => setInspected(undefined), 120)
  }
  useEffect(() => {
    if (!visible || !inspectedNode) return
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      // Radix also listens on document capture. React can remove the hint before
      // its listener runs, so stop other listeners on this same target as well.
      event.stopImmediatePropagation()
      clearTimeout(titleLeaveTimer.current)
      setInspected(undefined)
    }
    // Dialog's document-capture callback also guards this visible child hint. This listener
    // clears it even when focus is outside the SVG node (pointer-only inspection).
    document.addEventListener('keydown', dismiss, true)
    return () => document.removeEventListener('keydown', dismiss, true)
  }, [visible, inspectedNode])
  useEffect(() => () => clearTimeout(titleLeaveTimer.current), [])
  const fitGraph = (): void => {
    setHintGraph(undefined)
    setZoom(1)
    setCamera(fittedCamera)
    setPan({ x: 0, y: 0 })
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <div
        ref={viewport}
        data-citation-canvas
        role="region"
        aria-label={t('Citation graph')}
        className="relative min-h-[180px] min-w-0 flex-1 touch-none overflow-hidden bg-background cursor-grab active:cursor-grabbing"
        onPointerDown={(event) => {
          if (event.button !== 0 || event.isPrimary === false) return
          ignoreClickUntil.current = 0
          if (
            event.target instanceof Element &&
            event.target.closest(
              'g[role="button"], [data-node-hit], button, a, input, [data-no-pan]'
            )
          )
            return
          event.preventDefault()
          drag.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            panX: pan.x,
            panY: pan.y,
            moved: false,
            element: event.currentTarget
          }
          event.currentTarget.setPointerCapture?.(event.pointerId)
        }}
        onPointerMove={(event) => {
          const pending = drag.current
          if (!pending || pending.pointerId !== event.pointerId) return
          const dx = event.clientX - pending.x
          const dy = event.clientY - pending.y
          if (Math.hypot(dx, dy) > 3) pending.moved = true
          setPan({ x: pending.panX + dx, y: pending.panY + dy })
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId === event.pointerId) releasePan(true)
        }}
        onPointerCancel={(event) => {
          if (drag.current?.pointerId === event.pointerId) releasePan()
        }}
        onLostPointerCapture={(event) => {
          if (drag.current?.pointerId === event.pointerId) releasePan()
        }}
      >
        <div
          data-citation-toolbar
          data-no-pan
          className="absolute bottom-1 right-2 z-20 flex items-center gap-1 rounded-md border border-border-300/50 bg-bg-000/90 p-1 shadow-sm backdrop-blur sm:top-3 sm:right-3 sm:bottom-auto"
        >
          <ZoomControls
            onZoomIn={() => setZoom((value) => Math.min(3, value + 0.2))}
            onZoomOut={() => setZoom((value) => Math.max(0.5, value - 0.2))}
            onReset={fitGraph}
            resetLabel={t('Fit graph')}
            canZoomIn={zoom < 3}
            canZoomOut={zoom > 0.5}
          />
          <Button
            ref={sidebarToggle}
            variant="ghost"
            size="icon-xs"
            data-citation-inspector-toggle
            className="text-text-100 hover:text-text-000 [@media(pointer:coarse)]:size-11"
            aria-expanded={sidebarExpanded}
            aria-controls={`${marker}-inspector-content`}
            aria-label={sidebarExpanded ? t('Collapse sidebar panel') : t('Expand sidebar panel')}
            title={sidebarExpanded ? t('Collapse sidebar panel') : t('Expand sidebar panel')}
            onClick={onToggleSidebar}
          >
            {sidebarExpanded ? (
              <PanelRightClose aria-hidden="true" />
            ) : (
              <PanelRightOpen aria-hidden="true" />
            )}
          </Button>
          <span className="sr-only" data-citation-source>
            {t('Source: {{source}}', { source: sourceName })}
          </span>
          <span className="sr-only">
            {t('Graph: {{nodes}} papers, {{edges}} relationships', {
              nodes: graph?.nodes.length ?? 1,
              edges: graph?.edges.length ?? 0
            })}
          </span>
        </div>
        {graph ? (
          <div data-citation-regions className="sr-only">
            <span id={`${marker}-references-label`}>{t('Papers this paper references')}</span>
            <span id={`${marker}-citations-label`}>{t('Papers that cite this paper')}</span>
            <span id={`${marker}-both-label`}>{t('Both directions')}</span>
            <span id={`${marker}-center-label`}>{t('Current center')}</span>
          </div>
        ) : null}
        {inspectedNode ? (
          <div
            ref={titleTooltip}
            data-citation-hover-title
            role="tooltip"
            data-no-pan
            onMouseEnter={keepTitle}
            onMouseLeave={leaveTitle}
            className="absolute top-0 left-0 z-20 w-max max-w-[min(32rem,calc(100%-1.5rem))] overflow-y-auto rounded-lg border border-border-300/80 bg-card/95 px-3 py-2 text-center text-xs font-medium text-foreground shadow-lg backdrop-blur-md"
          >
            {inspectedNode.record.item.title}
          </div>
        ) : null}

        {visible && hintGraph && hintGraph === graph ? (
          <p
            role="status"
            className="pointer-events-none absolute bottom-14 left-2 z-10 max-w-52 rounded-md bg-card/90 px-2 py-1 text-[11px] text-muted-foreground sm:top-auto sm:right-3 sm:bottom-8 sm:left-auto sm:max-w-72"
          >
            {t('New papers off-screen. Fit graph.')}
          </p>
        ) : null}
        <div
          ref={plot}
          data-citation-plot
          className="absolute inset-x-0 top-12 bottom-12 overflow-hidden sm:top-14 sm:bottom-1"
        >
          {graph ? (
            <svg
              viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
              preserveAspectRatio="xMidYMid meet"
              style={{ width: '100%', height: '100%' }}
              data-zoom={zoom}
              data-pan-x={pan.x}
              data-pan-y={pan.y}
              className="block"
              role="group"
              aria-label={t('Citation graph')}
              aria-describedby={`${marker}-arrow-meaning`}
            >
              <defs>
                <pattern id={`${marker}-grid`} width="48" height="48" patternUnits="userSpaceOnUse">
                  <path
                    d="M 48 0 L 0 0 0 48"
                    fill="none"
                    stroke="hsl(var(--border) / .28)"
                    strokeWidth="1"
                  />
                  <circle cx="0" cy="0" r="1" fill="hsl(var(--muted-foreground) / .22)" />
                </pattern>
                {(['references', 'citations'] as const).flatMap((direction) =>
                  [false, true].map((emphasized) => (
                    <marker
                      key={`${direction}-${emphasized}`}
                      id={`${marker}-${direction}${emphasized ? '-emphasized' : ''}`}
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerUnits="userSpaceOnUse"
                      markerWidth={(emphasized ? 9 : 7) / scale}
                      markerHeight={(emphasized ? 9 : 7) / scale}
                      orient="auto-start-reverse"
                    >
                      <path
                        d="M 0 0 L 10 5 L 0 10 z"
                        fill={direction === 'references' ? 'var(--chart-1)' : 'var(--chart-3)'}
                      />
                    </marker>
                  ))
                )}
                <linearGradient id={`${marker}-both`}>
                  <stop offset="50%" stopColor="var(--chart-1)" stopOpacity={0.25} />
                  <stop offset="50%" stopColor="var(--chart-3)" stopOpacity={0.25} />
                </linearGradient>
              </defs>
              <rect
                x={view.x}
                y={view.y}
                width={view.width}
                height={view.height}
                fill={`url(#${marker}-grid)`}
                pointerEvents="none"
              />
              <g data-citation-scene transform={`translate(${pan.x / scale} ${pan.y / scale})`}>
                <circle
                  cx="800"
                  cy="500"
                  r="62"
                  fill="var(--primary)"
                  fillOpacity={0.06}
                  pointerEvents="none"
                />
                <circle
                  cx="800"
                  cy="500"
                  r="42"
                  fill="none"
                  stroke="var(--primary)"
                  strokeOpacity={0.22}
                  strokeWidth={1 / scale}
                  strokeDasharray={`${5 / scale} ${7 / scale}`}
                  pointerEvents="none"
                />
                {edges.map(({ source, target, direction, neighbor, bend, path }) => {
                  const related = selectedNode?.id === neighbor.id || inspected === neighbor.id
                  const emphasis = related ? 'related' : selectedNode?.center ? 'center' : 'ambient'
                  return (
                    <path
                      key={`${source}:${target}`}
                      data-source={source}
                      data-target={target}
                      data-direction={direction}
                      data-edge-emphasis={emphasis}
                      data-edge-bend={bend}
                      d={path}
                      fill="none"
                      style={{
                        stroke: direction === 'references' ? 'var(--chart-1)' : 'var(--chart-3)'
                      }}
                      opacity={related ? 1 : 0.8}
                      strokeWidth={(related ? 2.2 : 1.4) / scale}
                      markerEnd={`url(#${marker}-${direction}${related ? '-emphasized' : ''})`}
                    />
                  )
                })}
                <g aria-hidden="true">
                  {graph.nodes.map((node) => {
                    const point = positions.get(node.id)!
                    return (
                      <rect
                        key={node.id}
                        data-node-hit={node.id}
                        x={point.x - Math.max(112, 24 / scale) / 2}
                        y={point.y - Math.max(66, 24 / scale) / 2}
                        width={Math.max(112, 24 / scale)}
                        height={Math.max(66, 24 / scale)}
                        fill="transparent"
                        onMouseEnter={(event) => inspectTitle(paperAtPointer(event, node.id))}
                        onMouseMove={(event) => inspectTitle(paperAtPointer(event, node.id))}
                        onMouseLeave={leaveTitle}
                        onClick={(event) => {
                          if (Date.now() < ignoreClickUntil.current) return
                          const id = paperAtPointer(event, node.id)
                          setSelected(id)
                          viewport.current
                            ?.querySelector<SVGGElement>(`[data-paper-id="${id}"]`)
                            ?.focus({ preventScroll: true })
                        }}
                      />
                    )
                  })}
                </g>
                {graph.nodes.map((node) => {
                  const point = positions.get(node.id)!
                  return (
                    <g
                      key={node.id}
                      role="button"
                      tabIndex={selectedNode?.id === node.id ? 0 : -1}
                      data-paper-id={node.id}
                      aria-pressed={selectedNode?.id === node.id}
                      aria-describedby={`${marker}-${node.relation}-label ${marker}-${node.id}-metadata`}
                      data-relation={node.relation}
                      aria-label={
                        node.center
                          ? t('Center paper: {{title}}', { title: node.record.item.title })
                          : t('Select {{title}}', { title: node.record.item.title })
                      }
                      onClick={() => {
                        if (Date.now() >= ignoreClickUntil.current) setSelected(node.id)
                      }}
                      onMouseEnter={() => inspectTitle(node.id)}
                      onMouseLeave={leaveTitle}
                      onFocus={() => inspectTitle(node.id)}
                      onBlur={() => setInspected(undefined)}
                      onKeyDown={(event) => {
                        if (event.key === 'Tab' && !event.shiftKey) {
                          const details = viewport.current?.querySelector<HTMLButtonElement>(
                            '[data-citation-view-selected]'
                          )
                          if (details) {
                            event.preventDefault()
                            details.focus()
                          }
                          return
                        }
                        if (event.altKey || event.ctrlKey || event.metaKey) return
                        const index = graph.nodes.findIndex((entry) => entry.id === node.id)
                        const nextIndex =
                          event.key === 'Home'
                            ? 0
                            : event.key === 'End'
                              ? graph.nodes.length - 1
                              : ['ArrowRight', 'ArrowDown'].includes(event.key)
                                ? (index + 1) % graph.nodes.length
                                : ['ArrowLeft', 'ArrowUp'].includes(event.key)
                                  ? (index - 1 + graph.nodes.length) % graph.nodes.length
                                  : undefined
                        if (nextIndex !== undefined) {
                          event.preventDefault()
                          const next = graph.nodes[nextIndex]
                          setSelected(next.id)
                          viewport.current
                            ?.querySelector<SVGGElement>(`[data-paper-id="${next.id}"]`)
                            ?.focus({ preventScroll: true })
                          return
                        }
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          setSelected(node.id)
                        }
                      }}
                      className="group cursor-pointer outline-none"
                    >
                      <title>
                        {[
                          node.record.item.title,
                          fullCreatorLabel(node.record.item),
                          node.record.item.issuedYear?.toString() ?? t('No year')
                        ]
                          .filter(Boolean)
                          .join('\n')}
                      </title>
                      <desc id={`${marker}-${node.id}-metadata`}>
                        {[
                          fullCreatorLabel(node.record.item),
                          node.record.item.issuedYear?.toString() ?? t('No year')
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </desc>
                      {selectedNode?.id === node.id ? (
                        <circle
                          cx={point.x}
                          cy={point.y}
                          r={citationGraphNodeRadius(node.center) + 4}
                          fill="none"
                          stroke="var(--primary)"
                          strokeOpacity={0.72}
                          strokeWidth={0.75 / scale}
                          pointerEvents="none"
                        />
                      ) : null}
                      {(() => {
                        const kind = node.center
                          ? 'circle'
                          : node.relation === 'citations'
                            ? 'diamond'
                            : node.relation === 'references'
                              ? 'circle'
                              : 'both'
                        const selected = selectedNode?.id === node.id
                        const radius = citationGraphNodeRadius(node.center)
                        const visualRadius = node.center
                          ? radius
                          : kind === 'diamond'
                            ? radius * 1.2
                            : radius * 1.1
                        const style = node.center
                          ? {
                              fill: 'var(--background)',
                              fillOpacity: 0.96,
                              stroke: 'var(--primary)',
                              strokeOpacity: 0.95
                            }
                          : {
                              fill:
                                node.relation === 'both'
                                  ? `url(#${marker}-both)`
                                  : node.relation === 'references'
                                    ? 'var(--chart-1)'
                                    : 'var(--chart-3)',
                              fillOpacity: selected ? 1 : 0.25,
                              stroke:
                                node.relation === 'citations' ? 'var(--chart-3)' : 'var(--chart-1)',
                              strokeOpacity: 1
                            }
                        const shapeClass =
                          'group-focus-visible:stroke-ring group-focus-visible:stroke-[3]'
                        return kind === 'diamond' ? (
                          <polygon
                            data-node-mark
                            data-node-kind="diamond"
                            data-x={point.x}
                            data-y={point.y}
                            points={`${point.x},${point.y - visualRadius} ${point.x + visualRadius},${point.y} ${point.x},${point.y + visualRadius} ${point.x - visualRadius},${point.y}`}
                            strokeWidth={1.1 / scale}
                            className={shapeClass}
                            style={style}
                          />
                        ) : (
                          <circle
                            data-node-mark
                            data-node-kind={kind === 'both' ? 'both' : 'circle'}
                            data-x={point.x}
                            data-y={point.y}
                            cx={point.x}
                            cy={point.y}
                            r={visualRadius}
                            strokeWidth={1.1 / scale}
                            className={shapeClass}
                            style={style}
                          />
                        )
                      })()}
                      {node.relation === 'both' ? (
                        <polygon
                          data-node-kind="diamond"
                          points={`${point.x},${point.y - citationGraphNodeRadius(false) * 0.82} ${point.x + citationGraphNodeRadius(false) * 0.82},${point.y} ${point.x},${point.y + citationGraphNodeRadius(false) * 0.82} ${point.x - citationGraphNodeRadius(false) * 0.82},${point.y}`}
                          fill="var(--background)"
                          fillOpacity={selectedNode?.id === node.id ? 0.3 : 0.78}
                          stroke="var(--chart-3)"
                          strokeWidth={0.8 / scale}
                          pointerEvents="none"
                        />
                      ) : null}
                      {node.center ? (
                        <circle
                          cx={point.x}
                          cy={point.y}
                          r={citationGraphNodeRadius(true) + 8}
                          fill="none"
                          stroke="var(--primary)"
                          strokeOpacity={0.42}
                          strokeWidth={1 / scale}
                          strokeDasharray={`${3 / scale} ${5 / scale}`}
                          pointerEvents="none"
                        />
                      ) : null}
                      <text
                        data-citation-label
                        data-label-visible={labelPositions.has(node.id)}
                        x={
                          labelPositions.has(node.id)
                            ? (labelPositions.get(node.id)!.x - offset.x - pan.x) / scale + view.x
                            : point.x
                        }
                        y={
                          labelPositions.has(node.id)
                            ? (labelPositions.get(node.id)!.y - offset.y - pan.y) / scale + view.y
                            : point.y + 36
                        }
                        textAnchor="middle"
                        fontSize={labelSize}
                        opacity={labelPositions.has(node.id) ? 1 : 0}
                        paintOrder="stroke"
                        strokeWidth={4 / scale}
                        strokeLinejoin="round"
                        className="pointer-events-none fill-foreground stroke-background"
                      >
                        {labels.get(node.id)}
                      </text>
                    </g>
                  )
                })}
              </g>
            </svg>
          ) : (
            <div
              role="status"
              className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground"
            >
              {busy && !initialSearchSettled ? (
                <span className="inline-flex items-center gap-2">
                  <LoaderCircle
                    aria-hidden="true"
                    className="size-4 text-primary motion-safe:animate-spin"
                  />
                  {t('Searching…')}
                </span>
              ) : (
                centerTitle
              )}
            </div>
          )}
        </div>
        <Button
          data-citation-view-selected
          size="sm"
          variant="secondary"
          className="sr-only focus:not-sr-only focus:absolute focus:bottom-2 focus:left-2 focus:z-10"
          onClick={() => {
            onViewSelected()
          }}
        >
          {t('View selected paper')}
        </Button>
      </div>
      {graph ? (
        <div
          data-citation-legend
          className="mx-2 mb-2 max-w-full self-start rounded-md border border-border-300 bg-card px-2.5 py-1.5 text-xs text-muted-foreground sm:mx-3"
          aria-label={t('Citation graph')}
        >
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="inline-flex items-center gap-1 text-foreground">
              <span
                className="size-2 rounded-full border border-primary bg-background"
                aria-hidden="true"
              />
              {t('Current center')}
            </span>
            <span className="h-3 w-px bg-border-300" aria-hidden="true" />
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <span className="size-1.5 rounded-full bg-chart-1" aria-hidden="true" />
              {t('References')}
            </span>
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <span className="size-1.5 rotate-45 bg-chart-3" aria-hidden="true" />
              {t('Cited by')}
            </span>
          </div>
          <p id={`${marker}-arrow-meaning`} className="mt-1 text-[11px]">
            {t('A → B means A cites B.')} <span>{t('Scroll to zoom. Drag to pan.')}</span>
          </p>
        </div>
      ) : null}
    </div>
  )
}
