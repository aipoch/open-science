import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)

// A neighboring numbered code box belongs to an independently sourced prose
// column. Its complete frame, not a text/font heuristic, owns its border paint.
function neighboringCodeColumn(): ReturnType<typeof JSON.parse> {
  const width = 600,
    height = 800
  const operators: { fnArray: number[]; argsArray: unknown[] } = { fnArray: [], argsArray: [] }
  const graphicsBounds: ReturnType<typeof JSON.parse>[] = [],
    lines: ReturnType<typeof JSON.parse>[] = [],
    items: ReturnType<typeof JSON.parse>[] = []
  const emit = (op: number, args: unknown): number => {
    const index = operators.fnArray.length
    operators.fnArray.push(op)
    operators.argsArray.push(args)
    return index
  }
  const paint = (points: number[][], stroke = false): void => {
    const path = points.flatMap((p, i) => [i ? 1 : 0, p[0], height - p[1]])
    if (!stroke) path.push(4)
    const operationIndex = emit(OPS.constructPath, [
      stroke ? OPS.stroke : OPS.fill,
      [new Float32Array(path)],
      null
    ])
    const pad = stroke ? 0.5 : 0
    graphicsBounds.push({
      kind: 'path',
      operationIndex,
      normalizedRect: [
        Math.min(...points.map((p) => p[0])) - pad,
        Math.min(...points.map((p) => p[1])) - pad,
        Math.max(...points.map((p) => p[0])) + pad,
        Math.max(...points.map((p) => p[1])) + pad
      ].map((v, i) => v / (i % 2 ? height : width))
    })
  }
  const rect = (r: number[]): void =>
    paint([
      [r[0], r[1]],
      [r[2], r[1]],
      [r[2], r[3]],
      [r[0], r[3]]
    ])
  const text = (
    str: string,
    x: number,
    y: number,
    w: number,
    h: number,
    fontName = 'body',
    line = true
  ): void => {
    items.push({
      str,
      dir: 'ltr',
      width: w,
      height: h,
      transform: [h, 0, 0, h, x, height - y - h],
      fontName,
      sourceItem: { pageNumber: 1, index: items.length, text: str }
    })
    if (line) lines.push({ text: str, x, y, width: w, height: h, fontSize: h })
  }
  rect([50, 100, 280, 280])
  for (let i = 0; i < 8; i++) rect([80 + i * 22, 150 + i * 9, 90 + i * 22, 250])
  for (let i = 0; i < 4; i++) text(String(i * 10), 55, 150 + i * 25, 15, 10)
  for (let i = 0; i < 3; i++) text('Group ' + i, 95 + i * 55, 260, 35, 10)
  const caption = { page: 1, lines: ['Figure 1: Anonymous comparison.'], rect: [50, 290, 275, 300] }
  text(caption.lines[0], 50, 290, 225, 10)
  for (const y of [190, 205, 280, 295, 310])
    text('Ordinary explanation in the independent prose column.', 288, y, 204, 10)
  emit(OPS.setLineWidth, [1])
  for (const x of [290, 490])
    for (const y of [230, 250])
      paint(
        [
          [x, y],
          [x, y + 20]
        ],
        true
      )
  for (const y of [230, 270])
    for (const x of [290, 390])
      paint(
        [
          [x, y],
          [x + 100, y]
        ],
        true
      )
  for (let i = 0; i < 4; i++) {
    text(String(i + 1), 284, 233 + i * 9, 3, 6, 'numbers', false)
    text('value := input + offset', 292, 232 + i * 9, 180, 7, 'code', false)
  }
  const page = { pageNumber: 1, width, height, graphicsBounds, lines, invalidGraphicsBounds: 0 }
  const context = {
    operators,
    graphicsBounds: structuredClone(graphicsBounds),
    content: {
      items,
      styles: {
        body: { fontFamily: 'serif' },
        numbers: { fontFamily: 'serif' },
        code: { fontFamily: 'monospace' }
      }
    },
    viewport: {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x: number, y: number) => [x, height - y]
    }
  }
  return { page, caption, context }
}
function neighboringCodeResult(
  f: ReturnType<typeof JSON.parse>,
  context = true
): ReturnType<typeof JSON.parse> {
  return associateFigures(f.page, [f.caption], [], [], [], [], context ? f.context : undefined)[0]
}
it('excludes only the complete neighboring code frame owned by surrounding prose', () => {
  const f = neighboringCodeColumn(),
    snapshot = JSON.stringify(f)
  expect(neighboringCodeResult(f, false).rect[2]).toBeGreaterThan(280)
  expect(neighboringCodeResult(f).rect).toEqual([50, 100, 280, 280])
  expect(JSON.stringify(f)).toBe(snapshot)
})
it('retains native indentation inside the independently owned numbered frame', () => {
  const f = neighboringCodeColumn()
  for (const item of f.context.content.items.slice(-6)) {
    if (item.fontName === 'code') item.transform[4] += 7
  }
  expect(neighboringCodeResult(f).rect).toEqual([50, 100, 280, 280])
})
it.each([
  'boxed legend',
  'only upper prose',
  'missing frame side',
  'unknown clip',
  'transparent stroke',
  'unknown cap',
  'gutter ink',
  'nonmonospace',
  'source alias',
  'unknown plural carrier',
  'cyclic metadata',
  'unknown paint',
  'duplicate paint carrier',
  'different prose fonts',
  'invalid page',
  'unowned frame text'
])('preserves the legacy crop without unique foreign-frame proof: %s', (kind) => {
  const f = neighboringCodeColumn()
  if (kind === 'boxed legend')
    f.page.lines = f.page.lines.filter((l: ReturnType<typeof JSON.parse>) => l.x !== 288)
  if (kind === 'only upper prose')
    f.page.lines = f.page.lines.filter(
      (l: ReturnType<typeof JSON.parse>) => l.x !== 288 || l.y < 230
    )
  if (kind === 'missing frame side') f.context.operators.argsArray[10] = [OPS.endPath, [], null]
  if (kind === 'unknown clip') {
    f.context.operators.fnArray[9] = OPS.clip
    f.context.operators.argsArray[9] = []
  }
  if (kind === 'transparent stroke') {
    f.context.operators.fnArray[9] = OPS.setGState
    f.context.operators.argsArray[9] = [[['CA', 0]]]
  }
  if (kind === 'unknown cap') {
    f.context.operators.fnArray[9] = OPS.setLineCap
    f.context.operators.argsArray[9] = [9]
  }
  if (kind === 'gutter ink')
    f.context.content.items.push({
      str: 'bridge',
      height: 10,
      width: 20,
      transform: [10, 0, 0, 10, 275, 600],
      fontName: 'body'
    })
  if (kind === 'nonmonospace') f.context.content.styles.code.fontFamily = 'serif'
  if (kind === 'source alias')
    f.context.content.items.push({
      str: '',
      sourceToken: { sourceSegment: { pageNumber: 1, index: 8, start: 0, end: 1 } }
    })
  if (kind === 'unknown plural carrier')
    f.context.content.items[8].sourceTokens = [
      { sourceItem: { pageNumber: 2, index: 0, text: 'foreign' } }
    ]
  if (kind === 'cyclic metadata') f.context.content.items[8].metadata = f.context.content.items[8]
  if (kind === 'unknown paint') {
    f.context.operators.fnArray.push(OPS.shadingFill)
    f.context.operators.argsArray.push(['unknown'])
  }
  if (kind === 'duplicate paint carrier')
    f.context.graphicsBounds.push(structuredClone(f.context.graphicsBounds[10]))
  if (kind === 'different prose fonts') f.context.content.items[10].fontName = 'other'
  if (kind === 'invalid page') f.page.invalidGraphicsBounds = 1
  if (kind === 'unowned frame text')
    f.context.content.items.push({
      str: 'annotation',
      dir: 'ltr',
      height: 5,
      width: 20,
      transform: [5, 0, 0, 5, 300, 560],
      fontName: 'code'
    })
  expect(neighboringCodeResult(f)).toEqual(neighboringCodeResult(f, false))
})
const {
  nativeCaptionedAlignedRasterPair,
  nativeCaptionedRaster,
  nativeCaptionedVectorHeatmap,
  nativeCaptionedWorkflowPanel,
  nativeCaptionedVectorDiagram,
  nativeCaptionedConnectedNodes,
  nativeCaptionedVectorGrid,
  nativeCaptionedVectorTableGrid,
  nativeCaptionedVectorBarChart,
  nativeCaptionedFramedRaster,
  nativeCaptionedFramedRasterTextPanel,
  nativeCaptionedRasterArrayFragment,
  nativeCaptionedRasterQuad,
  nativeCaptionedRasterHorizontalArray,
  nativeCaptionedRasterSideBySide,
  nativeCaptionedRasterCompositeGrid,
  nativeCaptionedRasterFullWidth,
  nativeCaptionedRasterDualPanelGrid,
  nativeCaptionedRasterModerateGap,
  nativeCaptionedTextIllustration,
  nativeLetteredRasterArray,
  nativeRasterGrid
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-captioned-illustration.mjs')).href
)

// Short anonymous labels retain only the enclosure/connector proof.
// No original page, model output, paper identifier or label is needed.
function connectedNodePacket(): ReturnType<typeof JSON.parse> {
  const width = 600,
    height = 800,
    font = 8
  const operators: { fnArray: number[]; argsArray: unknown[] } = { fnArray: [], argsArray: [] }
  const emit = (code: number, args: unknown): void => {
    operators.fnArray.push(code)
    operators.argsArray.push(args)
  }
  const viewport = {
    width,
    height,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, height],
    convertToViewportPoint: (x: number, y: number) => [x, height - y]
  }
  const content: ReturnType<typeof JSON.parse> = {
    items: [],
    styles: { font: { ascent: 0.8, descent: -0.2, vertical: false } }
  }
  const page: ReturnType<typeof JSON.parse> = {
    pageNumber: 1,
    width,
    height,
    renderRotation: 0,
    invalidGraphicsBounds: 0,
    graphicsBounds: [],
    lines: []
  }
  const text = (str: string, x: number, y: number): void => {
    const glyphs = Array.from(str).map((unicode) => ({
      unicode,
      fontChar: unicode,
      originalCharCode: unicode.charCodeAt(0),
      width: 500,
      isSpace: unicode === ' ',
      isInFont: true
    }))
    emit(OPS.setFillRGBColor, ['#000000'])
    emit(OPS.beginText, null)
    emit(OPS.setFont, ['font', font])
    emit(OPS.moveText, [x, height - y - font])
    emit(OPS.showText, [glyphs])
    emit(OPS.endText, null)
    content.items.push({
      str,
      dir: 'ltr',
      transform: [font, 0, 0, font, x, height - y - font],
      width: str.length * 4,
      height: font,
      fontName: 'font'
    })
    page.lines.push({ text: str, x, y, width: str.length * 4, height: font, fontSize: font })
  }
  const path = (program: number[], paint: number, bounds: number[], rect: number[]): void => {
    const operationIndex = operators.fnArray.length
    emit(OPS.constructPath, [paint, [program], bounds])
    const normalizedRect = rect.map(
      (v, n) =>
        ((n < 2 ? Math.floor : Math.ceil)((v * 256) / (n % 2 ? height : width)) + (n < 2 ? 0 : 1)) /
        256
    )
    page.graphicsBounds.push({ kind: 'path', operationIndex, normalizedRect })
  }
  const nodes = [
    [240, 80, 360, 96],
    [140, 160, 240, 176],
    [260, 320, 340, 336],
    [390, 145, 490, 161],
    [60, 240, 140, 256],
    [160, 240, 240, 256],
    [260, 440, 340, 456],
    [420, 240, 540, 256]
  ]
  const parents = [0, 0, 0, 1, 1, 2, 3]
  for (const [n, r] of nodes.entries()) {
    const cx = (r[0] + r[2]) / 2,
      cy = (r[1] + r[3]) / 2,
      x = (r[2] - r[0]) / 2,
      y = 8,
      radius = 4,
      c = 2.2
    const program = [
      0,
      x - radius,
      y,
      1,
      -x + radius,
      y,
      2,
      -x + c,
      y,
      -x,
      y - c,
      -x,
      y - radius,
      1,
      -x,
      -y + radius,
      2,
      -x,
      -y + c,
      -x + c,
      -y,
      -x + radius,
      -y,
      1,
      x - radius,
      -y,
      2,
      x - c,
      -y,
      x,
      -y + c,
      x,
      -y + radius,
      1,
      x,
      y - radius,
      2,
      x,
      y - c,
      x - c,
      y,
      x - radius,
      y,
      4,
      0,
      -x,
      -y
    ]
    emit(OPS.save, null)
    emit(OPS.transform, [1, 0, 0, 1, cx, height - cy])
    emit(OPS.setFillRGBColor, ['#ccccff'])
    emit(OPS.setStrokeRGBColor, ['#000000'])
    emit(OPS.setLineWidth, [0.4])
    path(program, OPS.fillStroke, [-x, -y, x, y], r)
    emit(OPS.restore, null)
    text(`Node ${n}`, cx - 12, cy - 4.01)
  }
  for (const [n, r] of nodes.slice(1).entries()) {
    const parent = nodes[parents[n]],
      start = [(parent[0] + parent[2]) / 2, parent[3] + 0.4],
      tip = [(r[0] + r[2]) / 2, r[1] - 1.2],
      delta = [tip[0] - start[0], tip[1] - start[1]],
      length = Math.hypot(...delta),
      d = delta.map((v) => v / length),
      end = [tip[0] - d[0] * 5, tip[1] - d[1] * 5]
    emit(OPS.setLineWidth, [0.4])
    emit(OPS.setStrokeRGBColor, ['#000000'])
    emit(OPS.setFillRGBColor, ['#000000'])
    const line = [0, start[0], height - start[1], 1, end[0], height - end[1]]
    path(
      line,
      OPS.stroke,
      [
        Math.min(start[0], end[0]),
        height - Math.max(start[1], end[1]),
        Math.max(start[0], end[0]),
        height - Math.min(start[1], end[1])
      ],
      [
        Math.min(start[0], end[0]) - 0.2,
        Math.min(start[1], end[1]) - 0.2,
        Math.max(start[0], end[0]) + 0.2,
        Math.max(start[1], end[1]) + 0.2
      ]
    )
    const points = [
        tip,
        [end[0] - d[0] + d[1] * 1.5, end[1] - d[1] - d[0] * 1.5],
        [end[0] + d[0] * 0.2, end[1] + d[1] * 0.2],
        [end[0] - d[0] - d[1] * 1.5, end[1] - d[1] + d[0] * 1.5]
      ],
      bounds = [
        Math.min(...points.map((p) => p[0])),
        height - Math.max(...points.map((p) => p[1])),
        Math.max(...points.map((p) => p[0])),
        height - Math.min(...points.map((p) => p[1]))
      ]
    path(
      points.flatMap((p, n) => [n ? 1 : 0, p[0], height - p[1]]).concat(4),
      OPS.fillStroke,
      bounds,
      [bounds[0], height - bounds[3], bounds[2], height - bounds[1]]
    )
  }
  text('Figure 1: Connected nodes.', 248, 468)
  const caption = { page: 1, lines: ['Figure 1: Connected nodes.'], rect: [248, 468, 352, 476] }
  const tokens = content.items.map((i: ReturnType<typeof JSON.parse>, index: number) => ({
    text: i.str,
    rect: [
      i.transform[4],
      height - i.transform[5] - font,
      i.transform[4] + i.width,
      height - i.transform[5]
    ],
    horizontal: true,
    height: font,
    baseline: height - i.transform[5],
    sourceItem: { pageNumber: 1, index, text: i.str }
  }))
  return { page, caption, tokens, context: { operators, viewport, content } }
}

it('completes all connected enclosures before generic detached-label padding', () => {
  const p = connectedNodePacket()
  expect(
    nativeCaptionedConnectedNodes(p.page, p.caption, [p.caption], [], p.tokens, p.context)
      ?.graphicsCount
  ).toBe(22)
  const figures = associateFigures(p.page, [p.caption], [], [], [], p.tokens, p.context)
  expect(figures).toHaveLength(1)
  expect(figures[0].rect[0]).toBeLessThan(61)
  expect(figures[0].rect[2]).toBeGreaterThan(540)
  expect(figures[0].rect[1]).toBeGreaterThan(75)
  expect(figures[0].rect[3]).toBeLessThan(468)
})

it('preserves complete source ownership after the extractor scales native tokens through 1.5', () => {
  const p = connectedNodePacket()
  const expected = nativeCaptionedConnectedNodes(
    p.page,
    p.caption,
    [p.caption],
    [],
    p.tokens,
    p.context
  )
  const original = p.tokens.map((token: ReturnType<typeof JSON.parse>) => ({ ...token }))
  p.tokens = p.tokens.map((token: ReturnType<typeof JSON.parse>) => {
    const item = p.context.content.items[token.sourceItem.index]
    const x = (item.transform[4] * 1.5) / 1.5
    const baseline = (p.page.height * 1.5 - item.transform[5] * 1.5) / 1.5
    const height = (item.height * 1.5) / 1.5
    return {
      ...token,
      baseline,
      height,
      rect: [x, baseline - height, x + (item.width * 1.5) / 1.5, baseline]
    }
  })
  expect(
    p.tokens.some(
      (t: ReturnType<typeof JSON.parse>, n: number) => t.baseline !== original[n].baseline
    )
  ).toBe(true)
  expect(expected?.graphicsCount).toBe(22)
  expect(
    nativeCaptionedConnectedNodes(p.page, p.caption, [p.caption], [], p.tokens, p.context)
  ).toEqual(expected)
})

it.each([
  'white text',
  'white fill',
  'black fill',
  'invisible text',
  'alpha',
  'clip',
  'zero glyph',
  'missing token',
  'duplicate token',
  'extra path',
  'wrong bounds',
  'missing style',
  'body overlap',
  'caption overlap',
  'different baseline',
  'NaN baseline',
  'different height',
  'NaN height'
])('refuses connected-node completion with %s', (change) => {
  const p = connectedNodePacket(),
    ops = p.context.operators,
    firstText = ops.fnArray.indexOf(OPS.showText),
    firstPath = ops.fnArray.indexOf(OPS.constructPath)
  if (change === 'white text')
    ops.argsArray[ops.fnArray.indexOf(OPS.setFillRGBColor, firstPath + 1)] = ['#ffffff']
  if (change === 'white fill' || change === 'black fill')
    ops.argsArray[ops.fnArray.indexOf(OPS.setFillRGBColor)] = [
      change === 'white fill' ? '#ffffff' : '#000000'
    ]
  if (change === 'invisible text' || change === 'alpha' || change === 'clip') {
    ops.fnArray.push(
      change === 'invisible text'
        ? OPS.setTextRenderingMode
        : change === 'alpha'
          ? OPS.setGState
          : OPS.clip
    )
    ops.argsArray.push(
      change === 'invisible text' ? [3] : change === 'alpha' ? [[['ca', 0]]] : null
    )
  }
  if (change === 'zero glyph') ops.argsArray[firstText][0][0].width = 0
  if (change === 'missing token') p.tokens.shift()
  if (change === 'different baseline') p.tokens[0].baseline += 0.00001
  if (change === 'NaN baseline') p.tokens[0].baseline = Number.NaN
  if (change === 'different height') p.tokens[0].height += 0.00001
  if (change === 'NaN height') p.tokens[0].height = Number.NaN
  if (change === 'duplicate token') p.tokens.push(p.tokens[0])
  if (change === 'extra path') p.page.graphicsBounds.push({ ...p.page.graphicsBounds[0] })
  if (change === 'wrong bounds') ops.argsArray[firstPath][2][0] -= 1
  if (change === 'missing style') delete p.context.content.styles.font
  if (change === 'body overlap')
    p.page.lines.push({ text: 'Unowned prose', x: 80, y: 180, width: 120, height: 8, fontSize: 8 })
  const captions =
    change === 'caption overlap'
      ? [p.caption, { page: 1, lines: ['Figure 2: Other.'], rect: [80, 180, 220, 188] }]
      : [p.caption]
  expect(
    nativeCaptionedConnectedNodes(p.page, p.caption, captions, [], p.tokens, p.context)
  ).toBeUndefined()
})
const framedBefore = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids/caption-before-stacked-framed-raster.jsonl'))
const framedAfter = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids/caption-after-stacked-framed-raster.jsonl'))
const framedTextPanel = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids/captioned-ui-raster-text-panel.jsonl'))
const wideRasterWithUnrelatedPaths = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids/wide-raster-with-unrelated-paths.jsonl'))
const framedVectorPromptCard = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids/framed-vector-prompt-card.jsonl'))
const captionedVectorStageDiagram = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids/captioned-vector-stage-diagram.jsonl'))
const captionedVectorGrid = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids/captioned-vector-grid.jsonl'))
const vectorHeatmap = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids/vector-success-heatmap.jsonl'))
const workflowScreenshot = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids/workflow-screenshot-trajectory.jsonl'))
const rasterQuad = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids/captioned-raster-quad.jsonl'))
const dualPanelRasterGrid = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids/captioned-dual-panel-four-row-raster.jsonl'))
const rasterModerateGap = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids/captioned-raster-moderate-gap.jsonl'))
const stackedVectorPlates = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids/stacked-vector-plates.jsonl'))

it.each([
  ['caption before', framedBefore, [60, 140, 540, 300]],
  ['caption after', framedAfter, [60, 120, 540, 308]]
])('recovers only the nearest framed raster when %s', (_label, load, expected) => {
  const fixture = load()
  expect(
    nativeCaptionedFramedRaster(fixture.page, fixture.caption, [fixture.caption], [])?.rect
  ).toEqual(expected)
})

it('rejects a framed raster claimed by a competing caption', () => {
  const fixture = framedBefore()
  const competing = { page: 1, lines: ['Figure 2. Neighbor.'], rect: [50, 130, 550, 310] }
  expect(
    nativeCaptionedFramedRaster(fixture.page, fixture.caption, [fixture.caption, competing], [])
  ).toBeUndefined()
})

it('recovers a framed raster-plus-text response panel at the outer frame', () => {
  const fixture = framedTextPanel()
  expect(
    nativeCaptionedFramedRasterTextPanel(fixture.page, fixture.caption, [fixture.caption], [])?.rect
  ).toEqual([60, 120, 540, 600])
  expect(associateFigures(fixture.page, [fixture.caption], [], [], [], [])[0].rect).toEqual([
    60, 120, 540, 600
  ])
})

it.each([280, 330])('does not give a framed panel to a caption starting at x=%s', (left) => {
  const frame = [40, 50, 280, 250]
  const image = [60, 80, 260, 220]
  const own = { page: 1, lines: ['Figure 1. A response.'], rect: [40, 260, 280, 290] }
  const neighbor = {
    page: 1,
    lines: ['Figure 2. Another response.'],
    rect: [left, 260, 570, 290]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      { text: 'Prompt', x: 80, y: 100, width: 100, height: 10, fontSize: 10 },
      { text: 'Response', x: 80, y: 120, width: 100, height: 10, fontSize: 10 }
    ],
    graphicsBounds: [
      { kind: 'path', normalizedRect: frame.map((v, i) => v / (i % 2 ? 800 : 600)) },
      { kind: 'image', normalizedRect: image.map((v, i) => v / (i % 2 ? 800 : 600)) }
    ]
  }
  const snapshot = structuredClone({ page, own, neighbor })
  expect(nativeCaptionedFramedRasterTextPanel(page, own, [own, neighbor], [])?.rect).toEqual(frame)
  expect(nativeCaptionedFramedRasterTextPanel(page, neighbor, [own, neighbor], [])).toBeUndefined()
  expect({ page, own, neighbor }).toEqual(snapshot)
})

it('keeps a composite outer frame when an inset raster has its own border', () => {
  const caption = {
    page: 1,
    lines: ['Figure 12. Composite workflow panel.', 'The complete workflow is shown above.'],
    rect: [60, 480, 540, 520]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      { text: 'Prompt', x: 90, y: 130, width: 100, height: 12, fontSize: 10 },
      { text: 'Input and output', x: 90, y: 220, width: 160, height: 12, fontSize: 10 },
      { text: 'Model response', x: 90, y: 260, width: 160, height: 12, fontSize: 10 },
      {
        text: 'Figure 12. Composite workflow panel.',
        x: 60,
        y: 480,
        width: 480,
        height: 12,
        fontSize: 10
      },
      {
        text: 'The complete workflow is shown above.',
        x: 60,
        y: 496,
        width: 420,
        height: 12,
        fontSize: 10
      }
    ],
    graphicsBounds: [
      { kind: 'path', normalizedRect: [60 / 600, 100 / 800, 540 / 600, 470 / 800] },
      { kind: 'image', normalizedRect: [90 / 600, 300 / 800, 300 / 600, 466 / 800] },
      { kind: 'path', normalizedRect: [90 / 600, 300 / 800, 300 / 600, 466 / 800] }
    ]
  }
  expect(nativeCaptionedFramedRaster(page, caption, [caption], [])).toBeUndefined()
  expect(nativeCaptionedFramedRasterTextPanel(page, caption, [caption], [])?.rect).toEqual([
    60, 100, 540, 470
  ])
  expect(associateFigures(page, [caption], [], [], [], [])[0].rect).toEqual([60, 100, 540, 470])
})

it('recovers a pure vector prompt card when an inset frame proves its ownership', () => {
  const fixture = framedVectorPromptCard()
  expect(
    nativeCaptionedTextIllustration(fixture.page, fixture.caption, [fixture.caption], [])?.rect
  ).toEqual([69.328125, 71.15625, 545.0625, 309.375])
  expect(associateFigures(fixture.page, [fixture.caption], [], [], [], [])[0].rect).toEqual([
    69.328125, 71.15625, 545.0625, 309.375
  ])
})

it('recovers a staged vector diagram from its outer frame and repeated image marks', () => {
  const fixture = captionedVectorStageDiagram()
  expect(
    nativeCaptionedVectorDiagram(fixture.page, fixture.caption, [fixture.caption], [])?.rect
  ).toEqual([71.71875, 204.1875, 542.671875, 408.375])
  expect(associateFigures(fixture.page, [fixture.caption], [], [], [], [])[0].rect).toEqual([
    71.71875, 204.1875, 542.671875, 408.375
  ])
})

it('recovers a narrow vector grid from an attached frame and repeated path lattice', () => {
  const fixture = captionedVectorGrid()
  expect(
    nativeCaptionedVectorGrid(fixture.page, fixture.caption, [fixture.caption], [])?.rect
  ).toEqual([306, 63.36, 544.6800000000001, 175.824])
  expect(associateFigures(fixture.page, [fixture.caption], [], [], [], [])[0].rect).toEqual([
    306, 63.36, 544.6800000000001, 175.824
  ])
})

it('rejects a narrow vector grid when a table overlaps its frame', () => {
  const fixture = captionedVectorGrid()
  expect(
    nativeCaptionedVectorGrid(
      fixture.page,
      fixture.caption,
      [fixture.caption],
      [[306, 63, 545, 176]]
    )
  ).toBeUndefined()
})

it('rejects a narrow vector grid claimed by a competing caption', () => {
  const fixture = captionedVectorGrid(),
    competing = { page: 1, lines: ['Figure 7. Neighbor.'], rect: [300, 90, 550, 110] }
  expect(
    nativeCaptionedVectorGrid(fixture.page, fixture.caption, [fixture.caption, competing], [])
  ).toBeUndefined()
})

it('recovers a compact vector table diagram without an outer frame', () => {
  const caption = {
    page: 1,
    lines: ['Figure 8: Sample table diagram.'],
    rect: [60, 220, 540, 235]
  }
  const toNormalized = (rect: number[]): number[] =>
    rect.map((value, index) => value / (index % 2 ? 800 : 600))
  const paths = [
    [180, 110, 420, 116],
    [180, 140, 420, 146],
    [180, 170, 420, 176],
    [180, 200, 420, 206],
    ...[180, 240, 300, 360, 420].flatMap((x) => [
      [x, 110, x + 6, 146],
      [x, 140, x + 6, 176],
      [x, 170, x + 6, 206]
    ])
  ]
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      { text: caption.lines[0], x: 60, y: 220, width: 280, height: 10, fontSize: 9 },
      { text: '(1, 1) (1, 2)', x: 190, y: 118, width: 100, height: 10, fontSize: 9 },
      { text: '(2, 1) (2, 2)', x: 190, y: 148, width: 100, height: 10, fontSize: 9 },
      { text: '(3, 1) (3, 2)', x: 190, y: 178, width: 100, height: 10, fontSize: 9 }
    ],
    graphicsBounds: paths.map((rect) => ({ kind: 'path', normalizedRect: toNormalized(rect) }))
  }
  const vectorRect = nativeCaptionedVectorTableGrid(page, caption, [caption], [])?.rect
  expect(vectorRect?.[0]).toBeCloseTo(180)
  expect(vectorRect?.[1]).toBeCloseTo(110)
  expect(vectorRect?.[2]).toBeCloseTo(426)
  expect(vectorRect?.[3]).toBeCloseTo(206)
  const associatedVectorRect = associateFigures(page, [caption], [], [], [], [])[0].rect
  expect(associatedVectorRect?.[0]).toBeCloseTo(180)
  expect(associatedVectorRect?.[1]).toBeCloseTo(110)
  expect(associatedVectorRect?.[2]).toBeCloseTo(426)
  expect(associatedVectorRect?.[3]).toBeCloseTo(206)
})

it('recovers a dense native-vector success-rate heatmap under its caption', () => {
  const fixture = vectorHeatmap()
  expect(
    nativeCaptionedVectorHeatmap(fixture.page, fixture.caption, [fixture.caption], [])?.rect
  ).toEqual([100, 80, 453, 216])
  expect(associateFigures(fixture.page, [fixture.caption], [], [], [], [])[0].rect).toEqual([
    100, 80, 453, 216
  ])
})

it('ignores a disconnected vector grid above the local heatmap band', () => {
  const fixture = vectorHeatmap()
  const unrelated = Array.from({ length: 24 }, (_, index) => {
    const row = Math.floor(index / 6)
    const column = index % 6
    const left = 0.1 + column * 0.04
    const top = 0.005 + row * 0.018
    return {
      kind: 'path',
      normalizedRect: [left, top, left + 0.03, top + 0.012]
    }
  })
  fixture.page.graphicsBounds.push(...unrelated)
  expect(
    nativeCaptionedVectorHeatmap(fixture.page, fixture.caption, [fixture.caption], [])?.rect
  ).toEqual([100, 80, 453, 216])
})

it('recovers a connected workflow screenshot plate through its spanning path', () => {
  const fixture = workflowScreenshot()
  expect(
    nativeCaptionedWorkflowPanel(fixture.page, fixture.caption, [fixture.caption], [])?.rect
  ).toEqual([60, 70, 540, 340])
  expect(associateFigures(fixture.page, [fixture.caption], [], [], [], [])[0].rect).toEqual([
    60, 70, 540, 340
  ])
})

it('accepts a repeated full frame as the ownership witness for code cards', () => {
  const fixture = framedVectorPromptCard()
  fixture.page.graphicsBounds[1] = { ...fixture.page.graphicsBounds[0] }
  expect(
    nativeCaptionedTextIllustration(fixture.page, fixture.caption, [fixture.caption], [])?.rect
  ).toEqual([69.328125, 71.15625, 545.0625, 309.375])
})

it('rejects a framed raster-plus-text panel overlapping a table', () => {
  const fixture = framedTextPanel()
  expect(
    nativeCaptionedFramedRasterTextPanel(
      fixture.page,
      fixture.caption,
      [fixture.caption],
      [[60, 120, 540, 600]]
    )
  ).toBeUndefined()
})

it('uses the full border when painted raster bounds are inset', () => {
  const caption = {
    page: 26,
    lines: ['Figure 10. Recurrence summary.'],
    rect: [72, 289.44, 540.08, 481.44]
  }
  const page = {
    pageNumber: 26,
    width: 612,
    height: 792,
    invalidGraphicsBounds: 0,
    lines: [],
    graphicsBounds: [
      {
        kind: 'image',
        normalizedRect: [0.1352, 0.0959, 0.871, 0.3305]
      },
      { kind: 'path', normalizedRect: [0.1171875, 0.08984375, 0.890625, 0.359375] },
      {
        kind: 'image',
        normalizedRect: [0.1171875, 0.62109375, 0.890625, 0.91015625]
      },
      { kind: 'path', normalizedRect: [0.1171875, 0.62109375, 0.890625, 0.91015625] }
    ]
  }
  expect(nativeCaptionedFramedRaster(page, caption, [caption], [])?.rect).toEqual([
    71.71875, 71.15625, 545.0625, 284.625
  ])
})

it('recovers a multi-row raster tile grid above its caption', () => {
  const caption = { page: 1, lines: ['Figure 12. Trajectory plate.'], rect: [60, 350, 540, 380] }
  const images = Array.from({ length: 15 }, (_, index) => {
    const column = index % 5
    const row = Math.floor(index / 5)
    return {
      kind: 'image',
      normalizedRect: [
        (100 + column * 80) / 600,
        (90 + row * 70) / 800,
        (150 + column * 80) / 600,
        (140 + row * 70) / 800
      ]
    }
  })
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 60, y: 350, width: 480, height: 10, fontSize: 10 }],
    graphicsBounds: images
  }
  expect(nativeRasterGrid(page, caption, [caption], [])?.rect).toEqual([100, 90, 470, 280])
  expect(associateFigures(page, [caption], [], [], [], [])[0].rect).toEqual([100, 90, 470, 280])
})
it('does not merge a neighboring raster grid into the captioned grid', () => {
  const caption = { page: 1, lines: ['Figure 13. Target plate.'], rect: [380, 350, 710, 380] }
  const images = [10, 400].flatMap((left) =>
    Array.from({ length: 15 }, (_, index) => {
      const column = index % 5
      const row = Math.floor(index / 5)
      return {
        kind: 'image',
        normalizedRect: [
          (left + column * 60) / 720,
          (90 + row * 70) / 800,
          (left + column * 60 + 50) / 720,
          (140 + row * 70) / 800
        ]
      }
    })
  )
  const page = {
    pageNumber: 1,
    width: 720,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 380, y: 350, width: 330, height: 10, fontSize: 10 }],
    graphicsBounds: images
  }
  expect(nativeRasterGrid(page, caption, [caption], [])?.rect).toEqual([400, 90, 690, 280])
})
it('recovers a strict 2x2 raster plate beside unrelated page content', () => {
  const fixture = rasterQuad()
  expect(
    nativeCaptionedRasterQuad(fixture.page, fixture.caption, [fixture.caption], [])?.rect
  ).toEqual([50.203125, 185.625, 296.4375, 340.3125])
  expect(associateFigures(fixture.page, [fixture.caption], [], [], [], [])[0].rect).toEqual([
    50.203125, 185.625, 296.4375, 340.3125
  ])
})
it('rejects the 2x2 raster plate when a table overlaps its image bounds', () => {
  const fixture = rasterQuad()
  expect(
    nativeCaptionedRasterQuad(
      fixture.page,
      fixture.caption,
      [fixture.caption],
      [[40, 100, 560, 345]]
    )
  ).toBeUndefined()
})

const horizontalRasterArray = (): ReturnType<typeof JSON.parse> => {
  const caption = {
    page: 1,
    lines: ['Figure 11. Four panel comparison.'],
    rect: [50, 280, 550, 295]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      {
        text: '(a) Original (b) Groundtruth (c) BERT (d) LayoutLM',
        x: 70,
        y: 257,
        width: 460,
        height: 8,
        fontSize: 8
      },
      { text: caption.lines[0], x: 50, y: 280, width: 500, height: 10, fontSize: 10 }
    ],
    graphicsBounds: [
      { kind: 'image', normalizedRect: [60 / 600, 100 / 800, 170 / 600, 260 / 800] },
      { kind: 'image', normalizedRect: [180 / 600, 100 / 800, 290 / 600, 260 / 800] },
      { kind: 'image', normalizedRect: [300 / 600, 100 / 800, 410 / 600, 260 / 800] },
      { kind: 'image', normalizedRect: [420 / 600, 100 / 800, 530 / 600, 260 / 800] }
    ]
  }
  return { page, caption }
}

it('recovers every panel in a captioned horizontal raster strip', () => {
  const fixture = horizontalRasterArray()
  expect(
    nativeCaptionedRasterHorizontalArray(fixture.page, fixture.caption, [fixture.caption], [])?.rect
  ).toEqual([60, 100, 530, 260])
  expect(associateFigures(fixture.page, [fixture.caption], [], [], [], [])[0].rect).toEqual([
    60, 100, 530, 260
  ])
})

it('rejects a horizontal raster strip with a missing panel', () => {
  const fixture = horizontalRasterArray()
  fixture.page.graphicsBounds.pop()
  expect(
    nativeCaptionedRasterHorizontalArray(fixture.page, fixture.caption, [fixture.caption], [])
  ).toBeUndefined()
})

it('recovers a five-panel raster strip without requiring a four-panel legend', () => {
  const caption = {
    page: 1,
    lines: ['Figure 14: Sample misannotated tables.'],
    rect: [50, 230, 550, 245]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 50, y: 230, width: 500, height: 10, fontSize: 9 }],
    graphicsBounds: Array.from({ length: 5 }, (_, index) => ({
      kind: 'image',
      normalizedRect: [(60 + index * 105) / 600, 90 / 800, (145 + index * 105) / 600, 195 / 800]
    }))
  }
  expect(nativeCaptionedRasterHorizontalArray(page, caption, [caption], [])?.rect).toEqual([
    60, 90, 565, 195
  ])
  expect(associateFigures(page, [caption], [], [], [], [])[0].rect).toEqual([60, 90, 565, 195])
})

it('recovers a seven-panel raster strip below a preceding figure', () => {
  const upperCaption = {
      page: 1,
      lines: ['Figure 13. Upper raster plate.'],
      rect: [50, 230, 550, 245]
    },
    caption = {
      page: 1,
      lines: ['Figure 14. Visualizations at different time steps.'],
      rect: [50, 390, 550, 415]
    },
    page = {
      pageNumber: 1,
      width: 600,
      height: 800,
      invalidGraphicsBounds: 0,
      lines: [
        { text: upperCaption.lines[0], x: 50, y: 230, width: 500, height: 10, fontSize: 9 },
        { text: caption.lines[0], x: 50, y: 390, width: 500, height: 10, fontSize: 9 }
      ],
      graphicsBounds: [
        ...Array.from({ length: 7 }, (_, index) => ({
          kind: 'image',
          normalizedRect: [(60 + index * 74) / 600, 80 / 800, (125 + index * 74) / 600, 155 / 800]
        })),
        ...Array.from({ length: 7 }, (_, index) => ({
          kind: 'image',
          normalizedRect: [(60 + index * 74) / 600, 300 / 800, (125 + index * 74) / 600, 375 / 800]
        }))
      ]
    }
  const result = nativeCaptionedRasterHorizontalArray(page, caption, [upperCaption, caption], [])
  expect(result?.rect).toEqual([60, 300, 569, 375])
  expect(result?.graphicsCount).toBe(7)
  expect(associateFigures(page, [upperCaption, caption], [], [], [], [])).toContainEqual(
    expect.objectContaining({ caption, rect: [60, 300, 569, 375] })
  )
})

it('recovers a strictly aligned two-panel raster plate', () => {
  const caption = {
    page: 1,
    lines: ['Figure 15: Side-by-side comparison.'],
    rect: [50, 520, 550, 550]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 50, y: 520, width: 500, height: 10, fontSize: 10 }],
    graphicsBounds: [
      { kind: 'image', normalizedRect: [90 / 600, 180 / 800, 285 / 600, 440 / 800] },
      { kind: 'image', normalizedRect: [310 / 600, 182 / 800, 505 / 600, 442 / 800] }
    ]
  }
  expect(nativeCaptionedRasterSideBySide(page, caption, [caption], [])?.rect).toEqual([
    90, 180, 505, 442
  ])
  expect(associateFigures(page, [caption], [], [], [], [])[0]).toMatchObject({
    rect: [90, 180, 505, 442],
    reason: 'native-raster-side-by-side'
  })
})

it('rejects a side-by-side plate when a third image shares the caption band', () => {
  const caption = {
    page: 1,
    lines: ['Figure 16: Side-by-side comparison.'],
    rect: [50, 520, 550, 550]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 50, y: 520, width: 500, height: 10, fontSize: 10 }],
    graphicsBounds: [
      { kind: 'image', normalizedRect: [90 / 600, 180 / 800, 285 / 600, 440 / 800] },
      { kind: 'image', normalizedRect: [310 / 600, 182 / 800, 505 / 600, 442 / 800] },
      { kind: 'image', normalizedRect: [20 / 600, 180 / 800, 180 / 600, 420 / 800] }
    ]
  }
  expect(nativeCaptionedRasterSideBySide(page, caption, [caption], [])).toBeUndefined()
})

it('separates a lower raster grid after an intervening figure caption', () => {
  const upperCaption = {
      page: 1,
      lines: ['Figure 20. Upper plate.'],
      rect: [50, 225, 550, 245]
    },
    lowerCaption = {
      page: 1,
      lines: ['Figure 21. Lower plate.'],
      rect: [50, 445, 550, 465]
    },
    page = {
      pageNumber: 1,
      width: 600,
      height: 800,
      invalidGraphicsBounds: 0,
      lines: [
        { text: upperCaption.lines[0], x: 50, y: 225, width: 500, height: 10, fontSize: 9 },
        { text: lowerCaption.lines[0], x: 50, y: 445, width: 500, height: 10, fontSize: 9 }
      ],
      graphicsBounds: Array.from({ length: 12 }, (_, index) => {
        const plate = index < 6 ? 0 : 1
        const local = index % 6
        const row = Math.floor(local / 3)
        const column = local % 3
        return {
          kind: 'image',
          normalizedRect: [
            (80 + column * 135) / 600,
            (80 + plate * 220 + row * 70) / 800,
            (190 + column * 135) / 600,
            (135 + plate * 220 + row * 70) / 800
          ]
        }
      })
    },
    match = associateFigures(page, [upperCaption, lowerCaption], [], [], [], []).find(
      (candidate: { caption: unknown }) => candidate.caption === lowerCaption
    )

  expect(match?.rect?.[0]).toBeCloseTo(80)
  expect(match?.rect?.[1]).toBeCloseTo(300)
  expect(match?.rect?.[2]).toBeCloseTo(460)
  expect(match?.rect?.[3]).toBeCloseTo(425)
})

it('prioritizes a complete horizontal strip over a later single-panel figure', () => {
  const fixture = horizontalRasterArray()
  const lowerCaption = {
    page: 1,
    lines: ['Figure 12. Physical execution.'],
    rect: [50, 510, 320, 525]
  }
  fixture.page.lines.push({
    text: lowerCaption.lines[0],
    x: 50,
    y: 510,
    width: 270,
    height: 10,
    fontSize: 9
  })
  fixture.page.graphicsBounds.push(
    { kind: 'image', normalizedRect: [60 / 600, 300 / 800, 300 / 600, 500 / 800] },
    { kind: 'path', normalizedRect: [60 / 600, 300 / 800, 300 / 600, 500 / 800] }
  )
  const matches = associateFigures(fixture.page, [fixture.caption, lowerCaption], [], [], [], [])
  expect(
    matches.find((match: { caption: unknown }) => match.caption === fixture.caption)?.rect
  ).toEqual([60, 100, 530, 260])
})

it('recovers a multi-row raster composite without dropping its upper panels', () => {
  const caption = {
    page: 1,
    lines: ['Figure 15. Composite dataset overview.'],
    rect: [50, 690, 550, 710]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 50, y: 690, width: 500, height: 10, fontSize: 9 }],
    graphicsBounds: [
      { kind: 'image', normalizedRect: [90 / 600, 120 / 800, 250 / 600, 250 / 800] },
      { kind: 'image', normalizedRect: [270 / 600, 120 / 800, 430 / 600, 250 / 800] },
      { kind: 'image', normalizedRect: [90 / 600, 280 / 800, 230 / 600, 410 / 800] },
      { kind: 'image', normalizedRect: [245 / 600, 280 / 800, 385 / 600, 410 / 800] },
      { kind: 'image', normalizedRect: [90 / 600, 435 / 800, 430 / 600, 650 / 800] }
    ]
  }
  expect(nativeCaptionedRasterCompositeGrid(page, caption, [caption], [])?.rect).toEqual([
    90, 120, 430, 650
  ])
  expect(associateFigures(page, [caption], [], [], [], [])[0].rect).toEqual([90, 120, 430, 650])
})

it('recovers a two-row three-column raster composite', () => {
  const caption = {
    page: 1,
    lines: ['Figure 16. Three-column comparison.'],
    rect: [50, 510, 550, 530]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 50, y: 510, width: 500, height: 10, fontSize: 9 }],
    graphicsBounds: Array.from({ length: 6 }, (_, index) => {
      const row = Math.floor(index / 3)
      const column = index % 3
      return {
        kind: 'image',
        normalizedRect: [
          (80 + column * 145) / 600,
          (170 + row * 180) / 800,
          (210 + column * 145) / 600,
          (320 + row * 180) / 800
        ]
      }
    })
  }
  const rasterRect = nativeCaptionedRasterCompositeGrid(page, caption, [caption], [])?.rect
  expect(rasterRect?.[0]).toBeCloseTo(80)
  expect(rasterRect?.[1]).toBeCloseTo(170)
  expect(rasterRect?.[2]).toBeCloseTo(500)
  expect(rasterRect?.[3]).toBeCloseTo(500)
  const associatedRasterRect = associateFigures(page, [caption], [], [], [], [])[0].rect
  expect(associatedRasterRect?.[0]).toBeCloseTo(80)
  expect(associatedRasterRect?.[1]).toBeCloseTo(170)
  expect(associatedRasterRect?.[2]).toBeCloseTo(500)
  expect(associatedRasterRect?.[3]).toBeCloseTo(500)
})

it('recovers a unique narrow-column raster with a moderate caption gap', () => {
  const fixture = rasterModerateGap()
  const match = nativeCaptionedRasterModerateGap(
    fixture.page,
    fixture.caption,
    [fixture.caption],
    []
  )
  expect(match?.rect[0]).toBeCloseTo(50.2)
  expect(match?.rect[1]).toBeCloseTo(451.7)
  expect(match?.rect[2]).toBeCloseTo(296.4)
  expect(match?.rect[3]).toBeCloseTo(535.2)
  const associated = associateFigures(fixture.page, [fixture.caption], [], [], [], [])[0].rect
  expect(associated?.[0]).toBeCloseTo(50.2)
  expect(associated?.[1]).toBeCloseTo(451.7)
})
it('rejects the moderate-gap raster when a competing image is present', () => {
  const fixture = rasterModerateGap()
  fixture.page.graphicsBounds.push({ kind: 'image', normalizedRect: [0.6, 0.2, 0.9, 0.4] })
  expect(
    nativeCaptionedRasterModerateGap(fixture.page, fixture.caption, [fixture.caption], [])
  ).toBeUndefined()
})
it('recovers a complete four-row dual-panel raster plate', () => {
  const fixture = dualPanelRasterGrid()
  const rect = nativeCaptionedRasterDualPanelGrid(
    fixture.page,
    fixture.caption,
    [fixture.caption],
    []
  )?.rect
  expect(rect?.slice(0, 2)).toEqual([90, 100])
  expect(rect?.[2]).toBeCloseTo(470)
  expect(rect?.[3]).toBe(325)
  const associated = associateFigures(fixture.page, [fixture.caption], [], [], [], [])[0].rect
  expect(associated?.slice(0, 2)).toEqual([90, 100])
  expect(associated?.[2]).toBeCloseTo(470)
  expect(associated?.[3]).toBe(325)
})
it('rejects a dual-panel raster plate when one row is incomplete', () => {
  const fixture = dualPanelRasterGrid()
  fixture.page.graphicsBounds = fixture.page.graphicsBounds.slice(0, -1)
  expect(
    nativeCaptionedRasterDualPanelGrid(fixture.page, fixture.caption, [fixture.caption], [])
  ).toBeUndefined()
})
const plate = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids/unequal-lettered-raster-plate.jsonl'))
it('owns every unequal raster and attached key under the centered caption', () => {
  const f = plate()
  const match = associateFigures(f.page, [f.caption], [], [], [], f.tokens)[0]
  expect(match.rect).toEqual([30, 120, 570, 485])
})
it('keeps a left-column vector figure when a right-column plot has its own caption', () => {
  const left = {
    page: 1,
    lines: ['Fig. C.2. Semantic preference simplex.'],
    rect: [50, 220, 300, 255]
  }
  const right = { page: 1, lines: ['Fig. D.1. Training behavior.'], rect: [310, 400, 560, 435] }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      { text: left.lines[0], x: 50, y: 220, width: 250, height: 10, fontSize: 10 },
      { text: right.lines[0], x: 310, y: 400, width: 250, height: 10, fontSize: 10 }
    ],
    graphicsBounds: [
      { kind: 'path', normalizedRect: [80 / 600, 60 / 800, 250 / 600, 205 / 800] },
      { kind: 'path', normalizedRect: [340 / 600, 150 / 800, 540 / 600, 370 / 800] }
    ]
  }
  const [figure] = associateFigures(page, [left, right], [], [], [], [])
  expect(figure.rect).toEqual([80, 60, 250, expect.closeTo(205)])
})
it('separates stacked vector plates at the upper caption boundary', () => {
  const fixture = stackedVectorPlates()
  const matches = associateFigures(fixture.page, fixture.captions, [], [], [], [])
  expect(matches).toHaveLength(2)
  expect(matches[0].rect?.[1]).toBeCloseTo(136.1, 0)
  expect(matches[0].rect?.[3]).toBeCloseTo(272.3, 0)
  expect(matches[1].rect?.[1]).toBeCloseTo(464.1, 0)
  expect(matches[1].rect?.[3]).toBeCloseTo(600.2, 0)
})
it('recovers a single chart tightly attached to a narrow-column caption', () => {
  const caption = {
    page: 1,
    lines: ['FIGURE 4: Experimentally characterized relationship.'],
    rect: [36, 408, 293, 430]
  }
  const page = {
    pageNumber: 1,
    width: 612,
    height: 792,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 36, y: 408, width: 257, height: 10, fontSize: 10 }],
    graphicsBounds: [
      { kind: 'image', normalizedRect: [64 / 612, 233 / 792, 282 / 612, 405 / 792] },
      { kind: 'image', normalizedRect: [78 / 612, 461 / 792, 302 / 612, 660 / 792] }
    ]
  }
  expect(nativeCaptionedRaster(page, caption, [caption], [])?.rect).toEqual([
    64,
    expect.closeTo(233),
    282,
    405
  ])
})
it('recovers a wide raster chart when unrelated paths are elsewhere on the page', () => {
  const fixture = wideRasterWithUnrelatedPaths()
  expect(nativeCaptionedRaster(fixture.page, fixture.caption, [fixture.caption], [])?.rect).toEqual(
    [expect.closeTo(70), expect.closeTo(80), expect.closeTo(530), expect.closeTo(205)]
  )
})
it('recovers a full-width raster above a lower competing region', () => {
  const caption = {
    page: 1,
    lines: ['Figure 15. Time-frequency representation.'],
    rect: [50, 300, 550, 315]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 50, y: 300, width: 500, height: 10, fontSize: 10 }],
    graphicsBounds: [
      { kind: 'image', normalizedRect: [60 / 600, 80 / 800, 540 / 600, 292 / 800] },
      { kind: 'image', normalizedRect: [60 / 600, 350 / 800, 270 / 600, 500 / 800] },
      { kind: 'path', normalizedRect: [330 / 600, 350 / 800, 540 / 600, 500 / 800] }
    ]
  }
  expect(nativeCaptionedRasterFullWidth(page, caption, [caption], [])?.rect).toEqual([
    60, 80, 540, 292
  ])
  expect(associateFigures(page, [caption], [], [], [], [])[0]).toMatchObject({
    rect: [60, 80, 540, 292],
    reason: 'native-raster-full-width'
  })
})

const upperRasterPanelPage = (): ReturnType<typeof JSON.parse> => {
  const caption = {
    page: 1,
    lines: ['Figure 1. Composite response panels.'],
    rect: [50, 268, 550, 282]
  }
  const upper = {
    kind: 'image',
    imageHash: 'anonymous-upper-panel',
    normalizedRect: [60 / 600, 20 / 800, 220 / 600, 55 / 800]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 50, y: 268, width: 500, height: 10, fontSize: 10 }],
    graphicsBounds: [
      { kind: 'image', normalizedRect: [60 / 600, 60 / 800, 540 / 600, 260 / 800] },
      upper
    ]
  }
  return { page, caption, upper }
}

it.each([
  ['full-width', nativeCaptionedRasterFullWidth],
  ['ordinary', nativeCaptionedRaster]
] as const)('preserves a connected upper panel in the %s raster matcher', (_name, match) => {
  const { page, caption } = upperRasterPanelPage()
  expect(match(page, caption, [caption], [])).toMatchObject({
    rect: [60, 20, 540, 260],
    graphicsCount: 2
  })
})

it.each([
  ['full-width', nativeCaptionedRasterFullWidth],
  ['ordinary', nativeCaptionedRaster]
] as const)('excludes independent upper images in the %s raster matcher', (_name, match) => {
  for (const barrier of [
    'detached',
    'misaligned',
    'prose',
    'table',
    'caption',
    'margin',
    'ambiguous'
  ]) {
    const { page, caption, upper } = upperRasterPanelPage()
    const tables = barrier === 'table' ? [[60, 55, 220, 60]] : []
    const captions =
      barrier === 'caption'
        ? [caption, { page: 1, lines: ['Figure 2. Independent panel.'], rect: [60, 55, 220, 60] }]
        : [caption]
    const source = {
      ...page,
      ...(barrier === 'margin' ? { marginRuleBounds: [[0.1, 0.07, 0.9, 0.071]] } : {}),
      lines:
        barrier === 'prose'
          ? [
              ...page.lines,
              {
                text: 'Independent running header',
                x: 60,
                y: 55,
                width: 160,
                height: 5,
                fontSize: 5
              }
            ]
          : page.lines,
      graphicsBounds: [
        page.graphicsBounds[0],
        {
          ...upper,
          normalizedRect:
            barrier === 'detached'
              ? [30 / 600, 8 / 800, 120 / 600, 30 / 800]
              : barrier === 'misaligned'
                ? [90 / 600, 20 / 800, 250 / 600, 55 / 800]
                : upper.normalizedRect
        },
        ...(barrier === 'ambiguous'
          ? [
              {
                ...upper,
                imageHash: 'another-upper-panel',
                normalizedRect: [380 / 600, 20 / 800, 540 / 600, 55 / 800]
              }
            ]
          : [])
      ]
    }
    expect(match(source, caption, captions, tables), barrier).toMatchObject({
      rect: [60, 60, 540, 260],
      graphicsCount: 1
    })
  }
})

it('uses painted bounds when proving an upper raster panel', () => {
  const { page, caption, upper } = upperRasterPanelPage()
  const source = {
    ...page,
    graphicsBounds: [
      page.graphicsBounds[0],
      {
        ...upper,
        normalizedRect: [0, 0, 0.9, 55 / 800],
        paintedNormalizedRect: upper.normalizedRect
      }
    ]
  }
  expect(nativeCaptionedRasterFullWidth(source, caption, [caption], [])?.rect).toEqual([
    60, 20, 540, 260
  ])
})

it.each([
  ['full-width', nativeCaptionedRasterFullWidth],
  ['ordinary', nativeCaptionedRaster]
] as const)('keeps a substantial leading inset in the %s raster matcher', (_name, match) => {
  const { page, caption, upper } = upperRasterPanelPage()
  const source = {
    ...page,
    graphicsBounds: [
      page.graphicsBounds[0],
      {
        ...upper,
        normalizedRect: [35 / 600, 5 / 800, 175 / 600, 35 / 800]
      }
    ]
  }
  expect(match(source, caption, [caption], [])).toMatchObject({
    rect: [35, 5, 540, 260],
    graphicsCount: 2
  })
  for (const barrier of ['too small', 'insufficient containment', 'large gap', 'body text']) {
    const blocked = {
      ...source,
      lines:
        barrier === 'body text'
          ? [
              ...page.lines,
              { text: 'Independent header', x: 60, y: 40, width: 115, height: 10, fontSize: 10 }
            ]
          : page.lines,
      graphicsBounds: [
        page.graphicsBounds[0],
        {
          ...upper,
          normalizedRect:
            barrier === 'too small'
              ? [35 / 600, 5 / 800, 145 / 600, 35 / 800]
              : barrier === 'insufficient containment'
                ? [30 / 600, 5 / 800, 145 / 600, 35 / 800]
                : barrier === 'large gap'
                  ? [35 / 600, 0, 175 / 600, 28 / 800]
                  : source.graphicsBounds[1].normalizedRect
        }
      ]
    }
    expect(match(blocked, caption, [caption], []), barrier).toMatchObject({
      rect: [60, 60, 540, 260],
      graphicsCount: 1
    })
  }
})

function narrowBarFigure(label = 'Figure'): ReturnType<typeof JSON.parse> {
  const caption = {
    page: 1,
    lines: [`${label} 3 Expert-relative performance.`],
    rect: [330, 305, 545, 320]
  }
  const bars = Array.from({ length: 10 }, (_, index) => ({
    kind: 'path',
    normalizedRect: [
      (380 + index * 14) / 600,
      (150 + (index % 4) * 15) / 800,
      (390 + index * 14) / 600,
      280 / 800
    ]
  }))
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      { text: caption.lines[0], x: 330, y: 305, width: 215, height: 10, fontSize: 10 },
      ...['0', '50', '100', '150'].map((text, index) => ({
        text,
        x: 355,
        y: 270 - index * 35,
        width: 18,
        height: 10,
        fontSize: 10
      })),
      ...['Model A', 'Model B', 'Model C'].map((text, index) => ({
        text,
        x: 390 + index * 45,
        y: 285,
        width: 35,
        height: 10,
        fontSize: 10
      }))
    ],
    graphicsBounds: [
      { kind: 'path', normalizedRect: [330 / 600, 100 / 800, 540 / 600, 280 / 800] },
      ...bars
    ]
  }
  return { page, caption }
}
it.each(['Figure', 'Fig.'])(
  'recovers a narrow vector bar chart with the native %s label',
  (label) => {
    const { page, caption } = narrowBarFigure(label)
    expect(nativeCaptionedVectorBarChart(page, caption, [caption], [])?.rect).toEqual([
      330, 100, 540, 295
    ])
    expect(associateFigures(page, [caption], [], [], [], [])[0]).toMatchObject({
      rect: [330, 100, 540, 295],
      graphicsCount: 11
    })
  }
)
function mergedBarAxis(): ReturnType<typeof JSON.parse> {
  const f = narrowBarFigure('Fig.')
  f.page.lines = f.page.lines.filter((line: { text: string }) => !/^\d+$/.test(line.text))
  f.page.lines.push({
    text: '0 20 40 60 80 100',
    x: 330,
    y: 281,
    width: 210,
    height: 3,
    fontSize: 3
  })
  return {
    ...f,
    rules: [
      [330, 280, 540, 280],
      [330, 100, 330, 280]
    ]
  }
}
it('recovers a merged numeric axis only beside its unique native perpendicular rules', () => {
  const f = mergedBarAxis()
  expect(nativeCaptionedVectorBarChart(f.page, f.caption, [f.caption], [], f.rules)?.rect).toEqual([
    330, 100, 540, 295
  ])
  expect(associateFigures(f.page, [f.caption], [], f.rules)[0].rect).toEqual([330, 100, 540, 295])
})
it.each([false, true])(
  'keeps separately captioned merged-axis charts complete (reverse captions: %s)',
  (reverse) => {
    const right = mergedBarAxis(),
      left = mergedBarAxis()
    left.caption.lines = ['Fig. 4 Independent comparison.']
    left.caption.rect = left.caption.rect.map((v: number, i: number) => v - (i % 2 ? 0 : 280))
    left.page.lines[0].text = left.caption.lines[0]
    for (const line of left.page.lines) line.x -= 280
    for (const graphic of left.page.graphicsBounds)
      graphic.normalizedRect = graphic.normalizedRect.map(
        (v: number, i: number) => v - (i % 2 ? 0 : 280 / left.page.width)
      )
    left.rules = left.rules.map((rule: number[]) => rule.map((v, i) => v - (i % 2 ? 0 : 280)))
    right.page.lines.push(...left.page.lines)
    right.page.graphicsBounds.push(...left.page.graphicsBounds)
    const captions = [left.caption, right.caption]
    if (reverse) captions.reverse()
    const input = structuredClone({ page: right.page, captions }),
      figures = associateFigures(right.page, captions, [], [...left.rules, ...right.rules])
    expect(
      figures.find((figure: { caption: unknown }) => figure.caption === left.caption)?.rect
    ).toEqual([50, 100, 260, 295])
    expect(
      figures.find((figure: { caption: unknown }) => figure.caption === right.caption)?.rect
    ).toEqual([330, 100, 540, 295])
    expect({ page: right.page, captions }).toEqual(input)
  }
)
it.each(['no-rule', 'duplicate-rule', 'nonmonotonic', 'too-short', 'inside-plot', 'unknown-paint'])(
  'rejects merged numeric text without complete axis evidence: %s',
  (variant) => {
    const f = mergedBarAxis(),
      tick = f.page.lines.at(-1)
    if (variant === 'no-rule') f.rules.pop()
    if (variant === 'duplicate-rule') f.rules.push([...f.rules[0]])
    if (variant === 'nonmonotonic') tick.text = '0 20 40 30 80 100'
    if (variant === 'too-short') tick.width = 50
    if (variant === 'inside-plot') tick.y = 200
    if (variant === 'unknown-paint') f.page.invalidGraphicsBounds = 1
    expect(
      nativeCaptionedVectorBarChart(f.page, f.caption, [f.caption], [], f.rules)
    ).toBeUndefined()
  }
)
it('keeps raster recovery deferred when a path touches the image', () => {
  const fixture = wideRasterWithUnrelatedPaths()
  fixture.page.graphicsBounds.push({
    kind: 'path',
    normalizedRect: [0.2, 0.15, 0.3, 0.2]
  })
  expect(
    nativeCaptionedRaster(fixture.page, fixture.caption, [fixture.caption], [])
  ).toBeUndefined()
})
const fragmentedPlate = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids/fragmented-lettered-raster-plate.jsonl'))
it('recovers a unique 2x2 raster plate when its Fig.2 prefix is split from the caption', () => {
  const f = fragmentedPlate()
  const match = nativeCaptionedRasterArrayFragment(f.page, f.caption, [f.caption], [])
  expect(match?.rect).toEqual([60, 40, 480, 400])
  expect(match?.caption).toBe(f.caption)
  expect(match?.captionLines?.[0]).toMatch(/^Fig\.2\./)
  expect(match?.captionRect).toEqual(expect.arrayContaining([f.caption.rect[0], f.caption.rect[1]]))
  expect(associateFigures(f.page, [f.caption], [], [], [], [])[0].rect).toEqual([60, 40, 480, 400])
})
it('does not apply fragmented raster recovery to an open vector plot', () => {
  const f = fragmentedPlate()
  f.page.graphicsBounds = [
    { kind: 'path', normalizedRect: [0.1, 0.1, 0.8, 0.6] },
    { kind: 'path', normalizedRect: [0.2, 0.2, 0.7, 0.5] }
  ]
  expect(nativeCaptionedRasterArrayFragment(f.page, f.caption, [f.caption], [])).toBeUndefined()
})
it('recovers a framed text figure when the body font is close to the caption font', () => {
  const caption = { page: 1, lines: ['Figure 8. Verification prompt.'], rect: [50, 295, 550, 325] }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      { text: caption.lines[0], x: 50, y: 295, width: 500, height: 10, fontSize: 10 },
      ...Array.from({ length: 4 }, (_, index) => ({
        text: `A framed verification instruction line ${index} with enough text to prove ownership.`,
        x: 80,
        y: 100 + index * 20,
        width: 420,
        height: 9,
        fontSize: 9
      }))
    ],
    graphicsBounds: [
      { kind: 'path', normalizedRect: [0.1, 0.1, 0.9, 0.35] },
      { kind: 'path', normalizedRect: [0.1, 0.12, 0.9, 0.35] }
    ]
  }
  expect(nativeCaptionedTextIllustration(page, caption, [caption], [])?.rect).toEqual([
    60, 80, 540, 280
  ])
})
it('recovers a text figure whose frame is drawn as four aligned segments', () => {
  const caption = { page: 1, lines: ['Figure 9. Constructed checks.'], rect: [50, 295, 550, 325] }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      { text: caption.lines[0], x: 50, y: 295, width: 500, height: 10, fontSize: 10 },
      ...Array.from({ length: 5 }, (_, index) => ({
        text: `A framed check line ${index} keeps enough explanatory text for ownership.`,
        x: 80,
        y: 100 + index * 20,
        width: 420,
        height: 10,
        fontSize: 10
      }))
    ],
    graphicsBounds: [
      { kind: 'path', normalizedRect: [60 / 600, 80 / 800, 540 / 600, 90 / 800] },
      { kind: 'path', normalizedRect: [60 / 600, 270 / 800, 540 / 600, 280 / 800] },
      { kind: 'path', normalizedRect: [60 / 600, 80 / 800, 70 / 600, 280 / 800] },
      { kind: 'path', normalizedRect: [530 / 600, 80 / 800, 540 / 600, 280 / 800] }
    ]
  }
  expect(nativeCaptionedTextIllustration(page, caption, [caption], [])?.rect).toEqual([
    60, 80, 540, 280
  ])
})
it('recovers a text-only figure bounded by two aligned horizontal rules', () => {
  const caption = { page: 1, lines: ['Figure 11: Prompt template.'], rect: [50, 295, 550, 325] }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      ...Array.from({ length: 5 }, (_, index) => ({
        text: `Prompt instruction line ${index} contains enough monospaced text to prove the bounded figure body.`,
        x: 80,
        y: 100 + index * 30,
        width: 420,
        height: 10,
        fontSize: 10
      })),
      { text: caption.lines[0], x: 50, y: 295, width: 500, height: 10, fontSize: 10 }
    ],
    graphicsBounds: [
      { kind: 'path', normalizedRect: [60 / 600, 80 / 800, 540 / 600, 90 / 800] },
      { kind: 'path', normalizedRect: [60 / 600, 270 / 800, 540 / 600, 280 / 800] }
    ]
  }
  expect(nativeCaptionedTextIllustration(page, caption, [caption], [])?.rect).toEqual([
    60, 80, 540, 280
  ])
})
it('rejects a segmented frame that overlaps a table crop', () => {
  const caption = { page: 1, lines: ['Figure 10. Framed table.'], rect: [50, 295, 550, 325] }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      { text: caption.lines[0], x: 50, y: 295, width: 500, height: 10, fontSize: 10 },
      ...Array.from({ length: 5 }, (_, index) => ({
        text: `A framed table row ${index} with enough explanatory text for ownership.`,
        x: 80,
        y: 100 + index * 20,
        width: 420,
        height: 10,
        fontSize: 10
      }))
    ],
    graphicsBounds: [
      { kind: 'path', normalizedRect: [60 / 600, 80 / 800, 540 / 600, 90 / 800] },
      { kind: 'path', normalizedRect: [60 / 600, 270 / 800, 540 / 600, 280 / 800] },
      { kind: 'path', normalizedRect: [60 / 600, 80 / 800, 70 / 600, 280 / 800] },
      { kind: 'path', normalizedRect: [530 / 600, 80 / 800, 540 / 600, 280 / 800] }
    ]
  }
  expect(
    nativeCaptionedTextIllustration(page, caption, [caption], [[60, 80, 540, 280]])
  ).toBeUndefined()
})
it.each([
  'missing-key',
  'broken-key',
  'duplicate-key',
  'wrong-sequence',
  'foreign-prose',
  'table',
  'caption'
])('declines unproved lettered plates: %s', (reason) => {
  const f = plate(),
    tables: number[][] = [],
    captions = [f.caption]
  if (reason === 'missing-key') f.tokens.pop()
  if (reason === 'broken-key') f.tokens[2].baseline += 2
  if (reason === 'duplicate-key') f.tokens.push({ ...f.tokens.at(-1) })
  if (reason === 'wrong-sequence') f.caption.lines[0] = f.caption.lines[0].replace('(f)', '(g)')
  if (reason === 'foreign-prose')
    f.tokens.push({
      text: 'Independent source paragraph inside the crop area.',
      rect: [100, 260, 450, 270],
      horizontal: true,
      height: 10,
      baseline: 270
    })
  if (reason === 'table') tables.push([300, 300, 400, 400])
  if (reason === 'caption')
    captions.push({ page: 1, lines: ['Figure 2. Other.'], rect: [40, 300, 180, 310] })
  expect(nativeLetteredRasterArray(f.page, f.caption, captions, tables, f.tokens)).toBeUndefined()
})
const illustratedText = (): ReturnType<typeof JSON.parse> => {
  const caption = { page: 1, lines: ['Figure 2. Source illustration.'], rect: [50, 180, 550, 190] }
  return {
    caption,
    page: {
      pageNumber: 1,
      width: 600,
      height: 800,
      invalidGraphicsBounds: 0,
      lines: [
        ...Array.from({ length: 7 }, (_, i) => ({
          text: `${i}: ${'Synthetic text '.repeat(6)}`,
          x: 80,
          y: 75 + i * 12,
          width: 430,
          height: 5,
          fontSize: 5
        })),
        { text: caption.lines[0], x: 50, y: 180, width: 500, height: 10, fontSize: 10 }
      ],
      graphicsBounds: [{ kind: 'path', normalizedRect: [50 / 600, 65 / 800, 550 / 600, 175 / 800] }]
    }
  }
}
it.each(['body-font', 'table', 'competing-caption', 'far-caption', 'incomplete-content'])(
  'declines an unproved text illustration: %s',
  (reason) => {
    const f = illustratedText(),
      tables: number[][] = [],
      captions = [f.caption]
    if (reason === 'body-font')
      f.page.lines.slice(0, 7).forEach((line: { fontSize?: number }) => (line.fontSize = 10))
    if (reason === 'table') tables.push([50, 80, 550, 150])
    if (reason === 'competing-caption')
      captions.push({ page: 1, lines: ['Figure 3. Other.'], rect: [60, 90, 200, 100] })
    if (reason === 'far-caption') f.caption.rect[1] = 230
    if (reason === 'incomplete-content') f.page.lines = f.page.lines.slice(-3)
    expect(nativeCaptionedTextIllustration(f.page, f.caption, captions, tables)).toBeUndefined()
  }
)

// A complete three-font parameter label belongs to its separately painted panel.
const lowerParameterPair = (): ReturnType<typeof JSON.parse> => {
  const caption = { page: 1, lines: ['Figure 1. Paired panels.'], rect: [100, 270, 470, 280] }
  const tokens = [170, 360].flatMap((x, n) =>
    ['(' + 'ab'[n] + ')', 'r', '= ' + (n + 2)].map((text, i) => {
      const left = x + [0, 16, 25][i],
        width = [12, 6, 14][i]
      return {
        text,
        rect: [left, 251, left + width, 260],
        horizontal: true,
        height: 9,
        baseline: 260,
        fontDescent: -0.2,
        sourceItem: { pageNumber: 1, text, index: n * 3 + i }
      }
    })
  )
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      { text: caption.lines[0], x: 100, y: 270, width: 370, height: 10, fontSize: 10 },
      ...[0, 1].map((n) => ({
        text: tokens
          .slice(n * 3, n * 3 + 3)
          .map((t) => t.text)
          .join(''),
        x: tokens[n * 3].rect[0],
        y: 251,
        width: 39,
        height: 9,
        fontSize: 9
      }))
    ],
    graphicsBounds: [100, 290].map((x, n) => ({
      kind: 'image',
      imageHash: 'panel-' + n,
      normalizedRect: [x / 600, 90 / 800, (x + 180) / 600, 245 / 800],
      paintedNormalizedRect: [x / 600, 90 / 800, (x + 180) / 600, 245 / 800]
    }))
  }
  return { page, caption, tokens }
}
it('includes complete whole-font lower parameter labels and their descenders', () => {
  const f = lowerParameterPair()
  expect(
    nativeCaptionedAlignedRasterPair(f.page, f.caption, [f.caption], [], [], f.tokens)?.rect
  ).toEqual([100, 90, 470, 261.8])
})
it('refuses partial, foreign, fragmented and competing lower parameter labels', () => {
  const mutations = [
    (f: ReturnType<typeof lowerParameterPair>) => {
      f.tokens[1].sourceItem.pageNumber = 2
    },
    (f: ReturnType<typeof lowerParameterPair>) => {
      f.tokens.push({ ...structuredClone(f.tokens[1]), rect: [110, 110, 116, 119] })
    },
    (f: ReturnType<typeof lowerParameterPair>) => {
      f.tokens.pop()
    },
    (f: ReturnType<typeof lowerParameterPair>) => {
      f.tokens[1].sourceItem.text = 'other'
    },
    (f: ReturnType<typeof lowerParameterPair>) => {
      Object.assign(f.tokens[1], { sourceToken: {} })
    },
    (f: ReturnType<typeof lowerParameterPair>) => {
      f.tokens[4].text = 's'
      f.tokens[4].sourceItem.text = 's'
    },
    (f: ReturnType<typeof lowerParameterPair>) => {
      f.tokens[5].sourceItem.index = 2
    },
    (f: ReturnType<typeof lowerParameterPair>) => {
      f.tokens[2].text = '= '
      f.tokens[2].sourceItem.text = '= '
    },
    (f: ReturnType<typeof lowerParameterPair>) => {
      f.tokens[0].rect[2] = 300
    },
    (f: ReturnType<typeof lowerParameterPair>) => {
      f.page.graphicsBounds.push({
        kind: 'image',
        imageHash: 'foreign',
        normalizedRect: [0.45, 0.31, 0.48, 0.325],
        paintedNormalizedRect: [0.45, 0.31, 0.48, 0.325]
      })
    },
    (f: ReturnType<typeof lowerParameterPair>) => {
      f.page.lines.push({ text: 'unowned', x: 250, y: 251, width: 20, height: 9, fontSize: 9 })
    }
  ]
  for (const change of mutations) {
    const f = lowerParameterPair()
    change(f)
    expect(
      nativeCaptionedAlignedRasterPair(f.page, f.caption, [f.caption], [], [], f.tokens)
    ).toBeUndefined()
  }
  const f = lowerParameterPair()
  expect(
    nativeCaptionedAlignedRasterPair(
      f.page,
      f.caption,
      [f.caption],
      [[150, 250, 220, 265]],
      [],
      f.tokens
    )
  ).toBeUndefined()
  const other = { page: 1, lines: ['Table 1. Separate labels.'], rect: [150, 250, 220, 265] }
  expect(
    nativeCaptionedAlignedRasterPair(f.page, f.caption, [f.caption, other], [], [], f.tokens)
  ).toBeUndefined()
})

// A compact anonymous grid preserves only two enclosing frames and their titles.
function frameTitleGrid(): ReturnType<typeof JSON.parse> {
  const width = 600,
    height = 800,
    caption = { page: 1, lines: ['Figure 2. Composite workflow.'], rect: [150, 260, 450, 270] },
    frames = [
      [85, 95, 245, 254],
      [250, 95, 405, 254]
    ]
  const token = (text: string, rect: number[], index: number): ReturnType<typeof JSON.parse> => ({
    text,
    rect,
    height: rect[3] - rect[1],
    baseline: rect[3],
    horizontal: true,
    sourceItem: { pageNumber: 1, index, text }
  })
  const fonts = [
    token('Object Sequence Panel', [110, 96, 210, 102.5], 0),
    token('Interaction Panel', [280, 96, 375, 102.5], 1),
    token(caption.lines[0], caption.rect, 2)
  ]
  const graphics = []
  for (let row = 0; row < 4; row++)
    for (const x of [90, 170, 260, 335, 430])
      graphics.push({
        kind: 'image',
        normalizedRect: [
          x / width,
          (104 + row * 40) / height,
          (x + 50) / width,
          (134 + row * 40) / height
        ]
      })
  for (const r of frames)
    graphics.push({ kind: 'path', normalizedRect: r.map((v, n) => v / (n % 2 ? height : width)) })
  const page = {
    pageNumber: 1,
    width,
    height,
    invalidGraphicsBounds: 0,
    graphicsBounds: graphics,
    lines: fonts.map((f) => ({
      text: f.text,
      x: f.rect[0],
      y: f.rect[1],
      width: f.rect[2] - f.rect[0],
      height: f.height,
      fontSize: f.height
    }))
  }
  return { page, caption, frames, fonts }
}

it('completes two native closed-frame titles without extending the result lane', () => {
  const x = frameTitleGrid(),
    result = associateFigures(x.page, [x.caption], [], [], x.frames, x.fonts)[0]
  expect(result.reason).toBe('native-raster-composite-grid')
  expect(result.rect).toEqual([85, 95, 480, 254])
  expect(result.caption).toBe(x.caption)
})

it.each([
  [
    'missing title',
    (x: ReturnType<typeof JSON.parse>) => {
      x.fonts.splice(0, 1)
    }
  ],
  [
    'duplicate source',
    (x: ReturnType<typeof JSON.parse>) => {
      x.fonts.push({ ...x.fonts[0] })
    }
  ],
  [
    'foreign native body',
    (x: ReturnType<typeof JSON.parse>) => {
      x.fonts.push({
        text: 'Foreign body',
        rect: [430, 96, 470, 102],
        height: 6,
        baseline: 102,
        horizontal: true,
        sourceItem: { pageNumber: 1, index: 3, text: 'Foreign body' }
      })
    }
  ],
  [
    'missing frame',
    (x: ReturnType<typeof JSON.parse>) => {
      x.frames.pop()
    }
  ],
  [
    'outside title',
    (x: ReturnType<typeof JSON.parse>) => {
      x.fonts[0].rect = [110, 85, 210, 91.5]
    }
  ],
  [
    'title source mismatch',
    (x: ReturnType<typeof JSON.parse>) => {
      x.fonts[0].sourceItem.text = 'Unknown'
    }
  ],
  [
    'rotated title',
    (x: ReturnType<typeof JSON.parse>) => {
      x.fonts[0].horizontal = false
    }
  ],
  [
    'invalid native paint',
    (x: ReturnType<typeof JSON.parse>) => {
      x.page.invalidGraphicsBounds = 1
    }
  ],
  [
    'independent strip path',
    (x: ReturnType<typeof JSON.parse>) => {
      x.page.graphicsBounds.push({
        kind: 'path',
        normalizedRect: [430 / 600, 96 / 800, 470 / 600, 102 / 800]
      })
    }
  ],
  [
    'grazing strip path',
    (x: ReturnType<typeof JSON.parse>) => {
      x.page.graphicsBounds.push({
        kind: 'path',
        normalizedRect: [430 / 600, 96 / 800, 470 / 600, 106 / 800]
      })
    }
  ],
  [
    'competing caption',
    (x: ReturnType<typeof JSON.parse>) => {
      x.otherCaption = { page: 1, lines: ['Figure 3. Separate.'], rect: [110, 96, 210, 102] }
    }
  ],
  [
    'overlapping table',
    (x: ReturnType<typeof JSON.parse>) => {
      x.tables = [[110, 96, 210, 102]]
    }
  ]
])('refuses a frame-title completion with %s', (_name, mutate) => {
  const x = frameTitleGrid()
  mutate(x)
  const result = associateFigures(
    x.page,
    [x.caption, ...(x.otherCaption ? [x.otherCaption] : [])],
    x.tables ?? [],
    [],
    x.frames,
    x.fonts
  ).find((f: ReturnType<typeof JSON.parse>) => f.caption === x.caption)
  expect(result?.rect?.[1]).not.toBe(95)
})

// A single white Form background and two stroked rectangular frames suffice.
// These synthetic operators retain no original document or model output.
function frameTitlePaintGrid(): ReturnType<typeof JSON.parse> {
  const x = frameTitleGrid(),
    operators: ReturnType<typeof JSON.parse> = { fnArray: [], argsArray: [] }
  const emit = (code: number, args: unknown): number => {
    operators.fnArray.push(code)
    operators.argsArray.push(args)
    return operators.fnArray.length - 1
  }
  const rectPath = (r: number[]): number[] => [
    0,
    r[0],
    r[1],
    1,
    r[2],
    r[1],
    1,
    r[2],
    r[3],
    1,
    r[0],
    r[3],
    4
  ]
  const quant = (r: number[]): number[] =>
    r.map(
      (v, n) =>
        (n < 2
          ? Math.floor(((v * 1.5) / Math.ceil((n % 2 ? 800 : 600) * 1.5)) * 256)
          : Math.ceil(((v * 1.5) / Math.ceil((n % 2 ? 800 : 600) * 1.5)) * 256) + 1) / 256
    )
  emit(OPS.transform, [1, 0, 0, 1, 80, 540])
  emit(OPS.save, null)
  emit(OPS.beginGroup, [
    { matrix: null, bbox: [0, 0, 410, 170], smask: null, isolated: false, knockout: false }
  ])
  emit(OPS.paintFormXObjectBegin, [null, null])
  emit(OPS.beginMarkedContent, [{ name: 'Artifact' }])
  emit(OPS.save, null)
  emit(OPS.eoClip, null)
  emit(OPS.constructPath, [OPS.endPath, [rectPath([0, 0, 410, 170])], [0, 0, 410, 170]])
  x.alphaIndex = emit(OPS.setGState, [
    [
      ['BM', 'source-over'],
      ['ca', 1]
    ]
  ])
  x.whiteIndex = emit(OPS.setFillRGBColor, ['#ffffff'])
  x.backgroundIndex = emit(OPS.constructPath, [
    OPS.eoFill,
    [rectPath([0, 0, 410, 170])],
    [0, 0, 410, 170]
  ])
  emit(OPS.restore, null)
  emit(OPS.endMarkedContent, null)
  const paints = [
    { kind: 'path', operationIndex: x.backgroundIndex, normalizedRect: quant([80, 90, 490, 260]) }
  ]
  x.frameIndices = []
  for (const frame of x.frames) {
    const r = [frame[0] - 80, 260 - frame[3], frame[2] - 80, 260 - frame[1]]
    emit(OPS.save, null)
    emit(OPS.setLineWidth, [1.5])
    emit(OPS.setStrokeRGBColor, ['#777777'])
    emit(OPS.setDash, [[1.5, 1.5], 0])
    const index = emit(OPS.constructPath, [OPS.stroke, [rectPath(r)], r])
    x.frameIndices.push(index)
    paints.push({
      kind: 'path',
      operationIndex: index,
      normalizedRect: quant(frame.map((v: number, n: number) => v + (n < 2 ? -0.75 : 0.75)))
    })
    emit(OPS.restore, null)
  }
  emit(OPS.paintFormXObjectEnd, null)
  emit(OPS.endGroup, null)
  emit(OPS.restore, null)
  x.page.graphicsBounds = [
    ...paints,
    ...x.page.graphicsBounds.filter((g: ReturnType<typeof JSON.parse>) => g.kind === 'image')
  ]
  x.context = {
    operators,
    viewport: { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] },
    content: { items: x.fonts.map((f: ReturnType<typeof JSON.parse>) => ({ str: f.text })) }
  }
  return x
}

it('completes frame titles with specific native white background and border paint', () => {
  const x = frameTitlePaintGrid(),
    match = associateFigures(x.page, [x.caption], [], [], x.frames, x.fonts, x.context)[0]
  expect(match.reason).toBe('native-raster-composite-grid')
  expect(match.rect).toEqual([85, 95, 480, 254])
})

it('completes frame titles with the complete multi-page caption provider', () => {
  const x = frameTitlePaintGrid(),
    other = { page: 2, lines: ['Figure 2. Independent page.'], rect: [110, 96, 210, 102] },
    match = associateFigures(x.page, [x.caption, other], [], [], x.frames, x.fonts, x.context)[0]
  expect(match.rect).toEqual([85, 95, 480, 254])
})

function frameTitleNativePaintGrid(): ReturnType<typeof JSON.parse> {
  const x = frameTitlePaintGrid()
  x.context.operators.argsArray.forEach((args: ReturnType<typeof JSON.parse>, n: number) => {
    if (x.context.operators.fnArray[n] !== OPS.constructPath) return
    args[1][0] = new Float32Array(args[1][0])
    args[2] = new Float32Array(args[2])
  })
  return x
}

it('completes frame titles with original native Float32Array path bounds', () => {
  const x = frameTitleNativePaintGrid(),
    match = associateFigures(x.page, [x.caption], [], [], x.frames, x.fonts, x.context)[0]
  expect(match.rect).toEqual([85, 95, 480, 254])
})

it.each([
  [
    'nonfinite native bounds',
    (x: ReturnType<typeof JSON.parse>) => {
      x.context.operators.argsArray[x.backgroundIndex][2][0] = NaN
    }
  ],
  [
    'inconsistent native bounds',
    (x: ReturnType<typeof JSON.parse>) => {
      x.context.operators.argsArray[x.backgroundIndex][2][0] = 1
    }
  ],
  [
    'incomplete native bounds',
    (x: ReturnType<typeof JSON.parse>) => {
      x.context.operators.argsArray[x.backgroundIndex][2] = new Float32Array([0, 0, 410])
    }
  ],
  [
    'foreign numeric view',
    (x: ReturnType<typeof JSON.parse>) => {
      x.context.operators.argsArray[x.backgroundIndex][2] = new Float64Array([0, 0, 410, 170])
    }
  ],
  [
    'same-page competing caption',
    (x: ReturnType<typeof JSON.parse>) => {
      x.otherCaption = { page: 1, lines: ['Figure 2. Separate.'], rect: [110, 96, 210, 102] }
    }
  ]
])('keeps the original native crop with %s', (_name, mutate) => {
  const x = frameTitleNativePaintGrid()
  mutate(x)
  const match = associateFigures(
    x.page,
    [x.caption, ...(x.otherCaption ? [x.otherCaption] : [])],
    [],
    [],
    x.frames,
    x.fonts,
    x.context
  )[0]
  expect(match.rect).toEqual([90, 104, 480, 254])
})

it.each([
  [
    'large foreign path overlapping most of the old body',
    (x: ReturnType<typeof JSON.parse>) =>
      x.page.graphicsBounds.push({
        kind: 'path',
        normalizedRect: [85 / 600, 96 / 800, 470 / 600, 230 / 800]
      })
  ],
  [
    'nonopaque white paint',
    (x: ReturnType<typeof JSON.parse>) => {
      x.context.operators.argsArray[x.alphaIndex] = [[['ca', 0.5]]]
    }
  ],
  [
    'colored background',
    (x: ReturnType<typeof JSON.parse>) => {
      x.context.operators.argsArray[x.whiteIndex] = ['#eeeeee']
    }
  ],
  [
    'missing actual source context',
    (x: ReturnType<typeof JSON.parse>) => {
      x.context.content.items = []
    }
  ],
  [
    'foreign source context',
    (x: ReturnType<typeof JSON.parse>) => {
      x.context.content.items[0].str = 'Independent text'
    }
  ],
  [
    'foreign background index',
    (x: ReturnType<typeof JSON.parse>) => {
      x.page.graphicsBounds[0].operationIndex++
    }
  ],
  [
    'duplicate background owner',
    (x: ReturnType<typeof JSON.parse>) => {
      x.page.graphicsBounds.push({ ...x.page.graphicsBounds[0] })
    }
  ],
  [
    'missing clip',
    (x: ReturnType<typeof JSON.parse>) => {
      x.context.operators.fnArray[6] = OPS.endPath
    }
  ],
  [
    'wrong source matrix',
    (x: ReturnType<typeof JSON.parse>) => {
      x.context.operators.argsArray[0] = [1, 0, 0, 1, 80, 535]
    }
  ],
  [
    'transform after clip',
    (x: ReturnType<typeof JSON.parse>) => {
      x.context.operators.fnArray[8] = OPS.transform
      x.context.operators.argsArray[8] = [1, 0, 0, 1, 1, 0]
    }
  ],
  [
    'different active frame transform',
    (x: ReturnType<typeof JSON.parse>) => {
      x.context.operators.fnArray[x.frameIndices[0] - 4] = OPS.transform
      x.context.operators.argsArray[x.frameIndices[0] - 4] = [1, 0, 0, 1, 1, 0]
    }
  ],
  [
    'source restore underflow',
    (x: ReturnType<typeof JSON.parse>) => {
      x.context.operators.fnArray.push(OPS.restore)
      x.context.operators.argsArray.push(null)
    }
  ]
])('keeps the original raster-grid crop with %s', (_name, mutate) => {
  const x = frameTitlePaintGrid()
  mutate(x)
  const match = associateFigures(x.page, [x.caption], [], [], x.frames, x.fonts, x.context)[0]
  expect(match.rect).toEqual([90, 104, 480, 254])
})

const { nativeOwnedFormPaintBounds } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-owned-figure-labels.mjs')).href
)
function mixedFormPaint(): ReturnType<typeof JSON.parse> {
  const width = 600,
    height = 800,
    fnArray: number[] = [],
    argsArray: unknown[] = []
  const emit = (op: number, a: unknown): void => {
    fnArray.push(op)
    argsArray.push(a)
  }
  const rect = (x: number, y: number, w: number, h: number): void =>
    emit(OPS.constructPath, [
      OPS.fill,
      [[0, x, y, 1, x + w, y, 1, x + w, y + h, 1, x, y + h, 4]],
      [x, y, x + w, y + h]
    ])
  emit(OPS.paintFormXObjectBegin, [null, [80, 470, 520, 730]])
  emit(OPS.setFillRGBColor, ['#fffffe'])
  rect(100, 500, 400, 200)
  const images = [
    [120, 500, 100, 100],
    [360, 500, 100, 100]
  ]
  for (const [x, y, w, h] of images) {
    emit(OPS.save, null)
    emit(OPS.transform, [w, 0, 0, h, x, y])
    emit(OPS.paintImageXObject, ['image', w, h])
    emit(OPS.restore, null)
  }
  emit(OPS.paintFormXObjectEnd, null)
  const caption = { page: 1, lines: ['Figure 3. A mixed diagram.'], rect: [80, 340, 520, 350] }
  const page = {
    pageNumber: 1,
    width,
    height,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 80, y: 340, width: 440, height: 10, fontSize: 10 }],
    graphicsBounds: images.map(([x, y, w, h], i) => ({
      kind: 'image',
      operationIndex: 5 + i * 4,
      normalizedRect: [x / width, (height - y - h) / height, (x + w) / width, (height - y) / height]
    }))
  }
  return {
    page,
    caption,
    captions: [caption],
    tables: [],
    rect: [90, 180, 510, 320],
    context: {
      operators: { fnArray, argsArray },
      viewport: { width, height, scale: 1, rotation: 0, transform: [1, 0, 0, -1, 0, height] }
    }
  }
}
const ownedForm = (f: ReturnType<typeof JSON.parse>): unknown =>
  nativeOwnedFormPaintBounds(f.page, f.caption, f.captions, f.tables, f.rect, f.context)
it('restores opaque native frame paint owned by the same mixed Form, not its BBox', () => {
  const f = mixedFormPaint()
  expect(ownedForm(f)).toEqual([90, 100, 510, 320])
})
it.each([
  'white',
  'clipped',
  'unknown alpha',
  'late cover',
  'unbalanced',
  'other caption',
  'table',
  'unmatched image'
])('rejects mixed Form expansion for %s', (kind) => {
  const f = mixedFormPaint(),
    o = f.context.operators
  if (kind === 'white') o.argsArray[1] = ['#ffffff']
  if (kind === 'clipped') o.argsArray[0] = [null, [80, 470, 520, 610]]
  if (kind === 'unknown alpha') {
    o.fnArray.splice(2, 0, OPS.setGState)
    o.argsArray.splice(2, 0, [['ca', 0.5]])
  }
  if (kind === 'late cover') {
    o.fnArray.push(OPS.setFillRGBColor, OPS.constructPath)
    o.argsArray.push(
      ['#ffffff'],
      [OPS.fill, [[0, 0, 0, 1, 600, 0, 1, 600, 800, 1, 0, 800, 4]], [0, 0, 600, 800]]
    )
  }
  if (kind === 'unbalanced') {
    o.fnArray.pop()
    o.argsArray.pop()
  }
  if (kind === 'other caption')
    f.captions.push({ page: 1, lines: ['Figure 2. Other.'], rect: [90, 130, 510, 145] })
  if (kind === 'table') f.tables.push([90, 100, 510, 150])
  if (kind === 'unmatched image') f.page.graphicsBounds.pop()
  expect(ownedForm(f)).toBeUndefined()
})

it('uses tight cubic extrema rather than control points to validate source paths', () => {
  const f = mixedFormPaint(),
    o = f.context.operators
  o.fnArray.splice(-1, 0, OPS.constructPath)
  o.argsArray.splice(-1, 0, [
    OPS.fill,
    [[0, 150, 520, 2, 150, 560, 190, 560, 190, 520, 4]],
    [150, 520, 190, 550]
  ])
  expect(ownedForm(f)).toEqual([90, 100, 510, 320])
  o.argsArray[o.argsArray.length - 2][2] = [150, 520, 190, 560]
  expect(ownedForm(f)).toBeUndefined()
})
it('accepts a quarter-turn image with the same unique native paint owner', () => {
  const f = mixedFormPaint()
  f.context.operators.argsArray[4] = [0, -100, 100, 0, 120, 600]
  expect(ownedForm(f)).toEqual([90, 100, 510, 320])
})
it.each([
  'foreign operation',
  'negative image width',
  'nonfinite bounds',
  'skew image',
  'invalid path',
  'text clip'
])('rejects mixed Form evidence with %s', (kind) => {
  const f = mixedFormPaint(),
    o = f.context.operators
  if (kind === 'foreign operation') f.page.graphicsBounds[0].operationIndex++
  if (kind === 'negative image width') f.page.graphicsBounds[0].normalizedRect[2] = 0
  if (kind === 'nonfinite bounds') o.argsArray[2][2][1] = Infinity
  if (kind === 'skew image') o.argsArray[4] = [100, 10, 0, 100, 120, 500]
  if (kind === 'invalid path') o.argsArray[2][1][0][2] = NaN
  if (kind === 'text clip') {
    o.fnArray.push(OPS.setTextRenderingMode)
    o.argsArray.push([7])
  }
  expect(ownedForm(f)).toBeUndefined()
})

const { nativeOwnedFigureBottomLabels } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-owned-figure-labels.mjs')).href
)
function cutRasterLabels(): ReturnType<typeof JSON.parse> {
  const f = mixedFormPaint()
  f.rect = [90, 100, 510, 305]
  f.page.graphicsBounds = [0, 1, 2].map((i) => ({
    kind: 'image',
    imageHash: 'raster',
    normalizedRect: [(100 + i * 135) / 600, 100 / 800, (220 + i * 135) / 600, 310 / 800]
  }))
  f.tokens = [0, 1, 2].map((i) => ({
    text: 'Label ' + i,
    rect: [120 + i * 135, 303, 200 + i * 135, 315],
    horizontal: true,
    height: 12,
    baseline: 315
  }))
  return f
}
const cutLabels = (f: ReturnType<typeof JSON.parse>): unknown =>
  nativeOwnedFigureBottomLabels(f.page, f.caption, f.captions, f.tables, f.rect, [], f.tokens)
it('completes a repeated raster label row already intersecting the crop', () => {
  const f = cutRasterLabels()
  expect(cutLabels(f)).toEqual(f.tokens.map((t: ReturnType<typeof JSON.parse>) => t.rect))
})
it.each(['no raster', 'below crop', 'prose', 'caption', 'invalid width', 'duplicate raster'])(
  'rejects repeated raster row completion with %s',
  (kind) => {
    const f = cutRasterLabels()
    if (kind === 'no raster') f.page.graphicsBounds = []
    if (kind === 'below crop')
      f.tokens.forEach((t: ReturnType<typeof JSON.parse>) => {
        t.rect[1] += 5
        t.rect[3] += 5
        t.baseline += 5
      })
    if (kind === 'prose')
      f.tokens[1].text =
        'This complete sentence is unrelated to this comparison and must stay outside.'
    if (kind === 'caption') f.captions.push({ page: 1, rect: [100, 306, 500, 316] })
    if (kind === 'invalid width') f.tokens[0].rect[2] = 0
    if (kind === 'duplicate raster') f.page.graphicsBounds.push({ ...f.page.graphicsBounds[0] })
    expect(cutLabels(f)).toEqual([])
  }
)

// Anonymous geometry and same-stream native operators; no publication data.
const clippedFrameQuad = (x: number, y: number, w: number, h: number): Float32Array =>
  new Float32Array([0, x, y, 1, x + w, y, 1, x + w, y + h, 1, x, y + h, 4])
function clippedBackgroundChart(): ReturnType<typeof JSON.parse> {
  const width = 600,
    height = 800,
    coarse = [78, 98, 482, 406],
    caption = { page: 1, lines: ['Figure 1: Sample results.'], rect: [80, 402, 480, 412] }
  const ops: { fnArray: number[]; argsArray: unknown[] } = {
    fnArray: [OPS.transform, OPS.paintFormXObjectBegin, OPS.constructPath],
    argsArray: [
      [1, 0, 0, 1, 80, 400],
      [null, new Float32Array([0, 0, 400, 300])],
      [OPS.fill, [clippedFrameQuad(0, 0, 400, 300)], [0, 0, 400, 300]]
    ]
  }
  const graphicsBounds = [
    {
      kind: 'path',
      operationIndex: 2,
      normalizedRect: coarse.map((v, i) => v / (i % 2 ? height : width))
    }
  ]
  for (let i = 0; i < 8; i++) {
    const r = [120 + i * 35, 150 + i * 10, 132 + i * 35, 350],
      op = ops.fnArray.length
    ops.fnArray.push(OPS.constructPath)
    ops.argsArray.push([
      OPS.fill,
      [clippedFrameQuad(r[0] - 80, 800 - r[3] - 400, r[2] - r[0], r[3] - r[1])],
      null
    ])
    graphicsBounds.push({
      kind: 'path',
      operationIndex: op,
      normalizedRect: r.map((v, j) => v / (j % 2 ? height : width))
    })
  }
  ops.fnArray.push(OPS.paintFormXObjectEnd)
  ops.argsArray.push([])
  const line = (
    text: string,
    x: number,
    y: number,
    width: number
  ): ReturnType<typeof JSON.parse> => ({ text, x, y, width, height: 10, fontSize: 10 })
  const lines = [
    ...Array.from({ length: 4 }, (_, i) => line(String(i * 10), 85, 170 + i * 40, 20)),
    ...['Alpha', 'Beta', 'Gamma'].map((t, i) => line(t, 130 + i * 100, 370, 50)),
    line(caption.lines[0], 80, 402, 400)
  ]
  const page = { pageNumber: 1, width, height, graphicsBounds, lines, invalidGraphicsBounds: 0 },
    context = {
      operators: ops,
      graphicsBounds: structuredClone(graphicsBounds),
      viewport: { width, height, transform: [1, 0, 0, -1, 0, 800] }
    }
  return { page, caption, context, coarse }
}

function clippedChartResult(
  f: ReturnType<typeof JSON.parse>,
  withContext = true
): ReturnType<typeof JSON.parse> {
  return nativeCaptionedVectorBarChart(
    f.page,
    f.caption,
    [f.caption],
    [],
    [],
    withContext ? f.context : undefined
  )
}
it('uses the exact selected filled clip contribution without changing selected chart inventory', () => {
  const f = clippedBackgroundChart(),
    before = clippedChartResult(f, false),
    after = clippedChartResult(f)
  expect(before.rect[3]).toBeGreaterThan(f.caption.rect[1])
  expect(after.rect).toEqual([80, 100, 480, 400])
  expect(after.graphicsCount).toBe(before.graphicsCount)
  expect(after.caption).toBe(before.caption)
  expect(f.page.graphicsBounds[0].normalizedRect[3] * 800).toBeCloseTo(406)
})
it('uses the actual clipped contribution when a background fill extends beyond its Form', () => {
  const f = clippedBackgroundChart()
  f.context.operators.argsArray[2][1][0] = clippedFrameQuad(-4, -4, 408, 308)
  const result = clippedChartResult(f)
  expect(result.rect).toEqual([80, 100, 480, 400])
  expect(result.graphicsCount).toBe(clippedChartResult(f, false).graphicsCount)
  expect(result.caption).toBe(f.caption)
  expect(result.sourceItems).toBeUndefined()
})
it.each([false, true])(
  'keeps independent labels and paint outside a clipped background (oversized=%s)',
  (oversized) => {
    for (const surface of ['text', 'path']) {
      const f = clippedBackgroundChart()
      if (oversized) f.context.operators.argsArray[2][1][0] = clippedFrameQuad(-4, -4, 408, 308)
      if (surface === 'text')
        f.page.lines.push({
          text: 'Separate key',
          x: 150,
          y: 397,
          width: 70,
          height: 10,
          fontSize: 10
        })
      else
        f.page.graphicsBounds.push({
          kind: 'path',
          operationIndex: 99,
          normalizedRect: [150 / 600, 397 / 800, 220 / 600, 407 / 800]
        })
      expect(clippedChartResult(f).rect[3], surface).toBe(407)
    }
  }
)
it('uses a smaller explicit Form clip without shrinking independently selected chart content', () => {
  const f = clippedBackgroundChart()
  f.context.operators.argsArray[1][1] = new Float32Array([10, 10, 390, 290])
  expect(clippedChartResult(f).rect).toEqual([85, 110, 470, 390])
})
function captionAdvanceOverlapChart(): ReturnType<typeof JSON.parse> {
  const f = clippedBackgroundChart()
  f.page.graphicsBounds[0].normalizedRect[3] = 404 / 800
  f.context.graphicsBounds[0].normalizedRect[3] = 404 / 800
  f.caption.rect = [80, 399.5, 480, 412]
  f.page.lines.at(-1).y = 399.5
  return f
}
it('uses the proved background clip even when its edge overlaps the caption advance box', () => {
  const f = captionAdvanceOverlapChart(),
    input = structuredClone(f),
    result = associateFigures(f.page, [f.caption], [], [], [], [], f.context)[0]
  expect(result.rect).toEqual([80, 100, 480, 400])
  expect(result.caption).toBe(f.caption)
  expect(result.graphicsCount).toBe(9)
  expect(result.sourceItems).toBeUndefined()
  expect(f).toEqual(input)
})
it('retains separate paint and labels beyond a background clip beside a caption', () => {
  for (const surface of ['text', 'path']) {
    const f = captionAdvanceOverlapChart()
    f.caption.rect[2] = 140
    f.page.lines.at(-1).width = 60
    if (surface === 'text')
      f.page.lines.push({
        text: 'External key',
        x: 200,
        y: 398,
        width: 60,
        height: 10,
        fontSize: 10
      })
    else
      f.page.graphicsBounds.push({
        kind: 'path',
        operationIndex: 99,
        normalizedRect: [200 / 600, 398 / 800, 230 / 600, 408 / 800]
      })
    const result = associateFigures(f.page, [f.caption], [], [], [], [], f.context)[0]
    expect(result.rect[3], surface).toBe(408)
    expect(result.caption).toBe(f.caption)
  }
})
it('keeps the coarse background when a caption-overlapping exact clip is unproved', () => {
  for (const kind of ['missing context', 'missing clip', 'unknown clip']) {
    const f = captionAdvanceOverlapChart()
    if (kind === 'missing context') f.context = undefined
    if (kind === 'missing clip') f.context.operators.argsArray[1][1] = null
    if (kind === 'unknown clip') f.context.operators.argsArray[1][1] = [NaN, 0, 400, 300]
    expect(associateFigures(f.page, [f.caption], [], [], [], [], f.context)[0].rect, kind).toEqual([
      78, 98, 482, 404
    ])
  }
})
it.each([
  'unclipped',
  'larger clip',
  'empty clip',
  'stroke',
  'invalid path',
  'duplicate page carrier',
  'duplicate context carrier',
  'context mismatch',
  'viewport mismatch',
  'shear',
  'missing context',
  'missing operators',
  'missing fnArray',
  'missing argsArray',
  'missing graphics',
  'null graphic',
  'nonfinite rect',
  'short viewport',
  'invalid paint',
  'unknown paint count'
])('retains legacy geometry when exact background proof is unavailable: %s', (kind) => {
  const f = clippedBackgroundChart()
  if (kind === 'unclipped') f.context.operators.argsArray[1][1] = null
  if (kind === 'larger clip')
    f.context.operators.argsArray[1][1] = new Float32Array([-10, -10, 410, 310])
  if (kind === 'empty clip')
    f.context.operators.argsArray[1][1] = new Float32Array([10, 10, 10, 290])
  if (kind === 'stroke') f.context.operators.argsArray[2][0] = OPS.stroke
  if (kind === 'invalid path') f.context.operators.argsArray[2][1][0][3] = 2
  if (kind === 'duplicate page carrier') f.page.graphicsBounds.push({ ...f.page.graphicsBounds[0] })
  if (kind === 'duplicate context carrier')
    f.context.graphicsBounds.push({ ...f.context.graphicsBounds[0] })
  if (kind === 'context mismatch') f.context.graphicsBounds[0].normalizedRect[3] += 0.001
  if (kind === 'viewport mismatch') f.context.viewport.width++
  if (kind === 'shear') f.context.operators.argsArray[0][2] = 0.1
  if (kind === 'missing context') f.context = undefined
  if (kind === 'missing operators') f.context.operators = undefined
  if (kind === 'missing fnArray') f.context.operators.fnArray = undefined
  if (kind === 'missing argsArray') f.context.operators.argsArray = undefined
  if (kind === 'missing graphics') f.context.graphicsBounds = undefined
  if (kind === 'null graphic') f.context.graphicsBounds = [null]
  if (kind === 'nonfinite rect') f.context.graphicsBounds[0].normalizedRect[0] = NaN
  if (kind === 'short viewport') f.context.viewport.transform = [1, 0]
  if (kind === 'invalid paint') f.page.invalidGraphicsBounds = 1
  if (kind === 'unknown paint count') delete f.page.invalidGraphicsBounds
  expect(clippedChartResult(f)?.rect).toEqual(clippedChartResult(f, false)?.rect)
})
it('keeps existing table and independent caption vetoes for clipped backgrounds', () => {
  const f = clippedBackgroundChart(),
    other = { page: 1, lines: ['Figure 2: Independent.'], rect: [100, 150, 300, 170] }
  expect(
    nativeCaptionedVectorBarChart(f.page, f.caption, [f.caption, other], [], [], f.context)
  ).toBeUndefined()
  expect(
    nativeCaptionedVectorBarChart(
      f.page,
      f.caption,
      [f.caption],
      [[100, 150, 300, 170]],
      [],
      f.context
    )
  ).toBeUndefined()
})

function assignedBarBesideProse(): ReturnType<typeof JSON.parse> {
  const line = (
    text: string,
    x: number,
    y: number,
    width: number,
    height = 8
  ): { text: string; x: number; y: number; width: number; height: number; fontSize: number } => ({
    text,
    x,
    y,
    width,
    height,
    fontSize: height
  })
  const caption = {
    page: 1,
    lines: ['Fig. 2 Comparison of observations.'],
    rect: [70, 572, 530, 600]
  }
  const boxes = [
    [70, 345, 530, 569],
    [105, 398, 218, 530],
    [110, 470, 130, 530],
    [166, 460, 186, 530],
    [124, 447, 141, 530],
    [180, 440, 200, 530],
    [136, 434, 155, 530],
    [136, 457, 155, 530]
  ]
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      line(
        'The independent discussion continues with a complete sentence about the preceding results and these final',
        70,
        312,
        460,
        11
      ),
      line('Summary.', 70, 325, 33, 11),
      line('Group', 114, 525, 32),
      line('A', 120, 534, 20),
      ...[0, 1, 2, 3].map((v) => line(String(v / 10), 91, 519 - v * 27, 11)),
      line(caption.lines[0], 70, 572, 460, 11)
    ],
    graphicsBounds: boxes.map((rect, i) => ({
      kind: 'path',
      operationIndex: i,
      normalizedRect: rect.map((v, j) => v / (j % 2 ? 800 : 600))
    }))
  }
  return { page, caption }
}
it.each([0.75, 1.7])(
  'keeps assigned abbreviated bars outside preceding prose at scale %s',
  (scale) => {
    const f = assignedBarBesideProse()
    f.page.width *= scale
    f.page.height *= scale
    for (const line of f.page.lines)
      for (const key of ['x', 'y', 'width', 'height', 'fontSize']) line[key] *= scale
    f.caption.rect = f.caption.rect.map((value: number) => value * scale)
    const before = structuredClone(f)
    const [figure] = associateFigures(f.page, [f.caption], [], [])
    for (const [index, value] of [70, 345, 530, 569].entries())
      expect(figure.rect[index]).toBeCloseTo(value * scale, 10)
    expect(figure.rect[1]).toBeGreaterThan((325 + 11) * scale)
    expect(figure.graphicsCount).toBe(8)
    expect(f).toEqual(before)
  }
)

// The complete anonymous paint/text program is necessary: sparse rule boxes
// alone also describe ordinary paragraph dividers and do not own a figure.
function intervalPartitionPacket(rowCount = 3): ReturnType<typeof JSON.parse> {
  const width = 400,
    height = 400
  const page: ReturnType<typeof JSON.parse> = {
    pageNumber: 1,
    width,
    height,
    lines: [],
    graphicsBounds: [],
    invalidGraphicsBounds: 0
  }
  const operators: { fnArray: number[]; argsArray: unknown[] } = { fnArray: [], argsArray: [] }
  const content: ReturnType<typeof JSON.parse> = {
    items: [],
    styles: { font: { ascent: 0.8, descent: -0.2 } }
  }
  const viewport = { width, height, rotation: 0, scale: 1, transform: [1, 0, 0, -1, 0, height] }
  const tokens: ReturnType<typeof JSON.parse> = []
  const emit = (op: number, args: unknown = null): number => {
    operators.fnArray.push(op)
    operators.argsArray.push(args)
    return operators.fnArray.length - 1
  }
  const paint = (x: number, y: number, mark: boolean): void => {
    emit(OPS.save)
    emit(OPS.transform, [1, 0, 0, 1, x, height - y])
    emit(OPS.setLineWidth, [0.5])
    const r = 2,
      k = 1.1
    const program = mark
      ? [
          0,
          0,
          0,
          0,
          r,
          0,
          2,
          r,
          k,
          k,
          r,
          0,
          r,
          2,
          -k,
          r,
          -r,
          k,
          -r,
          0,
          2,
          -r,
          -k,
          -k,
          -r,
          0,
          -r,
          2,
          k,
          -r,
          r,
          -k,
          r,
          0,
          4,
          0,
          0,
          0
        ]
      : [0, 0, 0, 1, 240, 0]
    const operationIndex = emit(OPS.constructPath, [
      mark ? OPS.fillStroke : OPS.stroke,
      [program],
      mark ? [-r, -r, r, r] : [0, 0, 240, 0]
    ])
    emit(OPS.restore)
    const rect = mark
      ? [x - r - 0.25, y - r - 0.25, x + r + 0.25, y + r + 0.25]
      : [x - 0.25, y - 0.25, x + 240.25, y + 0.25]
    page.graphicsBounds.push({
      operationIndex,
      kind: 'path',
      normalizedRect: rect.map((z, n) => z / (n % 2 ? height : width))
    })
  }
  const addText = (str: string, x: number, baseline: number, zero = false): void => {
    const index = content.items.length,
      size = 10,
      advance = zero ? 0 : str.length * 5
    const sourceItem = { pageNumber: 1, index, text: str }
    content.items.push({
      str,
      dir: 'ltr',
      width: advance,
      height: size,
      transform: [size, 0, 0, size, x, height - baseline],
      fontName: 'font',
      hasEOL: false,
      sourceItem
    })
    emit(OPS.beginText)
    emit(OPS.setFont, ['font', size])
    emit(OPS.moveText, [x, height - baseline])
    emit(OPS.showText, [
      Array.from(str).map((c) => ({
        unicode: c,
        width: zero ? 0 : 500,
        originalCharCode: c.codePointAt(0),
        fontChar: c,
        isSpace: c === ' ',
        isInFont: true
      }))
    ])
    emit(OPS.endText)
    tokens.push({
      text: str,
      sourceItem,
      inlineSymbol: false,
      baseline,
      height: size,
      rect: [x, baseline - size, x + advance, baseline],
      horizontal: true,
      fontDescent: -0.2
    })
    page.lines.push({
      text: str,
      x,
      y: baseline - size,
      width: advance,
      height: size,
      fontSize: size
    })
  }
  for (let n = 0; n < rowCount; n++) {
    const y = 100 + n * 50,
      xs = Array.from({ length: n + 2 }, (_, j) => 80 + (j * 240) / (n + 1))
    paint(80, y, false)
    xs.forEach((x) => paint(x, y, true))
    if (!n) {
      addText('0', 65, y + 4)
      addText('1', 330, y + 4)
    }
    for (let j = 1; j < xs.length; j++) addText('A', (xs[j - 1] + xs[j]) / 2 - 2.5, y - 9)
  }
  const bottom = 100 + (rowCount - 1) * 50
  const caption = {
    page: 1,
    lines: ['Figure 1. Interval partitions.'],
    rect: [110, bottom + 24, 260, bottom + 36]
  }
  addText(caption.lines[0], 110, bottom + 34)
  return { args: [page, [caption], [], [], [], tokens, { viewport, operators, content }], addText }
}

it('recovers a sparse repeated native interval figure without creating text claims', () => {
  const { args } = intervalPartitionPacket(),
    before = structuredClone(args)
  const figures = associateFigures(...args)
  expect(figures).toEqual([
    {
      caption: args[1][0],
      rect: [65, 81, 335, 202.25],
      reason: 'native-repeated-interval-rows',
      graphicsCount: 12
    }
  ])
  expect(args).toEqual(before)
})

it('keeps a zero-advance body glyph outside the proved interval font domain', () => {
  const packet = intervalPartitionPacket()
  packet.addText('7', 100, 350, true)
  expect(associateFigures(...packet.args)[0]).toMatchObject({
    rect: [65, 81, 335, 202.25],
    graphicsCount: 12
  })
})

it.each([1, 2])('does not infer an interval figure from only %i sparse rule rows', (rows) => {
  expect(associateFigures(...intervalPartitionPacket(rows).args)[0].rect).toBeUndefined()
})

const refusedIntervalPackets: [string, (packet: ReturnType<typeof JSON.parse>) => void][] = [
  [
    'a non-positive page identity',
    (p) => {
      p.args[0].pageNumber = 0
    }
  ],
  [
    'a table caption rather than a figure',
    (p) => {
      p.args[1][0].lines[0] = 'Table 1. Interval partitions.'
    }
  ],
  [
    'unproved alpha',
    (p) => {
      p.args[6].operators.fnArray.push(OPS.setGState)
      p.args[6].operators.argsArray.push([[['ca', 0.5]]])
    }
  ],
  [
    'unproved clipping',
    (p) => {
      p.args[6].operators.fnArray.push(OPS.clip)
      p.args[6].operators.argsArray.push(null)
    }
  ],
  [
    'a competing table',
    (p) => {
      p.args[2].push([90, 85, 300, 210])
    }
  ],
  [
    'a competing caption',
    (p) => {
      p.args[1].push({ ...p.args[1][0], lines: ['Figure 2. Other.'] })
    }
  ],
  [
    'a repeated source identity',
    (p) => {
      p.args[5][2].sourceItem = { ...p.args[5][0].sourceItem }
    }
  ],
  [
    'a hidden nested source alias',
    (p) => {
      p.args[5][2].nested = { sourceItem: { ...p.args[5][2].sourceItem } }
    }
  ],
  [
    'a missing whole native label',
    (p) => {
      p.args[5].splice(2, 1)
    }
  ],
  [
    'missing native font metrics',
    (p) => {
      delete p.args[6].content.styles.font
    }
  ],
  [
    'a different active font',
    (p) => {
      const o = p.args[6].operators
      o.argsArray[o.fnArray.indexOf(OPS.setFont)][0] = 'other'
    }
  ],
  [
    'foreign native prose inside the crop',
    (p) => {
      p.addText('Body', 200, 177)
    }
  ],
  [
    'a zero-advance glyph within the crop vertical domain',
    (p) => {
      p.addText('7', 350, 177, true)
    }
  ],
  [
    'a missing recorded native paint',
    (p) => {
      p.args[0].graphicsBounds.pop()
    }
  ],
  [
    'a noncanonical mark',
    (p) => {
      const o = p.args[6].operators,
        i = o.fnArray.findIndex(
          (op: number, i: number) =>
            op === OPS.constructPath && o.argsArray[i][0] === OPS.fillStroke
        )
      o.argsArray[i][1][0][8] += 0.5
    }
  ],
  [
    'an unrecognized empty-path record',
    (p) => {
      p.args[6].operators.fnArray.push(OPS.constructPath)
      p.args[6].operators.argsArray.push([OPS.endPath, [null, null], null])
    }
  ]
]
it.each(refusedIntervalPackets)('refuses native interval completion with %s', (_name, mutate) => {
  const packet = intervalPartitionPacket()
  mutate(packet)
  const before = structuredClone(packet.args)
  expect(
    associateFigures(...packet.args).every((figure: { rect?: number[] }) => !figure.rect)
  ).toBe(true)
  expect(packet.args).toEqual(before)
})

// Native open nodes are whole BT/ET packets; edges require independently painted arrowheads.
function openCyclePacket({ scale = 1, dx = 0, dy = 0 } = {}): ReturnType<typeof JSON.parse> {
  const width = 600 * scale,
    height = 800 * scale,
    pageNumber = 1,
    o: { fnArray: number[]; argsArray: ReturnType<typeof JSON.parse>[] } = {
      fnArray: [],
      argsArray: []
    },
    raw: ReturnType<typeof JSON.parse>[] = [],
    styles = {
      base: { ascent: 0.8, descent: -0.2, vertical: false },
      small: { ascent: 0.8, descent: -0.2, vertical: false }
    },
    graphics: ReturnType<typeof JSON.parse>[] = [],
    lines: ReturnType<typeof JSON.parse>[] = [],
    indices: { shafts: number[]; heads: number[]; packets: number[]; fontOps: number[] } = {
      shafts: [],
      heads: [],
      packets: [],
      fontOps: []
    },
    v = {
      width,
      height,
      rotation: 0,
      scale: 1,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x: number, y: number): number[] => [x, height - y]
    }
  const op = (code: number, args: unknown = null): number => {
      o.fnArray.push(code)
      o.argsArray.push(args)
      return o.fnArray.length - 1
    },
    X = (x: number): number => (x + dx) * scale,
    Y = (y: number): number => (y + dy) * scale
  function textPacket(items: [string, number, number, number?, string?][]): number[][] {
    indices.packets.push(op(OPS.beginText))
    const rs: number[][] = []
    for (const [text, x, y, size = 10, font = 'base'] of items) {
      const px = X(x),
        baseline = Y(y),
        h = size * scale,
        w = text.length * h * 0.6
      indices.fontOps.push(op(OPS.setFont, [font, h]))
      op(OPS.setTextMatrix, [[1, 0, 0, 1, px, height - baseline]])
      op(OPS.showText, [
        [...text].map((c) => ({
          unicode: c,
          fontChar: c,
          originalCharCode: c.charCodeAt(0),
          width: 600,
          accent: null,
          vmetric: null,
          operatorListId: null,
          isSpace: c === ' ',
          isInFont: true
        }))
      ])
      const index = raw.length
      raw.push({
        str: text,
        dir: 'ltr',
        width: w,
        height: h,
        transform: [h, 0, 0, h, px, height - baseline],
        fontName: font,
        hasEOL: false,
        sourceItem: { pageNumber, index, text }
      })
      rs.push([px, baseline - h, px + w, baseline])
    }
    op(OPS.endText)
    return rs
  }
  function paint(program: number[], kind: number): number {
    const pts: number[][] = []
    for (let n = 0; n < program.length;) {
      const c = program[n++],
        k = c === 4 ? 0 : 2
      for (let j = 0; j < k; j += 2) pts.push([X(program[n + j]), height - Y(program[n + j + 1])])
      n += k
    }
    const transformed: number[] = []
    let idx = 0
    for (let n = 0; n < program.length;) {
      const c = program[n++]
      transformed.push(c)
      if (c !== 4) {
        transformed.push(...pts[idx++])
        n += 2
      }
    }
    const r = [
        Math.min(...pts.map((p) => p[0])),
        Math.min(...pts.map((p) => p[1])),
        Math.max(...pts.map((p) => p[0])),
        Math.max(...pts.map((p) => p[1]))
      ],
      i = op(OPS.constructPath, [kind, [Float32Array.from(transformed)], Float32Array.from(r)]),
      pad = scale * 0.3
    graphics.push({
      operationIndex: i,
      kind: 'path',
      normalizedRect: [
        (r[0] - pad) / width,
        (height - r[3] - pad) / height,
        (r[2] + pad) / width,
        (height - r[1] + pad) / height
      ]
    })
    return i
  }
  op(OPS.setFillRGBColor, ['#000000'])
  op(OPS.setStrokeRGBColor, ['#000000'])
  op(OPS.setLineWidth, [0.4 * scale])
  op(OPS.setLineCap, [0])
  for (const [x, y, n] of [
    [100, 110, '0'],
    [300, 110, '1'],
    [300, 250, '2'],
    [100, 250, '3']
  ] as [number, number, string][])
    textPacket([
      ['X', x, y],
      [n, x + 6, y + 2, 6, 'small']
    ])
  for (const [s, e] of [
    [
      [114, 105],
      [290, 105]
    ],
    [
      [305, 120],
      [305, 231]
    ],
    [
      [295, 245],
      [122, 245]
    ],
    [
      [105, 235],
      [105, 121]
    ]
  ]) {
    indices.shafts.push(paint([0, ...s, 1, ...e], OPS.stroke))
    const dd = [e[0] - s[0], e[1] - s[1]],
      len = Math.hypot(...dd),
      u = dd.map((z) => z / len),
      p = (x: number, y: number): number[] => [
        e[0] + u[0] * x - u[1] * y,
        e[1] + u[1] * x + u[0] * y
      ]
    indices.heads.push(
      paint([0, ...p(7, 0), 1, ...p(-3, 2), 1, ...p(0, 0), 1, ...p(-3, -2), 4], OPS.fillStroke)
    )
  }
  for (const [x, y] of [
    [200, 98],
    [316, 180],
    [200, 258],
    [92, 180]
  ])
    textPacket([['L', x, y]])
  const capText = 'Figure 1: State transitions.',
    capRects = textPacket([[capText, 80, 300]]),
    r = capRects[0],
    caption = { page: pageNumber, lines: [capText], rect: r }
  lines.push({
    text: capText,
    fontSize: 10 * scale,
    x: r[0],
    y: r[1],
    width: r[2] - r[0],
    height: r[3] - r[1]
  })
  const tokens = raw.map((item, index) => ({
      text: item.str,
      rect: [
        item.transform[4],
        height - item.transform[5] - item.height,
        item.transform[4] + item.width,
        height - item.transform[5]
      ],
      height: item.height,
      baseline: height - item.transform[5],
      horizontal: true,
      sourceItem: { pageNumber, index, text: item.str }
    })),
    page = {
      pageNumber,
      width,
      height,
      rotation: 0,
      renderRotation: 0,
      invalidGraphicsBounds: 0,
      graphicsBounds: graphics,
      lines
    }
  return {
    args: [
      page,
      [caption],
      [],
      [],
      [],
      tokens,
      { operators: o, viewport: v, content: { items: raw, styles } }
    ],
    indices,
    textPacket,
    op
  }
}

function refreshOpenCycleTokens(packet: ReturnType<typeof openCyclePacket>): void {
  const a = packet.args
  a[5] = a[6].content.items.map((item: ReturnType<typeof JSON.parse>, index: number) => ({
    text: item.str,
    rect: [
      item.transform[4],
      a[0].height - item.transform[5] - item.height,
      item.transform[4] + item.width,
      a[0].height - item.transform[5]
    ],
    height: item.height,
    baseline: a[0].height - item.transform[5],
    horizontal: true,
    sourceItem: { pageNumber: a[0].pageNumber, index, text: item.str }
  }))
}
it.each([0.75, 1.5])('recovers an unframed native directed cycle at scale %s', (scale) => {
  const p = openCyclePacket({ scale }),
    before = JSON.stringify(p.args),
    result = associateFigures(...p.args)
  expect(result).toHaveLength(1)
  expect(result[0].rect).toEqual([92, 88, 322, 260].map((x) => x * scale))
  expect(result[0].graphicsCount).toBe(8)
  expect(result[0].sourceItems).toBeUndefined()
  expect(JSON.stringify(p.args)).toBe(before)
})
it('keeps open-cycle proof independent of page location and unrelated outside content', () => {
  const p = openCyclePacket({ dx: 20, dy: 18 })
  p.textPacket([['Note', 40, 40]])
  refreshOpenCycleTokens(p)
  p.args[5].pop()
  p.args[2].push([420, 420, 470, 450])
  const result = associateFigures(...p.args)
  expect(result[0].rect).toEqual([112, 106, 342, 278])
  expect(result[0].sourceItems).toBeUndefined()
})
const refusedOpenCycles: [string, (p: ReturnType<typeof openCyclePacket>) => void][] = [
  [
    'a reversed shaft',
    (p) => {
      const r = p.args[6].operators.argsArray[p.indices.shafts[0]][1][0]
      ;[r[1], r[4]] = [r[4], r[1]]
      ;[r[2], r[5]] = [r[5], r[2]]
    }
  ],
  [
    'a missing arrowhead',
    (p) => {
      const i = p.indices.heads[0]
      p.args[6].operators.argsArray[i] = [OPS.endPath, [null], null]
      p.args[0].graphicsBounds = p.args[0].graphicsBounds.filter(
        (g: { operationIndex: number }) => g.operationIndex !== i
      )
    }
  ],
  [
    'a repeated paint identity',
    (p) => p.args[0].graphicsBounds.push({ ...p.args[0].graphicsBounds[0] })
  ],
  ['unknown paint', (p) => p.op(OPS.shadingFill, ['unproved'])],
  [
    'a different active font',
    (p) => (p.args[6].operators.argsArray[p.indices.fontOps[0]][0] = 'small')
  ],
  ['a different raw font', (p) => (p.args[6].content.items[0].fontName = 'small')],
  [
    'a nested native source alias',
    (p) => (p.args[5][0].other = { sourceItems: [{ ...p.args[5][1].sourceItem }] })
  ],
  ['an omitted whole native label', (p) => (p.args[5] = p.args[5].slice(1))],
  [
    'a competing caption',
    (p) =>
      p.args[1].push({ page: 1, rect: [400, 400, 500, 410], lines: ['Figure 2: Separate result.'] })
  ],
  ['an independent table inside the cycle', (p) => p.args[2].push([180, 160, 230, 210])],
  ['an independent table in the caption corridor', (p) => p.args[2].push([180, 270, 230, 280])],
  [
    'independent text inside the cycle',
    (p) => {
      p.textPacket([['Text', 190, 190]])
      refreshOpenCycleTokens(p)
    }
  ],
  [
    'an independent glyph packet touching a node',
    (p) => {
      p.textPacket([['Z', 110, 110]])
      refreshOpenCycleTokens(p)
    }
  ],
  [
    'independent text in the caption corridor',
    (p) => {
      p.textPacket([['Text', 190, 280]])
      refreshOpenCycleTokens(p)
    }
  ],
  [
    'a changed native glyph literal',
    (p) => {
      const o = p.args[6].operators,
        i = o.fnArray.indexOf(OPS.showText)
      o.argsArray[i][0][0].unicode = 'Y'
    }
  ],
  ['unknown graphic bounds', (p) => (p.args[0].invalidGraphicsBounds = 1)],
  ['an unbound caption literal', (p) => (p.args[1][0].lines = ['Figure 1: Different text.'])]
]
it.each(refusedOpenCycles)('refuses open-cycle recovery with %s', (_name, mutate) => {
  const p = openCyclePacket()
  mutate(p)
  const before = JSON.stringify(p.args)
  expect(associateFigures(...p.args).every((f: { rect?: number[] }) => !f.rect)).toBe(true)
  expect(JSON.stringify(p.args)).toBe(before)
})
