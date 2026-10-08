import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { isFigureRiskTable, isFigureOwnedPartialTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-evidence.mjs')).href
)
it('rejects a risk strip even when detector padding captures adjacent prose', () => {
  const cells = Array.from({ length: 8 }, (_, i) => ({
    row: Math.floor(i / 4),
    column: i % 4,
    text: String(30 - i),
    sourceRects: [
      [
        100 + (i % 4) * 20,
        100 + Math.floor(i / 4) * 15,
        115 + (i % 4) * 20,
        110 + Math.floor(i / 4) * 15
      ]
    ]
  }))
  const page = { lines: [{ text: 'Number at risk', x: 80, y: 85, width: 60, height: 10 }] }
  const figures = [
    { rect: [50, 40, 250, 180], caption: { lines: ['Figure 1: Kaplan-Meier estimates'] } }
  ]
  const table = {
    cells: [
      ...cells,
      { row: 0, column: 4, text: 'Adjacent prose fragment', sourceRects: [[260, 100, 340, 110]] }
    ]
  }
  expect(isFigureRiskTable(table, figures, page, 1)).toBe(true)
  expect(isFigureRiskTable(table, figures, { lines: [] }, 1)).toBe(false)
  expect(
    isFigureRiskTable(
      {
        ...table,
        cells: [...cells, { row: 3, column: 1, text: '12', sourceRects: [[260, 120, 275, 130]] }]
      },
      figures,
      page,
      1
    )
  ).toBe(false)
})

it('rejects an uncaptioned partial table crop owned by a larger figure panel', () => {
  const table = {
    cropRect: [150, 120, 455, 287],
    issues: ['text-crosses-crop-boundary', 'unassigned-source-text'],
    unassigned: ['32 frames · 128 trajectories per dataset']
  }
  const figures = [{ rect: [108, 80, 506, 196] }]
  expect(isFigureOwnedPartialTable(table, figures)).toBe(true)
  expect(isFigureOwnedPartialTable({ ...table, issues: [], unassigned: [] }, figures)).toBe(false)
})
