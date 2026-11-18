import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { associateFigures, recoverNativePeerFigureBarrier } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const {
  nativeCaptionAboveRasterStack,
  nativeRasterPeerOwnership,
  nativeRasterCaptionPacket,
  nativeWhiteBackedTiledFigures
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-raster-peer-ownership.mjs')).href
)
function fixture(): ReturnType<typeof JSON.parse> {
  const captions = [
    { page: 1, lines: ['Fig. 1: First independent plate.'], rect: [30, 330, 280, 340] },
    { page: 1, lines: ['Fig. 2: Second independent plate.'], rect: [320, 350, 570, 360] }
  ]
  const tokens = captions.map((c, index) => ({
    text: c.lines[0],
    sourceItem: { pageNumber: 1, index, text: c.lines[0] },
    horizontal: true,
    height: 10,
    rect: c.rect
  }))
  const graphicsBounds = [0, 1].flatMap((side) =>
    [0, 1, 2].flatMap((row) =>
      [0, 1].map((col) => ({
        kind: 'image',
        imageHash: 'anonymous-carrier',
        operationIndex: 10 + side * 100 + row * 2 + col,
        normalizedRect: [
          40 + side * 290 + col * 110,
          150 + row * 55,
          140 + side * 290 + col * 110,
          200 + row * 55
        ].map((v, n) => v / (n % 2 ? 800 : 600))
      }))
    )
  )
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    graphicsBounds,
    lines: tokens.map((t) => ({
      text: t.text,
      x: t.rect[0],
      y: t.rect[1],
      width: t.rect[2] - t.rect[0],
      height: 10,
      fontSize: 10
    }))
  }
  return { page, captions, tokens, tables: [[30, 40, 280, 120]] }
}
const associate = (f: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  associateFigures(f.page, f.captions, f.tables, [], [], f.tokens)
it('keeps complete disjoint native raster packets with their independent captions', () => {
  const f = fixture(),
    before = structuredClone(f),
    result = associate(f)
  expect(result.map((r: { rect: number[] }) => r.rect)).toEqual([
    [40, 150, 250, 310],
    [330, 150, 540, 310]
  ])
  expect(f).toEqual(before)
})

it.each(['complete', 'missing-mark', 'unpaired-frame', 'shared-path'])(
  'closes two framed raster packets with intact native caption marks: %s',
  (kind) => {
    const f = fixture()
    const [caption] = f.captions
    const mark = '\u20d7'
    caption.lines[0] += mark
    const nativeLabel = (
      text: string,
      index: number,
      rect: number[],
      horizontal: boolean
    ): {
      text: string
      sourceItem: { pageNumber: number; index: number; text: string }
      rect: number[]
      horizontal: boolean
      height: number
    } => ({ text, sourceItem: { pageNumber: 1, index, text }, rect, horizontal, height: 10 })
    const path = (
      operationIndex: number,
      rect: number[]
    ): {
      kind: string
      operationIndex: number
      normalizedRect: number[]
    } => ({
      kind: 'path',
      operationIndex,
      normalizedRect: rect.map((value, i) => value / (i % 2 ? 800 : 600))
    })
    if (kind !== 'missing-mark') f.tokens.push(nativeLabel(mark, 2, [275, 331, 275, 339], true))
    f.tokens.push(nativeLabel('Axis', 3, [252, 165, 261, 180], false))
    f.tokens.push(nativeLabel('Scale', 4, [569, 165, 575, 190], false))
    const left = [32, 131, 270, 318]
    const right = [323, 132, 585, 319]
    f.page.graphicsBounds.push(
      path(1, [565, 100, 572, 131]),
      path(3, left),
      path(4, left),
      path(103, right)
    )
    if (kind !== 'unpaired-frame') f.page.graphicsBounds.push(path(104, right))
    if (kind === 'shared-path') f.page.graphicsBounds.push(path(200, [100, 160, 400, 165]))
    const result = nativeRasterPeerOwnership(f.page, f.captions, f.tables, f.tokens)
    if (kind !== 'complete') expect(result).toBeUndefined()
    else {
      expect(result?.map((entry: { rect: number[] }) => entry.rect)).toEqual([left, right])
      expect(result?.map((entry: { caption: unknown }) => entry.caption)).toEqual(f.captions)
    }
  }
)

it.each(['complete', 'unknown-blank', 'foreign-paint', 'wrong-backing', 'body-in-figure'])(
  'bounds a complete white-backed raster tile group by visible ink: %s',
  (change) => {
    const caption = { page: 1, lines: ['Fig. 1. Native panels.'], rect: [80, 350, 290, 361] }
    const rect = (values: number[]): number[] => values.map((v, n) => v / (n % 2 ? 800 : 600))
    const first = {
      kind: 'path',
      operationIndex: 10,
      normalizedRect: rect([60, 100, 450, 340]),
      whiteRectangle: true
    }
    const tiles = [
      [60, 100, 280, 220],
      [280, 100, 450, 220],
      [60, 220, 280, 340],
      [280, 220, 450, 340]
    ].map((box, i) => ({
      kind: 'image',
      operationIndex: 13 + i * 2,
      normalizedRect: rect(box),
      imageHash: 'anonymous-raster',
      ...(i % 2
        ? { allWhiteRaster: true }
        : { paintedNormalizedRect: rect([100, box[1] + 2, 250, box[3] - 3]) })
    }))
    const page = {
      pageNumber: 1,
      width: 600,
      height: 800,
      invalidGraphicsBounds: 0,
      graphicsBounds: [first, ...tiles],
      captionStarts: [{ x: 80, y: 350, fontSize: 10, text: caption.lines[0] }]
    }
    const tokens = []
    if (change === 'unknown-blank') delete tiles[1].allWhiteRaster
    if (change === 'wrong-backing') first.normalizedRect[2] -= 0.08
    if (change === 'foreign-paint') page.graphicsBounds.push({ ...first, operationIndex: 99 })
    if (change === 'body-in-figure')
      tokens.push({ text: 'Ordinary text', rect: [120, 110, 175, 121] })
    const result = nativeWhiteBackedTiledFigures(page, [caption], [], tokens)
    if (change === 'complete') {
      expect(result).toHaveLength(1)
      expect(result[0].rect).toEqual([100, 102, 250, 337])
      expect(result[0].caption).toBe(caption)
    } else expect(result).toBeUndefined()
  }
)

it('keeps two raster panels with each aligned independent caption', () => {
  const f = fixture()
  f.captions[1].rect.splice(1, 3, 331, 570, 341)
  f.page.graphicsBounds = [0, 1].flatMap((side) =>
    [0, 1].map((row) => ({
      kind: 'image',
      imageHash: `panel-${side}-${row}`,
      operationIndex: 10 + side * 10 + row,
      normalizedRect: [40 + side * 290, 150 + row * 85, 260 + side * 290, 225 + row * 85].map(
        (n, axis) => n / (axis % 2 ? f.page.height : f.page.width)
      )
    }))
  )
  const label = {
    text: 'axis',
    sourceItem: { pageNumber: 1, index: 2, text: 'axis' },
    horizontal: false,
    height: 8,
    rect: [560, 170, 567, 210]
  }
  f.tokens.push(label)

  expect(
    nativeRasterPeerOwnership(f.page, f.captions, f.tables, f.tokens)?.map(
      (r: { rect: number[] }) => r.rect
    )
  ).toEqual([
    [40, 150, 260, 310],
    [330, 150, 567, 310]
  ])

  const secondPanel = f.page.graphicsBounds[1]
  secondPanel.operationIndex = 21
  expect(nativeRasterPeerOwnership(f.page, f.captions, f.tables, f.tokens)).toBeUndefined()
  secondPanel.operationIndex = 11
  delete secondPanel.imageHash
  expect(nativeRasterPeerOwnership(f.page, f.captions, f.tables, f.tokens)).toBeUndefined()
})

it('does not assign one native gutter label to both completed peer crops', () => {
  const f = fixture()
  f.captions[0].rect = [30, 330, 300, 340]
  f.captions[1].rect = [315, 350, 585, 360]
  f.tokens.forEach((token: ReturnType<typeof JSON.parse>, index: number) => {
    token.rect = f.captions[index].rect
  })
  expect(nativeRasterPeerOwnership(f.page, f.captions, f.tables, f.tokens)).toBeDefined()
  f.tokens.push({
    text: 'i',
    horizontal: true,
    height: 10,
    rect: [306, 170, 309, 180],
    sourceItem: { pageNumber: 1, index: 2, text: 'i' }
  })
  expect(nativeRasterPeerOwnership(f.page, f.captions, f.tables, f.tokens)).toBeUndefined()
})

it.each([
  'missing-caption-row',
  'duplicate-origin',
  'stale-source',
  'interleaved-images',
  'shared-frame',
  'table-crossing',
  'shared-caption',
  'unknown-operator',
  'unbounded-paint'
])('abstains from independent ownership when native closure is absent: %s', (kind) => {
  const f = fixture()
  if (kind === 'missing-caption-row') f.tokens.pop()
  if (kind === 'duplicate-origin') f.tokens.push(structuredClone(f.tokens[0]))
  if (kind === 'stale-source') f.tokens[0].sourceItem.text += ' A stale suffix.'
  if (kind === 'interleaved-images') f.page.graphicsBounds[1].operationIndex = 112
  if (kind === 'unknown-operator') delete f.page.graphicsBounds[0].operationIndex
  if (kind === 'unbounded-paint') f.page.invalidGraphicsBounds = 1
  if (kind === 'shared-caption') f.captions[0].rect[2] = 550
  if (kind === 'table-crossing') f.tables[0] = [30, 140, 280, 180]
  if (kind === 'shared-frame')
    f.page.graphicsBounds.push({
      kind: 'path',
      operationIndex: 300,
      normalizedRect: [30 / 600, 140 / 800, 550 / 600, 320 / 800]
    })
  expect(nativeRasterPeerOwnership(f.page, f.captions, f.tables, f.tokens)).toBeUndefined()
})

function completePacket(): ReturnType<typeof fixture> {
  const f = fixture(),
    caption = {
      page: 1,
      lines: ['Figure 1. One complete native plate.'],
      rect: [30, 330, 570, 340]
    }
  f.captions = [caption]
  f.tokens = [
    {
      text: caption.lines[0],
      horizontal: true,
      height: 10,
      rect: caption.rect,
      sourceItem: { pageNumber: 1, index: 0, text: caption.lines[0] }
    },
    {
      text: 'Panel title',
      horizontal: true,
      height: 10,
      rect: [60, 130, 140, 140],
      sourceItem: { pageNumber: 1, index: 1, text: 'Panel title' }
    },
    {
      text: 'axis',
      horizontal: false,
      height: 10,
      rect: [20, 170, 30, 210],
      sourceItem: { pageNumber: 1, index: 2, text: 'axis' }
    }
  ]
  f.page.lines = f.tokens.map((t: ReturnType<typeof JSON.parse>) => ({
    text: t.text,
    x: t.rect[0],
    y: t.rect[1],
    width: t.rect[2] - t.rect[0],
    height: t.rect[3] - t.rect[1],
    fontSize: 10
  }))
  f.tables = []
  return f
}
it('retains native reference carriers, header fonts and a rotated axis in one complete dense packet', () => {
  const f = completePacket(),
    before = structuredClone(f)
  expect(associate(f)[0].rect).toEqual([20, 130, 540, 310])
  expect(f).toEqual(before)
})
it.each([
  'stale-header',
  'duplicate-axis',
  'foreign-paragraph',
  'caption-barrier',
  'shared-paint',
  'foreign-table',
  'short-exterior-prose'
])('abstains from a single packet without complete native ownership: %s', (kind) => {
  const f = completePacket()
  if (kind === 'short-exterior-prose')
    f.tokens.push({
      text: 'Another paragraph.',
      horizontal: true,
      height: 10,
      rect: [50, 315, 250, 325],
      sourceItem: { pageNumber: 1, index: 9, text: 'Another paragraph.' }
    })
  if (kind === 'stale-header') f.tokens[1].sourceItem.text += ' Stale.'
  if (kind === 'duplicate-axis') f.tokens.push(structuredClone(f.tokens[2]))
  if (kind === 'foreign-paragraph')
    f.tokens.push({
      text: 'A separate ordinary paragraph explains a different result in this interval.',
      horizontal: true,
      height: 10,
      rect: [50, 220, 540, 230],
      sourceItem: {
        pageNumber: 1,
        index: 3,
        text: 'A separate ordinary paragraph explains a different result in this interval.'
      }
    })
  if (kind === 'caption-barrier')
    f.captions.push({ page: 1, lines: ['Figure 2. Earlier plate.'], rect: [30, 215, 570, 225] })
  if (kind === 'shared-paint')
    f.page.graphicsBounds.push({
      kind: 'path',
      operationIndex: 400,
      normalizedRect: [0, 140 / 800, 1, 320 / 800]
    })
  if (kind === 'foreign-table') f.tables.push([30, 140, 280, 200])
  expect(
    nativeRasterCaptionPacket(f.page, f.captions[0], f.captions, f.tables, f.tokens)
  ).toBeUndefined()
})

it.each(['same-page-table', 'neighbor-page', 'both'])(
  'keeps native peer ownership with complete production caption scope: %s',
  (scope) => {
    const f = fixture()
    if (scope !== 'neighbor-page')
      f.captions.push({
        page: 1,
        lines: ['TABLE I'],
        rect: [30, 40, 280, 60]
      })
    if (scope !== 'same-page-table')
      f.captions.push({
        page: 2,
        lines: ['Figure 3. A different page.'],
        rect: [30, 150, 570, 310]
      })
    const original = structuredClone(f)
    expect(
      nativeRasterPeerOwnership(f.page, f.captions, f.tables, f.tokens)?.map(
        (peer: { rect: number[] }) => peer.rect
      )
    ).toEqual([
      [40, 150, 250, 310],
      [330, 150, 540, 310]
    ])
    expect(associate(f).map((peer: { rect: number[] }) => peer.rect)).toEqual([
      [40, 150, 250, 310],
      [330, 150, 540, 310]
    ])
    expect(f).toEqual(original)
  }
)
it('retains a same-page foreign table caption as a physical ownership barrier', () => {
  const f = fixture()
  f.captions.push({ page: 1, lines: ['TABLE I'], rect: [50, 230, 250, 240] })
  expect(nativeRasterPeerOwnership(f.page, f.captions, f.tables, f.tokens)).toBeUndefined()
})

it('does not discard an invalid local non-figure caption boundary', () => {
  const f = fixture()
  f.captions.push({ page: 1, lines: ['TABLE I'], rect: [30, Number.NaN, 280, 60] })
  expect(nativeRasterPeerOwnership(f.page, f.captions, f.tables, f.tokens)).toBeUndefined()
})

function captionAboveStack(): ReturnType<typeof JSON.parse> {
  const width = 600,
    height = 800
  const captions = [2, 3, 4].map((number, i) => ({
    page: 1,
    rect: [40, 110 + 156 * i, 280, 120 + 156 * i],
    lines: [`Figure ${number}: A comparison plot.`]
  }))
  const tokens = captions.map((caption, index) => ({
    rect: caption.rect,
    height: 10,
    horizontal: true,
    text: caption.lines[0],
    sourceItem: { pageNumber: 1, index, text: caption.lines[0] }
  }))
  const rects = [0, 1, 2].map((index) => [46, 132 + 156 * index, 276, 224 + 156 * index])
  const normalize = (rect: number[]): number[] =>
    rect.map((v, index) => v / (index % 2 ? height : width))
  const graphicsBounds = rects.map((rect, operationIndex) => ({
    operationIndex,
    kind: 'image',
    normalizedRect: normalize([38, rect[1] - 4, 282, rect[3] + 4]),
    paintedNormalizedRect: normalize(rect)
  }))
  const context = {
    pageNumber: 1,
    viewport: { rotation: 0 },
    graphicsBounds,
    operators: {
      fnArray: rects.map(() => OPS.paintImageXObject),
      argsArray: rects.map((_, index) => [`anonymous-image-${index}`, 1200, 480])
    }
  }
  const page = {
    pageNumber: 1,
    width,
    height,
    rotation: 0,
    invalidGraphicsBounds: 0,
    graphicsBounds
  }
  const figures = captions.map((caption, index) => ({
    caption,
    rect: rects[Math.max(0, index - 1)]
  }))
  return { page, captions, tokens, context, figures, rects, tables: [] }
}

it('gives each numbered above-caption its own complete following raster in a closed stack', () => {
  const f = captionAboveStack()
  expect(
    nativeCaptionAboveRasterStack(
      f.page,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.figures
    )?.map((figure: { rect: number[] }) =>
      figure.rect.map((coordinate) => Number(coordinate.toFixed(8)))
    )
  ).toEqual(f.rects)
})

it.each([
  'stale-caption',
  'wrong-paint',
  'duplicate-image',
  'unproved-pixels',
  'crossing-table',
  'foreign-text'
])('does not replace earlier areas with a partial stacked proof: %s', (kind) => {
  const f = captionAboveStack()
  if (kind === 'stale-caption') f.tokens[1].sourceItem.text += ' Changed.'
  if (kind === 'wrong-paint') f.context.operators.fnArray[1] = OPS.paintInlineImageXObject
  if (kind === 'duplicate-image')
    f.context.operators.argsArray[1][0] = f.context.operators.argsArray[0][0]
  if (kind === 'unproved-pixels') delete f.page.graphicsBounds[1].paintedNormalizedRect
  if (kind === 'crossing-table') f.tables.push([80, 157, 270, 198])
  if (kind === 'foreign-text') f.tokens.push({ rect: [50, 234, 270, 245] })
  expect(
    nativeCaptionAboveRasterStack(f.page, f.captions, f.tables, f.tokens, f.context, f.figures)
  ).toBeUndefined()
})

it('reuses independent upper raster packets in the presence of a ruled header and a later figure', () => {
  const f = fixture(),
    { page, captions, tables, tokens } = f
  const rect = [320, 563, 570, 573]
  const caption = { page: 1, lines: ['Figure 3. A later independent plot.'], rect }
  captions.push(caption)
  const token = (text: string, rect: number[], index: number): ReturnType<typeof JSON.parse> => ({
    text,
    rect,
    horizontal: true,
    height: rect[3] - rect[1],
    sourceItem: { text, index, pageNumber: 1 }
  })
  tokens.push(
    token(caption.lines[0], rect, 2),
    token('Report', [40, 23, 63, 30], 3),
    token('1', [552, 23, 555, 30], 4)
  )
  const normalized = (b: number[]): number[] =>
    b.map((v, i) => v / (i % 2 ? page.height : page.width))
  page.graphicsBounds.push(
    { kind: 'path', operationIndex: 1, normalizedRect: normalized([38, 21, 70, 36]) },
    ...[0, 1, 2, 3].map((i) => ({
      kind: 'image',
      operationIndex: 200 + i,
      imageHash: 'foreign-plot-tile',
      normalizedRect: normalized([
        330 + (i % 2) * 100,
        410 + Math.floor(i / 2) * 52,
        430 + (i % 2) * 100,
        459 + Math.floor(i / 2) * 52
      ])
    }))
  )
  const figures = [
    { caption: captions[0], rect: [40, 23, 540, 310] },
    { caption: captions[1], rect: [330, 150, 540, 310] },
    { caption, rect: [320, 405, 550, 520] }
  ]
  const rules = [[37, 34, 560, 34]]
  const recover = (rules: number[][]): ReturnType<typeof JSON.parse> =>
    recoverNativePeerFigureBarrier(page, captions, figures, tables, rules, [], tokens)
  const result = recover(rules)
  expect(result.map((f: { rect: number[] }) => f.rect)).toEqual([
    [40, 150, 250, 310],
    [330, 150, 540, 310],
    [320, 405, 550, 520]
  ])
  expect(result[2]).toBe(figures[2])
  expect(recover([])).toBe(figures)
  page.graphicsBounds.at(-1).normalizedRect = normalized([325, 408, 529, 525])
  expect(recover(rules)).toBe(figures)
})
