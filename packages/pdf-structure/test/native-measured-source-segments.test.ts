import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolve } from './paths'

const { splitPdfNumericRuns } = await import(
  pathToFileURL(resolve('resources/literature-pdf-symbol-text.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { attachMeasuredTableSourceSegments } = await import(
  pathToFileURL(resolve('resources/literature-pdf-source-segments.mjs')).href
)

type Origin = { pageNumber: number; index: number; text: string }
type Range = Origin & { start: number; end: number }
type Segment = Range & { rect: number[] }
type Glyph = { unicode: string; width: number; isSpace: boolean }
type NativeItem = {
  str: string
  dir: string
  fontName: string
  width: number
  height: number
  transform: number[]
  sourceItem?: Origin
  sourceSegment?: Range
}
type Token = { text: string; rect: number[]; sourceItem?: Origin; sourceSegment?: Segment }
type Cell = {
  row?: number
  column?: number
  text: string
  sourceRects: number[][]
  sourceTokens: Array<{ text: string; rect: number[] }>
  sourceItems?: Origin[]
  sourceSegments?: Segment[]
}
type Fixture = {
  content: { items: NativeItem[] }
  operators: { fnArray: number[]; argsArray: Array<Array<string | number | Glyph[]>> }
  viewport: {
    rotation: number
    scale: number
    transform: number[]
    convertToViewportPoint: (x: number, y: number) => number[]
  }
}
function fixture(text = '12.5 12.5'): Fixture {
  const glyphs = Array.from(text).map((unicode) => ({
    unicode,
    width: /\s/u.test(unicode) ? 1000 : 500,
    isSpace: /\s/u.test(unicode)
  }))
  const item = {
    str: text,
    dir: 'ltr',
    fontName: 'native',
    width: glyphs.reduce((n, g) => n + g.width / 100, 0),
    height: 10,
    transform: [10, 0, 0, 10, 10, 50],
    sourceItem: { pageNumber: 1, index: 7, text }
  }
  const content = { items: [item] },
    operators = { fnArray: [OPS.setFont, OPS.showText], argsArray: [['native', 10], [glyphs]] }
  const viewport = {
    rotation: 0,
    scale: 1,
    transform: [1, 0, 0, -1, 0, 60],
    convertToViewportPoint: (x: number, y: number) => [x, 60 - y]
  }
  return { content, operators, viewport }
}
function split(text?: string): Token[] {
  const { content, operators, viewport } = fixture(text)
  return splitPdfNumericRuns(content, operators).items.map((item: NativeItem) =>
    tableTextToken(item, viewport, 0)
  )
}
const cellsFor = (tokens: Token[]): Cell[] =>
  tokens.map((token, column) => ({
    row: 0,
    column,
    text: token.text,
    sourceRects: [token.rect],
    sourceTokens: [{ text: token.text, rect: token.rect }]
  }))

it('retains exact distinct UTF16 source ranges and measured whitespace gaps for repeated numeric values', () => {
  const tokens = split(),
    cells = cellsFor(tokens)
  expect(tokens).toHaveLength(2)
  expect(tokens.map((t) => t.sourceItem)).toEqual([undefined, undefined])
  attachMeasuredTableSourceSegments({ cells }, tokens)
  expect(cells.map((c) => c.sourceSegments)).toEqual([
    [{ pageNumber: 1, index: 7, text: '12.5 12.5', start: 0, end: 4, rect: [10, 0, 30, 10] }],
    [{ pageNumber: 1, index: 7, text: '12.5 12.5', start: 5, end: 9, rect: [40, 0, 60, 10] }]
  ])
})

it('keeps UTF16 offsets for astral glyphs and literal whitespace', () => {
  const { content, operators, viewport } = fixture('𝛼X  Beta')
  const rules = [0, 20, 40, 60].map((y) => [0, y, 100, y])
  for (const x of [0, 30, 80, 100]) rules.push([x, 0, x, 60])
  const tokens = splitPdfNumericRuns(content, operators, { viewport, rules }).items.map(
    (item: NativeItem) => tableTextToken(item, viewport, 0)
  )
  expect(tokens.map((t: Token) => t.text)).toEqual(['𝛼X', 'Beta'])
  expect(tokens.map((t: Token) => [t.sourceSegment!.start, t.sourceSegment!.end])).toEqual([
    [0, 3],
    [5, 9]
  ])
})

it.each([
  'origin-text-changed',
  'no-origin',
  'unmeasured-width',
  'ordinary-inline-space',
  'already-segmented'
])('does not sign unsupported native provenance: %s', (variant) => {
  const { content, operators } = fixture()
  const item = content.items[0]
  if (variant === 'origin-text-changed') item.sourceItem!.text = 'other source'
  if (variant === 'no-origin') delete item.sourceItem
  if (variant === 'unmeasured-width') item.width += 1
  if (variant === 'ordinary-inline-space') {
    ;(operators.argsArray[1][0] as Glyph[])[4].width = 200
    item.width -= 8
  }
  if (variant === 'already-segmented')
    item.sourceSegment = { pageNumber: 1, index: 7, text: item.str, start: 0, end: item.str.length }
  const result = splitPdfNumericRuns(content, operators).items
  expect(result.every((i: NativeItem) => !i.sourceSegment)).toBe(true)
})

it('covers a mixed cell with whole native sources while keeping separate parent ranges', () => {
  const tokens = split(),
    extra = {
      text: '*',
      rect: [62, 0, 67, 10],
      sourceItem: { pageNumber: 1, index: 8, text: '*' }
    },
    cells = cellsFor(tokens)
  tokens.push(extra)
  cells[1].sourceRects.push(extra.rect)
  cells[1].sourceTokens.push({ text: extra.text, rect: extra.rect })
  cells[1].text += ' *'
  attachMeasuredTableSourceSegments({ cells }, tokens)
  expect(cells[1].sourceSegments).toHaveLength(2)
  expect(cells[1].sourceSegments![1]).toEqual({
    ...extra.sourceItem,
    start: 0,
    end: 1,
    rect: extra.rect
  })
  expect(cells[1].sourceItems).toBeUndefined()
})

it.each([
  'duplicate-cell',
  'duplicate-native',
  'changed-text',
  'changed-rect',
  'unmatched-region',
  'inconsistent-parent',
  'whole-owner-elsewhere',
  'overlapping-range'
])('keeps ambiguous or incomplete cell ownership unsigned: %s', (variant) => {
  const tokens = split(),
    cells = cellsFor(tokens)
  if (variant === 'duplicate-cell') cells.push(structuredClone(cells[0]))
  if (variant === 'duplicate-native') tokens.push(structuredClone(tokens[0]))
  if (variant === 'changed-text') cells[0].sourceTokens[0].text = 'rewritten'
  if (variant === 'changed-rect') tokens[0].sourceSegment!.rect = [9, 0, 30, 10]
  if (variant === 'unmatched-region') {
    cells[0].sourceRects.push([70, 0, 75, 10])
    cells[0].sourceTokens.push({ text: '*', rect: [70, 0, 75, 10] })
  }
  if (variant === 'inconsistent-parent') tokens[1].sourceSegment!.text = 'XX.X 12.5'
  if (variant === 'whole-owner-elsewhere')
    cells.push({
      text: '12.5 12.5',
      sourceTokens: [],
      sourceItems: [{ pageNumber: 1, index: 7, text: '12.5 12.5' }],
      sourceRects: [[10, 20, 60, 30]]
    })
  if (variant === 'overlapping-range') {
    tokens[1].sourceSegment!.start = 0
    tokens[1].sourceSegment!.end = 4
  }
  attachMeasuredTableSourceSegments({ cells }, tokens)
  expect(cells[0].sourceSegments).toBeUndefined()
})

it('rejects a measured fragment copied across table parts', () => {
  const tokens = split(),
    cells = cellsFor(tokens),
    duplicate = structuredClone(cells[0])
  attachMeasuredTableSourceSegments(
    { parts: [{ cells }, { parts: [{ cells: [duplicate] }] }] },
    tokens
  )
  expect(cells[0].sourceSegments).toBeUndefined()
  expect(duplicate.sourceSegments).toBeUndefined()
})

it('sorts mixed source evidence by original source index without reordering source regions', () => {
  const tokens = split(),
    extra: Token = {
      text: '*',
      rect: [62, 0, 67, 10],
      sourceItem: { pageNumber: 1, index: 3, text: '*' }
    },
    cells = cellsFor(tokens)
  tokens.push(extra)
  cells[1].sourceRects.push(extra.rect)
  cells[1].sourceTokens.push({ text: extra.text, rect: extra.rect })
  const regions = structuredClone(cells[1].sourceRects)
  attachMeasuredTableSourceSegments({ cells }, tokens)
  expect(cells[1].sourceSegments?.map((s) => s.index)).toEqual([3, 7])
  expect(cells[1].sourceRects).toEqual(regions)
})

it.each(['cell', 'token', 'segment'])(
  'preserves conflicting pre-existing provenance: %s',
  (variant) => {
    const tokens = split(),
      cells = cellsFor(tokens),
      foreign = { pageNumber: 1, index: 99, text: '12.5' }
    if (variant === 'cell') cells[0].sourceItems = [foreign]
    if (variant === 'token') Object.assign(cells[0].sourceTokens[0], { sourceItem: foreign })
    if (variant === 'segment')
      Object.assign(cells[0].sourceTokens[0], {
        sourceSegment: { ...foreign, start: 0, end: 4, rect: [10, 0, 30, 10] }
      })
    const before = structuredClone(cells[0])
    attachMeasuredTableSourceSegments({ cells }, tokens)
    expect(cells[0]).toEqual(before)
  }
)

it('counts already-signed claims from other parts before signing a duplicate range', () => {
  const tokens = split(),
    cells = cellsFor(tokens),
    existing = {
      text: '12.5',
      sourceRects: [[10, 20, 30, 30]],
      sourceSegments: [{ ...tokens[0].sourceSegment! }]
    }
  attachMeasuredTableSourceSegments({ parts: [{ cells }, { cells: [existing] }] }, tokens)
  expect(cells[0].sourceSegments).toBeUndefined()
})

it('retains token-only competing provenance from an incomplete cell', () => {
  const tokens = split(),
    cells = cellsFor(tokens)
  const other = {
    text: '12.5',
    sourceRects: [[10, 20, 30, 30]],
    sourceTokens: [
      {
        text: '12.5',
        rect: [10, 20, 30, 30],
        sourceItem: { pageNumber: 1, index: 7, text: '12.5 12.5' }
      }
    ]
  }
  attachMeasuredTableSourceSegments({ parts: [{ cells }, { cells: [other] }] }, tokens)
  expect(cells[0].sourceSegments).toBeUndefined()
})
