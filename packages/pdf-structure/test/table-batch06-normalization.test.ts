/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'

const { hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-evidence.mjs')).href
)
const { removeEmptySeparatorColumns } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-grid-normalize.mjs')).href
)
const { detectTableContinuationTail } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-continuation.mjs')).href
)

it('rejects a damaged equation crop even when a caption is attached', () => {
  const table = {
    cropRect: [0, 0, 600, 200],
    grid: [
      ['p−1 (bmax)', 'p−1 d d 2bmax+2'],
      ['βB 2 max K βB', 'max βB bmax'],
      ['', ''],
      ['', '']
    ],
    cells: [],
    rows: [],
    unassigned: Array.from({ length: 28 }, (_, i) => `fragment ${i}`),
    clipped: Array.from({ length: 34 }, (_, i) => ({ text: `glyph ${i}`, rect: [0, 0, 1, 1] })),
    issues: ['text-crosses-crop-boundary', 'unassigned-source-text'],
    repairs: []
  }
  expect(hasTableEvidence(table, { lines: ['Table 1. Supplementary derivation.'] })).toBe(false)
})

it('routes a captioned prose card away from table evidence', () => {
  const prose = 'A long narrative explanation '.repeat(12).trim()
  const table = {
    cropRect: [0, 0, 600, 300],
    grid: [[prose], [prose], [prose]],
    cells: [],
    rows: [],
    unassigned: Array.from({ length: 22 }, (_, i) => `tail ${i}`),
    clipped: Array.from({ length: 4 }, (_, i) => ({ text: `tail ${i}`, rect: [0, 0, 1, 1] })),
    issues: ['text-crosses-crop-boundary'],
    repairs: []
  }
  expect(hasTableEvidence(table, { lines: ['Table 14. Narrative comparison.'] })).toBe(false)
})

it('removes an unowned separator column while preserving a source-backed blank', () => {
  const makeCell = (row: number, column: number, text: string, sourceRects: number[][] = []) => ({
    row,
    column,
    rowSpan: 1,
    colSpan: 1,
    rect: [column * 100, row * 20, (column + 1) * 100, row * 20 + 15],
    text,
    sourceRects
  })
  const cells = [
    makeCell(0, 0, 'A'),
    makeCell(0, 1, 'B'),
    makeCell(0, 2, ''),
    makeCell(0, 3, 'C'),
    makeCell(1, 0, '1'),
    makeCell(1, 1, '2'),
    makeCell(1, 2, ''),
    makeCell(1, 3, '3')
  ]
  cells[3].rect = [330, 0, 400, 15]
  cells[7].rect = [330, 20, 400, 35]
  const columnRects = [
    [0, 0, 100, 40],
    [100, 0, 200, 40],
    [200, 0, 300, 40],
    [300, 0, 400, 40]
  ]
  const columns = columnRects.map((rect) => ({ rect }))
  const repairs: string[] = []
  expect(removeEmptySeparatorColumns({ cells, columns, columnRects, items: [], repairs })).toBe(1)
  expect(columnRects).toHaveLength(3)
  expect(cells.map((cell) => cell.column)).toEqual([0, 1, 2, 0, 1, 2])
  expect(cells.filter((cell) => cell.text === 'C')[0].rect).toEqual([300, 0, 400, 15])
  expect(repairs).toContain('empty-separator-column-removed')
})

it('marks an open narrative row that reaches the page crop edge', () => {
  const rows = [{ rect: [0, 0, 300, 40] }, { rect: [0, 40, 300, 100] }]
  const cells = [
    {
      row: 1,
      text: 'The final narrative row continues into the next page without a closing sentence'
    }
  ]
  expect(detectTableContinuationTail({ rows, cells, cropRect: [0, 0, 300, 100] })).toEqual({
    direction: 'next-page',
    row: 1,
    reason: 'open-row-at-crop-bottom'
  })
})

// Synthetic geometry preserves only a ruled body and detector padding touching notes.
const ruledMeasurements = (columns = 2): ReturnType<typeof JSON.parse> => {
  const tokens = [],
    cells = [],
    grid = []
  for (let row = 0; row < 3; row++) {
    const values = [`q${row}/qR`, ...Array(columns - 1).fill('2.4 × 10−3 ± 8%')]
    grid.push(values)
    for (const [column, text] of values.entries()) {
      const rect = [20 + column * 90, 30 + row * 20, 85 + column * 90, 40 + row * 20]
      tokens.push({ text, rect, horizontal: true, height: 10 })
      cells.push({ row, column, rowSpan: 1, colSpan: 1, text, rect, sourceRects: [rect] })
    }
  }
  const notes = Array.from({ length: 10 }, (_, i) => ({
    text: i % 2 ? 'x' : '0',
    rect: [20 + i * 8, i % 2 ? 92 : 89, 25 + i * 8, i % 2 ? 102 : 96],
    horizontal: true,
    height: i % 2 ? 10 : 7
  }))
  return {
    table: {
      cropRect: [10, 15, columns * 90, 97],
      grid,
      cells,
      rows: grid.map((_, row) => ({ rect: [10, 30 + row * 20, columns * 90, 40 + row * 20] })),
      unassigned: notes.filter((_, i) => i % 2 === 0).map((i) => i.text),
      clipped: notes.filter((_, i) => i % 2 === 1),
      issues: ['text-crosses-crop-boundary', 'unassigned-source-text']
    },
    caption: {
      lines: ['Table 1. Relative measurements.'],
      rect: [10 / 1.5, 0, (columns * 90) / 1.5, 10 / 1.5]
    },
    tokens: [...tokens, ...notes],
    rules: [
      [15, 20, columns * 90 - 5, 20],
      [15, 85, columns * 90 - 5, 85]
    ]
  }
}

it.each([2, 3])(
  'keeps a %s-column ruled measurement body when only its notes touch detector padding',
  (columns) => {
    const f = ruledMeasurements(columns)
    expect(hasTableEvidence(f.table, f.caption, f.tokens, f.rules)).toBe(true)
  }
)

it.each(['no-closing-rule', 'unowned-body', 'crossing-note', 'missing-source', 'no-caption'])(
  'retains damaged-formula rejection without complete body ownership: %s',
  (change) => {
    const f = ruledMeasurements()
    if (change === 'no-closing-rule') f.rules.pop()
    if (change === 'unowned-body')
      f.tokens.push({ text: 'lost', rect: [90, 55, 100, 65], height: 10, horizontal: true })
    if (change === 'crossing-note') f.tokens.at(-1).rect[1] = 84
    if (change === 'missing-source') f.tokens.shift()
    if (change === 'no-caption') f.caption = undefined
    expect(hasTableEvidence(f.table, f.caption, f.tokens, f.rules)).toBe(false)
  }
)

it.each(['body-replacement', 'body-control', 'unassigned-above', 'unknown-unassigned'])(
  'does not excuse non-footer damage as padding: %s',
  (change) => {
    const f = ruledMeasurements()
    if (change.startsWith('body-')) {
      const text = change === 'body-replacement' ? 'q�/�R' : 'q\u0001/\u0002R'
      for (let row = 0; row < 3; row++) {
        f.table.grid[row][0] = text
        f.table.cells[row * 2].text = text
        f.tokens[row * 2].text = text
      }
    }
    if (change === 'unassigned-above') {
      for (const token of f.tokens.slice(6).filter((_, i) => i % 2 === 0))
        token.rect = [20, 16, 25, 19]
    }
    if (change === 'unknown-unassigned') f.table.unassigned.push('missing body word')
    expect(hasTableEvidence(f.table, f.caption, f.tokens, f.rules)).toBe(false)
  }
)
