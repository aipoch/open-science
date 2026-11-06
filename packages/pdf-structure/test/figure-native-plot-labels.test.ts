const { tableTextToken } = await import('../resources/literature-pdf-orientation.mjs')
import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
const { nativeAttachedPlotLabels, nativeRasterTitlePixelCrop, nativeRasterTitlePixelPngSafe } =
  await import(
    pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
  )
const { anonymousOrderedRasterLabels } = await import('./fixtures/ordered-raster-labels.mjs')
const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')

it('retains complete native titles above a closed raster matrix without source claims', () => {
  const f = anonymousOrderedRasterLabels({ matrix: true }),
    [page, captions, tables, , , tokens, context] = f.args,
    before = JSON.stringify(f),
    plan = nativeRasterTitlePixelCrop(page, f.figure, captions, tables, tokens, context)
  expect(plan).toBeDefined()
  expect(plan.rect[1]).toBeLessThan(f.figure.rect[1])
  expect(plan.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
  const canvas = createCanvas(
      Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
      Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
    ),
    png = canvas.toBuffer('image/png')
  expect(nativeRasterTitlePixelPngSafe(plan, png, plan.rect, page)).toBe(true)
  expect(
    nativeRasterTitlePixelPngSafe(structuredClone(plan), Buffer.alloc(0), plan.rect, page)
  ).toBe(false)
  const original = context.operators.argsArray
  context.operators.argsArray = structuredClone(original)
  expect(nativeRasterTitlePixelPngSafe(plan, png, plan.rect, page)).toBe(false)
  context.operators.argsArray = original
  expect(nativeRasterTitlePixelPngSafe(plan, png, plan.rect, page)).toBe(true)
  context.glyphBounds[0].glyphs[0].bounds[0] -= 1
  expect(nativeRasterTitlePixelPngSafe(plan, png, plan.rect, page)).toBe(false)
  canvas.width = canvas.height = 0
})

it.each([
  'missing-image',
  'wrong-image-identity',
  'caption',
  'table',
  'caption-text',
  'source-owner',
  'font-metric',
  'Type3',
  'complete-crop',
  'transparent-title',
  'white-title'
])('declines an incomplete or competing raster-title proof: %s', (change) => {
  const f = anonymousOrderedRasterLabels({ matrix: true }),
    [page, captions, tables, , , tokens, context] = f.args
  if (change === 'missing-image') page.graphicsBounds.pop()
  if (change === 'wrong-image-identity')
    page.graphicsBounds[1].operationIndex = page.graphicsBounds[0].operationIndex
  if (change === 'caption') captions.push({ ...captions[0] })
  if (change === 'table') tables.push([50, 35, 350, 290])
  if (change === 'caption-text') captions[0].lines[1] = 'Another title.'
  if (change === 'source-owner') tokens[0].sourceItem.index += 1
  if (change === 'font-metric') delete context.content.styles.F.descent
  if (change === 'Type3') context.type3GlyphPrograms = [{}]
  if (change === 'complete-crop') f.figure.rect[1] = 30
  if (change === 'white-title') context.operators.argsArray[0] = ['#ffffff']
  if (change === 'transparent-title') {
    context.operators.fnArray.splice(1, 0, OPS.setGState)
    context.operators.argsArray.splice(1, 0, [[['ca', 0]]])
    for (const graphic of page.graphicsBounds) graphic.operationIndex += 1
  }
  expect(
    nativeRasterTitlePixelCrop(page, f.figure, captions, tables, tokens, context)
  ).toBeUndefined()
})
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

const { anonymousCertifiedPicture } = await import('./fixtures/figure-recovery-program.mjs')
const {
  createNativeFigurePaintCertificate,
  nativeFigurePaintCertificateData,
  nativePageTextPacketInventory
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const { nativeCertifiedFigurePixelCrop, nativeCertifiedFigurePixelPngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-whole-paint-scope.mjs')).href
)

it.each(['zero-advance', 'solid-mask'])(
  'bounds complete %s paint without granting Source authority',
  (mode) => {
    const f = anonymousCertifiedPicture()
    if (mode === 'zero-advance') f.text('\u0338', 180, 225, true)
    else f.add(OPS.paintSolidColorImageMask, [])
    const handle = createNativeFigurePaintCertificate(f.page, f.tokens, f.context),
      data = nativeFigurePaintCertificateData(handle, f.page, f.tokens, f.context)
    expect(data).toBeDefined()
    for (const key of ['sourceItems', 'records', 'glyphs', 'evidence'])
      expect(data[key]).toBeUndefined()
    expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeUndefined()
    expect(nativeFigurePaintCertificateData({}, f.page, f.tokens, f.context)).toBeUndefined()
  }
)

it('keeps complete drawing pixels separate from the running header and seals the exact proof', () => {
  const f = anonymousCertifiedPicture(),
    plan = nativeCertifiedFigurePixelCrop(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.peers
    )
  expect(plan?.rect).toEqual([68, 78, 192, 253])
  expect(plan.sourceItems).toBeUndefined()
  const canvas = createCanvas((plan.rect[2] - plan.rect[0]) * 4, (plan.rect[3] - plan.rect[1]) * 4),
    png = canvas.toBuffer('image/png')
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  expect(nativeCertifiedFigurePixelPngSafe({ ...plan }, png, plan.rect, f.page)).toBe(false)
  const original = f.context.operators.argsArray
  f.context.operators.argsArray = structuredClone(original)
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  f.context.operators.argsArray = original
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  Object.defineProperty(f.context.content.items[1], 'width', { enumerable: false })
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  canvas.width = canvas.height = 0
})

it.each(['caption', 'table', 'peer', 'foreign-paint'])(
  'declines a competing complete-picture %s',
  (mode) => {
    const f = anonymousCertifiedPicture()
    if (mode === 'caption') f.captions.push({ ...f.captions[0], rect: [70, 80, 100, 100] })
    if (mode === 'table') f.tables.push([70, 80, 100, 100])
    if (mode === 'peer') f.peers.push({ ...f.figure })
    if (mode === 'foreign-paint') f.shape(100, 170, 10, 10)
    expect(
      nativeCertifiedFigurePixelCrop(
        f.page,
        f.figure,
        f.captions,
        f.tables,
        f.tokens,
        f.context,
        f.peers
      )
    ).toBeUndefined()
  }
)

it.each(['getter', 'proxy', 'budget', 'mask-arguments'])(
  'declines incomplete pixel proof: %s',
  (mode) => {
    const f = anonymousCertifiedPicture()
    let reads = 0
    if (mode === 'getter')
      Object.defineProperty(f.context, 'extra', {
        get() {
          reads++
          return 1
        }
      })
    if (mode === 'proxy')
      f.context.extra = new Proxy(
        {},
        {
          get() {
            reads++
            throw Error('read')
          },
          ownKeys() {
            reads++
            throw Error('read')
          }
        }
      )
    if (mode === 'budget') f.context.extra = Array.from({ length: 66000 }, () => ({}))
    if (mode === 'mask-arguments') f.add(OPS.paintSolidColorImageMask, [1])
    expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeUndefined()
    expect(reads).toBe(0)
  }
)

const { anonymousContinuedRaster } = await import('./fixtures/figure-recovery-program.mjs')
const { nativeExplicitContinuationFigurePixelCrop } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-whole-paint-scope.mjs')).href
)
const continuedPictureArguments = (f: ReturnType<typeof JSON.parse>): unknown[] => [
  f.page,
  f.nextCaption,
  f.captions,
  f.tables,
  f.tokens,
  f.context,
  f.nextPage,
  f.nextTokens,
  f.nextContext
]

it('retains each continued raster page only with complete native marker and consecutive panel keys', () => {
  const f = anonymousContinuedRaster(),
    plan = nativeExplicitContinuationFigurePixelCrop(...continuedPictureArguments(f))
  expect(plan.rect).toEqual([48, 48, 352, 164.8])
  expect(plan.graphicsCount).toBe(2)
  expect(plan.caption).toBe(f.nextCaption)
  expect(plan.sourceItems).toBeUndefined()
  const canvas = createCanvas(
      (plan.rect[2] - plan.rect[0]) * 4,
      Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
    ),
    png = canvas.toBuffer('image/png')
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  f.nextContext.content.items[0].str = 'Changed'
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  canvas.width = canvas.height = 0
})
it.each(['caption-pairs', 'page-source', 'next-image', 'ambiguous-caption'])(
  'declines an incomplete continued-picture %s',
  (mode) => {
    const f = anonymousContinuedRaster()
    if (mode === 'caption-pairs') f.nextCaption.lines[1] = 'Paired views (a,b) (e,f).'
    if (mode === 'page-source') f.nextContext.sourceSha256 = 'b'.repeat(64)
    if (mode === 'next-image') f.nextPage.graphicsBounds.pop()
    if (mode === 'ambiguous-caption') f.captions.push({ ...f.nextCaption })
    expect(
      nativeExplicitContinuationFigurePixelCrop(...continuedPictureArguments(f))
    ).toBeUndefined()
  }
)

const { retainNativeRecoveryInputs } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-figure-recovery-profile.mjs')).href
)
it('retains only the exact secondary viewport, including its prototype callbacks and typed bytes', () => {
  const f = anonymousCertifiedPicture()
  class NativeViewport {
    convertToViewportPoint(x: number, y: number): number[] {
      return [x, 400 - y]
    }
  }
  const view = Object.assign(new NativeViewport(), {
    width: 400,
    height: 400,
    transform: [1, 0, 0, -1, 0, 400],
    bytes: new Uint8Array([1, 2])
  })
  f.context.runningHeadWitness = { witnessViewport: view }
  expect(retainNativeRecoveryInputs([f.context], f.context.viewport)).toBeUndefined()
  expect(retainNativeRecoveryInputs([f.context], f.context.viewport, { ...view })).toBeUndefined()
  const keep = retainNativeRecoveryInputs([f.context], f.context.viewport, view)
  expect(keep()).toBe(true)
  const handle = createNativeFigurePaintCertificate(f.page, f.tokens, f.context),
    data = nativeFigurePaintCertificateData(handle, f.page, f.tokens, f.context)
  expect(data).toBeDefined()
  const callback = NativeViewport.prototype.convertToViewportPoint
  NativeViewport.prototype.convertToViewportPoint = (x: number, y: number): number[] => [x, y]
  expect(keep()).toBe(false)
  expect(nativeFigurePaintCertificateData(handle, f.page, f.tokens, f.context)).toBeUndefined()
  NativeViewport.prototype.convertToViewportPoint = callback
  expect(keep()).toBe(true)
  view.bytes[0] = 9
  expect(keep()).toBe(false)
  view.bytes[0] = 1
  f.context.runningHeadWitness.witnessViewport = { ...view }
  expect(nativeFigurePaintCertificateData(handle, f.page, f.tokens, f.context)).toBeUndefined()
})
it.each(['witness-getter', 'viewport-getter', 'viewport-proxy'])(
  'does not execute an unproved secondary viewport: %s',
  (mode) => {
    const f = anonymousCertifiedPicture()
    let reads = 0
    if (mode === 'witness-getter')
      Object.defineProperty(f.context, 'runningHeadWitness', {
        get() {
          reads++
          return {}
        }
      })
    if (mode === 'viewport-getter')
      f.context.runningHeadWitness = Object.defineProperty({}, 'witnessViewport', {
        get() {
          reads++
          return {}
        }
      })
    if (mode === 'viewport-proxy')
      f.context.runningHeadWitness = {
        witnessViewport: new Proxy(
          {},
          {
            get() {
              reads++
              throw Error('read')
            },
            ownKeys() {
              reads++
              throw Error('read')
            },
            getPrototypeOf() {
              reads++
              throw Error('read')
            }
          }
        )
      }
    expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeUndefined()
    expect(reads).toBe(0)
  }
)
it('retains both original continued-page viewports with distinct native prototypes', () => {
  const f = anonymousContinuedRaster()
  class NativeViewport {}
  Object.setPrototypeOf(f.context.viewport, NativeViewport.prototype)
  Object.setPrototypeOf(f.nextContext.viewport, NativeViewport.prototype)
  expect(nativeExplicitContinuationFigurePixelCrop(...continuedPictureArguments(f))).toBeDefined()
})
it('preserves an already complete native crop instead of changing its padding', () => {
  const f = anonymousCertifiedPicture()
  expect(
    nativeCertifiedFigurePixelCrop(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.peers,
      f.crop
    )
  ).toBeUndefined()
})

it.each(['#ffffff', '#000000'])(
  'requires visible missing paint beyond an opaque background: %s',
  (background) => {
    const f = anonymousCertifiedPicture([], background),
      complete = [65, 75, 200, 270],
      plan = nativeCertifiedFigurePixelCrop(
        f.page,
        f.figure,
        f.captions,
        f.tables,
        f.tokens,
        f.context,
        f.peers,
        complete
      )
    if (background === '#ffffff') expect(plan).toBeUndefined()
    else expect(plan).toBeDefined()
    const handle = createNativeFigurePaintCertificate(f.page, f.tokens, f.context),
      data = nativeFigurePaintCertificateData(handle, f.page, f.tokens, f.context),
      backgroundPiece = data.pieces.find(
        (p: { kind: string; rect: number[] }) => p.kind === 'path' && p.rect[0] === 50
      )
    expect(backgroundPiece.rect).toEqual([50, 65, 340, 275])
    expect(backgroundPiece.opaqueWhiteFill).toBe(background === '#ffffff')
  }
)

it.each([false, true])(
  'uses actual solid-path witnesses rather than a conservative miter box: missing=%s',
  (missing) => {
    const f = anonymousCertifiedPicture([], undefined, true),
      old = missing ? [75, 75, 200, 270] : [65, 75, 200, 270],
      plan = nativeCertifiedFigurePixelCrop(
        f.page,
        f.figure,
        f.captions,
        f.tables,
        f.tokens,
        f.context,
        f.peers,
        old
      ),
      h = createNativeFigurePaintCertificate(f.page, f.tokens, f.context),
      data = nativeFigurePaintCertificateData(h, f.page, f.tokens, f.context),
      stroke = data.pieces.find(
        (p: { kind: string; floor: number }) => p.kind === 'path' && p.floor > 0
      )
    expect(stroke.rect).toEqual([60, 70, 100, 100])
    expect(stroke.visiblePaintPoints.length).toBeGreaterThan(0)
    if (missing) expect(plan).toBeDefined()
    else expect(plan).toBeUndefined()
  }
)
it('protects all existing figure paint when one drawing scope omits another panel', () => {
  const f = anonymousCertifiedPicture([], undefined, false, true)
  expect(
    nativeCertifiedFigurePixelCrop(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.peers,
      f.crop
    )
  ).toBeUndefined()
})

it.each([
  ['HEADER', '3'],
  ['RUNNING', 'FIGURE', 'HEADER', '3'],
  ['RUNNING', 'p', 'HEADER', '3'],
  ['running', 'p', 'header', '3']
])('requires a complete same-parity native leading header row with %s', (...parts) => {
  const f = anonymousCertifiedPicture([], undefined, false, false, parts)
  const math = f.context.glyphBounds[0].glyphs.find(
    (glyph: { fontChar: string }) => glyph.fontChar === 'p'
  )
  if (math) math.bounds = [-0.03, -0.2, 0.6, 0.9]
  f.page.pageNumber = f.context.pageNumber = f.figure.caption.page = 3
  for (const raw of f.context.content.items) raw.sourceItem.pageNumber = 3
  const previous = structuredClone(f.context.content)
  for (const raw of previous.items) delete raw.sourceItem
  previous.items[parts.length - 1].str = '1'
  f.context.runningHeadWitness = {
    sourceSha256: f.context.sourceSha256,
    currentPageNumber: 3,
    witnessPageNumber: 1,
    currentContent: f.context.content,
    witnessContent: previous,
    witnessViewport: f.context.viewport
  }
  f.figure.rect = [35, 20, 355, 285]
  const args = [f.page, f.figure, f.captions, f.tables, f.tokens, f.context, f.peers, f.figure.rect]
  if (parts.every((part) => !/\p{Lu}/u.test(part))) {
    expect(nativeCertifiedFigurePixelCrop(...args)).toBeUndefined()
    return
  }
  expect(nativeCertifiedFigurePixelCrop(...args)).toBeDefined()
  const first = previous.items[0].str
  previous.items[0].str = 'DIFFERENT'
  expect(nativeCertifiedFigurePixelCrop(...args)).toBeUndefined()
  previous.items[0].str = first
  previous.items[0].transform[4] += 1
  expect(nativeCertifiedFigurePixelCrop(...args)).toBeUndefined()
  previous.items[0].transform[4] -= 1
  previous.styles.F.ascent += 0.01
  expect(nativeCertifiedFigurePixelCrop(...args)).toBeUndefined()
})

it.each([false, true])(
  'does not use a raster envelope alone as a missing-ink witness: %s',
  (missingPaint) => {
    const f = anonymousCertifiedPicture(),
      o = f.context.operators
    const i = o.fnArray.indexOf(OPS.paintFormXObjectEnd)
    o.fnArray.splice(i, 0, OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore)
    o.argsArray.splice(i, 0, null, [140, 0, 0, 180, 60, 140], ['invented-margin', 140, 180], null)
    f.page.graphicsBounds.push({
      kind: 'image',
      operationIndex: i + 2,
      normalizedRect: [0.15, 0.2, 0.5, 0.65],
      imageHash: 'b'.repeat(64)
    })
    const old = [missingPaint ? 75 : 65, 75, 200, 270]
    const plan = nativeCertifiedFigurePixelCrop(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.peers,
      old
    )
    const h = createNativeFigurePaintCertificate(f.page, f.tokens, f.context)
    const data = nativeFigurePaintCertificateData(h, f.page, f.tokens, f.context)
    expect(data.pieces.filter((p: { kind: string }) => p.kind === 'image')).toHaveLength(1)
    if (missingPaint) expect(plan).toBeDefined()
    else expect(plan).toBeUndefined()
  }
)

it('declines a subcaption packet that borrows a separately printed external note', () => {
  const f = anonymousOrderedRasterLabels(),
    [page, captions, tables, , , tokens, context] = f.args
  page.pageNumber = context.pageNumber = 1
  page.rotation = page.renderRotation = 0
  context.sourceSha256 = 'a'.repeat(64)
  page.graphicsBounds.forEach((g, i) => {
    g.imageHash = String(i + 1).repeat(64)
  })
  for (const r of context.content.items) {
    if (!['(a)', '(b)'].includes(r.str)) continue
    const old = r.str,
      text = old + 'Panel'
    const i = context.operators.fnArray.findIndex(
      (op, i) => op === OPS.showText && context.operators.argsArray[i][0][0].unicode === old
    )
    const g = context.operators.argsArray[i][0][0]
    g.unicode = g.fontChar = text
    g.width = 500 * text.length
    const metric = context.glyphBounds[0].glyphs.find((g) => g.fontChar === old)
    metric.fontChar = text
    metric.bounds = [0, -0.1, 0.5 * text.length, 0.7]
    r.str = text
    r.width = 4 * text.length
    r.sourceItem.text = text
  }
  for (let i = context.operators.fnArray.length - 1; i >= 0; i--) {
    if (
      context.operators.fnArray[i] === OPS.showText &&
      ['Near', 'Far', 'View'].includes(context.operators.argsArray[i][0][0].unicode)
    ) {
      context.operators.fnArray.splice(i - 3, 5)
      context.operators.argsArray.splice(i - 3, 5)
    }
  }
  context.content.items = context.content.items.filter(
    (r) => !['Near', 'Far', 'View'].includes(r.str)
  )
  context.content.items.forEach((r, index) => {
    r.sourceItem.index = index
  })
  const beforeImageOps = context.operators.fnArray.flatMap((op, i) =>
    op === OPS.paintImageXObject ? [i] : []
  )
  page.graphicsBounds.forEach((g, i) => {
    g.operationIndex = beforeImageOps[i]
  })
  tokens.splice(
    0,
    tokens.length,
    ...context.content.items.map((r) => tableTextToken(r, context.viewport, 0))
  )
  expect(
    nativeCertifiedFigurePixelCrop(page, f.figure, captions, tables, tokens, context, [f.figure])
  ).toBeDefined()
  // An intersected descriptor glyph alone does not prove a missing packet.
  expect(
    nativeCertifiedFigurePixelCrop(
      page,
      f.figure,
      captions,
      tables,
      tokens,
      context,
      [f.figure],
      [48, 48, 352, 162]
    )
  ).toBeUndefined()
  // The description closes, but a later showText in its BT is an external note.
  const i = context.operators.fnArray.findIndex(
    (op, i) => op === OPS.showText && context.operators.argsArray[i][0][0].unicode === '(b)Panel'
  )
  context.operators.fnArray.splice(i + 1, 0, OPS.setTextMatrix, OPS.showText)
  context.operators.argsArray.splice(
    i + 1,
    0,
    [[1, 0, 0, 1, 220, 220]],
    [[{ unicode: 'Notes: External', fontChar: 'Notes: External', width: 7500, isInFont: true }]]
  )
  const r = {
    ...context.content.items.find((r) => r.str === '(b)Panel'),
    str: 'Notes: External',
    width: 60,
    transform: [8, 0, 0, 8, 220, 220],
    sourceItem: { pageNumber: 1, index: context.content.items.length, text: 'Notes: External' }
  }
  context.content.items.push(r)
  tokens.push(tableTextToken(r, context.viewport, 0))
  context.glyphBounds[0].glyphs.push({ fontChar: 'Notes: External', bounds: [0, -0.1, 7.5, 0.7] })
  const imageOps = context.operators.fnArray.flatMap((op, i) =>
    op === OPS.paintImageXObject ? [i] : []
  )
  page.graphicsBounds.forEach((g, i) => {
    g.operationIndex = imageOps[i]
  })
  expect(createNativeFigurePaintCertificate(page, tokens, context)).toBeDefined()
  expect(
    nativeCertifiedFigurePixelCrop(page, f.figure, captions, tables, tokens, context, [f.figure])
  ).toBeUndefined()
})

function anonymousTwinHeading(): ReturnType<typeof anonymousCertifiedPicture> {
  const f = anonymousCertifiedPicture(),
    o = f.context.operators
  o.fnArray.length =
    o.argsArray.length =
    f.context.content.items.length =
    f.tokens.length =
    f.context.glyphBounds[0].glyphs.length =
    f.page.graphicsBounds.length =
      0
  f.add(f.OPS.setFillRGBColor, ['#000000'])
  f.add(f.OPS.setStrokeRGBColor, ['#000000'])
  f.add(f.OPS.setLineWidth, [0.5])
  let serial = 0
  const panels: [number, number, number, string][] = [
    [60, 140, 4, '(a) First panel'],
    [225, 110, 6, '(b) Second panel']
  ]
  for (const [x, top, rows, label] of panels) {
    f.add(f.OPS.save, null)
    f.text(label, x, top - 10)
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < 5; c++) {
        f.shape(x + c * 20, top + r * 15, 20, 15, f.OPS.stroke)
        f.text(String.fromCodePoint(0x2460 + serial++), x + c * 20 + 7, top + r * 15 + 10)
      }
    f.add(f.OPS.restore, null)
  }
  f.text('Figure 1. Two panels.', 50, 235)
  const caption = { page: 1, rect: [50, 225, 350, 240], lines: ['Figure 1. Two panels.'] }
  f.figure.caption = caption
  f.figure.rect = [55, 105, 330, 205]
  f.captions.splice(0, f.captions.length, caption)
  // The exterior default/raw distinction stays literal and grants no Source.
  f.text('µ', 20, 350)
  const raw = f.context.content.items.at(-1)! as { str: string; sourceItem: { text: string } },
    token = f.tokens.at(-1)!
  raw.str = raw.sourceItem.text = token.text = 'μ'
  return f
}

it('completes staggered above-grid headings through two original pixel-only save scopes', () => {
  const f = anonymousTwinHeading(),
    before = JSON.stringify(f),
    plan = nativeCertifiedFigurePixelCrop(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.peers
    )
  expect(plan?.kind).toBe('complete-native-above-heading-twin-scope')
  expect(plan?.rect).toEqual([
    52.166666666666664, 88.66666666666667, 332.8333333333333, 207.83333333333334
  ])
  expect(plan?.sourceItems).toBeUndefined()
  expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
  // The live SDK/render epoch may retain a separate, exactly matching token
  // origin. Both real object graphs remain sealed; neither is rebound.
  const separate = anonymousTwinHeading()
  separate.tokens[0].sourceItem = { ...separate.tokens[0].sourceItem }
  expect(
    nativeCertifiedFigurePixelCrop(
      separate.page,
      separate.figure,
      separate.captions,
      separate.tables,
      separate.tokens,
      separate.context,
      separate.peers
    )
  ).toBeDefined()
})

it.each([
  'caption',
  'table',
  'peer',
  'foreign-paint',
  'long-body-prose',
  'heading-width',
  'heading-source',
  'already-complete'
])('keeps valid full paint but declines an ambiguous above-heading pair: %s', (mode) => {
  const f = anonymousTwinHeading()
  if (mode === 'caption')
    f.captions.push({ page: 1, rect: [220, 85, 260, 100], lines: ['Figure 2. Other.'] })
  if (mode === 'table') f.tables.push([220, 85, 260, 100])
  if (mode === 'peer') f.peers.push({ ...f.figure, rect: [220, 85, 260, 100] })
  if (mode === 'foreign-paint') f.shape(185, 100, 20, 20)
  if (mode === 'heading-width') {
    const token = f.tokens.find((t) => t.text.startsWith('(b)'))!,
      raw = f.context.content.items[token.sourceItem.index] as { width: number }
    raw.width += 2
    token.rect[2] += 2
  }
  if (mode === 'heading-source') {
    const token = f.tokens.find((t) => t.text.startsWith('(b)'))!
    token.sourceItem = { ...token.sourceItem, text: token.sourceItem.text + ' mismatch' }
  }
  if (mode === 'already-complete') f.figure.rect = [45, 80, 350, 215]
  if (mode === 'long-body-prose') {
    const o = f.context.operators,
      fnArray = o.fnArray as number[],
      at = fnArray.lastIndexOf(f.OPS.restore),
      count = o.fnArray.length
    f.text('An unrelated complete ordinary paragraph inside this save scope.', 65, 215)
    const ops = fnArray.splice(count),
      args = o.argsArray.splice(count)
    fnArray.splice(at, 0, ...ops)
    o.argsArray.splice(at, 0, ...args)
  }
  expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeDefined()
  expect(
    nativeCertifiedFigurePixelCrop(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.peers
    )
  ).toBeUndefined()
})

it.each([
  'operator-identity',
  'title-font-identity',
  'source-token-identity',
  'output-identity',
  'peers'
])('revokes an above-heading pixel plan after late %s replacement', (mutation) => {
  const f = anonymousTwinHeading(),
    plan = nativeCertifiedFigurePixelCrop(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.peers
    )
  expect(plan).toBeDefined()
  const canvas = createCanvas(
    Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
    Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
  )
  try {
    const png = canvas.toBuffer('image/png')
    expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
    if (mutation === 'operator-identity')
      f.context.operators.argsArray = structuredClone(f.context.operators.argsArray)
    if (mutation === 'title-font-identity')
      f.context.content.styles.F = { ...f.context.content.styles.F }
    if (mutation === 'source-token-identity') f.tokens[0].sourceItem = { ...f.tokens[0].sourceItem }
    if (mutation === 'output-identity') plan.rect = [...plan.rect]
    if (mutation === 'peers') f.peers.push({ ...f.figure, rect: [220, 85, 260, 100] })
    expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  } finally {
    canvas.width = canvas.height = 1
  }
})

it.each([
  'below',
  'right',
  'wrong-row',
  'wrong-column',
  'lone-column',
  'lone-row',
  'heading-packet-tail',
  'complete-lanes',
  'duplicate-column',
  'incomplete-label'
])('requires complete unique cell-label lanes in a valid paint program: %s', (mode) => {
  const f = anonymousTwinHeading(),
    o = f.context.operators,
    fnArray = o.fnArray as number[],
    argsArray = o.argsArray as unknown[],
    at = fnArray.lastIndexOf(f.OPS.restore),
    count = fnArray.length
  if (['complete-lanes', 'duplicate-column', 'incomplete-label'].includes(mode)) {
    for (let c = 0; c < 5; c++) f.text('t' + c, 230 + c * 20, 108)
    for (let r = 0; r < 6; r++) f.text('g' + r, 205, 120 + r * 15)
    if (mode === 'duplicate-column') f.text('x', 225, 108)
    if (mode === 'incomplete-label') {
      const token = f.tokens.find((t) => t.text === 'g0')!,
        raw = f.context.content.items[token.sourceItem.index] as { width: number }
      raw.width += 1
      token.rect[2] += 1
    }
  } else if (mode === 'below' || mode === 'heading-packet-tail') f.text('Note.', 225, 207)
  else if (mode === 'right') f.text('x', 329, 150)
  else if (mode === 'wrong-row') f.text('x', 210, 126)
  else if (mode === 'wrong-column') f.text('x', 242, 108)
  else if (mode === 'lone-column') f.text('x', 232, 108)
  else if (mode === 'lone-row') f.text('x', 210, 120)
  const ops = fnArray.splice(count),
    args = argsArray.splice(count)
  if (mode === 'heading-packet-tail') {
    const begin = fnArray.lastIndexOf(f.OPS.save),
      end = fnArray.indexOf(f.OPS.endText, begin)
    fnArray.splice(end, 0, ...ops.slice(1, -1))
    argsArray.splice(end, 0, ...args.slice(1, -1))
  } else {
    fnArray.splice(at, 0, ...ops)
    argsArray.splice(at, 0, ...args)
  }
  expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeDefined()
  const plan = nativeCertifiedFigurePixelCrop(
    f.page,
    f.figure,
    f.captions,
    f.tables,
    f.tokens,
    f.context,
    f.peers
  )
  if (mode === 'complete-lanes') expect(plan).toBeDefined()
  else expect(plan).toBeUndefined()
})

function anonymousAboveCaptionNotes(mode = 'notes'): ReturnType<typeof anonymousCertifiedPicture> {
  const f = anonymousCertifiedPicture()
  f.context.operators.fnArray.length = f.context.operators.argsArray.length = 0
  f.context.content.items.length = f.context.glyphBounds[0].glyphs.length = 0
  f.tokens.length = f.page.graphicsBounds.length = 0
  f.add(f.OPS.setFillRGBColor, ['#000000'])
  f.text('Figure 1. Drawing.', 60, 50)
  f.add(f.OPS.paintFormXObjectBegin, [null, [40, 120, 350, 340]])
  f.shape(70, 80, 20, 10)
  f.shape(100, 140, 40, 10)
  f.shape(140, 220, 50, 10)
  f.text('Axis', 80, 110)
  f.text('Value', 100, 250)
  if (mode !== 'notes-in-form') f.add(f.OPS.paintFormXObjectEnd, null)
  const first =
    mode === 'panel-description'
      ? '(a) Independent prose explains these observations.'
      : mode === 'unmarked-prose'
        ? 'Independent prose explains these observations.'
        : 'Notes: Independent prose explains these observations.'
  f.text(first, 60, 290)
  f.text('The complete statement remains outside the drawing.', 60, 302)
  f.text('The surrounding explanation remains available.', 60, 314)
  if (mode === 'notes-in-form') f.add(f.OPS.paintFormXObjectEnd, null)
  if (mode === 'external-legend') f.text('Treatment', 60, 270)
  if (mode === 'external-path') f.shape(65, 265, 10, 5)
  if (mode === 'next-paragraph') f.text('A separate paragraph has a native indent.', 70, 326)
  if (mode === 'missing-eol')
    (f.context.content.items as { hasEOL: boolean }[]).at(-1)!.hasEOL = false
  f.figure.caption.rect = [60, 42, 150, 52]
  f.figure.caption.lines = ['Figure 1. Drawing.']
  f.figure.rect = [60, 75, 240, 315]
  return f
}

it('keeps a complete above-caption Form separate from an independently closed Notes paragraph', () => {
  const f = anonymousAboveCaptionNotes(),
    before = JSON.stringify(f),
    plan = nativeCertifiedFigurePixelCrop(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.peers
    )
  expect(plan?.rect).toEqual([68, 78, 192, 253])
  expect(plan?.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})

it.each([
  'panel-description',
  'unmarked-prose',
  'notes-in-form',
  'external-legend',
  'external-path',
  'next-paragraph',
  'missing-eol'
])('retains complete original paint but refuses ambiguous exterior text: %s', (mode) => {
  const f = anonymousAboveCaptionNotes(mode)
  expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeDefined()
  expect(
    nativeCertifiedFigurePixelCrop(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.peers
    )
  ).toBeUndefined()
})

it.each(['notes-source', 'notes-eol', 'font', 'operator-array', 'output'])(
  'revokes an above-caption pixel-only plan after late %s replacement',
  (mode) => {
    const f = anonymousAboveCaptionNotes(),
      plan = nativeCertifiedFigurePixelCrop(
        f.page,
        f.figure,
        f.captions,
        f.tables,
        f.tokens,
        f.context,
        f.peers
      ),
      canvas = createCanvas(
        Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
        Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
      )
    try {
      const png = canvas.toBuffer('image/png')
      expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
      const note = (
        f.context.content.items as {
          hasEOL: boolean
          sourceItem: { pageNumber: number; index: number; text: string }
        }[]
      ).at(-1)!
      if (mode === 'notes-source') note.sourceItem = { ...note.sourceItem }
      if (mode === 'notes-eol') note.hasEOL = false
      if (mode === 'font') f.context.content.styles.F = { ...f.context.content.styles.F }
      if (mode === 'operator-array')
        f.context.operators.argsArray = structuredClone(f.context.operators.argsArray)
      if (mode === 'output') plan.rect = [...plan.rect]
      expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
    } finally {
      canvas.width = canvas.height = 1
    }
  }
)

const pairedRasterSaveFixture = (shifted = false): ReturnType<typeof JSON.parse> => {
  const f: ReturnType<typeof JSON.parse> = anonymousCertifiedPicture(
    [],
    undefined,
    false,
    false,
    []
  )
  f.context.operators.fnArray.length = 0
  f.context.operators.argsArray.length = 0
  f.context.content.items.length = 0
  f.context.glyphBounds[0].glyphs.length = 0
  f.page.graphicsBounds.length = 0
  f.tokens.length = 0
  const image = (x: number, y: number, width: number, height: number): void => {
    f.add(OPS.save, null)
    f.add(OPS.transform, [width, 0, 0, height, x, 400 - y - height])
    const operationIndex = f.context.operators.fnArray.length
    f.add(OPS.paintImageXObject, ['anonymous-image', 1, 1])
    f.page.graphicsBounds.push({
      kind: 'image',
      operationIndex,
      normalizedRect: [x / 400, y / 400, (x + width) / 400, (y + height) / 400],
      imageHash: 'c'.repeat(64)
    })
    f.add(OPS.restore, null)
  }
  f.add(OPS.setFillRGBColor, ['#000000'])
  f.add(OPS.save, null)
  f.add(OPS.paintFormXObjectBegin, [null, [50, 240, 285, 310]])
  f.add(OPS.setFillRGBColor, ['#ffffff'])
  f.shape(50, 90, 235, 70)
  f.add(OPS.setFillRGBColor, ['#000000'])
  for (const x of [60, 110, 160, 210]) image(x, 100, 40, 40)
  image(260, 100, 4, 40)
  f.text('0', 270, 105)
  f.text('1', 270, 135)
  f.add(OPS.paintFormXObjectEnd, null)
  f.text('First', 92.5, 80)
  f.text('Second', 190, 79)
  for (const [i, text] of ['A', 'B', 'C', 'D'].entries())
    f.text(text, 77.5 + i * 50 + (shifted && i === 1 ? 6 : 0), 155)
  f.shape(154.5, 75, 1, 90)
  f.add(OPS.restore, null)
  f.text('Figure 1. Paired raster comparisons.', 60, 210)
  const caption = {
    page: 1,
    rect: [60, 200, 300, 215],
    lines: ['Figure 1. Paired raster comparisons.']
  }
  f.figure.caption = caption
  f.figure.rect = [58, 98, 255, 143]
  f.figure.reason = 'native-raster-horizontal-array'
  f.captions = [caption]
  f.peers = [f.figure]
  return f
}

const pairedRasterSavePlan = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  nativeCertifiedFigurePixelCrop(
    f.page,
    f.figure,
    f.captions,
    f.tables,
    f.tokens,
    f.context,
    f.peers
  )

it('keeps a paired raster plate with its complete parent headings and labels, without Source claims', () => {
  const f = pairedRasterSaveFixture(),
    plan = pairedRasterSavePlan(f)
  // The original white Form clips its fill at x=50/285; only the final
  // outward margin extends those two sides. This oracle comes from that
  // fixture program, not the candidate's measured rectangle.
  expect(plan?.rect).toEqual([50 - 2 / 1.5, 70, 285 + 2 / 1.5, 167])
  expect(plan.sourceItems).toBeUndefined()
  const canvas = createCanvas(Math.ceil((plan.rect[2] - plan.rect[0]) * 4), 388),
    png = canvas.toBuffer('image/png')
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  const original = f.context.operators.argsArray
  f.context.operators.argsArray = structuredClone(original)
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  canvas.width = canvas.height = 0
})

it.each(['ordinary-paragraph', 'below-note', 'wrong-column', 'foreign-paint'])(
  'declines a valid complete paired raster program with %s outside the closed label lanes',
  (mode) => {
    const f = pairedRasterSaveFixture(mode === 'wrong-column'),
      ops = f.context.operators
    if (mode === 'foreign-paint') f.shape(55, 80, 10, 10)
    else if (mode !== 'wrong-column') {
      const restore = ops.fnArray.lastIndexOf(OPS.restore),
        suffixFns = ops.fnArray.splice(restore),
        suffixArgs = ops.argsArray.splice(restore),
        captionRaw = f.context.content.items.pop(),
        captionToken = f.tokens.pop()
      if (mode === 'ordinary-paragraph')
        for (let i = 0; i < 5; i++) f.text(`Unrelated ordinary prose line ${i}`, 50, 20 + i * 10)
      if (mode === 'below-note') f.text('Note', 70, 180)
      ops.fnArray.push(...suffixFns)
      ops.argsArray.push(...suffixArgs)
      captionRaw.sourceItem.index = f.context.content.items.length
      captionToken.sourceItem = captionRaw.sourceItem
      f.context.content.items.push(captionRaw)
      f.tokens.push(captionToken)
    }
    const handle = createNativeFigurePaintCertificate(f.page, f.tokens, f.context)
    expect(nativeFigurePaintCertificateData(handle, f.page, f.tokens, f.context)).toBeDefined()
    expect(pairedRasterSavePlan(f)).toBeUndefined()
  }
)

it('preserves a complete published paired raster plate without padding churn', () => {
  const f = pairedRasterSaveFixture()
  f.figure.rect = [50 - 2 / 1.5, 70, 285 + 2 / 1.5, 167]
  expect(pairedRasterSavePlan(f)).toBeUndefined()
})

const multipartLaterCaptionFixture = (captionTop = 280): ReturnType<typeof JSON.parse> => {
  const f: ReturnType<typeof JSON.parse> = anonymousCertifiedPicture(
    [],
    undefined,
    false,
    false,
    []
  )
  f.context.operators.fnArray.length = 0
  f.context.operators.argsArray.length = 0
  f.context.content.items.length = 0
  f.context.glyphBounds[0].glyphs.length = 0
  f.page.graphicsBounds.length = 0
  f.tokens.length = 0
  f.add(OPS.setFillRGBColor, ['#000000'])
  for (const [i, x] of [50, 220].entries()) {
    f.add(OPS.save, null)
    f.add(OPS.transform, [130, 0, 0, 70, x, 260])
    const operationIndex = f.context.operators.fnArray.length
    f.add(OPS.paintImageXObject, [`anonymous-panel-${i}`, 1, 1])
    f.page.graphicsBounds.push({
      kind: 'image',
      operationIndex,
      normalizedRect: [x / 400, 70 / 400, (x + 130) / 400, 140 / 400],
      imageHash: String(i + 1).repeat(64)
    })
    f.add(OPS.restore, null)
    f.text(`(${String.fromCharCode(97 + i)})Complete panel`, x + 10, 165)
    f.context.operators.fnArray.pop()
    f.context.operators.argsArray.pop()
    const secondLine = f.context.operators.fnArray.length
    f.text(`Second view ${i}`, x + 10, 176)
    f.context.operators.fnArray.splice(secondLine, 1)
    f.context.operators.argsArray.splice(secondLine, 1)
  }
  f.text('Figure 1. Independent panels.', 50, 230)
  f.text('Table 1. Later measurements.', 50, captionTop + 10)
  const caption = { page: 1, rect: [50, 220, 350, 235], lines: ['Figure 1. Independent panels.'] },
    later = {
      page: 1,
      rect: [50, captionTop, 350, captionTop + 15],
      lines: ['Table 1. Later measurements.']
    }
  f.figure.caption = caption
  f.figure.rect = [50, 70, 350, 162]
  f.figure.reason = 'native-raster-horizontal-array'
  f.captions = [caption, later]
  f.tables = [[50, 310, 350, 350]]
  f.peers = [f.figure]
  return f
}

it('retains complete multipart descriptions before a separate later Table caption without deleting exclusions', () => {
  const f = multipartLaterCaptionFixture(),
    plan = pairedRasterSavePlan(f)
  // At the existing minimum render scale 1.5, one safety pixel on each
  // original image/glyph plus two outward pixels give a total 2pt margin.
  expect(plan?.rect).toEqual([48, 68, 352, 179])
  expect(plan.sourceItems).toBeUndefined()
  expect(f.captions).toHaveLength(2)
  expect(f.captions[1].lines[0]).toBe('Table 1. Later measurements.')
  const canvas = createCanvas(
      Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
      Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
    ),
    png = canvas.toBuffer('image/png')
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  f.captions[1].rect = [...f.captions[1].rect]
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  canvas.width = canvas.height = 0
})

it.each(['same-height-caption', 'earlier-caption', 'foreign-table', 'foreign-peer'])(
  'declines complete multipart paint when a retained exclusion is %s',
  (mode) => {
    const f = multipartLaterCaptionFixture(
      mode === 'same-height-caption' ? 220 : mode === 'earlier-caption' ? 190 : 280
    )
    if (mode === 'foreign-table') f.tables.push([100, 100, 160, 130])
    if (mode === 'foreign-peer') f.peers.push({ rect: [100, 100, 160, 130] })
    const handle = createNativeFigurePaintCertificate(f.page, f.tokens, f.context)
    expect(nativeFigurePaintCertificateData(handle, f.page, f.tokens, f.context)).toBeDefined()
    expect(pairedRasterSavePlan(f)).toBeUndefined()
  }
)

const repeatedRasterHeaderFixture = (): ReturnType<typeof JSON.parse> => {
  const f = anonymousCertifiedPicture([], undefined, false, false, [])
  for (const values of [
    f.context.operators.fnArray,
    f.context.operators.argsArray,
    f.context.content.items,
    f.context.glyphBounds[0].glyphs,
    f.page.graphicsBounds,
    f.tokens
  ])
    values.length = 0
  f.add(OPS.setFillRGBColor, ['#000000'])
  f.text('3', 30, 30)
  f.text('A´', 100, 30)
  const at = f.context.operators.fnArray.lastIndexOf(OPS.showText)
  f.context.operators.argsArray[at] = [
    [
      { unicode: 'A', fontChar: 'A', width: 500, isInFont: true },
      { unicode: '´', fontChar: '´', width: 500, isInFont: true }
    ]
  ]
  f.context.glyphBounds[0].glyphs.push(
    { fontChar: 'A', bounds: [0, -0.1, 0.5, 0.7] },
    { fontChar: '´', bounds: [0.2, 0, 0.5, 0.7] }
  )
  // The original native source overlap is real; literal and glyph identities stay separate.
  f.text('oZ', 105.001, 30)
  for (const [n, x] of [40, 145, 250].entries()) {
    f.add(OPS.save, null)
    f.add(OPS.transform, [90, 0, 0, 60, x, 260])
    const operationIndex = f.context.operators.fnArray.length
    f.add(OPS.paintImageXObject, ['anonymous-image', 1, 1])
    f.page.graphicsBounds.push({
      kind: 'image',
      operationIndex,
      normalizedRect: [x / 400, 80 / 400, (x + 90) / 400, 140 / 400],
      imageHash: 'c'.repeat(64)
    })
    f.add(OPS.restore, null)
    f.text(`(${String.fromCharCode(97 + n)})`, x + 37.5, 155)
  }
  const line = 'Figure 1. Three native panels.'
  f.text(line, 40, 210)
  const caption = { page: 3, rect: [40, 200, 350, 215], lines: [line] }
  f.figure.caption = caption
  f.figure.rect = [25, 20, 350, 170]
  f.captions = [caption]
  f.peers = [f.figure]
  f.page.pageNumber = f.context.pageNumber = 3
  for (const raw of f.context.content.items) raw.sourceItem.pageNumber = 3
  const previous = structuredClone(f.context.content)
  previous.items[0].str = '1'
  for (const raw of previous.items) delete raw.sourceItem
  f.context.runningHeadWitness = {
    sourceSha256: f.context.sourceSha256,
    currentPageNumber: 3,
    witnessPageNumber: 1,
    currentContent: f.context.content,
    witnessContent: previous,
    witnessViewport: f.context.viewport
  }
  return f
}
const repeatedRasterHeaderPlan = (
  f: ReturnType<typeof JSON.parse>
): ReturnType<typeof JSON.parse> =>
  nativeCertifiedFigurePixelCrop(
    f.page,
    f.figure,
    f.captions,
    f.tables,
    f.tokens,
    f.context,
    f.peers
  )

it('excludes a repeated native header with overlapping source advances from three closed raster panels', () => {
  const f = repeatedRasterHeaderFixture(),
    before = JSON.stringify(f),
    plan = repeatedRasterHeaderPlan(f)
  expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeDefined()
  expect(plan?.rect).toEqual([38, 78, 342, 158])
  expect(JSON.stringify(f)).toBe(before)
  for (const key of ['sourceItems', 'records', 'evidence', 'glyphs'])
    expect(plan[key]).toBeUndefined()
  const canvas = createCanvas(1216, 320),
    png = canvas.toBuffer('image/png')
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  const previous = f.context.runningHeadWitness.witnessContent
  f.context.runningHeadWitness.witnessContent = structuredClone(previous)
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  f.context.runningHeadWitness.witnessContent = previous
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  f.context.content.items[1].sourceItem.index += 1
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  canvas.width = canvas.height = 0
})

it.each([
  'witness-literal',
  'witness-position',
  'witness-font',
  'source-inventory',
  'image-width',
  'wrong-label',
  'foreign-paint',
  'table',
  'caption',
  'peer',
  'touching-padding',
  'duplicate-glyph'
])('keeps repeated-header raster ownership closed with %s', (mode) => {
  const f = repeatedRasterHeaderFixture(),
    witness = f.context.runningHeadWitness.witnessContent
  if (mode === 'witness-literal') witness.items[1].str = 'OTHER'
  if (mode === 'witness-position') witness.items[1].transform[4] += 1
  if (mode === 'witness-font') witness.styles.F.ascent += 0.01
  if (mode === 'source-inventory') f.context.content.items[1].sourceItem.text = 'OTHER'
  if (mode === 'image-width') {
    const graphic = f.page.graphicsBounds[1]
    f.context.operators.argsArray[graphic.operationIndex - 1][0] += 1
    graphic.normalizedRect[2] += 1 / 400
  }
  if (mode === 'wrong-label') {
    const raw = f.context.content.items[4],
      index = f.context.operators.fnArray.findIndex(
        (op: number, i: number) =>
          op === OPS.showText && f.context.operators.argsArray[i][0][0].unicode === '(b)'
      )
    raw.str = raw.sourceItem.text = f.tokens[4].text = '(d)'
    Object.assign(f.context.operators.argsArray[index][0][0], { unicode: '(d)', fontChar: '(d)' })
    f.context.glyphBounds[0].glyphs.find(
      (g: { fontChar: string }) => g.fontChar === '(b)'
    ).fontChar = '(d)'
  }
  if (mode === 'foreign-paint') f.shape(140, 100, 1, 1)
  if (mode === 'table') f.tables.push([40, 80, 130, 140])
  if (mode === 'caption') f.captions.push({ ...f.figure.caption, rect: [40, 80, 130, 140] })
  if (mode === 'peer') f.peers.push({ ...f.figure, rect: [40, 80, 130, 140] })
  if (mode === 'touching-padding')
    f.context.glyphBounds[0].glyphs.find(
      (g: { fontChar: string }) => g.fontChar === '´'
    ).bounds[1] = -4.75
  if (mode === 'duplicate-glyph') {
    const raw = f.context.content.items[1],
      index = f.context.operators.fnArray.findIndex(
        (op: number, i: number) =>
          op === OPS.showText && f.context.operators.argsArray[i][0][0].unicode === 'A'
      )
    const show = f.context.operators.argsArray[index][0]
    show.push(500, { ...show[1] })
    raw.str = raw.sourceItem.text = f.tokens[1].text = witness.items[1].str = 'A´´'
    expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeDefined()
  }
  expect(repeatedRasterHeaderPlan(f)).toBeUndefined()
})

it('tightens only blank padding against the complete repeated header barrier', () => {
  const f = repeatedRasterHeaderFixture()
  f.context.glyphBounds[0].glyphs.find((g: { fontChar: string }) => g.fontChar === '´').bounds[1] =
    -4.7
  const plan = repeatedRasterHeaderPlan(f)
  expect(plan?.rect).toEqual([38, 79, 342, 158])
  const canvas = createCanvas(1216, 316),
    png = canvas.toBuffer('image/png')
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  canvas.width = canvas.height = 0
})

it('preserves the old vector-header refusal when original header advances overlap', () => {
  const f = repeatedRasterHeaderFixture()
  for (const x of [60, 165, 270]) f.shape(x, 100, 1, 1)
  expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeDefined()
  expect(repeatedRasterHeaderPlan(f)).toBeUndefined()
})

// A complete numbered body remains exterior to a separately saved drawing.
const numberedBodyBeforePicture = (variant = ''): ReturnType<typeof JSON.parse> => {
  const f = anonymousCertifiedPicture([], undefined, false, false, [])
  for (const values of [
    f.context.operators.fnArray,
    f.context.operators.argsArray,
    f.context.content.items,
    f.context.glyphBounds[0].glyphs,
    f.page.graphicsBounds,
    f.tokens
  ])
    values.length = 0
  f.add(OPS.setFillRGBColor, ['#000000'])
  f.text('z=0', 120, 80)
  f.text('(2.4)', 30, 80)
  f.text('The forward relation is', 30, 110)
  f.text('x=1', 120, 140)
  f.text('(2.5)', 30, 140)
  f.text('The center relation is', 30, 170)
  if (variant === 'clipped formula') {
    f.add(OPS.save, null)
    f.add(OPS.constructPath, [
      OPS.clip,
      [[0, 0, 210, 1, 400, 210, 1, 400, 400, 1, 0, 400, 4]],
      [0, 210, 400, 400]
    ])
  }
  f.text(variant === 'formula word' ? 'y=Panel' : 'y=2', 120, 200)
  f.text(', ', 140, 200)
  const gapShow = f.context.operators.fnArray.findIndex(
    (op: number, i: number) =>
      op === OPS.showText && f.context.operators.argsArray[i][0][0].unicode === ', '
  )
  Object.assign(f.context.operators.argsArray[gapShow][0][0], {
    unicode: ',',
    fontChar: ',',
    width: 500
  })
  Object.assign(
    f.context.glyphBounds[0].glyphs.find((g: { fontChar: string }) => g.fontChar === ', '),
    { fontChar: ',', bounds: [0, -0.1, 0.5, 0.7] }
  )
  f.text(
    variant === 'incomplete formula' ? '(2.6' : variant === 'broken sequence' ? '(2.8)' : '(2.6)',
    30,
    200
  )
  if (variant === 'clipped formula') f.add(OPS.restore, null)
  if (variant === 'outside panel') f.text('Panel B', 200, 225)
  if (variant === 'outside math panel') f.text('q=7', 230, 225)
  if (variant === 'unknown paint') f.shape(160, 220, 3, 3)
  f.add(OPS.save, null)
  f.shape(80, 250, 40, 30)
  f.shape(180, 250, 40, 30)
  f.shape(125, 265, 45, 2)
  f.text('A', 90, 270)
  f.text('B', 190, 270)
  f.text('(u,v)', 90, 340)
  f.text('(s,t)', 190, 340)
  f.add(OPS.restore, null)
  const line = 'Figure 1. A coordinate drawing.'
  f.text(line, 40, 380)
  const caption = { page: 1, rect: [40, 370, 330, 385], lines: [line] }
  f.figure.caption = caption
  f.figure.rect = [70, 100, 280, 310]
  f.captions = [caption]
  f.peers = [f.figure]
  return f
}

it('separates complete numbered body formulas and includes all saved bottom labels', () => {
  const f = numberedBodyBeforePicture(),
    before = JSON.stringify(f)
  expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeUndefined()
  const plan = nativeCertifiedFigurePixelCrop(
    f.page,
    f.figure,
    f.captions,
    f.tables,
    f.tokens,
    f.context,
    f.peers
  )
  expect(plan).toBeDefined()
  expect(plan.rect[1]).toBeGreaterThan(220)
  expect(plan.rect[3]).toBeGreaterThan(340)
  expect(plan.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
  const canvas = createCanvas(
      Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
      Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
    ),
    png = canvas.toBuffer('image/png')
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  const tiny = createCanvas(1, 1)
  expect(
    nativeCertifiedFigurePixelPngSafe(plan, tiny.toBuffer('image/png'), plan.rect, f.page)
  ).toBe(false)
  tiny.width = tiny.height = 0
  const original = f.context.operators.argsArray
  f.context.operators.argsArray = structuredClone(original)
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  f.context.operators.argsArray = original
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  expect(
    nativeCertifiedFigurePixelPngSafe(
      plan,
      canvas.toBuffer('image/png'),
      [plan.rect[0], plan.rect[1], plan.rect[2], plan.rect[3] - 5],
      f.page
    )
  ).toBe(false)
  f.context.operators.fnArray.push(OPS.clip)
  f.context.operators.argsArray.push(null)
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  canvas.width = canvas.height = 0
})
it.each([
  'outside panel',
  'outside math panel',
  'unknown paint',
  'incomplete formula',
  'broken sequence',
  'formula word',
  'missing source',
  'missing font',
  'clipped formula'
])('retains unknown exterior picture content instead of excluding %s', (variant) => {
  const f = numberedBodyBeforePicture(variant)
  if (variant === 'missing source') f.context.content.items[3].sourceItem.index += 1
  if (variant === 'missing font') delete f.context.content.styles.F.descent
  expect(
    nativeCertifiedFigurePixelCrop(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.peers
    )
  ).toBeUndefined()
})

const continuedBodyBeforePicture = (variant = ''): ReturnType<typeof JSON.parse> => {
  const f = anonymousCertifiedPicture([], undefined, false, false, [])
  for (const values of [
    f.context.operators.fnArray,
    f.context.operators.argsArray,
    f.context.content.items,
    f.context.glyphBounds[0].glyphs,
    f.page.graphicsBounds,
    f.tokens
  ])
    values.length = 0
  f.add(OPS.setFillRGBColor, ['#000000'])
  const lines = [
    'continued results from the first group support the proposed relation',
    'the second group shows the same trend with consistent measurements',
    'these clear results offer direct support for our final conclusion.'
  ]
  if (variant === 'note')
    lines[0] = 'Note: continued results describe the independently drawn panel.'
  if (variant === 'annotation')
    lines[0] = 'An annotation describes the meaning of the independent panel.'
  if (variant === 'title')
    lines[0] = 'Overview of the independent panel and its complete components.'
  if (variant === 'unfinished') lines[2] = lines[2].slice(0, -1)
  if (variant === 'narrow-row') lines[1] = 'we see no big gap in all ten new runs'
  for (const [i, line] of lines.entries()) f.text(line, 20, 40 + i * 15)
  f.context.content.items[2].hasEOL = false
  if (variant === 'unknown-text') f.text('Panel Q', 200, 120)
  if (variant === 'unknown-paint') f.shape(160, 120, 3, 3)
  f.add(OPS.save, null)
  f.shape(80, 160, 40, 30)
  f.shape(180, 160, 40, 30)
  f.shape(125, 175, 45, 2)
  f.text('A', 90, 180)
  f.text('B', 190, 180)
  f.text('(u,v)', 90, 260)
  f.text('(s,t)', 190, 260)
  f.add(OPS.restore, null)
  const line = 'Figure 1. A saved coordinate drawing.'
  f.text(line, 20, 335)
  const caption = { page: 1, rect: [20, 325, 360, 340], lines: [line] }
  f.figure.caption = caption
  f.figure.rect = [20, 30, 340, 235]
  f.captions = [caption]
  f.peers = [f.figure]
  if (variant !== 'no-body-witness')
    f.text('The body remains available for ordinary translation after this drawing.', 20, 365)
  if (variant === 'missing-source') f.context.content.items[0].sourceItem.index += 1
  if (variant === 'missing-font') delete f.context.content.styles.F.descent
  return f
}

it('excludes a completely proved opening body while preserving every saved drawing label', () => {
  const f = continuedBodyBeforePicture(),
    before = JSON.stringify(f),
    plan = nativeCertifiedFigurePixelCrop(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.peers
    )
  expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeDefined()
  expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeDefined()
  expect(plan).toBeDefined()
  expect(plan.rect[1]).toBeGreaterThan(120)
  expect(plan.rect[3]).toBeGreaterThan(260)
  expect(plan.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
  const canvas = createCanvas(
      Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
      Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
    ),
    png = canvas.toBuffer('image/png')
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  const old = f.context.content.items[0].sourceItem
  f.context.content.items[0].sourceItem = { ...old }
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  f.context.content.items[0].sourceItem = old
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  canvas.width = canvas.height = 0
})

it.each([
  'note',
  'annotation',
  'title',
  'unfinished',
  'narrow-row',
  'unknown-text',
  'unknown-paint',
  'no-body-witness',
  'missing-source',
  'missing-font'
])('keeps unproved opening content inside the old picture: %s', (variant) => {
  const f = continuedBodyBeforePicture(variant)
  expect(
    nativeCertifiedFigurePixelCrop(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.peers
    )
  ).toBeUndefined()
})

it('accepts native zero metrics only with the complete original glyph and Source packet', () => {
  const f = continuedBodyBeforePicture()
  f.context.content.styles.F.ascent = 0
  f.context.content.styles.F.descent = 0
  for (const t of f.tokens) {
    t.fontAscent = t.fontDescent = 0
    delete t.nativeLabelRect
  }
  expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeDefined()
  expect(
    nativeCertifiedFigurePixelCrop(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.peers
    )
  ).toBeDefined()
})

const captionedRasterNotes = (count = 2, variant = ''): ReturnType<typeof JSON.parse> => {
  const f = anonymousCertifiedPicture([], undefined, false, false, [])
  for (const values of [
    f.context.operators.fnArray,
    f.context.operators.argsArray,
    f.context.content.items,
    f.context.glyphBounds[0].glyphs,
    f.page.graphicsBounds,
    f.tokens
  ])
    values.length = 0
  f.add(OPS.setFillRGBColor, ['#000000'])
  const line = 'Figure 1. Paired raster views.'
  f.text(line, 40, 35)
  const caption = { page: 1, rect: [40, 25, 350, 40], lines: [line] }
  f.figure.caption = caption
  for (let i = 0; i < count; i++) {
    const x = 40 + (i % 2) * 180,
      y = 80 + Math.floor(i / 2) * 120,
      letter = variant === 'broken-keys' && i === 1 ? 'd' : String.fromCharCode(97 + i)
    f.text(`(${letter}) Panel ${letter}`, x + 10, y - 15)
    f.add(OPS.save, null)
    f.add(OPS.transform, [140, 0, 0, 70, x, 400 - y - 70])
    const operationIndex = f.context.operators.fnArray.length
    f.add(OPS.paintImageXObject, [`generated-view-${i}`, 1, 1])
    f.page.graphicsBounds.push({
      kind: 'image',
      operationIndex,
      normalizedRect: [x / 400, y / 400, (x + 140) / 400, (y + 70) / 400],
      imageHash: String(i + 1).repeat(64)
    })
    f.add(OPS.restore, null)
  }
  const noteY = count === 2 ? 170 : 290
  f.text(
    variant === 'no-figure-reference'
      ? 'Note: These results describe the complete measured outcomes.'
      : 'Note: These panels compare the complete measured outcomes.',
    40,
    noteY
  )
  if (variant !== 'one-line')
    f.text(
      variant === 'unfinished'
        ? 'The same units apply to each view'
        : 'The same units and complete range apply to each view.',
      40,
      noteY + 14
    )
  if (variant !== 'no-next-boundary')
    f.text('This ordinary text follows the complete figure annotation.', 40, noteY + 50)
  if (variant === 'unknown-paint') f.shape(190, 130, 3, 3)
  if (variant === 'extra-label') f.text('Unowned label', 180, 135)
  if (variant === 'missing-source') f.context.content.items[1].sourceItem.index += 1
  if (variant === 'missing-font') delete f.context.content.styles.F.descent
  f.figure.rect = [40, 80, 360, noteY + 2]
  f.captions = [caption]
  f.peers = [f.figure]
  return f
}

it.each([2, 4])(
  'retains every native panel description and the complete Note for %i raster views',
  (count) => {
    const f = captionedRasterNotes(count),
      before = JSON.stringify(f),
      plan = nativeCertifiedFigurePixelCrop(
        f.page,
        f.figure,
        f.captions,
        f.tables,
        f.tokens,
        f.context,
        f.peers
      )
    expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeDefined()
    expect(plan).toBeDefined()
    expect(plan.rect[1]).toBeLessThan(65)
    expect(plan.rect[3]).toBeGreaterThan(count === 2 ? 184 : 304)
    expect(plan.sourceItems).toBeUndefined()
    expect(JSON.stringify(f)).toBe(before)
    const canvas = createCanvas(
        Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
        Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
      ),
      png = canvas.toBuffer('image/png')
    expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
    f.context.content.items[1].sourceItem = { ...f.context.content.items[1].sourceItem }
    expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
    canvas.width = canvas.height = 0
  }
)
it.each([
  'broken-keys',
  'no-figure-reference',
  'one-line',
  'unfinished',
  'no-next-boundary',
  'unknown-paint',
  'extra-label',
  'missing-source',
  'missing-font'
])('preserves raster Notes refusal when the native range lacks %s proof', (variant) => {
  const f = captionedRasterNotes(2, variant)
  expect(
    nativeCertifiedFigurePixelCrop(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.peers
    )
  ).toBeUndefined()
})

const stackedSourceFormsFixture = (mode = ''): ReturnType<typeof JSON.parse> => {
  const f = anonymousCertifiedPicture([], undefined, false, false, [])
  for (const values of [
    f.context.operators.fnArray,
    f.context.operators.argsArray,
    f.context.content.items,
    f.context.glyphBounds[0].glyphs,
    f.page.graphicsBounds,
    f.tokens
  ])
    values.length = 0
  f.add(OPS.setFillRGBColor, ['#000000'])
  const starts: number[] = []
  const rows = mode === 'intermediate' ? 3 : 2
  for (let row = 0; row < rows; row++) {
    const y = 60 + row * (rows === 3 ? 100 : 110)
    starts.push(f.context.content.items.length)
    f.add(OPS.paintFormXObjectBegin, [null, [20, 400 - y - 90, 380, 400 - y + 20]])
    f.text('Train group ' + row, 50, y)
    f.text('Evaluation group ' + row, 220, y)
    f.shape(55, y + 10, 100, 60)
    f.shape(225, y + 10, 100, 60)
    f.text('Revenue units', 130, y + 85)
    f.add(OPS.paintFormXObjectEnd, null)
  }
  const line = 'Figure 1. Distributions for the top and bottom groups.'
  const captionY = rows === 3 ? 380 : 300
  f.text(line, 25, captionY)
  f.figure.caption = { page: 1, rect: [25, captionY - 10, 390, captionY + 5], lines: [line] }
  f.figure.rect = [30, 160, 365, 265]
  f.figure.sourceItems = f.context.content.items
    .slice(starts[1], starts[1] + 3)
    .map((r) => r.sourceItem)
  f.figure.graphicsCount = 2
  f.captions = [f.figure.caption]
  f.peers = [f.figure]
  if (mode === 'foreign-paint') f.shape(190, 135, 10, 10)
  if (mode === 'missing-font') delete f.context.content.styles.F.descent
  if (mode === 'wrong-claim') f.figure.sourceItems = [f.context.content.items.at(-1).sourceItem]
  if (mode === 'no-pair-caption') f.figure.caption.lines = ['Figure 1. An independent group.']
  if (mode === 'noncontiguous') f.figure.sourceItems = f.figure.sourceItems.slice(1)
  // A real font dictionary records each used glyph once, even when the source repeats it.
  f.context.glyphBounds[0].glyphs = [
    ...new Map(f.context.glyphBounds[0].glyphs.map((g) => [g.fontChar, g])).values()
  ]
  return f
}
it('closes every original stacked Form and its complete claims without mutating the old partial owner', () => {
  const f = stackedSourceFormsFixture(),
    before = JSON.stringify(f),
    plan = repeatedRasterHeaderPlan(f)
  expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeDefined()
  expect(
    nativeFigurePaintCertificateData(
      createNativeFigurePaintCertificate(f.page, f.tokens, f.context),
      f.page,
      f.tokens,
      f.context
    )
  ).toBeDefined()
  expect(plan?.kind).toBe('complete-native-stacked-source-forms')
  expect(plan.sourceItems).toHaveLength(6)
  expect(plan.sourceItems.slice(3)).toEqual(f.figure.sourceItems)
  expect(plan.graphicsCount).toBe(4)
  expect(JSON.stringify(f)).toBe(before)
  const canvas = createCanvas(
    Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
    Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
  )
  expect(
    nativeCertifiedFigurePixelPngSafe(plan, canvas.toBuffer('image/png'), plan.rect, f.page)
  ).toBe(true)
  const oldClaims = JSON.stringify(f.figure.sourceItems)
  expect(nativeCertifiedFigurePixelPngSafe(plan, Buffer.alloc(0), plan.rect, f.page)).toBe(false)
  expect(JSON.stringify(f.figure.sourceItems)).toBe(oldClaims)
  expect(f.figure.graphicsCount).toBe(2)
  plan.sourceItems = [...plan.sourceItems]
  expect(
    nativeCertifiedFigurePixelPngSafe(plan, canvas.toBuffer('image/png'), plan.rect, f.page)
  ).toBe(false)
  canvas.width = canvas.height = 0
})
it.each(['foreign-paint', 'missing-font', 'wrong-claim', 'no-pair-caption', 'noncontiguous'])(
  'declines stacked complete claims with %s',
  (mode) => {
    const f = stackedSourceFormsFixture(mode),
      before = JSON.stringify(f)
    expect(repeatedRasterHeaderPlan(f)).toBeUndefined()
    expect(JSON.stringify(f)).toBe(before)
  }
)
const describedRasterHeaderFixture = (offsetLast = false): ReturnType<typeof JSON.parse> => {
  const f = anonymousCertifiedPicture([], undefined, false, false, [])
  for (const values of [
    f.context.operators.fnArray,
    f.context.operators.argsArray,
    f.context.content.items,
    f.context.glyphBounds[0].glyphs,
    f.page.graphicsBounds,
    f.tokens
  ])
    values.length = 0
  f.add(OPS.setFillRGBColor, ['#000000'])
  f.text('3', 30, 30)
  f.text('SURVEY TITLE', 100, 30)
  for (const [i, x] of [40, 145, 250].entries()) {
    const width = [90, 96, 82][i],
      height = [60, 64, 58][i],
      bottom = offsetLast && i === 2 ? 142 : 140
    f.add(OPS.save, null)
    f.add(OPS.transform, [width, 0, 0, height, x, 400 - bottom])
    const operationIndex = f.context.operators.fnArray.length
    f.add(OPS.paintImageXObject, ['generated-view', 1, 1])
    f.page.graphicsBounds.push({
      kind: 'image',
      operationIndex,
      normalizedRect: [x / 400, (bottom - height) / 400, (x + width) / 400, bottom / 400],
      imageHash: 'c'.repeat(64)
    })
    f.add(OPS.restore, null)
  }
  for (let i = 0; i < 3; i++) {
    const x = 40 + i * 105,
      labelOffset = ([90, 96, 82][i] - 70) / 2
    f.text('(' + String.fromCharCode(97 + i) + ')', x + labelOffset, 155)
    f.text('Full view.', x + labelOffset + 20, 155)
  }
  const line = 'Figure 1. Three full views.'
  f.text(line, 40, 210)
  f.figure.caption = { page: 3, rect: [40, 200, 350, 215], lines: [line] }
  f.figure.rect = [25, 20, 350, 170]
  f.captions = [f.figure.caption]
  f.peers = [f.figure]
  f.page.pageNumber = f.context.pageNumber = 3
  for (const r of f.context.content.items) r.sourceItem.pageNumber = 3
  const prior = structuredClone(f.context.content)
  prior.items[0].str = '1'
  for (const r of prior.items) delete r.sourceItem
  f.context.runningHeadWitness = {
    sourceSha256: f.context.sourceSha256,
    currentPageNumber: 3,
    witnessPageNumber: 1,
    currentContent: f.context.content,
    witnessContent: prior,
    witnessViewport: f.context.viewport
  }
  f.context.glyphBounds[0].glyphs = [
    ...new Map(f.context.glyphBounds[0].glyphs.map((g) => [g.fontChar, g])).values()
  ]
  return f
}
it('excludes only a repeated native header while retaining complete raster descriptions', () => {
  const f = describedRasterHeaderFixture(),
    before = JSON.stringify(f),
    plan = repeatedRasterHeaderPlan(f)
  expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeDefined()
  expect(plan?.kind).toBe('complete-native-raster-row-with-repeated-header')
  expect(plan.rect[1]).toBeGreaterThan(50)
  expect(plan.rect[3]).toBeGreaterThan(155)
  expect(plan.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})
it('retains the old raster owner when its native previous-page header witness is absent', () => {
  const f = describedRasterHeaderFixture()
  delete f.context.runningHeadWitness
  expect(repeatedRasterHeaderPlan(f)).toBeUndefined()
})

it('rejects complete raster descriptions when their images do not share a native bottom edge', () => {
  expect(repeatedRasterHeaderPlan(describedRasterHeaderFixture(true))).toBeUndefined()
})

it('refuses an undeclared middle Form when the complete caption identifies only top and bottom groups', () => {
  expect(repeatedRasterHeaderPlan(stackedSourceFormsFixture('intermediate'))).toBeUndefined()
})

const { nativeOrdinaryBodyReferenceMetadata } =
  await import('../resources/literature-pdf-caption-group.mjs')
const ordinaryReferenceMetadataFixture = (mode = ''): ReturnType<typeof JSON.parse> => {
  const f = anonymousCertifiedPicture([], undefined, false, false, [])
  for (const values of [
    f.context.operators.fnArray,
    f.context.operators.argsArray,
    f.context.content.items,
    f.context.glyphBounds[0].glyphs,
    f.page.graphicsBounds,
    f.tokens
  ])
    values.length = 0
  f.context.content.styles.M = { ascent: 0.9, descent: -0.2, vertical: false }
  const marker = (text: string, x: number, y: number): void => {
    const at = f.context.operators.fnArray.length
    f.text(text, x, y)
    f.context.operators.argsArray[at + 1][0] = 'M'
    f.context.content.items.at(-1).fontName = 'M'
    const glyph = f.context.glyphBounds[0].glyphs.pop()
    let font = f.context.glyphBounds.find((font) => font.fontName === 'M')
    if (!font) f.context.glyphBounds.push((font = { fontName: 'M', glyphs: [] }))
    font.glyphs.push(glyph)
  }
  f.add(OPS.setFillRGBColor, ['#000000'])
  marker('Figure 2.', 40, 80)
  f.text('A measured response.', 90, 80)
  f.text('The separate complete caption ends here.', 40, 94)
  const trueCaption = {
    page: 1,
    rect: [40, 70, 350, 94],
    lines: ['Figure 2. A measured response.', 'The separate complete caption ends here.']
  }
  const lines = [
    'Figure 2 compares the complete groups using data.',
    'The measured response is explained in ordinary words.',
    'Each of the groups remains part of the full sentence.',
    mode === 'unfinished' ? 'The comparison continues' : 'The complete comparison is retained.'
  ]
  for (const [i, line] of lines.entries()) f.text(line, i ? 40 : 55, 120 + i * 14)
  marker(mode === 'no-heading' ? 'An independent section' : 'II Methods', 40, 200)
  f.text('The following section has independent text.', 55, 224)
  const caption = { page: 1, rect: [40, 110, 350, 162], lines }
  const figure = {
    id: 'generated-reference',
    page: 1,
    caption: { ...caption, text: lines.join(' ') },
    issue: 'no-unambiguous-adjacent-graphics',
    graphicsCount: 0
  }
  const trueFigure = {
    id: 'generated-plot',
    page: 1,
    region: [0.1, 0.08, 0.88, 0.15],
    thumbnail: 'thumbnails/generated.png',
    caption: { ...trueCaption, text: trueCaption.lines.join(' ') }
  }
  f.figure = figure
  f.captions = [trueCaption, caption]
  f.peers = [trueFigure, figure]
  if (mode === 'font') delete f.context.content.styles.F.descent
  if (mode === 'roi') f.figure.region = [0.1, 0.2, 0.8, 0.4]
  if (mode === 'missing-true') f.captions = [caption]
  if (mode === 'unknown-paint') f.shape(200, 140, 3, 3)
  if (mode === 'literal')
    f.figure.caption.lines = [lines[0], 'Replaced middle source line.', ...lines.slice(2)]
  f.page.lines = f.context.content.items.map((r) => ({
    text: r.str,
    x: r.transform[4],
    y: 400 - r.transform[5] - r.height,
    width: r.width,
    height: r.height,
    fontSize: r.height
  }))
  return f
}
const ordinaryMetadataProof = (f): ReturnType<typeof JSON.parse> =>
  nativeOrdinaryBodyReferenceMetadata?.(f.figure, f.page, f.captions, f.peers, f.context)
it('removes only a native null-image body-reference association after its complete original parent closes', () => {
  const f = ordinaryReferenceMetadataFixture(),
    before = JSON.stringify(f),
    proof = ordinaryMetadataProof(f)
  expect(proof).toBeDefined()
  expect(proof.current()).toBe(true)
  expect(JSON.stringify(f)).toBe(before)
  f.context.content.items[4].sourceItem = { ...f.context.content.items[4].sourceItem }
  expect(proof.current()).toBe(false)
})
it.each(['font', 'roi', 'missing-true', 'unknown-paint', 'literal', 'unfinished', 'no-heading'])(
  'retains optional metadata when its complete native ordinary-parent proof lacks %s',
  (mode) => {
    expect(ordinaryMetadataProof(ordinaryReferenceMetadataFixture(mode))).toBeUndefined()
  }
)
it('does not release a true caption with a published original image', () => {
  const f = ordinaryReferenceMetadataFixture()
  f.figure = f.peers[0]
  expect(ordinaryMetadataProof(f)).toBeUndefined()
})

const openingParagraphFormFixture = (mode = ''): ReturnType<typeof JSON.parse> => {
  const f = anonymousCertifiedPicture([], undefined, false, false, [])
  for (const values of [
    f.context.operators.fnArray,
    f.context.operators.argsArray,
    f.context.content.items,
    f.context.glyphBounds[0].glyphs,
    f.page.graphicsBounds,
    f.tokens
  ])
    values.length = 0
  f.add(OPS.setFillRGBColor, ['#000000'])
  const lines = [
    'An opening paragraph explains Figure 4 and the measured groups.',
    'The following words complete the original ordinary context.',
    'Every printed word remains part of this complete native source domain.',
    mode === 'unfinished'
      ? 'The native paragraph continues beyond this scope'
      : 'The original source provenance stays unchanged throughout processing.'
  ]
  const emit = (text: string, x: number, y: number, mismatch = false): void => {
    const at = f.context.operators.fnArray.length
    f.text(text, x, y)
    if (mismatch) f.context.operators.argsArray[at + 3][0][0].unicode = text.replace('μ', 'µ')
  }
  if (mode === 'note') lines[0] = lines[0].replace('An opening', 'Note: opening')
  if (mode === 'body-unicode') lines[1] += ' μ.'
  for (const [i, line] of lines.entries())
    emit(line, i || mode === 'no-indent' ? 40 : 55, 50 + i * 18, mode === 'body-unicode' && i === 1)
  f.bodySourceIndices = f.context.content.items.map((r) => r.sourceItem.index)
  f.context.content.items.at(-1).hasEOL = false
  if (mode === 'open-text') {
    f.context.operators.fnArray.pop()
    f.context.operators.argsArray.pop()
  }
  if (mode === 'unknown-paint') f.shape(200, 90, 4, 4)
  f.add(OPS.paintFormXObjectBegin, [null, [20, 140, 390, 250]])
  f.shape(55, 175, 110, 45)
  f.shape(225, 175, 110, 45)
  f.text('Horizontal axis', 130, 239)
  f.add(OPS.paintFormXObjectEnd, null)
  if (mode === 'peer-form') {
    f.add(OPS.paintFormXObjectBegin, [null, [20, 140, 390, 250]])
    f.shape(180, 175, 20, 20)
    f.add(OPS.paintFormXObjectEnd, null)
  }
  const caption = [
    'Figure 4. A complete native response.',
    'The original caption includes a comparison , μ.'
  ]
  emit(caption[0], 30, 280)
  emit(caption[1], 30, 298, true)
  f.figure.caption = { page: 1, rect: [30, 270, 390, 305], lines: caption }
  f.figure.rect = [25, 25, 390, 250]
  f.figure.graphicsCount = 1
  f.captions = [f.figure.caption]
  f.peers = [f.figure]
  if (mode === 'font') delete f.context.content.styles.F.descent
  if (mode === 'owned-source') f.context.content.items[1].sourceItem.text += ' altered'
  // Each generated native font entry is a single used glyph, independent of repeated text.
  f.context.glyphBounds[0].glyphs = [
    ...new Map(f.context.glyphBounds[0].glyphs.map((g) => [g.fontChar, g])).values()
  ]
  return f
}
it('separates a complete opening paragraph from its unique native Form while retaining foreign compound micro text', () => {
  const f = openingParagraphFormFixture(),
    before = JSON.stringify(f),
    plan = repeatedRasterHeaderPlan(f)
  const packet = nativePageTextPacketInventory(
    f.page,
    f.tokens,
    f.context,
    true,
    new Set(f.bodySourceIndices),
    true
  )
  expect(packet.records.at(-1).foreignSourceNormalized).toBe(true)
  expect(
    packet.records
      .filter((r) => f.bodySourceIndices.includes(r.index))
      .every((r) => !r.foreignSourceNormalized && r.advanceComplete)
  ).toBe(true)
  expect(plan?.kind).toBe('complete-native-form-after-opening-body')
  expect(plan.rect[1]).toBeGreaterThan(150)
  expect(plan.rect[3]).toBeLessThan(f.figure.caption.rect[1])
  expect(Object.hasOwn(plan, 'sourceItems')).toBe(false)
  expect(f.figure.graphicsCount).toBe(1)
  expect(JSON.stringify(f)).toBe(before)
  const canvas = createCanvas(
    Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
    Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
  )
  expect(
    nativeCertifiedFigurePixelPngSafe(plan, canvas.toBuffer('image/png'), plan.rect, f.page)
  ).toBe(true)
  expect(nativeCertifiedFigurePixelPngSafe(plan, Buffer.alloc(0), plan.rect, f.page)).toBe(false)
  f.context.content.items[0].sourceItem = { ...f.context.content.items[0].sourceItem }
  expect(
    nativeCertifiedFigurePixelPngSafe(plan, canvas.toBuffer('image/png'), plan.rect, f.page)
  ).toBe(false)
  canvas.width = canvas.height = 0
})
it.each([
  'body-unicode',
  'unfinished',
  'no-indent',
  'unknown-paint',
  'peer-form',
  'font',
  'owned-source',
  'note',
  'open-text'
])('preserves opening paragraph refusal for %s without changing Source or hasEOL', (mode) => {
  const f = openingParagraphFormFixture(mode),
    before = JSON.stringify(f)
  expect(repeatedRasterHeaderPlan(f)).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})

it('rejects a nonfinite separately styled true-caption marker before omitting ordinary metadata', () => {
  const f = ordinaryReferenceMetadataFixture()
  f.context.content.styles.M.ascent = Number.NaN
  expect(ordinaryMetadataProof(f)).toBeUndefined()
})
it('requires an explicit horizontal style for the independently printed heading and marker font', () => {
  const f = ordinaryReferenceMetadataFixture()
  f.context.content.styles.M.vertical = 0
  expect(ordinaryMetadataProof(f)).toBeUndefined()
})
it('rejects stacked native claims when their font only has a falsey vertical flag', () => {
  const f = stackedSourceFormsFixture()
  f.context.content.styles.F.vertical = 0
  expect(repeatedRasterHeaderPlan(f)).toBeUndefined()
})

function anonymousCaptionedFormGrid(
  rows = 1,
  previous = false,
  missing = false
): ReturnType<typeof anonymousCertifiedPicture> {
  const f = anonymousCertifiedPicture(),
    o = f.context.operators
  o.fnArray.length =
    o.argsArray.length =
    f.context.content.items.length =
    f.tokens.length =
    f.context.glyphBounds[0].glyphs.length =
    f.page.graphicsBounds.length =
      0
  f.add(OPS.setFillRGBColor, ['#000000'])
  if (previous) {
    f.add(OPS.paintFormXObjectBegin, [null, [30, 340, 350, 390]])
    f.shape(40, 20, 80, 20)
    f.text('Earlier', 50, 35)
    f.add(OPS.paintFormXObjectEnd, null)
    f.text('Figure 1. Earlier view.', 40, 65)
  }
  const top = previous ? 100 : 80
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < 2; column++) {
      if (missing && row === rows - 1 && column === 1) continue
      const x = 50 + column * 170,
        y = top + row * 75
      f.add(OPS.paintFormXObjectBegin, [null, [x - 5, 400 - y - 65, x + 125, 400 - y + 5]])
      f.text('Panel ' + String.fromCharCode(65 + row * 2 + column), x + 25, y + 10)
      f.shape(x, y + 20, 120, 30)
      f.text('Axis ' + String.fromCharCode(65 + row * 2 + column), x + 30, y + 60)
      f.add(OPS.paintFormXObjectEnd, null)
    }
  const captionText =
      rows === 1 ? 'Figure 1. Left: One view. Right: Another view.' : 'Figure 2. Views.',
    bottom = top + rows * 75 + 15,
    caption = { page: 1, rect: [40, bottom, 360, bottom + 15], lines: [captionText] }
  f.text(captionText, 40, bottom + 10)
  f.figure.caption = caption
  f.figure.rect = [215, top + (rows - 1) * 75 + 15, 345, top + rows * 75 - 10]
  f.captions.splice(
    0,
    f.captions.length,
    ...(previous ? [{ page: 1, rect: [40, 55, 350, 70], lines: ['Figure 1. Earlier view.'] }] : []),
    caption
  )
  return f
}

it('completes captioned native Forms without deriving source claims from nonfinite style metrics', () => {
  const f = anonymousCaptionedFormGrid()
  f.context.content.styles.F.ascent = f.context.content.styles.F.descent = Number.NaN
  const plan = nativeCertifiedFigurePixelCrop(
    f.page,
    f.figure,
    f.captions,
    f.tables,
    f.tokens,
    f.context,
    f.peers
  )
  expect(plan?.kind).toBe('complete-native-captioned-form-grid')
  expect(plan?.rect[0]).toBeLessThan(50)
  expect(plan?.sourceItems).toBeUndefined()
  expect(Number.isNaN(f.context.content.styles.F.ascent)).toBe(true)
  const canvas = createCanvas(
      Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
      Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
    ),
    png = canvas.toBuffer('image/png')
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  f.context.operators.argsArray[0] = ['#ffffff']
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  canvas.width = canvas.height = 0
})

it('keeps complete caption-bounded Form rows separate from the preceding figure', () => {
  const f = anonymousCaptionedFormGrid(2, true),
    plan = nativeCertifiedFigurePixelCrop(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.peers
    )
  expect(plan?.kind).toBe('complete-native-captioned-form-grid')
  expect(plan?.rect[1]).toBeGreaterThan(70)
  expect(plan?.rect[1]).toBeLessThan(110)
  expect(plan?.sourceItems).toBeUndefined()
})

it('declines a captioned Form grid with an unproved missing cell', () => {
  const f = anonymousCaptionedFormGrid(2, false, true)
  expect(
    nativeCertifiedFigurePixelCrop(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.peers
    )
  ).toBeUndefined()
})

it('does not absorb independent text between captioned Form panels', () => {
  const f = anonymousCaptionedFormGrid()
  f.text('Unrelated text', 175, 120)
  expect(
    nativeCertifiedFigurePixelCrop(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.peers
    )
  ).toBeUndefined()
})

function completeCaptionOutsideSavedPicture(
  mode = ''
): ReturnType<typeof anonymousCertifiedPicture> {
  const f = anonymousCertifiedPicture()
  f.figure.rect = [50, 60, 350, 306]
  if (mode === 'foreign-text') f.text('Independent annotation.', 50, 285)
  if (mode === 'incomplete-caption') {
    const r = f.context.content.items.at(-1),
      text = r.str.slice(0, -1)
    r.str = r.sourceItem.text = text
    f.tokens[f.tokens.length - 1] = tableTextToken(r, f.context.viewport, 0)
    const i = f.context.operators.fnArray.lastIndexOf(OPS.showText)
    f.context.operators.argsArray[i][0][0].unicode = text
    f.figure.caption.lines[0] = text
  }
  return f
}

it('excludes a complete independently bound caption already cut by a saved-picture crop', () => {
  const f = completeCaptionOutsideSavedPicture(),
    before = JSON.stringify(f),
    plan = nativeCertifiedFigurePixelCrop(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.peers
    )
  expect(plan?.kind).toBe('complete-native-saved-picture')
  expect(plan?.rect[3]).toBeLessThan(290)
  expect(plan?.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})

it.each(['foreign-text', 'incomplete-caption'])(
  'retains old paint when a caption exclusion lacks complete independent proof: %s',
  (mode) => {
    const f = completeCaptionOutsideSavedPicture(mode)
    expect(
      nativeCertifiedFigurePixelCrop(
        f.page,
        f.figure,
        f.captions,
        f.tables,
        f.tokens,
        f.context,
        f.peers
      )
    ).toBeUndefined()
  }
)

it('does not exclude a same-packet note outside the independently printed caption band', () => {
  const f = completeCaptionOutsideSavedPicture(),
    o = f.context.operators,
    boundary = o.fnArray.lastIndexOf(OPS.endText)
  f.figure.rect[3] = 345
  f.text('Separate note.', 60, 335)
  expect(o.fnArray[boundary + 1]).toBe(OPS.beginText)
  o.fnArray.splice(boundary, 2)
  o.argsArray.splice(boundary, 2)
  expect(
    nativeCertifiedFigurePixelCrop(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.peers
    )
  ).toBeUndefined()
})

function captionedRasterRows(mode = ''): ReturnType<typeof anonymousCertifiedPicture> {
  const f = anonymousCertifiedPicture([], undefined, false, false, [])
  for (const values of [
    f.context.operators.fnArray,
    f.context.operators.argsArray,
    f.context.content.items,
    f.context.glyphBounds[0].glyphs,
    f.page.graphicsBounds,
    f.tokens
  ])
    values.length = 0
  f.add(OPS.setFillRGBColor, ['#000000'])
  const earlier = { page: 1, rect: [40, 55, 360, 75], lines: ['Figure 1. Earlier view.'] }
  f.text(earlier.lines[0], 40, 70)
  for (let i = 0; i < 2; i++) {
    const y = 110 + i * 80
    f.add(OPS.save, null)
    f.add(OPS.transform, [300, 0, 0, 60, 40, 400 - y - 60])
    const operationIndex = f.context.operators.fnArray.length
    f.add(OPS.paintImageXObject, [`generated-row-${i}`, 300, 60])
    f.page.graphicsBounds.push({
      kind: 'image',
      operationIndex,
      normalizedRect: [40 / 400, y / 400, 340 / 400, (y + 60) / 400],
      paintedNormalizedRect: [41 / 400, (y + 1) / 400, 339 / 400, (y + 59) / 400],
      ...(mode !== 'missing-image-hash' || i !== 0 ? { imageHash: String(i + 1).repeat(64) } : {})
    })
    f.add(OPS.restore, null)
  }
  const text =
    mode === 'disjoint-ranges'
      ? 'Figure 2. (a-b) Views; (d-e) errors.'
      : 'Figure 2. (a-b) Views; (c-d) errors.'
  f.text(text, 40, 285)
  f.figure.caption = { page: 1, rect: [40, 275, 360, 290], lines: [text] }
  f.figure.rect = [39, 189, 341, 251]
  f.captions = [earlier, f.figure.caption]
  f.peers = [f.figure]
  if (mode === 'foreign-text') f.text('Independent annotation.', 45, 184)
  if (mode === 'padding-only') f.figure.rect = [39, 111.5, 341, 251]
  if (mode === 'wrong-op-hash') {
    f.page.graphicsBounds = structuredClone(f.context.graphicsBounds)
    f.page.graphicsBounds[0].imageHash = 'd'.repeat(64)
  }
  return f
}

it('recovers both complete raster rows bound by contiguous caption ranges without claiming text', () => {
  const f = captionedRasterRows(),
    publishedRect = [39, 169.5, 341, 251]
  f.figure.rect = [41, 191, 339, 249]
  const before = JSON.stringify(f),
    plan = nativeCertifiedFigurePixelCrop(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.peers,
      publishedRect
    )
  expect(plan?.kind).toBe('complete-native-captioned-raster-rows')
  expect(plan?.rect[1]).toBeLessThan(110)
  expect(plan?.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
  const canvas = createCanvas(
    Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
    Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
  )
  const png = canvas.toBuffer('image/png')
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  f.figure.rect = plan.rect
  expect(repeatedRasterHeaderPlan(f)).toBeUndefined()
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  canvas.width = canvas.height = 0
})

it.each(['disjoint-ranges', 'foreign-text', 'missing-image-hash', 'padding-only', 'wrong-op-hash'])(
  'declines stacked raster admission without complete caption and native exclusions: %s',
  (mode) => {
    const f = captionedRasterRows(mode)
    expect(repeatedRasterHeaderPlan(f)).toBeUndefined()
  }
)

const ligaturePacketApi = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const duplicateMetadataApi = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
const ligatureCaptureApi = await import(
  pathToFileURL(resolve('resources/literature-pdf-render-bounds.mjs')).href
)
const { version: nativePdfVersion } = await import('pdfjs-dist/legacy/build/pdf.mjs')

function ordinaryDuplicateLigature(mode = ''): ReturnType<typeof JSON.parse> {
  const f = anonymousCertifiedPicture([], undefined, false, false, [])
  for (const a of [
    f.context.operators.fnArray,
    f.context.operators.argsArray,
    f.context.content.items,
    f.tokens,
    f.context.glyphBounds[0].glyphs,
    f.page.graphicsBounds
  ])
    a.length = 0
  f.context.content.styles.H = { ascent: 0.7, descent: -0.1, vertical: false }
  const rawStrings: string[] = [],
    glyphs = new Map<string, Map<string, unknown>>()
  const emit = (normal: string, raw: string, x: number, y: number, font = 'F', size = 10): void => {
    const start = f.context.operators.fnArray.length
    f.text(normal, x, y)
    f.context.operators.argsArray[start + 1] = [font, size]
    f.context.operators.argsArray[start + 3] = [
      Array.from(raw, (c) => ({
        unicode: c,
        fontChar: c,
        width: 500,
        originalCharCode: c.codePointAt(0),
        isInFont: true
      }))
    ]
    const r = f.context.content.items.at(-1)
    r.width = (Array.from(raw).length * size) / 2
    r.height = size
    r.fontName = font
    r.transform = [size, 0, 0, size, x, 400 - y]
    f.tokens[f.tokens.length - 1] = tableTextToken(r, f.context.viewport, 0)
    rawStrings.push(raw)
    if (!glyphs.has(font)) glyphs.set(font, new Map())
    for (const c of raw) glyphs.get(font)!.set(c, { fontChar: c, bounds: [0, -0.1, 0.5, 0.7] })
  }
  f.add(OPS.setFillRGBColor, ['#000000'])
  emit('Running header', 'Running header', 40, 25)
  const body = [
    'Figure 4 describes the complete measured view.',
    'This ordinary paragraph explains the original grouping.',
    'The full native source remains ordinary prose.'
  ]
  body.forEach((s, i) => emit(s, s, 40, 50 + i * 12))
  f.context.content.items.at(-1).hasEOL = false
  f.add(OPS.paintFormXObjectBegin, [null, [30, 160, 360, 280]])
  f.shape(50, 140, 90, 30)
  f.shape(200, 190, 90, 30)
  emit('Axis', 'Axis', 150, 230)
  f.add(OPS.paintFormXObjectEnd, null)
  const title = 'Figure 4: A complete native response.'
  emit(title, title, 40, 280)
  emit('Results', 'Results', 40, 320, 'H', 12)
  emit(
    'A final fixed observation.',
    mode === 'without-ligature' ? 'A final fixed observation.' : 'A final ﬁxed observation.',
    40,
    345
  )
  f.context.glyphBounds = [...glyphs].map(([fontName, values]) => ({
    fontName,
    glyphs: [...values.values()]
  }))
  const bodyRect = [40, 40, 40 + Math.max(...body.map((s) => s.length)) * 5, 74]
  const caption = { page: 1, rect: bodyRect, lines: body }
  const genuineCaption = { page: 1, rect: [40, 270, 40 + title.length * 5, 280], lines: [title] }
  f.figure = {
    id: 'duplicate',
    page: 1,
    caption,
    region: [60, 140, 310, 220].map((v) => v / 400),
    thumbnail: 'thumbnails/duplicate.png',
    graphicsCount: 2
  }
  f.genuine = {
    id: 'genuine',
    page: 1,
    caption: genuineCaption,
    region: [40, 120, 350, 240].map((v) => v / 400),
    thumbnail: 'thumbnails/genuine.png',
    graphicsCount: 2
  }
  f.captions = [caption, genuineCaption]
  f.peers = [f.figure, f.genuine]
  if (mode === 'foreign-parent') f.shape(45, 60, 5, 5)
  if (mode === 'literal-parent')
    caption.lines = [body[0], 'A different ordinary middle sentence.', body[2]]
  if (mode === 'body-font') f.context.content.styles.F.vertical = 0
  if (mode === 'glyph-code') {
    for (const args of f.context.operators.argsArray)
      for (const g of Array.isArray(args?.[0]) ? args[0] : [])
        if (g?.unicode === 'ﬁ') delete g.originalCharCode
  }
  const defaultContent = structuredClone(f.context.content)
  defaultContent.items.forEach((r) => {
    delete r.sourceItem
  })
  const rawContent = structuredClone(defaultContent)
  rawContent.items.forEach((r, i) => {
    r.str = rawStrings[i]
  })
  if (mode === 'raw-field') rawContent.items.at(-1).width += 1
  if (mode === 'unsupported-pair') rawContent.items.at(-1).str = 'A final ﬀxed observation.'
  const viewport = { ...f.context.viewport }
  delete viewport.convertToViewportPoint
  f.snapshot = {
    pageNumber: 1,
    sourceSha256: f.context.sourceSha256,
    viewport,
    operators: structuredClone(f.context.operators),
    content: defaultContent,
    glyphBounds: structuredClone(f.context.glyphBounds),
    graphicsBounds: structuredClone(f.page.graphicsBounds)
  }
  f.evidence = {
    schema: 'same-pdfjs-page-dual-api-capture-v1',
    pdfjsVersion: nativePdfVersion,
    apiDefaultOptions: {},
    apiRawOptions: { disableNormalization: true },
    pageNumber: 1,
    sourceSha256: f.context.sourceSha256,
    defaultContent,
    rawContent,
    renderContext: structuredClone(f.snapshot)
  }
  f.context.dualApiEvidence = f.evidence
  return f
}

const ligaturePacket = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  (
    ligaturePacketApi.nativePageTextPacketInventoryWithLigatureCertificate ??
    ligaturePacketApi.nativePageTextPacketInventoryWithDualApiCertificate
  )(f.page, f.tokens, f.context, f.evidence, true)
const duplicateOrdinaryProof = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  (
    duplicateMetadataApi.nativeDuplicateOrdinaryReferenceMetadata ??
    duplicateMetadataApi.nativeOrdinaryBodyReferenceMetadata
  )(f.figure, f.page, f.captions, f.peers, f.context)

it('binds a whole native ligature expansion without changing Source or the old micro-sign API', () => {
  const f = ordinaryDuplicateLigature(),
    before = JSON.stringify(f),
    packet = ligaturePacket(f)
  expect(packet).toBeDefined()
  expect(packet.records.every((r) => r.advanceComplete)).toBe(true)
  expect(packet.records.at(-1).r.str).toBe('A final fixed observation.')
  expect(packet.records.at(-1).part.some((p) => p.g.text === 'ﬁ')).toBe(true)
  expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeUndefined()
  expect(
    ligaturePacketApi.nativePageTextPacketInventoryWithDualApiCertificate(
      f.page,
      f.tokens,
      f.context,
      f.evidence,
      true
    )
  ).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
  const captured = ligatureCaptureApi.attachNativeDualApiEvidence(
    f.snapshot,
    f.evidence.defaultContent,
    f.evidence.rawContent
  )
  expect(captured.dualApiEvidence).toBeDefined()
})

it('omits only a fully proved ordinary duplicate while retaining the genuine caption and Source epoch', () => {
  const f = ordinaryDuplicateLigature(),
    before = JSON.stringify(f),
    proof = duplicateOrdinaryProof(f)
  expect(proof?.current()).toBe(true)
  expect(proof.caption).toBe(f.figure.caption)
  expect(JSON.stringify(f)).toBe(before)
  expect(duplicateOrdinaryProof({ ...f, figure: f.genuine })).toBeUndefined()
  f.context.content.items[1].sourceItem = { ...f.context.content.items[1].sourceItem }
  expect(proof.current()).toBe(false)
})
it.each(['raw-field', 'glyph-code', 'unsupported-pair'])(
  'refuses a native ligature relation without complete independent %s evidence',
  (mode) => {
    expect(ligaturePacket(ordinaryDuplicateLigature(mode))).toBeUndefined()
  }
)
it.each(['literal-parent', 'foreign-parent', 'body-font'])(
  'retains duplicate metadata when its ordinary parent lacks %s proof',
  (mode) => {
    expect(duplicateOrdinaryProof(ordinaryDuplicateLigature(mode))).toBeUndefined()
  }
)

it('proves an ordinary duplicate with the complete strict packet when both native text APIs agree', () => {
  const f = ordinaryDuplicateLigature('without-ligature'),
    before = JSON.stringify(f)
  expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeDefined()
  expect(
    ligaturePacketApi.nativePageTextPacketInventoryWithLigatureCertificate(
      f.page,
      f.tokens,
      f.context,
      f.context.dualApiEvidence,
      true
    )
  ).toBeUndefined()
  expect(duplicateOrdinaryProof(f)?.current()).toBe(true)
  expect(JSON.stringify(f)).toBe(before)
})

function captionAdvanceGapFixture(mode = ''): ReturnType<typeof anonymousCertifiedPicture> {
  const f = anonymousCaptionedFormGrid(2),
    o = f.context.operators,
    formStarts = o.fnArray.flatMap((op, i) => (op === OPS.paintFormXObjectBegin ? [i] : [])),
    bottom = 245 - 1 / 30
  for (const start of formStarts.slice(-2).reverse()) {
    const box = o.argsArray[start][1],
      x = box[0],
      y = 400 - box[3],
      at = start + 1,
      lower = 400 - bottom,
      width = box[2] - box[0]
    box[1] = lower
    for (const g of f.page.graphicsBounds) if (g.operationIndex >= at) g.operationIndex += 3
    o.fnArray.splice(at, 0, OPS.setFillRGBColor, OPS.constructPath, OPS.setFillRGBColor)
    o.argsArray.splice(
      at,
      0,
      ['#ffffff'],
      [
        OPS.fill,
        [[0, x, lower, 1, x + width, lower, 1, x + width, 400 - y, 1, x, 400 - y, 4]],
        [x, lower, x + width, 400 - y]
      ],
      ['#000000']
    )
    f.page.graphicsBounds.push({
      kind: 'path',
      operationIndex: at + 1,
      normalizedRect: [x, y, x + width, bottom].map((v) => v / 400)
    })
  }
  o.fnArray.splice(-5)
  o.argsArray.splice(-5)
  f.context.content.items.pop()
  f.tokens.pop()
  f.context.glyphBounds[0].glyphs.pop()
  const parts =
    mode === 'multiple-text'
      ? ['Figure 2. Complete response', 'panels.']
      : ['Figure 2. Complete response panels.']
  let x = 40
  for (const part of parts) {
    f.text(part, x, 255)
    x += part.length * 5 + 5
  }
  const text = parts.join(' ')
  f.figure.caption = { page: 1, rect: [40, 245, 40 + text.length * 5, 255], lines: [text] }
  f.captions.splice(0, f.captions.length, f.figure.caption)
  f.page.lines = f.context.content.items.map((r) => ({
    text: r.str,
    x: r.transform[4],
    y: 400 - r.transform[5] - r.height,
    width: r.width,
    height: r.height,
    fontSize: r.height
  }))
  if (mode === 'missing-glyph') f.context.glyphBounds[0].glyphs.pop()
  if (mode === 'incomplete-caption') f.figure.caption.lines = ['Figure 2. Incomplete panels.']
  if (mode === 'touching-ink') f.context.glyphBounds[0].glyphs.at(-1)!.bounds[3] = 0.9
  if (mode === 'foreign-paint') f.shape(40, 246, 10, 1)
  if (mode === 'extra-form') {
    f.add(OPS.paintFormXObjectBegin, [null, [175, 260, 215, 300]])
    f.shape(180, 105, 10, 10)
    f.text('Other', 180, 125)
    f.add(OPS.paintFormXObjectEnd, null)
  }
  if (mode === 'clip') {
    const at = o.fnArray.length - 5
    o.fnArray.splice(at, 0, OPS.constructPath)
    o.argsArray.splice(at, 0, [
      OPS.clip,
      [[0, 40, 140, 1, 50, 140, 1, 50, 160, 1, 40, 160, 4]],
      [40, 140, 50, 160]
    ])
  }
  return f
}
const captionGapPlan = (
  f: ReturnType<typeof anonymousCertifiedPicture>
): ReturnType<typeof JSON.parse> =>
  nativeCertifiedFigurePixelCrop(
    f.page,
    f.figure,
    f.captions,
    f.tables,
    f.tokens,
    f.context,
    f.peers
  )
const captionGapPng = (plan: ReturnType<typeof JSON.parse>, scale = 4): Buffer => {
  const canvas = createCanvas(
    Math.ceil((plan.rect[2] - plan.rect[0]) * scale),
    Math.ceil((plan.rect[3] - plan.rect[1]) * scale)
  )
  try {
    return canvas.toBuffer('image/png')
  } finally {
    canvas.width = canvas.height = 0
  }
}

it.each(['', 'multiple-text'])(
  'retains complete Forms across proved caption advance blank space: %s',
  async (mode) => {
    const f = captionAdvanceGapFixture(mode),
      before = JSON.stringify(f),
      plan = captionGapPlan(f)
    expect(plan).toBeDefined()
    expect(plan.rect[3]).toBeGreaterThan(f.figure.caption.rect[1])
    expect(nativeCertifiedFigurePixelPngSafe(plan, captionGapPng(plan), plan.rect, f.page)).toBe(
      true
    )
    expect(nativeCertifiedFigurePixelPngSafe(plan, captionGapPng(plan, 3), plan.rect, f.page)).toBe(
      false
    )
    expect(JSON.stringify(f)).toBe(before)
    await Promise.resolve()
    f.context.content.items.at(-1)!.sourceItem = { ...f.context.content.items.at(-1)!.sourceItem }
    expect(nativeCertifiedFigurePixelPngSafe(plan, captionGapPng(plan), plan.rect, f.page)).toBe(
      false
    )
  }
)
it.each([
  'missing-glyph',
  'incomplete-caption',
  'touching-ink',
  'foreign-paint',
  'extra-form',
  'clip'
])('keeps the complete Form caption-gap path closed without %s evidence', (mode) => {
  const f = captionAdvanceGapFixture(mode),
    plan = captionGapPlan(f)
  expect(
    !!plan && nativeCertifiedFigurePixelPngSafe(plan, captionGapPng(plan), plan.rect, f.page)
  ).toBe(false)
})

function anonymousFormWithBoxedPanel(mode = ''): ReturnType<typeof anonymousCertifiedPicture> {
  const f = anonymousCertifiedPicture(),
    o = f.context.operators
  o.fnArray.length =
    o.argsArray.length =
    f.context.content.items.length =
    f.tokens.length =
    f.context.glyphBounds[0].glyphs.length =
    f.page.graphicsBounds.length =
      0
  f.add(OPS.setFillRGBColor, ['#000000'])
  f.add(OPS.paintFormXObjectBegin, [null, [90, 270, 310, 360]])
  f.shape(100, 50, 200, 60)
  f.text('Tree', 180, 85)
  f.add(OPS.paintFormXObjectEnd, null)
  if (mode !== 'missing-upper') f.text(mode === 'upper-marker' ? '(c)' : '(a)', 190, 140)
  for (const [i, x] of [50, 230].entries()) {
    f.text('Model ' + String.fromCharCode(65 + i), x + 20, 160)
    f.add(OPS.save, null)
    f.shape(x, 170, 120, 60)
    f.shape(x + 1, 171, 118, 58)
    f.text('value: ' + String.fromCharCode(65 + i), x + 10, 195)
    f.text('rate: ' + String.fromCharCode(65 + i), x + 10, 215)
    f.add(OPS.restore, null)
    if (mode === 'outside-body' && !i) f.text('Independent prose.', 170, 240)
  }
  if (mode !== 'missing-lower') f.text(mode === 'lower-marker' ? '(c)' : '(b)', 190, 250)
  const line =
    mode === 'caption-relation'
      ? 'Figure 1. One unrelated view.'
      : 'Figure 1. (a) Tree and (b) model inputs.'
  f.text(line, 40, 280)
  const caption = { page: 1, rect: [40, 270, 360, 285], lines: [line] }
  f.figure.caption = caption
  f.figure.rect = mode === 'complete' ? [45, 40, 355, 260] : [95, 45, 305, 125]
  f.captions.splice(0, f.captions.length, caption)
  if (mode === 'foreign-paint') f.shape(175, 175, 20, 20)
  if (mode === 'font') f.context.content.styles.F.vertical = 0
  if (mode === 'open-lifetime') {
    const i = o.fnArray.indexOf(OPS.endText)
    // Keep all operation and Source indices fixed; only leave the BT lifetime open.
    o.fnArray[i] = OPS.beginText
  }
  return f
}
it('recovers a caption-linked boxed panel below a complete native Form without changing Source', () => {
  const f = anonymousFormWithBoxedPanel(),
    before = JSON.stringify(f),
    plan = repeatedRasterHeaderPlan(f)
  expect(plan?.kind).toBe('complete-native-form-with-boxed-panel')
  expect(plan.rect[3]).toBeGreaterThan(250)
  expect(plan.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
  const canvas = createCanvas(
      Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
      Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
    ),
    png = canvas.toBuffer('image/png')
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, [...plan.rect], f.page)).toBe(false)
  f.context.operators.argsArray[0] = ['#ffffff']
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  canvas.width = canvas.height = 0
})
it.each([
  'upper-marker',
  'lower-marker',
  'missing-upper',
  'missing-lower',
  'caption-relation',
  'outside-body',
  'foreign-paint',
  'font',
  'open-lifetime',
  'complete'
])('keeps boxed native panel recovery closed for %s', (mode) => {
  const f = anonymousFormWithBoxedPanel(mode),
    before = JSON.stringify(f)
  expect(repeatedRasterHeaderPlan(f)).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})

function anonymousPairSavedDiagrams(mode = ''): ReturnType<typeof anonymousCertifiedPicture> {
  const f = anonymousCertifiedPicture(),
    o = f.context.operators
  o.fnArray.length =
    o.argsArray.length =
    f.context.content.items.length =
    f.tokens.length =
    f.context.glyphBounds[0].glyphs.length =
    f.page.graphicsBounds.length =
      0
  f.add(OPS.setFillRGBColor, ['#000000'])
  const joinText = (): void => {
    const end = o.fnArray.lastIndexOf(OPS.endText, o.fnArray.length - 6)
    const begin = o.fnArray.lastIndexOf(OPS.beginText)
    o.fnArray[end] = OPS.moveText
    o.argsArray[end] = [0, 0]
    o.fnArray[begin] = OPS.moveText
    o.argsArray[begin] = [0, 0]
  }
  for (const [i, x] of [40, 220].entries()) {
    f.add(OPS.save, null)
    f.shape(x, 90, 15, 15)
    f.shape(x + 50, 140, 15, 15)
    f.shape(x + 100, 90, 15, 15)
    f.text(i ? 'Edge' : 'Node', x + 35, 180)
    f.add(OPS.restore, null)
    f.text(i ? (mode === 'wrong-marker' ? '(c)' : '(b)') : '(a)', x + 10, 210)
    f.text(
      i ? (mode === 'description' ? 'Second diagram' : 'Second diagram.') : 'First diagram.',
      x + 30,
      i && mode === 'displaced-description' ? 222 : 210
    )
    joinText()
  }
  if (mode === 'body-in-description') {
    f.text('Independent text.', 310, 210)
    joinText()
  }
  const line = 'Figure 1. (a) and (b).'
  f.text(line, 40, 260)
  joinText()
  f.text(mode === 'foreign-advance' ? 'External prose. ' : 'External prose.', 40, 310)
  joinText()
  const caption = { page: 1, rect: [40, 250, 250, 265], lines: [line] }
  f.figure.caption = caption
  f.figure.rect = [230, 85, 350, 220]
  f.captions.splice(0, f.captions.length, caption)
  if (mode === 'foreign') f.shape(160, 100, 20, 10)
  if (mode === 'table') f.tables.push([50, 80, 160, 200])
  if (mode === 'caption-link') caption.lines[0] = 'Figure 1. Another view.'
  if (mode === 'source') f.context.content.items[1].sourceItem.text = 'Other'
  if (mode === 'font') delete f.context.content.styles.F.descent

  if (mode === 'extra-save') {
    f.add(OPS.save, null)
    f.shape(170, 110, 10, 10)
    f.add(OPS.restore, null)
  }
  if (mode === 'foreign-advance') {
    const raw = f.context.content.items.at(-1)!
    raw.width += 2
    f.tokens[f.tokens.length - 1] = tableTextToken(raw, f.context.viewport, 0)
  }
  if (mode === 'open-lifetime') o.fnArray[o.fnArray.lastIndexOf(OPS.endText)] = OPS.beginText
  if (mode === 'duplicate-source') f.tokens.push({ ...f.tokens[0] })

  return f
}
it.each(['', 'foreign-advance'])(
  'recovers two complete saved diagrams while retaining the shared caption and prose lifetime: %s',
  (mode) => {
    const f = anonymousPairSavedDiagrams(mode),
      before = JSON.stringify(f)
    expect(
      nativeFigurePaintCertificateData(
        createNativeFigurePaintCertificate(f.page, f.tokens, f.context),
        f.page,
        f.tokens,
        f.context
      )
    ).toBeDefined()
    const packet = nativePageTextPacketInventory(
      f.page,
      f.tokens,
      f.context,
      true,
      new Set(f.tokens.slice(0, -1).map((t) => t.sourceItem.index)),
      false
    )!
    expect(packet).toBeDefined()
    const second = packet.records.find((r) => r.r.str === 'Second diagram.')!,
      cap = packet.records.find((r) => r.r.str.startsWith('Figure 1.'))!,
      body = packet.records.at(-1)!
    expect(second.part[0].g.packet).toBe(cap.part[0].g.packet)
    expect(second.part[0].g.packet).toBe(body.part[0].g.packet)
    if (mode)
      expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeUndefined()
    const plan = repeatedRasterHeaderPlan(f)
    expect(plan?.kind).toBe('complete-native-paired-saved-diagrams')
    expect(plan.rect[0]).toBeLessThan(45)
    expect(plan.sourceItems).toBeUndefined()
    expect(JSON.stringify(f)).toBe(before)
    const canvas = createCanvas(
        Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
        Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
      ),
      png = canvas.toBuffer('image/png')
    expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
    expect(nativeCertifiedFigurePixelPngSafe({ ...plan }, png, plan.rect, f.page)).toBe(false)
    f.context.content.items.at(-1)!.sourceItem = { ...f.context.content.items.at(-1)!.sourceItem }
    expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
    canvas.width = canvas.height = 0
  }
)
it.each([
  'foreign',
  'table',
  'caption-link',
  'source',
  'font',
  'description',
  'extra-save',
  'body-in-description',
  'open-lifetime',
  'duplicate-source',
  'wrong-marker',
  'displaced-description'
])('declines incomplete paired saved diagrams: %s', (mode) => {
  const f = anonymousPairSavedDiagrams(mode)
  if (['wrong-marker', 'displaced-description', 'description'].includes(mode)) {
    expect(
      nativeFigurePaintCertificateData(
        createNativeFigurePaintCertificate(f.page, f.tokens, f.context),
        f.page,
        f.tokens,
        f.context
      )
    ).toBeDefined()
    expect(
      nativePageTextPacketInventory(
        f.page,
        f.tokens,
        f.context,
        true,
        new Set(f.tokens.slice(0, -1).map((t) => t.sourceItem.index)),
        false
      )
    ).toBeDefined()
  }
  expect(repeatedRasterHeaderPlan(f)).toBeUndefined()
})

const { nativeFiniteColoredPatternFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-whole-paint-scope.mjs')).href
)
function anonymousColoredPatternForm(family = 0, change = ''): ReturnType<typeof JSON.parse> {
  const shift = change === 'offcenter' ? 137.5 : 77.5
  const f = anonymousCertifiedPicture([], undefined, false, false, [])
  for (const a of [
    f.context.operators.fnArray,
    f.context.operators.argsArray,
    f.context.content.items,
    f.context.glyphBounds,
    f.page.graphicsBounds,
    f.tokens
  ])
    a.length = 0
  const style = { ascent: 0.7, descent: -0.1, vertical: false }
  f.context.content.styles = Object.fromEntries(['T', 'D', 'H'].map((font) => [font, { ...style }]))
  f.context.glyphBounds = ['T', 'D', 'H'].map((fontName) => ({ fontName, glyphs: [] }))
  const text = (str: string, x: number, y: number, font = 'T', size = 10, shared = false): void => {
    x += shift
    if (!shared) f.add(OPS.beginText, null)
    f.add(OPS.setFont, [font, size])
    f.add(OPS.setTextMatrix, [[1, 0, 0, 1, x, 400 - y]])
    f.add(OPS.showText, [
      [{ unicode: str, fontChar: str, width: 500 * str.length, isInFont: true }]
    ])
    if (!shared) f.add(OPS.endText, null)
    const index = f.context.content.items.length,
      raw = {
        str,
        dir: 'ltr',
        fontName: font,
        width: (size * str.length) / 2,
        height: size,
        transform: [size, 0, 0, size, x, 400 - y],
        hasEOL: true,
        sourceItem: { pageNumber: 1, index, text: str }
      }
    f.context.content.items.push(raw)
    f.tokens.push(tableTextToken(raw, f.context.viewport, 0))
    const glyphs = f.context.glyphBounds.find(
      (g: { fontName: string }) => g.fontName === font
    ).glyphs
    if (!glyphs.some((g: { fontChar: string }) => g.fontChar === str))
      glyphs.push({ fontChar: str, bounds: [0, -0.1, str.length / 2, 0.7] })
  }
  const nativeShape = f.shape
  f.shape = (x: number, ...args: number[]) => nativeShape(x + shift, ...args)
  f.add(OPS.setFillRGBColor, ['#000000'])
  f.add(OPS.paintFormXObjectBegin, [null, [50 + shift, 300, 195 + shift, 350]])
  f.shape(60, 60, 20, 20)
  text('A', 80, 80, 'D')
  f.add(OPS.paintFormXObjectEnd, null)
  text('Fig. 1', 50, 120)
  text('Prior view.', 85, 120)
  text('An earlier panel.', 50, 132, 'D')
  const prior = {
    page: 1,
    rect: [50 + shift, 110, 140 + shift, 132],
    lines: ['Fig. 1 Prior view.', 'An earlier panel.']
  }
  if (change !== 'no-form')
    f.add(OPS.paintFormXObjectBegin, [null, [50 + shift, 160, 195 + shift, 220]])
  f.shape(60, 190, 10, 10)
  f.shape(90, 200, 10, 10)
  const lines: number[] = [],
    background = family !== 1,
    groups = family ? 2 : 1
  for (let group = 0; group < groups; group++)
    for (let i = 0; i < 3; i++) {
      const x = -6 + i * 6,
        y = group ? 12 + x : -x
      lines.push(0, x, y, 1, x + 12, y + (group ? -12 : 12))
    }
  const program: ReturnType<typeof JSON.parse> = {
    fnArray: [
      OPS.setStrokeRGBColor,
      OPS.setFillRGBColor,
      ...(background ? [OPS.constructPath, OPS.setFillRGBColor] : []),
      OPS.setLineWidth,
      OPS.constructPath
    ],
    argsArray: [
      ['#000000'],
      ['#bbbbbb'],
      ...(background
        ? [[OPS.fill, [[0, 0, 0, 1, 12, 0, 1, 12, 12, 1, 0, 12, 4]], [0, 0, 12, 12]], ['#000000']]
        : []),
      [1],
      [OPS.stroke, [lines], [-6, -6, 18, 18]]
    ],
    length: background ? 6 : 4
  }
  if (change === 'resource') {
    program.fnArray.push(OPS.dependency)
    program.argsArray.push([['external-font']])
    program.length++
  }
  if (change === 'path-program') program.argsArray.at(-1)[1][0][1] += 0.25
  const pattern: ReturnType<typeof JSON.parse> = [
    'TilingPattern',
    null,
    program,
    change === 'rotated' ? [0, 1, -1, 0, 0, 0] : [1, 0, 0, 1, 0, 0],
    [0, 0, 12, 12],
    12,
    12,
    1,
    1
  ]
  if (change === 'uncolored') {
    pattern[1] = '#bbbbbb'
    pattern[7] = 2
  }
  f.add(OPS.setFillColorN, pattern)
  f.shape(115, 190, 20, 20)
  f.add(OPS.setFillRGBColor, ['#000000'])
  text('0', 49.7, 220, 'D') // The original panel clips this glyph; no Source recovery.
  if (change !== 'no-form') f.add(OPS.paintFormXObjectEnd, null)
  f.add(OPS.beginText, null)
  text('Fig. 2', 50, 260, 'T', 10, true)
  text('Where each sample lies', 85, 260, change === 'caption-font' ? 'D' : 'T', 10, true)
  text('A complete description.', 50, 272, 'D', 10, true)
  text(change === 'folio' ? 'Note' : '1', change === 'folio' ? 110.5 : 119.5, 330, 'H', 12, true)
  f.add(OPS.endText, null)
  if (change === 'foreign') f.shape(80, 210, 8, 8)
  f.page.lines = [
    {
      text: 'Fig. 2 Where each sample lies',
      x: 50 + shift,
      y: 250,
      width: 145,
      height: 10,
      fontSize: 10
    },
    { text: 'A complete description.', x: 50 + shift, y: 262, width: 115, height: 10, fontSize: 10 }
  ]
  f.captions = [prior]
  f.figure = { caption: prior, rect: [50 + shift, 50, 195 + shift, 100] }
  f.peers = [f.figure]
  for (const token of f.tokens) token.sourceItem = { ...token.sourceItem }
  if (change === 'source-tuple') f.tokens[1].sourceItem.index += 100
  f.pattern = pattern
  return f
}
const coloredPatternPlan = (
  f: ReturnType<typeof anonymousColoredPatternForm>
): ReturnType<typeof JSON.parse> => {
  const candidates = nativeFiniteColoredPatternFigures(
    f.page,
    f.captions,
    f.tables,
    f.tokens,
    f.context
  )
  if (candidates.length !== 1) return
  return nativeCertifiedFigurePixelCrop(
    f.page,
    candidates[0],
    [...f.captions, candidates[0].caption],
    f.tables,
    f.tokens,
    f.context,
    [f.figure, candidates[0]]
  )
}
it.each([0, 1, 2])(
  'keeps a complete finite hatch Form as pixels while its clipped Source stays refused: %s',
  (family) => {
    const f = anonymousColoredPatternForm(family),
      before = JSON.stringify(f),
      plan = coloredPatternPlan(f)
    expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeUndefined()
    const paint = nativeFigurePaintCertificateData(
        createNativeFigurePaintCertificate(f.page, f.tokens, f.context),
        f.page,
        f.tokens,
        f.context
      ),
      patternPath = paint.pieces.find(
        (p: { operationIndex: number }) =>
          p.operationIndex === f.context.operators.fnArray.indexOf(OPS.setFillColorN) + 1
      )
    expect(patternPath.visiblePaintPoints).toEqual([])
    expect(patternPath.opaqueWhiteFill).toBe(false)
    expect(plan?.kind).toBe('complete-native-colored-pattern-form')
    expect(plan.sourceItems).toEqual([])
    expect(plan.rect).toEqual([127.5 - 2 / 1.5, 180 - 2 / 1.5, 272.5 + 2 / 1.5, 240 + 2 / 1.5])
    expect(JSON.stringify(f)).toBe(before)
  }
)
it.each([
  'resource',
  'rotated',
  'uncolored',
  'no-form',
  'caption-font',
  'folio',
  'foreign',
  'source-tuple',
  'offcenter',
  'path-program'
])('declines an independent finite pattern proof with %s', (change) => {
  const f = anonymousColoredPatternForm(0, change)
  if (['caption-font', 'folio', 'foreign', 'source-tuple', 'offcenter'].includes(change))
    expect(
      nativeFigurePaintCertificateData(
        createNativeFigurePaintCertificate(f.page, f.tokens, f.context),
        f.page,
        f.tokens,
        f.context
      )
    ).toBeDefined()
  expect(coloredPatternPlan(f)).toBeUndefined()
})
it('binds an image-only hatch plan to original program, Source and output identities at PNG validation', () => {
  const f = anonymousColoredPatternForm(),
    plan = coloredPatternPlan(f),
    canvas = createCanvas(
      Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
      Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
    ),
    png = canvas.toBuffer('image/png')
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  expect(nativeCertifiedFigurePixelPngSafe({ ...plan }, png, plan.rect, f.page)).toBe(false)
  const original = f.context.content.items.at(-1).sourceItem
  f.context.content.items.at(-1).sourceItem = { ...original }
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  f.context.content.items.at(-1).sourceItem = original
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  const tokenOrigin = f.tokens.at(-1).sourceItem
  f.tokens.at(-1).sourceItem = { ...tokenOrigin }
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  f.tokens.at(-1).sourceItem = tokenOrigin
  const emptyClaims = plan.sourceItems
  plan.sourceItems = []
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  plan.sourceItems = emptyClaims
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  f.pattern[2].argsArray.at(-1)[1][0][1] -= 1
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  canvas.width = canvas.height = 0
})

// The complete title, numbered heading and paragraph retain their one native ET.
const sectionBodyBeforePicture = (variant = ''): ReturnType<typeof JSON.parse> => {
  const f = anonymousCertifiedPicture([], undefined, false, false, [])
  for (const values of [
    f.context.operators.fnArray,
    f.context.operators.argsArray,
    f.context.content.items,
    f.context.glyphBounds[0].glyphs,
    f.page.graphicsBounds,
    f.tokens
  ])
    values.length = 0
  f.context.content.styles.H = { ascent: 0.7, descent: -0.1, vertical: false }
  f.context.content.styles.T = { ascent: 0.7, descent: -0.1, vertical: false }
  const faces = new Map<string, unknown[]>([
    ['F', f.context.glyphBounds[0].glyphs],
    ['H', []],
    ['T', []]
  ])
  const emit = (str: string, x: number, y: number, font = 'F'): void => {
    const at = f.context.operators.fnArray.length
    f.text(str, x, y)
    f.context.operators.argsArray[at + 1] = [font, 10]
    const r = f.context.content.items.at(-1)
    r.fontName = font
    f.tokens[f.tokens.length - 1] = tableTextToken(r, f.context.viewport, 0)
    if (font !== 'F') faces.get(font)!.push(f.context.glyphBounds[0].glyphs.pop())
  }
  f.add(OPS.setFillRGBColor, ['#000000'])
  const start = f.context.operators.fnArray.length
  emit('A complete anonymous research title', 100, 20, 'T')
  emit(
    variant === 'unnumbered-heading'
      ? 'A complete section title'
      : '2.3. Complete native observations',
    20,
    55,
    variant === 'body-heading-font' ? 'F' : 'H'
  )
  const body = [
    'We describe the complete measured groups in this ordinary account',
    'the original measurements support each independently tested claim',
    'our repeated comparison preserves every available native source',
    'these consistent observations support the stated final conclusion.'
  ]
  if (variant === 'unfinished-body') body[3] = body[3].slice(0, -1)
  for (const [i, line] of body.entries())
    emit(line, 20, 80 + i * 15 + (variant === 'row-gap' && i === 2 ? 4 : 0))
  f.context.content.items[5].hasEOL = false
  f.add(OPS.setFillRGBColor, [variant === 'unproved-tail' ? '#ff0000' : '#000000'])
  f.add(OPS.setStrokeRGBColor, ['#000000'])
  const ops = f.context.operators,
    prefix = ops.fnArray
      .slice(start)
      .map((op: number, i: number) => ({ op, args: ops.argsArray[start + i] }))
      .filter((x: { op: number }) => x.op !== OPS.beginText && x.op !== OPS.endText)
  ops.fnArray.splice(
    start,
    ops.fnArray.length - start,
    OPS.beginText,
    ...prefix.map((x: { op: number }) => x.op),
    OPS.endText
  )
  ops.argsArray.splice(
    start,
    ops.argsArray.length - start,
    null,
    ...prefix.map((x: { args: unknown }) => x.args),
    null
  )
  if (variant === 'unknown-foreign') emit('Unknown panel key', 130, 126)
  f.add(OPS.save, null)
  f.add(OPS.paintFormXObjectBegin, [null, [20, 100, 380, 260]])
  f.shape(80, 160, 40, 30)
  f.shape(210, 160, 40, 30)
  f.shape(130, 175, 60, 2)
  emit('Axis', 90, 210)
  emit('(u,v)', 90, 270)
  emit('(s,t)', 220, 270)
  f.add(OPS.paintFormXObjectEnd, null)
  f.add(OPS.restore, null)
  const line = 'Figure 1. Complete independent drawings.'
  emit(line, 20, 335)
  const caption = { page: 1, rect: [20, 325, 360, 340], lines: [line] }
  f.figure.caption = caption
  f.figure.rect = [20, variant === 'header-old-crop' ? 45 : 118, 360, 235]
  f.captions = [caption]
  f.peers = [f.figure]
  if (variant !== 'no-body-witness')
    emit(
      'The same ordinary body font continues below this independent drawing.',
      20,
      365,
      variant === 'different-witness-font' ? 'H' : 'F'
    )
  f.context.glyphBounds = [...faces].map(([fontName, glyphs]) => ({ fontName, glyphs }))
  return f
}

it('separates a complete section body from a saved picture while retaining the full shared text packet', () => {
  const f = sectionBodyBeforePicture(),
    before = JSON.stringify(f),
    packet = nativePageTextPacketInventory(f.page, f.tokens, f.context, true)
  expect(packet).toBeDefined()
  expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeDefined()
  const prefix = packet.records.slice(0, 6)
  expect(new Set(prefix.flatMap((r) => r.part.map(({ g }) => g.packet))).size).toBe(1)
  const plan = nativeCertifiedFigurePixelCrop(
    f.page,
    f.figure,
    f.captions,
    f.tables,
    f.tokens,
    f.context,
    f.peers
  )
  expect(plan).toBeDefined()
  expect(plan.rect[1]).toBeGreaterThan(140)
  expect(plan.rect[3]).toBeGreaterThan(270)
  expect(plan.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
  const canvas = createCanvas(
      Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
      Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
    ),
    png = canvas.toBuffer('image/png')
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  expect(nativeCertifiedFigurePixelPngSafe(structuredClone(plan), png, plan.rect, f.page)).toBe(
    false
  )
  const source = f.context.content.items[2].sourceItem
  f.context.content.items[2].sourceItem = { ...source }
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  f.context.content.items[2].sourceItem = source
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  canvas.width = canvas.height = 0
})

it.each([
  'unnumbered-heading',
  'body-heading-font',
  'unfinished-body',
  'row-gap',
  'no-body-witness',
  'different-witness-font',
  'header-old-crop',
  'unknown-foreign',
  'unproved-tail'
])(
  'keeps a complete native section body inside the old crop when proof is insufficient: %s',
  (variant) => {
    const f = sectionBodyBeforePicture(variant)
    expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeDefined()
    expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeDefined()
    expect(
      nativeCertifiedFigurePixelCrop(
        f.page,
        f.figure,
        f.captions,
        f.tables,
        f.tokens,
        f.context,
        f.peers
      )
    ).toBeUndefined()
  }
)

// A generated native program preserves curved clipping and white underpaint.
const anonymousCurvedForm = (variant = ''): ReturnType<typeof JSON.parse> => {
  const f = anonymousCertifiedPicture([], undefined, false, false, [])
  for (const values of [
    f.context.operators.fnArray,
    f.context.operators.argsArray,
    f.context.content.items,
    f.context.glyphBounds[0].glyphs,
    f.page.graphicsBounds,
    f.tokens
  ])
    values.length = 0
  f.add(OPS.setFillRGBColor, ['#000000'])
  f.text('Running header', 250, 30)
  f.add(OPS.save, null)
  f.add(OPS.paintFormXObjectBegin, [null, [40, 140, 350, 330]])
  if (variant === 'prior-ink') f.shape(60, 90, 15, 8)
  if (variant === 'translucent-white') f.add(OPS.setGState, [[['ca', 0.5]]])
  f.add(OPS.setFillRGBColor, ['#ffffff'])
  f.shape(40, 70, 310, 190)
  if (variant === 'nonrectangular-white')
    f.context.operators.argsArray.at(-1)[1][0] = [
      0, 40, 140, 1, 350, 330, 1, 40, 140, 1, 350, 330, 4
    ]
  f.add(OPS.setGState, [[['ca', 1]]])
  f.add(OPS.setFillRGBColor, ['#226699'])
  f.add(OPS.save, null)
  f.add(OPS.clip, null)
  f.add(OPS.constructPath, [
    OPS.endPath,
    [
      [0, 80, 220, 2, 80, 245, 110, 250, 120, 240, 1, 120, 220, variant === 'unclosed-clip' ? 0 : 4]
    ],
    [80, 220, 120, 250]
  ])
  f.shape(90, 165, 15, 10)
  f.add(OPS.restore, null)
  f.shape(170, 120, 45, 55)
  f.shape(250, 105, 55, 70)
  f.add(OPS.setFillRGBColor, ['#000000'])
  f.text('Axis', 80, 210)
  f.text('Legend', 240, 235)
  for (const [i, x] of [80, 150].entries()) {
    f.add(OPS.setLineWidth, [1.5])
    f.add(OPS.setLineJoin, [1])
    f.add(OPS.setLineCap, [i ? 0 : 2])
    f.add(OPS.setDash, [i ? [3, 2] : [], 0])
    const at = f.context.operators.fnArray.length
    f.add(OPS.constructPath, [
      OPS.stroke,
      [[0, x, 170, 1, x + 10, variant === 'bent-line' ? 169 : 170, 1, x + 20, 170]],
      [x, 169, x + 20, 170]
    ])
    f.page.graphicsBounds.push({
      kind: 'path',
      operationIndex: at,
      normalizedRect: [(x - 1) / 400, 229 / 400, (x + 21) / 400, 232 / 400]
    })
  }
  if (variant === 'later-white') {
    f.add(OPS.setFillRGBColor, ['#ffffff'])
    f.shape(40, 70, 310, 190)
  }
  f.add(OPS.paintFormXObjectEnd, null)
  f.add(OPS.restore, null)
  f.add(OPS.setFillRGBColor, ['#000000'])
  if (variant === 'foreign-ink') f.text('Foreign prose', 100, 180)
  const line = 'Figure 1. Independent measurements.'
  f.text(line, 60, 252)
  f.figure.caption = { page: 1, rect: [60, 242, 280, 255], lines: [line] }
  f.figure.rect = [20, 15, 380, 290]
  f.captions = [f.figure.caption]
  if (variant === 'duplicate-caption') f.captions.push({ ...f.figure.caption })
  f.peers = [f.figure]
  f.context.glyphBounds[0].glyphs = [
    ...new Map(
      f.context.glyphBounds[0].glyphs.map((g: { fontChar: string }) => [g.fontChar, g])
    ).values()
  ]
  return f
}
const curvedFormPlan = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  nativeCertifiedFigurePixelCrop(
    f.page,
    f.figure,
    f.captions,
    f.tables,
    f.tokens,
    f.context,
    f.peers
  )
it('retains clipped native plots and their legend while excluding white padding and foreign prose', () => {
  const f = anonymousCurvedForm(),
    before = JSON.stringify(f)
  expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeDefined()
  expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeUndefined()
  const plan = curvedFormPlan(f)
  expect(plan?.kind).toBe('complete-native-occupied-clipped-form')
  expect(plan.sourceItems).toBeUndefined()
  expect(plan.rect[1]).toBeGreaterThan(70)
  expect(plan.rect[3]).toBeLessThan(240)
  expect(plan.rect[3]).toBeGreaterThan(235)
  expect(JSON.stringify(f)).toBe(before)
  const canvas = createCanvas(
      Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
      Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
    ),
    png = canvas.toBuffer('image/png')
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  expect(nativeCertifiedFigurePixelPngSafe({ ...plan }, png, plan.rect, f.page)).toBe(false)
  const source = f.context.content.items[1].sourceItem
  f.context.content.items[1].sourceItem = { ...source }
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  f.context.content.items[1].sourceItem = source
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  plan.rect[0] -= 1
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  canvas.width = canvas.height = 0
})
it.each([
  'prior-ink',
  'translucent-white',
  'later-white',
  'foreign-ink',
  'bent-line',
  'unclosed-clip',
  'nonrectangular-white',
  'duplicate-caption'
])('declines an occupied clipped Form without complete independent bounds: %s', (variant) => {
  const f = anonymousCurvedForm(variant),
    before = JSON.stringify(f)
  expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeDefined()
  expect(curvedFormPlan(f)).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})

const crossPageMetadataApi = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
const anonymousCrossPageBody = (variant = ''): ReturnType<typeof JSON.parse> => {
  const make = (number: number): ReturnType<typeof JSON.parse> => {
    const f = anonymousCertifiedPicture([], undefined, false, false, [])
    for (const a of [
      f.context.operators.fnArray,
      f.context.operators.argsArray,
      f.context.content.items,
      f.context.glyphBounds[0].glyphs,
      f.page.graphicsBounds,
      f.tokens
    ])
      a.length = 0
    f.page.pageNumber = f.context.pageNumber = number
    f.context.content.styles.B = { ...f.context.content.styles.F }
    f.context.content.styles.C = { ...f.context.content.styles.F }
    const faces = new Map<string, ReturnType<typeof JSON.parse>[]>([
      ['F', f.context.glyphBounds[0].glyphs],
      ['B', []],
      ['C', []]
    ])
    const emit = (
      str: string,
      x: number,
      y: number,
      font = 'F',
      size = 10,
      descent = -0.1,
      ascent = 0.7
    ): void => {
      const horizontal = font === 'F' ? 1.02 : font === 'B' ? 0.99 : 1
      const at = f.context.operators.fnArray.length
      f.text(str, x, y)
      f.context.operators.argsArray[at + 1] = [font, size]
      f.context.operators.argsArray[at + 2][0][0] = horizontal
      const raw = f.context.content.items.at(-1),
        glyph = f.context.glyphBounds[0].glyphs.at(-1)
      raw.fontName = font
      raw.width = (size * horizontal * str.length) / 2
      raw.height = size
      raw.transform = [size * horizontal, 0, 0, size, x, 400 - y]
      raw.sourceItem.pageNumber = number
      glyph.bounds = [0, descent, str.length / 2, ascent]
      if (font !== 'F') faces.get(font)!.push(f.context.glyphBounds[0].glyphs.pop())
      f.tokens[f.tokens.length - 1] = tableTextToken(raw, f.context.viewport, 0)
    }
    const line = (
      str: string,
      x: number,
      y: number,
      font = 'F',
      size = 10,
      descent = -0.1,
      ascent = 0.7
    ): void => {
      let offset = 0
      for (const part of str.split(/(Map)/u).filter(Boolean)) {
        emit(part, x + offset, y, part === 'Map' ? 'B' : font, size, descent, ascent)
        offset += (size * (part === 'Map' ? 0.99 : font === 'F' ? 1.02 : 1) * part.length) / 2
      }
      f.page.lines.push({ text: str, x, y: y - size, width: offset, height: size, fontSize: size })
    }
    f.add(OPS.setFillRGBColor, ['#000000'])
    const done = (): void => {
      f.context.glyphBounds = [...faces].map(([fontName, glyphs]) => ({
        fontName,
        glyphs: [...new Map(glyphs.map((g) => [g.fontChar, g])).values()]
      }))
    }
    return { ...f, line, done }
  }
  const prior = make(1),
    current = make(2)
  prior.shape(50, 45, 100, 25)
  const parentLines = [
    'Figure 1. Complete measurements.',
    variant === 'open-parent' ? 'All values are retained' : 'All values are retained.'
  ]
  parentLines.forEach((line, i) => prior.line(line, 40, 105 + i * 12, 'C'))
  const parentCaption = { page: 1, rect: [40, 95, 200, 117], lines: parentLines }
  prior.line(
    variant === 'unclosed-parent-domain' ? 'Related account' : '1 Methods',
    40,
    160,
    'C',
    14
  )
  prior.line('A Map records native work.', 40, 185)
  prior.line('The test account concludes.', 40, 197)
  const parentFigure = {
    id: 'prior-view',
    page: 1,
    caption: parentCaption,
    region: [0.1, 0.1, 0.8, 0.2],
    thumbnail: 'thumbnails/prior.png',
    graphicsCount: 1
  }
  current.shape(260, 40, 70, 25)
  const currentCaption = {
    page: 2,
    rect: [240, 90, 395, 100],
    lines: ['Figure 2. Independent values.']
  }
  current.line(currentCaption.lines[0], 240, 100, 'C')
  const currentFigure = {
    id: 'current-view',
    page: 2,
    caption: currentCaption,
    region: [0.6, 0.1, 0.9, 0.2],
    thumbnail: 'thumbnails/current.png',
    graphicsCount: 1
  }
  current.line('A Map records the work.', 60, 148)
  current.line(
    'The prior account ends.',
    50,
    160,
    'F',
    10,
    variant === 'ink-collision' ? -0.6 : -0.25
  )
  if (variant === 'other-foreign') current.line('Foreign label', 175, 165, 'F', 10, -0.25)
  const lines = [
    'Figure 1 holds the base.',
    'A Map guides the record.',
    'The evidence is complete.'
  ]
  const face = variant === 'caption-continuation' ? 'C' : 'F'
  lines.forEach((line, i) =>
    current.line(
      line,
      i ? 50 : 60,
      172 + i * 12,
      face,
      10,
      -0.1,
      variant === 'reverse-collision' && i === 0 ? 1.25 : 0.7
    )
  )
  current.line(
    variant === 'missing-heading' ? 'Further evidence' : '2 Further evidence',
    50,
    228,
    'C',
    14
  )
  current.line('A Map begins the work', 50, 250)
  current.line('the next unit continues', 50, 262)
  const caption = { page: 2, rect: [50, 162, 190, 196], lines }
  const figure = {
    id: 'ordinary-reference',
    page: 2,
    caption,
    issue: 'no-unambiguous-adjacent-graphics'
  }
  const captions = [parentCaption, currentCaption, caption],
    figures = [parentFigure, currentFigure, figure]
  if (variant === 'duplicate-parent') {
    prior.shape(260, 45, 70, 25)
    prior.line('Figure 1. Another complete view.', 40, 290, 'C')
    const duplicate = {
      page: 1,
      rect: [40, 280, 200, 290],
      lines: ['Figure 1. Another complete view.']
    }
    captions.push(duplicate)
    figures.push({ ...parentFigure, id: 'second-prior-view', caption: duplicate })
  }
  prior.done()
  current.done()
  if (variant === 'different-pdf') prior.context.sourceSha256 = 'b'.repeat(64)
  const previousFrame = { pageGeometry: prior.page, context: prior.context }
  return { prior, current, figure, captions, figures, previousFrame }
}
const crossPageBodyProof = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  crossPageMetadataApi.nativeCrossPageOrdinaryBodyReferenceMetadata(
    f.figure,
    f.current.page,
    f.captions,
    f.figures,
    f.current.context,
    f.previousFrame
  )
it('omits only a crosspage ghost when complete prior ink touches the body advance upper blank', () => {
  const f = anonymousCrossPageBody(),
    before = JSON.stringify(f)
  const priorPacket = nativePageTextPacketInventory(
    f.prior.page,
    f.prior.tokens,
    f.prior.context,
    true
  )
  const packet = nativePageTextPacketInventory(
    f.current.page,
    f.current.tokens,
    f.current.context,
    true
  )
  expect(priorPacket).toBeDefined()
  expect(packet).toBeDefined()
  const first = packet.records.find((r) => r.r.str.startsWith('Figure 1 holds')),
    earlier = packet.records.find((r) => r.r.str === 'The prior account ends.')
  expect(Math.max(...earlier.part.map(({ g }) => g.ink[3]))).toBeGreaterThan(first.rect[1])
  expect(Math.max(...earlier.part.map(({ g }) => g.ink[3]))).toBeLessThan(
    Math.min(...first.part.map(({ g }) => g.ink[1]))
  )
  const proof = crossPageBodyProof(f)
  expect(proof?.current()).toBe(true)
  expect(Object.keys(proof)).toEqual(['current'])
  expect(JSON.stringify(f)).toBe(before)
  const source = f.prior.context.content.items[0].sourceItem
  f.prior.context.content.items[0].sourceItem = { ...source }
  expect(proof.current()).toBe(false)
  f.prior.context.content.items[0].sourceItem = source
  expect(proof.current()).toBe(true)
  const context = f.previousFrame.context
  f.previousFrame.context = { ...context }
  expect(proof.current()).toBe(false)
  f.previousFrame.context = context
  expect(proof.current()).toBe(true)
})
it.each([
  'ink-collision',
  'reverse-collision',
  'other-foreign',
  'missing-heading',
  'open-parent',
  'unclosed-parent-domain',
  'caption-continuation',
  'duplicate-parent',
  'different-pdf'
])('retains crosspage metadata without a complete narrow proof: %s', (variant) => {
  const f = anonymousCrossPageBody(variant),
    before = JSON.stringify(f)
  expect(
    nativePageTextPacketInventory(f.prior.page, f.prior.tokens, f.prior.context, true)
  ).toBeDefined()
  expect(
    nativePageTextPacketInventory(f.current.page, f.current.tokens, f.current.context, true)
  ).toBeDefined()
  expect(crossPageBodyProof(f)).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})

const savedHatchApi = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const anonymousSavedHatch = (variant = ''): ReturnType<typeof JSON.parse> => {
  const f = anonymousCertifiedPicture([], undefined, false, false, [])
  for (const a of [
    f.context.operators.fnArray,
    f.context.operators.argsArray,
    f.context.content.items,
    f.context.glyphBounds[0].glyphs,
    f.page.graphicsBounds,
    f.tokens,
    f.page.lines
  ])
    a.length = 0
  f.context.content.styles.F = { ascent: 0, descent: 0, vertical: false }
  f.add(OPS.setFillRGBColor, ['#000000'])
  f.text('Several ordinary records remain outside this independent diagram.', 20, 35)
  f.context.content.items[0].width += 1
  f.tokens[0] = tableTextToken(f.context.content.items[0], f.context.viewport, 0)
  f.text('Earlier ordinary evidence remains in the original reading column.', 20, 50)
  f.text(
    variant === 'open-body'
      ? 'A complete account remains in this separate paragraph'
      : 'A complete account remains in this separate paragraph.',
    20,
    82
  )
  // A real positive native outline with no corresponding TextContent item.
  // It is physically foreign and must stay in the new evidence inventory.
  f.text('\r', 360, 60)
  f.context.content.items.pop()
  f.tokens.pop()
  f.add(OPS.save, null)
  f.add(OPS.setFillRGBColor, ['#f5f5f5'])
  f.shape(60, 100, 270, 150)
  const program = {
    fnArray: [OPS.save, OPS.setLineWidth, OPS.constructPath, OPS.restore],
    argsArray: [null, [0.35], [OPS.stroke, [[0, -2, 0, 1, 2, 0]], [-2, 0, 2, 0]], null],
    length: 4
  }
  if (variant === 'unsupported-cell') program.fnArray[2] = OPS.shadingFill
  const pattern = (color: string): void =>
    f.add(OPS.setFillColorN, [
      'TilingPattern',
      color,
      program,
      [0.7071, 0.7071, -0.7071, 0.7071, 0, 0],
      [-2, -2, 2, 2],
      4.1,
      4.1,
      2,
      1
    ])
  pattern('#c7c7c7')
  f.shape(60, 100, 270, 150)
  pattern('#ecb78c')
  f.shape(90, 125, 210, 100)
  f.add(OPS.setFillRGBColor, ['#000000'])
  f.text('North axis', 90, 140)
  f.text('Panel A', 90, 160)
  f.text('Panel B', 200, 180)
  f.text('Summary', 100, 230)
  if (variant !== 'unclosed-save') f.add(OPS.restore, null)
  if (variant === 'foreign-overlap') f.text('Unrelated exterior label', 80, 160)
  const line = 'Figure 1. Independent diagram.'
  f.text(line, 60, 285)
  f.figure = {
    id: 'saved-hatch-view',
    page: 1,
    rect: [50, 65, 350, 270],
    caption: { page: 1, rect: [60, 275, 230, 285], lines: [line] }
  }
  f.captions = [f.figure.caption]
  f.tables = []
  f.peers = [f.figure]
  f.context.glyphBounds[0].glyphs = [
    ...new Map(
      f.context.glyphBounds[0].glyphs.map((g: ReturnType<typeof JSON.parse>) => [g.fontChar, g])
    ).values()
  ]
  if (variant === 'missing-outline')
    f.context.glyphBounds[0].glyphs = f.context.glyphBounds[0].glyphs.filter(
      (g: ReturnType<typeof JSON.parse>) => g.fontChar !== 'Panel B'
    )
  return f
}
const savedHatchPlan = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  nativeCertifiedFigurePixelCrop(
    f.page,
    f.figure,
    f.captions,
    f.tables,
    f.tokens,
    f.context,
    f.peers
  )
it('preserves saved uncolored hatching while removing a complete exterior sentence without Source authority', () => {
  const f = anonymousSavedHatch(),
    before = JSON.stringify(f),
    plan = savedHatchPlan(f)
  expect(plan).toBeDefined()
  expect(plan.kind).toBe('complete-native-uncolored-saved-pixel')
  expect(plan.rect).toEqual([58, 98, 332, 252])
  expect(plan.sourceItems).toBeUndefined()
  expect(plan.nativeBody).toBeUndefined()
  expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeUndefined()
  expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeUndefined()
  const handle = savedHatchApi.createNativeSavedUncoloredPixelEvidence(f.page, f.tokens, f.context),
    data = savedHatchApi.nativeSavedUncoloredPixelEvidenceData(handle, f.page, f.tokens, f.context)
  expect(data.glyphs.some((g: ReturnType<typeof JSON.parse>) => g.text === '\r')).toBe(true)
  expect(data.records[0].raw.width).toBeGreaterThan(
    data.glyphs[0].advance[2] - data.glyphs[0].advance[0]
  )
  expect(f.context.content.styles.F.ascent).toBe(0)
  expect(nativeFigurePaintCertificateData(handle, f.page, f.tokens, f.context)).toBeUndefined()
  expect(
    savedHatchApi.nativeSavedUncoloredPixelEvidenceData({}, f.page, f.tokens, f.context)
  ).toBeUndefined()
  const canvas = createCanvas(
      Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
      Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
    ),
    png = canvas.toBuffer('image/png')
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  expect(nativeCertifiedFigurePixelPngSafe({ ...plan }, png, plan.rect, f.page)).toBe(false)
  expect(JSON.stringify(f)).toBe(before)
  const source = f.context.content.items[0].sourceItem
  f.context.content.items[0].sourceItem = { ...source }
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  f.context.content.items[0].sourceItem = source
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  plan.rect[0] -= 1
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  canvas.width = canvas.height = 0
})
it.each(['unsupported-cell', 'unclosed-save', 'foreign-overlap', 'open-body', 'missing-outline'])(
  'refuses a saved hatch crop without complete independent physical proof: %s',
  (variant) => {
    const f = anonymousSavedHatch(variant),
      before = JSON.stringify(f)
    if (variant === 'foreign-overlap' || variant === 'open-body')
      expect(
        savedHatchApi.createNativeSavedUncoloredPixelEvidence(f.page, f.tokens, f.context)
      ).toBeDefined()
    expect(savedHatchPlan(f)).toBeUndefined()
    expect(JSON.stringify(f)).toBe(before)
  }
)

const keyedPairModule = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const { groupPageLines: keyedPairGroupLines } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
const { nativeCaptionedRasterSideBySide: keyedPairLegacySideBySide } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-captioned-illustration.mjs')).href
)
const { nativeFigureLabelBounds: keyedPairLabelBounds } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-crop-geometry.mjs')).href
)

// Anonymous native operators reproduce a small left panel beside a wide right
// panel. No external document, image payload or file identifier is retained.
function anonymousUnequalKeyedPair(mode = ''): ReturnType<typeof JSON.parse> {
  const page: ReturnType<typeof JSON.parse> = {
      pageNumber: 1,
      width: 400,
      height: 400,
      rotation: 0,
      renderRotation: 0,
      invalidGraphicsBounds: 0,
      lines: [],
      graphicsBounds: []
    },
    viewport = {
      width: 400,
      height: 400,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, 400],
      convertToViewportPoint: (x: number, y: number) => [x, 400 - y]
    },
    style = { ascent: 0.7, descent: -0.1, vertical: false },
    context: ReturnType<typeof JSON.parse> = {
      pageNumber: 1,
      sourceSha256: 'a'.repeat(64),
      viewport,
      operators: { fnArray: [], argsArray: [] },
      content: { items: [], styles: { F: style } },
      glyphBounds: [{ fontName: 'F', glyphs: [] }],
      graphicsBounds: page.graphicsBounds
    },
    tokens: ReturnType<typeof JSON.parse>[] = [],
    add = (op: number, args: unknown): void => {
      context.operators.fnArray.push(op)
      context.operators.argsArray.push(args)
    },
    text = (str: string, x: number, baseline: number): void => {
      add(OPS.beginText, null)
      add(OPS.setFont, ['F', 8])
      add(OPS.setTextMatrix, [[1, 0, 0, 1, x, 400 - baseline]])
      add(OPS.showText, [
        [{ unicode: str, fontChar: str, width: 500 * str.length, isInFont: true }]
      ])
      add(OPS.endText, null)
      const sourceItem = { pageNumber: 1, index: context.content.items.length, text: str },
        raw = {
          str,
          dir: 'ltr',
          width: 4 * str.length,
          height: 8,
          transform: [8, 0, 0, 8, x, 400 - baseline],
          fontName: 'F',
          sourceItem,
          hasEOL: true
        }
      context.content.items.push(raw)
      context.glyphBounds[0].glyphs.push({
        fontChar: str,
        bounds: [0, -0.1, 0.5 * str.length, 0.7]
      })
      tokens.push({
        ...tableTextToken(raw, viewport, 0),
        nativeLabelRect: keyedPairLabelBounds(raw, style, viewport),
        fontAscent: style.ascent,
        fontDescent: style.descent
      })
      page.lines.push({ text: str, x, y: baseline - 8, width: raw.width, height: 8, fontSize: 8 })
    },
    image = (x: number, width: number): void => {
      add(OPS.save, null)
      add(OPS.transform, [width, 0, 0, 100, x, 250])
      const operationIndex = context.operators.fnArray.length
      add(OPS.paintImageXObject, ['anonymous-image-' + operationIndex, 80, 100])
      page.graphicsBounds.push({
        operationIndex,
        kind: 'image',
        normalizedRect: [x / 400, 50 / 400, (x + width) / 400, 150 / 400]
      })
      add(OPS.restore, null)
    }
  add(OPS.setFillRGBColor, ['#000000'])
  image(45, 90)
  image(145, 220)
  text('(a)', 84, 160)
  text(mode === 'wrong-key' ? '(c)' : '(b)', 249, 160)
  if (mode === 'foreign') text('Unrelated prose.', 70, 120)
  const title = 'Figure 1: Native panels (a) and (b).'
  text(title, 40, 190)
  const caption = { page: 1, lines: [title], rect: [40, 182, 380, 190] },
    captions = [caption],
    tables: number[][] = [],
    legacy = { caption, rect: [45, 50, 135, 160.8], graphicsCount: 1 }
  if (mode === 'table') tables.push([200, 90, 300, 140])
  if (mode === 'caption') caption.lines[0] += ' Altered.'
  if (mode === 'third-image') image(10, 20)
  if (mode === 'source') context.content.items[0].sourceItem.index = 1
  return { page, context, tokens, caption, captions, tables, legacy }
}
function keyedPairPlan(f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> {
  const origins = new Map(),
    runs = keyedPairGroupLines(f.page, [], origins)
  return {
    plan: keyedPairModule.nativeKeyedImagePairPixelCrop?.(
      f.page,
      f.legacy,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.legacy.rect,
      runs
    ),
    origins,
    runs
  }
}
it('completes the unequal native image family from a narrow legacy crop', () => {
  const f = anonymousUnequalKeyedPair(),
    before = JSON.stringify(f),
    result = keyedPairPlan(f),
    rect = result.plan?.rect ?? f.legacy.rect
  expect(keyedPairLegacySideBySide(f.page, f.caption, f.captions, f.tables)).toBeUndefined()
  expect(rect).toEqual([43, 48, 367, 162.8])
  expect(result.plan.graphicsCount).toBe(2)
  expect(result.plan.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})
it.each(['wrong-key', 'foreign', 'table', 'caption', 'third-image', 'source'])(
  'refuses an incomplete unequal native pair: %s',
  (mode) => {
    const f = anonymousUnequalKeyedPair(mode)
    expect(keyedPairPlan(f).plan).toBeUndefined()
  }
)
it('binds genuine grouped caption provenance and actual image/PNG epochs', () => {
  const f = anonymousUnequalKeyedPair(),
    { plan, origins, runs } = keyedPairPlan(f),
    canvas = createCanvas(
      Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
      Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
    ),
    png = canvas.toBuffer('image/png')
  try {
    expect(keyedPairModule.nativeKeyedImagePairPixelPlanCurrent(plan, f.page)).toBe(true)
    expect(keyedPairModule.nativeKeyedImagePairPixelPngSafe(plan, png, plan.rect, f.page)).toBe(
      true
    )
    expect(keyedPairModule.nativeKeyedImagePairPixelPlanCurrent({ ...plan }, f.page)).toBe(false)
    expect(
      keyedPairModule.nativeKeyedImagePairPixelPngSafe({ ...plan }, png, plan.rect, f.page)
    ).toBe(false)
    expect(
      keyedPairModule.nativeKeyedImagePairPixelCrop(
        f.page,
        f.legacy,
        f.captions,
        [],
        f.tokens,
        f.context,
        f.legacy.rect,
        structuredClone(runs)
      )
    ).toBeUndefined()
    const parts = origins.get(runs[0])
    origins.set(runs[0], [...parts])
    expect(keyedPairModule.nativeKeyedImagePairPixelPlanCurrent(plan, f.page)).toBe(false)
    origins.set(runs[0], parts)
    expect(keyedPairModule.nativeKeyedImagePairPixelPlanCurrent(plan, f.page)).toBe(true)
    const args = f.context.operators.argsArray
    f.context.operators.argsArray = structuredClone(args)
    expect(keyedPairModule.nativeKeyedImagePairPixelPngSafe(plan, png, plan.rect, f.page)).toBe(
      false
    )
    f.context.operators.argsArray = args
    canvas.width = Math.ceil((plan.rect[2] - plan.rect[0]) / 2)
    canvas.height = Math.ceil((plan.rect[3] - plan.rect[1]) / 2)
    expect(
      keyedPairModule.nativeKeyedImagePairPixelPngSafe(
        plan,
        canvas.toBuffer('image/png'),
        plan.rect,
        f.page
      )
    ).toBe(false)
  } finally {
    canvas.width = canvas.height = 0
  }
})

it('keeps raw numeric script Sources exact while comparing the native grouped caption display', () => {
  const f = anonymousUnequalKeyedPair(),
    c = f.context,
    add = (op: number, args: unknown): void => {
      c.operators.fnArray.push(op)
      c.operators.argsArray.push(args)
    }
  c.operators.fnArray.splice(-5)
  c.operators.argsArray.splice(-5)
  c.content.items.pop()
  c.glyphBounds[0].glyphs.pop()
  f.tokens.pop()
  f.page.lines.pop()
  const nativeText = (str: string, em: number, x: number, baseline: number): void => {
    add(OPS.beginText, null)
    add(OPS.setFont, ['F', em])
    add(OPS.setTextMatrix, [[1, 0, 0, 1, x, 400 - baseline]])
    add(OPS.showText, [[{ unicode: str, fontChar: str, width: 500 * str.length, isInFont: true }]])
    add(OPS.endText, null)
    const raw = {
      str,
      dir: 'ltr',
      width: em * 0.5 * str.length,
      height: em,
      transform: [em, 0, 0, em, x, 400 - baseline],
      fontName: 'F',
      hasEOL: true,
      sourceItem: { pageNumber: 1, index: c.content.items.length, text: str }
    }
    c.content.items.push(raw)
    c.glyphBounds[0].glyphs.push({ fontChar: str, bounds: [0, -0.1, 0.5 * str.length, 0.7] })
    f.tokens.push({
      ...tableTextToken(raw, c.viewport, 0),
      nativeLabelRect: keyedPairLabelBounds(raw, c.content.styles.F, c.viewport),
      fontAscent: 0.7,
      fontDescent: -0.1
    })
    f.page.lines.push({
      text: str,
      x,
      y: baseline - em,
      width: raw.width,
      height: em,
      fontSize: em
    })
  }
  const base = 'Figure 1: Counts 10',
    tail = 'cells (a) and (b).',
    edge = 40 + base.length * 4
  nativeText(base, 8, 40, 190)
  nativeText('5', 5.5, edge, 187)
  nativeText(tail, 8, edge + 2.75, 190)
  const origins = new Map(),
    rows = keyedPairGroupLines(f.page, [], origins),
    caption = rows.find((row: { text: string }) => row.text.startsWith('Figure 1:'))
  expect(caption).toBeDefined()
  f.caption.lines = [caption.text]
  f.caption.rect = [caption.x, caption.y, caption.right, caption.bottom]
  const rawLiterals = c.content.items.slice(-3).map((r: { str: string }) => r.str),
    before = JSON.stringify(f),
    { plan } = keyedPairPlan(f)
  expect(rawLiterals).toEqual([base, '5', tail])
  expect(caption.text.replace(/\s/gu, '')).not.toBe(rawLiterals.join('').replace(/\s/gu, ''))
  expect(plan).toBeDefined()
  expect(plan.sourceItems).toBeUndefined()
  const canvas = createCanvas(
    Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
    Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
  )
  try {
    expect(
      keyedPairModule.nativeKeyedImagePairPixelPngSafe(
        plan,
        canvas.toBuffer('image/png'),
        plan.rect,
        f.page
      )
    ).toBe(true)
    expect(c.content.items.slice(-3).map((r: { str: string }) => r.str)).toEqual(rawLiterals)
    expect(JSON.stringify(f)).toBe(before)
  } finally {
    canvas.width = canvas.height = 0
  }
})

// One generated native fixture covers a two-row raster plate beside a separate
// captioned image and a keyed raster grid. No external page or image is retained.
function anonymousCompleteRasterPlate(shape = 'rows', mode = ''): ReturnType<typeof JSON.parse> {
  const page: ReturnType<typeof JSON.parse> = {
      pageNumber: 1,
      width: 400,
      height: 500,
      rotation: 0,
      renderRotation: 0,
      invalidGraphicsBounds: 0,
      graphicsBounds: [],
      lines: []
    },
    viewport = {
      scale: 1,
      width: 400,
      height: 500,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, 500],
      convertToViewportPoint: (x: number, y: number) => [x, 500 - y]
    },
    style = { ascent: 0.7, descent: -0.1, vertical: false },
    context: ReturnType<typeof JSON.parse> = {
      pageNumber: 1,
      sourceSha256: 'a'.repeat(64),
      viewport,
      content: { items: [], styles: { F: style } },
      operators: { fnArray: [], argsArray: [] },
      glyphBounds: [{ fontName: 'F', glyphs: [] }],
      graphicsBounds: page.graphicsBounds,
      opaqueRasterImages: []
    },
    tokens: ReturnType<typeof JSON.parse>[] = [],
    add = (op: number, a: unknown): void => {
      context.operators.fnArray.push(op)
      context.operators.argsArray.push(a)
    },
    image = (x: number, y: number, w: number, h: number, large = false): void => {
      add(OPS.save, null)
      add(OPS.transform, [w, 0, 0, h, x, 500 - y - h])
      const i = context.operators.fnArray.length,
        id = 'anonymous-' + i,
        width = large ? 4000 : 80,
        height = large ? 2000 : 100
      add(OPS.paintImageXObject, [id, width, height])
      add(OPS.restore, null)
      page.graphicsBounds.push({
        kind: 'image',
        operationIndex: i,
        normalizedRect: [x / 400, y / 500, (x + w) / 400, (y + h) / 500],
        ...(large ? {} : { imageHash: String(i % 10).repeat(64) })
      })
      if (large)
        context.opaqueRasterImages.push({ operationIndex: i, imageId: id, width, height, kind: 2 })
    },
    text = (str: string, x: number, baseline: number): void => {
      add(OPS.beginText, null)
      add(OPS.setFont, ['F', 8])
      add(OPS.setTextMatrix, [[1, 0, 0, 1, x, 500 - baseline]])
      add(OPS.showText, [
        [{ unicode: str, fontChar: str, width: 500 * str.length, isInFont: true }]
      ])
      add(OPS.endText, null)
      const raw = {
        str,
        dir: 'ltr',
        width: 4 * str.length,
        height: 8,
        transform: [8, 0, 0, 8, x, 500 - baseline],
        fontName: 'F',
        hasEOL: true,
        sourceItem: { pageNumber: 1, index: context.content.items.length, text: str }
      }
      context.content.items.push(raw)
      context.glyphBounds[0].glyphs.push({
        fontChar: str,
        bounds: [0, -0.1, 0.5 * str.length, 0.7]
      })
      tokens.push({
        ...tableTextToken(raw, viewport, 0),
        nativeLabelRect: keyedPairLabelBounds(raw, style, viewport),
        fontAscent: 0.7,
        fontDescent: -0.1
      })
      page.lines.push({ text: str, x, y: baseline - 8, width: raw.width, height: 8, fontSize: 8 })
    },
    captions: ReturnType<typeof JSON.parse>[] = []
  add(OPS.setFillRGBColor, ['#000000'])
  text('Running head.', 40, 25)
  const headerOp = context.operators.fnArray.length
  add(OPS.constructPath, [
    OPS.fill,
    [[0, 40, 470, 1, 360, 470, 1, 360, 471, 1, 40, 471, 4]],
    [40, 470, 360, 471]
  ])
  let published: number[]
  if (shape === 'rows') {
    image(40, 50, 320, 55, true)
    image(40, 108, 320, 55)
    const title = 'Figure 1: Panels (a–d) and (e–h).'
    text(title, 40, 180)
    captions.push({ page: 1, lines: [title], rect: [40, 172, 360, 180] })
    image(40, 245, 320, 90)
    const other = 'Figure 2: Independent image.'
    text(other, 40, 355)
    captions.push({ page: 1, lines: [other], rect: [40, 347, 360, 355] })
    published = [40, 108, 360, 163]
    if (mode === 'extra-image') image(40, 190, 320, 20)
    if (mode === 'missing-opaque') context.opaqueRasterImages = []
  } else {
    image(70, 40, 260, 35)
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) {
        const x = 40 + 115 * c,
          y = 80 + 80 * r,
          label = '(' + String.fromCharCode(97 + r * 3 + c) + ') Tile'
        image(x, y, 90, 60)
        text(label, x + 45 - label.length * 2, y + 68)
      }
    const title = 'Figure 1: Raster grid and shared legend.'
    text(title, 40, 319)
    captions.push({ page: 1, lines: [title], rect: [40, 311, 360, 319] })
    published = [40, 80, 360, 308.8]
    if (mode === 'extra-image') image(70, 10, 260, 20)
  }
  if (mode === 'foreign-ink') text('External.', 60, 100)
  const figure = { caption: captions[0], rect: published, graphicsCount: shape === 'rows' ? 1 : 9 }
  if (mode === 'caption') captions[0].lines[0] += ' Changed.'
  page.marginRuleBounds = [[0.1, 0.058, 0.9, 0.06]]
  context.graphicsBounds = [
    { kind: 'path', operationIndex: headerOp, normalizedRect: page.marginRuleBounds[0] },
    ...page.graphicsBounds
  ]
  return { page, context, tokens, captions, figure, tables: [] }
}
function completeRasterPlatePlan(f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> {
  return keyedPairModule.nativeCompleteRasterPlatePixelCrop?.(
    f.page,
    f.figure,
    f.captions,
    f.tables,
    f.tokens,
    f.context,
    f.figure.rect
  )
}
it.each(['rows', 'grid'])(
  'completes a bounded native raster plate without Source claims: %s',
  (shape) => {
    const f = anonymousCompleteRasterPlate(shape),
      before = JSON.stringify(f),
      plan = completeRasterPlatePlan(f)
    expect(plan).toBeDefined()
    expect(plan.sourceItems).toBeUndefined()
    expect(plan.rect[1]).toBeLessThan(f.figure.rect[1])
    if (shape === 'rows')
      expect(
        keyedPairModule.createNativeFigurePaintCertificate(f.page, f.tokens, f.context)
      ).toBeUndefined()
    else expect(f.captions[0].rect[1] - 2).toBeLessThan(plan.rect[3])
    expect(
      keyedPairModule.nativeFigurePaintCertificateData(plan, f.page, f.tokens, f.context)
    ).toBeUndefined()
    expect(keyedPairModule.nativeKeyedImagePairPixelPlanCurrent(plan, f.page)).toBe(false)
    expect(JSON.stringify(f)).toBe(before)
  }
)
it.each([
  ['rows', 'missing-opaque'],
  ['rows', 'extra-image'],
  ['grid', 'extra-image'],
  ['rows', 'foreign-ink'],
  ['grid', 'foreign-ink'],
  ['grid', 'caption']
])('refuses an incomplete raster plate proof: %s %s', (shape, mode) => {
  const f = anonymousCompleteRasterPlate(shape, mode),
    before = JSON.stringify(f)
  expect(keyedPairModule.nativePageTextPacketInventory(f.page, f.tokens, f.context)).toBeDefined()
  expect(completeRasterPlatePlan(f)).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})
it('binds raster-only identity, original no-hash inputs, output and PNG scale', () => {
  const f = anonymousCompleteRasterPlate(),
    plan = completeRasterPlatePlan(f)
  expect(plan).toBeDefined()
  const canvas = createCanvas(
      Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
      Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
    ),
    png = canvas.toBuffer('image/png')
  try {
    expect(keyedPairModule.nativeCompleteRasterPlatePixelPlanCurrent(plan, f.page)).toBe(true)
    expect(keyedPairModule.nativeCompleteRasterPlatePixelPlanCurrent({ ...plan }, f.page)).toBe(
      false
    )
    expect(
      keyedPairModule.nativeCompleteRasterPlatePixelPngSafe(plan, png, plan.rect, f.page)
    ).toBe(true)
    const records = f.context.content.items
    f.context.content.items = [...records]
    expect(
      keyedPairModule.nativeCompleteRasterPlatePixelPngSafe(plan, png, plan.rect, f.page)
    ).toBe(false)
    f.context.content.items = records
    expect(keyedPairModule.nativeCompleteRasterPlatePixelPlanCurrent(plan, f.page)).toBe(true)
    plan.rect[0] -= 1
    expect(keyedPairModule.nativeCompleteRasterPlatePixelPlanCurrent(plan, f.page)).toBe(false)
    plan.rect[0] += 1
    canvas.width = Math.ceil((plan.rect[2] - plan.rect[0]) / 2)
    canvas.height = Math.ceil((plan.rect[3] - plan.rect[1]) / 2)
    expect(
      keyedPairModule.nativeCompleteRasterPlatePixelPngSafe(
        plan,
        canvas.toBuffer('image/png'),
        plan.rect,
        f.page
      )
    ).toBe(false)
  } finally {
    canvas.width = canvas.height = 0
  }
})

const keyedFormWholeModule = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-whole-paint-scope.mjs')).href
)
// One generated plate keeps the last panel, key and caption in one complete BT.
function anonymousKeyedFormGrid(mode = ''): ReturnType<typeof JSON.parse> {
  const f = anonymousCertifiedPicture([], undefined, false, false, [])
  for (const a of [
    f.context.operators.fnArray,
    f.context.operators.argsArray,
    f.context.content.items,
    f.context.glyphBounds[0].glyphs,
    f.page.graphicsBounds,
    f.tokens
  ])
    a.length = 0
  const text = (str: string, x: number, y: number, shared = false): void => {
    if (!shared) f.add(OPS.beginText, null)
    f.add(OPS.setFont, ['F', 10])
    f.add(OPS.setTextMatrix, [[1, 0, 0, 1, x, 400 - y]])
    f.add(OPS.showText, [
      [{ unicode: str, fontChar: str, width: 500 * str.length, isInFont: true }]
    ])
    if (!shared) f.add(OPS.endText, null)
    const raw = {
      str,
      dir: 'ltr',
      width: 5 * str.length,
      height: 10,
      transform: [10, 0, 0, 10, x, 400 - y],
      fontName: 'F',
      hasEOL: true,
      sourceItem: { pageNumber: 1, index: f.context.content.items.length, text: str }
    }
    f.context.content.items.push(raw)
    if (!f.context.glyphBounds[0].glyphs.some((g: { fontChar: string }) => g.fontChar === str))
      f.context.glyphBounds[0].glyphs.push({
        fontChar: str,
        bounds: [0, -0.1, str.length / 2, 0.7]
      })
    f.tokens.push(tableTextToken(raw, f.context.viewport, 0))
  }
  f.add(OPS.setFillRGBColor, ['#000000'])
  for (let i = 0; i < 9; i++) {
    const x = 20 + (i % 3) * 90,
      y = 20 + Math.floor(i / 3) * 90
    f.add(OPS.paintFormXObjectBegin, [null, [x, 400 - y - 60, x + 70, 400 - y]])
    f.shape(x, y, 70, 60)
    text('A', x + 10, y + 25)
    text(mode === 'node-key' && i === 8 ? 'C' : 'B', x + 45, y + 40)
    f.add(OPS.paintFormXObjectEnd, null)
    f.add(OPS.beginText, null)
    text('(' + String.fromCharCode(97 + i) + ')', x + 10, y + 74, true)
    text('View', x + 30, y + 74, true)
    if (i < 8) f.add(OPS.endText, null)
  }
  text('Node key', 300, 140, true)
  text('A', 300, 158, true)
  text('Left', 330, 158, true)
  text(mode === 'duplicate-key' ? 'A' : 'B', 300, 176, true)
  text('Right', 330, 176, true)
  if (mode === 'unknown-source') text('Unrelated note.', 300, 200, true)
  const title =
    'Figure 1. (a) to (i). The node key ' +
    (mode === 'caption-link' ? 'is unrelated.' : 'applies to every panel.')
  text(title, 20, 310, true)
  text('Ordinary body.', 20, 345, true)
  f.add(OPS.endText, null)
  const caption = { page: 1, lines: [title], rect: [20, 300, 390, 310] }
  f.figure.caption = caption
  f.figure.rect = [20, 110, 270, 274]
  f.captions = [caption]
  f.peers = [f.figure]
  if (mode === 'table') f.tables.push([295, 130, 365, 180])
  if (mode === 'foreign-paint') f.shape(280, 130, 8, 8)
  return f
}
it('recovers all nine native panels and the complete shared key without splitting a BT', () => {
  const f = anonymousKeyedFormGrid(),
    before = JSON.stringify(f)
  expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeDefined()
  expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeDefined()
  const plan = repeatedRasterHeaderPlan(f)
  expect(plan?.kind).toBe('complete-native-keyed-form-grid')
  expect(plan.rect[1]).toBeLessThan(20)
  expect(plan.rect[2]).toBeGreaterThan(350)
  expect(plan.sourceItems).toBeUndefined()
  const { nativeKeyedFormGridPixelPlanCurrent: current } = keyedFormWholeModule
  expect(current(plan, f.page)).toBe(true)
  expect(current({ ...plan }, f.page)).toBe(false)
  const ordinary = anonymousCaptionedFormGrid(2),
    oldPlan = repeatedRasterHeaderPlan(ordinary)
  expect(oldPlan).toBeDefined()
  expect(current(oldPlan, ordinary.page)).toBe(false)
  expect(nativeFigurePaintCertificateData(plan, f.page, f.tokens, f.context)).toBeUndefined()
  const original = f.context.content.items
  f.context.content.items = [...original]
  expect(current(plan, f.page)).toBe(false)
  f.context.content.items = original
  expect(current(plan, f.page)).toBe(true)
  const canvas = createCanvas(
    Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
    Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
  )
  try {
    expect(
      nativeCertifiedFigurePixelPngSafe(plan, canvas.toBuffer('image/png'), plan.rect, f.page)
    ).toBe(true)
    canvas.width = Math.ceil((plan.rect[2] - plan.rect[0]) / 2)
    canvas.height = Math.ceil((plan.rect[3] - plan.rect[1]) / 2)
    expect(
      nativeCertifiedFigurePixelPngSafe(plan, canvas.toBuffer('image/png'), plan.rect, f.page)
    ).toBe(false)
  } finally {
    canvas.width = canvas.height = 0
  }
  plan.rect[0] -= 1
  expect(current(plan, f.page)).toBe(false)
  expect(JSON.stringify(f)).toBe(before)
})
it.each(['node-key', 'duplicate-key', 'caption-link', 'unknown-source', 'foreign-paint', 'table'])(
  'refuses an unclosed keyed native plate: %s',
  (mode) => {
    const f = anonymousKeyedFormGrid(mode)
    expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeDefined()
    expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeDefined()
    expect(repeatedRasterHeaderPlan(f)).toBeUndefined()
  }
)
// One generated grid keeps compact shared-key pixels and whole three-Source
// panel descriptions. The original strings and arrow font are never rewritten.
function anonymousCompactKeyRows(mode = ''): ReturnType<typeof JSON.parse> {
  const f = anonymousCompleteRasterPlate('grid', mode === 'foreign-ink' ? mode : ''),
    c = f.context,
    oldItems = c.content.items,
    oldOps = c.operators,
    fnArray: number[] = [],
    argsArray: unknown[] = [],
    indices = new Map<number, number>(),
    items: ReturnType<typeof JSON.parse>[] = [],
    emit = (op: number, a: unknown): void => {
      fnArray.push(op)
      argsArray.push(a)
    },
    addItem = (
      base: ReturnType<typeof JSON.parse>,
      str: string,
      x: number,
      baseline: number,
      fontName = 'F',
      hasEOL = true
    ): void => {
      items.push({
        ...base,
        str,
        width: str.length * 4,
        height: 8,
        transform: [8, 0, 0, 8, x, 500 - baseline],
        fontName,
        hasEOL,
        sourceItem: { pageNumber: 1, index: items.length, text: str }
      })
    },
    show = (str: string): void =>
      emit(OPS.showText, [
        [{ unicode: str, fontChar: str, width: 500 * str.length, isInFont: true }]
      ])
  let source = 0,
    matrixIndex = 0
  for (let i = 0; i < oldOps.fnArray.length; i++) {
    const op = oldOps.fnArray[i],
      a = structuredClone(oldOps.argsArray[i])
    indices.set(i, fnArray.length)
    if (op === OPS.transform && a[0] === 260 && a[3] === 35) {
      a[0] = 140
      a[4] = 130
    }
    if (op === OPS.setTextMatrix) matrixIndex = fnArray.length
    if (op !== OPS.showText) {
      emit(op, a)
      continue
    }
    const raw = oldItems[source++]
    if (!/^\([a-i]\) Tile$/u.test(raw.str) || mode === 'unsplit') {
      const baseline = 500 - raw.transform[5] + (raw.str.startsWith('Figure 1:') ? 4 : 0)
      ;(argsArray[matrixIndex] as number[][])[0][5] = 500 - baseline
      emit(op, a)
      addItem(raw, raw.str, raw.transform[4], baseline)
      continue
    }
    const prefix = raw.str.slice(0, 3) + ' Recorded signal (',
      arrow = mode === 'wrong-arrow' ? '→' : '↑',
      x = raw.transform[4] + raw.width / 2 - (prefix.length + 2) * 2,
      baseline = 500 - raw.transform[5],
      suffixBaseline = baseline + (mode === 'detached-suffix' ? 2 : 0)
    ;(argsArray[matrixIndex] as number[][])[0][4] = x
    show(prefix)
    addItem(raw, prefix, x, baseline, 'F', false)
    emit(OPS.setFont, ['Arrow', 8])
    if (suffixBaseline !== baseline)
      emit(OPS.setTextMatrix, [[1, 0, 0, 1, x + prefix.length * 4, 500 - suffixBaseline]])
    show(arrow)
    addItem(raw, arrow, x + prefix.length * 4, suffixBaseline, 'Arrow', false)
    emit(OPS.setFont, ['F', 8])
    show(')')
    addItem(raw, ')', x + (prefix.length + 1) * 4, suffixBaseline)
  }
  f.captions[0].rect = f.captions[0].rect.map((v: number, i: number) => v + (i % 2 ? 4 : 0))
  c.operators = { fnArray, argsArray }
  c.content.items = items
  c.content.styles.Arrow = { ...c.content.styles.F }
  c.glyphBounds = ['F', 'Arrow'].map((fontName) => ({
    fontName,
    glyphs: [
      ...new Map(items.filter((r) => r.fontName === fontName).map((r) => [r.str, r])).values()
    ].map((r) => ({ fontChar: r.str, bounds: [0, -0.1, r.str.length * 0.5, 0.7] }))
  }))
  const remap = (g: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> => ({
    ...g,
    operationIndex: indices.get(g.operationIndex),
    ...(g.kind === 'image' && g.normalizedRect[1] === 0.08
      ? { normalizedRect: [130 / 400, 40 / 500, 270 / 400, 75 / 500] }
      : {})
  })
  f.page.graphicsBounds = f.page.graphicsBounds.map(remap)
  c.graphicsBounds = c.graphicsBounds.map(remap)
  f.tokens = items.map((raw) => ({
    ...tableTextToken(raw, c.viewport, 0),
    nativeLabelRect: keyedPairLabelBounds(raw, c.content.styles[raw.fontName], c.viewport),
    fontAscent: 0.7,
    fontDescent: -0.1
  }))
  f.page.lines = items.map((raw) => ({
    text: raw.str,
    x: raw.transform[4],
    y: 500 - raw.transform[5] - 8,
    width: raw.width,
    height: 8,
    fontSize: 8
  }))
  return f
}
it('retains a compact shared key and complete exterior arrow descriptions as pixels only', () => {
  const f = anonymousCompactKeyRows(),
    before = JSON.stringify(f),
    plan = completeRasterPlatePlan(f)
  expect(keyedPairModule.nativePageTextPacketInventory(f.page, f.tokens, f.context)).toBeDefined()
  expect(plan).toBeDefined()
  expect(plan.rect[0]).toBeLessThan(40)
  expect(plan.rect[1]).toBeLessThan(40)
  expect(plan.rect[2]).toBeGreaterThan(360)
  expect(plan.sourceItems).toBeUndefined()
  expect(
    keyedPairModule.nativeFigurePaintCertificateData(plan, f.page, f.tokens, f.context)
  ).toBeUndefined()
  expect(keyedPairModule.nativeCompleteRasterPlatePixelPlanCurrent(plan, f.page)).toBe(true)
  expect(keyedPairModule.nativeCompleteRasterPlatePixelPlanCurrent({ ...plan }, f.page)).toBe(false)
  const canvas = createCanvas(
    Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
    Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
  )
  expect(
    keyedPairModule.nativeCompleteRasterPlatePixelPngSafe(
      plan,
      canvas.toBuffer('image/png'),
      plan.rect,
      f.page
    )
  ).toBe(true)
  canvas.width = canvas.height = 0
  expect(JSON.stringify(f)).toBe(before)
})
it.each(['wrong-arrow', 'detached-suffix', 'foreign-ink', 'unsplit'])(
  'refuses an unclosed compact-key description: %s',
  (mode) => {
    const f = anonymousCompactKeyRows(mode),
      before = JSON.stringify(f)
    expect(keyedPairModule.nativePageTextPacketInventory(f.page, f.tokens, f.context)).toBeDefined()
    expect(completeRasterPlatePlan(f)).toBeUndefined()
    expect(JSON.stringify(f)).toBe(before)
  }
)

// A caption-shaped continuation remains part of its original native paragraph.
function ordinaryContinuationMetadata(mode = ''): ReturnType<typeof JSON.parse> {
  const f = anonymousCertifiedPicture([], undefined, false, false, [])
  for (const values of [
    f.context.operators.fnArray,
    f.context.operators.argsArray,
    f.context.content.items,
    f.context.glyphBounds[0].glyphs,
    f.page.graphicsBounds,
    f.tokens
  ])
    values.length = 0
  f.add(OPS.setFillRGBColor, ['#000000'])
  f.text('Archive', 200, 25)
  if (mode !== 'missing-prior')
    f.text(
      mode === 'closed-prior'
        ? 'The complete measured response is presented here.'
        : 'The complete measured response is presented in',
      40,
      55
    )
  const lines = [
    'figure 4. The measured result is retained here,',
    'each complete source remains native evidence,',
    'and all original observations close here.'
  ]
  lines.forEach((line, i) => {
    if (mode === 'split-line' && i === 1) {
      const head = 'each complete source '
      f.text(head, 40, 69 + i * 14)
      f.text('remains native evidence,', 40 + head.length * 5, 69 + i * 14)
    } else f.text(line, 40, 69 + i * 14)
  })
  f.context.content.items.at(-1).hasEOL = false
  if (mode === 'row-not-closed') f.context.content.items.at(-2).hasEOL = false
  // The header and paragraph share one original BT. Header glyphs stay foreign.
  for (let i = f.context.operators.fnArray.length - 2; i > 0; i--)
    if (
      f.context.operators.fnArray[i] === OPS.endText &&
      f.context.operators.fnArray[i + 1] === OPS.beginText
    ) {
      f.context.operators.fnArray.splice(i, 2)
      f.context.operators.argsArray.splice(i, 2)
    }
  f.shape(50, 130, 290, 60)
  const title = 'Figure 4. A separate complete response.'
  f.text(title, 40, 220)
  if (mode === 'foreign-ink') f.text('Independent annotation', 45, 80)
  f.page.lines = f.context.content.items.map((r) => ({
    text: r.str,
    x: r.transform[4],
    y: 400 - r.transform[5] - r.height,
    width: r.width,
    height: r.height,
    fontSize: r.height
  }))
  if (mode === 'split-line') {
    const start = f.context.content.items.findIndex((r) => r.str === 'each complete source '),
      records = f.context.content.items.slice(start, start + 2),
      shown = f.page.lines.slice(start, start + 2)
    f.page.lines.splice(start, 2, {
      ...shown[0],
      text: duplicateMetadataApi.joinPdfSmallCapsLine(records),
      width: shown[1].x + shown[1].width - shown[0].x
    })
  }
  const caption = {
    page: 1,
    lines,
    rect: [40, 59, 40 + Math.max(...lines.map((s) => s.length)) * 5, 97]
  }
  const genuineCaption = {
    page: 1,
    lines: [title],
    rect: [40, 210, 40 + title.length * 5, 220]
  }
  f.figure = {
    id: 'continuation-only-metadata',
    page: 1,
    caption,
    region: [45, 120, 345, 185].map((n) => n / 400),
    thumbnail: 'thumbnails/continuation.png',
    graphicsCount: 1
  }
  f.genuine = {
    id: 'retained-native-view',
    page: 1,
    caption: genuineCaption,
    region: [50, 130, 340, 190].map((n) => n / 400),
    thumbnail: 'thumbnails/retained.png',
    graphicsCount: 1
  }
  f.captions = mode === 'missing-title' ? [caption] : [caption, genuineCaption]
  f.peers = [f.figure, f.genuine]
  if (mode === 'unknown-metrics') delete f.context.content.styles.F.ascent
  if (mode === 'caption-literal') caption.lines[1] = 'A different display line.'
  return f
}

it('omits only a native same-page paragraph continuation with an independent genuine caption', () => {
  const f = ordinaryContinuationMetadata(),
    before = JSON.stringify(f),
    proof = duplicateOrdinaryProof(f)
  expect(proof?.current()).toBe(true)
  expect(proof.caption).toBe(f.figure.caption)
  expect(JSON.stringify(f)).toBe(before)
  expect(duplicateOrdinaryProof({ ...f, figure: f.genuine })).toBeUndefined()
  const item = f.context.content.items[1]
  item.sourceItem = { ...item.sourceItem }
  expect(proof.current()).toBe(false)
})
it.each([
  'missing-prior',
  'closed-prior',
  'missing-title',
  'foreign-ink',
  'unknown-metrics',
  'caption-literal',
  'row-not-closed'
])('retains continuation metadata without complete native %s evidence', (mode) => {
  expect(duplicateOrdinaryProof(ordinaryContinuationMetadata(mode))).toBeUndefined()
})

it('binds a normal Source-line flush to all its original native fragments without rewriting them', () => {
  const f = ordinaryContinuationMetadata('split-line'),
    before = JSON.stringify(f),
    proof = duplicateOrdinaryProof(f)
  expect(proof?.current()).toBe(true)
  expect(JSON.stringify(f)).toBe(before)
  const operators = f.context.operators.fnArray
  f.context.operators.fnArray = [...operators]
  expect(proof.current()).toBe(false)
})

async function metadataThumbnailWithdrawalFixture(
  parentAlias = false
): Promise<ReturnType<typeof JSON.parse>> {
  const fs = await import('node:fs'),
    { writeFile } = await import('node:fs/promises'),
    path = await import('node:path'),
    os = await import('node:os'),
    crypto = await import('node:crypto'),
    { compileFunction } = await import('node:vm'),
    { default: assert } = await import('node:assert/strict'),
    ts = await import('typescript'),
    text = fs.readFileSync(resolve('resources/literature-pdf-extract.mjs'), 'utf8'),
    ast = ts.createSourceFile('extract.mjs', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS),
    names = new Set(['rememberFigureMetadataPng', 'writeCropPng', 'withdrawFigureMetadataPng']),
    functions: string[] = []
  const visit = (node: import('typescript').Node): void => {
    if (ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ''))
      functions.push(node.getText(ast))
    ts.forEachChild(node, visit)
  }
  visit(ast)
  expect(functions).toHaveLength(3)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-metadata-withdraw-')),
    imageRoot = path.join(root, parentAlias ? 'alias' : '', 'thumbnails'),
    figures: unknown[] = [],
    tables: unknown[] = [],
    algorithms: unknown[] = [],
    written = new Map(),
    evaluate = compileFunction(
      functions.join('\n') + '\nreturn {writeCropPng,withdrawFigureMetadataPng}',
      [
        'assert',
        'createHash',
        'lstatSync',
        'realpathSync',
        'readFileSync',
        'unlinkSync',
        'resolve',
        'dirname',
        'join',
        'output',
        'writeFile',
        'imageRoot',
        'writtenFigurePngs',
        'figures',
        'tables',
        'algorithms'
      ]
    ),
    api = evaluate(
      assert,
      crypto.createHash,
      fs.lstatSync,
      fs.realpathSync,
      fs.readFileSync,
      fs.unlinkSync,
      path.resolve,
      path.dirname,
      path.join,
      path.dirname(imageRoot),
      writeFile,
      imageRoot,
      written,
      figures,
      tables,
      algorithms
    )
  if (parentAlias) {
    const target = path.join(root, 'actual')
    fs.mkdirSync(target)
    fs.symlinkSync(
      target,
      path.join(root, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
  }
  fs.mkdirSync(imageRoot)
  const figure = { id: 'ordinary-reference', thumbnail: 'thumbnails/ordinary-reference.png' },
    file = path.join(imageRoot, 'ordinary-reference.png'),
    bytes = Buffer.from('original rendered bytes')
  figures.push(figure)
  await api.writeCropPng(figure.thumbnail, bytes)
  return {
    fs,
    path,
    root,
    figures,
    tables,
    figure,
    file,
    bytes,
    api,
    close: () => {
      expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()))
      expect(path.basename(root).startsWith('native-metadata-withdraw-')).toBe(true)
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}

it('retains an omitted-metadata PNG when a remaining nested table part still references it', async () => {
  const f = await metadataThumbnailWithdrawalFixture()
  try {
    f.tables.push({ id: 'retained-table', parts: [{ thumbnail: f.figure.thumbnail }] })
    expect(() =>
      f.api.withdrawFigureMetadataPng(f.figure, new Set([f.figure]), () => true)
    ).toThrow(/still shared/)
    expect(f.fs.readFileSync(f.file)).toEqual(f.bytes)
    f.tables.length = 0
    f.api.withdrawFigureMetadataPng(f.figure, new Set([f.figure]), () => true)
    expect(f.fs.existsSync(f.file)).toBe(false)
  } finally {
    f.close()
  }
})

it('keeps the registered PNG when an exclusive crop write collides', async () => {
  const f = await metadataThumbnailWithdrawalFixture()
  try {
    await expect(
      f.api.writeCropPng(f.figure.thumbnail, Buffer.from('conflicting crop'), { flag: 'wx' })
    ).rejects.toMatchObject({ code: 'EEXIST' })
    expect(f.fs.readFileSync(f.file)).toEqual(f.bytes)
    f.api.withdrawFigureMetadataPng(f.figure, new Set([f.figure]), () => true)
    expect(f.fs.existsSync(f.file)).toBe(false)
  } finally {
    f.close()
  }
})

it('refuses metadata publication when the originally written PNG bytes are stale', async () => {
  const f = await metadataThumbnailWithdrawalFixture()
  try {
    const changed = Buffer.from(f.bytes)
    changed[0] ^= 1
    f.fs.writeFileSync(f.file, changed)
    expect(() =>
      f.api.withdrawFigureMetadataPng(f.figure, new Set([f.figure]), () => true)
    ).toThrow()
    expect(f.fs.readFileSync(f.file)).toEqual(changed)
  } finally {
    f.close()
  }
})

it('withdraws its own unchanged PNG through a real parent directory alias', async () => {
  const f = await metadataThumbnailWithdrawalFixture(true)
  try {
    expect(f.fs.realpathSync(f.file)).not.toBe(f.path.resolve(f.file))
    expect(f.fs.lstatSync(f.path.dirname(f.file)).isSymbolicLink()).toBe(false)
    f.api.withdrawFigureMetadataPng(f.figure, new Set([f.figure]), () => true)
    expect(f.fs.existsSync(f.file)).toBe(false)
  } finally {
    f.close()
  }
})

// Generated six-image plate: native parameter labels remain separate whole
// Sources; image completion never grants Source, table or paint authority.
function anonymousSixRasterPlate(mode = ''): ReturnType<typeof JSON.parse> {
  const f = anonymousCompleteRasterPlate('grid'),
    c = f.context,
    items: ReturnType<typeof JSON.parse>[] = [],
    glyphs: ReturnType<typeof JSON.parse>[] = [],
    add = (op: number, args: unknown): void => {
      c.operators.fnArray.push(op)
      c.operators.argsArray.push(args)
    },
    text = (str: string, x: number, baseline: number, size = 8): void => {
      add(OPS.beginText, null)
      add(OPS.setFont, ['F', size])
      add(OPS.setTextMatrix, [[1, 0, 0, 1, x, 500 - baseline]])
      add(OPS.showText, [
        [{ unicode: str, fontChar: str, width: str.length * 500, isInFont: true }]
      ])
      add(OPS.endText, null)
      const raw = {
        str,
        dir: 'ltr',
        width: (str.length * size) / 2,
        height: size,
        transform: [size, 0, 0, size, x, 500 - baseline],
        fontName: 'F',
        hasEOL: true,
        sourceItem: { pageNumber: 1, index: items.length, text: str }
      }
      items.push(raw)
      if (!glyphs.some((g) => g.fontChar === str))
        glyphs.push({ fontChar: str, bounds: [0, -0.1, str.length * 0.5, 0.7] })
    },
    image = (x: number, y: number): void => {
      const first = f.page.graphicsBounds.length === 0,
        shifted = first && mode === 'form-matrix',
        matrix = new Float32Array([1, 0, 0, 1, shifted ? 0.25 : 0, 0]),
        box = new Float32Array([0, 0, first && mode === 'form-clip' ? 80.25 : 79.875, 39.9375])
      add(OPS.save, null)
      add(OPS.transform, [1.75, 0, 0, 1.75, x, 500 - y - 70])
      add(OPS.paintFormXObjectBegin, [matrix, box])
      if (first && mode === 'nested-form')
        add(OPS.paintFormXObjectBegin, [
          new Float32Array([1, 0, 0, 1, 0, 0]),
          new Float32Array([0, 0, 79.875, 39.9375])
        ])
      if (first && mode === 'form-text') {
        add(OPS.beginText, null)
        add(OPS.setFont, ['F', 8])
        add(OPS.setTextMatrix, [[1, 0, 0, 1, 2, 30]])
        add(OPS.showText, [[{ unicode: 'Note', fontChar: 'Note', width: 2000, isInFont: true }]])
        add(OPS.endText, null)
        const raw = {
          str: 'Note',
          dir: 'ltr',
          width: 28,
          height: 14,
          transform: [14, 0, 0, 14, x + 3.5, 500 - y - 17.5],
          fontName: 'F',
          hasEOL: true,
          sourceItem: { pageNumber: 1, index: items.length, text: 'Note' }
        }
        items.push(raw)
        glyphs.push({ fontChar: 'Note', bounds: [0, -0.1, 2, 0.7] })
      }
      add(OPS.save, null)
      add(OPS.transform, [80, 0, 0, 40, 0, 0])
      const operationIndex = c.operators.fnArray.length
      add(OPS.paintImageXObject, ['anonymous-six-' + operationIndex, 80, 40])
      add(OPS.restore, null)
      if (first && mode === 'nested-form') add(OPS.paintFormXObjectEnd, [])
      add(OPS.paintFormXObjectEnd, [])
      add(OPS.restore, null)
      const dx = shifted ? 0.25 * 1.75 : 0
      f.page.graphicsBounds.push({
        operationIndex,
        kind: 'image',
        normalizedRect: [(x + dx) / 400, y / 500, (x + 140 + dx) / 400, (y + 70) / 500],
        imageHash: String(operationIndex % 10).repeat(64)
      })
    }
  c.operators = { fnArray: [], argsArray: [] }
  f.page.graphicsBounds = []
  delete f.page.marginRuleBounds
  c.graphicsBounds = f.page.graphicsBounds
  c.opaqueRasterImages = []
  add(OPS.setFillRGBColor, ['#000000'])
  text('Running head.', 180, mode === 'foreign-ink' ? 54.5 : 35)
  for (let i = 0; i < 6; i++) {
    const x = 40 + (i % 2) * 170,
      y = 60 + Math.floor(i / 2) * 85
    image(x, y)
    text(`(${'abcdef'[i]})`, x + 2, y + 7)
    text('q', x + 18, y + 7)
    text('r', x + 22, y + 8.5, 6)
    text('=1', x + 27, y + 7)
  }
  const title = 'Figure 1: Six recorded views.'
  text(title, 40, 325)
  f.captions = [{ page: 1, lines: [title], rect: [40, 317, 360, 325] }]
  if (mode === 'foreign-ink') glyphs[0].bounds[1] = -0.3
  if (mode === 'unexpected-body') text('Unrelated words.', 100, 180)
  if (mode === 'missing-hash') delete f.page.graphicsBounds[3].imageHash
  c.content.items = items
  c.glyphBounds = [{ fontName: 'F', glyphs }]
  f.tokens = items.map((raw) => ({
    ...tableTextToken(raw, c.viewport, 0),
    nativeLabelRect: keyedPairLabelBounds(raw, c.content.styles.F, c.viewport),
    fontAscent: 0.7,
    fontDescent: -0.1
  }))
  f.page.lines = items.map((raw) => ({
    text: raw.str,
    x: raw.transform[4],
    y: 500 - raw.transform[5] - raw.height,
    width: raw.width,
    height: raw.height,
    fontSize: raw.height
  }))
  f.figure = { caption: f.captions[0], rect: [40, 230, 180, 300], graphicsCount: 1 }
  return f
}
const sixRasterPng = (plan: ReturnType<typeof JSON.parse>, scale: number): Buffer => {
  const canvas = createCanvas(
    Math.ceil((plan.rect[2] - plan.rect[0]) * scale),
    Math.ceil((plan.rect[3] - plan.rect[1]) * scale)
  )
  const png = canvas.toBuffer('image/png')
  canvas.width = canvas.height = 0
  return png
}
it('completes all six native raster panels and whole parameter labels as pixels only', () => {
  const f = anonymousSixRasterPlate(),
    before = JSON.stringify(f)
  const packet = keyedPairModule.nativePageTextPacketInventory(f.page, f.tokens, f.context)
  expect(packet).toBeDefined()
  // The fractional original Form BBox really clips the 140x70 unit image.
  // This must not turn into an unclipped synthetic positive again.
  expect(packet.evidence.images[0].rect).toEqual([40, 60.109375, 179.78125, 130])
  expect(packet.evidence.images[0].rect[1]).toBeGreaterThan(60)
  expect(packet.evidence.images[0].rect[2]).toBeLessThan(180)
  const plan = completeRasterPlatePlan(f)
  expect(plan).toBeDefined()
  expect(plan.rect).toEqual([38, 57, 351.78125, 302])
  expect(plan.sourceItems).toBeUndefined()
  expect(plan.minimumScale).toBeUndefined()
  expect(keyedPairModule.nativeCompleteRasterPlatePixelPlanCurrent(plan, f.page)).toBe(true)
  expect(
    keyedPairModule.nativeCompleteRasterPlatePixelPngSafe(
      plan,
      sixRasterPng(plan, 4),
      plan.rect,
      f.page
    )
  ).toBe(true)
  expect(
    keyedPairModule.nativeFigurePaintCertificateData(plan, f.page, f.tokens, f.context)
  ).toBeUndefined()
  expect(keyedPairModule.nativeKeyedImagePairPixelPlanCurrent(plan, f.page)).toBe(false)
  expect(JSON.stringify(f)).toBe(before)
})
it.each([1.99, 2])(
  'refuses six-panel PNGs whose conservative footprint cannot prove scale two: %s',
  (scale) => {
    const f = anonymousSixRasterPlate(),
      plan = completeRasterPlatePlan(f)
    expect(plan).toBeDefined()
    expect(
      keyedPairModule.nativeCompleteRasterPlatePixelPngSafe(
        plan,
        sixRasterPng(plan, scale),
        plan.rect,
        f.page
      )
    ).toBe(false)
  }
)
it('keeps the six-panel minimum private and revokes borrowed or replaced native inputs', () => {
  const f = anonymousSixRasterPlate(),
    plan = completeRasterPlatePlan(f)
  expect(plan).toBeDefined()
  const png = sixRasterPng(plan, 4),
    safe = (): boolean =>
      keyedPairModule.nativeCompleteRasterPlatePixelPngSafe(plan, png, plan.rect, f.page)
  expect(Reflect.set(plan, 'minimumScale', 1.5)).toBe(false)
  expect(
    keyedPairModule.nativeCompleteRasterPlatePixelPngSafe(
      { ...plan, minimumScale: 1.5 },
      png,
      plan.rect,
      f.page
    )
  ).toBe(false)
  expect(
    keyedPairModule.nativeCompleteRasterPlatePixelPngSafe(plan, png, [...plan.rect], f.page)
  ).toBe(false)
  expect(
    keyedPairModule.nativeCompleteRasterPlatePixelPngSafe(plan, png, plan.rect, { ...f.page })
  ).toBe(false)
  const original = f.context.content.items
  f.context.content.items = [...original]
  expect(safe()).toBe(false)
  f.context.content.items = original
  expect(safe()).toBe(true)
  const bounds = f.context.glyphBounds[0].glyphs[0].bounds,
    originalBound = bounds[1]
  bounds[1] = originalBound - 1
  expect(safe()).toBe(false)
  bounds[1] = originalBound
  expect(safe()).toBe(true)
})
it.each([
  'foreign-ink',
  'unexpected-body',
  'missing-hash',
  'form-matrix',
  'form-clip',
  'nested-form',
  'form-text'
])('retains the old crop when a six-panel physical proof is incomplete: %s', (mode) => {
  const f = anonymousSixRasterPlate(mode),
    before = JSON.stringify(f)
  expect(keyedPairModule.nativePageTextPacketInventory(f.page, f.tokens, f.context)).toBeDefined()
  expect(completeRasterPlatePlan(f)).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})

it('binds a whole caption Source when line width arithmetic rounds inward', () => {
  const f = anonymousSixRasterPlate(),
    line = f.page.lines.at(-1),
    raw = f.context.content.items.at(-1)
  line.width -= Number.EPSILON * line.width
  expect(line.x + line.width).toBeLessThan(raw.transform[4] + raw.width)
  expect(keyedPairModule.nativePageTextPacketInventory(f.page, f.tokens, f.context)).toBeDefined()
  const plan = completeRasterPlatePlan(f)
  expect(plan).toBeDefined()
  expect(plan.rect).toEqual([38, 57, 351.78125, 302])
})
const { nativeNormalRasterPairPixelCurrent: normalPairWholeCurrent } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-whole-paint-scope.mjs')).href
)
const { Util: normalPairUtil } = await import('pdfjs-dist/legacy/build/pdf.mjs')
const { nativeFigureLabelBounds: normalPairLabelBounds } =
  await import('../resources/literature-pdf-figure-crop-geometry.mjs')
function anonymousNormalRasterPair(mode = 'target'): ReturnType<
  typeof anonymousCertifiedPicture
> & {
  witnesses: { left: number[]; right: number[] }
  mode: string
} {
  const f = anonymousCertifiedPicture(),
    o = f.context.operators
  o.fnArray.length =
    o.argsArray.length =
    f.context.content.items.length =
    f.tokens.length =
    f.context.glyphBounds[0].glyphs.length =
    f.page.graphicsBounds.length =
      0
  const m = mode === 'control' ? [1, 0, 0, 1, 0, 0] : [1, 0.000001, 0, 1, 0, 0]
  f.add(OPS.beginMarkedContentProps, ['Artifact', undefined])
  f.add(OPS.setFillRGBColor, ['#000000'])
  if (mode !== 'control')
    f.add(OPS.setGState, [
      [
        ['BM', mode === 'non-normal' ? 'multiply' : 'source-over'],
        ['ca', 1],
        ['CA', 1]
      ]
    ])
  f.add(OPS.paintFormXObjectBegin, [m, [40, 150, 360, 330]])
  for (const [n, x] of [55, 215].entries()) {
    const y = 90,
      w = 125,
      h = 120
    f.add(OPS.save, null)
    f.add(OPS.transform, [w, 0, 0, h, x, 400 - y - h])
    const i = o.fnArray.length
    f.add(OPS.paintImageXObject, ['anonymous' + n, 20, 20])
    f.add(OPS.restore, null)
    const points = [
      [x, 400 - y - h],
      [x + w, 400 - y - h],
      [x + w, 400 - y],
      [x, 400 - y]
    ]
    for (const p of points) {
      normalPairUtil.applyTransform(p, m)
      normalPairUtil.applyTransform(p, f.context.viewport.transform)
    }
    f.page.graphicsBounds.push({
      kind: 'image',
      operationIndex: i,
      normalizedRect: [
        Math.min(...points.map((p) => p[0])) / 400,
        Math.min(...points.map((p) => p[1])) / 400,
        Math.max(...points.map((p) => p[0])) / 400,
        Math.max(...points.map((p) => p[1])) / 400
      ],
      imageHash: String(n + 1).repeat(64)
    })
    f.text(n ? 'r' : 'q', x + 12, 130)
    const r = f.context.content.items.at(-1)
    r.transform = normalPairUtil.transform(m, r.transform)
    r.width *= Math.hypot(m[0], m[1])
    r.height *= Math.hypot(m[2], m[3])
    f.tokens[f.tokens.length - 1] = {
      ...tableTextToken(r, f.context.viewport, 0),
      fontAscent: 0.7,
      fontDescent: -0.1,
      nativeLabelRect: normalPairLabelBounds(r, f.context.content.styles.F, f.context.viewport)
    }
  }
  f.add(OPS.paintFormXObjectEnd, null)
  if (mode === 'caption-clip') {
    f.add(OPS.paintFormXObjectBegin, [
      [1, 0.5, 0, 1, 0, 0],
      [0, 100, 400, 400]
    ])
    f.add(OPS.transform, [1, -0.5, 0, 1, 0, 0])
  }
  const head = mode === 'wrong-caption' ? 'Other 1. Level, D' : 'Figure 1. Level, D'
  f.text(head, 40, 280)
  f.text('x', 126, 282)
  const script = f.context.content.items.at(-1)
  o.argsArray[o.fnArray.length - 4][1] = 6
  script.width = 3
  script.height = 6
  script.transform[0] = script.transform[3] = 6
  f.tokens[f.tokens.length - 1] = {
    ...tableTextToken(script, f.context.viewport, 0),
    fontAscent: 0.7,
    fontDescent: -0.1,
    nativeLabelRect: normalPairLabelBounds(script, f.context.content.styles.F, f.context.viewport)
  }
  f.text('(a)', 138, 280)
  f.text('and flux', 158, 280)
  f.text('(b)', 205, 280)
  f.text('coefficients.', 225, 280)
  f.text('at a fixed setting.', 40, 300)
  if (mode === 'foreign-contact') f.shape(210, 170, 5, 5)

  if (mode === 'caption-clip') f.add(OPS.paintFormXObjectEnd, null)
  f.add(OPS.endMarkedContent, null)
  if (mode === 'missing-hash') delete f.page.graphicsBounds[1].imageHash
  const caption = { page: 1, rect: [40, 270, 125, 282], lines: [head] }
  f.figure.caption = caption
  f.figure.rect = [55, 90, 180, 210]
  f.captions.splice(0, f.captions.length, caption)
  class PairWitnessViewport {
    convertToViewportPoint(x: number, y: number): number[] {
      return [x, 400 - y]
    }
  }
  const witnessViewport = Object.assign(new PairWitnessViewport(), f.context.viewport)
  f.context.runningHeadWitness = {
    sourceSha256: f.context.sourceSha256,
    currentPageNumber: 1,
    witnessPageNumber: 2,
    currentContent: f.context.content,
    witnessContent: { items: [], styles: {} },
    witnessViewport
  }
  return { ...f, witnesses: { left: [110, 145], right: [275, 145] }, mode }
}

function normalPairPlan(
  f: ReturnType<typeof anonymousNormalRasterPair>
): ReturnType<typeof nativeCertifiedFigurePixelCrop> {
  return nativeCertifiedFigurePixelCrop(
    f.page,
    f.figure,
    f.captions,
    f.tables,
    f.tokens,
    f.context,
    f.peers
  )
}
it('keeps a complete affine raster pair pixel-only while binding its original caption', () => {
  const f = anonymousNormalRasterPair(),
    before = JSON.stringify(f),
    plan = normalPairPlan(f)
  expect(plan).toBeDefined()
  expect(normalPairWholeCurrent(plan, f.page)).toBe(true)
  expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeUndefined()
  expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeUndefined()
  expect(nativeFigurePaintCertificateData(plan, f.page, f.tokens, f.context)).toBeUndefined()
  expect(plan.sourceItems).toBeUndefined()
  expect(plan.rect[0]).toBeLessThan(f.witnesses.left[0])
  expect(plan.rect[2]).toBeGreaterThan(f.witnesses.right[0])
  expect(JSON.stringify(f)).toBe(before)
  const canvas = createCanvas(
      Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
      Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
    ),
    png = canvas.toBuffer('image/png')
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  expect(keyedPairModule.nativeNormalRasterPairPixelCurrent({ ...plan }, f.page)).toBe(false)
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, [...plan.rect], f.page)).toBe(false)
  const low = createCanvas(
    Math.ceil(plan.rect[2] - plan.rect[0]),
    Math.ceil(plan.rect[3] - plan.rect[1])
  )
  expect(
    nativeCertifiedFigurePixelPngSafe(plan, low.toBuffer('image/png'), plan.rect, f.page)
  ).toBe(false)
  const old = f.context.operators.argsArray
  f.context.operators.argsArray = [...old]
  expect(keyedPairModule.nativeNormalRasterPairPixelCurrent(plan, f.page)).toBe(false)
  f.context.operators.argsArray = old
  expect(keyedPairModule.nativeNormalRasterPairPixelCurrent(plan, f.page)).toBe(true)
  const witnessViewport = f.context.runningHeadWitness.witnessViewport,
    prototype = Object.getPrototypeOf(witnessViewport)
  Object.setPrototypeOf(witnessViewport, {})
  expect(normalPairWholeCurrent(plan, f.page)).toBe(false)
  Object.setPrototypeOf(witnessViewport, prototype)
  expect(normalPairWholeCurrent(plan, f.page)).toBe(true)
  plan.rect[2]++
  expect(keyedPairModule.nativeNormalRasterPairPixelCurrent(plan, f.page)).toBe(false)
  canvas.width = canvas.height = low.width = low.height = 0
})
it.each(['foreign-contact', 'wrong-caption', 'missing-hash', 'non-normal', 'caption-clip'])(
  'refuses a complete pair when an independent physical obligation fails: %s',
  (mode) => {
    const f = anonymousNormalRasterPair(mode),
      before = JSON.stringify(f)
    // These native constructions retain their full Source/paint program when
    // normalized to the old control semantics. They do not fail a fake token.
    if (!['non-normal', 'caption-clip'].includes(mode)) {
      const c = anonymousNormalRasterPair(mode)
      const o = c.context.operators
      const state = o.fnArray.indexOf(OPS.setGState)
      o.fnArray.splice(state, 1)
      o.argsArray.splice(state, 1)
      for (const g of c.page.graphicsBounds) if (g.operationIndex > state) g.operationIndex--
      const fm = o.fnArray.indexOf(OPS.paintFormXObjectBegin)
      o.argsArray[fm][0] = [1, 0, 0, 1, 0, 0]
      for (const r of c.context.content.items.slice(0, 2)) {
        r.transform[1] = 0
        r.transform[5] -= r.transform[4] * 0.000001
        c.tokens[r.sourceItem.index] = {
          ...tableTextToken(r, c.context.viewport, 0),
          fontAscent: 0.7,
          fontDescent: -0.1,
          nativeLabelRect: normalPairLabelBounds(r, c.context.content.styles.F, c.context.viewport)
        }
      }
      expect(nativePageTextPacketInventory(c.page, c.tokens, c.context, true)).toBeDefined()
    }
    expect(normalPairPlan(f)).toBeUndefined()
    expect(JSON.stringify(f)).toBe(before)
  }
)
function anonymousCompoundCaptionPair(
  mode = 'complete'
): ReturnType<typeof anonymousCertifiedPicture> {
  const f = anonymousCertifiedPicture(),
    o = f.context.operators
  o.fnArray.length =
    o.argsArray.length =
    f.context.content.items.length =
    f.tokens.length =
    f.context.glyphBounds[0].glyphs.length =
    f.page.graphicsBounds.length =
      0
  f.add(OPS.setFillRGBColor, ['#000000'])
  f.add(OPS.setGState, [
    [
      ['BM', 'source-over'],
      ['ca', 1],
      ['CA', 1]
    ]
  ])
  f.add(OPS.paintFormXObjectBegin, [
    [1, 0.000001, 0, 1, 0, 0],
    [40, 150, 360, 330]
  ])
  for (const [n, x] of [55, 215].entries()) {
    f.add(OPS.save, null)
    f.add(OPS.transform, [125, 0, 0, 120, x, 190])
    const operationIndex = o.fnArray.length
    f.add(OPS.paintImageXObject, ['anonymous-pair-' + n, 20, 20])
    f.add(OPS.restore, null)
    f.page.graphicsBounds.push({
      kind: 'image',
      operationIndex,
      normalizedRect: [
        x / 400,
        (90 - (x + 125) * 0.000001) / 400,
        (x + 125) / 400,
        (210 - x * 0.000001) / 400
      ],
      imageHash: String(n + 1).repeat(64)
    })
  }
  f.add(OPS.paintFormXObjectEnd, null)
  f.add(OPS.save, null)
  f.add(OPS.clip, null)
  f.add(OPS.constructPath, [
    OPS.endPath,
    [[0, 0, 0, 1, 400, 0, 1, 400, 400, 1, 0, 400, 4]],
    [0, 0, 400, 400]
  ])
  f.add(OPS.beginText, null)
  f.add(OPS.setFont, ['F', 10])
  f.add(OPS.setTextMatrix, [[1, 0, 0, 1, 80, 270]])
  const space = {
    originalCharCode: 32,
    unicode: ' ',
    fontChar: ' ',
    width: 250,
    isInFont: mode === 'paints',
    isSpace: true,
    accent: null
  }
  const spaceOp = o.fnArray.length
  f.add(OPS.showText, [[space]])
  f.add(OPS.endText, null)
  if (mode === 'capsule-paint') f.shape(80, 125, 3, 3)
  f.add(OPS.restore, null)
  f.context.skippedSpaceGlyphs =
    mode === 'paints'
      ? []
      : [
          {
            operationIndex: spaceOp,
            glyphIndex: 0,
            fontName: 'F',
            fontChar: ' ',
            width: mode === 'bad-capture' ? 251 : 250
          }
        ]
  f.context.glyphBounds[0].glyphs.push({ fontChar: ' ', bounds: [0.1, 0, 0.6, 0.6] })
  f.text('Figure 1.', 40, 280)
  f.text('(', 90, 280)
  f.text('a', 95, 280)
  f.text(') Field', 100, 280)
  f.text('(', 140, 280)
  f.text(')', 150, 280)
  for (const r of f.context.content.items.slice(0, 5)) r.hasEOL = false
  f.text('z', 145, 280)
  const script = f.context.content.items.at(-1)
  o.argsArray[o.fnArray.length - 4][1] = 6
  script.width = 3
  script.height = 6
  script.transform[0] = script.transform[3] = 6
  f.tokens[f.tokens.length - 1] = {
    ...tableTextToken(script, f.context.viewport, 0),
    fontAscent: 0.7,
    fontDescent: -0.1,
    nativeLabelRect: normalPairLabelBounds(script, f.context.content.styles.F, f.context.viewport)
  }
  f.text('The first field uses a common scale.', 40, 300)
  f.text('(', 40, 320)
  f.text(mode === 'wrong-marker' ? 'c' : 'b', 45, 320)
  f.text(') Corresponding profiles', 50, 320)
  f.text('At the same fixed setting.', 40, 340)
  if (mode === 'foreign-paint') f.shape(235, 130, 4, 4)
  const caption = { page: 1, rect: [40, 270, 155, 280], lines: ['Figure 1.(a) Field()'] }
  f.page.lines.push({ text: caption.lines[0], x: 40, y: 270, width: 115, height: 10, fontSize: 10 })
  f.figure.caption = caption
  f.figure.rect = [55, 90, 180, 210]
  f.captions.splice(0, f.captions.length, caption)
  f.context.glyphBounds[0].glyphs = [
    ...new Map(f.context.glyphBounds[0].glyphs.map((g) => [g.fontChar, g])).values()
  ]
  return f
}
it('recovers a full pair from a whole fragmented caption without granting text authority', () => {
  const f = anonymousCompoundCaptionPair(),
    before = JSON.stringify(f),
    plan = normalPairPlan(f)
  expect(plan).toBeDefined()
  expect(plan.rect[2]).toBeGreaterThan(330)
  expect(normalPairWholeCurrent(plan, f.page)).toBe(true)
  expect(
    keyedPairModule.nativeNormalRasterPairPixelCrop(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.peers
    )
  ).toBeUndefined()
  expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeUndefined()
  expect(nativeFigurePaintCertificateData(plan, f.page, f.tokens, f.context)).toBeUndefined()
  expect(plan.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
  const canvas = createCanvas(
      Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
      Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
    ),
    png = canvas.toBuffer('image/png')
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  expect(normalPairWholeCurrent({ ...plan }, f.page)).toBe(false)
  const glyph = f.context.operators.argsArray[f.context.skippedSpaceGlyphs[0].operationIndex][0][0]
  glyph.isInFont = true
  expect(normalPairWholeCurrent(plan, f.page)).toBe(false)
  glyph.isInFont = false
  expect(normalPairWholeCurrent(plan, f.page)).toBe(true)
  canvas.width = canvas.height = 0
})
it.each(['paints', 'capsule-paint', 'bad-capture', 'wrong-marker', 'foreign-paint'])(
  'rejects an incomplete compound-caption physical proof: %s',
  (mode) => {
    const f = anonymousCompoundCaptionPair(mode),
      before = JSON.stringify(f)
    expect(normalPairPlan(f)).toBeUndefined()
    expect(JSON.stringify(f)).toBe(before)
  }
)
function anonymousForeignCaptionPair(
  mode = 'complete'
): ReturnType<typeof anonymousCertifiedPicture> {
  const f = anonymousCompoundCaptionPair(),
    o = f.context.operators
  f.context.content.items[5].hasEOL = false
  f.context.content.items.splice(6, 0, {
    str: '',
    dir: 'ltr',
    width: mode === 'nonzero-sentinel' ? 1 : 0,
    height: 0,
    transform: [6, 0, 0, 6, 155, 117],
    fontName: 'F',
    hasEOL: true,
    sourceItem: { pageNumber: 1, index: 6, text: '' }
  })
  f.context.content.items.forEach((r, i) => {
    r.sourceItem.index = i
  })
  f.context.opaqueRasterImages = f.page.graphicsBounds
    .filter((g) => g.kind === 'image')
    .map((g) => ({
      operationIndex: g.operationIndex,
      imageId: o.argsArray[g.operationIndex][0],
      width: 20,
      height: 20,
      kind: 2
    }))
  const source = f.context.content.items.find((r) => r.str === 'z'),
    sourceIndex = f.context.content.items.indexOf(source)
  const show = o.fnArray.findIndex(
      (op, i) => op === OPS.showText && o.argsArray[i][0][0].unicode === 'z'
    ),
    begin = show - 3,
    end = show + 1
  o.fnArray.splice(end + 1, 0, OPS.restore)
  o.argsArray.splice(end + 1, 0, null)
  o.fnArray.splice(show, 0, OPS.setGState)
  o.argsArray.splice(show, 0, [
    [
      ['BM', 'source-over'],
      ['ca', mode === 'fractional-alpha' ? 0.5 : 0],
      ['CA', 0]
    ]
  ])
  o.fnArray.splice(begin, 0, OPS.save)
  o.argsArray.splice(begin, 0, null)
  const glyph = o.argsArray[show + 2][0][0]
  glyph.unicode = 'η'
  source.str = source.sourceItem.text = 'η'
  f.tokens[sourceIndex] = {
    ...tableTextToken(source, f.context.viewport, 0),
    fontAscent: 0.7,
    fontDescent: -0.1,
    nativeLabelRect: normalPairLabelBounds(source, f.context.content.styles.F, f.context.viewport)
  }
  const opening = f.context.content.items.findIndex(
    (r, i) => r.str === '(' && f.context.content.items[i + 1]?.str === 'b'
  )
  for (const [index, text, x] of [
    [opening, 'Shown. (', 40],
    [opening + 1, 'b', 80],
    [opening + 2, ') Corresponding profiles', 85]
  ] as [number, string, number][]) {
    const r = f.context.content.items[index],
      at = o.fnArray.findIndex(
        (op, i) =>
          op === OPS.showText &&
          o.argsArray[i][0][0].unicode === r.str &&
          o.argsArray[i - 1]?.[0]?.[4] === r.transform[4] &&
          o.argsArray[i - 1]?.[0]?.[5] === r.transform[5]
      )
    const g = o.argsArray[at][0][0]
    g.unicode = g.fontChar = text
    g.width = 500 * text.length
    r.str = r.sourceItem.text = text
    r.width = 5 * text.length
    r.transform[4] = x
    o.argsArray[at - 1][0][4] = x
    if (!f.context.glyphBounds[0].glyphs.some((g) => g.fontChar === text))
      f.context.glyphBounds[0].glyphs.push({
        fontChar: text,
        bounds: [0, -0.1, 0.5 * text.length, 0.7]
      })
    f.tokens[index] = {
      ...tableTextToken(r, f.context.viewport, 0),
      fontAscent: 0.7,
      fontDescent: -0.1,
      nativeLabelRect: normalPairLabelBounds(r, f.context.content.styles.F, f.context.viewport)
    }
  }
  if (mode === 'mask-state') {
    const group = {
      matrix: null,
      bbox: [0, 0, 400, 400],
      smask: { subtype: 'Alpha', backdrop: null },
      isolated: true,
      knockout: false
    }
    f.add(OPS.beginGroup, [group])
    f.shape(145, 274, 4, 6)
    f.add(OPS.endGroup, [group])
  }
  f.add(OPS.setGState, [[['SMask', mode === 'mask-state']]])
  f.add(OPS.save, null)
  f.add(OPS.transform, [
    4,
    0,
    0,
    6,
    mode === 'foreign-contact' ? 100 : 145,
    mode === 'foreign-contact' ? 260 : 120
  ])
  const operationIndex = o.fnArray.length
  f.add(OPS.paintImageXObject, ['anonymous-caption-glyph', 4, 6])
  f.add(OPS.restore, null)
  const x = mode === 'foreign-contact' ? 100 : 145,
    y = mode === 'foreign-contact' ? 134 : 274
  f.page.graphicsBounds.push({
    kind: 'image',
    operationIndex,
    normalizedRect: [x / 400, y / 400, (x + 4) / 400, (y + 6) / 400],
    imageHash: '3'.repeat(64)
  })
  if (mode === 'zero-source-contact') {
    source.transform[4] = 100
    source.transform[5] = 270
    o.argsArray[show][0][4] = 100
    o.argsArray[show][0][5] = 270
    f.tokens[sourceIndex] = {
      ...tableTextToken(source, f.context.viewport, 0),
      fontAscent: 0.7,
      fontDescent: -0.1,
      nativeLabelRect: normalPairLabelBounds(source, f.context.content.styles.F, f.context.viewport)
    }
  }
  f.tokens = f.context.content.items
    .filter((r) => r.str.trim())
    .map((r) => ({
      ...tableTextToken(r, f.context.viewport, 0),
      fontAscent: 0.7,
      fontDescent: -0.1,
      nativeLabelRect: normalPairLabelBounds(r, f.context.content.styles.F, f.context.viewport)
    }))
  return f
}
it('keeps foreign caption pixels and invisible text outside a complete opaque pair', () => {
  const f = anonymousForeignCaptionPair(),
    before = JSON.stringify(f),
    plan = normalPairPlan(f)
  expect(plan).toBeDefined()
  expect(plan.rect[2]).toBeGreaterThan(330)
  expect(normalPairWholeCurrent(plan, f.page)).toBe(true)
  expect(
    keyedPairModule.nativeCompoundCaptionRasterPairPixelCrop(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.peers
    )
  ).toBeUndefined()
  expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeUndefined()
  expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeUndefined()
  expect(nativeFigurePaintCertificateData(plan, f.page, f.tokens, f.context)).toBeUndefined()
  expect(plan.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
  const canvas = createCanvas(
      Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
      Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
    ),
    png = canvas.toBuffer('image/png')
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  expect(normalPairWholeCurrent({ ...plan }, f.page)).toBe(false)
  const metadata = f.context.opaqueRasterImages
  f.context.opaqueRasterImages = [...metadata]
  expect(normalPairWholeCurrent(plan, f.page)).toBe(false)
  f.context.opaqueRasterImages = metadata
  expect(normalPairWholeCurrent(plan, f.page)).toBe(true)
  const state = oAlphaState(f)
  state[1] = 1
  expect(normalPairWholeCurrent(plan, f.page)).toBe(false)
  state[1] = 0
  expect(normalPairWholeCurrent(plan, f.page)).toBe(true)
  canvas.width = canvas.height = 0
})
function oAlphaState(
  f: ReturnType<typeof anonymousCertifiedPicture>
): ReturnType<typeof JSON.parse> {
  return f.context.operators.argsArray
    .find(
      (a, i) =>
        f.context.operators.fnArray[i] === OPS.setGState &&
        a[0].some((e) => e[0] === 'ca' && e[1] === 0)
    )[0]
    .find((e) => e[0] === 'ca')
}
it.each([
  'mask-state',
  'fractional-alpha',
  'foreign-contact',
  'zero-source-contact',
  'nonzero-sentinel'
])('declines an unproved foreign-transparency pixel pair: %s', (mode) => {
  const f = anonymousForeignCaptionPair(mode),
    before = JSON.stringify(f)
  expect(normalPairPlan(f)).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})
function anonymousProjectedCaptionPair(
  mode = 'complete'
): ReturnType<typeof anonymousCertifiedPicture> {
  const f = anonymousForeignCaptionPair(mode === 'foreign-contact' ? mode : 'complete'),
    o = f.context.operators
  const target =
    o.fnArray.findIndex(
      (op, i) =>
        op === OPS.showText &&
        o.argsArray[i][0][0].unicode === '(' &&
        o.argsArray[i - 1]?.[0]?.[4] === 140
    ) - 3
  f.text('q', 125, 283)
  const script = f.context.content.items.pop()!
  script.width = 3
  script.height = 6
  script.transform[0] = script.transform[3] = 6
  script.hasEOL = false
  const ops = o.fnArray.splice(-5),
    args = o.argsArray.splice(-5)
  args[1][1] = 6
  o.fnArray.splice(target, 0, ...ops)
  o.argsArray.splice(target, 0, ...args)
  for (const g of f.page.graphicsBounds) if (g.operationIndex >= target) g.operationIndex += 5
  f.context.content.items.splice(4, 0, script)
  const lead = f.context.content.items[0]
  f.context.content.items.unshift({
    ...lead,
    str: '',
    width: 0,
    height: 0,
    transform: [...lead.transform],
    hasEOL: true,
    sourceItem: { ...lead.sourceItem, text: '' }
  })
  const body = f.context.content.items.find(
    (r) => r.str === 'The first field uses a common scale.'
  )!
  body.transform[4] = 30
  const bodyShow = o.fnArray.findIndex(
    (op, i) => op === OPS.showText && o.argsArray[i][0][0].unicode === body.str
  )
  o.argsArray[bodyShow - 1][0][4] = 30
  if (mode === 'wrong-boundary-owner') {
    body.transform[4] = 60
    o.argsArray[bodyShow - 1][0][4] = 60
    const order = o.fnArray.map((_, i) => i),
      segment = order.splice(bodyShow - 3, 5)
    order.splice(2, 0, ...segment)
    const fn = [...o.fnArray],
      args = [...o.argsArray],
      positions = new Map(order.map((old, i) => [old, i]))
    o.fnArray.splice(0, o.fnArray.length, ...order.map((i) => fn[i]))
    o.argsArray.splice(0, o.argsArray.length, ...order.map((i) => args[i]))
    for (const g of f.page.graphicsBounds) g.operationIndex = positions.get(g.operationIndex)!
    for (const g of f.context.opaqueRasterImages)
      g.operationIndex = positions.get(g.operationIndex)!
    for (const g of f.context.skippedSpaceGlyphs)
      g.operationIndex = positions.get(g.operationIndex)!
    f.context.content.items.splice(f.context.content.items.indexOf(body), 1)
    f.context.content.items.unshift(
      {
        ...body,
        str: '',
        width: 0,
        height: 0,
        transform: [...body.transform],
        hasEOL: true,
        sourceItem: { ...body.sourceItem, text: '' }
      },
      body
    )
  }
  f.context.content.items.forEach((r, i) => {
    r.sourceItem.index = i
  })
  f.tokens = f.context.content.items
    .filter((r) => r.str.trim())
    .map((r) => ({
      ...tableTextToken(r, f.context.viewport, 0),
      fontAscent: 0.7,
      fontDescent: -0.1,
      nativeLabelRect: normalPairLabelBounds(r, f.context.content.styles.F, f.context.viewport)
    }))
  f.page.lines = [
    { text: 'Figure 1.(a) Field', x: 40, y: 270, width: 95, height: 10, fontSize: 10 },
    { text: 'q', x: 125, y: 277, width: 3, height: 6, fontSize: 6 },
    { text: '()', x: 140, y: 270, width: 15, height: 10, fontSize: 10 },
    { text: 'η', x: 145, y: 274, width: 3, height: 6, fontSize: 6 },
    {
      text: 'The first field uses a common scale.',
      x: 30,
      y: 290,
      width: 180,
      height: 10,
      fontSize: 10
    },
    { text: 'Shown. (', x: 40, y: 310, width: 40, height: 10, fontSize: 10 },
    { text: 'b', x: 80, y: 310, width: 5, height: 10, fontSize: 10 },
    { text: ') Corresponding profiles', x: 85, y: 310, width: 120, height: 10, fontSize: 10 },
    { text: 'At the same fixed setting.', x: 40, y: 330, width: 130, height: 10, fontSize: 10 }
  ]
  f.figure.caption.lines = ['Figure 1.(a) Field ()']
  f.figure.rect = [35, 279.8, 130, 300]
  f.shape(40, 280.2, 45, 0.5, OPS.eoFill)
  if (mode === 'foreign-path') f.shape(100, 280.2, 10, 0.5, OPS.eoFill)
  if (mode === 'wrong-boundary-owner') {
    const line = f.page.lines.splice(4, 1)[0]
    line.x = 60
    f.page.lines.unshift(line)
    f.figure.rect = [50, 279.8, 130, 301]
  }
  if (mode === 'projection') f.page.lines[1].text = 'other'
  if (mode === 'outside-caption') f.figure.rect = [5, 220, 20, 240]
  if (mode === 'missing-script')
    f.context.glyphBounds[0].glyphs = f.context.glyphBounds[0].glyphs.filter(
      (g) => g.fontChar !== 'q'
    )
  return f
}
it('replaces caption pixels with a complete pair using the original script projection', () => {
  const f = anonymousProjectedCaptionPair(),
    before = JSON.stringify(f),
    plan = normalPairPlan(f)
  expect(plan).toBeDefined()
  expect(plan.rect[1]).toBeLessThan(100)
  expect(plan.rect[2]).toBeGreaterThan(330)
  expect(normalPairWholeCurrent(plan, f.page)).toBe(true)
  expect(normalPairWholeCurrent({ ...plan }, f.page)).toBe(false)
  expect(nativeCertifiedFigurePixelPngSafe(plan, captionGapPng(plan), plan.rect, f.page)).toBe(true)
  expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeUndefined()
  expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeUndefined()
  expect(plan.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
  const text = f.page.lines[0].text
  f.page.lines[0].text += ' changed'
  expect(normalPairWholeCurrent(plan, f.page)).toBe(false)
  f.page.lines[0].text = text
  expect(normalPairWholeCurrent(plan, f.page)).toBe(true)
})
it.each([
  'projection',
  'outside-caption',
  'foreign-contact',
  'missing-script',
  'foreign-path',
  'wrong-boundary-owner'
])('keeps a projected-caption pair closed without %s proof', (mode) => {
  const f = anonymousProjectedCaptionPair(mode),
    before = JSON.stringify(f)
  expect(normalPairPlan(f)).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})

// One generated complete raster pair carries four native markers and only
// original cursor records; the micro sign belongs to distant ordinary prose.
function anonymousFourMarkerPair(mode = 'micro'): ReturnType<typeof JSON.parse> {
  const f = anonymousCertifiedPicture([], undefined, false, false, [])
  for (const a of [
    f.context.operators.fnArray,
    f.context.operators.argsArray,
    f.context.content.items,
    f.tokens,
    f.context.glyphBounds[0].glyphs,
    f.page.graphicsBounds
  ])
    a.length = 0
  f.add(OPS.setFillRGBColor, ['#000000'])
  const glyphs = (s: string): unknown[] =>
    Array.from(s).map((c) => ({
      unicode: c,
      fontChar: c,
      width: 500,
      isInFont: true,
      originalCharCode: c.codePointAt(0)
    }))
  const marker = (s: string, x: number, y: number, boundary: boolean): void => {
    if (boundary)
      f.context.content.items.push({
        str: '',
        dir: 'ltr',
        width: 0,
        height: 0,
        transform: [10, 0, 0, 10, x, 400 - y],
        fontName: 'F',
        hasEOL: true,
        sourceItem: { pageNumber: 1, index: f.context.content.items.length, text: '' }
      })
    f.text(s, x, y)
    const i = f.context.operators.fnArray.lastIndexOf(OPS.showText)
    f.context.operators.argsArray[i] = [glyphs(s)]
    for (const c of s)
      if (!f.context.glyphBounds[0].glyphs.some((g) => g.fontChar === c))
        f.context.glyphBounds[0].glyphs.push({ fontChar: c, bounds: [0, -0.1, 0.5, 0.7] })
  }
  for (const [n, y] of [70, 165].entries()) {
    f.add(OPS.save, null)
    f.add(OPS.transform, [310, 0, 0, n ? 90 : 80, 40, 400 - y - (n ? 90 : 80)])
    f.add(OPS.setGState, [[['SMask', mode === 'active-mask' ? true : false]]])
    const i = f.context.operators.fnArray.length
    f.add(OPS.paintImageXObject, ['generated' + n, 40, 20])
    f.add(OPS.restore, null)
    f.page.graphicsBounds.push({
      kind: 'image',
      operationIndex: i,
      normalizedRect: [0.1, y / 400, 0.875, (y + (n ? 90 : 80)) / 400],
      imageHash: String(n + 1).repeat(64)
    })
    if (!n) {
      marker('a)', 75, 100, true)
      marker('b)', 215, 130, false)
    }
  }
  marker('c)d)', 75, 230, true)
  const c = f.context.content.items.at(-1),
    i = f.context.operators.fnArray.lastIndexOf(OPS.showText)
  f.context.operators.argsArray[i] = [[...glyphs('c)'), -13000, ...glyphs('d)')]]
  f.context.content.items.pop()
  f.tokens.pop()
  for (const [str, x, width, height] of [
    ['c)', 75, 10, 10],
    [' ', 85, 130, mode === 'bad-cursor' ? 1 : 0],
    ['d)', 215, 10, 10]
  ] as const) {
    const r = {
      ...c,
      str,
      width,
      height,
      transform: [10, 0, 0, 10, x, 170],
      hasEOL: false,
      sourceItem: { pageNumber: 1, index: f.context.content.items.length, text: str }
    }
    f.context.content.items.push(r)
    if (str.trim())
      f.tokens.push({
        ...tableTextToken(r, f.context.viewport, 0),
        fontAscent: 0.7,
        fontDescent: -0.1,
        nativeLabelRect: normalPairLabelBounds(r, f.context.content.styles.F, f.context.viewport)
      })
  }
  f.text('Figure', 40, 300)
  f.context.content.items.at(-1).hasEOL = false
  f.text(' 3. Complete paired observations.', 70, 300)
  f.text('All measurements retain their original labels.', 40, 315)
  f.text(mode === 'identity' ? 'x' : 'µ', 40, 370)
  if (mode !== 'identity') {
    const r = f.context.content.items.at(-1)
    r.str = mode === 'unsupported-pair' ? 'α' : 'μ'
    r.sourceItem.text = r.str
    f.tokens.at(-1).text = r.str
    f.tokens.at(-1).sourceItem = r.sourceItem
    const g =
      f.context.operators.argsArray[f.context.operators.fnArray.lastIndexOf(OPS.showText)][0][0]
    g.originalCharCode = 181
  }
  if (mode === 'foreign-contact') f.text('Foreign', 60, 90)
  const cg = awaitedFourMarkerCaptionModule
  f.page.lines = fourMarkerReading.normalizePageLineOrder({
    width: 400,
    lines: cg.projectPdfTextLines(f.context.content, f.context.viewport)
  })
  const rows = cg.groupPageLines(f.page).filter((r) => r.y >= 280 && r.y < 330),
    caption = {
      page: 1,
      lines: rows.map((r) => r.text),
      rect: [
        Math.min(...rows.map((r) => r.x)),
        Math.min(...rows.map((r) => r.y)),
        Math.max(...rows.map((r) => r.right)),
        Math.max(...rows.map((r) => r.bottom))
      ]
    }
  f.figure.caption = caption
  f.figure.rect = [40, 165, 350, 255]
  f.captions = [caption]
  f.peers = [f.figure]
  if (mode !== 'identity') {
    const defaultContent = structuredClone(f.context.content)
    defaultContent.items.forEach((r) => {
      delete r.sourceItem
    })
    const rawContent = structuredClone(defaultContent)
    rawContent.items.find((r) => r.str === (mode === 'unsupported-pair' ? 'α' : 'μ')).str = 'µ'
    const viewport = { ...f.context.viewport }
    delete viewport.convertToViewportPoint
    f.context.dualApiEvidence = {
      schema: 'same-pdfjs-page-dual-api-capture-v1',
      pdfjsVersion: nativePdfVersion,
      apiDefaultOptions: {},
      apiRawOptions: { disableNormalization: true },
      pageNumber: 1,
      sourceSha256: f.context.sourceSha256,
      defaultContent,
      rawContent,
      renderContext: {
        pageNumber: 1,
        sourceSha256: f.context.sourceSha256,
        viewport,
        operators: structuredClone(f.context.operators),
        content: structuredClone(defaultContent),
        glyphBounds: structuredClone(f.context.glyphBounds),
        graphicsBounds: structuredClone(f.page.graphicsBounds)
      }
    }
  }
  return f
}
const awaitedFourMarkerCaptionModule = await import('../resources/literature-pdf-caption-group.mjs')
const fourMarkerReading = await import('../resources/literature-pdf-reading-order.mjs')
const fourMarkerPlan = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  nativeCertifiedFigurePixelCrop(
    f.page,
    f.figure,
    f.captions,
    f.tables,
    f.tokens,
    f.context,
    f.peers
  )
it.each(['micro', 'identity'])(
  'retains all four native markers and both original rasters: %s',
  (mode) => {
    const f = anonymousFourMarkerPair(mode),
      before = JSON.stringify(f),
      plan = fourMarkerPlan(f)
    expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeDefined()
    expect(plan).toBeDefined()
    expect(plan.rect).toEqual([40 - 2 / 1.5, 70 - 2 / 1.5, 350 + 2 / 1.5, 255 + 2 / 1.5])
    expect(plan.sourceItems).toBeUndefined()
    expect(nativeFigurePaintCertificateData(plan, f.page, f.tokens, f.context)).toBeUndefined()
    if (mode === 'micro')
      expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeUndefined()
    expect(JSON.stringify(f)).toBe(before)
    if (mode !== 'micro') return
    const canvas = createCanvas(
        Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
        Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
      ),
      png = canvas.toBuffer('image/png')
    expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
    expect(nativeCertifiedFigurePixelPngSafe({ ...plan }, png, plan.rect, f.page)).toBe(false)
    const items = f.context.content.items
    f.context.content.items = [...items]
    expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
    f.context.content.items = items
    expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
    expect(nativeCertifiedFigurePixelPngSafe(plan, new Uint8Array(1), plan.rect, f.page)).toBe(
      false
    )
    canvas.width = canvas.height = 0
  }
)
it.each(['active-mask', 'bad-cursor', 'unsupported-pair', 'foreign-contact'])(
  'declines an unclosed four-marker pixel domain: %s',
  (mode) => {
    const f = anonymousFourMarkerPair(mode),
      before = JSON.stringify(f)
    expect(fourMarkerPlan(f)).toBeUndefined()
    expect(JSON.stringify(f)).toBe(before)
  }
)

const { nativeProofTailFigurePixelPlanCurrent } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-whole-paint-scope.mjs')).href
)
const proofTailFixture = (mode = ''): ReturnType<typeof JSON.parse> => {
  const f = anonymousCertifiedPicture([], undefined, false, false, [])
  for (const a of [
    f.context.operators.fnArray,
    f.context.operators.argsArray,
    f.context.content.items,
    f.context.glyphBounds[0].glyphs,
    f.page.graphicsBounds,
    f.tokens
  ])
    a.length = 0
  f.context.content.styles.B = { ascent: 0, descent: 0, vertical: false }
  f.context.glyphBounds.push({ fontName: 'B', glyphs: [] })
  f.add(mode === 'white-box' ? OPS.setStrokeRGBColor : OPS.setFillRGBColor, [
    mode === 'white-box' ? '#ffffff' : '#000000'
  ])
  const body = [
    'The response obeys a clear rule under the given stable model assumptions.',
    'Each part retains its original values throughout the complete argument.',
    'This proves the relation. Figure 1 illustrates the complete comparison.'
  ]
  for (const [i, s] of body.entries()) {
    const at = f.context.operators.fnArray.length
    f.text(s, 25, 30 + i * 14)
    f.context.operators.argsArray[at + 1][0] = 'B'
    f.context.content.items.at(-1).fontName = 'B'
    f.context.glyphBounds[1].glyphs.push(f.context.glyphBounds[0].glyphs.pop())
  }
  // Keep the original coarse Source and exact glyph advance distinct.
  f.context.content.items[0].width += 0.08
  f.tokens[0].rect[2] += 0.08
  f.tokens[0].nativeLabelRect[2] += 0.08
  const last = f.context.operators.fnArray.length - 1
  for (let i = last; i >= 1; i--) {
    if (
      (f.context.operators.fnArray[i] === OPS.beginText && i !== 1) ||
      (f.context.operators.fnArray[i] === OPS.endText && i !== last)
    ) {
      f.context.operators.fnArray.splice(i, 1)
      f.context.operators.argsArray.splice(i, 1)
    }
  }
  const segment = (x: number, y: number, dx: number, dy: number): void => {
    f.add(OPS.save, [])
    f.add(OPS.transform, [1, 0, 0, 1, x, 400 - y])
    f.add(OPS.setDash, [[], 0])
    f.add(OPS.setLineCap, [0])
    f.add(OPS.setLineWidth, [0.4])
    const at = f.context.operators.fnArray.length
    f.add(OPS.constructPath, [
      OPS.stroke,
      [[0, 0, 0, 1, dx, dy]],
      [Math.min(0, dx), Math.min(0, dy), Math.max(0, dx), Math.max(0, dy)]
    ])
    f.page.graphicsBounds.push({
      kind: 'path',
      operationIndex: at,
      normalizedRect: [
        (x - 0.2) / 400,
        (y - Math.max(dy, 0) - 0.2) / 400,
        (x + Math.max(dx, 0) + 0.2) / 400,
        (y - Math.min(dy, 0) + 0.2) / 400
      ]
    })
    f.add(OPS.restore, [])
  }
  segment(380, 58, 0, 8)
  segment(380.2, 50.2, 7.6, 0)
  segment(380.2, 57.8, mode === 'broken-side' ? 3 : 7.6, 0)
  segment(388, 58, 0, 8)
  f.add(OPS.save, [])
  f.add(OPS.paintFormXObjectBegin, [null, [20, 140, 390, 270]])
  f.add(OPS.setFillRGBColor, ['#ffffff'])
  f.shape(20, 130, 370, 130)
  f.add(OPS.setFillRGBColor, ['#000000'])
  f.shape(35, 150, 130, 40)
  f.shape(215, 150, 130, 40)
  f.shape(75, 220, 230, 2)
  f.text('First panel', 45, 140)
  f.text('Second panel', 225, 140)
  f.text('Common key', 75, 245)
  f.add(OPS.paintFormXObjectEnd, [])
  f.add(OPS.restore, [])
  f.text('Figure 1. Complete generated panels.', 30, 300)
  f.figure = {
    reason: 'native-vector-bar-chart',
    graphicsCount: 8,
    rect: [20, 56, 395, 265],
    caption: { page: 1, rect: [30, 290, 300, 302], lines: ['Figure 1. Complete generated panels.'] }
  }
  f.captions = [f.figure.caption]
  f.peers = [f.figure]
  if (mode === 'source-literal') f.context.content.items[1].str += ' changed'
  if (mode === 'foreign-contact') f.shape(100, 180, 5, 5)
  return f
}
const proofTailPlan = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  nativeCertifiedFigurePixelCrop(
    f.page,
    f.figure,
    f.captions,
    f.tables,
    f.tokens,
    f.context,
    f.peers,
    f.figure.rect
  )
it('keeps a complete proof-tail outside a closed drawing using pixels alone', () => {
  const f = proofTailFixture(),
    before = JSON.stringify(f),
    plan = proofTailPlan(f)
  const paint = createNativeFigurePaintCertificate(f.page, f.tokens, f.context)
  expect(nativeFigurePaintCertificateData(paint, f.page, f.tokens, f.context)).toBeDefined()
  expect(plan).toBeDefined()
  expect(plan.rect[1]).toBeGreaterThan(100)
  expect(plan.sourceItems).toBeUndefined()
  expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeUndefined()
  expect(nativeProofTailFigurePixelPlanCurrent(plan, f.page)).toBe(true)
  expect(nativeProofTailFigurePixelPlanCurrent({ ...plan }, f.page)).toBe(false)
  const canvas = createCanvas(
      Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
      Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
    ),
    png = canvas.toBuffer('image/png')
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  expect(nativeCertifiedFigurePixelPngSafe(plan, Buffer.alloc(0), plan.rect, f.page)).toBe(false)
  expect(JSON.stringify(f)).toBe(before)
  const args = f.context.operators.argsArray
  f.context.operators.argsArray = structuredClone(args)
  expect(nativeProofTailFigurePixelPlanCurrent(plan, f.page)).toBe(false)
  expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  f.context.operators.argsArray = args
  expect(nativeProofTailFigurePixelPlanCurrent(plan, f.page)).toBe(true)
  canvas.width = canvas.height = 0
})
it.each(['broken-side', 'source-literal', 'foreign-contact', 'white-box'])(
  'declines incomplete proof-tail pixels: %s',
  (mode) => {
    const f = proofTailFixture(mode)
    if (mode === 'white-box') {
      const handle = createNativeFigurePaintCertificate(f.page, f.tokens, f.context)
      const data = nativeFigurePaintCertificateData(handle, f.page, f.tokens, f.context)
      expect(data).toBeDefined()
      const form = f.context.operators.fnArray.indexOf(OPS.paintFormXObjectBegin)
      const strokes = data.pieces.filter((p) => p.kind === 'path' && p.operationIndex < form)
      expect(strokes).toHaveLength(4)
      expect(strokes.every((p) => p.visiblePaintPoints.length === 0)).toBe(true)
    }
    expect(proofTailPlan(f)).toBeUndefined()
  }
)
