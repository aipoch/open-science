import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
type SourceToken = {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
}
const token = (text: string, column: number, y: number, indent = 10): SourceToken => ({
  text,
  rect: [column * 100 + indent, y, column * 100 + 90, y + 10],
  baseline: y + 10,
  height: 10,
  horizontal: true
})
const parent = (text: string, x: number): SourceToken => ({
  ...token(text, 0, 10),
  rect: [x + 20, 10, x + 180, 20]
})
const categories = ['First', 'Second', 'Third']
const source = [
  parent('Treatment (n = 12)', 100),
  parent('Control (n = 9)', 300),
  ...['', 'Mean (SD)', 'Number (valid %)', 'Mean (SD)', 'Number (valid %)', 'p-value'].flatMap(
    (text, c) => (text ? [token(text, c, 30)] : [])
  ),
  token('Age', 0, 50),
  token('50 (±8)', 1, 50),
  token('55 (±9)', 3, 50),
  token('.5', 5, 50),
  ...Array.from({ length: 4 }, (_, group) => [
    token(`Category group ${group}`, 0, 70 + group * 80),
    ...categories.flatMap((label, i) => {
      const y = 90 + group * 80 + i * 20
      return [
        token(label, 0, y, 20),
        token(`${i + 1} (10)`, 2, y),
        token(i === 2 ? '0' : `${i + 2} (20)`, 4, y),
        ...(i === 0 ? [token('.8', 5, y)] : [])
      ]
    })
  ]).flat()
]
const raw = {
  cropRect: [0, 0, 600, 390],
  structure: {
    objects: [
      ...Array.from({ length: 6 }, (_, c) => ({
        label: 'table column',
        rect: [c * 100, 0, c * 100 + 100, 390]
      })),
      { label: 'table column header', rect: [0, 10, 600, 42] },
      ...[
        [10, 42],
        [50, 62],
        ...Array.from({ length: 4 }, (_, i) => [70 + i * 80, 142 + i * 80])
      ].map(([top, bottom]) => ({ label: 'table row', rect: [0, top, 600, bottom] }))
    ]
  }
}
const rules = [
  [100, 5, 300, 5],
  [300, 5, 500, 5],
  ...[100, 300, 500].map((x) => [x, 5, x, 25]),
  [100, 25, 300, 25],
  [300, 25, 500, 25],
  ...[45, 65, 145, 225, 305, 385].map((y) => [0, y, 600, y])
]
const caption = [{ lines: ['Table 1. Participant characteristics'], rect: [0, -30, 600, -15] }]
const run = (items = source, lines = rules): ReturnType<typeof refineTable> =>
  refineTable(raw, items, caption, [], lines)

it('separates sparse mean/count records and ruled treatment headers without filling blank cells', () => {
  const result = run()
  expect(result.grid).toHaveLength(19)
  expect(result.grid.slice(0, 3)).toEqual([
    ['', 'Treatment (n = 12)', '', 'Control (n = 9)', '', ''],
    ['', 'Mean (SD)', 'Number (valid %)', 'Mean (SD)', 'Number (valid %)', 'p-value'],
    ['Age', '50 (±8)', '', '55 (±9)', '', '.5']
  ])
  expect(result.grid[6]).toEqual(['Third', '', '3 (10)', '', '0', ''])
  for (const column of [1, 3]) {
    expect(
      result.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === column)
        ?.colSpan
    ).toBe(2)
  }
  expect(result.unassigned).toEqual([])
})

it('shares a single category P value only through the next source border', () => {
  const result = run()
  for (const row of [4, 8, 12, 16]) {
    expect(
      result.cells.find((c: { row: number; column: number }) => c.row === row && c.column === 5)
        ?.rowSpan
    ).toBe(3)
  }
  for (const variant of [
    run([...source, token('.2', 5, 110)]),
    run(
      source,
      rules.filter((r) => r[1] !== 145)
    )
  ]) {
    expect(
      variant.cells.find((c: { row: number; column: number }) => c.row === 4 && c.column === 5)
        ?.rowSpan
    ).toBe(1)
  }
})

it('does not reconstruct partial records when the repeated statistic units are missing', () => {
  const result = run(
    source.map((item) =>
      item.text === 'Number (valid %)' ? { ...item, text: 'Description' } : item
    )
  )
  expect(result.repairs).not.toContain('text-supported-numeric-rows-recovered')
  expect(result.grid.length).toBeLessThan(19)
})

it('uses the full source header box when a recovered glyph band is shorter than its cell', () => {
  const headings = [
    { ...token('Observed Treatment Effects', 2, 10), rect: [200, 10, 410, 20] },
    token('Effect Size', 5, 10),
    { ...token('P-values', 6, 10), rect: [680, 10, 740, 20] },
    ...[
      '',
      'Mean',
      'Median',
      'Lower Quartile',
      'Upper Quartile',
      'Effect',
      'Within-group',
      'Between-group'
    ].flatMap((value, c) => (value ? [token(value, c, 30)] : []))
  ]
  const items = [
    ...headings,
    ...Array.from({ length: 4 }, (_, i) => {
      const y = 50 + i * 30
      return [
        token(`Outcome ${i}`, 0, y),
        ...[1, 2, 3, 4].flatMap((c) => [token('T: 1.5', c, y), token('C: 0.5', c, y + 12)]),
        token('0.4', 5, y),
        token('.03', 6, y),
        token('.1', 6, y + 12),
        token('.05', 7, y)
      ]
    }).flat()
  ]
  const table = {
    cropRect: [0, 0, 800, 168],
    structure: {
      objects: [
        ...Array.from({ length: 8 }, (_, c) => ({
          label: 'table column',
          rect: [c * 100, 0, c * 100 + 100, 168]
        })),
        { label: 'table column header', rect: [0, 30, 800, 42] },
        { label: 'table row', rect: [0, 30, 800, 42] },
        ...Array.from({ length: 4 }, (_, i) => ({
          label: 'table row',
          rect: [0, 50 + i * 30, 800, 74 + i * 30]
        }))
      ]
    }
  }
  const borders = [
    [100, 5, 500, 5],
    [100, 25, 500, 25],
    [100, 5, 100, 25],
    [500, 5, 500, 25]
  ]
  const result = refineTable(table, items, caption, [], borders)
  expect(
    result.cells.find((c: { text: string }) => c.text === 'Observed Treatment Effects')?.colSpan
  ).toBe(4)
  expect(result.grid[1][4]).toBe('Upper Quartile')
  expect(result.grid[2][4]).toBe('T: 1.5 C: 0.5')
  const openBox = refineTable(table, items, caption, [], [])
  expect(
    openBox.cells.find((c: { text: string }) => c.text === 'Observed Treatment Effects')?.origin
  ).not.toBe('ruled-header-span')
})
