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

it.each(['complete', 'missing key', 'no upper frame', 'foreign prose', 'foreign paint'])(
  'extends a caption-keyed upper schematic and plot only with complete evidence: %s',
  (condition) => {
    const upper = [196, 48, 290, 160]
    const lower = [
      [72, 180, 172, 259],
      [190, 180, 290, 259]
    ]
    const frames = [upper, ...lower]
    const caption = {
      page: 1,
      rect: [54, 278, 298, 288],
      lines: ['Figure 1: (a) Plan; (b) Photo; (c) Overview; (d) Left; (e) Right.']
    }
    const keys: [string, number[]][] = [
      ['(a)', [55, 45, 67, 55]],
      ['(b)', [55, 99, 67, 109]],
      ['(c)', [173, 45, 185, 55]],
      ['(d)', [55, 167, 67, 177]],
      ['(e)', [173, 167, 185, 177]]
    ]
    const tokens = keys.map(([text, rect], index) => ({
      text,
      rect,
      height: 10,
      horizontal: true,
      sourceItem: { pageNumber: 1, index, text }
    }))
    const line = (text: string, [x, y, right, bottom]: number[]): Record<string, unknown> => ({
      text,
      x,
      y,
      width: right - x,
      height: bottom - y,
      fontSize: 10
    })
    const width = 600
    const height = 800
    const paint = [
      ...frames.flatMap(([x, y]) =>
        [0, 1, 2, 3].map((n) => [x + 10, y + 5 + n * 15, x + 60, y + 15 + n * 15])
      ),
      [80, 66, 150, 80],
      [70, 100, 161, 169]
    ]
    if (condition === 'foreign paint') paint.push([340, 60, 400, 100])
    const graphicsBounds = paint.map((rect, index) => ({
      kind: index === 13 ? 'image' : 'path',
      operationIndex: index,
      normalizedRect: rect.map((v, i) => v / (i % 2 ? height : width)),
      ...(index === 13 ? { imageHash: 'anonymous-raster' } : {})
    }))
    const lines = [
      line(caption.lines[0], caption.rect),
      ...keys.map(([text, rect]) => line(text, rect)),
      line('20', [182, 153, 192, 161]),
      ...frames.flatMap(([x, y]) =>
        [0, 1, 2, 3].map((n) => line(String(n), [x - 10, y + n * 16, x - 2, y + n * 16 + 8]))
      )
    ]
    if (condition === 'foreign prose')
      lines.push(
        line(
          'An independent paragraph occupying the middle of the column has no figure ownership.',
          [54, 90, 296, 100]
        )
      )
    if (condition === 'missing key') tokens.shift()
    const page = {
      pageNumber: 1,
      width,
      height,
      rotation: 0,
      renderRotation: 0,
      invalidGraphicsBounds: 0,
      graphicsBounds,
      lines
    }
    const rules = frames.flatMap(([l, t, r, b]) => [
      [l, t, r, t],
      [l, b, r, b],
      [l, t, l, b],
      [r, t, r, b]
    ])
    const closed = condition === 'no upper frame' ? [] : [upper]
    const result = nativeCaptionedPlotBand(page, caption, [caption], [], rules, closed, tokens)
    expect(result?.rect?.[1]).toBe(condition === 'complete' ? 45 : 153)
    expect(result?.graphicsCount).toBe(condition === 'complete' ? 14 : 2)
  }
)
