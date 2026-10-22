import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
const { nativeAttachedPlotLabels } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const { nativeTopParagraphTail } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-bands.mjs')).href
)
const token = (
  text: string,
  rect: number[],
  horizontal = true,
  height = 8
): ReturnType<typeof JSON.parse> => ({ text, rect, horizontal, height, baseline: rect[3] })
const input = (): ReturnType<typeof JSON.parse> => ({
  page: { pageNumber: 1, width: 600, height: 800, graphicsBounds: [] },
  figure: { rect: [100, 100, 500, 250] },
  tokens: [
    ...Array.from({ length: 5 }, (_, i) => token(`${i}.0`, [100, 110 + i * 25, 116, 118 + i * 25])),
    token('Power', [80, 130, 90, 170], false, 10),
    token('−2', [77, 120, 85, 130], false, 8),
    token('First', [160, 80, 185, 86], true, 6),
    token('Second', [260, 80, 290, 86], true, 6),
    token('Third', [360, 80, 385, 86], true, 6)
  ],
  rules: [
    [143, 83, 157, 83],
    [243, 83, 257, 83],
    [343, 83, 357, 83]
  ]
})
it('recovers fragmented rotated axis and the complete keyed common legend', () => {
  const f = input()
  expect(nativeAttachedPlotLabels(f.page, f.figure, [], [], f.rules, f.tokens).rect).toEqual([
    77, 80, 500, 250
  ])
})

it.each(['complete', 'gap', 'duplicate-label', 'prose', 'caption', 'table'])(
  'requires complete and unambiguous split top legend keys: %s',
  (change) => {
    const f = input()
    f.tokens = f.tokens.slice(7)
    f.rules = [147, 247, 347].flatMap((x) => [
      [x, 83, x + 5, 83],
      [x + 5, 83, x + 10, 83]
    ])
    const captions: ReturnType<typeof JSON.parse>[] = [],
      tables: number[][] = []
    if (change === 'gap') f.rules[1][0] += 1
    if (change === 'duplicate-label') f.tokens.push({ ...f.tokens[0] })
    if (change === 'prose') f.tokens.push(token('Outside words', [110, 88, 190, 96]))
    if (change === 'caption') captions.push({ page: 1, rect: [110, 88, 190, 96] })
    if (change === 'table') tables.push([110, 88, 190, 96])
    const before = JSON.stringify(f)
    const result = nativeAttachedPlotLabels(f.page, f.figure, captions, tables, f.rules, f.tokens)
    expect(result.rect).toEqual(change === 'complete' ? [100, 80, 500, 250] : f.figure.rect)
    expect(result.sourceItems).toBeUndefined()
    expect(JSON.stringify(f)).toBe(before)
  }
)

it.each(['complete', 'mixed-unit', 'one-row', 'duplicate-row', 'prose', 'caption', 'table'])(
  'requires a consistent repeated percentage column for an exterior axis: %s',
  (change) => {
    const f = input()
    f.tokens = [
      ...Array.from({ length: 4 }, (_, i) =>
        token(`${i * 25}%`, [100, 110 + i * 30, 116, 118 + i * 30])
      ),
      token('Rate', [80, 130, 90, 190], false, 10)
    ]
    f.rules = []
    const captions: ReturnType<typeof JSON.parse>[] = [],
      tables: number[][] = []
    if (change === 'mixed-unit') f.tokens[0].text = '0'
    if (change === 'one-row') f.tokens = [f.tokens[0], f.tokens[4]]
    if (change === 'duplicate-row') f.tokens = [f.tokens[0], f.tokens[0], f.tokens[0], f.tokens[4]]
    if (change === 'prose') f.tokens.push(token('Note', [81, 210, 99, 218]))
    if (change === 'caption') captions.push({ page: 1, rect: [81, 210, 99, 218] })
    if (change === 'table') tables.push([81, 210, 99, 218])
    const before = JSON.stringify(f)
    const result = nativeAttachedPlotLabels(f.page, f.figure, captions, tables, f.rules, f.tokens)
    expect(result.rect).toEqual(change === 'complete' ? [80, 100, 500, 250] : f.figure.rect)
    expect(result.sourceItems).toBeUndefined()
    expect(JSON.stringify(f)).toBe(before)
  }
)

it('completes right colorbar ticks and fragmented rotated labels', () => {
  const f = input()
  f.tokens = [
    ...Array.from({ length: 5 }, (_, i) =>
      token(`${i * 100}`, [496, 110 + i * 25, 514, 118 + i * 25])
    ),
    token('Velocity', [519, 130, 527, 190], false),
    token('x', [522, 122, 528, 130], false, 6)
  ]
  expect(nativeAttachedPlotLabels(f.page, f.figure, [], [], [], f.tokens).rect).toEqual([
    100, 100, 528, 250
  ])
  f.tokens = f.tokens.slice(3)
  expect(nativeAttachedPlotLabels(f.page, f.figure, [], [], [], f.tokens).rect).toEqual(
    f.figure.rect
  )
  f.tokens.push({ ...f.tokens[0] }, { ...f.tokens[0] })
  expect(nativeAttachedPlotLabels(f.page, f.figure, [], [], [], f.tokens).rect).toEqual(
    f.figure.rect
  )
})

it.each(['complete', 'missing-marker', 'duplicate-key', 'prose', 'table', 'caption'])(
  'completes partially owned bottom legend labels only with paired keys: %s',
  (change) => {
    const f = input()
    f.tokens = [
      token('First measure', [190, 248, 280, 256]),
      token('Second measure', [350, 248, 450, 256])
    ]
    f.rules = [
      [166, 252, 176, 252],
      [176, 252, 186, 252],
      [326, 252, 336, 252],
      [336, 252, 346, 252]
    ]
    const tables: number[][] = [],
      captions: ReturnType<typeof JSON.parse>[] = []
    if (change === 'missing-marker') f.rules = f.rules.slice(0, 2)
    if (change === 'duplicate-key') f.tokens[1] = { ...f.tokens[0] }
    if (change === 'prose') f.tokens.push(token('Unowned prose', [100, 250, 150, 258]))
    if (change === 'table') tables.push([100, 250, 150, 258])
    if (change === 'caption') captions.push({ page: 1, rect: [100, 250, 150, 258] })
    expect(
      nativeAttachedPlotLabels(f.page, f.figure, captions, tables, f.rules, f.tokens).rect
    ).toEqual(change === 'complete' ? [100, 100, 500, 256] : f.figure.rect)
  }
)
it.each(['missing-ticks', 'distant-axis', 'missing-markers', 'competing-caption', 'table'])(
  'requires independent ownership for external plot lettering: %s',
  (reason) => {
    const f = input(),
      captions: ReturnType<typeof JSON.parse>[] = [],
      tables: number[][] = []
    if (reason === 'missing-ticks') f.tokens = f.tokens.slice(5)
    if (reason === 'distant-axis')
      f.tokens = f.tokens.filter((t: ReturnType<typeof JSON.parse>) => t.horizontal)
    if (reason === 'missing-markers') f.rules = []
    if (reason === 'competing-caption') captions.push({ page: 1, rect: [77, 80, 190, 90] })
    if (reason === 'table') tables.push([77, 80, 190, 90])
    const rect = nativeAttachedPlotLabels(
      f.page,
      f.figure,
      captions,
      tables,
      f.rules,
      f.tokens
    ).rect
    if (reason === 'missing-ticks' || reason === 'distant-axis') expect(rect[0]).toBe(100)
    if (reason === 'missing-markers') expect(rect[1]).toBe(100)
    if (reason === 'table' || reason === 'competing-caption') expect(rect).toEqual(f.figure.rect)
  }
)
it('recovers one enclosed heading only above repeated populated axes', () => {
  const f = input()
  f.tokens = f.tokens.filter((t: ReturnType<typeof JSON.parse>) => t.rect[1] >= 100)
  f.tokens.push(token('Common panel title', [190, 75, 410, 86], true, 10))
  f.page.graphicsBounds = [
    { kind: 'path', normalizedRect: [90 / 600, 70 / 800, 510 / 600, 260 / 800] }
  ]
  f.rules = [
    [120, 110, 120, 230],
    [280, 110, 280, 230],
    [440, 110, 440, 230]
  ]
  expect(nativeAttachedPlotLabels(f.page, f.figure, [], [], f.rules, f.tokens).rect[1]).toBe(75)
  f.page.graphicsBounds = []
  expect(nativeAttachedPlotLabels(f.page, f.figure, [], [], f.rules, f.tokens).rect[1]).toBe(100)
})

it.each([false, true])(
  'keeps a two-row body tail outside smaller figure lettering, bullets: %s',
  (bullets) => {
    const lines = [
      {
        text: bullets
          ? '• First external operation;'
          : 'A source paragraph with enough words to prove an ordinary body row before the figure.',
        x: 40,
        y: 40,
        width: 440,
        height: 10,
        fontSize: 10
      },
      {
        text: bullets ? '• Second external operation.' : 'Final words.',
        x: 40,
        y: 54,
        width: 140,
        height: 10,
        fontSize: 10
      },
      { text: 'Plot title', x: 120, y: 100, width: 120, height: 6, fontSize: 6 }
    ]
    expect(nativeTopParagraphTail(lines[1], [70, 80, 470, 250], lines)).toBe(true)
    lines[2].fontSize = 10
    expect(nativeTopParagraphTail(lines[1], [70, 80, 470, 250], lines)).toBe(false)
  }
)

const outerAxes = (): ReturnType<typeof JSON.parse> => ({
  page: { pageNumber: 1, width: 600, height: 800, graphicsBounds: [] },
  figure: { rect: [98, 98, 402, 252] },
  rules: [
    [100, 100, 400, 100],
    [100, 250, 400, 250],
    [100, 100, 100, 250],
    [400, 100, 400, 250]
  ],
  tokens: [
    ...Array.from({ length: 4 }, (_, i) => token(String(i), [84, 110 + i * 30, 94, 118 + i * 30])),
    token('Amplitude', [65, 140, 73, 210], false),
    ...Array.from({ length: 4 }, (_, i) =>
      token(String(i), [120 + i * 70, 254, 130 + i * 70, 262])
    ),
    token('Time', [230, 266, 260, 274])
  ]
})
it('completes external tick columns and axis titles from a closed native frame', () => {
  const f = outerAxes()
  expect(nativeAttachedPlotLabels(f.page, f.figure, [], [], f.rules, f.tokens).rect).toEqual([
    65, 98, 402, 274
  ])
})
it.each(['open frame', 'one tick', 'caption barrier', 'body continuation', 'bad token'])(
  'refuses outside frame labels with %s',
  (kind) => {
    const f = outerAxes()
    let captions: unknown[] = []
    if (kind === 'open frame') f.rules.pop()
    if (kind === 'one tick')
      f.tokens = f.tokens.filter((_: unknown, i: number) => i === 0 || i === 4)
    if (kind === 'caption barrier') captions = [{ page: 1, rect: [80, 251, 410, 260] }]
    if (kind === 'body continuation')
      f.tokens.push(
        token('This paragraph must remain separate from the figure.', [70, 265, 400, 273])
      )
    if (kind === 'bad token') f.tokens[0].rect[2] = 70
    expect(
      nativeAttachedPlotLabels(f.page, f.figure, captions, [], f.rules, f.tokens).rect
    ).toEqual(f.figure.rect)
  }
)

const { OPS: axisOps } = await import('pdfjs-dist/legacy/build/pdf.mjs')
const axisModule = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
type AxisSource = { pageNumber: number; index: number; text: string }
type AxisCaption = { page: number; lines: string[]; rect: number[] }
type AxisGraphic = { operationIndex: number; kind: string; normalizedRect: number[] }
type AxisToken = {
  text: string
  rect: number[]
  height: number
  baseline: number
  horizontal: boolean
  sourceItem: AxisSource
}
type AxisRaw = {
  str: string
  dir: string
  width: number
  height: number
  transform: number[]
  fontName: string
  hasEOL: boolean
  sourceItem: AxisSource
}
type AxisFixture = {
  page: {
    pageNumber: number
    width: number
    height: number
    invalidGraphicsBounds: number
    lines: unknown[]
    graphicsBounds: AxisGraphic[]
  }
  figure: { rect: number[]; caption: AxisCaption }
  captions: AxisCaption[]
  tables: number[][]
  rules: number[][]
  tokens: AxisToken[]
  context: {
    operators: { fnArray: number[]; argsArray: unknown[] }
    graphicsBounds: AxisGraphic[]
    viewport: {
      width: number
      height: number
      scale: number
      rotation: number
      transform: number[]
      convertToViewportPoint: (x: number, y: number) => number[]
    }
    content: {
      items: AxisRaw[]
      styles: Record<string, { ascent: number; descent: number; vertical: boolean }>
    }
    glyphBounds: { fontName: string; glyphs: { fontChar: string; bounds: number[] }[] }[]
  }
}
function scriptedAxisFixture(scale = 1): AxisFixture {
  const width = 600 * scale,
    height = 800 * scale
  const fnArray: number[] = [],
    argsArray: unknown[] = []
  const add = (op: number, args: unknown): void => {
    fnArray.push(op)
    argsArray.push(args)
  }
  const rules = [
    [100, 100, 100, 200],
    [500, 100, 500, 200],
    [100, 200, 500, 200]
  ].map((r) => r.map((n) => n * scale))
  const graphicsBounds = rules.map((r) => {
    const operationIndex = fnArray.length
    add(axisOps.constructPath, [
      axisOps.stroke,
      [[0, r[0], height - r[1], 1, r[2], height - r[3]]],
      [
        Math.min(r[0], r[2]),
        height - Math.max(r[1], r[3]),
        Math.max(r[0], r[2]),
        height - Math.min(r[1], r[3])
      ]
    ])
    return {
      operationIndex,
      kind: 'path',
      normalizedRect: [
        (r[0] - 0.5) / width,
        (r[1] - 0.5) / height,
        (r[2] + 0.5) / width,
        (r[3] + 0.5) / height
      ]
    }
  })
  const items: {
    str: string
    dir: string
    width: number
    height: number
    transform: number[]
    fontName: string
    hasEOL: boolean
    sourceItem: { pageNumber: number; index: number; text: string }
  }[] = []
  const tokens: {
    text: string
    rect: number[]
    height: number
    baseline: number
    horizontal: boolean
    sourceItem: { pageNumber: number; index: number; text: string }
  }[] = []
  const glyphs: { fontChar: string; bounds: number[] }[] = []
  let px = 0,
    py = 0
  const show = (text: string, x: number, y: number, size: number): void => {
    x *= scale
    y *= scale
    size *= scale
    add(axisOps.setFont, ['F', size])
    add(axisOps.moveText, [x - px, height - y - py])
    px = x
    py = height - y
    add(axisOps.showText, [
      [{ unicode: text, fontChar: text, width: 500, isInFont: true, isSpace: false, accent: null }]
    ])
    if (!glyphs.some((g) => g.fontChar === text))
      glyphs.push({ fontChar: text, bounds: [0, -0.1, 0.5, 0.7] })
    const index = items.length,
      sourceItem = { pageNumber: 1, index, text }
    items.push({
      str: text,
      dir: 'ltr',
      width: size * 0.5,
      height: size,
      transform: [size, 0, 0, size, x, height - y],
      fontName: 'F',
      hasEOL: false,
      sourceItem
    })
    tokens.push({
      text,
      rect: [x, y - size, x + size * 0.5, y],
      height: size,
      baseline: y,
      horizontal: true,
      sourceItem: { ...sourceItem }
    })
  }
  const begin = (): void => {
    add(axisOps.beginText, null)
    px = py = 0
  }
  for (const [i, x] of [100, 300, 500].entries()) {
    begin()
    show(String(i), x - 2.5, 214, 10)
    add(axisOps.endText, null)
  }
  begin()
  show('A', 294, 239, 14)
  show('u', 301, 233, 8)
  show('v', 301, 243, 8)
  add(axisOps.endText, null)
  begin()
  show('C', 100, 275, 10)
  add(axisOps.endText, null)
  const caption = {
    page: 1,
    lines: ['Figure 1. Plot.'],
    rect: [90, 265, 510, 280].map((n) => n * scale)
  }
  const page = { pageNumber: 1, width, height, invalidGraphicsBounds: 0, lines: [], graphicsBounds }
  return {
    page,
    figure: { rect: [90, 90, 510, 234].map((n) => n * scale), caption },
    captions: [caption],
    tables: [] as number[][],
    rules,
    tokens,
    context: {
      operators: { fnArray, argsArray },
      graphicsBounds,
      viewport: {
        width,
        height,
        scale: 1,
        rotation: 0,
        transform: [1, 0, 0, -1, 0, height],
        convertToViewportPoint: (x: number, y: number): number[] => [x, height - y]
      },
      content: { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
      glyphBounds: [{ fontName: 'F', glyphs }]
    }
  }
}
const completeAxisPacket = (
  f: ReturnType<typeof scriptedAxisFixture>,
  foreign = (): boolean => false
): ReturnType<typeof JSON.parse> =>
  axisModule.nativeAxisTitlePacket?.(
    f.page,
    f.figure,
    f.captions,
    f.tables,
    f.rules,
    f.tokens,
    f.context,
    foreign
  )

it.each([0.75, 1.5])(
  'completes one scripted native x-axis title without a fixed-distance increase at scale %s',
  (scale) => {
    const f = scriptedAxisFixture(scale)
    const proof = completeAxisPacket(f)
    expect(proof?.rect).toHaveLength(4)
    ;[90, 90, 510, 243.8].forEach((n, i) => expect(proof.rect[i]).toBeCloseTo(n * scale, 8))
    expect(proof?.sourceItems).toEqual([])
  }
)

it.each([
  'missing-glyph',
  'font-mismatch',
  'alias',
  'missing-axis',
  'few-ticks',
  'caption',
  'table',
  'foreign',
  'missing-context',
  'unknown-paint',
  'unrelated-text'
])('refuses an unproved axis-title completion: %s', (change) => {
  const f = scriptedAxisFixture()
  if (change === 'missing-glyph') f.context.glyphBounds[0].glyphs.pop()
  if (change === 'font-mismatch') f.context.content.items[3].fontName = 'Other'
  if (change === 'alias') f.tokens.push({ ...f.tokens[3], rect: [10, 10, 17, 24] })
  if (change === 'missing-axis') f.rules.pop()
  if (change === 'few-ticks') {
    f.context.content.items[0].str = 'word'
    f.context.content.items[0].sourceItem.text = 'word'
  }
  if (change === 'caption')
    f.captions.push({ page: 1, lines: ['Figure 2. Other.'], rect: [250, 235, 350, 260] })
  if (change === 'table') f.tables.push([250, 235, 350, 260])
  if (change === 'missing-context') f.context.glyphBounds = []
  if (change === 'unknown-paint') {
    f.context.operators.fnArray.push(axisOps.constructPath)
    f.context.operators.argsArray.push([
      axisOps.fill,
      [[0, 260, 560, 1, 320, 560, 1, 320, 559, 1, 260, 559, 4]],
      [260, 559, 320, 560]
    ])
  }
  if (change === 'unrelated-text') {
    const t = f.tokens.at(-1)!
    t.rect = [100, 236, 105, 246]
    f.context.content.items.at(-1)!.transform[5] = 554
  }
  expect(completeAxisPacket(f, () => change === 'foreign')).toBeUndefined()
})

it.each([
  axisOps.shadingFill,
  axisOps.beginGroup,
  axisOps.paintImageMaskXObject,
  axisOps.setTextRenderingMode,
  99999
])('rejects unsupported native painting or text state %s', (op) => {
  const f = scriptedAxisFixture()
  f.context.operators.fnArray.push(op)
  f.context.operators.argsArray.push([1])
  expect(completeAxisPacket(f)).toBeUndefined()
})
it('rejects a soft mask rather than claiming complete paint inventory', () => {
  const f = scriptedAxisFixture()
  f.context.operators.fnArray.push(axisOps.setGState)
  f.context.operators.argsArray.push([[['SMask', true]]])
  expect(completeAxisPacket(f)).toBeUndefined()
})
