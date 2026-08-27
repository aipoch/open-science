import { describe, expect, it } from 'vitest'

import {
  fitContainedImageRect,
  normalizedPointToNaturalPixel,
  normalizedPointToViewport,
  viewportPointToNormalized
} from './image-annotation-geometry'

describe('image annotation geometry', () => {
  it.each([
    {
      name: 'horizontal letterbox',
      viewport: { left: 10, top: 20, width: 400, height: 400 },
      naturalSize: { width: 800, height: 400 },
      expected: { left: 10, top: 120, width: 400, height: 200 }
    },
    {
      name: 'vertical letterbox',
      viewport: { left: 10, top: 20, width: 400, height: 200 },
      naturalSize: { width: 400, height: 800 },
      expected: { left: 160, top: 20, width: 100, height: 200 }
    },
    {
      name: 'matching aspect ratio',
      viewport: { left: -20, top: 8, width: 640, height: 360 },
      naturalSize: { width: 1920, height: 1080 },
      expected: { left: -20, top: 8, width: 640, height: 360 }
    }
  ])('fits the real image content for $name', ({ viewport, naturalSize, expected }) => {
    expect(fitContainedImageRect(viewport, naturalSize)).toEqual(expected)
  })

  it.each([
    { point: { x: 10, y: 120 }, expected: { x: 0, y: 0 } },
    { point: { x: 210, y: 220 }, expected: { x: 0.5, y: 0.5 } },
    { point: { x: 410, y: 320 }, expected: { x: 1, y: 1 } },
    { point: { x: 210, y: 119.99 }, expected: undefined },
    { point: { x: 9.99, y: 220 }, expected: undefined },
    { point: { x: 410.01, y: 220 }, expected: undefined }
  ])('maps only real image pixels for $point', ({ point, expected }) => {
    expect(
      viewportPointToNormalized(point, { left: 10, top: 120, width: 400, height: 200 })
    ).toEqual(expected)
  })

  it.each([
    { point: { x: 0, y: 0 }, expected: { x: 0, y: 0 } },
    { point: { x: 0.5, y: 0.5 }, expected: { x: 600, y: 400 } },
    { point: { x: 1, y: 1 }, expected: { x: 1199, y: 799 } },
    { point: { x: -0.2, y: 1.2 }, expected: { x: 0, y: 799 } },
    { point: { x: 0.5005, y: 0.499 }, expected: { x: 600, y: 399 } }
  ])('rounds and clamps $point to a natural pixel', ({ point, expected }) => {
    expect(normalizedPointToNaturalPixel(point, { width: 1200, height: 800 })).toEqual(expected)
  })

  it('round-trips normalized positions through the displayed content rectangle', () => {
    const rect = { left: 34.5, top: -18, width: 734, height: 412 }
    const point = { x: 0.237, y: 0.819 }
    const viewportPoint = normalizedPointToViewport(point, rect)

    expect(viewportPointToNormalized(viewportPoint, rect)?.x).toBeCloseTo(point.x)
    expect(viewportPointToNormalized(viewportPoint, rect)?.y).toBeCloseTo(point.y)
  })
})
