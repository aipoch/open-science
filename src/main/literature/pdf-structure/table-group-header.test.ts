import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const table = {
  id: 'grouped',
  cropRect: [0, 0, 700, 100],
  structure: {
    objects: [
      ...[20, 40, 60].map((y) => ({ label: 'table row', rect: [0, y, 700, y + 20] })),
      ...Array.from({ length: 7 }, (_, i) => ({
        label: 'table column',
        rect: [i * 100, 0, (i + 1) * 100, 100]
      })),
      { label: 'table column header', rect: [0, 20, 700, 60] },
      { label: 'table spanning cell', rect: [100, 40, 700, 60] },
      { label: 'table spanning cell', rect: [300, 40, 600, 60] },
      { label: 'table spanning cell', rect: [100, 20, 200, 60] }
    ]
  }
}
const token = (
  text: string,
  x: number,
  y: number,
  width = 40
): { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean } => ({
  text,
  rect: [x, y, x + width, y + 10],
  baseline: y + 10,
  height: 10,
  horizontal: true
})
const items = [
  token('Term', 10, 5),
  token('Treatment (N', 175, 5, 124),
  token('=', 300, 5, 5),
  token('100)', 306, 5, 25),
  token('Control (N', 475, 5, 124),
  token('=', 600, 5, 5),
  token('50)', 606, 5, 25),
  ...Array.from({ length: 6 }, (_, i) => token(`Grade ${i % 3}`, 120 + i * 100, 25)),
  token('Number (percent)', 330, 45, 140),
  token('Response', 10, 65),
  ...Array.from({ length: 6 }, (_, i) => token(String(i + 1), 120 + i * 100, 65))
]

it('recovers sibling group headers and a shared units row without splitting PDF text fragments', () => {
  const result = refineTable(table, items)
  expect(result.cells.filter((c: { row: number }) => c.row === 0)).toMatchObject([
    { column: 0, colSpan: 1, text: 'Term' },
    { column: 1, colSpan: 3, text: 'Treatment (N=100)' },
    { column: 4, colSpan: 3, text: 'Control (N=50)' }
  ])
  expect(
    result.cells.find((c: { row: number; column: number }) => c.row === 2 && c.column === 1)
  ).toMatchObject({ colSpan: 6, text: 'Number (percent)' })
  expect(result.grid[3]).toEqual(['Response', '1', '2', '3', '4', '5', '6'])
  expect(result.unassigned).toEqual([])
})

it('does not infer source group headers without model header evidence', () => {
  const noHeader = {
    ...table,
    structure: { objects: table.structure.objects.filter((o) => o.label !== 'table column header') }
  }
  expect(
    refineTable(noHeader, items).cells.filter(
      (c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan > 1
    )
  ).toEqual([])
})

it('does not guess parent spans when a child column is equidistant between labels', () => {
  const ambiguous = items.map((item) =>
    item.baseline === 15 && item.rect[0] >= 475
      ? { ...item, rect: item.rect.map((v, i) => (i % 2 ? v : v - 106)) }
      : item
  )
  const result = refineTable(table, ambiguous)
  expect(
    result.cells.filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan > 1)
  ).toEqual([])
})

it('does not extend a units label across all columns without a covering model span', () => {
  const partial = {
    ...table,
    structure: {
      objects: table.structure.objects.filter(
        (o) =>
          !(
            o.label === 'table spanning cell' &&
            o.rect[0] === 100 &&
            o.rect[1] === 40 &&
            o.rect[2] === 700
          )
      )
    }
  }
  const result = refineTable(partial, items)
  expect(
    result.cells.filter((c: { row: number; colSpan: number }) => c.row === 2 && c.colSpan === 6)
  ).toEqual([])
})

it('recovers three-level headers without splitting a child group between parents', () => {
  const nested = {
    ...table,
    structure: {
      objects: [
        ...[0, 20, 40, 60].map((y) => ({ label: 'table row', rect: [0, y, 700, y + 20] })),
        ...table.structure.objects.filter((o) => o.label === 'table column'),
        { label: 'table column header', rect: [0, 0, 700, 60] }
      ]
    }
  }
  const result = refineTable(nested, [
    token('Study groups', 330, 5, 140),
    token('Treatment', 180, 25, 140),
    token('Control', 480, 25, 140),
    ...Array.from({ length: 6 }, (_, i) => token(`Grade ${i % 3}`, 120 + i * 100, 45)),
    token('Response', 10, 65),
    ...Array.from({ length: 6 }, (_, i) => token(String(i + 1), 120 + i * 100, 65))
  ])
  expect(
    result.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 1)
  ).toMatchObject({ colSpan: 6, text: 'Study groups' })
  expect(
    result.cells.filter((c: { row: number; colSpan: number }) => c.row === 1 && c.colSpan === 3)
  ).toHaveLength(2)
})
