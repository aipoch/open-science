import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { OfficePreviewSlideView } from '../../../../../shared/office-preview'
import type { DeckOutline, ShapeOutline } from '../../../../../shared/pptx-edit'
import {
  frameToScreen,
  moveFrame,
  pixelsPerEmu,
  resizeFrame,
  sameFrame,
  type FrameChange
} from './pptx-edit-geometry'

// Pictures are replaced from the toolbar; these kinds open an in-place text editor.
const EDITABLE_KINDS: ReadonlySet<ShapeOutline['kind']> = new Set(['text', 'table', 'chart'])

type Drag = {
  shapeId: number
  mode: 'move' | 'resize'
  startX: number
  startY: number
  dx: number
  dy: number
}

type PptxSelectionOverlayProps = {
  outline: DeckOutline
  slideIndex: number
  slideView: OfficePreviewSlideView | undefined
  selectedShapeId: number | undefined
  disabled: boolean
  onSelect: (shapeId: number | undefined) => void
  onFrameChange: (shapeId: number, change: FrameChange) => void
  onEditText: (shapeId: number) => void
}

const framedShapes = (shapes: readonly ShapeOutline[]): ShapeOutline[] =>
  shapes.filter((shape) => shape.frame !== undefined)

const draggedFrame = (shape: ShapeOutline, drag: Drag | undefined, scale: number): FrameChange => {
  const frame = shape.frame!
  if (!drag || drag.shapeId !== shape.shapeId) return { ...frame }
  return drag.mode === 'move'
    ? moveFrame(frame, drag.dx, drag.dy, scale)
    : resizeFrame(frame, drag.dx, drag.dy, scale)
}

const PptxSelectionOverlay = ({
  outline,
  slideIndex,
  slideView,
  selectedShapeId,
  disabled,
  onSelect,
  onFrameChange,
  onEditText
}: PptxSelectionOverlayProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [hoveredShapeId, setHoveredShapeId] = useState<number>()
  const [drag, setDrag] = useState<Drag>()
  const dragRef = useRef<Drag | undefined>(undefined)
  const slide = outline.slides[slideIndex]
  if (!slide || !slideView || slideView.slideIndex !== slideIndex) return null
  const scale = pixelsPerEmu(outline.slideSize, slideView)

  const start = (event: React.PointerEvent, shapeId: number, mode: Drag['mode']): void => {
    if (disabled || event.button !== 0) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    onSelect(shapeId)
    const next = { shapeId, mode, startX: event.clientX, startY: event.clientY, dx: 0, dy: 0 }
    dragRef.current = next
    setDrag(next)
  }
  const track = (event: React.PointerEvent): void => {
    const current = dragRef.current
    if (!current) return
    const next = {
      ...current,
      dx: event.clientX - current.startX,
      dy: event.clientY - current.startY
    }
    dragRef.current = next
    setDrag(next)
  }
  const finish = (shape: ShapeOutline): void => {
    const current = dragRef.current
    dragRef.current = undefined
    setDrag(undefined)
    if (!current || !shape.frame) return
    const change = draggedFrame(shape, current, scale)
    if (!sameFrame(shape.frame, change)) onFrameChange(shape.shapeId, change)
  }

  return (
    <div data-testid="pptx-selection-overlay" className="pointer-events-none absolute inset-0 z-20">
      {framedShapes(slide.shapes).map((shape) => {
        const change = draggedFrame(shape, drag, scale)
        const rect = frameToScreen(change, outline.slideSize, slideView)
        const selected = shape.shapeId === selectedShapeId
        return (
          <div
            key={shape.shapeId}
            role="button"
            tabIndex={-1}
            aria-label={t('Slide shape {{name}}', { name: shape.name })}
            aria-pressed={selected}
            data-shape-id={shape.shapeId}
            data-hovered={!disabled && hoveredShapeId === shape.shapeId ? '' : undefined}
            className={`pointer-events-auto absolute touch-none ${selected ? 'outline-2 outline-primary' : !disabled && hoveredShapeId === shape.shapeId && !drag ? 'outline-1 outline-primary' : ''} ${disabled ? 'cursor-default' : 'cursor-move'}`}
            onPointerEnter={() => setHoveredShapeId(shape.shapeId)}
            onPointerLeave={() => setHoveredShapeId(undefined)}
            style={{
              ...rect,
              transform: `rotate(${change.rotationDeg}deg)`
            }}
            onPointerDown={(event) => start(event, shape.shapeId, 'move')}
            onPointerMove={track}
            onPointerUp={() => finish(shape)}
            onPointerCancel={() => {
              dragRef.current = undefined
              setDrag(undefined)
            }}
            onDoubleClick={() => {
              if (!disabled && EDITABLE_KINDS.has(shape.kind)) onEditText(shape.shapeId)
            }}
          >
            {selected && !disabled ? (
              <div
                aria-hidden="true"
                className="absolute -right-1.5 -bottom-1.5 size-3 cursor-nwse-resize rounded-sm border border-primary bg-background"
                onPointerDown={(event) => start(event, shape.shapeId, 'resize')}
                onPointerMove={track}
                onPointerUp={() => finish(shape)}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

export { PptxSelectionOverlay }
export type { PptxSelectionOverlayProps }
