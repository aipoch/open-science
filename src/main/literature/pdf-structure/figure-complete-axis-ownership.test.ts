import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { nativeCompleteAxisFigure } = await import(
  pathToFileURL(
    resolve('resources/pdf-structure/literature-pdf-figure-complete-axis-ownership.mjs')
  ).href
)
type Input = ReturnType<typeof JSON.parse>
const input = (): Input => {
  const caption = { page: 1, lines: ['Figure 1. Independent plots.'], rect: [40, 270, 250, 282] }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [{ text: caption.lines[0], x: 40, y: 270, width: 210, height: 10, fontSize: 10 }],
    graphicsBounds: []
  }
  const tokens: Input[] = [],
    rules: number[][] = []
  const add = (text: string, rect: number[], height = 8): void => {
    tokens.push({ text, rect, height, horizontal: true, baseline: rect[3] })
  }
  const path = (r: number[]): void => {
    page.graphicsBounds.push({
      kind: 'path',
      normalizedRect: r.map((v, i) => v / (i % 2 ? 800 : 600))
    } as never)
  }
  rules.push([100, 80, 250, 80], [100, 230, 250, 230], [100, 80, 100, 230], [250, 80, 250, 230])
  path([101, 81, 249, 229])
  path([120, 100, 126, 108])
  path([160, 140, 166, 148])
  path([195, 160, 201, 168])
  for (let n = 0; n < 5; n++) add(String(n), [85, 90 + n * 25, 94, 98 + n * 25])
  add('Axis label', [130, 242, 210, 250])
  for (let n = 0; n < 3; n++)
    add(
      'An independent paragraph owns this complete physical line.',
      [340, 65 + n * 13, 535, 76 + n * 13],
      11
    )
  return {
    page,
    caption,
    captions: [caption],
    tables: [],
    rules,
    tokens,
    oldBounds: [60, 50, 535, 260]
  }
}
const run = (f: Input): Input =>
  nativeCompleteAxisFigure(f.page, f.caption, f.captions, f.tables, f.rules, f.tokens, f.oldBounds)
it('shrinks only the independently proven prose side of a populated native axis', () => {
  const f = input(),
    r = run(f)
  expect(r.rect[2]).toBeLessThan(300)
  expect(r.rect[0]).toBeLessThanOrEqual(85)
  expect(r.rect[3]).toBeGreaterThanOrEqual(250)
})
it('preserves the existing enclosing path margins and drawn outer border', () => {
  const f = input(),
    container = [65, 55, 285, 260]
  f.page.graphicsBounds.push({
    kind: 'path',
    normalizedRect: container.map((v: number, i: number) => v / (i % 2 ? 800 : 600))
  })
  for (const [i, v] of container.entries()) expect(run(f).rect[i]).toBeCloseTo(v, 10)
})
it('preserves an unequal-height native pair without borrowing a following figure', () => {
  const f = input()
  f.oldBounds = [60, 50, 590, 260]
  f.tokens = f.tokens.filter((t: Input) => t.height !== 11)
  for (let n = 0; n < 2; n++)
    f.tokens.push({
      text: 'Independent prose above the completed plate.',
      rect: [70, 40 + n * 13, 550, 51 + n * 13],
      height: 11,
      horizontal: true,
      baseline: 51 + n * 13
    })
  f.rules.push([300, 70, 480, 70], [300, 230, 480, 230], [300, 70, 300, 230], [480, 70, 480, 230])
  for (const r of [
    [301, 71, 479, 229],
    [320, 100, 326, 108],
    [360, 140, 366, 148],
    [395, 160, 401, 168]
  ])
    f.page.graphicsBounds.push({
      kind: 'path',
      normalizedRect: r.map((v, i) => v / (i % 2 ? 800 : 600))
    })
  const r = run(f)
  expect(r.rect[2]).toBeGreaterThanOrEqual(480)
  expect(r.rect[1]).toBeGreaterThanOrEqual(70)
})
it.each([
  'missing-edge',
  'missing-drawing',
  'missing-ticks',
  'caption',
  'table',
  'foreign-prose-inside',
  'unknown-removed-label',
  'external-raster',
  'external-vector',
  'invalid-source'
])('rejects incomplete complete-axis ownership: %s', (reason) => {
  const f = input()
  if (reason === 'missing-edge') f.rules.pop()
  if (reason === 'missing-drawing') f.page.graphicsBounds = []
  if (reason === 'missing-ticks') f.tokens = f.tokens.filter((t: Input) => !/^[0-9]$/.test(t.text))
  if (reason === 'caption')
    f.captions.push({ page: 1, lines: ['Figure 2. Separate plate.'], rect: [120, 180, 230, 192] })
  if (reason === 'table') f.tables.push([100, 80, 250, 230])
  if (reason === 'foreign-prose-inside')
    f.tokens.push({
      text: 'This independent paragraph crosses the actual axis and prevents ownership.',
      rect: [120, 180, 320, 191],
      height: 11,
      horizontal: true,
      baseline: 191
    })
  if (reason === 'unknown-removed-label')
    f.tokens.push({
      text: 'Detached key',
      rect: [310, 210, 335, 218],
      height: 8,
      horizontal: true,
      baseline: 218
    })
  if (reason === 'external-raster' || reason === 'external-vector')
    f.page.graphicsBounds.push({
      kind: reason === 'external-raster' ? 'image' : 'path',
      normalizedRect: [220 / 600, 180 / 800, 360 / 600, 260 / 800]
    })
  if (reason === 'invalid-source') f.tokens[0].baseline = NaN
  expect(run(f)).toBeUndefined()
})
it('keeps existing behavior without separate prose or running-title evidence', () => {
  const f = input()
  f.tokens = f.tokens.filter((t: Input) => t.height !== 11)
  expect(run(f)).toBeUndefined()
})
it.each(['raster', 'small-path', 'different-font-label'])(
  'rejects removed ink without an independent native owner: %s',
  (reason) => {
    const f = input()
    if (reason === 'different-font-label')
      f.tokens.push({
        text: 'Unknown key',
        rect: [360, 84, 405, 92],
        height: 8,
        horizontal: true,
        baseline: 92
      })
    else
      f.page.graphicsBounds.push({
        kind: reason === 'raster' ? 'image' : 'path',
        normalizedRect: (reason === 'raster' ? [380, 150, 420, 170] : [380, 180, 385, 185]).map(
          (v: number, i: number) => v / (i % 2 ? 800 : 600)
        )
      })
    expect(run(f)).toBeUndefined()
  }
)
it('rejects a detached short line without the repeated native paragraph leading', () => {
  const f = input()
  f.tokens.push({
    text: 'Unknown key',
    rect: [340, 109, 395, 120],
    height: 11,
    horizontal: true,
    baseline: 120
  })
  expect(run(f)).toBeUndefined()
})
it('retains a literal short paragraph tail with two preceding native leading peers', () => {
  const f = input()
  f.tokens.push({
    text: 'Literal tail',
    rect: [340, 104, 395, 115],
    height: 11,
    horizontal: true,
    baseline: 115
  })
  expect(run(f)).toBeDefined()
})
it('keeps a native inline script bridge into a complete physical prose row', () => {
  const f = input()
  f.tokens = f.tokens.filter((t: Input) => t.baseline !== 76)
  f.tokens.push(
    { text: 'q', rect: [340, 65, 346, 76], height: 11, horizontal: true, baseline: 76 },
    { text: 'unit', rect: [346, 70, 375, 77.7], height: 7.7, horizontal: true, baseline: 77.7 },
    {
      text: 'A complete literal prose continuation on the same baseline.',
      rect: [378, 65, 535, 76],
      height: 11,
      horizontal: true,
      baseline: 76
    }
  )
  expect(run(f)).toBeDefined()
})
it('keeps the complete triangular native array while removing the upper prose band', () => {
  const f = input()
  f.rules = []
  f.page.graphicsBounds = []
  f.tokens = f.tokens.filter((t: Input) => t.height !== 11)
  f.caption.rect = [40, 310, 400, 322]
  f.page.lines[0].y = 310
  f.oldBounds = [60, 40, 490, 315]
  for (const [x, y] of [
    [100, 90],
    [100, 180],
    [190, 180]
  ]) {
    f.rules.push(
      [x, y, x + 80, y],
      [x, y + 80, x + 80, y + 80],
      [x, y, x, y + 80],
      [x + 80, y, x + 80, y + 80]
    )
    for (const r of [
      [x + 1, y + 1, x + 79, y + 79],
      [x + 20, y + 20, x + 26, y + 28],
      [x + 40, y + 40, x + 46, y + 48]
    ])
      f.page.graphicsBounds.push({
        kind: 'path',
        normalizedRect: r.map((v: number, i: number) => v / (i % 2 ? 800 : 600))
      })
  }
  for (let n = 0; n < 2; n++)
    f.tokens.push({
      text: 'Independent complete paragraph above the corner axes.',
      rect: [70, 40 + n * 13, 490, 51 + n * 13],
      height: 11,
      horizontal: true,
      baseline: 51 + n * 13
    })
  const r = run(f)
  expect(r.rect[1]).toBeGreaterThanOrEqual(90)
  expect(r.rect[2]).toBeGreaterThanOrEqual(270)
  expect(r.rect[3]).toBeGreaterThanOrEqual(260)
})
