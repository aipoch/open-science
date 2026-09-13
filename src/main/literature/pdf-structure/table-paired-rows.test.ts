import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)

// Three biomarker groups and a total, each with count/percentage physical rows.
// Model rows omit a count, a percentage, the top header and the final percentage.
const text = (value: string, column: number, y: number): object => ({
  text: value,
  rect: [column * 100 + 10, y, column * 100 + 60, y + 10],
  baseline: y + 10,
  height: 10,
  horizontal: true
})
const caption = [{ lines: ['Table 1. Biomarkers'], rect: [0, -20, 600, -10] }]
const items = [
  text('Marker', 2, 0),
  text('Total', 4, 0),
  text('P value', 5, 0),
  text('Negative', 2, 20),
  text('Positive', 3, 20),
  ...Array.from({ length: 7 }, (_, pair) => {
    const y = 40 + pair * 28
    return [
      ...(pair % 2 === 0 ? [text(pair === 6 ? 'Total' : `Biomarker ${pair / 2}`, 0, y)] : []),
      ...(pair < 6 ? [text(pair % 2 ? 'Positive' : 'Negative', 1, y)] : []),
      ...[2, 3, 4].map((column) => text(String(100 + pair * 10 + column), column, y)),
      ...(pair < 6 && pair % 2 === 0 ? [text('0.123', 5, y)] : []),
      ...[2, 3, 4].map((column) => text(`${column * 10}.0%`, column, y + 14))
    ]
  }).flat()
]
const raw = {
  id: 'paired',
  cropRect: [0, 0, 600, 238],
  structure: {
    objects: [
      ...Array.from({ length: 6 }, (_, column) => ({
        label: 'table column',
        rect: [column * 100, 0, column * 100 + 100, 238]
      })),
      { label: 'table column header', rect: [0, 20, 600, 30] },
      ...[
        20,
        ...Array.from({ length: 14 }, (_, i) => 40 + i * 14).filter(
          (_, i) => ![3, 8, 13].includes(i)
        )
      ].map((y) => ({ label: 'table row', rect: [0, y, 600, y + 10] })),
      { label: 'table spanning cell', rect: [500, 145, 600, 238] }
    ]
  }
}

it('recovers paired comparisons with shared odds ratios, intervals and P values', () => {
  const header = ['Population', 'Comparison', 'N', 'Response', '95% CI', 'OR', '95% CI for OR', 'P']
  const records = Array.from({ length: 3 }, (_, i) => [
    [`Population ${i}`, 'Control', '100', '29', '25 to 34', '1.75', '1.28 to 2.37', '.0004'],
    ['', 'Treatment', '110', '42', '37 to 47', '', '', '']
  ]).flat()
  const source = [header, ...records].flatMap((row, i) =>
    row.flatMap((value, c) => (value ? [text(value, c, i * 16 + 2)] : []))
  )
  const table = {
    cropRect: [0, 0, 800, 115],
    structure: {
      objects: [
        ...Array.from({ length: 8 }, (_, c) => ({
          label: 'table column',
          rect: [c * 100, 0, (c + 1) * 100, 115]
        })),
        ...Array.from({ length: 7 }, (_, r) => ({
          label: 'table row',
          rect: [0, r * 16, 800, r * 16 + 15]
        })),
        { label: 'table column header', rect: [0, 0, 800, 16] },
        { label: 'table spanning cell', rect: [500, 30, 600, 67] }
      ]
    }
  }
  const result = refineTable(table, source)
  expect(result.grid).toEqual([header, ...records])
  expect(result.issues).toEqual([])
  for (const row of [1, 3, 5])
    for (const column of [0, 5, 6, 7]) {
      expect(
        result.cells.find(
          (c: { row: number; column: number }) => c.row === row && c.column === column
        )?.rowSpan
      ).toBe(2)
    }
  for (const extra of [text('0.3', 7, 34), text('Additional explanation', 1, 42)]) {
    expect(refineTable(table, [...source, extra]).repairs).not.toContain(
      'text-supported-comparison-rows-recovered'
    )
  }
})

it('recovers all count/percentage pairs, two-tier headers and bounded category spans', () => {
  const result = refineTable(raw, items, caption, [], [[210, 19, 360, 19]])
  expect(result.grid).toHaveLength(16)
  expect(result.grid[0]).toHaveLength(6)
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
  expect(result.cells).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: 'Marker', row: 0, column: 2, colSpan: 2, rowSpan: 1 }),
      expect.objectContaining({ text: 'Total', row: 0, column: 4, rowSpan: 2 }),
      expect.objectContaining({ text: 'P value', row: 0, column: 5, rowSpan: 2 }),
      expect.objectContaining({ text: 'Biomarker 2', row: 10, column: 0, rowSpan: 4 }),
      expect.objectContaining({ text: '0.123', row: 10, column: 5, rowSpan: 4 }),
      expect.objectContaining({ text: 'Positive', row: 12, column: 1, rowSpan: 2 }),
      expect.objectContaining({ text: 'Total', row: 14, column: 0, rowSpan: 2 })
    ])
  )
  for (let pair = 0; pair < 7; pair++) {
    expect(result.grid[2 + pair * 2].slice(2, 5)).toEqual(
      [2, 3, 4].map((column) => String(100 + pair * 10 + column))
    )
    expect(result.grid[3 + pair * 2].slice(2, 5)).toEqual(['20.0%', '30.0%', '40.0%'])
  }
})

it('does not infer a count/percentage layout across intervening prose or incomplete pairs', () => {
  for (const extra of [text('Comment', 1, 115), text('Extra value', 5, 110)]) {
    const result = refineTable(raw, [...items, extra], caption)
    expect(result.repairs).not.toContain('text-supported-count-percentage-rows-recovered')
  }
  const result = refineTable(raw, items, caption)
  expect(result.cells.find((cell: { text: string }) => cell.text === 'Marker').colSpan).toBe(1)
})

it('aligns repeated treatment/control records without crossing missing arms or prose', async () => {
  const { repairWrappedTableRows } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-row-repair.mjs')).href
  )
  const groups = Array.from({ length: 3 }, (_, i) => [
    [
      text(`Outcome ${i}`, 0, 30 + i * 32),
      text('T: −0.36', 1, 30 + i * 32),
      text('T: 0.240', 2, 30 + i * 32)
    ],
    [text('C: −0.50', 1, 42 + i * 32), text('C: 0.157', 2, 42 + i * 32)]
  ]).flat()
  const run = (
    source: object[][],
    rules: number[][] = []
  ): { rows: { rect: number[] }[]; repairs: string[] } => {
    const rows = [0, 35, 67, 99].map((y) => ({ rect: [0, y, 300, y + 35] }))
    const repairs: string[] = []
    repairWrappedTableRows({
      rows,
      repairs,
      groups: source,
      items: source.flat(),
      columnRects: [0, 100, 200].map((x) => [x, 0, x + 100, 140]),
      rules,
      right: 300
    })
    return { rows, repairs }
  }
  expect(run(groups).rows.map((r) => r.rect.slice(1, 4))).toEqual([
    [30, 300, 52],
    [62, 300, 84],
    [94, 300, 116]
  ])
  for (const source of [
    groups.slice(0, -1),
    [...groups.slice(0, 2), [text('Additional explanation', 0, 55)], ...groups.slice(2)]
  ])
    expect(run(source).repairs).not.toContain('paired-arm-outcomes-recovered')
  expect(run(groups, [[0, 41, 300, 41]]).repairs).not.toContain('paired-arm-outcomes-recovered')
})
