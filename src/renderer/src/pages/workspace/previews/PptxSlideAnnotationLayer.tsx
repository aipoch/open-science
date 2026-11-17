import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { PdfNormalizedRect } from '../../../../../shared/annotation-contract'
import type { OfficePreviewSlideView } from '../../../../../shared/office-preview'
import type { DeckOutline, ShapeOutline } from '../../../../../shared/pptx-edit'
import {
  frameToScreen,
  normalizedToScreen,
  screenRectToNormalized,
  type ScreenRect,
  type SlideBox
} from './pptx-edit-geometry'

type SlidePick = { shapeId?: number; region?: PdfNormalizedRect }

type SlideMarker = { id: string; number: number; shapeId?: number; region?: PdfNormalizedRect }

type Point = { x: number; y: number }

const insideRect = (point: Point, rect: ScreenRect): boolean =>
  point.x >= rect.left &&
  point.y >= rect.top &&
  point.x <= rect.left + rect.width &&
  point.y <= rect.top + rect.height

// Later shapes paint on top, so the last framed hit is the one the user sees.
const shapeAt = (
  shapes: readonly ShapeOutline[],
  point: Point,
  outline: DeckOutline,
  box: SlideBox
): ShapeOutline | undefined =>
  [...shapes]
    .reverse()
    .find(
      (shape) =>
        shape.frame && insideRect(point, frameToScreen(shape.frame, outline.slideSize, box))
    )

const SLIDE_BADGE_RECT: ScreenRect = { left: 4, top: 4, width: 20, height: 20 }

// A marker outlines its region or shape; a slide-wide note gets a corner badge.
const markerRect = (
  marker: SlideMarker,
  shapes: readonly ShapeOutline[],
  outline: DeckOutline,
  box: SlideBox
): ScreenRect => {
  if (marker.region) return normalizedToScreen(marker.region, box)
  const frame = shapes.find((shape) => shape.shapeId === marker.shapeId)?.frame
  return frame ? frameToScreen(frame, outline.slideSize, box) : SLIDE_BADGE_RECT
}

type PptxSlideAnnotationLayerProps = {
  outline: DeckOutline
  slideIndex: number
  slideView: OfficePreviewSlideView | undefined
  markers: readonly SlideMarker[]
  revealedId?: string
  active: boolean
  disabled: boolean
  onPick: (pick: SlidePick) => void
}

const PptxSlideAnnotationLayer = ({
  outline,
  slideIndex,
  slideView,
  markers,
  revealedId,
  active,
  disabled,
  onPick
}: PptxSlideAnnotationLayerProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const startRef = useRef<Point | undefined>(undefined)
  const [drag, setDrag] = useState<{ a: Point; b: Point }>()
  const slide = outline.slides[slideIndex]
  if (!slide || !slideView || slideView.slideIndex !== slideIndex) return null
  // Pointer coordinates are local to the slide box, so geometry uses a zero-origin box.
  const box: SlideBox = { x: 0, y: 0, width: slideView.width, height: slideView.height }
  const local = (event: React.PointerEvent<HTMLElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
  }
  const finish = (event: React.PointerEvent<HTMLElement>): void => {
    const a = startRef.current
    startRef.current = undefined
    setDrag(undefined)
    if (!a || disabled) return
    const b = local(event)
    const region = screenRectToNormalized(a, b, box)
    if (region) return onPick({ region })
    const shape = shapeAt(slide.shapes, b, outline, box)
    onPick(shape ? { shapeId: shape.shapeId } : {})
  }

  const dragRect = drag ? screenRectToNormalized(drag.a, drag.b, box) : undefined

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      <div
        data-testid="pptx-slide-annotation-layer"
        aria-label={t('Annotate slide')}
        className={`absolute touch-none ${active && !disabled ? 'pointer-events-auto cursor-crosshair' : ''}`}
        style={{ left: slideView.x, top: slideView.y, width: box.width, height: box.height }}
        onPointerDown={(event) => {
          if (!active || disabled || event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          startRef.current = local(event)
        }}
        onPointerMove={(event) => {
          const a = startRef.current
          if (a) setDrag({ a, b: local(event) })
        }}
        onPointerUp={finish}
        onPointerCancel={() => {
          startRef.current = undefined
          setDrag(undefined)
        }}
      >
        {markers.map((marker) => {
          const rect = markerRect(marker, slide.shapes, outline, box)
          return (
            <div
              key={marker.id}
              data-annotation-marker={marker.id}
              data-revealed={marker.id === revealedId ? '' : undefined}
              className={`pointer-events-none absolute rounded-sm border-2 border-accent-main-100 ${marker.id === revealedId ? 'bg-accent-main-100/15 ring-2 ring-accent-main-100/40' : ''}`}
              style={rect}
            >
              <span className="absolute -top-2 -left-2 flex size-4 items-center justify-center rounded-full bg-accent-main-100 text-[10px] font-medium text-white">
                {marker.number}
              </span>
            </div>
          )
        })}
        {dragRect ? (
          <div
            className="pointer-events-none absolute border border-dashed border-accent-main-100 bg-accent-main-100/10"
            style={normalizedToScreen(dragRect, box)}
          />
        ) : null}
      </div>
    </div>
  )
}

export { PptxSlideAnnotationLayer }
export type { PptxSlideAnnotationLayerProps, SlideMarker, SlidePick }
