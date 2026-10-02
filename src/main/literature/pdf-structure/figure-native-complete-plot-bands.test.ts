import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const {
  nativeCaptionedPlotBand,
  nativeFigureRunningHead,
  nativeClosedCategoryLabels,
  nativeAlignedNodeFigure,
  nativeTopParagraphTail,
  nativeDisjointPlotColumn
} = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-figure-native-plot-bands.mjs')).href
)
const input = (): ReturnType<typeof JSON.parse> => {
  const caption = { page: 1, lines: ['Figure 1: Paired curves.'], rect: [40, 280, 240, 292] }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 40, y: 280, width: 200, height: 10, fontSize: 10 }],
    graphicsBounds: [] as ReturnType<typeof JSON.parse>[]
  }
  const rules: number[][] = []
  for (const left of [100, 330]) {
    rules.push(
      [left, 60, left + 170, 60],
      [left, 240, left + 170, 240],
      [left, 60, left, 240],
      [left + 170, 60, left + 170, 240]
    )
    for (const rect of [
      [left - 1, 59, left + 171, 241],
      [left + 3, 64, left + 160, 232],
      [left + 6, 68, left + 155, 220],
      [left + 10, 74, left + 150, 205]
    ])
      page.graphicsBounds.push({
        kind: 'path',
        normalizedRect: rect.map((v, i) => v / (i % 2 ? 800 : 600))
      })
    for (let i = 0; i < 5; i++)
      page.lines.push({
        text: String(i),
        x: left - 15,
        y: 75 + i * 30,
        width: 8,
        height: 8,
        fontSize: 8
      })
    page.lines.push({
      text: 'Horizontal axis',
      x: left + 20,
      y: 247,
      width: 110,
      height: 8,
      fontSize: 8
    })
  }
  const tableCaption = {
    page: 1,
    lines: ['Table 1. Independent records.'],
    rect: [40, 380, 240, 392]
  }
  return { page, caption, captions: [caption, tableCaption], rules }
}
it('preserves both closed populated native plots under one short caption', () => {
  const f = input(),
    r = associateFigures(f.page, f.captions, [], f.rules)
  expect(r[0].rect[2]).toBeGreaterThanOrEqual(500)
  expect(r[0].rect[0]).toBeLessThanOrEqual(85)
})
it('preserves both vertically stacked closed plots above their shared caption', () => {
  const f = input()
  f.rules = f.rules.slice(0, 4)
  f.page.graphicsBounds = f.page.graphicsBounds.slice(0, 4)
  f.page.lines = f.page.lines.slice(0, 7)
  f.rules.push(
    [100, 270, 270, 270],
    [100, 450, 270, 450],
    [100, 270, 100, 450],
    [270, 270, 270, 450]
  )
  for (const g of [...f.page.graphicsBounds])
    f.page.graphicsBounds.push({
      ...g,
      normalizedRect: g.normalizedRect.map((v: number, i: number) => v + (i % 2 ? 210 / 800 : 0))
    })
  for (const l of f.page.lines.slice(1)) f.page.lines.push({ ...l, y: l.y + 210 })
  f.caption.rect = [40, 490, 450, 502]
  f.captions[1].rect = [40, 570, 240, 582]
  f.page.lines[0] = {
    text: f.caption.lines[0],
    x: 40,
    y: 490,
    width: 410,
    height: 10,
    fontSize: 10
  }
  const r = associateFigures(f.page, f.captions, [], f.rules)
  expect(r[0].rect).toBeDefined()
  expect(r[0].rect[1]).toBeLessThan(70)
  expect(r[0].rect[3]).toBeGreaterThan(450)
})

it.each([
  'missing-edge',
  'missing-curves',
  'missing-ticks',
  'foreign-prose',
  'competing-caption',
  'foreign-table'
])('declines incomplete native plot ownership: %s', (reason) => {
  const f = input()
  if (reason === 'missing-edge') f.rules.pop()
  if (reason === 'missing-curves') f.page.graphicsBounds = f.page.graphicsBounds.slice(0, 4)
  if (reason === 'missing-ticks')
    f.page.lines = f.page.lines.filter((l: ReturnType<typeof JSON.parse>) => l.x < 300)
  if (reason === 'foreign-prose')
    f.page.lines.push({
      text: 'Independent paragraph text. '.repeat(4),
      x: 110,
      y: 120,
      width: 360,
      height: 10,
      fontSize: 10
    })
  if (reason === 'competing-caption')
    f.captions.push({ page: 1, lines: ['Figure 2: Independent.'], rect: [330, 180, 490, 192] })
  expect(
    nativeCaptionedPlotBand(
      f.page,
      f.caption,
      f.captions,
      reason === 'foreign-table' ? [[330, 80, 490, 230]] : [],
      f.rules
    )
  ).toBeUndefined()
})

const token = (
  text: string,
  rect: number[],
  height = 8,
  horizontal = true
): ReturnType<typeof JSON.parse> => ({ text, rect, height, horizontal, baseline: rect[3] })
it('uses a native running separator when the graphics filter already omitted its stroke', () => {
  const f = input()
  f.page.pageNumber = 4
  f.page.lines.push({
    text: '4 Independent running title',
    x: 40,
    y: 30,
    width: 500,
    height: 8,
    fontSize: 8
  })
  const tokens = [
    token('4', [40, 30, 44, 38]),
    token('Independent running title', [410, 30, 540, 38])
  ]
  const proof = nativeFigureRunningHead(f.page, f.captions, tokens, [[40, 48, 540, 48]])
  expect(proof?.lines).toContain(f.page.lines.at(-1))
  for (const reason of ['missing-rule', 'competing-rule', 'caption-in-band', 'image-in-band']) {
    const g = structuredClone(f),
      rules = reason === 'missing-rule' ? [] : [[40, 48, 540, 48]]
    if (reason === 'competing-rule') rules.push([40, 47, 540, 47])
    if (reason === 'caption-in-band') g.captions[0].rect = [40, 30, 540, 38]
    if (reason === 'image-in-band')
      g.page.graphicsBounds.push({ kind: 'image', normalizedRect: [0.06, 0.03, 0.95, 0.055] })
    expect(nativeFigureRunningHead(g.page, g.captions, tokens, rules)).toBeUndefined()
  }
})
const categories = (): ReturnType<typeof JSON.parse> => {
  const f = input()
  f.rules = f.rules.slice(0, 4)
  f.page.graphicsBounds = f.page.graphicsBounds.slice(0, 4)
  f.tokens = [
    token('Category alpha', [45, 85, 98, 95], 6, false),
    token('Category beta', [50, 120, 98, 130], 6, false),
    token('Category gamma', [48, 155, 98, 165], 6, false),
    token('Axis title', [34, 80, 42, 190], 8, false),
    token('a', [34, 42, 42, 54], 12),
    ...Array.from({ length: 4 }, (_, i) =>
      token(String(i), [105 + i * 35, 242, 109 + i * 35, 248], 6)
    )
  ]
  return f
}
it('keeps repeated slanted categories, adjacent vertical title and their panel marker', () => {
  const f = categories(),
    rect = [99, 60, 270, 260]
  const owned = nativeClosedCategoryLabels(
    f.page,
    f.caption,
    f.captions,
    [],
    rect,
    f.rules,
    f.tokens
  )
  expect(Math.min(...owned.map((r: number[]) => r[0]))).toBe(34)
  expect(Math.min(...owned.map((r: number[]) => r[1]))).toBe(42)
})
it.each([
  'missing-edge',
  'single-category',
  'missing-ticks',
  'ambiguous-title',
  'foreign-prose',
  'table-owner'
])('rejects incomplete category-axis ownership: %s', (reason) => {
  const f = categories()
  if (reason === 'missing-edge') f.rules.pop()
  if (reason === 'single-category')
    f.tokens = f.tokens.filter(
      (t: ReturnType<typeof JSON.parse>) => !['Category beta', 'Category gamma'].includes(t.text)
    )
  if (reason === 'missing-ticks')
    f.tokens = f.tokens.filter((t: ReturnType<typeof JSON.parse>) => !/^[0-9]$/.test(t.text))
  if (reason === 'ambiguous-title') f.tokens.push(token('Second axis', [32, 90, 40, 195], 8, false))
  if (reason === 'foreign-prose')
    f.tokens.push(token('Independent body paragraph text. '.repeat(3), [30, 110, 99, 122], 10))
  expect(
    nativeClosedCategoryLabels(
      f.page,
      f.caption,
      f.captions,
      reason === 'table-owner' ? [[30, 60, 99, 230]] : [],
      [99, 60, 270, 260],
      f.rules,
      f.tokens
    )
  ).toEqual([])
})
it('recognizes only repeated native paragraph continuity above drawing ink', () => {
  const lines = [0, 1, 2, 3].map((i) => ({
    text:
      i === 3
        ? 'Short final line.'
        : 'Independent prose paragraph with many source words in the same printed block.'.repeat(2),
    x: 40,
    y: 40 + i * 13,
    width: i === 3 ? 100 : 440,
    height: 10,
    fontSize: 10
  }))
  expect(nativeTopParagraphTail(lines[3], [70, 110, 470, 250], lines)).toBe(true)
  expect(nativeTopParagraphTail(lines[3], [70, 80, 470, 250], lines)).toBe(false)
  expect(
    nativeTopParagraphTail(
      lines[3],
      [70, 110, 470, 250],
      lines.map((l) => ({ ...l, text: 'Short chart title' }))
    )
  ).toBe(false)
  expect(
    nativeTopParagraphTail(
      lines[3],
      [70, 110, 470, 250],
      lines.filter((_, i) => i !== 1)
    )
  ).toBe(false)
})
const nodes = (): ReturnType<typeof JSON.parse> => {
  const f = input()
  f.caption.rect = [40, 220, 540, 232]
  f.page.lines[0] = {
    text: f.caption.lines[0],
    x: 40,
    y: 220,
    width: 500,
    height: 10,
    fontSize: 10
  }
  f.page.graphicsBounds = []
  f.rules = []
  f.tokens = []
  for (let i = 0; i < 4; i++) {
    const x = 110 + i * 90
    f.page.graphicsBounds.push({
      kind: 'path',
      normalizedRect: [x / 600, 175 / 800, (x + 10) / 600, 185 / 800]
    })
    f.tokens.push(
      token('Label', [x - 5, 152, x + 15, 160]),
      token('Value', [x - 5, 194, x + 15, 202])
    )
    if (i < 3) f.rules.push([x + 10, 180, x + 90, 180])
  }
  return f
}
it('recovers a sparse aligned native-node diagram with complete upper/lower labels', () => {
  const f = nodes()
  expect(
    nativeAlignedNodeFigure(f.page, f.caption, f.captions, [], f.rules, f.tokens)?.rect
  ).toEqual([105, 152, 395, 202])
})
it.each([
  'missing-connector',
  'missing-upper-label',
  'foreign-prose',
  'table-owner',
  'unaligned-node'
])('declines a sparse chain without full native proof: %s', (reason) => {
  const f = nodes()
  if (reason === 'missing-connector') f.rules = []
  if (reason === 'missing-upper-label') f.tokens.shift()
  if (reason === 'foreign-prose')
    f.tokens.push(token('Independent paragraph. '.repeat(4), [100, 170, 405, 180], 10))
  if (reason === 'unaligned-node') f.page.graphicsBounds[0].normalizedRect[1] -= 0.01
  expect(
    nativeAlignedNodeFigure(
      f.page,
      f.caption,
      f.captions,
      reason === 'table-owner' ? [[100, 170, 405, 205]] : [],
      f.rules,
      f.tokens
    )
  ).toBeUndefined()
})
it('declines disjoint-column ownership without repeated numeric source and curve objects', () => {
  const f = input()
  f.captions.push({ page: 1, lines: ['Figure 2: Adjacent curves.'], rect: [330, 280, 540, 292] })
  expect(nativeDisjointPlotColumn(f.page, f.caption, f.captions, [], [])).toBeUndefined()
})

const columns = (): ReturnType<typeof JSON.parse> => {
  const f = input()
  f.caption.rect = [40, 280, 290, 292]
  f.page.lines[0].width = 250
  f.page.graphicsBounds = f.page.graphicsBounds.slice(0, 4)
  f.page.lines = f.page.lines.slice(0, 7)
  f.captions.push({
    page: 1,
    lines: ['Figure 2: Independent right plot.'],
    rect: [330, 280, 560, 292]
  })
  f.tokens = f.page.lines
    .slice(1)
    .map((l: ReturnType<typeof JSON.parse>) =>
      token(l.text, [l.x, l.y, l.x + l.width, l.y + l.height], l.fontSize)
    )
  return f
}
it('recovers a whole populated column without swallowing the adjacent caption column', () => {
  const f = columns(),
    r = nativeDisjointPlotColumn(f.page, f.caption, f.captions, [], f.tokens)
  expect(r?.rect).toEqual([85, 59, 271, 255])
})
it.each(['missing-ticks', 'missing-curves', 'no-disjoint-caption', 'foreign-prose', 'table-owner'])(
  'declines unproven column ownership: %s',
  (reason) => {
    const f = columns()
    if (reason === 'missing-ticks') f.tokens = []
    if (reason === 'missing-curves') f.page.graphicsBounds = f.page.graphicsBounds.slice(0, 1)
    if (reason === 'no-disjoint-caption') f.captions = f.captions.slice(0, 2)
    if (reason === 'foreign-prose')
      f.tokens.push(token('Independent paragraph text. '.repeat(3), [90, 100, 270, 110], 10))
    expect(
      nativeDisjointPlotColumn(
        f.page,
        f.caption,
        f.captions,
        reason === 'table-owner' ? [[100, 100, 250, 220]] : [],
        f.tokens
      )
    ).toBeUndefined()
  }
)

it('keeps a decoded painted raster in its independent caption column despite caption scripts', async () => {
  const { nativeRasterCaptionColumn } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-raster-column.mjs')).href
  )
  const f = input()
  f.caption.rect = [320, 280, 550, 300]
  f.page.lines = [
    { text: f.caption.lines[0], x: 320, y: 280, width: 230, height: 10, fontSize: 10 },
    { text: 'index', x: 380, y: 289, width: 10, height: 6, fontSize: 6 }
  ]
  f.captions[1].rect = [40, 60, 290, 110]
  f.page.graphicsBounds = [
    {
      kind: 'image',
      normalizedRect: [0.5, 0.02, 0.95, 0.34],
      paintedNormalizedRect: [0.55, 0.06, 0.935, 0.33]
    }
  ]
  expect(nativeRasterCaptionColumn(f.page, f.caption, f.captions, [])?.rect).toEqual([
    330, 48, 561, 264
  ])
  const unpainted = structuredClone(f)
  delete unpainted.page.graphicsBounds[0].paintedNormalizedRect
  expect(
    nativeRasterCaptionColumn(unpainted.page, unpainted.caption, unpainted.captions, [])
  ).toBeUndefined()
  expect(
    nativeRasterCaptionColumn(f.page, f.caption, f.captions, [[330, 100, 550, 250]])
  ).toBeUndefined()
  const ambiguous = structuredClone(f)
  ambiguous.captions[1].rect = [330, 80, 540, 110]
  expect(
    nativeRasterCaptionColumn(ambiguous.page, ambiguous.caption, ambiguous.captions, [])
  ).toBeUndefined()
})
