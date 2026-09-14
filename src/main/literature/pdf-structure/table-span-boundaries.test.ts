import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const text = (value: string, c: number, y: number): object => ({
  text: value,
  rect: [c * 100 + 5, y, c * 100 + 5 + value.length * 3, y + 8],
  baseline: y + 8,
  height: 8,
  horizontal: true
})
it('ends a statistical rowspan before the next projected section header', () => {
  const table = {
    id: 'section-boundary',
    cropRect: [0, 0, 400, 140],
    structure: {
      objects: [
        ...[0, 1, 2, 3].map((c) => ({
          label: 'table column',
          rect: [c * 100, 0, c * 100 + 100, 140]
        })),
        ...Array.from({ length: 7 }, (_, r) => ({
          label: 'table row',
          rect: [0, r * 20, 400, r * 20 + 20]
        })),
        { label: 'table column header', rect: [0, 0, 400, 20] },
        { label: 'table spanning cell', rect: [200, 20, 300, 100] },
        { label: 'table projected row header', rect: [0, 80, 400, 100] }
      ]
    }
  }
  const grid = [
    ['Characteristic', 'Count', 'P', 'RR'],
    ['ER status', '', 'NS', ''],
    ['Positive', '10', '', ''],
    ['Negative', '20', '', ''],
    ['Histology', '', '', ''],
    ['Ductal', '30', '', ''],
    ['Other', '40', '', '']
  ]
  const items = grid.flatMap((row, r) => row.flatMap((v, c) => (v ? [text(v, c, r * 20 + 5)] : [])))
  const result = refineTable(table, items)
  expect(result.cells).toContainEqual(
    expect.objectContaining({ row: 1, column: 2, rowSpan: 3, colSpan: 1, text: 'NS' })
  )
  expect(result.cells).toContainEqual(
    expect.objectContaining({ row: 4, column: 0, rowSpan: 1, colSpan: 4, text: 'Histology' })
  )
  expect(result.issues).not.toContain('conflicting-spanning-cells')
  const conflicting = refineTable(table, [...items, text('.04', 2, 85)])
  expect(conflicting.repairs).not.toContain('statistic-span-section-boundary-recovered')
})
it('keeps group sample sizes and percent units in one vertically merged header', () => {
  const table = {
    id: 'unit-header',
    cropRect: [0, 0, 400, 100],
    structure: {
      objects: [
        ...[0, 1, 2, 3].map((c) => ({
          label: 'table column',
          rect: [c * 100, 0, c * 100 + 100, 100]
        })),
        ...[
          [0, 33],
          [33, 52],
          [55, 75],
          [75, 100]
        ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 400, b] })),
        { label: 'table column header', rect: [0, 18, 400, 52] },
        ...[1, 2, 3].map((c) => ({
          label: 'table spanning cell',
          rect: [c * 100 + 1, 19, c * 100 + 90, 52]
        }))
      ]
    }
  }
  const items = [
    text('Characteristic', 0, 5),
    text('Arm A', 1, 5),
    text('Arm B', 2, 5),
    text('p-value', 3, 5),
    text('(n = 103)', 1, 20),
    text('(n = 104)', 2, 20),
    text('n (%)', 1, 37),
    text('n (%)', 2, 37),
    text('Positive', 0, 60),
    text('10 (10)', 1, 60),
    text('20 (20)', 2, 60),
    text('.05', 3, 60),
    text('Negative', 0, 80),
    text('90 (90)', 1, 80),
    text('80 (80)', 2, 80)
  ]
  const captions = [{ lines: ['Table 1. Characteristics'], rect: [0, -20, 400, -5] }]
  const rules = [
    [0, 0, 400, 0],
    [0, 52, 400, 52],
    [0, 100, 400, 100]
  ]
  const result = refineTable(table, items, captions, [], rules)
  expect(result.cells).toContainEqual(
    expect.objectContaining({
      row: 0,
      column: 1,
      rowSpan: 2,
      colSpan: 1,
      text: 'Arm A (n = 103) n (%)'
    })
  )
  expect(result.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 3, rowSpan: 2, colSpan: 1, text: 'p-value' })
  )
  expect(result.issues).not.toContain('unresolved-spanning-cells')
  expect(
    refineTable(table, items, captions, [], [...rules, [0, 32, 400, 32]]).repairs
  ).not.toContain('ruled-unit-header-recovered')
})

it('extends a partial comparison P span through complete repeated grade distributions', () => {
  const grid = [
    ['Toxicity (grade)', 'Group A', 'Group B', 'P'],
    ['Before therapy', '', '', ''],
    ['0', '10', '8', '.555'],
    ['1', '14', '16', ''],
    ['2', '0', '0', ''],
    ['After therapy', '', '', ''],
    ['0', '8', '1', '.001'],
    ['1', '14', '12', ''],
    ['2', '2', '11', '']
  ]
  const table = {
    id: 'grades',
    cropRect: [0, 0, 400, 180],
    structure: {
      objects: [
        ...[0, 1, 2, 3].map((c) => ({
          label: 'table column',
          rect: [c * 100, 0, c * 100 + 100, 180]
        })),
        ...grid.map((_, r) => ({ label: 'table row', rect: [0, r * 20, 400, r * 20 + 20] })),
        { label: 'table column header', rect: [0, 0, 400, 20] },
        ...[1, 5].map((r) => ({
          label: 'table projected row header',
          rect: [0, r * 20, 400, r * 20 + 20]
        })),
        ...[2, 6].map((r) => ({
          label: 'table spanning cell',
          rect: [300, r * 20, 400, r * 20 + 40]
        }))
      ]
    }
  }
  const items = grid.flatMap((row, r) => row.flatMap((v, c) => (v ? [text(v, c, r * 20 + 5)] : [])))
  const result = refineTable(table, items)
  expect(result.cells).toContainEqual(
    expect.objectContaining({ row: 2, column: 3, rowSpan: 3, text: '.555' })
  )
  expect(result.cells).toContainEqual(
    expect.objectContaining({ row: 6, column: 3, rowSpan: 3, text: '.001' })
  )
  for (const different of [
    [...items, text('.04', 3, 85)],
    items.map((i) => ({
      ...i,
      ...((i as { text: string }).text === 'Toxicity (grade)' ? { text: 'Characteristic' } : {})
    }))
  ])
    expect(refineTable(table, different).repairs).not.toContain('grade-statistic-span-recovered')
})

it('recovers a projected section between percentage records with an attached raised marker', () => {
  const grid = [
    ['Status', 'Response', 'Stable', 'Progression'],
    ['Positive', '10 (50%)', '5 (25%)', '5 (25%)'],
    ['Negative', '4 (40%)', '3 (30%)', '3 (30%)'],
    ['Intrinsic molecular subtype', '', '', ''],
    ['Luminal', '2 (50%)', '1 (25%)', '1 (25%)'],
    ['Basal', '2 (40%)', '2 (40%)', '1 (20%)']
  ]
  const table = {
    id: 'projected-gap',
    cropRect: [0, 0, 400, 120],
    structure: {
      objects: [
        ...[0, 1, 2, 3].map((c) => ({
          label: 'table column',
          rect: [c * 100, 0, c * 100 + 100, 120]
        })),
        ...[0, 1, 2, 4, 5].map((r) => ({
          label: 'table row',
          rect: [0, r * 20, 400, r === 2 ? 68 : r * 20 + 20]
        })),
        { label: 'table projected row header', rect: [0, 60, 400, 80] },
        { label: 'table column header', rect: [0, 0, 400, 20] }
      ]
    }
  }
  const items = grid.flatMap((row, r) => row.flatMap((v, c) => (v ? [text(v, c, r * 20 + 5)] : [])))
  const marker = {
    text: 'c',
    rect: [86, 64.5, 89, 69.5],
    baseline: 69.5,
    height: 5,
    horizontal: true
  }
  const result = refineTable(table, [...items, marker])
  expect(result.unassigned).toEqual([])
  expect(result.cells).toContainEqual(
    expect.objectContaining({ row: 3, colSpan: 4, text: 'Intrinsic molecular subtypec' })
  )
})

it('recovers a sparse final model-fit statistic as its own record', () => {
  const table = {
    id: 'fit-summary',
    cropRect: [0, 0, 1000, 101],
    structure: {
      objects: [
        ...Array.from({ length: 10 }, (_, c) => ({
          label: 'table column',
          rect: [c * 100, 0, c * 100 + 100, 101]
        })),
        ...[
          [0, 20],
          [20, 40],
          [40, 60],
          [60, 84]
        ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 1000, b] })),
        { label: 'table column header', rect: [0, 0, 1000, 20] }
      ]
    }
  }
  const grid = [
    ['Parameter', 'A', 'SE', 'P', 'B', 'SE', 'P', 'C', 'SE', 'P'],
    ['Intercept', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
    ['Slope', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
    ['AICC (smaller is better)', '3872.00', '', '', '7983.80', '', '', '4070.00', '', ''],
    ['SBC (smaller is better)', '3878.80', '', '', '7990.60', '', '', '4076.80', '', '']
  ]
  const items = grid.flatMap((row, r) =>
    row.flatMap((v, c) => (v ? [text(v, c, r === 4 ? 81 : r * 20 + 5)] : []))
  )
  const result = refineTable(table, items, [], [], [[0, 98, 1000, 98]])
  expect(result.grid).toHaveLength(5)
  expect(result.grid[4][0]).toBe('SBC (smaller is better)')
  expect(result.grid[4][4]).toBe('7990.60')
  expect(result.unassigned).toEqual([])
})

it('keeps two ruled header tiers over the same three coefficient columns', () => {
  const xs = [0, 100, 160, 220, 280, 340, 400, 460]
  const table = {
    id: 'stacked-model-header',
    cropRect: [0, 0, 460, 100],
    structure: {
      objects: [
        ...xs.slice(0, -1).map((x, c) => ({ label: 'table column', rect: [x, 0, xs[c + 1], 100] })),
        ...[0, 1, 2, 3, 4].map((r) => ({
          label: 'table row',
          rect: [0, r * 20, 460, r * 20 + 20]
        })),
        { label: 'table column header', rect: [0, 0, 460, 60] },
        ...[1, 4].map((c) => ({ label: 'table spanning cell', rect: [xs[c], 20, xs[c + 3], 40] }))
      ]
    }
  }
  const grid = [
    ['Parameter', 'Weight', '', '', 'Diet', '', ''],
    ['', 'Model A', '', '', 'Model B', '', ''],
    ['', 'β', 'SE', 'p', 'β', 'SE', 'p'],
    ['Intercept', '1', '2', '.03', '4', '5', '.06'],
    ['Age', '1', '2', '.03', '4', '5', '.06']
  ]
  const items = grid.flatMap((row, r) =>
    row.flatMap((v, c) =>
      v
        ? [
            {
              text: v,
              rect: [xs[c] + 5, r * 20 + 3, xs[c] + 5 + v.length * 3, r * 20 + 11],
              height: 8,
              baseline: r * 20 + 11,
              horizontal: true
            }
          ]
        : []
    )
  )
  const rules = [...[1, 4].flatMap((c) => [20, 40].map((y) => [xs[c] + 3, y, xs[c + 3] - 3, y]))]
  const result = refineTable(table, items, [], [], rules)
  expect(result.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 1, colSpan: 3, text: 'Weight' })
  )
  expect(result.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 4, colSpan: 3, text: 'Diet' })
  )
  expect(result.cells).toContainEqual(
    expect.objectContaining({ row: 1, column: 1, colSpan: 3, text: 'Model A' })
  )
})
