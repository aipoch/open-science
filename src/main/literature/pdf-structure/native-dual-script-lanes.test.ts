import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { populateTableCellText } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-cell-text.mjs')).href
)
type Token = {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
}
type LaneInput = { base: Token; upper: Token; first: Token; last: Token; items: Token[] }
const token = (
  text: string,
  left: number,
  right: number,
  baseline: number,
  height: number
): Token => ({
  text,
  rect: [left, baseline - height, right, baseline],
  baseline,
  height,
  horizontal: true
})
const input = (): LaneInput => {
  const base = token('K', 20, 33.5, 36, 16),
    upper = token('(7)', 33.9, 50.1, 27.4, 12),
    first = token('q', 33.51, 39.1, 40.6, 12),
    last = token('+3', 39.5, 55.7, 40.6, 12)
  return { base, upper, first, last, items: [base, upper, first, last] }
}
it('keeps one continuous native lower script together below a parenthesized upper', () => {
  const f = input(),
    before = JSON.stringify(f.items),
    x = {
      cells: [{ row: 0, column: 0, rowSpan: 1, colSpan: 1, rect: [0, 0, 80, 55], items: [] }],
      items: f.items,
      pageItems: f.items,
      rows: [{ rect: [0, 0, 80, 55] }],
      columnRects: [[0, 0, 80, 55]],
      headerRows: [],
      rules: [],
      bottom: 55,
      issues: new Set(),
      repairs: []
    }
  expect(populateTableCellText(x)).toEqual([])
  expect(x.cells[0].textRuns).toEqual([
    { text: 'K', position: 'normal' },
    { text: 'q+3', position: 'subscript' },
    { text: '(7)', position: 'superscript' }
  ])
  expect(x.cells[0].sourceRects).toHaveLength(4)
  expect(JSON.stringify(f.items)).toBe(before)
})
const { orderNativeDualScriptLanes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-dual-script-lanes.mjs')).href
)
const anchored = (): LaneInput & { line: Token[]; anchors: Map<Token, Token> } => {
  const f = input(),
    line = [f.base, f.first, f.upper, f.last],
    anchors = new Map(f.items.filter((i) => i !== f.base).map((i) => [i, f.base]))
  return { ...f, line, anchors }
}
it('orders closed lanes by their first source occurrence without mutating the input', () => {
  const f = anchored(),
    before = [...f.line]
  expect(orderNativeDualScriptLanes(f.line, f.anchors)).toEqual([f.base, f.first, f.last, f.upper])
  expect(orderNativeDualScriptLanes([f.base, f.upper, f.first, f.last], f.anchors)).toEqual([
    f.base,
    f.upper,
    f.first,
    f.last
  ])
  expect(f.line).toEqual(before)
})
it.each([
  'ordinary prose',
  'multiple bases',
  'different direct base',
  'nested lower anchor',
  'large script',
  'open upper',
  'non-numeric upper',
  'one lower',
  'different lower baselines',
  'wide lower gap',
  'overlapping lower',
  'detached start',
  'crossing lanes'
])('declines unproved dual native lanes: %s', (variant) => {
  const f = anchored()
  if (variant === 'ordinary prose') f.base.text = 'Paragraph'
  if (variant === 'multiple bases') {
    const other = token('M', 60, 72, 36, 16)
    f.line.push(other)
  }
  if (variant === 'different direct base') f.anchors.set(f.last, token('M', 60, 72, 36, 16))
  if (variant === 'nested lower anchor') f.anchors.set(f.last, f.first)
  if (variant === 'large script') f.last.height = 15
  if (variant === 'open upper') f.upper.text = '(7'
  if (variant === 'non-numeric upper') f.upper.text = '(word)'
  if (variant === 'one lower') f.line = f.line.filter((i) => i !== f.last)
  if (variant === 'different lower baselines') f.last.baseline += 2
  if (variant === 'wide lower gap') {
    f.last.rect[0] += 5
    f.last.rect[2] += 5
  }
  if (variant === 'overlapping lower') {
    f.last.rect[0] = 37
  }
  if (variant === 'detached start') {
    f.first.rect[0] += 3
    f.first.rect[2] += 3
  }
  if (variant === 'crossing lanes') f.upper.rect[3] = f.first.rect[1]
  expect(orderNativeDualScriptLanes(f.line, f.anchors)).toBeUndefined()
})
