import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)

it('merges a group header split into separate PDF word operators', () => {
  const table = {
    cropRect: [0, 0, 300, 40],
    structure: {
      objects: [
        ...[0, 100, 150, 200, 250].map((x, i, xs) => ({
          label: 'table column',
          rect: [x, 0, xs[i + 1] ?? 300, 40]
        })),
        { label: 'table row', rect: [0, 0, 300, 20] },
        { label: 'table row', rect: [0, 20, 300, 40] },
        { label: 'table column header', rect: [0, 0, 300, 40] }
      ]
    }
  }
  const result = refineTable(table, [
    token('Events', 5, 5, 35),
    ...[100, 200].flatMap((x) => [
      token('Group', x + 5, 5, 25),
      token('(n', x + 33, 5, 12),
      token('=', x + 48, 5, 6),
      token('51)', x + 57, 5, 18)
    ]),
    ...[100, 150, 200, 250].map((x) => token('Grade', x + 5, 25, 30))
  ])
  expect(result.unassigned).toEqual([])
  expect(
    result.cells.filter(
      (cell: { row: number; colSpan: number }) => cell.row === 0 && cell.colSpan === 2
    )
  ).toHaveLength(2)
})
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

// A font switch and a column boundary can split one parent label into pieces
// wholly contained in different child columns (CDD Table 1).
it('keeps a proven parent span when PDF text fragments fall inside different child columns', () => {
  const sample = {
    cropRect: [0, 0, 400, 80],
    structure: {
      objects: [
        { label: 'table row', rect: [0, 20, 400, 40] },
        { label: 'table row', rect: [0, 40, 400, 60] },
        { label: 'table column header', rect: [0, 20, 400, 40] },
        ...Array.from({ length: 4 }, (_, i) => ({
          label: 'table column',
          rect: [i * 100, 0, (i + 1) * 100, 80]
        }))
      ]
    }
  }
  const result = refineTable(sample, [
    token('Variables', 10, 5),
    token('Expression (', 130, 5, 164),
    token('n', 295, 5, 4),
    token('=', 300, 5, 4),
    token('200 patients)', 305, 5, 80),
    token('Low', 120, 25),
    token('High', 220, 25),
    token('P', 320, 25),
    token('Age', 10, 45),
    token('0.1', 320, 45)
  ])
  expect(
    result.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 1)
  ).toMatchObject({ colSpan: 3, text: 'Expression (n=200 patients)' })
  expect(result.issues).not.toContain('span-conflicts-with-source-columns')
  expect(result.grid[1]).toEqual(['', 'Low', 'High', 'P'])
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

it.each([
  ['10', '20'],
  ['A', 'B']
])('does not join independent close column labels: %s / %s', (a, b) => {
  const sample = {
    cropRect: [0, 0, 200, 40],
    structure: {
      objects: [
        { label: 'table row', rect: [0, 0, 200, 20] },
        { label: 'table row', rect: [0, 20, 200, 40] },
        { label: 'table column header', rect: [0, 0, 200, 40] },
        { label: 'table column', rect: [0, 0, 100, 40] },
        { label: 'table column', rect: [100, 0, 200, 40] }
      ]
    }
  }
  const result = refineTable(sample, [
    token(a, 80, 5, 19),
    token(b, 100, 5, 19),
    token('First', 10, 25),
    token('Second', 130, 25)
  ])
  expect(result.grid[0]).toEqual([a, b])
  expect(result.cells.every((c: { colSpan: number }) => c.colSpan === 1)).toBe(true)
  expect(result.issues).toContain('span-conflicts-with-source-columns')
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

it('separates underlined treatment parents from leaf headers after numeric row recovery', () => {
  const edges = [0, 160, 260, 360, 460, 560]
  const raw = {
    id: 'underlined-treatment-parents',
    cropRect: [0, 0, 560, 260],
    structure: {
      objects: [
        ...edges
          .slice(1)
          .map((end, c) => ({ label: 'table column', rect: [edges[c], 40, end, 260] })),
        { label: 'table column header', rect: [0, 40, 560, 58] },
        { label: 'table row', rect: [0, 40, 560, 58] },
        ...Array.from({ length: 10 }, (_, r) => ({
          label: 'table row',
          rect: [0, 60 + r * 20, 560, 80 + r * 20]
        }))
      ]
    }
  }
  const header = [
    token('Event, n (%)', 5, 42, 75),
    ...[180, 380].flatMap((x, i) => [
      token(i ? 'Placebo +' : 'Treatment +', x + 25, 10, 55),
      token('Drug', x + 83, 10, 30),
      token('(n =', x + 44, 24, 25),
      token(i ? '112)' : '114)', x + 72, 24, 23),
      token('Any Grade', x, 42, 50),
      token('Grade ≥3', x + 115, 42, 55)
    ])
  ]
  const body = Array.from({ length: 10 }, (_, r) => [
    token(`Event ${r}`, 5, 64 + r * 20, 60),
    ...[180, 295, 380, 495].map((x, c) => token(c % 2 ? '0' : '12 (24)', x, 64 + r * 20, 40))
  ]).flat()
  const rules = [
    [0, 2, 560, 2],
    [180, 42.8, 350, 42.8],
    [380, 42.8, 550, 42.8],
    [0, 58, 560, 58],
    [0, 260, 560, 260]
  ]
  const captions = [{ lines: ['Table 2. Adverse events'], rect: [0, -25, 560, -10] }]
  const result = refineTable(raw, [...header, ...body], captions, [], rules)
  expect(result.cells).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        text: 'Treatment + Drug (n = 114)',
        row: 0,
        column: 1,
        colSpan: 2
      }),
      expect.objectContaining({ text: 'Placebo + Drug (n = 112)', row: 0, column: 3, colSpan: 2 })
    ])
  )
  expect(result.grid[1]).toEqual(['Event, n (%)', 'Any Grade', 'Grade ≥3', 'Any Grade', 'Grade ≥3'])
  expect(result.grid.slice(2)).toEqual(
    Array.from({ length: 10 }, (_, r) => [`Event ${r}`, '12 (24)', '0', '12 (24)', '0'])
  )
  expect(refineTable(raw, [...header, ...body], captions).repairs).not.toContain(
    'underlined-parent-band-recovered'
  )
  expect(
    refineTable(
      raw,
      [...header, ...body],
      captions,
      [],
      rules.filter((r) => r[0] !== 380)
    ).repairs
  ).not.toContain('underlined-parent-band-recovered')
  const noModelHeader = structuredClone(raw)
  noModelHeader.structure.objects = noModelHeader.structure.objects.filter(
    (o) => o.label !== 'table column header'
  )
  expect(
    refineTable(noModelHeader, [...header, ...body], captions, [], rules).repairs
  ).not.toContain('underlined-parent-band-recovered')
})
