import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { groupTableParts } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-group.mjs')).href
)
const line = (
  text: string,
  y: number
): { text: string; x: number; y: number; width: number; height: number } => ({
  text,
  x: 10,
  y,
  width: 90,
  height: 10
})
const page = {
  lines: [line('Table 1. Sample data.', 0), line('A. Tricco data', 15), line('B. Dewa data', 110)]
}
const table = (
  id: string,
  top: number,
  bottom: number,
  columns: number
): {
  id: string
  page: number
  cropRect: number[]
  rows: { rect: number[] }[]
  grid: string[][]
  cells: never[]
  unassigned: string[]
  issues: string[]
  notes: { text: string; rect: number[] }[]
  sourceViewport: { width: number; height: number }
} => ({
  id,
  page: 1,
  cropRect: [0, top * 1.5, 300, bottom * 1.5],
  rows: [{ rect: [0, top * 1.5, 300, bottom * 1.5] }],
  grid: [Array(columns).fill('Value')],
  cells: [],
  unassigned: [],
  issues: [],
  notes: [],
  sourceViewport: { width: 300, height: 600 }
})
const parts = [
  {
    ...table('table-1', 30, 100, 5),
    caption: { text: 'Table 1. Sample data.', rect: [0, 0, 200, 10] }
  },
  {
    ...table('table-2', 125, 200, 7),
    notes: [{ text: 'Shared note', rect: [0, 205, 200, 215] }],
    captionIssue: 'unmatched-caption'
  }
]
it('groups consecutive labelled parts under one caption without flattening their columns', () => {
  const groups = groupTableParts(parts, page)
  expect(groups).toHaveLength(1)
  expect(groups[0].parts.map((p: { title: string }) => p.title)).toEqual([
    'A. Tricco data',
    'B. Dewa data'
  ])
  expect(groups[0].parts.map((p: { grid: string[][] }) => p.grid[0].length)).toEqual([5, 7])
  expect(groups[0].notes).toEqual(parts[1].notes)
  expect(groups[0].parts.every((p: { notes: unknown[] }) => !p.notes.length)).toBe(true)
  expect(groups[0].cropRect).toEqual([0, 0, 300, 322.5])
  expect(groups[0].captionIssue).toBeUndefined()
})
it('keeps independent, unlabelled, interrupted and nonconsecutive tables separate', () => {
  expect(groupTableParts([{ ...parts[0], caption: undefined }, parts[1]], page)).toHaveLength(2)
  expect(
    groupTableParts(
      [parts[0], { ...parts[1], caption: { text: 'Table 2.', rect: [0, 110, 200, 120] } }],
      page
    )
  ).toHaveLength(2)
  for (const lines of [
    page.lines.slice(0, 2),
    [...page.lines.slice(0, 2), line('C. Other data', 110)],
    [...page.lines, line('Discussion of unrelated results.', 101)]
  ]) {
    expect(groupTableParts(parts, { lines })).toHaveLength(2)
  }
  expect(groupTableParts([{ ...parts[0], notes: parts[1].notes }, parts[1]], page)).toHaveLength(2)
})

it('joins explicitly marked same-page column continuations and keeps their caption and notes', () => {
  const header = ['Variable', 'Group A', 'Group B']
  const first = {
    ...table('left', 10, 100, 3),
    grid: [header, ['Age', '60', '61']],
    cells: [{ row: 1, column: 0, text: 'Age' }]
  }
  const next = {
    ...table('right', 10, 50, 3),
    cropRect: [315, 15, 615, 75],
    caption: { text: 'Table 1: Baseline characteristics.', rect: [210, 50, 410, 60] },
    grid: [header, ['(Continued from previous column)', '', ''], ['R0', '48', '43']],
    cells: [
      { row: 0, column: 0, text: 'Variable' },
      { row: 2, column: 0, text: 'R0' }
    ],
    notes: [{ text: 'Abbreviations: R0 = complete resection.', rect: [210, 60, 410, 70] }]
  }
  const page = { lines: [line('(Table 1 continued on next column)', 90)] }
  const [joined] = groupTableParts([next, first], page)
  expect(groupTableParts([next, first], page)).toHaveLength(1)
  expect(joined.grid).toEqual([header, ['Age', '60', '61'], ['R0', '48', '43']])
  expect(joined.cells.at(-1)).toMatchObject({ row: 2, text: 'R0' })
  expect(joined.caption).toEqual(next.caption)
  expect(joined.notes).toEqual(next.notes)
  expect(groupTableParts([first, next], { lines: [] })).toHaveLength(2)
  expect(
    groupTableParts(
      [first, { ...next, caption: { ...next.caption, text: 'Table 2: Other data.' } }],
      page
    )
  ).toHaveLength(2)
  expect(
    groupTableParts(
      [first, { ...next, grid: [['Different', 'A', 'B'], ...next.grid.slice(1)] }],
      page
    )
  ).toHaveLength(2)
})

it('joins explicitly labelled column continuations in source reading order', () => {
  const first = {
    ...table('left', 70, 600, 3),
    cropRect: [20, 105, 320, 900],
    caption: { text: 'Table 1. Characteristics', rect: [15, 50, 200, 65] },
    grid: [
      ['Characteristic', 'Treatment', 'Control'],
      ['Age', '51', '52']
    ],
    cells: [{ row: 1, column: 0, rowSpan: 1, colSpan: 1, text: 'Age' }]
  }
  const next = {
    ...table('right', 62, 180, 3),
    cropRect: [340, 93, 640, 270],
    caption: { text: 'Table 1 (continued)', rect: [225, 45, 400, 60] },
    grid: [
      ['Characteristic', 'Treatment', 'Control'],
      ['Statin', '2', '0']
    ],
    cells: [{ row: 1, column: 0, rowSpan: 1, colSpan: 1, text: 'Statin' }],
    notes: [{ text: 'Data are counts.', rect: [230, 185, 410, 195] }]
  }
  const result = groupTableParts([next, first], { lines: [] })
  expect(result).toHaveLength(1)
  expect(result[0].grid).toEqual([...first.grid, next.grid[1]])
  expect(result[0].cells.at(-1)).toMatchObject({ text: 'Statin', row: 2 })
  expect(result[0].notes).toEqual(next.notes)
  expect(result[0].caption).toEqual(first.caption)
  const marker = { text: '(Continued )', x: 180, y: 606, width: 28, height: 10 }
  const withFooter = {
    ...first,
    cropRect: [20, 105, 320, 918],
    unassigned: ['(', 'Continued', ')'],
    clipped: [{ text: 'Continued', rect: [270, 909, 312, 924] }],
    issues: ['unassigned-source-text', 'text-crosses-crop-boundary']
  }
  const joined = groupTableParts([withFooter, next], { lines: [marker] })[0]
  expect(joined.unassigned).toEqual([])
  expect(joined.clipped).toEqual([])
  expect(joined.issues).toEqual([])
  expect(joined.cropRect[3]).toBeLessThan(909)
  expect(joined.grid).toEqual(result[0].grid)
  for (const lines of [[], [{ ...marker, y: 300 }]]) {
    expect(groupTableParts([withFooter, next], { lines })[0].unassigned).toEqual(
      withFooter.unassigned
    )
  }
  const unresolved = { ...withFooter, unassigned: [...withFooter.unassigned, 'Missing count'] }
  expect(groupTableParts([unresolved, next], { lines: [marker] })[0].unassigned).toContain(
    'Missing count'
  )
  for (const other of [
    { ...next, caption: { ...next.caption, text: 'Table 2 (continued)' } },
    { ...next, grid: [['Different', 'A', 'B'], next.grid[1]] },
    { ...next, page: 2 }
  ])
    expect(groupTableParts([other, first], { lines: [] })).toHaveLength(2)
})
