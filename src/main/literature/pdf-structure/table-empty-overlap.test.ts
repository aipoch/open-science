import { readPdfFixture } from './read-fixture'
import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { removeEmptyOverlappingRows } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-row-repair.mjs')).href
)
const fixture = readPdfFixture(
  resolve('src/main/literature/pdf-structure/fixtures/source-grids/empty-overlapping-row.jsonl')
)

it('removes two unsupported overlap bands without changing any source record', () => {
  const x = structuredClone(fixture)
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.grid).toEqual(x.expectedGrid)
  expect(result.repairs.filter((r: string) => r === 'empty-overlapping-row-removed')).toHaveLength(
    2
  )
  expect(result.unassigned).toEqual([])
  for (const cell of result.cells) {
    expect(result.grid[cell.row][cell.column]).toBe(cell.text)
    expect(cell.row + cell.rowSpan).toBeLessThanOrEqual(result.grid.length)
  }
})

function overlappingRows(): {
  rows: { rect: number[]; origin: string }[]
  cells: {
    row: number
    column: number
    rowSpan: number
    colSpan: number
    text: string
    rect: number[]
    sourceRects: number[][]
  }[]
  items: { rect: number[]; text: string }[]
  rules: number[][]
  repairs: string[]
} {
  const rows = [
    { rect: [0, 0, 300, 14], origin: 'model' },
    { rect: [0, 8, 300, 22], origin: 'model' },
    { rect: [0, 17, 300, 31], origin: 'model' }
  ]
  const cells = rows.flatMap((band, row) =>
    ['Category', '2 (20)', '3 (30)'].map((text, column) => ({
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      text: row === 1 ? '' : text,
      rect: [column * 100, band.rect[1], (column + 1) * 100, band.rect[3]],
      sourceRects:
        row === 1
          ? []
          : [[column * 100 + 5, row === 0 ? 1 : 18, column * 100 + 50, row === 0 ? 11 : 28]]
    }))
  )
  const items = cells.flatMap((cell) => cell.sourceRects.map((rect) => ({ rect, text: cell.text })))
  return { rows, cells, items, rules: [], repairs: [] }
}

it('renumbers cells after removing an unsupported overlapping band', () => {
  const x = overlappingRows()
  removeEmptyOverlappingRows(x)
  expect(x.rows).toHaveLength(2)
  expect(x.cells.map((cell) => cell.row)).toEqual([0, 0, 0, 1, 1, 1])
})

it.each([
  'rule',
  'unassigned-token',
  'vertical-span',
  'source-gap',
  'blank-spacer',
  'missing-value'
])('preserves an empty row with %s evidence', (condition) => {
  const x = overlappingRows()
  if (condition === 'rule') x.rules.push([0, 15, 300, 15])
  if (condition === 'unassigned-token') x.items.push({ rect: [2, 12, 12, 16], text: '*' })
  if (condition === 'vertical-span') x.cells[0].rowSpan = 2
  if (condition === 'source-gap') {
    for (const cell of x.cells.filter((cell) => cell.row === 2)) cell.sourceRects[0][3] += 8
  }
  if (condition === 'blank-spacer') x.rows[1].rect = [0, 14, 300, 17]
  if (condition === 'missing-value') x.cells.at(-1)!.text = ''
  const before = structuredClone(x)
  removeEmptyOverlappingRows(x)
  expect(x).toEqual(before)
})

function singleBaselineOverlap(): ReturnType<typeof overlappingRows> {
  const x = overlappingRows()
  x.rows[1].rect = [0, 17, 300, 24]
  return x
}

it('removes a short redundant band owned entirely by one neighboring source row', () => {
  const x = singleBaselineOverlap()
  removeEmptyOverlappingRows(x)
  expect(x.rows).toHaveLength(2)
  expect(x.repairs).toEqual(['empty-overlapping-row-removed'])
})

it.each(['rule', 'unassigned-token', 'wide-band', 'outside-baseline', 'vertical-span'])(
  'preserves a one-sided band with %s evidence',
  (condition) => {
    const x = singleBaselineOverlap()
    if (condition === 'rule') x.rules.push([0, 20, 300, 20])
    if (condition === 'unassigned-token') x.items.push({ rect: [2, 20, 12, 23], text: '*' })
    if (condition === 'wide-band') x.rows[1].rect[3] += 10
    if (condition === 'outside-baseline') x.rows[1].rect = [0, 14, 300, 19]
    if (condition === 'vertical-span') x.cells[0].rowSpan = 2
    const before = structuredClone(x)
    removeEmptyOverlappingRows(x)
    expect(x).toEqual(before)
  }
)

it('removes empty model bands between native threshold records without losing unit exponents', () => {
  const x = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/moderator-statistic-rows.jsonl'
    )
  )
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid).toHaveLength(35)
  expect(t.grid.every((row: string[]) => row.some(Boolean))).toBe(true)
  expect(t.repairs.filter((r: string) => r === 'empty-overlapping-row-removed')).toHaveLength(2)
  const unit = t.cells.find((c: { text: string }) => c.text === '≤25 kg/m2')
  expect(unit.textRuns).toContainEqual(
    expect.objectContaining({ text: '2', position: 'superscript' })
  )
  expect(t.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects)).toHaveLength(223)
})

function thresholdRows(): ReturnType<typeof overlappingRows> {
  const x = overlappingRows()
  x.cells[0].text = '≤25 kg/m2'
  x.cells[6].text = '>25–≤30'
  const anchor = x.items[0]
  Object.assign(anchor, { text: '≤25 kg/m', baseline: 11, height: 10, horizontal: true })
  const exponent = { text: '2', rect: [51, 0, 55, 7], baseline: 7, height: 7, horizontal: true }
  x.items.push(exponent)
  x.cells[0].sourceRects.push(exponent.rect)
  return x
}

it('retains a uniquely attached unit exponent while removing a redundant threshold band', () => {
  const x = thresholdRows(),
    rects = structuredClone(x.cells.flatMap((c) => c.sourceRects))
  removeEmptyOverlappingRows(x)
  expect(x.rows).toHaveLength(2)
  expect(x.cells.flatMap((c) => c.sourceRects)).toEqual(rects)
})

it.each(['detached-exponent', 'ambiguous-anchor', 'unassigned-token', 'rule', 'non-numeric-label'])(
  'keeps a threshold band with %s',
  (variant) => {
    const x = thresholdRows()
    if (variant === 'detached-exponent') {
      x.items.at(-1)!.rect[0] += 20
      x.items.at(-1)!.rect[2] += 20
    }
    if (variant === 'ambiguous-anchor') {
      const anchor = { ...x.items[0], rect: [20, 1, 49, 11] }
      x.items.push(anchor)
      x.cells[0].sourceRects.push(anchor.rect)
    }
    if (variant === 'unassigned-token') x.items.push({ text: '*', rect: [20, 12, 25, 16] })
    if (variant === 'rule') x.rules.push([0, 15, 300, 15])
    if (variant === 'non-numeric-label') x.cells[0].text = '≤ unknown'
    const before = structuredClone(x)
    removeEmptyOverlappingRows(x)
    expect(x).toEqual(before)
  }
)
