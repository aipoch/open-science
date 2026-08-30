// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { normalizedPdfRect, pointInPage } from './pdf-region-evidence'

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
