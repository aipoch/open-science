import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
// Minimized from clinical Table 1: the last predicted row ends above the
// source text centers, yet intersects their top edges. It contains no text.
const table = {
  id: 'last-row',
  cropRect: [0, 0, 300, 80],
  structure: {
    objects: [
      { label: 'table row', rect: [0, 0, 300, 20] },
      { label: 'table row', rect: [0, 30, 300, 42] },
      ...[0, 100, 200].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 80] }))
    ]
  }
}
const token = (text: string, x: number, y: number): object => ({
  text,
  rect: [x, y, x + 50, y + 12],
  baseline: y + 12,
  height: 12,
  horizontal: true
})
const first = [token('First', 5, 4), token('10', 105, 4), token('20', 205, 4)]
const last = [token('Last', 5, 38), token('30', 105, 38), token('40', 205, 38)]

it('aligns an empty predicted row with overlapping multi-column source text without adding a row', () => {
  const result = refineTable(table, [...first, ...last])
  expect(result.grid).toEqual([
    ['First', '10', '20'],
    ['Last', '30', '40']
  ])
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
})

it('does not move an occupied row or absorb an isolated footnote', () => {
  const occupied = refineTable(table, [...first, token('Existing', 5, 29), ...last])
  expect(occupied.grid[1][0]).toBe('Existing')
  expect(occupied.unassigned).toEqual(['Last', '30', '40'])
  const note = refineTable(table, [...first, token('* A note', 5, 38)])
  expect(note.grid[1]).toEqual(['', '', ''])
  expect(note.unassigned).toEqual(['* A note'])
})

it('does not choose between two empty row bands intersecting the same source line', () => {
  const ambiguous = {
    ...table,
    structure: {
      objects: [...table.structure.objects, { label: 'table row', rect: [0, 50, 300, 62] }]
    }
  }
  const result = refineTable(ambiguous, [
    ...first,
    token('Last', 5, 40),
    token('30', 105, 40),
    token('40', 205, 40)
  ])
  expect(result.grid.slice(1)).toEqual([
    ['', '', ''],
    ['', '', '']
  ])
  expect(result.unassigned).toEqual(['Last', '30', '40'])
})

it('separates two complete numeric records captured by one shifted model row', () => {
  const shifted = {
    ...table,
    structure: {
      objects: [
        ...table.structure.objects.filter((o) => o.label !== 'table row'),
        { label: 'table row', rect: [0, 10, 300, 41] }
      ]
    }
  }
  const result = refineTable(shifted, [
    token('Group A', 5, 5),
    token('108 (86)', 105, 5),
    token('55 (89)', 205, 5),
    token('Group B', 5, 28),
    token('17 (14)', 105, 28),
    token('7 (11)', 205, 28)
  ])
  expect(result.grid).toEqual([
    ['Group A', '108 (86)', '55 (89)'],
    ['Group B', '17 (14)', '7 (11)']
  ])
  expect(result.unassigned).toEqual([])
})
