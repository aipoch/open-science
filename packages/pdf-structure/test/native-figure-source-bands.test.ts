import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { readPdfFixture } from './read-fixture'

const { associateFigures, associatePreviousPageRasterFigure } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
type Rect = number[]
type Caption = { page: number; lines: string[]; rect: Rect }
type Line = { text: string; x: number; y: number; width: number; height: number; fontSize: number }
type Token = {
  text: string
  rect: Rect
  height: number
  baseline: number
  horizontal: boolean
  fontDescent: number
}
type Page = {
  pageNumber: number
  width: number
  height: number
  rotation: number
  invalidGraphicsBounds: number
  lines: Line[]
  graphicsBounds: {
    kind: string
    normalizedRect: Rect
    paintedNormalizedRect?: Rect
    imageHash?: string
  }[]
}
type Fixture = {
  page: Page
  candidates: Caption[]
  tableRects: Rect[]
  rules: Rect[]
  closedFrames: Rect[]
  nativeTokens: Token[]
  operatorContext?: {
    viewport: { transform: number[] }
    operators: { fnArray: number[]; argsArray: unknown[][] }
  }
}
const fixture = (key: string): Fixture =>
  readPdfFixture('test/fixtures/source-grids/native-figure-source-bands.jsonl')[key]
const associate = (f: Fixture): { caption: Caption; rect?: Rect }[] =>
  associateFigures(
    f.page,
    f.candidates,
    f.tableRects,
    f.rules,
    f.closedFrames,
    f.nativeTokens,
    f.operatorContext
  )

it('owns both native keyed raster panels and their complete label fonts under a short centered caption', () => {
  const f = fixture('keyedRasterRow'),
    before = structuredClone(f)
  const [found] = associate(f)
  expect(found.rect).toBeDefined()
  expect(found.rect![0]).toBeLessThan(60)
  expect(found.rect![2]).toBeGreaterThan(550)
  expect(found.rect![3]).toBeGreaterThan(404)
  expect(found.rect![3]).toBeLessThan(f.candidates[0].rect[1])
  expect(f).toEqual(before)
})

it('does not join keyed raster panels through an independent caption', () => {
  const f = fixture('keyedRasterRow')
  f.candidates.push({ page: 1, lines: ['Figure 2. Another owner.'], rect: [280, 320, 340, 335] })
  const found = associate(f).find((item) => item.caption === f.candidates[0])
  expect(found?.rect === undefined || found.rect[2] - found.rect[0] < 400).toBe(true)
})

it('retains the native centered heading of every repeated raster row', () => {
  const f = fixture('centeredRowHeadings')
  const [found] = associate(f)
  expect(found.rect![1]).toBeLessThanOrEqual(95.495)
  expect(found.rect![3]).toBeGreaterThan(340)
})

it('does not borrow a lone heading without the second row heading witness', () => {
  const f = fixture('centeredRowHeadings')
  f.nativeTokens = f.nativeTokens.filter((token) => token.rect[1] < 200 || token.rect[1] > 250)
  expect(associate(f)[0].rect![1]).toBeGreaterThan(100)
})

it('keeps an isolated native vector strip and labels separate from the preceding prose card', () => {
  const f = fixture('isolatedVectorBand')
  const [found] = associate(f)
  expect(found.rect![1]).toBeGreaterThan(680)
  expect(found.rect![0]).toBeLessThanOrEqual(337.616)
  expect(found.rect![3]).toBeGreaterThanOrEqual(724.477)
})

it('does not claim an isolated vector strip already owned by a table', () => {
  const f = fixture('isolatedVectorBand')
  f.tableRects.push([330, 690, 500, 730])
  expect(associate(f)[0].rect?.[1] ?? 0).toBeLessThan(680)
})

it('completes a native keyed plot plate including headings, vertical labels, and font descenders', () => {
  const f = fixture('keyedPlotBand')
  const [found] = associate(f)
  expect(found.rect![0]).toBeLessThanOrEqual(54.49)
  expect(found.rect![1]).toBeLessThanOrEqual(67.585)
  expect(found.rect![2]).toBeGreaterThan(538)
  expect(found.rect![3]).toBeGreaterThan(158)
})

it('keeps proved running-head fonts out of keyed plot completion', () => {
  const f = fixture('keyedPlotBand'),
    expected = associate(f)[0].rect
  const header = [
    { text: 'Anonymous author', rect: [54, 36, 144, 46] },
    { text: '1', rect: [550, 36, 556, 46] }
  ]
  f.page.lines.push({
    text: 'Anonymous author 1',
    x: 54,
    y: 36,
    width: 502,
    height: 10,
    fontSize: 10
  })
  f.nativeTokens.push(
    ...header.map((t) => ({ ...t, height: 10, baseline: 46, horizontal: true, fontDescent: -0.2 }))
  )
  f.rules.push([50, 52, 560, 52])
  const snapshot = structuredClone(f)
  expect(associate(f)[0].rect).toEqual(expected)
  expect(f).toEqual(snapshot)
  const withLabel = structuredClone(f)
  withLabel.page.lines.push({ text: 'X', x: 280, y: 38, width: 8, height: 8, fontSize: 8 })
  withLabel.nativeTokens.push({
    text: 'X',
    rect: [280, 38, 288, 46],
    height: 8,
    baseline: 46,
    horizontal: true,
    fontDescent: -0.2
  })
  expect(associate(withLabel)[0].rect![1]).toBeLessThanOrEqual(38)
  f.rules.pop()
  expect(associate(f)[0].rect![1]).toBeLessThanOrEqual(36)
})

it('preserves an already complete four-panel native plate through later local plot matching', () => {
  const f = fixture('completeKeyedPlot'),
    before = structuredClone(f)
  const [found] = associate(f)
  expect(found.rect![2]).toBeGreaterThan(550)
  expect(found.rect![3]).toBeGreaterThan(350)
  for (const token of f.nativeTokens.filter((t) => /^[a-d]$/u.test(t.text))) {
    expect(found.rect![0]).toBeLessThanOrEqual(token.rect[0])
    expect(found.rect![1]).toBeLessThanOrEqual(token.rect[1])
    expect(found.rect![2]).toBeGreaterThanOrEqual(token.rect[2])
    expect(found.rect![3]).toBeGreaterThanOrEqual(token.rect[3])
  }
  expect(f).toEqual(before)
})

it.each(['missing-key', 'intervening-prose', 'invalid-graphics'])(
  'requires complete isolated native keyed plot evidence with %s',
  (failure) => {
    const f = fixture('keyedPlotBand')
    if (failure === 'missing-key')
      f.nativeTokens = f.nativeTokens.filter((t) => !t.text.startsWith('(b)'))
    if (failure === 'intervening-prose')
      f.page.lines.push({
        text: 'This is an independent article paragraph with enough ordinary words to establish that the nearby plot does not own it.',
        x: 60,
        y: 40,
        width: 470,
        height: 10,
        fontSize: 10
      })
    if (failure === 'invalid-graphics') f.page.invalidGraphicsBounds = 1
    expect(associate(f)[0].rect![0]).toBeGreaterThan(100)
  }
)

const splitPages = (): { pages: Page[]; captions: Caption[] } => {
  const make = (pageNumber: number, bounds?: Rect): Page => ({
    pageNumber,
    width: 600,
    height: 800,
    rotation: 0,
    invalidGraphicsBounds: 0,
    lines: [],
    graphicsBounds: bounds
      ? [
          {
            kind: 'image',
            imageHash: String(pageNumber).repeat(64),
            normalizedRect: bounds.map((v, n) => v / (n % 2 ? 800 : 600))
          }
        ]
      : []
  })
  const pages = [make(1, [100, 100, 500, 300]), make(2, [100, 500, 500, 720]), make(3)]
  const captions = [
    { page: 1, lines: ['Figure 1. Earlier native plate.'], rect: [100, 310, 500, 320] },
    { page: 3, lines: ['Figure 2. Following native plate.'], rect: [100, 60, 500, 70] }
  ]
  for (const c of captions)
    pages[c.page - 1].lines.push({
      text: c.lines[0],
      x: c.rect[0],
      y: c.rect[1],
      width: 400,
      height: 10,
      fontSize: 10
    })
  return { pages, captions }
}

it('associates a lone terminal raster with its following-page caption and preceding-page sequence witness', () => {
  const { pages, captions } = splitPages()
  const found = associatePreviousPageRasterFigure(pages[1], pages, captions)
  expect(found).toHaveLength(1)
  expect(found[0].rect).toEqual([100, 500, 500, 720])
  expect(found[0].caption.page).toBe(3)
})

it('does not carry a terminal raster across an intervening paragraph', () => {
  const { pages, captions } = splitPages()
  pages[1].lines.push({
    text: 'A separate discussion follows this illustration.',
    x: 100,
    y: 722,
    width: 400,
    height: 10,
    fontSize: 10
  })
  expect(associatePreviousPageRasterFigure(pages[1], pages, captions)).toEqual([])
})

it('recovers native vector strokes whose quantized boxes spill across a separate caption', () => {
  const f = fixture('quantizedVectorBand')
  const [found] = associate(f)
  expect(found.rect).toBeDefined()
  expect(found.rect![1]).toBeLessThan(525)
  expect(found.rect![3]).toBeGreaterThan(591)
  expect(found.rect![3]).toBeLessThan(f.candidates[0].rect[1])
})

it.each(['missing-native', 'crossing-stroke', 'wide-miter'])(
  'keeps a quantized boundary unresolved with %s evidence',
  (failure) => {
    const f = fixture('quantizedVectorBand')
    if (failure === 'missing-native') f.operatorContext = undefined
    if (failure === 'crossing-stroke') {
      f.operatorContext!.operators.fnArray.push(91)
      f.operatorContext!.operators.argsArray.push([
        20,
        [[0, 343, 590, 1, 343, 600]],
        [343, 590, 343, 600]
      ])
    }
    if (failure === 'wide-miter') {
      f.operatorContext!.operators.argsArray[0] = [4]
      f.operatorContext!.operators.argsArray[1] = [0]
    }
    expect(associate(f)[0].rect).toBeUndefined()
  }
)
