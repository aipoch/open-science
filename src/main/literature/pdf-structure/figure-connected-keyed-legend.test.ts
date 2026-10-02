import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { nativeConnectedKeyedLegend } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-figure-connected-keyed-legend.mjs'))
    .href
)
type Input = ReturnType<typeof JSON.parse>
const input = (): Input => {
  const caption = { page: 1, rect: [370, 90, 550, 190], lines: ['Figure 1. Connected diagram.'] }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [{ text: caption.lines[0], x: 370, y: 90, width: 180, height: 10, fontSize: 10 }],
    graphicsBounds: []
  }
  const tokens: Input[] = [],
    paths: number[][] = [
      [40, 75, 330, 210],
      [105, 80, 285, 205],
      [155, 45, 205, 70],
      [160, 215, 195, 240]
    ]
  for (const y of [100, 160])
    for (const x of [120, 175, 230]) {
      paths.push([x, y, x + 28, y + 28])
      tokens.push({
        text: 'x',
        rect: [x + 8, y + 9, x + 16, y + 17],
        height: 8,
        baseline: y + 17,
        horizontal: true
      })
    }
  tokens.push(
    { text: 'a', rect: [175, 53, 183, 61], height: 8, baseline: 61, horizontal: true },
    { text: 'b', rect: [172, 223, 180, 231], height: 8, baseline: 231, horizontal: true }
  )
  for (const x of [40, 125])
    for (const y of [241, 253]) {
      paths.push([x, y, x + 12, y + 12])
      tokens.push({
        text: 'Key entry',
        rect: [x + 15, y + 1, x + 70, y + 9],
        height: 8,
        baseline: y + 9,
        horizontal: true
      })
    }
  page.graphicsBounds = paths.map((rect) => ({
    kind: 'path',
    normalizedRect: rect.map((v, i) => v / (i % 2 ? 800 : 600))
  })) as never
  return { page, caption, captions: [caption], tables: [], tokens, oldBounds: [40, 55, 330, 232] }
}
const run = (f: Input): Input =>
  nativeConnectedKeyedLegend(f.page, f.caption, f.captions, f.tables, f.tokens, f.oldBounds)
it('retains connected outer nodes and the independently repeated keyed legend', () => {
  const r = run(input())
  expect(r.rect[1]).toBeCloseTo(45)
  expect(r.rect[3]).toBeCloseTo(265)
})
it.each([false, true])(
  'requires all three repeated index-definition pairs: missing=%s',
  (missing) => {
    const f = input()
    for (const y of [241, 253, 265]) {
      for (const x of [40, 125]) {
        if (y !== 265) continue
        f.page.graphicsBounds.push({
          kind: 'path',
          normalizedRect: [x / 600, y / 800, (x + 12) / 600, (y + 12) / 800]
        })
        f.tokens.push({
          text: 'Key entry',
          rect: [x + 15, y + 1, x + 70, y + 9],
          height: 8,
          baseline: y + 9,
          horizontal: true
        })
      }
      f.tokens.push({
        text: 'i',
        rect: [230, y + 1, 233, y + 9],
        height: 8,
        baseline: y + 9,
        horizontal: true
      })
      if (!missing || y !== 265)
        f.tokens.push({
          text: 'Definition',
          rect: [241, y + 1, 290, y + 9],
          height: 8,
          baseline: y + 9,
          horizontal: true
        })
    }
    if (missing) expect(run(f)).toBeUndefined()
    else expect(run(f).rect[3]).toBeGreaterThanOrEqual(277)
  }
)
it.each([
  'missing-container',
  'missing-key-column',
  'foreign-font',
  'foreign-baseline',
  'raster',
  'caption',
  'table',
  'invalid-source'
])('rejects incomplete connected diagram ownership: %s', (reason) => {
  const f = input()
  if (reason === 'missing-container') f.page.graphicsBounds.splice(1, 1)
  if (reason === 'missing-key-column')
    f.page.graphicsBounds = f.page.graphicsBounds.filter(
      (g: Input) => !(g.normalizedRect[0] === 125 / 600 && g.normalizedRect[1] >= 241 / 800)
    )
  if (reason === 'foreign-font')
    f.tokens.push({
      text: 'Foreign line',
      rect: [230, 246, 300, 256],
      height: 10,
      baseline: 256,
      horizontal: true
    })
  if (reason === 'foreign-baseline')
    f.tokens.push({
      text: 'Unknown key',
      rect: [230, 238, 285, 246],
      height: 8,
      baseline: 246,
      horizontal: true
    })
  if (reason === 'raster')
    f.page.graphicsBounds.push({
      kind: 'image',
      normalizedRect: [230 / 600, 240 / 800, 270 / 600, 260 / 800]
    })
  if (reason === 'caption')
    f.captions.push({
      page: 1,
      rect: [200, 240, 300, 255],
      lines: ['Figure 2. Independent graphic.']
    })
  if (reason === 'table') f.tables.push([200, 240, 300, 255])
  if (reason === 'invalid-source') f.tokens[0].baseline = NaN
  expect(run(f)).toBeUndefined()
})
it.each(['unkeyed-near-legend', 'unconnected-top-label'])(
  'rejects new small lettering without a concrete native owner: %s',
  (reason) => {
    const f = input(),
      rect = reason === 'unkeyed-near-legend' ? [230, 242, 285, 250] : [70, 46, 130, 54]
    f.tokens.push({ text: 'Unknown key', rect, height: 8, baseline: rect[3], horizontal: true })
    expect(run(f)).toBeUndefined()
  }
)
