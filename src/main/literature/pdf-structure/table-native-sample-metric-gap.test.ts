import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { recoverUnownedSourceRows } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-row-repair.mjs')).href
)
type Fixture = {
  groups: {
    text: string
    rect: number[]
    baseline: number
    height: number
    horizontal: boolean
  }[][]
  items: { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean }[]
  columnRects: number[][]
  rows: { rect: number[] }[]
  repairs: string[]
}
function fixture(): Fixture {
  const values = [
    ['Measure', 'N', '%', 'N', '%', 'P'],
    ['Category A', '4', '40', '5', '50', '.20'],
    ['Size', 'N=12', '', 'N=14', '', '.15'],
    ['Category B', '6', '60', '7', '70', '.30']
  ]
  const columnRects = Array.from({ length: 6 }, (_, c) => [c * 100, 0, (c + 1) * 100, 80])
  const groups = values.map((r, n) =>
    r.flatMap((text, c) =>
      text
        ? [
            {
              text,
              rect: [c * 100 + 5, n * 20 + 5, c * 100 + 90, n * 20 + 15],
              baseline: n * 20 + 15,
              height: 10,
              horizontal: true
            }
          ]
        : []
    )
  )
  return {
    groups,
    items: groups.flat(),
    columnRects,
    rows: [0, 1, 3].map((n) => ({ rect: [0, n * 20, 600, (n + 1) * 20] })),
    repairs: [] as string[]
  }
}
it('retains a sparse sample-qualified metric only under explicit repeated N and percent leaves', () => {
  const f = fixture()
  recoverUnownedSourceRows(f)
  expect(f.rows).toHaveLength(4)
  expect(f.repairs).toContain('text-supported-row-recovered')
})
it.each(['sample leaves', 'paired sample', 'complete peer'])(
  'declines a sample metric without %s',
  (kind) => {
    const f = fixture()
    if (kind === 'sample leaves') f.groups[0][2].text = 'Other'
    if (kind === 'paired sample') f.groups[2][2].text = 'Value'
    if (kind === 'complete peer') {
      f.groups[1][1].text = 'Other'
      f.groups[3][1].text = 'Other'
    }
    recoverUnownedSourceRows(f)
    expect(f.rows).toHaveLength(3)
  }
)
