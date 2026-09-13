import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverRuledStubGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-stub-grid.mjs')).href
)

type Token = { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean }
type ObjectBox = { label: string; rect: number[] }

function fixture(): {
  table: { cropRect: number[]; structure: { objects: ObjectBox[] } }
  columns: ObjectBox[]
  rules: number[][]
  items: Token[]
} {
  const columns = Array.from({ length: 4 }, (_, c) => ({
    label: 'table column',
    rect: [c * 80, 0, (c + 1) * 80, 120]
  }))
  const rules: number[][] = []
  for (let r = 0; r <= 6; r++)
    for (let c = 0; c < 4; c++) {
      if (r !== 4 || c !== 0) rules.push([c * 80, r * 20, (c + 1) * 80, r * 20])
    }
  for (let r = 0; r < 6; r++)
    for (let c = 0; c <= 4; c++) {
      if (c !== 1 || r === 3 || r === 4) rules.push([c * 80, r * 20, c * 80, (r + 1) * 20])
    }
  const token = (text: string, x: number, y: number, width = 30, height = 10): Token => ({
    text,
    rect: [x, y, x + width, y + height],
    baseline: y + height,
    height,
    horizontal: true
  })
  const items = [
    token('Treatment', 165, 3),
    token('Control', 245, 3),
    token('Age (years)', 5, 23, 90),
    token('BMI (kg/m', 5, 43, 72),
    token('2', 77, 43, 4, 6),
    token(')', 81, 43, 4),
    token('Site of', 5, 63),
    token('disease', 5, 83),
    token('Left', 85, 63),
    token('Right', 85, 83),
    token('Diameter', 5, 103, 95),
    ...Array.from({ length: 5 }, (_, r) => [
      token(`${r + 10} (50)`, 165, (r + 1) * 20 + 3),
      token(`${r + 20} (50)`, 245, (r + 1) * 20 + 3)
    ]).flat()
  ]
  const table = {
    cropRect: [0, 0, 320, 120],
    structure: {
      objects: [
        ...columns,
        { label: 'table row', rect: [0, 0, 320, 40] },
        ...Array.from({ length: 4 }, (_, r) => ({
          label: 'table row',
          rect: [0, (r + 2) * 20, 320, (r + 3) * 20]
        })),
        { label: 'table column header', rect: [0, 0, 320, 40] }
      ]
    }
  }
  return { table, columns, items, rules }
}

it('restores a separate header and source-closed stub spans without changing numeric records', () => {
  const { table, items, rules } = fixture()
  const result = refineTable(
    table,
    items,
    [{ lines: ['Table 1. Characteristics'], rect: [0, -20, 320, -5] }],
    [],
    rules
  )
  expect(result.grid[0]).toEqual(['', '', 'Treatment', 'Control'])
  expect(result.grid.slice(1).map((r: string[]) => r.slice(2))).toEqual(
    Array.from({ length: 5 }, (_, r) => [`${r + 10} (50)`, `${r + 20} (50)`])
  )
  expect(result.cells.find((c: { text: string }) => c.text === 'Site of disease')).toMatchObject({
    row: 3,
    column: 0,
    rowSpan: 2
  })
  expect(result.cells.find((c: { text: string }) => c.text === 'BMI (kg/m2)')).toMatchObject({
    colSpan: 2,
    textRuns: [
      { text: 'BMI (kg/m', position: 'normal' },
      { text: '2', position: 'superscript' },
      { text: ')', position: 'normal' }
    ]
  })
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
})

it('requires complete boundaries, rectangular faces and numeric table evidence', () => {
  const { table, columns, items, rules } = fixture()
  const recover = (edges: number[][], source = items): unknown =>
    recoverRuledStubGrid(table.cropRect, columns, source, edges)
  expect(recover(rules)).toBeDefined()
  expect(recover([...rules, [0, 80, 40, 80]])).toBeUndefined() // half a divider
  expect(recover(rules.filter((r) => !(r[0] === 320 && r[1] === 60)))).toBeUndefined() // open exterior
  expect(recover(rules.filter((r) => !(r[0] === 80 && r[1] === 60 && r[2] === 80)))).toBeUndefined() // L-shaped face
  expect(
    recover(
      rules,
      items.map((i) => ({ ...i, text: 'prose' }))
    )
  ).toBeUndefined()
  // Stroke caps from a neighbouring border may project by a fraction of a pixel.
  expect(recover([...rules, [79.8, 80, 80, 80]])).toBeDefined()
})
