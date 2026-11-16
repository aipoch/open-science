import type { ShapeOutline } from '../../../../../shared/pptx-edit'

type SlideSize = { cx: number; cy: number }
type SlideBox = { x: number; y: number; width: number; height: number }
type ShapeFrame = NonNullable<ShapeOutline['frame']>
type ScreenRect = { left: number; top: number; width: number; height: number }
type FrameChange = { x: number; y: number; w: number; h: number; rotationDeg: number }

const MIN_FRAME_EMU = 91_440

// Pixels per EMU for the rendered slide; the overlay and the iframe share one coordinate space.
const pixelsPerEmu = (size: SlideSize, box: SlideBox): number =>
  size.cx > 0 ? box.width / size.cx : 0

const frameToScreen = (frame: ShapeFrame, size: SlideSize, box: SlideBox): ScreenRect => {
  const scale = pixelsPerEmu(size, box)
  return {
    left: box.x + frame.x * scale,
    top: box.y + frame.y * scale,
    width: frame.w * scale,
    height: frame.h * scale
  }
}

const toChange = (frame: ShapeFrame, patch: Partial<FrameChange>): FrameChange => ({
  x: frame.x,
  y: frame.y,
  w: frame.w,
  h: frame.h,
  rotationDeg: frame.rotationDeg,
  ...patch
})

const moveFrame = (frame: ShapeFrame, dxPx: number, dyPx: number, scale: number): FrameChange =>
  scale > 0
    ? toChange(frame, {
        x: Math.round(frame.x + dxPx / scale),
        y: Math.round(frame.y + dyPx / scale)
      })
    : toChange(frame, {})

const resizeFrame = (frame: ShapeFrame, dxPx: number, dyPx: number, scale: number): FrameChange =>
  scale > 0
    ? toChange(frame, {
        w: Math.max(MIN_FRAME_EMU, Math.round(frame.w + dxPx / scale)),
        h: Math.max(MIN_FRAME_EMU, Math.round(frame.h + dyPx / scale))
      })
    : toChange(frame, {})

const sameFrame = (a: ShapeFrame, b: FrameChange): boolean =>
  a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value))

// Maps a screen-space drag onto the slide box as a 0..1 rectangle, or undefined when it is a click.
const screenRectToNormalized = (
  a: { x: number; y: number },
  b: { x: number; y: number },
  box: SlideBox
): { x: number; y: number; width: number; height: number } | undefined => {
  if (box.width <= 0 || box.height <= 0) return undefined
  const x1 = clampUnit((Math.min(a.x, b.x) - box.x) / box.width)
  const y1 = clampUnit((Math.min(a.y, b.y) - box.y) / box.height)
  const x2 = clampUnit((Math.max(a.x, b.x) - box.x) / box.width)
  const y2 = clampUnit((Math.max(a.y, b.y) - box.y) / box.height)
  return x2 - x1 < 0.01 || y2 - y1 < 0.01
    ? undefined
    : { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

const normalizedToScreen = (
  region: { x: number; y: number; width: number; height: number },
  box: SlideBox
): ScreenRect => ({
  left: box.x + region.x * box.width,
  top: box.y + region.y * box.height,
  width: region.width * box.width,
  height: region.height * box.height
})

export {
  frameToScreen,
  MIN_FRAME_EMU,
  moveFrame,
  normalizedToScreen,
  pixelsPerEmu,
  resizeFrame,
  sameFrame,
  screenRectToNormalized
}
export type { FrameChange, ScreenRect, SlideBox, SlideSize }
