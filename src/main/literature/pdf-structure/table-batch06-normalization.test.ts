import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-evidence.mjs')).href
)
const { removeEmptySeparatorColumns } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-grid-normalize.mjs')).href
)
const { detectTableContinuationTail } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-continuation.mjs')).href
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
  expect(repairs).toContain('empty-separator-column-removed')
})

it('marks an open narrative row that reaches the page crop edge', () => {
  const rows = [{ rect: [0, 0, 300, 40] }, { rect: [0, 40, 300, 100] }]
  const cells = [
    { row: 1, text: 'The final narrative row continues into the next page without a closing sentence' }
  ]
  expect(detectTableContinuationTail({ rows, cells, cropRect: [0, 0, 300, 100] })).toEqual({
    direction: 'next-page',
    row: 1,
    reason: 'open-row-at-crop-bottom'
  })
})
