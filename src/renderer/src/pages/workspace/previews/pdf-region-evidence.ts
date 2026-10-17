import type { AcpMessageImage } from '../../../../../shared/acp-image-contract'
import { sanitizeAcpMessageImage } from '../../../../../shared/acp-image-contract'
import type { PdfNormalizedRect } from '../../../../../shared/annotation-contract'
import { validatePdfProseRegions, type PdfProseRegion } from '../../../../../shared/pdf-text'

type NormalizedPoint = Readonly<{ x: number; y: number }>

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value))

const normalizedPdfRect = (
  start: NormalizedPoint,
  end: NormalizedPoint
): PdfNormalizedRect | undefined => {
  const left = clampUnit(Math.min(start.x, end.x))
  const top = clampUnit(Math.min(start.y, end.y))
  const right = clampUnit(Math.max(start.x, end.x))
  const bottom = clampUnit(Math.max(start.y, end.y))
  if (right - left < 0.005 || bottom - top < 0.005) return undefined
  return { x: left, y: top, width: right - left, height: bottom - top }
}

const pointInPage = (clientX: number, clientY: number, page: DOMRect): NormalizedPoint => ({
  x: clampUnit((clientX - page.left) / page.width),
  y: clampUnit((clientY - page.top) / page.height)
})

// On a 0-degree PDF.js page, the displayed viewport is the unrotated CropBox. Ratios
// already remove its origin and zoom, so these are the reader's top-left coordinates.
// Rotated pages must not reuse the annotation coordinate contract for prose reading.
const pdfProseRegionFromRect = (
  page: number,
  rotation: number,
  rect: PdfNormalizedRect,
  splitRatio: number
): PdfProseRegion | undefined => {
  if (rotation !== 0 || !Number.isFinite(splitRatio) || splitRatio <= 0 || splitRatio >= 1)
    return undefined
  const region: PdfProseRegion = {
    page,
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    split: rect.x + rect.width * splitRatio
  }
  try {
    validatePdfProseRegions([region])
    return region
  } catch {
    return undefined
  }
}

const cropPdfCanvasRegion = (
  source: HTMLCanvasElement,
  rect: PdfNormalizedRect
): AcpMessageImage | undefined => {
  if (source.width <= 0 || source.height <= 0) return undefined
  const sourceX = Math.round(rect.x * source.width)
  const sourceY = Math.round(rect.y * source.height)
  const sourceWidth = Math.max(1, Math.round(rect.width * source.width))
  const sourceHeight = Math.max(1, Math.round(rect.height * source.height))

  for (const maxSide of [1_280, 960, 720]) {
    const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight))
    const target = document.createElement('canvas')
    target.width = Math.max(1, Math.round(sourceWidth * scale))
    target.height = Math.max(1, Math.round(sourceHeight * scale))
    const context = target.getContext('2d')
    if (!context) return undefined
    context.drawImage(
      source,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      target.width,
      target.height
    )
    const dataUrl = target.toDataURL('image/png')
    const separator = dataUrl.indexOf(',')
    if (separator < 0) continue
    const image = sanitizeAcpMessageImage({
      mimeType: 'image/png',
      data: dataUrl.slice(separator + 1)
    })
    if (image) return image
  }
  return undefined
}

const textInPdfRect = (
  textLayer: HTMLElement | null,
  page: DOMRect,
  rect: PdfNormalizedRect,
  limit: number
): string | undefined => {
  if (!textLayer) return undefined
  const left = page.left + rect.x * page.width
  const top = page.top + rect.y * page.height
  const right = left + rect.width * page.width
  const bottom = top + rect.height * page.height
  const text = Array.from(textLayer.querySelectorAll<HTMLElement>('span'))
    .filter((span) => {
      const bounds = span.getBoundingClientRect()
      return (
        bounds.right > left && bounds.left < right && bounds.bottom > top && bounds.top < bottom
      )
    })
    .map((span) => span.textContent ?? '')
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return text ? text.slice(0, limit) : undefined
}

export {
  cropPdfCanvasRegion,
  normalizedPdfRect,
  pdfProseRegionFromRect,
  pointInPage,
  textInPdfRect
}
