import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverAlignedNumericGrid, recoverAnchoredStubGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-aligned-numeric-grid.mjs')).href
)
const token = (text: string, x: number, y: number, width = 35, height = 10): object => ({
  text,
  rect: [x, y, x + width, y + height],
  baseline: y + height,
  height,
  horizontal: true
})
const caption = [{ lines: ['Table 1. Repeated outcomes'], rect: [0, 0, 300, 10] }]
const model = (columns: number, height = 600): object => ({
  cropRect: [0, 0, columns * 100, height],
  structure: {
    objects: [
      ...Array.from({ length: columns }, (_, c) => ({
        label: 'table column',
        rect: [c * 100, 0, (c + 1) * 100, height]
      })),
      { label: 'table row', rect: [0, 0, columns * 100, 30] },
      { label: 'table row', rect: [0, 30, columns * 100, height] },
      { label: 'table column header', rect: [0, 0, columns * 100, 30] }
    ]
  }
})
const repeated = (): object[] => [
  ...['Variables', 'Arm A', 'Arm B', 'Arm C', 'Arm D', 'P-value'].map((s, c) =>
    token(s, c * 100 + 5, 5, 65)
  ),
  ...Array.from({ length: 3 }, (_, section) => [
    token(`Outcome ${section + 1}`, 5, 40 + section * 150, 85),
    ...['Baseline', 'End-trial', 'Change', 'P-value'].flatMap((s, r) => [
      token(s, 5, 60 + section * 150 + r * 25, 70),
      ...Array.from({ length: s === 'P-value' ? 4 : 5 }, (_, c) =>
        token(
          s === 'P-value' ? '0.040' : `${10 + section}.${r}±1.2`,
          c * 100 + 105,
          60 + section * 150 + r * 25,
          70
        )
      )
    ])
  ]).flat()
]
it('recovers every outcome and follow-up record even when the model predicts one body row', () => {
  const result = refineTable(model(6), repeated(), caption)
  expect(result.grid).toHaveLength(16)
  expect(result.grid.filter((r: string[]) => r[0] === 'P-value')).toHaveLength(3)
  expect(result.grid.at(-1)).toEqual(['P-value', '0.040', '0.040', '0.040', '0.040', ''])
  expect(result.unassigned).toEqual([])
  expect(result.cells.filter((c: { colSpan: number }) => c.colSpan === 6)).toHaveLength(3)
})
it('declines a reconstruction with an unexplained body line, crossing value, or no caption', () => {
  const items = repeated()
  expect(recoverAlignedNumericGrid(model(6), items, [])).toBeUndefined()
  expect(
    recoverAlignedNumericGrid(model(6), [...items, token('Unexplained', 305, 170)], caption)
  ).toBeUndefined()
  expect(
    recoverAlignedNumericGrid(model(6), [...items, token('200', 190, 85, 35)], caption)
  ).toBeUndefined()
})
it('keeps wrapped percentages with their own count and restores a ruled parent header', () => {
  const items = [
    token('Variables', 5, 5, 65),
    token('Total', 105, 5),
    token('N (%)', 105, 17),
    token('Group N (%)', 205, 5, 75),
    token('P-value', 405, 5, 65),
    token('Arm A', 205, 25, 65),
    token('Arm B', 305, 25, 65),
    ...Array.from({ length: 2 }, (_, section) => [
      token(`Category ${section}`, 5, 50 + section * 250, 75),
      ...Array.from({ length: 5 }, (_, r) => [
        token(`Record ${r}`, 5, 70 + section * 250 + r * 35, 65),
        ...[1, 2, 3].map((c) => token('12 (50)', c * 100 + 5, 70 + section * 250 + r * 35, 60)),
        token('0.2', 405, 70 + section * 250 + r * 35)
      ]).flat(),
      token('Wrapped', 5, 250 + section * 250, 65),
      ...[1, 2, 3].map((c) => token('12', c * 100 + 5, 250 + section * 250)),
      ...[1, 2, 3].map((c) => token('(50)', c * 100 + 5, 262 + section * 250))
    ]).flat()
  ]
  const result = refineTable(model(5), items, caption, [], [[200, 20, 400, 20]])
  expect(result.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 2, colSpan: 2, text: 'Group N (%)' })
  )
  expect(result.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 1, rowSpan: 2, text: 'Total N (%)' })
  )
  expect(result.grid.filter((r: string[]) => r[0] === 'Wrapped')).toEqual(
    Array.from({ length: 2 }, () => ['Wrapped', '12 (50)', '12 (50)', '12 (50)', ''])
  )
  expect(result.unassigned).toEqual([])
})
it('keeps wrapped definition labels with prose and separates empty section headings', () => {
  const items = [
    token('Variables', 5, 5, 65),
    token('Definition', 105, 5, 70),
    ...Array.from({ length: 2 }, (_, section) => [
      token(`Section ${section}`, 5, 35 + section * 200, 70),
      ...Array.from({ length: 3 }, (_, r) => [
        token(`Measure ${r}`, 5, 60 + section * 200 + r * 45, 70),
        token('continued label', 5, 72 + section * 200 + r * 45, 80),
        token('A detailed anatomical description', 105, 65 + section * 200 + r * 45, 90)
      ])
    ]).flat(2)
  ]
  const recovered = recoverAnchoredStubGrid(model(2), items, caption)
  expect(recovered?.rows).toHaveLength(9)
  const result = refineTable(model(2), items, caption)
  expect(result.grid.filter((r: string[]) => /continued label/.test(r[0]))).toHaveLength(6)
  expect(result.cells.filter((c: { colSpan: number }) => c.colSpan === 2)).toHaveLength(2)
  expect(result.unassigned).toEqual([])
  expect(
    recoverAnchoredStubGrid(model(2), [...items, token('23', 105, 45)], caption)
  ).toBeUndefined()
})

it('keeps a mean/SD heading clear of the P-value column and excludes only an external continuation marker', () => {
  const items = repeated().map((item: object) => {
    const value = item as { rect: number[]; baseline: number }
    return {
      ...item,
      rect: value.rect.map((v, i) => (i % 2 ? v + 20 : v)),
      baseline: value.baseline + 20
    }
  })
  // Place units between the treatment headings and the first section.
  items.push(token('(Mean ± SD)', 105, 40, 90) as (typeof items)[number])
  items.push(
    ...([
      token('(', 320, 580, 4),
      token('continued on next page', 327, 580, 130),
      token(')', 460, 580, 4)
    ] as typeof items)
  )
  const result = refineTable(model(6), items, caption)
  expect(result.cells).toContainEqual(
    expect.objectContaining({ row: 1, column: 1, colSpan: 4, text: '(Mean ± SD)' })
  )
  expect(result.unassigned).toEqual([])
})

it('keeps independent group headings separate above a full-width header rule', () => {
  const items = [
    ...['Group A', 'Group B', 'Group C', 'Total', 'P-value'].map((s, c) =>
      token(s, 105 + c * 100, 5, 65)
    ),
    token('Allocation', 5, 23, 70),
    ...[1, 2, 3, 4].map((c) => token('N = 80', c * 100 + 5, 23, 50)),
    ...Array.from({ length: 3 }, (_, section) => [
      token(`Category ${section}`, 5, 45 + section * 120, 85),
      ...Array.from({ length: 4 }, (_, n) => [
        token(`Level ${n}`, 5, 65 + section * 120 + n * 20, 65),
        ...[1, 2, 3, 4].map((c) => token('20 (25%)', c * 100 + 5, 65 + section * 120 + n * 20, 65))
      ]).flat()
    ]).flat()
  ]
  const result = refineTable(model(6, 420), items, caption, [], [[0, 19, 600, 19]])
  expect(result.grid[0]).toEqual(['', 'Group A', 'Group B', 'Group C', 'Total', 'P-value'])
  expect(result.grid[1][0]).toBe('Allocation')
  expect(
    result.cells
      .filter((c: { row: number; colSpan: number }) => c.row === 0)
      .every((c: { colSpan: number }) => c.colSpan === 1)
  ).toBe(true)
})

it('keeps each control/intervention pair under its own day despite merged model rows', () => {
  const items = [
    ...['Outcome', 'Mean', 'SD', 't', 'df', 'p'].map((s, c) => token(s, c * 100 + 5, 5, 65)),
    ...Array.from({ length: 5 }, (_, day) => [
      token(`Day ${day + 1}`, 5, 30 + day * 105, 50),
      ...Array.from({ length: 3 }, (_, record) => [
        token('Control', 5, 45 + day * 105 + record * 28, 65),
        ...['1.2', '0.3', '1.5', '28', '0.15'].map((s, c) =>
          token(s, c * 100 + 105, 45 + day * 105 + record * 28, 40)
        ),
        token('Intervention', 5, 58 + day * 105 + record * 28, 70),
        token('1.0', 105, 58 + day * 105 + record * 28, 30),
        token('0.2', 205, 58 + day * 105 + record * 28, 30)
      ]).flat()
    ]).flat()
  ]
  const result = refineTable(model(6), items, caption)
  expect(result.grid.filter((r: string[]) => r[0] === 'Control')).toHaveLength(15)
  expect(result.grid.filter((r: string[]) => r[0] === 'Intervention')).toHaveLength(15)
  expect(result.unassigned).toEqual([])
})
