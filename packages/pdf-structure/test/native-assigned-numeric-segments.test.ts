import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolve } from './paths'
const { splitPdfNumericRuns, nativeWhitespaceGaps } = await import(
  pathToFileURL(resolve('resources/literature-pdf-symbol-text.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { refineMeasuredAssignedNumericSegments } = await import(
  pathToFileURL(resolve('resources/literature-pdf-source-segments.mjs')).href
)
type Origin = { pageNumber: number; index: number; text: string }
type Cell = {
  row: number
  column: number
  rowSpan: number
  colSpan: number
  text: string
  sourceRects: number[][]
  sourceTokens: Array<{ text: string; rect: number[]; sourceItem?: Origin }>
  sourceItems?: Origin[]
  sourceSegments?: Array<Origin & { start: number; end: number; rect: number[] }>
}
type Token = { text: string; rect: number[]; horizontal: boolean; sourceItem: Origin }
type Run = {
  text: string
  rect: number[]
  gaps: Array<{ left: number; right: number; index: number }>
}
function fixture(): { table: { cells: Cell[] }; tokens: Token[]; runs: Run[] } {
  const text = '12.5 12.5',
    sourceItem = { pageNumber: 1, index: 7, text },
    item = {
      str: text,
      dir: 'ltr',
      fontName: 'native',
      width: 44,
      height: 10,
      transform: [10, 0, 0, 10, 10, 50],
      sourceItem
    }
  const content = { items: [item] },
    operators = {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [
        ['native', 10],
        [
          Array.from(text).map((unicode) => ({
            unicode,
            width: unicode === ' ' ? 400 : 500,
            isSpace: unicode === ' '
          }))
        ]
      ]
    }
  const viewport = {
    rotation: 0,
    scale: 1,
    transform: [1, 0, 0, -1, 0, 60],
    convertToViewportPoint: (x: number, y: number) => [x, 60 - y]
  }
  expect(splitPdfNumericRuns(content, operators).items).toEqual([item])
  const cells: Cell[] = [
    [10, 0, 32, 10],
    [32, 0, 54, 10]
  ].map((rect, column) => ({
    row: 2,
    column,
    rowSpan: 1,
    colSpan: 1,
    text: '12.5',
    sourceRects: [rect],
    sourceTokens: [{ text: '12.5', rect }],
    sourceItems: [sourceItem]
  }))
  return {
    table: { cells },
    tokens: [tableTextToken(item, viewport, 0)],
    runs: nativeWhitespaceGaps(content, operators, viewport)
  }
}
it('only shrinks complete assigned numeric clips to actual native glyph extents', () => {
  const { table, tokens, runs } = fixture(),
    before = structuredClone(table)
  refineMeasuredAssignedNumericSegments(table, tokens, runs)
  expect(table.cells.map((cell) => cell.sourceRects)).toEqual([
    [[10, 0, 30, 10]],
    [[34, 0, 54, 10]]
  ])
  expect(table.cells.map((cell) => cell.sourceSegments?.map((s) => [s.start, s.end]))).toEqual([
    [[0, 4]],
    [[5, 9]]
  ])
  expect(table.cells.map(({ row, column, text }) => ({ row, column, text }))).toEqual(
    before.cells.map(({ row, column, text }) => ({ row, column, text }))
  )
  expect(table.cells.every((cell) => cell.sourceItems === undefined)).toBe(true)
})
it.each([
  'cut-through-glyph',
  'missing-child',
  'duplicate-owner',
  'different-row',
  'spanning',
  'nonadjacent-column',
  'wrong-parent',
  'wrong-token-owner',
  'conflicting-parent-text',
  'missing-measurement',
  'duplicate-measurement',
  'wrong-gap-index',
  'baseline-mismatch',
  'clip-outside-parent',
  'competing-region',
  'missing-token'
])('preserves the original assignment without unsafe refinement: %s', (variant) => {
  const { table, tokens, runs } = fixture()
  if (variant === 'cut-through-glyph') {
    table.cells[0].sourceRects[0][2] = 29
    table.cells[1].sourceRects[0][0] = 29
  }
  if (variant === 'missing-child') table.cells.pop()
  if (variant === 'duplicate-owner') table.cells.push(structuredClone(table.cells[0]))
  if (variant === 'different-row') table.cells[1].row++
  if (variant === 'spanning') table.cells[1].colSpan = 2
  if (variant === 'nonadjacent-column') table.cells[1].column++
  if (variant === 'wrong-parent')
    table.cells[1].sourceItems = [{ ...tokens[0].sourceItem, index: 99 }]
  if (variant === 'wrong-token-owner')
    table.cells[1].sourceTokens[0].sourceItem = { ...tokens[0].sourceItem, index: 99 }
  if (variant === 'conflicting-parent-text')
    table.cells[1].sourceItems = [{ ...tokens[0].sourceItem, text: '12.5 99.9' }]
  if (variant === 'missing-measurement') runs.length = 0
  if (variant === 'duplicate-measurement') runs.push(structuredClone(runs[0]))
  if (variant === 'wrong-gap-index') runs[0].gaps[0].index = 3
  if (variant === 'baseline-mismatch') runs[0].rect[1]++
  if (variant === 'clip-outside-parent') table.cells[0].sourceRects[0][0]--
  if (variant === 'competing-region')
    table.cells.push({
      ...structuredClone(table.cells[0]),
      sourceItems: [{ pageNumber: 1, index: 99, text: '12.5' }]
    })
  if (variant === 'missing-token') table.cells[0].sourceTokens = []
  const before = structuredClone(table)
  refineMeasuredAssignedNumericSegments(table, tokens, runs)
  expect(table).toEqual(before)
})
it('rejects a parent claimed by cells in different tables', () => {
  const { table, tokens, runs } = fixture(),
    joined = { parts: table.cells.map((cell) => ({ cells: [cell] })) },
    before = structuredClone(joined)
  refineMeasuredAssignedNumericSegments(joined, tokens, runs)
  expect(joined).toEqual(before)
})

it.each(['signed-range', 'token-only-claim', 'duplicate-native'])(
  'rejects additional original-source ownership even away from the measured rect: %s',
  (variant) => {
    const { table, tokens, runs } = fixture()
    if (variant === 'duplicate-native') tokens.push(structuredClone(tokens[0]))
    else {
      const extra: Cell = {
        row: 7,
        column: 0,
        rowSpan: 1,
        colSpan: 1,
        text: '12.5',
        sourceRects: [[80, 30, 100, 40]],
        sourceTokens: [{ text: '12.5', rect: [80, 30, 100, 40] }]
      }
      if (variant === 'signed-range')
        extra.sourceSegments = [
          { ...tokens[0].sourceItem, start: 0, end: 4, rect: [80, 30, 100, 40] }
        ]
      else extra.sourceTokens[0].sourceItem = tokens[0].sourceItem
      table.cells.push(extra)
    }
    const before = structuredClone(table)
    refineMeasuredAssignedNumericSegments(table, tokens, runs)
    expect(table).toEqual(before)
  }
)

it('does not borrow a measurement from another native identity at the same geometry', () => {
  const { table, tokens, runs } = fixture()
  tokens.push({ ...structuredClone(tokens[0]), sourceItem: { ...tokens[0].sourceItem, index: 99 } })
  const before = structuredClone(table)
  refineMeasuredAssignedNumericSegments(table, tokens, runs)
  expect(table).toEqual(before)
})

it('does not overwrite pre-existing segments from a different original source', () => {
  const { table, tokens, runs } = fixture()
  table.cells[0].sourceSegments = [
    { pageNumber: 1, index: 99, text: '12.5', start: 0, end: 4, rect: [10, 0, 32, 10] }
  ]
  const before = structuredClone(table)
  refineMeasuredAssignedNumericSegments(table, tokens, runs)
  expect(table).toEqual(before)
})
