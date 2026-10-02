import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { collectGraphicsBounds } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-graphics.mjs')).href
)
const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
const raster = (
  rgba = false
): { width: number; height: number; kind: number; data: Uint8Array } => {
  const channels = rgba ? 4 : 3,
    data = new Uint8Array(10 * 10 * channels).fill(255)
  for (let y = 2; y < 8; y++)
    for (let x = 2; x < 8; x++) {
      const i = (y * 10 + x) * channels
      data[i] = 0
    }
  return { width: 10, height: 10, kind: rgba ? 3 : 2, data }
}
const collect = (
  decoded: ReturnType<typeof raster>,
  matrix = [100, 0, 0, 100, 0, 0],
  viewport = true
): { paintedNormalizedRect?: number[]; normalizedRect: number[] } => {
  const internal = {
    operatorList: {
      fnArray: [OPS.transform, OPS.paintImageXObject],
      argsArray: [matrix, ['image']]
    },
    objs: { has: () => true, get: () => decoded },
    params: viewport
      ? { viewport: { width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100] } }
      : {}
  }
  return collectGraphicsBounds(
    { _internalRenderTask: internal },
    { isEmpty: () => false, minX: () => 0, minY: () => 0, maxX: () => 1, maxY: () => 1 }
  ).graphicsBounds[0]
}
it.each([false, true])('records only provable white raster borders (rgba=%s)', (rgba) => {
  const g = collect(raster(rgba))
  expect(g.paintedNormalizedRect).toEqual([0.1, 0.1, 0.9, 0.9])
  expect(g.normalizedRect).toEqual([0, 0, 1, 1])
})

it('proves complete blank edge strips within the inspection budget of an already decoded large raster', () => {
  const width = 4100,
    height = 4000,
    data = new Uint8Array(width * height * 3)
  data.fill(255, 0, width * 3 * 2)
  data.fill(255, width * 3 * (height - 2))
  const g = collect({ width, height, kind: 2, data })
  expect(g.paintedNormalizedRect?.[0]).toBe(0)
  expect(g.paintedNormalizedRect?.[1]).toBeCloseTo(1 / height, 12)
  expect(g.paintedNormalizedRect?.[2]).toBe(1)
  expect(g.paintedNormalizedRect?.[3]).toBeCloseTo((height - 1) / height, 12)
  expect(g.normalizedRect).toEqual([0, 0, 1, 1])
})

it('does not assume unfinished strips in an all-white raster beyond the inspection budget', () => {
  const width = 4100,
    height = 4000,
    data = new Uint8Array(width * height * 3).fill(255)
  expect(collect({ width, height, kind: 2, data }).paintedNormalizedRect).toBeUndefined()
})
it.each(['border-ink', 'off-white', 'skew', 'rotate', 'missing-viewport', 'short-buffer'])(
  'preserves complete raster bounds without a strict decoded border proof: %s',
  (variant) => {
    const r = raster(),
      matrix = [100, 0, 0, 100, 0, 0]
    if (variant === 'border-ink')
      for (let y = 0; y < 10; y++)
        for (let x = 0; x < 10; x++)
          if (x === 0 || x === 9 || y === 0 || y === 9) r.data[(y * 10 + x) * 3] = 0
    if (variant === 'off-white')
      for (let i = 0; i < r.data.length; i++) if (r.data[i] === 255) r.data[i] = 254
    if (variant === 'skew') matrix[1] = 1
    if (variant === 'rotate') {
      matrix[0] = 0
      matrix[1] = 100
      matrix[2] = -100
      matrix[3] = 0
    }
    if (variant === 'short-buffer') r.data = new Uint8Array(3)
    const g = collect(r, matrix, variant !== 'missing-viewport')
    expect(g.paintedNormalizedRect).toBeUndefined()
  }
)
it('treats fully transparent pixels as unpainted and retains partially opaque pixels', () => {
  const r = raster(true)
  for (let y = 0; y < 10; y++)
    for (let x = 0; x < 10; x++)
      if (x < 2 || x >= 8 || y < 2 || y >= 8) {
        const i = (y * 10 + x) * 4
        r.data[i] = 0
        r.data[i + 3] = 0
      }
  expect(collect(r).paintedNormalizedRect).toEqual([0.1, 0.1, 0.9, 0.9])
  r.data[3] = 1
  expect(collect(r).paintedNormalizedRect?.slice(0, 2)).toEqual([0, 0])
})
it('does not scan decoded rasters beyond its independent pixel budget', () => {
  const r = { width: 4001, height: 4000, kind: 2, data: new Uint8Array(4001 * 4000 * 3) }
  expect(collect(r).paintedNormalizedRect).toBeUndefined()
})
