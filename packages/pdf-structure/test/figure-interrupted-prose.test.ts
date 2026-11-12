import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const { nativeTopParagraphTail } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-bands.mjs')).href
)

it('does not use a caption continuation as independent paragraph evidence', () => {
  const lines = [60, 73, 260].map((y) => ({
    text: 'Independent measurements under the stated conditions and reported experimental observations',
    x: 50,
    y,
    width: 500,
    height: 10,
    fontSize: 10
  }))
  const captions = [{ rect: [50, 245, 550, 270] }]
  expect(nativeTopParagraphTail(lines[1], [50, 100, 550, 230], lines, captions)).toBe(false)
})

it.each([true, false])(
  'requires independently continuing prose below an interrupting plot: %s',
  (continued) => {
    const lines = [60, 73, ...(continued ? [260] : [])].map((y) => ({
      text: 'The independent source describes several observations and continues with further measured values',
      x: 50,
      y,
      width: 500,
      height: 10,
      fontSize: 10
    }))
    expect(nativeTopParagraphTail(lines[1], [50, 100, 550, 230], lines)).toBe(continued)
  }
)

it.each([true, false])(
  'uses disjoint subplot evidence before excluding remote mathematical prose: %s',
  (bracketed) => {
    const page = {
      pageNumber: 1,
      width: 600,
      height: 800,
      invalidGraphicsBounds: 0,
      lines: (bracketed ? [111, 174, 186] : [174, 186]).map((y) => ({
        text: 'Each independent source measurement explains these values.',
        x: 54,
        y,
        width: 245,
        height: 10,
        fontSize: 10
      })),
      graphicsBounds: [
        [103, 142, 265, 148],
        [316, 50, 567, 278],
        [349, 68, 447, 142],
        [469, 71, 557, 142]
      ].map((r) => ({
        kind: 'path',
        normalizedRect: r.map((v, i) => v / (i % 2 ? 800 : 600))
      }))
    }
    const captions = [
      { page: 1, rect: [317, 287, 562, 297], lines: ['FIG. 1. Independent observations.'] }
    ]
    const [figure] = associateFigures(page, captions)
    if (bracketed) expect(figure.rect[0]).toBeGreaterThan(310)
    else expect(figure.rect[0]).toBeLessThan(200)
    expect(figure.rect[2]).toBeGreaterThan(550)
  }
)

function inlineFormulaTail(): ReturnType<typeof JSON.parse> {
  const row = (text: string, x: number, y: number, width: number): unknown => ({
    text,
    x,
    y,
    width,
    height: 10,
    fontSize: 10
  })
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      row('The independent measurements define the normalized weights', 50, 177, 198),
      row('q', 261, 177, 12),
      row('(', 275, 177, 3),
      row('x', 280, 177, 6),
      row('′', 293, 176.5, 2),
      row(')', 296, 177, 4),
      ...[190, 202, 214].map((y) =>
        row('The separate source paragraph continues with measured observations.', 50, y, 250)
      ),
      row('Figure 1. Independent observations.', 317, 287, 245)
    ],
    graphicsBounds: [
      [316, 50, 567, 278],
      [349, 68, 447, 142],
      [469, 71, 557, 142]
    ].map((r) => ({
      kind: 'path',
      normalizedRect: r.map((v, i) => v / (i % 2 ? 800 : 600))
    }))
  }
  const captions = [
    { page: 1, rect: [317, 287, 562, 297], lines: ['Figure 1. Independent observations.'] }
  ]
  const tokens = page.lines.map((l: ReturnType<typeof JSON.parse>, index) => ({
    text: l.text,
    rect: [l.x, l.y, l.x + l.width, l.y + l.height],
    horizontal: true,
    baseline: l.y + 10,
    height: 10,
    sourceItem: { pageNumber: 1, index, text: l.text }
  }))
  return { page, captions, tokens }
}

it('excludes a native inline formula tail continued by a separately aligned prose column', () => {
  const f = inlineFormulaTail(),
    before = structuredClone(f)
  expect(associateFigures(f.page, f.captions, [], [], [], f.tokens)[0].rect[0]).toBeGreaterThan(310)
  expect(f).toEqual(before)
})

it.each(['missing-source', 'aliased-source', 'detached-label', 'no-paragraph'])(
  'retains a punctuation label without complete independent prose ownership: %s',
  (kind) => {
    const f = inlineFormulaTail()
    if (kind === 'missing-source') delete f.tokens[4].sourceItem
    if (kind === 'aliased-source') f.tokens.push({ ...f.tokens[4] })
    if (kind === 'detached-label') {
      f.page.lines = f.page.lines.filter((_: unknown, i: number) => i !== 0)
      f.tokens.shift()
    }
    if (kind === 'no-paragraph')
      f.page.lines = f.page.lines.filter((l: { y: number }) => l.y < 190 || l.y > 250)
    expect(associateFigures(f.page, f.captions, [], [], [], f.tokens)[0].rect[0]).toBeLessThan(310)
  }
)
