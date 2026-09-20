import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { repairInlineFragmentRows } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-row-repair.mjs')).href
)
it('attaches a lowered glyph to its record and never expands over a separate value', () => {
  const main = { text: 'E', rect: [10, 10, 18, 20], height: 10 }
  const subscript = { text: '2', rect: [18, 18, 22, 24], height: 6 }
  const value = { text: '300', rect: [40, 10, 60, 20], height: 10 }
  const unrelated = { text: '400', rect: [40, 19, 60, 29], height: 10 }
  for (const extras of [[], [unrelated]]) {
    const rows = [{ rect: [0, 8, 100, 20] }, { rect: [0, 20, 100, 30] }]
    const repairs: string[] = []
    repairInlineFragmentRows({
      rows,
      groups: [[main, subscript, value]],
      items: [main, subscript, value, ...extras],
      left: 0,
      right: 100,
      repairs
    })
    expect(rows).toHaveLength(extras.length ? 2 : 1)
    expect(repairs).toEqual(extras.length ? [] : ['inline-fragment-row-recovered'])
  }
})

it('realigns a final numeric row when only its raised marker lies inside the predicted band', async () => {
  const { refineTable } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
  )
  const token = (text: string, x: number, y: number, width = 30, height = 10): object => ({
    text,
    rect: [x, y, x + width, y + height],
    height,
    baseline: y + height,
    horizontal: true
  })
  const table = {
    cropRect: [0, 0, 300, 85],
    structure: {
      objects: [
        ...[0, 100, 200].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 85] })),
        ...[
          [0, 25],
          [25, 48],
          [48, 60.4]
        ].map(([y, end]) => ({ label: 'table row', rect: [0, y, 300, end] })),
        { label: 'table column header', rect: [0, 0, 300, 25] }
      ]
    }
  }
  const items = [
    token('Variable', 5, 5),
    token('Coefficient', 105, 5, 60),
    token('P-value', 205, 5, 50),
    token('Time T2', 5, 32),
    token('−2 (−4 to 1)', 105, 32, 75),
    token('0.30', 205, 32),
    token('Time T3', 5, 56),
    token('c', 36, 57, 4, 6),
    token('−4 (−8 to 2)', 105, 56, 75),
    token('0.65', 205, 56)
  ]
  const result = refineTable(
    table,
    items,
    [{ lines: ['Table 1. Effects'], rect: [0, -20, 300, -10] }],
    [],
    [[0, 75, 300, 75]]
  )
  expect(result.unassigned).toEqual([])
  expect(result.grid.at(-1)).toEqual(['Time T3 c', '−4 (−8 to 2)', '0.65'])
})
