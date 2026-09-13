import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverTreatmentScheduleGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-record-grid.mjs')).href
)
const token = (
  text: string,
  x: number,
  y: number,
  width: number
): {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
} => ({ text, rect: [x, y, x + width, y + 10], baseline: y + 10, height: 10, horizontal: true })
const table = {
  cropRect: [0, 0, 400, 250],
  structure: {
    objects: [
      ...[0, 120, 220, 310].map((x, c, xs) => ({
        label: 'table column',
        rect: [x, 0, xs[c + 1] ?? 400, 250]
      })),
      ...Array.from({ length: 12 }, (_, r) => ({
        label: 'table row',
        rect: [0, r * 20, 400, r * 20 + 18]
      })),
      { label: 'table spanning cell', rect: [0, 65, 400, 140] }
    ]
  }
}
const captions = [{ lines: ['Table 2'], rect: [80, -30, 160, -10] }]
const items = [
  token('AA regimen', 5, 0, 70),
  token('Drug-A', 10, 20, 80),
  token('40 mg/m2', 150, 20, 50),
  token('intravenously on day 1', 201, 20, 160),
  token('Drug-B', 10, 40, 100),
  token('200 mg', 150, 40, 50),
  token('orally on days 3 and 6', 205, 40, 170),
  token('Duration of cycle 21 days.', 10, 60, 175),
  token('Maximum cumulative dose', 190, 60, 180),
  token('depends on prior treatment.', 10, 80, 180),
  token('BB regimen', 5, 110, 70),
  token('Drug-C', 10, 130, 95),
  token('50 mg/m’', 150, 130, 50),
  token('intravenously on days I and', 205, 130, 180),
  token('8', 150, 150, 5),
  token('Drug-D', 10, 170, 95),
  token('60 mg', 150, 170, 50),
  token('orally on days 1 to 14', 205, 170, 170),
  token('Duration of cycle 28 days.', 10, 190, 175),
  token('(2)', 190, 190, 20)
]

it('keeps dose, route and wrapped dates together while spanning regimen and cycle descriptions', () => {
  const result = refineTable(table, items, captions)
  expect(result.grid).toEqual([
    ['AA regimen', ''],
    ['Drug-A', '40 mg/m2 intravenously on day 1'],
    ['Drug-B', '200 mg orally on days 3 and 6'],
    ['Duration of cycle 21 days. Maximum cumulative dose depends on prior treatment.', ''],
    ['BB regimen', ''],
    ['Drug-C', '50 mg/m’ intravenously on days I and 8'],
    ['Drug-D', '60 mg orally on days 1 to 14'],
    ['Duration of cycle 28 days. (2)', '']
  ])
  expect(result.cells.filter((c: { colSpan: number }) => c.colSpan === 2)).toHaveLength(4)
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
})

it('rejects uncertain gutters, unrecognized lines and insufficient regimen evidence', () => {
  expect(
    recoverTreatmentScheduleGrid(
      table,
      items.filter((i) => i.text !== 'BB regimen'),
      captions
    )
  ).toBeUndefined()
  expect(
    recoverTreatmentScheduleGrid(table, [...items, token('Unknown row', 5, 225, 100)], captions)
  ).toBeUndefined()
  expect(
    recoverTreatmentScheduleGrid(
      table,
      items.map((i) => (i.text === 'Drug-B' ? { ...i, rect: [10, 40, 170, 50] } : i)),
      captions
    )
  ).toBeUndefined()
})
