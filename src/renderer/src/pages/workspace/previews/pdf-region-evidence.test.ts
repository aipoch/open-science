// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { MAX_ACP_MESSAGE_IMAGE_BYTES } from '../../../../../shared/acp'

import {
  cropPdfCanvasRegion,
  normalizedPdfRect,
  pointInPage,
  textInPdfRect
} from './pdf-region-evidence'

afterEach(() => vi.restoreAllMocks())

describe('PDF region Evidence geometry', () => {
  it('stores drag geometry in page-normalized coordinates independent of zoom', () => {
    const page = { left: 100, top: 50, width: 800, height: 1_000 } as DOMRect

    const rect = normalizedPdfRect(pointInPage(700, 850, page), pointInPage(300, 250, page))

    expect(rect).toMatchObject({ x: 0.25, y: 0.2, width: 0.5 })
    expect(rect?.height).toBeCloseTo(0.6)
    const zoomed = normalizedPdfRect(
      pointInPage(1_300, 1_650, { ...page, width: 1_600, height: 2_000 } as DOMRect),
      pointInPage(500, 450, { ...page, width: 1_600, height: 2_000 } as DOMRect)
    )
    expect(zoomed?.x).toBeCloseTo(rect!.x)
    expect(zoomed?.y).toBeCloseTo(rect!.y)
    expect(zoomed?.width).toBeCloseTo(rect!.width)
    expect(zoomed?.height).toBeCloseTo(rect!.height)
  })

  it('rejects accidental clicks and clamps points to the page', () => {
    const page = { left: 100, top: 50, width: 800, height: 1_000 } as DOMRect
    expect(
      normalizedPdfRect(pointInPage(200, 200, page), pointInPage(202, 202, page))
    ).toBeUndefined()
    expect(pointInPage(0, 2_000, page)).toEqual({ x: 0, y: 1 })
  })
})

describe('PDF region image evidence', () => {
  const pngData = 'iVBORw0KGgo='
  const fullPage = { x: 0, y: 0, width: 1, height: 1 }

  const canvas = (width: number, height: number): HTMLCanvasElement => {
    const element = document.createElement('canvas')
    element.width = width
    element.height = height
    return element
  }

  const drawing = (): {
    drawImage: ReturnType<typeof vi.fn>
    encode: MockInstance<HTMLCanvasElement['toDataURL']>
  } => {
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage
    } as unknown as CanvasRenderingContext2D)
    const encode = vi
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue(`data:image/png;base64,${pngData}`)
    return { drawImage, encode }
  }

  it('crops source pixels and downscales the longest side without changing aspect ratio', () => {
    const { drawImage, encode } = drawing()
    const page = canvas(4000, 2000)
    const result = cropPdfCanvasRegion(page, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 })
    expect(drawImage).toHaveBeenCalledExactlyOnceWith(page, 1000, 500, 2000, 1000, 0, 0, 1280, 640)
    expect(encode).toHaveBeenCalledExactlyOnceWith('image/png')
    expect(result).toEqual({ mimeType: 'image/png', data: pngData, byteLength: 8 })
  })

  it('does not upscale a small crop and rounds subpixel crops to at least one pixel', () => {
    const { drawImage } = drawing()
    const page = canvas(100, 80)
    cropPdfCanvasRegion(page, { x: 0.125, y: 0.125, width: 0.2, height: 0.25 })
    expect(drawImage).toHaveBeenNthCalledWith(1, page, 13, 10, 20, 20, 0, 0, 20, 20)
    cropPdfCanvasRegion(page, { x: 0, y: 0, width: 0.001, height: 0.001 })
    expect(drawImage).toHaveBeenNthCalledWith(2, page, 0, 0, 1, 1, 0, 0, 1, 1)
  })

  it.each([
    [0, 100],
    [100, 0]
  ])('rejects a %i by %i source before drawing', (width, height) => {
    const { drawImage, encode } = drawing()
    expect(cropPdfCanvasRegion(canvas(width, height), fullPage)).toBeUndefined()
    expect(drawImage).not.toHaveBeenCalled()
    expect(encode).not.toHaveBeenCalled()
  })

  it('returns no evidence when the canvas context is unavailable', () => {
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL')
    expect(cropPdfCanvasRegion(canvas(100, 100), fullPage)).toBeUndefined()
    expect(context).toHaveBeenCalledExactlyOnceWith('2d')
    expect(encode).not.toHaveBeenCalled()
  })

  it('retries an oversized image at smaller dimensions using the real image validator', () => {
    const { drawImage, encode } = drawing()
    const oversized = 'A'.repeat(4 * Math.ceil((MAX_ACP_MESSAGE_IMAGE_BYTES + 1) / 3))
    encode.mockReturnValueOnce(`data:image/png;base64,${oversized}`)
    const page = canvas(2000, 4000)
    expect(cropPdfCanvasRegion(page, fullPage)).toMatchObject({ data: pngData, byteLength: 8 })
    expect(drawImage).toHaveBeenNthCalledWith(1, page, 0, 0, 2000, 4000, 0, 0, 640, 1280)
    expect(drawImage).toHaveBeenNthCalledWith(2, page, 0, 0, 2000, 4000, 0, 0, 480, 960)
    expect(encode).toHaveBeenCalledTimes(2)
  })

  it('exhausts three bounded attempts when image encoding produces unusable data', () => {
    const { drawImage, encode } = drawing()
    encode
      .mockReturnValueOnce('data:')
      .mockReturnValueOnce('data:image/png;base64,invalid!')
      .mockReturnValueOnce('data:image/png;base64,')
    const page = canvas(2000, 1000)
    expect(cropPdfCanvasRegion(page, fullPage)).toBeUndefined()
    expect(encode).toHaveBeenCalledTimes(3)
    expect(drawImage).toHaveBeenNthCalledWith(3, page, 0, 0, 2000, 1000, 0, 0, 720, 360)
  })
})

describe('PDF region text evidence', () => {
  const page = new DOMRect(100, 50, 800, 1000)
  const rect = { x: 0.25, y: 0.2, width: 0.5, height: 0.4 }

  it('extracts intersecting spans in document order, normalizes whitespace and bounds the quote', () => {
    const layer = document.createElement('div')
    const spans: Array<[string, DOMRect]> = [
      ['  alpha\n ', new DOMRect(290, 260, 30, 20)],
      ['outside-left', new DOMRect(200, 260, 100, 20)],
      ['outside-right', new DOMRect(700, 260, 20, 20)],
      ['outside-top', new DOMRect(320, 230, 20, 20)],
      ['outside-bottom', new DOMRect(320, 650, 20, 20)],
      ['beta\t gamma', new DOMRect(680, 630, 40, 40)]
    ]
    for (const [text, bounds] of spans) {
      const span = document.createElement('span')
      span.textContent = text
      vi.spyOn(span, 'getBoundingClientRect').mockReturnValue(bounds)
      layer.append(span)
    }
    expect(textInPdfRect(layer, page, rect, 100)).toBe('alpha beta gamma')
    expect(textInPdfRect(layer, page, rect, 10)).toBe('alpha beta')
  })

  it('returns no quote for missing layers, empty selections and whitespace-only spans', () => {
    expect(textInPdfRect(null, page, rect, 100)).toBeUndefined()
    const layer = document.createElement('div')
    expect(textInPdfRect(layer, page, rect, 100)).toBeUndefined()
    const span = document.createElement('span')
    span.textContent = ' \n\t '
    vi.spyOn(span, 'getBoundingClientRect').mockReturnValue(new DOMRect(310, 260, 20, 20))
    layer.append(span)
    expect(textInPdfRect(layer, page, rect, 100)).toBeUndefined()
  })
})
