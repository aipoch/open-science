import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const token = (
  text: string,
  x: number,
  y: number,
  width: number
): { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean } => ({
  text,
  rect: [x, y, x + width, y + 10],
  baseline: y + 10,
  height: 10,
  horizontal: true
})
const caption = [{ lines: ['Table III. Groups'], rect: [0, -20, 1100, -10] }]
const headers = [
  token('Sequencing type (Basis)', 10, 10, 180),
  token('Group name (N)', 230, 10, 150),
  token('Survival', 410, 10, 60),
  token('Clinical/Immune', 510, 10, 130),
  token('Molecular findings', 780, 10, 150),
  token('(Refs.)', 1040, 10, 50)
]
const items = [
  ...headers,
  token('Study type', 10, 50, 140),
  token('(several', 10, 65, 140),
  token('measurements)', 10, 80, 140),
  token('Subtype One', 230, 50, 140),
  token('(10)', 230, 65, 35),
  token('Subtype Two (20)', 230, 80, 150),
  token('Good', 410, 50, 40),
  token('Poor', 410, 80, 40),
  token('First group findings', 680, 50, 300),
  token('tail', 680, 65, 25),
  token('Second group findings', 680, 80, 300),
  token('continued', 680, 95, 65),
  token('(1)', 1040, 50, 25),
  token('Another study', 10, 120, 140),
  token('Subtype Three (30)', 230, 120, 155),
  token('Third group findings', 680, 120, 300),
  token('(2)', 1040, 120, 25)
]
const raw = {
  cropRect: [0, 0, 1100, 145],
  structure: {
    objects: [
      // The detector swallows the empty clinical column and splits wrapped lines.
      ...[0, 200, 400, 650, 1020].map((x, i, a) => ({
        label: 'table column',
        rect: [x, 0, a[i + 1] ?? 1100, 145]
      })),
      ...[10, 50, 65, 80, 95, 120].map((y) => ({ label: 'table row', rect: [0, y, 1100, y + 10] })),
      { label: 'table column header', rect: [0, 0, 1100, 30] },
      { label: 'table spanning cell', rect: [200, 50, 400, 105] }
    ]
  }
}
const rules = [
  [0, 0, 1100, 0],
  [0, 30, 1100, 30]
]

it('recovers study records, wrapped group names, empty columns and independent study spans', () => {
  const result = refineTable(raw, items, caption, [], rules)
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
  expect(result.grid).toHaveLength(4)
  expect(result.grid[0]).toHaveLength(6)
  expect(result.grid.map((r: string[]) => r[1])).toEqual([
    'Group name (N)',
    'Subtype One (10)',
    'Subtype Two (20)',
    'Subtype Three (30)'
  ])
  expect(result.grid[1][4]).toBe('First group findings tail')
  expect(result.grid[2][4]).toBe('Second group findings continued')
  expect(result.grid.every((r: string[], i: number) => !i || r[3] === '')).toBe(true)
  expect(result.cells).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        text: 'Study type (several measurements)',
        column: 0,
        row: 1,
        rowSpan: 2
      }),
      expect.objectContaining({ text: '(1)', column: 5, row: 1, rowSpan: 2 })
    ])
  )
})

it('requires a caption, a ruled header and the explicit group/count structure', () => {
  for (const [source, captions, borders] of [
    [items, [], rules],
    [items, caption, []],
    [
      [...items.filter((i) => i.text !== 'Group name (N)'), token('Description', 230, 10, 150)],
      caption,
      rules
    ]
  ]) {
    expect(refineTable(raw, source, captions, [], borders).repairs).not.toContain(
      'text-supported-study-records-recovered'
    )
  }
})
