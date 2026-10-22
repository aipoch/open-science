import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { nativeCaptionedPlotBand } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-bands.mjs')).href
)

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- synthetic geometry
function fixture() {
  const frames = [
    [80, 80, 240, 180],
    [280, 80, 440, 180],
    [80, 300, 180, 400],
    [210, 300, 310, 400],
    [340, 300, 440, 400]
  ]
  const caption = {
    page: 1,
    rect: [60, 440, 480, 452],
    lines: ['Figure 1: (a–b) Overview; (c–e) Details.']
  }
  const line = (text: string, r: number[]): Record<string, unknown> => ({
    text,
    x: r[0],
    y: r[1],
    width: r[2] - r[0],
    height: r[3] - r[1],
    fontSize: 10
  })
  const tokens = frames.map((r, index) => {
    const text = `(${String.fromCharCode(97 + index)})`,
      center = (r[0] + r[2]) / 2
    return {
      text,
      rect: [center - 6, r[3] + 20, center + 6, r[3] + 30],
      horizontal: true,
      sourceItem: { pageNumber: 1, index, text }
    }
  })
  const rules = frames.flatMap(([l, t, r, b]) => [
    [l, t, r, t],
    [l, b, r, b],
    [l, t, l, b],
    [r, t, r, b]
  ])
  const graphicsBounds = frames.flatMap((r) =>
    [0, 1, 2].map((n) => ({
      kind: 'path',
      normalizedRect: [
        (r[0] + 10) / 600,
        (r[1] + 10 + n * 20) / 800,
        (r[0] + 60) / 600,
        (r[1] + 20 + n * 20) / 800
      ]
    }))
  )
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    graphicsBounds,
    lines: [
      line(caption.lines[0], caption.rect),
      ...tokens.map((t) => line(t.text, t.rect)),
      ...frames.flatMap((r) =>
        [0, 1, 2, 3].map((n) =>
          line(String(n), [r[0] - 10, r[1] + n * 20, r[0] - 2, r[1] + n * 20 + 8])
        )
      )
    ]
  }
  const captions = [caption],
    tables: number[][] = []
  const run = (): number[] | undefined =>
    nativeCaptionedPlotBand(page, caption, captions, tables, rules, [], tokens)?.rect
  return { page, caption, captions, tables, tokens, rules, run, line }
}

it('keeps caption-keyed upper panels when successive rows have different widths', () => {
  expect(fixture().run()?.[1]).toBeLessThan(100)
})

it.each([
  'missing key',
  'duplicate key',
  'unreliable graphics',
  'wrong source page',
  'wrong order',
  'unreferenced key',
  'off-center key',
  'foreign caption',
  'foreign table',
  'prose',
  'missing ink',
  'missing ticks'
])('does not complete upper panels with %s', (condition) => {
  const f = fixture()
  if (condition === 'missing key') f.tokens.shift()
  if (condition === 'duplicate key') f.tokens.push({ ...f.tokens[0] })
  if (condition === 'unreliable graphics') f.page.invalidGraphicsBounds = 1
  if (condition === 'wrong source page') f.tokens[0].sourceItem.pageNumber = 2
  if (condition === 'wrong order')
    [f.tokens[0].rect, f.tokens[1].rect] = [f.tokens[1].rect, f.tokens[0].rect]
  if (condition === 'unreferenced key') f.caption.lines = ['Figure 1: (c–e) Details.']
  if (condition === 'off-center key') f.tokens[0].rect[0] -= 30
  if (condition === 'foreign caption')
    f.captions.push({ page: 1, rect: [60, 200, 480, 212], lines: ['Figure 2: Another figure.'] })
  if (condition === 'foreign table') f.tables.push([80, 80, 240, 180])
  if (condition === 'prose')
    f.page.lines.push(
      f.line(
        'Independent paragraph with enough words to establish ordinary prose in the intervening region.',
        [80, 230, 440, 240]
      )
    )
  if (condition === 'missing ink') f.page.graphicsBounds.splice(0, 3)
  if (condition === 'missing ticks')
    f.page.lines = f.page.lines.filter((l) => !(l.x === 70 && Number(l.y) < 180))
  expect(f.run()?.[1] ?? Infinity).toBeGreaterThan(180)
})
