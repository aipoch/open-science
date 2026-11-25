import { ExternalLink, GripVertical, Maximize, Minus, Plus, X } from 'lucide-react'
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent
} from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { FigureLinkAnchor } from './pdf-native-links'
import type { createPdfPagePreviewCache } from './pdf-figure-selections'

type Point = { x: number; y: number }
const clamp = (n: number, max: number): number => Math.max(0, Math.min(n, max))
const margin = 8

function IconButton({
  label,
  children,
  onClick,
  disabled
}: {
  label: string
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </Button>
  )
}

export function PdfFigurePreviewPanel({
  anchor,
  reference,
  page,
  image,
  caption,
  pageCache,
  onClose,
  onNavigate,
  onImageError
}: {
  anchor?: FigureLinkAnchor
  reference: string
  page: number
  image: string
  caption?: string
  pageCache: ReturnType<typeof createPdfPagePreviewCache> | null
  onClose: () => void
  onNavigate: () => void
  onImageError: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const panel = useRef<HTMLElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const picture = useRef<HTMLImageElement>(null)
  const [position, setPosition] = useState<Point>()
  const [scale, setScale] = useState(1)
  const [aspect, setAspect] = useState(1)
  const [heldPage, setHeldPage] = useState<string>()
  const [detail, setDetail] = useState<string>()
  const gesture = useRef<{ id: number; start: Point; initial: Point; kind: 'move' | 'pan' } | null>(
    null
  )
  const zoomScroll = useRef<Point | null>(null)
  const displayingCrop = Boolean(caption && !heldPage)

  function boundPosition(point: Point): Point {
    const el = panel.current!
    const host = el.parentElement!
    return {
      x: margin + clamp(point.x - margin, host.clientWidth - el.offsetWidth - 2 * margin),
      y: margin + clamp(point.y - margin, host.clientHeight - el.offsetHeight - 2 * margin)
    }
  }
  useLayoutEffect(() => {
    const el = panel.current!
    const host = el.parentElement!
    const place = (): void => {
      const box = host.getBoundingClientRect()
      const x = anchor ? anchor.x - box.left : host.clientWidth / 2
      const below = anchor ? anchor.bottom - box.top + margin : margin
      const above = anchor ? anchor.top - box.top - margin : 0
      el.style.maxHeight = '72%'
      const height = el.offsetHeight
      const width = el.offsetWidth
      const fromRight = anchor ? anchor.right - box.left + margin : x
      const fromLeft = anchor ? anchor.left - box.left - margin - width : x
      let preferred = { x: x - 24, y: below }
      if (below + height > host.clientHeight - margin) {
        if (above - height >= margin) preferred.y = above - height
        else if (fromRight + width <= host.clientWidth - margin || fromLeft >= margin) {
          preferred = {
            x: fromRight + width <= host.clientWidth - margin ? fromRight : fromLeft,
            y: below - height / 3
          }
        } else {
          const roomBelow = host.clientHeight - margin - below
          const roomAbove = above - margin
          el.style.maxHeight = Math.max(90, Math.max(roomBelow, roomAbove)) + 'px'
          preferred.y = roomBelow >= roomAbove ? below : above - el.offsetHeight
        }
      }
      setPosition((old) => {
        const next = boundPosition(old ?? preferred)
        return old?.x === next.x && old.y === next.y ? old : next
      })
    }
    place()
    if (anchor?.keyboard) el.focus({ preventScroll: true })
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(place)
    observer.observe(host)
    return () => observer.disconnect()
  }, [anchor])

  useEffect(() => {
    if (!heldPage || !pageCache) return
    const controller = new AbortController()
    void pageCache.load(page, controller.signal, true).then((result) => {
      if (!controller.signal.aborted) setDetail(result)
    })
    return () => controller.abort()
  }, [heldPage, page, pageCache])

  function imagePoint(client: Point): Point {
    const box = picture.current!.getBoundingClientRect()
    return {
      x: clamp((client.x - box.left) / Math.max(1, box.width), 1),
      y: clamp((client.y - box.top) / Math.max(1, box.height), 1)
    }
  }
  // The scrollable plane grows about its center. Keep the selected pixel under the pointer.
  function zoom(next: number, client?: Point, fixedPoint?: Point): void {
    const view = viewport.current,
      img = picture.current
    if (!view || !img || (scale === next && !fixedPoint)) return
    const rect = view.getBoundingClientRect()
    const focus = client
      ? { x: client.x - rect.left, y: client.y - rect.top }
      : { x: view.clientWidth / 2, y: view.clientHeight / 2 }
    const imageRect = img.getBoundingClientRect()
    const pixel = fixedPoint ?? imagePoint({ x: rect.left + focus.x, y: rect.top + focus.y })
    const width = (imageRect.width * next) / scale,
      height = (imageRect.height * next) / scale
    zoomScroll.current = {
      x: Math.max(0, (view.clientWidth - width) / 2) + pixel.x * width - focus.x,
      y: Math.max(0, (view.clientHeight - height) / 2) + pixel.y * height - focus.y
    }
    if (next === scale) {
      view.scrollLeft = zoomScroll.current.x
      view.scrollTop = zoomScroll.current.y
      zoomScroll.current = null
      return
    }
    if (!caption && next > 1) setHeldPage(image)
    setScale(next)
  }
  useLayoutEffect(() => {
    const v = viewport.current,
      pos = zoomScroll.current
    if (v && pos) {
      v.scrollLeft = pos.x
      v.scrollTop = pos.y
      zoomScroll.current = null
    }
  }, [scale])

  const pinchZoom = useEffectEvent((factor: number, focus: Point) => {
    zoom(Math.max(1, Math.min(8, scale * factor)), focus)
  })
  useEffect(() => {
    const view = viewport.current!
    let delta = 0,
      frame = 0
    let focus: Point
    const wheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      event.stopPropagation()
      focus = { x: event.clientX, y: event.clientY }
      delta +=
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? view.clientHeight : 1)
      if (!frame)
        frame = requestAnimationFrame(() => {
          pinchZoom(Math.exp(-delta / 100), focus)
          frame = 0
          delta = 0
        })
    }
    view.addEventListener('wheel', wheel, { passive: false })
    return () => {
      view.removeEventListener('wheel', wheel)
      cancelAnimationFrame(frame)
    }
  }, [])

  const pinch = useRef<{ distance: number; scale: number; pixel: Point } | null>(null)
  function touchGesture(touches: React.TouchList, begin: boolean): void {
    if (touches.length !== 2) {
      pinch.current = null
      return
    }
    const [a, b] = [touches[0], touches[1]]
    const focus = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
    if (!distance) return
    if (begin || !pinch.current) {
      gesture.current = null
      pinch.current = { distance, scale, pixel: imagePoint(focus) }
    } else {
      const start = pinch.current
      zoom(Math.max(1, Math.min(8, (start.scale * distance) / start.distance)), focus, start.pixel)
    }
  }

  function start(event: PointerEvent<HTMLElement>, kind: 'move' | 'pan'): void {
    if (!event.isPrimary || event.button !== 0 || (kind === 'pan' && scale === 1)) return
    const initial =
      kind === 'move'
        ? position
        : { x: viewport.current!.scrollLeft, y: viewport.current!.scrollTop }
    if (!initial) return
    gesture.current = {
      kind,
      id: event.pointerId,
      initial,
      start: { x: event.clientX, y: event.clientY }
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function move(event: PointerEvent<HTMLElement>): void {
    const drag = gesture.current
    if (!drag || event.pointerId !== drag.id) return
    const dx = event.clientX - drag.start.x,
      dy = event.clientY - drag.start.y
    if (drag.kind === 'move') {
      setPosition(boundPosition({ x: drag.initial.x + dx, y: drag.initial.y + dy }))
    } else {
      viewport.current!.scrollLeft = drag.initial.x - dx
      viewport.current!.scrollTop = drag.initial.y - dy
    }
  }
  const dragEvents = {
    onPointerMove: move,
    onLostPointerCapture: () => {
      gesture.current = null
    }
  }
  return (
    <section
      ref={panel}
      tabIndex={-1}
      role="region"
      aria-label={reference}
      data-pdf-figure-preview
      className="absolute z-[45] flex h-[min(27rem,calc(100%_-_1rem))] max-h-[72%] w-[min(29rem,calc(100%_-_1rem))] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-card outline-none"
      style={{ left: position?.x ?? margin, top: position?.y ?? margin }}
    >
      <header className="flex shrink-0 items-center gap-1 border-b border-border pl-1 pr-1.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-grab touch-none select-none items-center gap-1.5 rounded-md px-1 py-2 text-left active:cursor-grabbing focus-visible:keyboard-focus"
          aria-label={t('Move preview')}
          title={t('Move preview')}
          onPointerDown={(e) => start(e, 'move')}
          {...dragEvents}
          onKeyDown={(e) => {
            const offset: Record<string, Point> = {
              ArrowLeft: { x: -16, y: 0 },
              ArrowRight: { x: 16, y: 0 },
              ArrowUp: { x: 0, y: -16 },
              ArrowDown: { x: 0, y: 16 }
            }
            const d = offset[e.key]
            if (!d || !position) return
            e.preventDefault()
            e.stopPropagation()
            setPosition(boundPosition({ x: position.x + d.x, y: position.y + d.y }))
          }}
        >
          <GripVertical className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-semibold">{reference}</span>
          <span className="truncate text-xs text-muted-foreground">
            {t('Page {{page}}', { page })}
          </span>
        </button>
        <IconButton label={t('Show in PDF')} onClick={onNavigate}>
          <ExternalLink />
        </IconButton>
        <IconButton label={t('Close')} onClick={onClose}>
          <X />
        </IconButton>
      </header>
      <div className="relative min-h-0 flex-1 bg-muted/30">
        <div
          ref={viewport}
          tabIndex={0}
          className="absolute inset-0 overflow-auto overscroll-contain outline-none focus-visible:keyboard-focus"
          style={{
            containerType: 'size',
            touchAction: 'none',
            cursor: scale > 1 ? 'grab' : 'zoom-in'
          }}
          onTouchStart={(e) => touchGesture(e.touches, true)}
          onTouchMove={(e) => touchGesture(e.touches, false)}
          onTouchEnd={(e) => touchGesture(e.touches, true)}
          onTouchCancel={() => {
            pinch.current = null
          }}
          onPointerDown={(e) => start(e, 'pan')}
          {...dragEvents}
          onDoubleClick={(e) => zoom(scale === 1 ? 2 : 1, { x: e.clientX, y: e.clientY })}
        >
          <div
            className="grid min-h-full min-w-full place-items-center"
            style={{
              width: `min(${scale * 100}cqw, ${scale * 100 * aspect}cqh)`,
              height: `min(${(scale * 100) / aspect}cqw, ${scale * 100}cqh)`
            }}
          >
            <img
              ref={picture}
              draggable={false}
              className="block select-none object-contain"
              style={{
                width: `min(${scale * 100}cqw, ${scale * 100 * aspect}cqh)`,
                maxWidth: 'none'
              }}
              onLoad={(e) => {
                const img = e.currentTarget
                if (img.naturalHeight) setAspect(img.naturalWidth / img.naturalHeight)
              }}
              src={displayingCrop ? image : (detail ?? heldPage ?? image)}
              alt={displayingCrop ? reference : t('Page {{page}}', { page })}
              onError={() => {
                if (!displayingCrop && detail) setDetail(undefined)
                else onImageError()
              }}
            />
          </div>
        </div>
      </div>
      {displayingCrop && (
        <p className="max-h-[22%] shrink-0 overflow-auto overscroll-contain border-t border-border px-3 py-2 text-xs leading-relaxed">
          {caption}
        </p>
      )}
      <footer className="flex shrink-0 items-center gap-0.5 border-t border-border px-1.5 py-0.5">
        <IconButton
          label={t('Zoom out')}
          onClick={() => zoom(Math.max(1, scale / 2))}
          disabled={scale === 1}
        >
          <Minus />
        </IconButton>
        <span className="min-w-10 text-center text-xs tabular-nums">
          {Math.round(scale * 100)}%
        </span>
        <IconButton
          label={t('Zoom in')}
          onClick={() => zoom(Math.min(8, scale * 2))}
          disabled={scale === 8}
        >
          <Plus />
        </IconButton>
        <IconButton label={t('Reset zoom')} onClick={() => zoom(1)} disabled={scale === 1}>
          <Maximize />
        </IconButton>
        {heldPage && caption && (
          <Button
            className="ml-auto"
            variant="secondary"
            size="sm"
            onClick={() => {
              setHeldPage(undefined)
              setDetail(undefined)
              zoom(1)
            }}
          >
            {t('View image')}
          </Button>
        )}
      </footer>
    </section>
  )
}
