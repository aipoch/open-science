import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
// Minimized geometry from the reported PDF: a three-line header's first line
// sits just above both predicted header and row boxes, but inside the table crop.
const table = {
  id: 'header',
  cropRect: [0, 0, 300, 100],
  structure: {
    objects: [
      { label: 'table row', rect: [0, 20, 300, 50] },
      { label: 'table row', rect: [0, 55, 300, 75] },
      { label: 'table column header', rect: [0, 20, 300, 50] },
      ...[0, 100, 200].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 100] }))
    ]
  }
}
const token = (
  text: string,
  x: number,
  y: number
): {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
} => ({
  text,
  rect: [x, y, x + 60, y + 10],
  baseline: y + 10,
  height: 10,
  horizontal: true
})
const items = [
  token('Variable', 5, 35),
  token('Treatment', 105, 8),
  token('Control', 205, 8),
  token('Group A', 105, 21),
  token('Group B', 205, 21),
  token('(N=100)', 105, 35),
  token('(N=50)', 205, 35),
  token('Response', 5, 60),
  token('40', 105, 60),
  token('10', 205, 60)
]

it('recovers the first header line into its own column without introducing a new row', () => {
  const result = refineTable(table, items)
  expect(result.grid[0]).toEqual([
    'Variable',
    'Treatment Group A (N=100)',
    'Control Group B (N=50)'
  ])
  expect(result.grid[1]).toEqual(['Response', '40', '10'])
  expect(result.unassigned).toEqual([])
  expect(result.issues).not.toContain('unresolved-multiline-cell')
})

it('keeps text unresolved without model header evidence or when too far from the header', () => {
  const noHeader = {
    ...table,
    structure: { objects: table.structure.objects.filter((o) => o.label !== 'table column header') }
  }
  expect(refineTable(noHeader, items).unassigned).toEqual(['Treatment', 'Control'])
  const distant = items.map((i) =>
    ['Treatment', 'Control'].includes(i.text)
      ? { ...i, rect: [i.rect[0], 0, i.rect[2], 4], baseline: 4, height: 4 }
      : i
  )
  expect(refineTable(table, distant).unassigned).toEqual(['Treatment', 'Control'])
})

it('does not turn an isolated note above the header into a column label', () => {
  const single = items.filter((i) => i.text !== 'Control')
  expect(refineTable(table, single).unassigned).toEqual(['Treatment'])
})

it('recovers wrapped labels without a model header when an adjacent table caption supports the first row', () => {
  const noHeader = {
    ...table,
    structure: { objects: table.structure.objects.filter((o) => o.label !== 'table column header') }
  }
  const caption = { lines: ['Table 1. Baseline characteristics.'], rect: [0, -18, 300, -4] }
  const result = refineTable(noHeader, items, [caption])
  expect(result.grid[0]).toEqual([
    'Variable',
    'Treatment Group A (N=100)',
    'Control Group B (N=50)'
  ])
  expect(result.unassigned).toEqual([])
})

it('preserves a merged section row after expanding the preceding column header', () => {
  const withSpan = {
    ...table,
    structure: {
      objects: [
        ...table.structure.objects,
        { label: 'table projected row header', rect: [0, 55, 300, 75] }
      ]
    }
  }
  const result = refineTable(
    withSpan,
    items.filter((i) => !['40', '10'].includes(i.text))
  )
  expect(result.grid[0][1]).toBe('Treatment Group A (N=100)')
  expect(result.cells.find((c: { row: number }) => c.row === 1)).toMatchObject({
    column: 0,
    colSpan: 3,
    text: 'Response'
  })
})

it('still rejects model spans that combine independently populated source columns or rows', () => {
  for (const rect of [
    [100, 20, 300, 50],
    [100, 20, 200, 75]
  ]) {
    const withSpan = {
      ...table,
      structure: { objects: [...table.structure.objects, { label: 'table spanning cell', rect }] }
    }
    const result = refineTable(withSpan, items)
    expect(result.grid[0]).toEqual([
      'Variable',
      'Treatment Group A (N=100)',
      'Control Group B (N=50)'
    ])
    expect(result.grid[1]).toEqual(['Response', '40', '10'])
    expect(result.issues).toContain(
      rect[2] === 300 ? 'span-conflicts-with-source-columns' : 'span-conflicts-with-source-rows'
    )
  }
})
