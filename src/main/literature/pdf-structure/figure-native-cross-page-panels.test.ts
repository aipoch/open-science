import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { associateAdjacentFigure } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const line = (
  text: string,
  x: number,
  y: number,
  width: number
): { text: string; x: number; y: number; width: number; height: number; fontSize: number } => ({
  text,
  x,
  y,
  width,
  height: 12,
  fontSize: 12
})
type NativePage = {
  pageNumber: number
  width: number
  height: number
  rotation: number
  invalidGraphicsBounds: number
  lines: ReturnType<typeof line>[]
  graphicsBounds: { kind: string; normalizedRect: number[] }[]
}
const input = (): {
  page: NativePage
  pages: NativePage[]
  captions: { page: number; lines: string[]; rect: number[] }[]
  rules: number[][]
  closedFrames: number[][]
} => {
  const outer = [120, 155, 490, 435],
    page = {
      pageNumber: 1,
      width: 600,
      height: 800,
      rotation: 0,
      invalidGraphicsBounds: 0,
      lines: [line('(a)', 94, 180, 16)],
      graphicsBounds: [
        outer,
        ...Array.from({ length: 24 }, (_, i) => [
          160 + (i % 6) * 40,
          190 + Math.floor(i / 6) * 45,
          190 + (i % 6) * 40,
          215 + Math.floor(i / 6) * 45
        ])
      ].map((rect) => ({
        kind: 'path',
        normalizedRect: rect.map((v, i) => v / (i % 2 ? 800 : 600))
      }))
    }
  const next = {
    ...page,
    pageNumber: 2,
    lines: [line('(b)', 94, 98, 16)],
    graphicsBounds: [
      { kind: 'image', normalizedRect: [120 / 600, 70 / 800, 490 / 600, 350 / 800] },
      { kind: 'path', normalizedRect: [87 / 600, 95 / 800, 119 / 600, 121 / 800] }
    ]
  }
  return {
    page,
    pages: [page, next],
    captions: [
      {
        page: 2,
        lines: ['Figure S2. (a) First panel. (b) Second panel.'],
        rect: [72, 382, 535, 410]
      }
    ],
    rules: [
      [150, 180, 450, 180],
      [150, 400, 450, 400],
      [150, 180, 150, 400],
      [450, 180, 450, 400]
    ],
    closedFrames: [[87, 177, 119, 203]]
  }
}
it('retains the first native labelled panel when the next page owns its second panel and shared caption', () => {
  const f = input(),
    r = associateAdjacentFigure(f.page, f.pages, f.captions, f.rules, f.closedFrames)
  expect(r).toHaveLength(1)
  expect(r[0].caption.page).toBe(2)
  expect(r[0].rect[0]).toBeLessThanOrEqual(87)
  expect(r[0].rect[1]).toBeLessThanOrEqual(155)
  expect(r[0].rect[3]).toBeCloseTo(435, 8)
})
it.each([
  'missing-axis-edge',
  'unboxed-mark',
  'wrong-peer',
  'caption-without-pair',
  'competing-caption'
])('rejects a cross-page panel without unique native pair proof: %s', (variant) => {
  const f = input()
  if (variant === 'missing-axis-edge') f.rules.pop()
  if (variant === 'unboxed-mark') f.closedFrames = []
  if (variant === 'wrong-peer') f.pages[1].lines[0].text = '(c)'
  if (variant === 'caption-without-pair') f.captions[0].lines = ['Figure S2. Second panel.']
  if (variant === 'competing-caption')
    f.captions.push({ ...f.captions[0], lines: ['Figure S3. (a) First panel. (b) Second panel.'] })
  expect(associateAdjacentFigure(f.page, f.pages, f.captions, f.rules, f.closedFrames)).toEqual([])
})
