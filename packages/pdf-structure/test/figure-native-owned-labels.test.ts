import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const {
  nativeFigureMarginPageNumber,
  nativeRepeatedFigureHeader,
  nativeOwnedFigureLabels,
  nativeOwnedFigureGlyphTails,
  nativePanelTopHeading,
  nativeTableDividerGraphic
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-owned-figure-labels.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { nativeFigureLabelBounds } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-crop-geometry.mjs')).href
)

function repeatedNativeHeader(kind: string): ReturnType<typeof JSON.parse> {
  const style = { ascent: 0.7, descent: -0.2, vertical: false, fontFamily: 'serif' }
  const raw = (str: string, x: number, baseline: number, width: number): unknown => ({
    str,
    dir: 'ltr',
    width,
    height: 10,
    transform: [10, 0, 0, 10, x, 800 - baseline],
    fontName: 'native-font',
    hasEOL: false
  })
  const items: ReturnType<typeof JSON.parse> = [
    ...(kind === 'title' ? [raw('REPEATED ARTICLE TITLE', 200, 52, 200)] : []),
    raw('12', kind === 'title' ? 500 : 100, 52, 10),
    raw('Axis', 150, 100, 30),
    raw('Figure 1. Observed values.', 100, 360, 250)
  ]
  items[kind === 'title' ? 2 : 1].transform = [8.66, 5, -5, 8.66, 150, 700]
  items.forEach((r: ReturnType<typeof JSON.parse>, index: number) => {
    r.sourceItem = { pageNumber: 12, index, text: r.str }
  })
  const viewport = {
    width: 600,
    height: 800,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, 800],
    convertToViewportPoint: (x: number, y: number): number[] => [x, 800 - y]
  }
  const tokens = items.map((r: ReturnType<typeof JSON.parse>) => ({
    ...tableTextToken(r, viewport, 0),
    fontAscent: style.ascent,
    fontDescent: style.descent,
    nativeLabelRect: nativeFigureLabelBounds(r, style, viewport)
  }))
  const lines = tokens.map((t: ReturnType<typeof JSON.parse>) => ({
    text: t.text,
    x: t.rect[0],
    y: t.rect[1],
    width: t.rect[2] - t.rect[0],
    height: 10,
    fontSize: 10
  }))
  if (kind === 'title')
    lines.splice(0, 2, {
      text: 'REPEATED ARTICLE TITLE 12',
      x: 200,
      y: 42,
      width: 310,
      height: 10,
      fontSize: 10
    })
  const content = { items, styles: { 'native-font': style } }
  const witnessContent = structuredClone(content)
  witnessContent.items.forEach((r: ReturnType<typeof JSON.parse>) => {
    if (r.str === '12') r.str = '10'
    delete r.sourceItem
  })
  return {
    page: {
      pageNumber: 12,
      width: 600,
      height: 800,
      rotation: 0,
      invalidGraphicsBounds: 0,
      lines,
      graphicsBounds: [{ kind: 'path', operationIndex: 7, normalizedRect: [0.15, 0.08, 0.9, 0.4] }]
    },
    tokens,
    captions: [{ page: 12, lines: ['Figure 1. Observed values.'], rect: [100, 350, 540, 360] }],
    tables: [],
    context: {
      sourceSha256: 'a'.repeat(64),
      content: structuredClone(content),
      viewport: { ...viewport, convertToViewportPoint: undefined },
      runningHeadWitness: {
        sourceSha256: 'a'.repeat(64),
        currentPageNumber: 12,
        witnessPageNumber: 10,
        currentContent: content,
        witnessContent,
        witnessViewport: { ...viewport, convertToViewportPoint: undefined }
      }
    }
  }
}

it.each(['number', 'title'])(
  'excludes a repeated native %s header before figure completion',
  (kind) => {
    const f = repeatedNativeHeader(kind)
    const before = structuredClone(f)
    const result = associateFigures(f.page, f.captions, f.tables, [], [], f.tokens, f.context)
    expect(result).toEqual([{ caption: f.captions[0], rect: [90, 64, 540, 320], graphicsCount: 1 }])
    expect(f).toEqual(before)
  }
)

it.each([
  'missing witness',
  'changed title',
  'source alias',
  'incomplete font',
  'paint collision',
  'different page label'
])('preserves an unproved page header with %s', (issue) => {
  const f = repeatedNativeHeader('title')
  if (issue === 'missing witness') delete f.context.runningHeadWitness
  if (issue === 'changed title')
    f.context.runningHeadWitness.witnessContent.items[0].str = 'A DIFFERENT TITLE'
  if (issue === 'source alias')
    f.tokens.at(-1).nested = { sourceItem: { ...f.tokens[0].sourceItem } }
  if (issue === 'incomplete font') delete f.tokens[0].fontDescent
  if (issue === 'paint collision') f.page.graphicsBounds[0].normalizedRect[1] = 0.04
  if (issue === 'different page label') f.page.pageLabel = '7'
  expect(
    nativeRepeatedFigureHeader(f.page, f.tokens, f.captions, f.tables, f.context)
  ).toBeUndefined()
})

it('retains a repeated header when a rotated font extends into its separating band', () => {
  const f = repeatedNativeHeader('title')
  const style = { ascent: 0.9, descent: -0.3, vertical: false, fontFamily: 'serif' }
  const angle = (160 * Math.PI) / 180
  const item = structuredClone(f.context.content.items[2])
  item.fontName = 'plot-font'
  item.transform = [
    10 * Math.cos(angle),
    10 * Math.sin(angle),
    -10 * Math.sin(angle),
    10 * Math.cos(angle),
    150,
    700
  ]
  const viewport = {
    ...f.context.viewport,
    convertToViewportPoint: (x: number, y: number): number[] => [x, 800 - y]
  }
  item.transform[5] += nativeFigureLabelBounds(item, style, viewport)[1] - 61
  for (const content of [f.context.content, f.context.runningHeadWitness.currentContent]) {
    content.items[2] = structuredClone(item)
    content.styles['plot-font'] = style
  }
  f.tokens[2] = {
    ...tableTextToken(item, viewport, 0),
    fontAscent: style.ascent,
    fontDescent: style.descent,
    nativeLabelRect: nativeFigureLabelBounds(item, style, viewport)
  }
  const line = f.page.lines.find((line: ReturnType<typeof JSON.parse>) => line.text === 'Axis')
  Object.assign(line, {
    x: f.tokens[2].rect[0],
    y: f.tokens[2].rect[1],
    width: f.tokens[2].rect[2] - f.tokens[2].rect[0],
    height: f.tokens[2].rect[3] - f.tokens[2].rect[1]
  })
  expect(f.tokens[2].nativeLabelRect[1]).toBeCloseTo(61)
  expect(
    nativeRepeatedFigureHeader(f.page, f.tokens, f.captions, f.tables, f.context)
  ).toBeUndefined()
})

function isolatedMarginNumber(): ReturnType<typeof JSON.parse> {
  const items = [
    { text: '6', rect: [50, 30, 56, 40], height: 10, baseline: 40 },
    { text: 'Axis', rect: [100, 90, 130, 98], height: 8, baseline: 98 }
  ].map((item, index) => ({
    ...item,
    horizontal: true,
    sourceItem: { pageNumber: 6, index, text: item.text }
  }))
  return {
    page: {
      pageNumber: 6,
      width: 600,
      height: 800,
      rotation: 0,
      invalidGraphicsBounds: 0,
      lines: items.map((i) => ({
        text: i.text,
        x: i.rect[0],
        y: i.rect[1],
        width: i.rect[2] - i.rect[0],
        height: i.height,
        fontSize: i.height
      })),
      graphicsBounds: [{ kind: 'path', operationIndex: 7, normalizedRect: [0.15, 0.1, 0.9, 0.4] }]
    },
    tokens: items,
    captions: [{ page: 6, lines: ['Figure 1. An example.'], rect: [50, 350, 540, 360] }],
    tables: []
  }
}

it.each(['left', 'right'])(
  'proves an isolated native page number at the %s margin without changing source',
  (side) => {
    const f = isolatedMarginNumber()
    if (side === 'right') {
      f.tokens[0].rect = [550, 30, 556, 40]
      f.page.lines[0].x = 550
    }
    const before = structuredClone(f)
    expect(nativeFigureMarginPageNumber(f.page, f.tokens, f.captions, f.tables)).toEqual({
      line: f.page.lines[0],
      token: f.tokens[0]
    })
    expect(f).toEqual(before)
  }
)

it('uses an explicit PDF page label to exclude a detached offset page number', () => {
  const f = isolatedMarginNumber()
  f.page.pageNumber = 12
  f.page.pageLabel = '6'
  f.tokens.forEach((token) => (token.sourceItem.pageNumber = 12))
  f.captions[0].page = 12
  const before = structuredClone(f)
  expect(nativeFigureMarginPageNumber(f.page, f.tokens, f.captions, f.tables)).toEqual({
    line: f.page.lines[0],
    token: f.tokens[0]
  })
  expect(associateFigures(f.page, f.captions, f.tables, [], [], f.tokens)).toEqual([
    { caption: f.captions[0], rect: [90, 80, 540, 320], graphicsCount: 1 }
  ])
  expect(f).toEqual(before)
})

it.each([
  undefined,
  null,
  '',
  '7',
  '6.0',
  '06',
  'vi',
  '６',
  '٦',
  ' 6',
  '0',
  '9007199254740992',
  '6 supplement',
  6
])(
  'does not infer an offset page number from an absent or conflicting PDF label %s',
  (pageLabel) => {
    const f = isolatedMarginNumber()
    f.page.pageNumber = 12
    f.page.pageLabel = pageLabel
    f.tokens.forEach((token) => (token.sourceItem.pageNumber = 12))
    f.captions[0].page = 12
    expect(nativeFigureMarginPageNumber(f.page, f.tokens, f.captions, f.tables)).toBeUndefined()
  }
)

it('keeps a physical-page-number-shaped corner label when PDF numbering contradicts it', () => {
  const f = isolatedMarginNumber()
  f.page.pageLabel = '3'
  expect(nativeFigureMarginPageNumber(f.page, f.tokens, f.captions, f.tables)).toBeUndefined()
})

it.each(['source-alias', 'nearby-font', 'nearby-paint', 'unknown-paint'])(
  'does not let a matching PDF label override incomplete native exclusion with %s',
  (reason) => {
    const f = isolatedMarginNumber()
    f.page.pageNumber = 12
    f.page.pageLabel = '6'
    f.tokens.forEach((token) => (token.sourceItem.pageNumber = 12))
    f.captions[0].page = 12
    if (reason === 'source-alias')
      f.tokens.push({ ...structuredClone(f.tokens[0]), rect: [50, 600, 56, 610] })
    if (reason === 'nearby-font') f.tokens[1].rect = [100, 35, 130, 43]
    if (reason === 'nearby-paint') f.page.graphicsBounds[0].normalizedRect[1] = 0.04
    if (reason === 'unknown-paint') f.page.graphicsBounds[0].kind = 'unknown'
    expect(nativeFigureMarginPageNumber(f.page, f.tokens, f.captions, f.tables)).toBeUndefined()
  }
)

it.each([
  'offset-numbering',
  'middle-label',
  'lower-label',
  'noninitial-source',
  'source-alias',
  'unknown-source',
  'nearby-font',
  'nearby-paint',
  'unknown-paint',
  'invalid-graphics',
  'competing-caption',
  'competing-table',
  'invalid-font',
  'missing-line',
  'rotated-page'
])('retains an unproved margin number with %s', (reason) => {
  const f = isolatedMarginNumber()
  if (reason === 'offset-numbering') f.page.pageNumber = 9
  if (reason === 'middle-label') f.tokens[0].rect = [250, 30, 256, 40]
  if (reason === 'lower-label') f.tokens[0].rect = [50, 100, 56, 110]
  if (reason === 'noninitial-source') f.tokens[0].sourceItem.index = 5
  if (reason === 'source-alias')
    f.tokens.push({ ...structuredClone(f.tokens[0]), rect: [50, 600, 56, 610] })
  if (reason === 'unknown-source') f.tokens[0].sourceItem.text = '7'
  if (reason === 'nearby-font') f.tokens[1].rect = [100, 35, 130, 43]
  if (reason === 'nearby-paint') f.page.graphicsBounds[0].normalizedRect[1] = 0.04
  if (reason === 'unknown-paint') f.page.graphicsBounds[0].kind = 'unknown'
  if (reason === 'invalid-graphics') f.page.invalidGraphicsBounds = 1
  if (reason === 'competing-caption') f.captions[0].rect = [50, 35, 540, 45]
  if (reason === 'competing-table') f.tables.push([30, 20, 550, 90])
  if (reason === 'invalid-font') f.tokens[1].rect[0] = NaN
  if (reason === 'missing-line') f.page.lines.shift()
  if (reason === 'rotated-page') f.page.rotation = 90
  expect(nativeFigureMarginPageNumber(f.page, f.tokens, f.captions, f.tables)).toBeUndefined()
})
const line = (
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 8
): ReturnType<typeof JSON.parse> => ({ text, x, y, width, height: fontSize, fontSize })
const input = (): ReturnType<typeof JSON.parse> => ({
  page: {
    width: 600,
    height: 800,
    lines: [line('Figure 1: Panel.', 100, 300, 250, 10), line('LR', 390, 90, 10, 8)]
  },
  caption: { rect: [100, 300, 350, 310] },
  rect: [100, 80, 400, 250],
  tokens: [{ text: 'ec', rect: [400.2, 91, 406, 98], height: 7, baseline: 98, horizontal: true }]
})
it('preserves literal native tail adjoining one already owned small label', () => {
  const f = input()
  const r = nativeOwnedFigureGlyphTails(f.page, f.caption, [f.caption], [], f.rect, f.tokens)
  expect(r).toHaveLength(1)
  expect(r[0].text).toBe('ec')
  expect(r[0].x + r[0].width).toBe(406)
})
it.each(['far', 'foreign-table', 'different-baseline', 'competing-glyph', 'nonfinite', 'vertical'])(
  'rejects a native tail with %s',
  (reason) => {
    const f = input()
    if (reason === 'far') f.tokens[0].rect[0] = 403
    if (reason === 'different-baseline') f.tokens[0].baseline = 110
    if (reason === 'competing-glyph') f.tokens.push({ ...f.tokens[0] })
    if (reason === 'nonfinite') f.tokens[0].baseline = NaN
    if (reason === 'vertical') f.tokens[0].horizontal = false
    expect(
      nativeOwnedFigureGlyphTails(
        f.page,
        f.caption,
        [f.caption],
        reason === 'foreign-table' ? [[400, 90, 420, 110]] : [],
        f.rect,
        f.tokens
      )
    ).toEqual([])
  }
)
it('retains a repeated small label column outside drawing ink', () => {
  const f = input()
  f.page.lines.push(...Array.from({ length: 6 }, (_, i) => line('Layer', 65, 100 + i * 15, 32, 7)))
  expect(nativeOwnedFigureLabels(f.page, f.caption, [f.caption], [], f.rect)).toHaveLength(7)
})
it('does not retain detached prose or a foreign-owned label column', () => {
  const f = input()
  f.page.lines.push(...Array.from({ length: 6 }, (_, i) => line('Layer', 65, 100 + i * 15, 32, 7)))
  expect(nativeOwnedFigureLabels(f.page, f.caption, [f.caption], [], f.rect, () => true)).toEqual(
    []
  )
})
it('recovers one detached panel title above its own native opening and sibling titles', () => {
  const f = input()
  f.page.lines = [
    line('(a) First panel', 110, 50, 170, 10),
    line('(b) Second panel', 110, 180, 170, 10),
    line('(c) Third panel', 310, 180, 170, 10)
  ]
  f.rect = [100, 80, 500, 260]
  expect(nativePanelTopHeading(f.page, [], [], f.rect, [[100, 75, 500, 75]])).toHaveLength(1)
  expect(nativePanelTopHeading(f.page, [], [], f.rect, [])).toEqual([])
  f.page.lines.push(line('Foreign text', 400, 55, 60, 10))
  expect(nativePanelTopHeading(f.page, [], [], f.rect, [[100, 75, 500, 75]])).toEqual([])
})

it('preserves the complete native font box of fused panel marks on a proven framed array', () => {
  const f = readPdfFixture(
    resolve('test/fixtures/native-panel-array-with-fused-small-headings.jsonl')
  )
  f.page.lines.push({
    text: f.captions[0].lines[0],
    x: f.captions[0].rect[0],
    y: f.captions[0].rect[1],
    width: f.captions[0].rect[2] - f.captions[0].rect[0],
    height: 10,
    fontSize: 10
  })
  const original = associateFigures(f.page, f.captions, [], f.rules)[0].rect
  const h = Math.min(
    ...f.page.lines
      .filter((l: ReturnType<typeof JSON.parse>) => l.y >= f.captions[0].rect[1])
      .map((l: ReturnType<typeof JSON.parse>) => l.fontSize)
  )
  f.page.lines.push({
    text: 'a b c',
    x: original[0] - 1,
    y: original[1] - 1,
    width: 180,
    height: h,
    fontSize: h
  })
  const result = associateFigures(f.page, f.captions, [], f.rules)[0].rect
  expect(result[0]).toBeLessThanOrEqual(original[0] - 1)
  expect(result[1]).toBeLessThanOrEqual(original[1] - 1)
})

it('pads only the native terminal font overhang when the added strip has no foreign ink', () => {
  const f = input()
  const r = nativeOwnedFigureGlyphTails(f.page, f.caption, [f.caption], [], f.rect, f.tokens)
  expect(r[0].cropRect[2]).toBeCloseTo(407.4)
  f.tokens.push({
    text: 'Other',
    rect: [406.5, 90, 420, 100],
    height: 10,
    baseline: 100,
    horizontal: true
  })
  expect(
    nativeOwnedFigureGlyphTails(f.page, f.caption, [f.caption], [], f.rect, f.tokens)[0].cropRect[2]
  ).toBe(406)
})

const tableDividerInput = (): ReturnType<typeof JSON.parse> => {
  const page = {
    pageNumber: 1,
    width: 612,
    height: 792,
    invalidGraphicsBounds: 0,
    lines: [
      line('Figure 1: Complete native panel.', 76, 365, 400, 10),
      line('Axis', 120, 330, 30, 8)
    ],
    graphicsBounds: [
      {
        kind: 'path',
        normalizedRect: [76.5 / 612, 179.4375 / 792, 540.28125 / 612, 355.78125 / 792]
      },
      {
        kind: 'path',
        normalizedRect: [143.4375 / 612, 148.5 / 792, 148.21875 / 612, 167.0625 / 792]
      }
    ]
  }
  return {
    page,
    captions: [{ page: 1, lines: [page.lines[0].text], rect: [76, 365, 476, 375] }],
    tables: [[101.55, 104.049, 473.267, 162.131]],
    rules: [
      [101.55, 102.156, 473.267, 102.156],
      [101.55, 104.049, 473.267, 104.049],
      [101.55, 115.905, 473.267, 115.905],
      [101.55, 162.131, 473.267, 162.131],
      [143.988, 150.475, 143.988, 161.932]
    ]
  }
}
it('excludes a quantized native last-row divider belonging uniquely to a recognized ruled table', () => {
  const f = tableDividerInput()
  expect(associateFigures(f.page, f.captions, f.tables, f.rules)[0].rect[1]).toBeGreaterThanOrEqual(
    179
  )
})
it.each([
  'missing-native-divider',
  'missing-native-header',
  'competing-table',
  'native-outside-table',
  'wide-drawing'
])('keeps the original graphic without strict table divider ownership: %s', (reason) => {
  const f = tableDividerInput()
  if (reason === 'missing-native-divider') f.rules.pop()
  if (reason === 'missing-native-header') f.rules.splice(0, 3)
  if (reason === 'competing-table') f.tables.push([...f.tables[0]])
  if (reason === 'native-outside-table') f.rules.at(-1)[3] = 170
  if (reason === 'wide-drawing') f.page.graphicsBounds[1].normalizedRect[2] += 0.01
  expect(associateFigures(f.page, f.captions, f.tables, f.rules)[0].rect[1]).toBeLessThan(160)
})

const paddedNativeDivider = (): ReturnType<typeof JSON.parse> => ({
  page: { width: 612, height: 792 },
  graphic: [205.59375, 303.1875, 210.375, 318.65625],
  tables: [[104, 156.8866461933333, 503.3333333333333, 314.96080405333333]],
  rules: [
    [108, 156.95331285999995, 504.00735912322995, 156.95331285999995],
    [108, 301.79971293, 504.00735912322995, 301.79971293],
    [108, 314.62747072, 504.00735912322995, 314.62747072],
    [207.04742672999998, 304.2173103816175, 207.04742672999998, 312.94407138]
  ]
})

it.each([0.75, 1, 1.5])(
  'retains native terminal-divider ownership inside a padded table crop at scale %s',
  (scale) => {
    const f = paddedNativeDivider()
    f.page.width *= scale
    f.page.height *= scale
    f.graphic = f.graphic.map((v: number) => v * scale)
    f.tables = f.tables.map((r: number[]) => r.map((v) => v * scale))
    f.rules = f.rules.map((r: number[]) => r.map((v) => v * scale))
    const before = structuredClone(f)
    expect(nativeTableDividerGraphic(f.page, f.graphic, f.tables, f.rules)).toBe(true)
    expect(f).toEqual(before)
  }
)

it.each([
  'closing-gap',
  'horizontal-padding',
  'missing-fence',
  'competing-owner',
  'outside-segment'
])('requires the same native fence despite table crop padding: %s', (missing) => {
  const f = paddedNativeDivider()
  if (missing === 'closing-gap') f.tables[0][3] += 2
  if (missing === 'horizontal-padding') f.tables[0][0] -= 5
  if (missing === 'missing-fence') f.rules.splice(0, 1)
  if (missing === 'competing-owner') f.tables.push([...f.tables[0]])
  if (missing === 'outside-segment') f.rules.at(-1)[3] = f.tables[0][3] + 1
  expect(nativeTableDividerGraphic(f.page, f.graphic, f.tables, f.rules)).toBe(false)
})
