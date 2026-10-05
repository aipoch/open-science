import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const { nativeFramedPanelArray } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-figure-connectivity.mjs')).href
)
it('retains both complete native panel groups despite their fused heading runs', () => {
  const f = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/native-panel-array-with-fused-small-headings.jsonl'
    )
  )
  const result = associateFigures(f.page, f.captions, [], f.rules)
  expect(result).toHaveLength(1)
  expect(result[0].rect).toEqual([112.359375, 210.375, 502.03125, 612.5625])
})
const graphic = (rect: number[], kind = 'path'): { kind: string; normalizedRect: number[] } => ({
  kind,
  normalizedRect: rect.map((v, i) => v / (i % 2 ? 800 : 600))
})
const caption = (
  lines: string[],
  rect: number[]
): { page: number; lines: string[]; rect: number[] } => ({ page: 1, lines, rect })
it('keeps all raster rows above a centered Continue caption under its original number', () => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    rotation: 0,
    invalidGraphicsBounds: 0,
    lines: [],
    graphicsBounds: [
      [70, 110, 310, 380],
      [305, 110, 545, 380],
      [70, 380, 310, 640],
      [305, 380, 545, 640]
    ].map((r) => graphic(r, 'image'))
  }
  const c = caption(['Figure 8. Continue'], [260, 646, 350, 655])
  const f = associateFigures(page, [c])[0]
  f.rect.forEach((v: number, i: number) => expect(v).toBeCloseTo([70, 110, 545, 640][i], 8))
  expect(f.caption.lines).toEqual(c.lines)
})
it('does not use a noncentered Continue marker to own distant raster panels', () => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    rotation: 0,
    invalidGraphicsBounds: 0,
    lines: [],
    graphicsBounds: [
      [70, 110, 310, 380],
      [305, 110, 545, 380],
      [70, 380, 310, 640],
      [305, 380, 545, 640]
    ].map((r) => graphic(r, 'image'))
  }
  const f = associateFigures(page, [caption(['Figure 8. Continue'], [40, 646, 120, 655])])[0]
  expect(f.rect).toBeUndefined()
})

it('recovers two same-row raster panels when the first association leaves the caption unresolved', () => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    rotation: 0,
    invalidGraphicsBounds: 0,
    lines: [],
    graphicsBounds: [
      [70, 110, 300, 360],
      [305, 110, 535, 360]
    ].map((r) => graphic(r, 'image'))
  }
  const result = associateFigures(page, [
    caption(['Figure 9. Paired plots.'], [70, 372, 535, 392])
  ])[0]
  expect(result.rect).toHaveLength(4)
  result.rect.forEach((value: number, index: number) =>
    expect(value).toBeCloseTo([70, 110, 535, 360][index])
  )
})
const arrayInput = (): {
  page: {
    pageNumber: number
    width: number
    height: number
    rotation: number
    invalidGraphicsBounds: number
    lines: { text: string; x: number; y: number; width: number; height: number; fontSize: number }[]
    graphicsBounds: ReturnType<typeof graphic>[]
  }
  rules: number[][]
  captions: ReturnType<typeof caption>[]
} => {
  const frames = Array.from({ length: 8 }, (_, i) => {
    const x = 100 + (i % 4) * 100,
      y = 210 + Math.floor(i / 4) * 100
    return [x, y, x + 90, y + 90]
  })
  const rules = frames.flatMap(([x, y, r, b]) => [
    [x, y, r, y],
    [x, b, r, b],
    [x, y, x, b],
    [r, y, r, b]
  ])
  const graphics = frames
    .flatMap(([x, y, r, b]) => [
      [x, y, r, b],
      ...[1, 2, 3, 4].map((k) => [x + 10, y + k * 15, r - 10, y + k * 15 + 8])
    ])
    .map((r) => graphic(r))
  graphics.push(graphic([98, 194, 492, 402]))
  const lines = [
    { text: 'Label '.repeat(17), x: 105, y: 197, width: 380, height: 5, fontSize: 5 },
    { text: 'Label '.repeat(17), x: 105, y: 295, width: 380, height: 5, fontSize: 5 },
    { text: 'Label '.repeat(17), x: 105, y: 393, width: 380, height: 5, fontSize: 5 }
  ]
  return {
    page: {
      pageNumber: 1,
      width: 600,
      height: 800,
      rotation: 0,
      invalidGraphicsBounds: 0,
      lines,
      graphicsBounds: graphics
    },
    rules,
    captions: [caption(['Figure 1. Native panel array.'], [80, 410, 520, 430])]
  }
}
it('keeps the upper row of a closed native panel array with fused small-font headings', () => {
  const f = arrayInput(),
    r = associateFigures(f.page, f.captions, [], f.rules)[0]
  expect(r.rect[1]).toBeLessThanOrEqual(197)
  expect(r.rect[3]).toBeGreaterThanOrEqual(400)
})
it.each(['missing-edges', 'empty-panels', 'competing-table'])(
  'does not recover a native array without full proof: %s',
  (variant) => {
    const f = arrayInput()
    if (variant === 'missing-edges') f.rules = f.rules.filter((r) => r[0] !== r[2])
    if (variant === 'empty-panels')
      f.page.graphicsBounds = f.page.graphicsBounds.filter(
        (g) => g.normalizedRect[2] - g.normalizedRect[0] > 0.14
      )
    const r = nativeFramedPanelArray(
      f.page,
      f.captions,
      variant === 'competing-table' ? [[90, 190, 500, 405]] : [],
      f.rules
    )
    expect(r).toBeUndefined()
  }
)
