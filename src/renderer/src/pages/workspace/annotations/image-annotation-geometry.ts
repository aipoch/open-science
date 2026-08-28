type Point = Readonly<{ x: number; y: number }>
type Size = Readonly<{ width: number; height: number }>
type Rect = Readonly<{ left: number; top: number; width: number; height: number }>

const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0
const clampUnit = (value: number): number => Math.min(1, Math.max(0, value))

// Returns the actual pixel-bearing rectangle of an object-contain image. The input rectangle may
// already include the viewer's zoom/pan transform; normalized points therefore remain independent
// from both the transform and viewport size.
const fitContainedImageRect = (viewport: Rect, naturalSize: Size): Rect | undefined => {
  if (
    !finitePositive(viewport.width) ||
    !finitePositive(viewport.height) ||
    !finitePositive(naturalSize.width) ||
    !finitePositive(naturalSize.height)
  ) {
    return undefined
  }

  const scale = Math.min(viewport.width / naturalSize.width, viewport.height / naturalSize.height)
  const width = naturalSize.width * scale
  const height = naturalSize.height * scale
  return {
    left: viewport.left + (viewport.width - width) / 2,
    top: viewport.top + (viewport.height - height) / 2,
    width,
    height
  }
}

const viewportPointToNormalized = (point: Point, imageRect: Rect): Point | undefined => {
  if (!finitePositive(imageRect.width) || !finitePositive(imageRect.height)) return undefined
  const right = imageRect.left + imageRect.width
  const bottom = imageRect.top + imageRect.height
  if (point.x < imageRect.left || point.x > right || point.y < imageRect.top || point.y > bottom) {
    return undefined
  }
  return {
    x: clampUnit((point.x - imageRect.left) / imageRect.width),
    y: clampUnit((point.y - imageRect.top) / imageRect.height)
  }
}

const normalizedPointToViewport = (point: Point, imageRect: Rect): Point => ({
  x: imageRect.left + clampUnit(point.x) * imageRect.width,
  y: imageRect.top + clampUnit(point.y) * imageRect.height
})

// Pixel coordinates identify a pixel index, not an edge coordinate: the bottom-right normalized
// corner is therefore (width - 1, height - 1). Math.round is used consistently in prompt payloads
// and read-only cards.
const normalizedPointToNaturalPixel = (point: Point, naturalSize: Size): Point => ({
  x: Math.min(
    Math.max(0, Math.round(clampUnit(point.x) * (Math.max(1, naturalSize.width) - 1))),
    Math.max(0, naturalSize.width - 1)
  ),
  y: Math.min(
    Math.max(0, Math.round(clampUnit(point.y) * (Math.max(1, naturalSize.height) - 1))),
    Math.max(0, naturalSize.height - 1)
  )
})

export {
  fitContainedImageRect,
  normalizedPointToNaturalPixel,
  normalizedPointToViewport,
  viewportPointToNormalized
}
export type { Point as ImageAnnotationPoint, Rect as ImageAnnotationRect, Size as ImageNaturalSize }
